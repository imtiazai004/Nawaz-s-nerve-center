/**
 * The central board — M0-33.
 *
 * What is under test is not "the list renders". It is the three things a board can silently
 * get wrong, each of which ends with somebody not being sent to an emergency:
 *
 *   - it shows another department's incidents, or hides its own (INV-05)
 *   - it folds an unassessed report into a severity level (ADR-0009, INV-04)
 *   - it presents data older than it claims (INV-02)
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSyncServer } from '../server.js';
import { createPool, migrate, type Pool } from '../../db/pool.js';
import { seedDepartment } from '../../testing/seed.js';
import { hashPassword } from '../../auth/passwords.js';
import { login } from '../../auth/sessions.js';
import type { Board } from '../board.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const PASSWORD = 'duty-officer-2026';

describe.skipIf(dbUrl === undefined)('the central board (integration)', () => {
  let pool: Pool;
  let server: Server;
  let base: string;

  let rescueDept: string;
  let policeDept: string;
  let rescueToken: string;
  let policeToken: string;
  let controlRoomToken: string;

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    server = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    rescueDept = await seedDepartment(pool, 'Rescue 1122 (test)');
    policeDept = await seedDepartment(pool, 'Police (test)');

    rescueToken = await actor('Rescue Duty Officer', rescueDept, 'station');
    policeToken = await actor('Police Duty Officer', policeDept, 'station');
    controlRoomToken = await actor('Control Room Operator', null, 'district');
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
  });

  async function actor(name: string, departmentId: string | null, tier: string): Promise<string> {
    const seat = await pool.query<{ seat_id: string }>(
      `INSERT INTO seat (title, department_id, tier, can_break_glass)
       VALUES ($1, $2, $3, false) RETURNING seat_id`,
      [name, departmentId, tier],
    );
    const phone = `+92300${randomUUID().slice(0, 10)}`;
    const person = await pool.query<{ person_id: string }>(
      `INSERT INTO person (full_name, phone, password_hash)
       VALUES ($1, $2, $3) RETURNING person_id`,
      [name, phone, await hashPassword(PASSWORD)],
    );
    await pool.query('INSERT INTO duty_assignment (seat_id, person_id) VALUES ($1, $2)', [
      seat.rows[0]!.seat_id,
      person.rows[0]!.person_id,
    ]);
    const result = await login(pool, phone, PASSWORD);
    if (result === null) throw new Error(`login failed for ${name}`);
    return result.token;
  }

  async function post(
    path: string,
    token: string,
    body: unknown,
  ): Promise<Record<string, unknown>> {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return (await res.json()) as Record<string, unknown>;
  }

  async function board(token: string | null): Promise<{ status: number; body: Board }> {
    const res = await fetch(`${base}/incidents`, {
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
    });
    return { status: res.status, body: (await res.json()) as Board };
  }

  /** An incident routed to a department, optionally with a stated severity. */
  async function incident(departmentId: string, severity?: string): Promise<string> {
    const created = await post('/incidents', controlRoomToken, {
      category: 'rta',
      ...(severity === undefined ? {} : { severity }),
    });
    const id = created['incidentId'] as string;
    await post(`/incidents/${id}/route`, controlRoomToken, {
      departmentIds: [departmentId],
      reason: 'board test',
    });
    return id;
  }

  const rowFor = (b: Board, id: string) => b.incidents.find((r) => r.incidentId === id);

  it('requires a session', async () => {
    expect((await board(null)).status).toBe(401);
  });

  describe('scoping is server-side (INV-05)', () => {
    it("does not send another department its neighbours' incidents", async () => {
      const mine = await incident(rescueDept, 'high');
      const theirs = await incident(policeDept, 'high');

      const rescue = await board(rescueToken);
      expect(rowFor(rescue.body, mine)).toBeDefined();
      // Not merely hidden in the UI — never sent.
      expect(rowFor(rescue.body, theirs)).toBeUndefined();

      const police = await board(policeToken);
      expect(rowFor(police.body, theirs)).toBeDefined();
      expect(rowFor(police.body, mine)).toBeUndefined();
    });

    it('shows the district everything', async () => {
      const a = await incident(rescueDept, 'high');
      const b = await incident(policeDept, 'low');
      const view = await board(controlRoomToken);
      expect(rowFor(view.body, a)).toBeDefined();
      expect(rowFor(view.body, b)).toBeDefined();
    });

    /**
     * The export is the board, so its scoping has to be the board's — capability 9.
     *
     * Written here rather than beside the CSV unit tests on purpose: the risk is not that the
     * formatting is wrong, it is that a *file departments email to each other* is built from a
     * different query than the screen and quietly answers a wider question. Same `buildBoard`,
     * same seat, therefore the same answer — asserted rather than assumed.
     */
    it('scopes the spreadsheet export exactly as it scopes the board', async () => {
      const mine = await incident(rescueDept, 'high');
      const theirs = await incident(policeDept, 'high');

      const res = await fetch(`${base}/export/incidents.csv?days=7`, {
        headers: { authorization: `Bearer ${rescueToken}` },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/csv/);
      expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="incidents-/);

      const csv = await res.text();
      expect(csv).toContain(mine);
      // Never sent, exactly as on the board.
      expect(csv).not.toContain(theirs);
    });

    it('refuses the export without a session', async () => {
      expect((await fetch(`${base}/export/incidents.csv`)).status).toBe(401);
    });
  });

  describe('an unassessed report is never dressed as a level (ADR-0009, INV-04)', () => {
    it('marks the row unassessed rather than giving it a severity', async () => {
      const id = await incident(rescueDept); // no severity stated
      const row = rowFor((await board(rescueToken)).body, id);
      expect(row?.severity).toBe('unknown');
      expect(row?.assessed).toBe(false);
    });

    it('counts it separately in the summary, in neither direction', async () => {
      const view = await board(controlRoomToken);
      // It is not folded into `worst` — which is the count that would hide it — and it is
      // not counted as a critical either, which would hide the real ones among them.
      expect(view.body.summary.unassessed).toBeGreaterThan(0);
      expect(view.body.summary.worst).not.toBe('unknown');
    });

    it('still puts it near the top of the queue, because it could be anything', async () => {
      // Ordering for attention is a different question from ranking for aggregation, and
      // this is the one place they legitimately differ. See `attentionRank`.
      const view = await board(rescueToken);
      const unassessed = view.body.incidents.findIndex((r) => !r.assessed && !r.overdue);
      const low = view.body.incidents.findIndex(
        (r) => r.severity === 'low' && !r.overdue && r.acknowledgedAt === null,
      );
      if (unassessed !== -1 && low !== -1) expect(unassessed).toBeLessThan(low);
    });
  });

  describe('it says how old it is (INV-02)', () => {
    it('stamps every response with the server time it was folded', async () => {
      const view = await board(rescueToken);
      expect(Number.isFinite(Date.parse(view.body.asOf))).toBe(true);
    });

    it('carries lastRecordedAt on every row, so a client can age it', async () => {
      const id = await incident(rescueDept, 'high');
      const row = rowFor((await board(rescueToken)).body, id);
      expect(row?.lastRecordedAt).not.toBeNull();
      expect(Number.isFinite(Date.parse(row!.lastRecordedAt!))).toBe(true);
    });
  });

  describe('what the board is for', () => {
    it('puts unacknowledged work above work already picked up', async () => {
      const acked = await incident(rescueDept, 'critical');
      await post(`/incidents/${acked}/acknowledge`, rescueToken, {});
      const open = await incident(rescueDept, 'low');

      const rows = (await board(rescueToken)).body.incidents;
      expect(rows.findIndex((r) => r.incidentId === open)).toBeLessThan(
        rows.findIndex((r) => r.incidentId === acked),
      );
    });

    it('drops an incident once it is closed', async () => {
      const id = await incident(rescueDept, 'low');
      await post(`/incidents/${id}/acknowledge`, rescueToken, {});
      await post(`/incidents/${id}/resolve`, rescueToken, { outcome: 'cleared' });
      await post(`/incidents/${id}/close`, rescueToken, { notes: 'done' });

      expect(rowFor((await board(rescueToken)).body, id)).toBeUndefined();
    });

    it('shows a district override without erasing what the department said', async () => {
      const id = await incident(rescueDept, 'high');
      await post(`/incidents/${id}/triage`, rescueToken, { severity: 'high', category: 'rta' });
      await post(`/incidents/${id}/override`, controlRoomToken, {
        field: 'severity',
        value: 'critical',
        reason: 'second reporter confirms casualties',
      });

      const row = rowFor((await board(rescueToken)).body, id);
      expect(row?.severity).toBe('critical');
      // The department's own assessment is on the board too, not buried in a detail view.
      expect(row?.overriddenFrom).toBe('high');
    });

    it('counts open, unacknowledged and overdue honestly', async () => {
      const view = await board(controlRoomToken);
      const { summary, incidents } = view.body;
      expect(summary.open).toBe(incidents.filter((r) => r.status !== 'closed').length);
      expect(summary.unacknowledged).toBe(
        incidents.filter((r) => r.acknowledgedAt === null).length,
      );
      expect(summary.overdue).toBe(incidents.filter((r) => r.overdue).length);
    });
  });
});
