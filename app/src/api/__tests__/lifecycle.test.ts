/**
 * The incident lifecycle over HTTP — M0-24…28, 30, 31.
 *
 * Every one of these goes through the real server against the real database. Nothing is
 * driven through a browser and nothing is stubbed, for the reason INV-05 exists: an
 * authority rule that only holds when you use the app is not a rule, and the people this
 * system must withstand will use `curl`.
 *
 * The suite is organised around what each check is protecting, not around the endpoints, so
 * a deleted test is visibly a deleted protection.
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
import { loadIncident } from '../../db/eventStore.js';
import { hashPassword } from '../../auth/passwords.js';
import { login } from '../../auth/sessions.js';
import { ASSUMED_CATEGORY, ASSUMED_SEVERITY } from '../lifecycle.js';
import { PLACEHOLDER_SLA } from '../../domain/sla.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const PASSWORD = 'duty-officer-2026';

describe.skipIf(dbUrl === undefined)('incident lifecycle over HTTP (integration)', () => {
  let pool: Pool;
  let server: Server;
  let base: string;

  let rescueDept: string;
  let policeDept: string;

  let rescueToken: string;
  let rescueSupervisorToken: string;
  let policeToken: string;
  let controlRoomToken: string;
  let dcToken: string;
  let seatlessToken: string;

  let rescueSeat: string;
  let controlRoomSeat: string;

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    server = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    rescueDept = await seedDepartment(pool, 'Rescue 1122 (test)');
    policeDept = await seedDepartment(pool, 'Police (test)');

    rescueSeat = await makeSeat('Rescue 1122 Station In-Charge', rescueDept, 'station');
    const rescueSupervisorSeat = await makeSeat(
      'Rescue 1122 Tehsil Supervisor',
      rescueDept,
      'tehsil',
    );
    const policeSeat = await makeSeat('SHO Bannu City', policeDept, 'station');
    controlRoomSeat = await makeSeat('District Control Room', null, 'district');
    const dcSeat = await makeSeat('Deputy Commissioner Bannu', null, 'district', true);

    rescueToken = await actor('Rescue Duty Officer', rescueSeat);
    rescueSupervisorToken = await actor('Rescue Supervisor', rescueSupervisorSeat);
    policeToken = await actor('Police Duty Officer', policeSeat);
    controlRoomToken = await actor('Control Room Operator', controlRoomSeat);
    dcToken = await actor('Deputy Commissioner', dcSeat);
    seatlessToken = await actor('Transferred Officer', null);
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
  });

  async function makeSeat(
    title: string,
    departmentId: string | null,
    tier: string,
    breakGlass = false,
  ): Promise<string> {
    const res = await pool.query<{ seat_id: string }>(
      `INSERT INTO seat (title, department_id, tier, can_break_glass)
       VALUES ($1, $2, $3, $4) RETURNING seat_id`,
      [title, departmentId, tier, breakGlass],
    );
    return res.rows[0]!.seat_id;
  }

  /** A person, optionally holding a seat, signed in. Null seat = authenticated, no authority. */
  async function actor(name: string, seatId: string | null): Promise<string> {
    const phone = `+92300${randomUUID().slice(0, 10)}`;
    const person = await pool.query<{ person_id: string }>(
      `INSERT INTO person (full_name, phone, password_hash)
       VALUES ($1, $2, $3) RETURNING person_id`,
      [name, phone, await hashPassword(PASSWORD)],
    );
    if (seatId !== null) {
      await pool.query('INSERT INTO duty_assignment (seat_id, person_id) VALUES ($1, $2)', [
        seatId,
        person.rows[0]!.person_id,
      ]);
    }
    const result = await login(pool, phone, PASSWORD);
    if (result === null) throw new Error(`login failed for ${name}`);
    return result.token;
  }

  async function call(
    method: string,
    path: string,
    token: string | null,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const sendsBody = method !== 'GET' && method !== 'HEAD' && body !== undefined;
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      ...(sendsBody ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return {
      status: res.status,
      body: (text.length > 0 ? JSON.parse(text) : {}) as Record<string, unknown>,
    };
  }

  /** A reported incident, already routed to Rescue. The starting point for most tests. */
  async function routedIncident(): Promise<string> {
    const created = await call('POST', '/incidents', controlRoomToken, {
      category: 'rta',
      severity: 'high',
    });
    const id = created.body['incidentId'] as string;
    const routed = await call('POST', `/incidents/${id}/route`, controlRoomToken, {
      departmentIds: [rescueDept],
      reason: 'road traffic accident on the Kohat road',
    });
    expect(routed.status).toBe(200);
    return id;
  }

  describe('intake never refuses (M0-24, INV-01)', () => {
    it('accepts a complete report', async () => {
      const res = await call('POST', '/incidents', rescueToken, {
        category: 'fire',
        severity: 'critical',
      });
      expect(res.status).toBe(201);
      expect(res.body['assumed']).toEqual([]);
    });

    it('accepts a report with no fields at all, and says what it assumed', async () => {
      // Someone told us an emergency is happening. Refusing that to enforce a schema would
      // be the system choosing to lose it.
      const res = await call('POST', '/incidents', rescueToken, {});
      expect(res.status).toBe(201);
      expect(res.body['assumed']).toEqual(['category', 'severity']);

      const events = await loadIncident(pool, res.body['incidentId'] as string);
      // Two: the report, and the automatic routing pass that follows it (ADR-0010).
      expect(events.map((e) => e.type)).toEqual(['reported', 'routed']);
      expect(events[0]!.payload).toMatchObject({
        category: ASSUMED_CATEGORY,
        severity: ASSUMED_SEVERITY,
      });

      // A report with no category cannot be routed by category — that would treat a
      // placeholder as an assessment — and there is no description to search either. So it
      // is unassigned, and it says so rather than going quiet.
      expect(res.body['unassigned']).toBe(true);
      expect(res.body['routedTo']).toEqual([]);
    });

    it('accepts a report whose body is not even valid json', async () => {
      const res = await fetch(`${base}/incidents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${rescueToken}` },
        body: '{this is not json',
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { assumed: string[] };
      expect(body.assumed).toContain('severity');
    });

    it('replaces a nonsense severity rather than rejecting the report', async () => {
      const res = await call('POST', '/incidents', rescueToken, {
        category: 'flood',
        severity: 'apocalyptic',
      });
      expect(res.status).toBe(201);
      expect(res.body['assumed']).toEqual(['severity']);
    });

    it('records an unstated severity as unknown, never as a guessed level (ADR-0009)', async () => {
      // The old behaviour guessed `high`. It was defensible and it was wrong: on a screen,
      // an assumption is indistinguishable from an assessment.
      const res = await call('POST', '/incidents', rescueToken, { category: 'flood' });
      const events = await loadIncident(pool, res.body['incidentId'] as string);
      expect((events[0]!.payload as { severity: string }).severity).toBe('unknown');
      expect(ASSUMED_SEVERITY).toBe('unknown');
    });

    it('refuses to let triage set a severity back to unknown', async () => {
      // Triage is the act of assessing. Revising an assessment to "no assessment" is not a
      // thing an operator does, and `unknown` is intake's value alone.
      const id = await routedIncident();
      const res = await call('POST', `/incidents/${id}/triage`, rescueToken, {
        severity: 'unknown',
        category: 'rta',
      });
      expect(res.status).toBe(400);
    });

    it('escalates an unassessed report on the high deadline, not the low one', async () => {
      // The urgency the old guess expressed now lives in the SLA target, where it does not
      // lie on a screen. Same effect on escalation; no false claim about who judged what.
      expect(PLACEHOLDER_SLA.unknown).toBe(PLACEHOLDER_SLA.high);
    });

    it('refuses to accept an occurredAt in the future', async () => {
      // A clock skewed forward would push the SLA deadline out and quietly buy the incident
      // extra time before it escalates. The report is still accepted; the claim is not.
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const res = await call('POST', '/incidents', rescueToken, {
        category: 'rta',
        severity: 'high',
        occurredAt: future,
      });
      expect(res.status).toBe(201);
      expect(res.body['assumed']).toEqual(['occurredAt']);

      const events = await loadIncident(pool, res.body['incidentId'] as string);
      expect(events[0]!.occurredAt < future).toBe(true);
    });

    it('keeps a stated past occurredAt — the offline case', async () => {
      const earlier = new Date(Date.now() - 90 * 60 * 1000).toISOString();
      const res = await call('POST', '/incidents', rescueToken, {
        category: 'rta',
        severity: 'high',
        occurredAt: earlier,
      });
      expect(res.body['assumed']).toEqual([]);

      const events = await loadIncident(pool, res.body['incidentId'] as string);
      expect(new Date(events[0]!.occurredAt).toISOString()).toBe(earlier);
      // recordedAt is the server's, and it is later. That gap is the district's measured
      // connectivity picture (ADR-0002).
      expect(events[0]!.recordedAt > events[0]!.occurredAt).toBe(true);
    });
  });

  describe('authentication and seats', () => {
    it('refuses every lifecycle path without a session', async () => {
      const id = await routedIncident();
      for (const [method, path] of [
        ['POST', '/incidents'],
        ['GET', `/incidents/${id}`],
        ['POST', `/incidents/${id}/triage`],
        ['POST', `/incidents/${id}/acknowledge`],
        ['POST', `/incidents/${id}/close`],
      ] as const) {
        const res = await call(method, path, null, method === 'GET' ? undefined : {});
        expect(res.status).toBe(401);
      }
    });

    it('refuses a signed-in officer who holds no seat', async () => {
      // Authenticated, and with no authority whatsoever. Authority is the seat's (ADR-0004).
      const id = await routedIncident();
      const res = await call('POST', `/incidents/${id}/acknowledge`, seatlessToken, {});
      expect(res.status).toBe(403);
      expect(res.body['error']).toMatch(/no current duty assignment/);
    });
  });

  describe('routing (M0-27) and reassignment (M0-30)', () => {
    it('lets the control room route an unrouted incident', async () => {
      const created = await call('POST', '/incidents', controlRoomToken, {
        category: 'fire',
        severity: 'high',
      });
      const id = created.body['incidentId'] as string;

      const res = await call('POST', `/incidents/${id}/route`, controlRoomToken, {
        departmentIds: [rescueDept],
        reason: 'structure fire, Rescue leads',
      });
      expect(res.status).toBe(200);
      expect(
        (res.body['state'] as { responsibleDepartmentIds: string[] }).responsibleDepartmentIds,
      ).toEqual([rescueDept]);
    });

    it('refuses a station-tier seat trying to route', async () => {
      // Routing authority is tehsil and above. A station in-charge cannot hand work to
      // another department by themselves.
      const created = await call('POST', '/incidents', rescueToken, {
        category: 'fire',
        severity: 'high',
      });
      const res = await call(
        'POST',
        `/incidents/${created.body['incidentId'] as string}/route`,
        rescueToken,
        { departmentIds: [policeDept], reason: 'not ours' },
      );
      expect(res.status).toBe(403);
    });

    it('requires a reason to route', async () => {
      const created = await call('POST', '/incidents', controlRoomToken, { category: 'rta' });
      const res = await call(
        'POST',
        `/incidents/${created.body['incidentId'] as string}/route`,
        controlRoomToken,
        { departmentIds: [rescueDept] },
      );
      expect(res.status).toBe(400);
      expect(res.body['error']).toMatch(/reason/);
    });

    it('sends a second routing attempt to reassign, so the handover is recorded as one', async () => {
      const id = await routedIncident();
      const res = await call('POST', `/incidents/${id}/route`, controlRoomToken, {
        departmentIds: [policeDept],
        reason: 'wrong department',
      });
      expect(res.status).toBe(409);
      expect(res.body['error']).toMatch(/reassign/);
    });

    it('reassigns with a reason, and the reason is in the log', async () => {
      const id = await routedIncident();
      const res = await call('POST', `/incidents/${id}/reassign`, controlRoomToken, {
        departmentIds: [policeDept],
        reason: 'crowd control required; Police leads from here',
      });
      expect(res.status).toBe(200);

      const events = await loadIncident(pool, id);
      const reassigned = events.find((e) => e.type === 'reassigned');
      expect(reassigned?.payload).toMatchObject({
        toDepartmentIds: [policeDept],
        reason: 'crowd control required; Police leads from here',
      });
    });

    it('refuses a reassignment with no reason (INV-06)', async () => {
      const id = await routedIncident();
      const res = await call('POST', `/incidents/${id}/reassign`, controlRoomToken, {
        departmentIds: [policeDept],
      });
      expect(res.status).toBe(400);
    });
  });

  describe('triage (M0-26)', () => {
    it('lets the owning department triage its own incident', async () => {
      const id = await routedIncident();
      const res = await call('POST', `/incidents/${id}/triage`, rescueToken, {
        severity: 'critical',
        category: 'rta-multiple-casualty',
      });
      expect(res.status).toBe(200);
      const state = res.body['state'] as { severity: { value: string }; status: string };
      expect(state.severity.value).toBe('critical');
    });

    it('refuses a department with no stake in the incident', async () => {
      const id = await routedIncident();
      const res = await call('POST', `/incidents/${id}/triage`, policeToken, {
        severity: 'low',
        category: 'nothing to see',
      });
      // Not a 403: Police has no authority to read this incident either, and confirming it
      // exists would itself disclose another department's operations.
      expect(res.status).toBe(404);
    });

    it('rejects a severity outside the scale', async () => {
      const id = await routedIncident();
      const res = await call('POST', `/incidents/${id}/triage`, rescueToken, {
        severity: 'extremely bad',
        category: 'rta',
      });
      expect(res.status).toBe(400);
    });
  });

  describe('acknowledgement (M0-28)', () => {
    it('records the seat from the session, not from the body', async () => {
      // The whole audit trail rests on this. A client that can name its own seat can put a
      // lie into the record, and the record is faithful — it would preserve it forever.
      const id = await routedIncident();
      const res = await call('POST', `/incidents/${id}/acknowledge`, rescueToken, {
        seatId: controlRoomSeat,
        actorSeatId: controlRoomSeat,
      });
      expect(res.status).toBe(200);

      const events = await loadIncident(pool, id);
      const ack = events.find((e) => e.type === 'acknowledged')!;
      expect(ack.actorSeatId).toBe(rescueSeat);
      expect((ack.payload as { seatId: string }).seatId).toBe(rescueSeat);
    });

    it('refuses an acknowledgement before the incident has been routed', async () => {
      const created = await call('POST', '/incidents', controlRoomToken, { category: 'rta' });
      const res = await call(
        'POST',
        `/incidents/${created.body['incidentId'] as string}/acknowledge`,
        controlRoomToken,
        {},
      );
      expect(res.status).toBe(409);
      expect(res.body['error']).toMatch(/not been routed/);
    });

    it('refuses a second acknowledgement rather than restarting the clock', async () => {
      const id = await routedIncident();
      expect((await call('POST', `/incidents/${id}/acknowledge`, rescueToken, {})).status).toBe(
        200,
      );
      const again = await call('POST', `/incidents/${id}/acknowledge`, rescueToken, {});
      expect(again.status).toBe(409);
      expect(again.body['error']).toMatch(/already acknowledged/);
    });

    it('lets a supervisor in the same department acknowledge', async () => {
      const id = await routedIncident();
      const res = await call('POST', `/incidents/${id}/acknowledge`, rescueSupervisorToken, {});
      expect(res.status).toBe(200);
    });

    it('lets the control room acknowledge, but only with a reason', async () => {
      // Acknowledgement stops the SLA clock. The control room doing it on a department's
      // behalf is legitimate — after escalation, it is the whole point — and it is exactly
      // the thing that has to be explainable afterwards.
      const id = await routedIncident();
      const without = await call('POST', `/incidents/${id}/acknowledge`, controlRoomToken, {});
      expect(without.status).toBe(403);

      const withReason = await call('POST', `/incidents/${id}/acknowledge`, controlRoomToken, {
        reason: 'escalated twice with no response; control room taking it',
      });
      expect(withReason.status).toBe(200);
    });
  });

  describe('override (ADR-0003)', () => {
    it("keeps the department's own assessment underneath the district's", async () => {
      const id = await routedIncident();
      await call('POST', `/incidents/${id}/triage`, rescueToken, {
        severity: 'high',
        category: 'rta',
      });

      const res = await call('POST', `/incidents/${id}/override`, controlRoomToken, {
        field: 'severity',
        value: 'critical',
        reason: 'second reporter confirms multiple casualties',
      });
      expect(res.status).toBe(200);

      const state = res.body['state'] as {
        severity: { value: string; overriddenFrom?: { value: string; reason: string } };
      };
      expect(state.severity.value).toBe('critical');
      expect(state.severity.overriddenFrom?.value).toBe('high');
      expect(state.severity.overriddenFrom?.reason).toMatch(/multiple casualties/);
    });

    it('refuses an override with no reason', async () => {
      const id = await routedIncident();
      const res = await call('POST', `/incidents/${id}/override`, controlRoomToken, {
        field: 'severity',
        value: 'critical',
      });
      expect(res.status).toBe(400);
    });

    it('lets the owning department emit one too — pinned as current behaviour, not endorsed', async () => {
      // The policy table makes the owner allowed on its own fields, so an owner override is
      // permitted. It is attributable — `actorSeatId` is the department's own seat, so
      // nobody can manufacture the appearance of a district decision — but whether a
      // department should be able to use `overridden` at all, rather than triaging again,
      // is a live question. Pinned here so a future change to it is deliberate. See Q-17.
      const id = await routedIncident();
      const res = await call('POST', `/incidents/${id}/override`, rescueToken, {
        field: 'severity',
        value: 'low',
        reason: 'downgrading our own call',
      });
      expect(res.status).toBe(200);

      const events = await loadIncident(pool, id);
      expect(events.find((e) => e.type === 'overridden')?.actorSeatId).toBe(rescueSeat);
    });
  });

  describe('resolution and closure (M0-31)', () => {
    it('walks an incident to closed', async () => {
      const id = await routedIncident();
      await call('POST', `/incidents/${id}/acknowledge`, rescueToken, {});
      await call('POST', `/incidents/${id}/actions`, rescueToken, {
        note: 'two ambulances dispatched from Bannu station',
      });

      const resolved = await call('POST', `/incidents/${id}/resolve`, rescueToken, {
        outcome: 'four casualties transported to DHQ; road cleared',
      });
      expect(resolved.status).toBe(200);

      const closed = await call('POST', `/incidents/${id}/close`, rescueToken, {
        notes: 'handover to Police for the report',
      });
      expect(closed.status).toBe(200);
      expect((closed.body['state'] as { status: string }).status).toBe('closed');
    });

    it('refuses to close an incident that was never resolved', async () => {
      // Closure completeness is a metric this system exists to be honest about, and an
      // incident closed with no recorded outcome is the failure it measures.
      const id = await routedIncident();
      const res = await call('POST', `/incidents/${id}/close`, rescueToken, {
        notes: 'nothing to report',
      });
      expect(res.status).toBe(409);
      expect(res.body['error']).toMatch(/resolve/);
    });

    it('refuses further changes once closed', async () => {
      const id = await routedIncident();
      await call('POST', `/incidents/${id}/resolve`, rescueToken, { outcome: 'stood down' });
      await call('POST', `/incidents/${id}/close`, rescueToken, { notes: 'false alarm' });

      const res = await call('POST', `/incidents/${id}/triage`, rescueToken, {
        severity: 'low',
        category: 'rta',
      });
      expect(res.status).toBe(409);
    });

    it('still accepts a response action after closure, because it is a fact that happened', async () => {
      const id = await routedIncident();
      await call('POST', `/incidents/${id}/resolve`, rescueToken, { outcome: 'stood down' });
      await call('POST', `/incidents/${id}/close`, rescueToken, { notes: 'false alarm' });

      const res = await call('POST', `/incidents/${id}/actions`, rescueToken, {
        note: 'crew debrief logged the next morning',
      });
      expect(res.status).toBe(200);
    });
  });

  describe('cross-department access is denied by default', () => {
    it('hides an incident from a department with no stake in it', async () => {
      const id = await routedIncident();
      const res = await call('GET', `/incidents/${id}`, policeToken, undefined);
      expect(res.status).toBe(404);
    });

    it('shows it to the owning department', async () => {
      const id = await routedIncident();
      const res = await call('GET', `/incidents/${id}`, rescueToken, undefined);
      expect(res.status).toBe(200);
      expect((res.body['state'] as { incidentId: string }).incidentId).toBe(id);
    });

    it('shows it to the district, which holds override authority over it', async () => {
      const id = await routedIncident();
      expect((await call('GET', `/incidents/${id}`, controlRoomToken, undefined)).status).toBe(200);
      expect((await call('GET', `/incidents/${id}`, dcToken, undefined)).status).toBe(200);
    });

    it('shows an unrouted incident to anyone, because nobody owns it yet', async () => {
      // An emergency nobody is permitted to see is an emergency nobody picks up (INV-01).
      const created = await call('POST', '/incidents', controlRoomToken, { category: 'rta' });
      const res = await call(
        'GET',
        `/incidents/${created.body['incidentId'] as string}`,
        policeToken,
        undefined,
      );
      expect(res.status).toBe(200);
    });

    it('returns the full history alongside the state, so provenance is renderable', async () => {
      const id = await routedIncident();
      await call('POST', `/incidents/${id}/triage`, rescueToken, {
        severity: 'critical',
        category: 'rta',
      });
      const res = await call('GET', `/incidents/${id}`, rescueToken, undefined);
      const events = res.body['events'] as { type: string }[];
      // Two routing entries, and both belong in the history: the automatic pass at intake
      // (ADR-0010) and then the control room's own decision. Collapsing them would hide
      // which of the two actually sent help.
      expect(events.map((e) => e.type)).toEqual(['reported', 'routed', 'routed', 'triaged']);
    });
  });

  describe('nothing here mutates (ADR-0001)', () => {
    it('every command appends exactly one event and rewrites none', async () => {
      const id = await routedIncident();
      const before = await loadIncident(pool, id);

      await call('POST', `/incidents/${id}/triage`, rescueToken, {
        severity: 'critical',
        category: 'rta',
      });
      await call('POST', `/incidents/${id}/acknowledge`, rescueToken, {});
      await call('POST', `/incidents/${id}/resolve`, rescueToken, { outcome: 'cleared' });

      const after = await loadIncident(pool, id);
      expect(after).toHaveLength(before.length + 3);
      // The events that were already there are byte-for-byte what they were.
      expect(after.slice(0, before.length)).toEqual(before);
    });

    it('a refused command leaves no trace in the log', async () => {
      const id = await routedIncident();
      const before = await loadIncident(pool, id);
      await call('POST', `/incidents/${id}/triage`, policeToken, {
        severity: 'low',
        category: 'x',
      });
      await call('POST', `/incidents/${id}/close`, rescueToken, { notes: 'no' });
      expect(await loadIncident(pool, id)).toHaveLength(before.length);
    });
  });

  describe('routes that do not exist', () => {
    it('404s an unknown incident', async () => {
      const res = await call('GET', `/incidents/${randomUUID()}`, rescueToken, undefined);
      expect(res.status).toBe(404);
    });

    it('404s a malformed incident id without touching the database', async () => {
      const res = await call('GET', '/incidents/not-a-uuid', rescueToken, undefined);
      expect(res.status).toBe(404);
    });

    it('404s an unknown action', async () => {
      const id = await routedIncident();
      const res = await call('POST', `/incidents/${id}/annihilate`, rescueToken, {});
      expect(res.status).toBe(404);
    });

    it('405s the wrong method', async () => {
      const id = await routedIncident();
      expect((await call('DELETE', `/incidents/${id}`, rescueToken, undefined)).status).toBe(405);
      expect((await call('GET', `/incidents/${id}/triage`, rescueToken, undefined)).status).toBe(
        405,
      );
    });
  });
});
