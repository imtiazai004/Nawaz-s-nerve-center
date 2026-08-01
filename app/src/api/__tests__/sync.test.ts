import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { assertAuthUsable, createSyncServer } from '../server.js';
import { validateBatch } from '../protocol.js';
import { createPool, migrate, type Pool } from '../../db/pool.js';
import { loadIncident } from '../../db/eventStore.js';
import { foldIncident } from '../../domain/incident.js';
import { seedActor, authHeaders, type TestActor } from '../../testing/seed.js';

const url = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

describe('auth stub guard', () => {
  it('allows the stub in development and test', () => {
    expect(() => assertAuthUsable('stub', 'development')).not.toThrow();
    expect(() => assertAuthUsable('stub', 'test')).not.toThrow();
  });

  it('refuses to start with the stub in production', () => {
    // "Shipped with the auth stub still in place" is a routine way for a system like this
    // to be compromised. A comment does not prevent it; a startup failure does.
    expect(() => assertAuthUsable('stub', 'production')).toThrow(/Refusing to start/);
  });
});

describe('validateBatch', () => {
  function good(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      eventId: randomUUID(),
      incidentId: randomUUID(),
      type: 'reported',
      occurredAt: '2026-08-01T14:02:00.000Z',
      clientSeq: 1,
      actorPersonId: randomUUID(),
      actorSeatId: randomUUID(),
      sourceChannel: 'mobile',
      payload: { category: 'rta', severity: 'high' },
      ...over,
    };
  }

  it('accepts a well-formed event', () => {
    expect(validateBatch([good()]).valid).toHaveLength(1);
  });

  it('accepts an incomplete payload — an emergency is never refused (INV-01)', () => {
    // A reporter under stress who omits fields has still told us something happened.
    const out = validateBatch([good({ payload: {} }), good({ payload: { note: 'fire' } })]);
    expect(out.valid).toHaveLength(2);
    expect(out.rejected).toHaveLength(0);
  });

  it('rejects an event with no usable id, and says why', () => {
    const out = validateBatch([good({ eventId: 'not-a-uuid' })]);
    expect(out.valid).toHaveLength(0);
    expect(out.rejected[0]!.reason).toMatch(/eventId/);
  });

  it('rejects a missing clientSeq, because fold order depends on it (ADR-0008)', () => {
    const out = validateBatch([good({ clientSeq: undefined })]);
    expect(out.rejected[0]!.reason).toMatch(/clientSeq/);
  });

  it('one bad event never takes down the batch around it', () => {
    // During an outage a device may hold the only record of several emergencies.
    const out = validateBatch([good(), { junk: true }, good(), good({ occurredAt: 'nope' })]);
    expect(out.valid).toHaveLength(2);
    expect(out.rejected).toHaveLength(2);
  });

  it('collects every problem with an event, not just the first', () => {
    const out = validateBatch([good({ eventId: 'x', sourceChannel: 'carrier-pigeon' })]);
    expect(out.rejected[0]!.reason).toMatch(/eventId/);
    expect(out.rejected[0]!.reason).toMatch(/sourceChannel/);
  });
});

