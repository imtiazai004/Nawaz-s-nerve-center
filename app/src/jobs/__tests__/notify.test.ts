/**
 * Notifications — M0-32, and INV-03 made true of a running system.
 *
 * The invariant is one sentence: *a message that did not reach the duty officer surfaces on
 * the central board as an unmet obligation, not as a log line.* Every test here is about
 * some way that could quietly stop being true:
 *
 *   - an attempt that fails leaves no trace
 *   - "we queued it" gets recorded as "somebody knows"
 *   - a vacant post swallows the obligation, exactly as it once nearly did for escalation
 *   - a crash between attempting and recording loses the attempt
 *   - someone else can clear an unmet obligation off the board
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSyncServer } from '../../api/server.js';
import { createPool, migrate, type Pool } from '../../db/pool.js';
import { loadIncident } from '../../db/eventStore.js';
import { foldIncident } from '../../domain/incident.js';
import { unmetObligations, UNDELIVERED_AFTER_MINUTES } from '../../domain/notifications.js';
import { buildBoard } from '../../api/board.js';
import { seatOf } from '../../api/lifecycle.js';
import { hashPassword } from '../../auth/passwords.js';
import { login, resolveIdentity } from '../../auth/sessions.js';
import { seedDepartment } from '../../testing/seed.js';
import { runNotifyPass, inAppChannel, type NotificationChannel } from '../notify.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const PASSWORD = 'duty-officer-2026';

describe.skipIf(dbUrl === undefined)('notifications (INV-03)', () => {
  let pool: Pool;
  let server: Server;
  let base: string;

  let rescueDept: string;
  let policeDept: string;
  /** A department with a seat that nobody currently holds. */
  let vacantDept: string;
  let vacantSeatId: string;

  let rescueToken: string;
  let rescuePersonId: string;
  let rescueSeatId: string;
  let controlRoomToken: string;

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    server = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    rescueDept = await seedDepartment(pool, 'Rescue 1122 (test)');
    policeDept = await seedDepartment(pool, 'Police (test)');
    vacantDept = await seedDepartment(pool, 'Vacant Department (test)');

    const rescue = await actor('Rescue Duty Officer', rescueDept, 'station');
    rescueToken = rescue.token;
    rescuePersonId = rescue.personId;
    rescueSeatId = rescue.seatId;

    await actor('Police Duty Officer', policeDept, 'station');
    controlRoomToken = (await actor('Control Room', null, 'district')).token;

    // A post with nobody in it. The case that must never swallow an obligation.
    vacantSeatId = await makeSeat('Vacant Station In-Charge', vacantDept, 'station');
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
  });

  async function makeSeat(title: string, dept: string | null, tier: string): Promise<string> {
    const res = await pool.query<{ seat_id: string }>(
      `INSERT INTO seat (title, department_id, tier, can_break_glass)
       VALUES ($1, $2, $3, false) RETURNING seat_id`,
      [title, dept, tier],
    );
    return res.rows[0]!.seat_id;
  }

  async function actor(
    name: string,
    dept: string | null,
    tier: string,
  ): Promise<{ token: string; personId: string; seatId: string }> {
    const seatId = await makeSeat(name, dept, tier);
    const phone = `+92300${randomUUID().slice(0, 10)}`;
    const person = await pool.query<{ person_id: string }>(
      `INSERT INTO person (full_name, phone, password_hash)
       VALUES ($1, $2, $3) RETURNING person_id`,
      [name, phone, await hashPassword(PASSWORD)],
    );
    const personId = person.rows[0]!.person_id;
    await pool.query('INSERT INTO duty_assignment (seat_id, person_id) VALUES ($1, $2)', [
      seatId,
      personId,
    ]);
    const result = await login(pool, phone, PASSWORD);
    if (result === null) throw new Error(`login failed for ${name}`);
    return { token: result.token, personId, seatId };
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

  async function routedTo(departmentId: string): Promise<string> {
    const created = await post('/incidents', controlRoomToken, {
      category: 'rta',
      severity: 'high',
    });
    const id = created['incidentId'] as string;
    await post(`/incidents/${id}/route`, controlRoomToken, {
      departmentIds: [departmentId],
      reason: 'notification test',
    });
    return id;
  }

  const attempts = async (incidentId: string) =>
    foldIncident(incidentId, await loadIncident(pool, incidentId)).notifications;

  describe('an attempt is recorded before it is made', () => {
    it('notifies the department an incident was routed to', async () => {
      const id = await routedTo(rescueDept);
      await runNotifyPass(pool, { incidentIds: [id] });

      const list = await attempts(id);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ seatId: rescueSeatId, reason: 'routed', state: 'pending' });
    });

    it('does not notify the same seat twice for the same obligation', async () => {
      const id = await routedTo(rescueDept);
      await runNotifyPass(pool, { incidentIds: [id] });
      await runNotifyPass(pool, { incidentIds: [id] });
      await runNotifyPass(pool, { incidentIds: [id] });

      // Idempotency comes from comparing obligations against the log, not from a marker.
      // Three passes are one notification, which is what stops a scan loop becoming a
      // notification storm (INV-08).
      expect(await attempts(id)).toHaveLength(1);
    });

    it('leaves the attempt pending — queued is not delivered', async () => {
      // The lie this prevents: telling the control room an officer knows about an emergency
      // when all that happened is a row was written.
      const id = await routedTo(rescueDept);
      await runNotifyPass(pool, { incidentIds: [id] });
      expect((await attempts(id))[0]!.state).toBe('pending');
    });
  });

  describe('a failure is never invisible', () => {
    it('records a failure when the post is vacant, rather than skipping it', async () => {
      // A vacant post must not swallow an obligation — the same rule ADR-0004 forces on
      // escalation, and the same reasoning: nobody is coming, so somebody has to be told
      // that nobody is coming.
      const id = await routedTo(vacantDept);
      await runNotifyPass(pool, { incidentIds: [id] });

      const list = await attempts(id);
      expect(list).toHaveLength(1);
      expect(list[0]!.state).toBe('failed');
      expect(list[0]!.seatId).toBe(vacantSeatId);
      expect(list[0]!.failure).toContain('no_duty_holder');
    });

    it('records a failure when the channel itself fails', async () => {
      const id = await routedTo(rescueDept);
      const broken: NotificationChannel = {
        name: 'web',
        deliver: () => Promise.resolve({ ok: false, failure: 'gateway timeout after 30s' }),
      };
      await runNotifyPass(pool, { incidentIds: [id], channel: broken });

      const list = await attempts(id);
      expect(list[0]!.state).toBe('failed');
      expect(list[0]!.failure).toContain('gateway timeout');
    });

    it('records a failure when the channel throws rather than returning', async () => {
      // A channel that throws must not take the pass down with it, and must not leave the
      // attempt looking like it might have worked.
      const id = await routedTo(rescueDept);
      const exploding: NotificationChannel = {
        name: 'web',
        deliver: () => Promise.reject(new Error('DNS lookup failed')),
      };
      await runNotifyPass(pool, { incidentIds: [id], channel: exploding });

      const list = await attempts(id);
      expect(list[0]!.state).toBe('failed');
      expect(list[0]!.failure).toContain('DNS lookup failed');
    });

    it('surfaces a failed attempt on the central board, not in a log line', async () => {
      // The literal words of INV-03. If this test is deleted the invariant is gone, whatever
      // the notification code still does.
      const id = await routedTo(vacantDept);
      await runNotifyPass(pool, { incidentIds: [id] });

      const identity = await resolveIdentity(pool, rescuePersonId);
      const control = seatOf({
        personId: 'x',
        fullName: 'Control',
        seatId: randomUUID(),
        seatTitle: 'District Control Room',
        departmentId: null,
        departmentName: null,
        tier: 'district',
        canBreakGlass: false,
        isAdministration: false,
      })!;

      const board = await buildBoard(pool, control);
      const row = board.incidents.find((r) => r.incidentId === id);

      expect(row?.notificationsFailed).toBe(1);
      expect(board.summary.notificationsUnmet).toBeGreaterThan(0);
      expect(identity).not.toBeNull();
    });

    it('counts a pending attempt as unmet once it has waited too long', async () => {
      // Sent and never picked up is a different problem from could-not-send, and the board
      // reports them separately: one needs a roster fixed, the other needs a phone answered.
      const id = await routedTo(rescueDept);
      await runNotifyPass(pool, { incidentIds: [id] });

      const list = await attempts(id);
      const later = new Date(
        Date.parse(list[0]!.attemptedAt) + (UNDELIVERED_AFTER_MINUTES + 1) * 60_000,
      ).toISOString();

      const unmet = unmetObligations(list, later);
      expect(unmet).toHaveLength(1);
      expect(unmet[0]!.why).toBe('undelivered');
    });

    it('does not count a fresh pending attempt as unmet', async () => {
      const id = await routedTo(rescueDept);
      await runNotifyPass(pool, { incidentIds: [id] });
      const list = await attempts(id);
      expect(unmetObligations(list, list[0]!.attemptedAt)).toHaveLength(0);
    });
  });

  describe('the inbox, and what settles an attempt', () => {
    it('shows the seat holder what is waiting for them', async () => {
      const id = await routedTo(rescueDept);
      await runNotifyPass(pool, { incidentIds: [id] });

      const res = await fetch(`${base}/notifications`, {
        headers: { authorization: `Bearer ${rescueToken}` },
      });
      const body = (await res.json()) as { notifications: { incidentId: string }[] };
      expect(body.notifications.some((n) => n.incidentId === id)).toBe(true);
    });

    it('collecting it is what makes it delivered', async () => {
      const id = await routedTo(rescueDept);
      await runNotifyPass(pool, { incidentIds: [id] });
      const attemptId = (await attempts(id))[0]!.attemptId;

      const res = await fetch(`${base}/notifications/${attemptId}/seen`, {
        method: 'POST',
        headers: { authorization: `Bearer ${rescueToken}` },
      });
      expect(res.status).toBe(200);

      expect((await attempts(id))[0]!.state).toBe('delivered');
    });

    it('a delivered attempt leaves the inbox and stops being unmet', async () => {
      const id = await routedTo(rescueDept);
      await runNotifyPass(pool, { incidentIds: [id] });
      const attemptId = (await attempts(id))[0]!.attemptId;

      await fetch(`${base}/notifications/${attemptId}/seen`, {
        method: 'POST',
        headers: { authorization: `Bearer ${rescueToken}` },
      });

      const res = await fetch(`${base}/notifications`, {
        headers: { authorization: `Bearer ${rescueToken}` },
      });
      const body = (await res.json()) as { notifications: { attemptId: string }[] };
      expect(body.notifications.some((n) => n.attemptId === attemptId)).toBe(false);

      const later = new Date(Date.now() + 60 * 60_000).toISOString();
      expect(unmetObligations(await attempts(id), later)).toHaveLength(0);
    });

    it('refuses to let another seat clear an obligation off the board', async () => {
      // A board that can be quietened by the wrong person is worse than no board.
      const id = await routedTo(rescueDept);
      await runNotifyPass(pool, { incidentIds: [id] });
      const attemptId = (await attempts(id))[0]!.attemptId;

      const res = await fetch(`${base}/notifications/${attemptId}/seen`, {
        method: 'POST',
        headers: { authorization: `Bearer ${controlRoomToken}` },
      });
      // Not "forbidden": whose notification it is, is itself information.
      expect(res.status).toBe(404);
      expect((await attempts(id))[0]!.state).toBe('pending');
    });

    it('requires a session', async () => {
      expect((await fetch(`${base}/notifications`)).status).toBe(401);
    });
  });

  describe('a handover has two sides', () => {
    it('tells the department losing an incident, not just the one gaining it', async () => {
      // A handover nobody announced is how two departments each assume the other went.
      const id = await routedTo(rescueDept);
      await runNotifyPass(pool, { incidentIds: [id] });
      await post(`/incidents/${id}/reassign`, controlRoomToken, {
        departmentIds: [policeDept],
        reason: 'law and order, not medical',
      });
      await runNotifyPass(pool, { incidentIds: [id] });

      const reasons = (await attempts(id)).map((a) => a.reason);
      expect(reasons).toContain('reassigned');
      expect(reasons).toContain('lost_responsibility');
    });
  });

  describe('the in-app channel', () => {
    it('reports whether anyone holds the seat, and nothing more', async () => {
      const channel = inAppChannel(pool);
      const held = await channel.deliver({
        seatId: rescueSeatId,
        incidentId: randomUUID(),
        reason: 'routed',
      });
      expect(held.ok).toBe(true);

      const vacant = await channel.deliver({
        seatId: vacantSeatId,
        incidentId: randomUUID(),
        reason: 'routed',
      });
      expect(vacant.ok).toBe(false);
    });
  });
});
