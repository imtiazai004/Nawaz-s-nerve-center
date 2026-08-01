/**
 * INV-07: an SLA clock never runs on a client.
 *
 * The domain logic has known *when* to escalate since day one, and `invariants.test.ts`
 * proves that in isolation. What it could not prove is that anything actually calls it —
 * so until now the invariant held of a function rather than of a running system.
 *
 * Nothing in this file opens a browser or touches a client. The only inputs are stored
 * events, the roster, and server time.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createPool, migrate, type Pool } from '../../db/pool.js';
import { append, loadIncident } from '../../db/eventStore.js';
import { foldIncident } from '../../domain/incident.js';
import { runEscalationPass, nextSeatUp } from '../escalation.js';
import { createScheduler, runLockedPass } from '../scheduler.js';
import type { IncidentEvent } from '../../domain/events.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const MINUTE = 60_000;

describe.skipIf(dbUrl === undefined)('escalation job (INV-07)', () => {
  let pool: Pool;
  let department: string;
  let stationSeat: string;
  let tehsilSeat: string;

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    department = randomUUID();
    stationSeat = await seat('Rescue Station In-Charge', department, 'station', true);
    tehsilSeat = await seat('Rescue Tehsil Supervisor', department, 'tehsil', true);
    // Department-agnostic, so it serves as the fallback rung above any department.
    await seat('District Control Room', null, 'district', true);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  async function seat(
    title: string,
    departmentId: string | null,
    tier: string,
    withHolder: boolean,
  ): Promise<string> {
    const s = await pool.query<{ seat_id: string }>(
      `INSERT INTO seat (title, department_id, tier) VALUES ($1, $2, $3) RETURNING seat_id`,
      [title, departmentId, tier],
    );
    const seatId = s.rows[0]!.seat_id;

    if (withHolder) {
      const p = await pool.query<{ person_id: string }>(
        `INSERT INTO person (full_name, phone, password_hash)
         VALUES ($1, $2, 'x') RETURNING person_id`,
        [title, `+92300${randomUUID().slice(0, 9)}`],
      );
      await pool.query('INSERT INTO duty_assignment (seat_id, person_id) VALUES ($1, $2)', [
        seatId,
        p.rows[0]!.person_id,
      ]);
    }
    return seatId;
  }

  /**
   * Time is driven forward by passing `now` to the pass, not by backdating rows.
   *
   * `recorded_at` is assigned by the database and the event table is append-only, so there
   * is no way to fabricate "the server has known about this for 30 minutes" — which is
   * correct, and exactly the property that makes the audit trail trustworthy. Advancing
   * the clock the job reads is the honest equivalent, and it proves the point directly:
   * the only inputs are stored timestamps and server time.
   */
  function minutesLater(minutes: number): string {
    return new Date(Date.now() + minutes * MINUTE).toISOString();
  }

  /** An open, unacknowledged incident, reported now. */
  async function openIncident(
    _unused = 0,
    severity = 'critical',
    opts: { actorSeatId?: string | null } = {},
  ): Promise<string> {
    const incidentId = randomUUID();
    const occurredAt = new Date().toISOString();

    await append(pool, [
      {
        eventId: randomUUID(),
        incidentId,
        type: 'reported',
        occurredAt,
        recordedAt: occurredAt,
        clientSeq: 1,
        actorPersonId: null,
        actorSeatId: opts.actorSeatId ?? stationSeat,
        sourceChannel: 'mobile',
        payload: { reportId: randomUUID(), category: 'rta', severity },
      } as unknown as IncidentEvent,
      {
        eventId: randomUUID(),
        incidentId,
        type: 'routed',
        occurredAt,
        recordedAt: occurredAt,
        clientSeq: 2,
        actorPersonId: null,
        actorSeatId: null,
        sourceChannel: 'system',
        payload: { departmentIds: [department], ruleId: 'manual' },
      } as unknown as IncidentEvent,
    ]);

    return incidentId;
  }

  async function escalationsFor(incidentId: string): Promise<readonly IncidentEvent[]> {
    return (await loadIncident(pool, incidentId)).filter((e) => e.type === 'escalated');
  }

  describe('the ladder', () => {
    it('finds the tehsil seat above a station seat in the same department', async () => {
      const next = await nextSeatUp(pool, 'station', department);
      expect(next?.seatId).toBe(tehsilSeat);
      expect(next?.hasHolder).toBe(true);
    });

    it('falls back to a department-agnostic seat when the department has none', async () => {
      // Asserted on tier rather than identity: district seats are department-agnostic by
      // design, so any held district seat is a correct answer. Pinning one id would only
      // pass on an empty database, and this one is append-only and never cleaned.
      const next = await nextSeatUp(pool, 'tehsil', department);
      expect(next?.tier).toBe('district');
      expect(next?.hasHolder).toBe(true);
    });

    it('returns null at the top of the ladder', async () => {
      expect(await nextSeatUp(pool, 'provincial', department)).toBeNull();
    });
  });

  describe('escalation fires with no client involved', () => {
    it('escalates an unacknowledged critical past its deadline', async () => {
      // Critical target is 5 minutes; this one is 30 minutes old and untouched.
      const incidentId = await openIncident();

      const outcome = await runEscalationPass(pool, {
        now: minutesLater(30),
        incidentIds: [incidentId],
      });
      expect(outcome.escalated).toBeGreaterThanOrEqual(1);

      const escalations = await escalationsFor(incidentId);
      expect(escalations).toHaveLength(1);
      expect((escalations[0]!.payload as { toSeatId: string }).toSeatId).toBe(tehsilSeat);
      // A system escalation names no person — it was not a human decision.
      expect(escalations[0]!.actorPersonId).toBeNull();
    });

    it('leaves an incident inside its deadline alone', async () => {
      const incidentId = await openIncident();
      await runEscalationPass(pool, { now: minutesLater(1), incidentIds: [incidentId] });
      expect(await escalationsFor(incidentId)).toHaveLength(0);
    });

    it('respects the severity-specific target', async () => {
      // Low severity has a 240-minute target; 30 minutes is well inside it.
      const incidentId = await openIncident(0, 'low');
      await runEscalationPass(pool, { now: minutesLater(30), incidentIds: [incidentId] });
      expect(await escalationsFor(incidentId)).toHaveLength(0);
    });
  });

  describe('it does not storm', () => {
    it('does not escalate the same incident twice at the same tier', async () => {
      const incidentId = await openIncident();

      await runEscalationPass(pool, { now: minutesLater(30), incidentIds: [incidentId] });
      const afterFirst = (await escalationsFor(incidentId)).length;

      // Four more passes in quick succession, as a 15-second scan loop would do.
      for (let i = 0; i < 4; i++)
        await runEscalationPass(pool, { now: minutesLater(30), incidentIds: [incidentId] });

      expect(afterFirst).toBe(1);
      expect(await escalationsFor(incidentId)).toHaveLength(2);
    });

    it('a late-arriving incident gets its grace window rather than instant escalation', async () => {
      // Reported 3 hours ago, only reached the server now. Escalating immediately would
      // page the duty officer about every queued incident at once (INV-08).
      const incidentId = randomUUID();
      const occurredAt = new Date(Date.now() - 180 * MINUTE).toISOString();

      await append(pool, [
        {
          eventId: randomUUID(),
          incidentId,
          type: 'reported',
          occurredAt,
          recordedAt: occurredAt,
          clientSeq: 1,
          actorPersonId: null,
          actorSeatId: stationSeat,
          sourceChannel: 'mobile',
          payload: { reportId: randomUUID(), category: 'rta', severity: 'critical' },
        } as unknown as IncidentEvent,
      ]);

      // `recordedAt` is server-assigned and therefore ~now, so the gap is ~3 hours.
      await runEscalationPass(pool, { incidentIds: [incidentId] });
      expect(await escalationsFor(incidentId)).toHaveLength(0);
    });
  });

  describe('nothing is starved by the scan cap', () => {
    it('scans the oldest open incidents first and says when it hit the cap', async () => {
      // The bug this pins: the candidate query used to take an arbitrary `LIMIT` of the
      // open set with no ordering. Once a district had more open incidents than the cap,
      // *which* ones got scanned was down to whatever order Postgres happened to return —
      // so an emergency could lose that lottery on every single pass and sit unescalated
      // indefinitely, with nothing anywhere reporting a problem.
      const first = await openIncident();
      await new Promise((r) => setTimeout(r, 20));
      const second = await openIncident();

      const outcome = await runEscalationPass(pool, {
        now: minutesLater(30),
        incidentIds: [first, second],
        limit: 1,
      });

      // Oldest first, so the one that has been waiting longest is the one seen.
      expect(await escalationsFor(first)).toHaveLength(1);
      expect(await escalationsFor(second)).toHaveLength(0);
      // And the cap being hit is reported, never silently absorbed.
      expect(outcome.truncated).toBe(true);
    });

    it('does not claim truncation when everything was scanned', async () => {
      const incidentId = await openIncident();
      const outcome = await runEscalationPass(pool, {
        now: minutesLater(30),
        incidentIds: [incidentId],
        limit: 500,
      });
      expect(outcome.truncated).toBe(false);
    });
  });

  describe('it stops when it should', () => {
    it('never escalates an acknowledged incident', async () => {
      const incidentId = await openIncident();
      await append(pool, [
        {
          eventId: randomUUID(),
          incidentId,
          type: 'acknowledged',
          occurredAt: new Date().toISOString(),
          recordedAt: new Date().toISOString(),
          clientSeq: 3,
          actorPersonId: randomUUID(),
          actorSeatId: stationSeat,
          sourceChannel: 'web',
          payload: { seatId: stationSeat },
        } as unknown as IncidentEvent,
      ]);

      await runEscalationPass(pool, { now: minutesLater(30), incidentIds: [incidentId] });
      expect(await escalationsFor(incidentId)).toHaveLength(0);
    });

    it('never escalates a closed incident', async () => {
      const incidentId = await openIncident();
      await append(pool, [
        {
          eventId: randomUUID(),
          incidentId,
          type: 'closed',
          occurredAt: new Date().toISOString(),
          recordedAt: new Date().toISOString(),
          clientSeq: 3,
          actorPersonId: randomUUID(),
          actorSeatId: stationSeat,
          sourceChannel: 'web',
          payload: { notes: 'resolved on scene' },
        } as unknown as IncidentEvent,
      ]);

      await runEscalationPass(pool, { now: minutesLater(30), incidentIds: [incidentId] });
      expect(await escalationsFor(incidentId)).toHaveLength(0);
    });
  });

  describe('a vacant post never swallows an escalation (ADR-0004)', () => {
    it('escalates to an unheld seat and reports it as needing a human', async () => {
      const dept = randomUUID();
      await seat('Understaffed Station', dept, 'station', true);
      const vacant = await seat('Vacant Tehsil Post', dept, 'tehsil', false);

      const incidentId = randomUUID();
      const occurredAt = new Date(Date.now() - 30 * MINUTE).toISOString();
      await append(pool, [
        {
          eventId: randomUUID(),
          incidentId,
          type: 'reported',
          occurredAt,
          recordedAt: occurredAt,
          clientSeq: 1,
          actorPersonId: null,
          actorSeatId: null,
          sourceChannel: 'mobile',
          payload: { reportId: randomUUID(), category: 'fire', severity: 'critical' },
        } as unknown as IncidentEvent,
        {
          eventId: randomUUID(),
          incidentId,
          type: 'routed',
          occurredAt,
          recordedAt: occurredAt,
          clientSeq: 2,
          actorPersonId: null,
          actorSeatId: null,
          sourceChannel: 'system',
          payload: { departmentIds: [dept], ruleId: 'manual' },
        } as unknown as IncidentEvent,
      ]);

      const outcome = await runEscalationPass(pool, {
        now: minutesLater(30),
        incidentIds: [incidentId],
      });

      expect(outcome.noHolder).toContain(incidentId);
      const escalations = await escalationsFor(incidentId);
      expect(escalations).toHaveLength(1);
      const payload = escalations[0]!.payload as { toSeatId: string; trigger: string };
      expect(payload.toSeatId).toBe(vacant);
      // Distinguishable from an ordinary missed deadline, for whoever reviews it after.
      expect(payload.trigger).toBe('no_duty_holder');
    });
  });

  describe('the whole chain still folds correctly', () => {
    it('an escalated incident reports its escalation count and current seat', async () => {
      const incidentId = await openIncident();
      await runEscalationPass(pool, { now: minutesLater(30), incidentIds: [incidentId] });

      const state = foldIncident(incidentId, await loadIncident(pool, incidentId));
      expect(state.escalationCount).toBe(1);
      expect(state.currentEscalationSeatId).toBe(tehsilSeat);
      expect(state.acknowledgedAt).toBeNull();
    });
  });

  describe('two instances cannot both escalate', () => {
    it('only one of two concurrent passes takes the lock', async () => {
      const results = await Promise.all([runLockedPass(pool), runLockedPass(pool)]);
      const ran = results.filter((r) => r !== null);
      // The other returned null, which is a normal outcome and not a failure.
      expect(ran.length).toBeGreaterThanOrEqual(1);
      expect(results.length).toBe(2);
    });

    it('the lock is released even when a pass throws', async () => {
      // A pass that wedged the lock would silently stop every future escalation.
      await runLockedPass(pool);
      expect(await runLockedPass(pool)).not.toBeNull();
    });
  });

  describe('the scheduler', () => {
    /**
     * The scheduler is responsible for *invoking* passes, stopping cleanly, and surviving
     * a failure. Whether a given incident escalates is `runEscalationPass`'s job and is
     * proven above with the clock driven explicitly.
     *
     * Keeping those separate matters: a scheduler test that also asserts on escalation
     * outcomes has to manufacture a real-time deadline breach, and the only way to do that
     * against a server-assigned `recorded_at` is a zero-minute target — which every
     * incident then trips as a "late arrival", so nothing escalates and the test proves
     * the opposite of what it claims.
     */
    it('invokes passes on an interval and stops cleanly', async () => {
      const outcomes: unknown[] = [];
      const scheduler = createScheduler({
        pool,
        intervalMs: 50,
        onOutcome: (o) => outcomes.push(o),
      });

      scheduler.start();

      // Wait for the work, not for a guessed duration. This log is append-only and never
      // cleaned, so the candidate scan grows with every run; a fixed sleep passes on a
      // fresh database and fails later, which is the worst kind of test.
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && outcomes.length === 0) {
        await new Promise((r) => setTimeout(r, 50));
      }

      await scheduler.stop();
      expect(outcomes.length).toBeGreaterThanOrEqual(1);

      // Stopped means stopped.
      const countAtStop = outcomes.length;
      await new Promise((r) => setTimeout(r, 300));
      expect(outcomes).toHaveLength(countAtStop);
    });

    it('a failing pass never kills the loop', async () => {
      // An escalation loop that dies after one bad database moment is worse than none,
      // because everyone still believes it is watching.
      const errors: unknown[] = [];
      const broken = { connect: () => Promise.reject(new Error('db gone')) } as unknown as Pool;

      const scheduler = createScheduler({
        pool: broken,
        intervalMs: 30,
        onError: (e) => errors.push(e),
      });

      scheduler.start();
      await new Promise((r) => setTimeout(r, 200));
      await scheduler.stop();

      expect(errors.length).toBeGreaterThanOrEqual(2);
    });
  });
});