describe.skipIf(url === undefined)('sync endpoints (integration)', () => {
  let pool: Pool;
  let server: Server;
  let base: string;
  let incidentId: string;
  let seq: number;
  let actor: TestActor;

  beforeAll(async () => {
    pool = createPool(url);
    await migrate(pool, migrationsDir);
    server = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test' });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // There is no longer a way in without a session — that is the point of INV-05.
    actor = await seedActor(pool, { title: 'Sync Test Seat' });
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  });

  beforeEach(() => {
    incidentId = randomUUID();
    seq = 0;
  });

  function ev(type: string, payload: Record<string, unknown> = {}): Record<string, unknown> {
    seq += 1;
    return {
      eventId: randomUUID(),
      incidentId,
      type,
      // One shared instant, as a real offline batch has. See ADR-0008.
      occurredAt: '2026-08-01T14:02:00.000Z',
      clientSeq: seq,
      actorPersonId: randomUUID(),
      actorSeatId: randomUUID(),
      sourceChannel: 'mobile',
      payload,
    };
  }

  async function push(events: unknown[]): Promise<Record<string, never>> {
    const res = await fetch(`${base}/sync`, {
      method: 'POST',
      headers: authHeaders(actor.token),
      body: JSON.stringify({ deviceId: randomUUID(), events }),
    });
    return (await res.json()) as Record<string, never>;
  }

  it('reports database health honestly', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, db: 'up' });
  });

  it('accepts a batch and stores it', async () => {
    const body = (await push([
      ev('reported', { category: 'rta', severity: 'high' }),
      ev('triaged', { category: 'rta', severity: 'critical' }),
    ])) as unknown as { accepted: string[]; appended: number; cursor: number };

    expect(body.accepted).toHaveLength(2);
    expect(body.appended).toBe(2);
    expect(body.cursor).toBeGreaterThan(0);

    const state = foldIncident(incidentId, await loadIncident(pool, incidentId));
    expect(state.severity?.value).toBe('critical');
  });

  it('tells the client exactly what it may stop holding', async () => {
    // The whole contract. Anything absent from `accepted` stays in the outbox.
    const a = ev('reported', { severity: 'high' });
    const bad = { ...ev('triaged'), eventId: 'not-a-uuid' };

    const body = (await push([a, bad])) as unknown as {
      accepted: string[];
      rejected: { reason: string }[];
    };

    expect(body.accepted).toEqual([a['eventId']]);
    expect(body.rejected).toHaveLength(1);
  });

  it('reports an already-held event as accepted, so the client can release it', async () => {
    // Exactly the ambiguous-network case: the client does not know its first push landed.
    const batch = [ev('reported', { severity: 'high' }), ev('acknowledged')];

    const first = (await push(batch)) as unknown as { appended: number; accepted: string[] };
    const second = (await push(batch)) as unknown as {
      appended: number;
      duplicates: number;
      accepted: string[];
    };

    expect(first.appended).toBe(2);
    expect(second.appended).toBe(0);
    expect(second.duplicates).toBe(2);
    // Still accepted — the server holds them, which is what the client needs to know.
    expect(second.accepted).toEqual(first.accepted);
    expect(await loadIncident(pool, incidentId)).toHaveLength(2);
  });

  it('pulls only what the client is missing, and advances the cursor', async () => {
    const before = await fetch(`${base}/sync?cursor=0&limit=10000`, {
      headers: authHeaders(actor.token),
    });
    const start = ((await before.json()) as { nextCursor: number }).nextCursor;

    await push([ev('reported', { severity: 'low' })]);

    const res = await fetch(`${base}/sync?cursor=${start}`, { headers: authHeaders(actor.token) });
    const page = (await res.json()) as { events: { incidentId: string }[]; nextCursor: number };

    expect(page.events.some((e) => e.incidentId === incidentId)).toBe(true);
    expect(page.nextCursor).toBeGreaterThan(start);

    const drained = await fetch(`${base}/sync?cursor=${page.nextCursor}`, {
      headers: authHeaders(actor.token),
    });
    expect(((await drained.json()) as { events: unknown[] }).events).toHaveLength(0);
  });

  it('rejects a malformed cursor rather than guessing', async () => {
    const res = await fetch(`${base}/sync?cursor=-5`, { headers: authHeaders(actor.token) });
    expect(res.status).toBe(400);
  });

  it('rejects invalid json without crashing', async () => {
    const res = await fetch(`${base}/sync`, {
      method: 'POST',
      headers: authHeaders(actor.token),
      body: '{ not json',
    });
    expect(res.status).toBe(400);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it('never lets the client set recordedAt', async () => {
    const forged = { ...ev('reported', { severity: 'high' }), recordedAt: '1999-01-01T00:00:00Z' };
    await push([forged]);

    const [stored] = await loadIncident(pool, incidentId);
    expect(stored!.recordedAt.startsWith('1999')).toBe(false);
  });
});
