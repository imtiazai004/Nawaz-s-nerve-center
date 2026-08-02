/**
 * The roster — M1a-10, over HTTP, against a real PostgreSQL.
 *
 * Most of this file is about **who may touch whose data**, because that is the requirement
 * the owner set and it is the one with a silent failure mode. A roster edit that reaches too
 * far does not throw: it quietly changes the number an emergency alert will be sent to.
 *
 * The split under test, from the owner (2026-08-02):
 *
 *   - a department edits **its own** people and posts
 *   - the two administrative offices edit **anyone's**
 *   - routing signals and SLA deadlines stay with the two offices, and a department must not
 *     reach them — it could otherwise remove the signal that sends it night-time fire calls,
 *     and nothing on any screen would show that it had happened
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSyncServer } from '../server.js';
import { createPool, migrate, type Pool } from '../../db/pool.js';
import { seedActor, seedDepartment, TEST_PASSWORD } from '../../testing/seed.js';
import { runNotifyPass } from '../../jobs/notify.js';
import { loadIncident } from '../../db/eventStore.js';
import { foldIncident } from '../../domain/incident.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const RUN = randomUUID().slice(0, 8);

describe.skipIf(dbUrl === undefined)('the roster (integration)', () => {
  let pool: Pool;
  let server: Server;
  let base: string;

  let dcToken: string;
  /** Rescue: an ordinary department, editing itself. */
  let rescueToken: string;
  let rescueDept: string;
  /** Police: a second ordinary department, so "its own" can be told from "anyone's". */
  let policeToken: string;
  let policeDept: string;

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    server = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const dcDept = await seedDepartment(pool, `DC Office (roster ${RUN})`);
    await pool.query('UPDATE department SET is_administration = true WHERE department_id = $1', [
      dcDept,
    ]);
    dcToken = (
      await seedActor(pool, { title: `DC (roster ${RUN})`, departmentId: dcDept, tier: 'district' })
    ).token;

    rescueDept = await seedDepartment(pool, `Rescue (roster ${RUN})`);
    rescueToken = (
      await seedActor(pool, { title: `Rescue Duty (roster ${RUN})`, departmentId: rescueDept })
    ).token;

    policeDept = await seedDepartment(pool, `Police (roster ${RUN})`);
    policeToken = (
      await seedActor(pool, { title: `Police Duty (roster ${RUN})`, departmentId: policeDept })
    ).token;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
  });

  async function call(
    method: string,
    path: string,
    token: string | null,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const raw = await res.text();
    return {
      status: res.status,
      body: raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>),
    };
  }

  //----------------------------------------------------------------------------
  // Who may touch whose
  //----------------------------------------------------------------------------

  describe('a department edits its own, and only its own', () => {
    it('shows a department its own roster without being told its id', async () => {
      // An officer should not have to know their department's uuid to open "my department".
      const res = await call('GET', '/roster', rescueToken);
      expect(res.status).toBe(200);
      expect(res.body['departmentId']).toBe(rescueDept);
      expect(res.body['editable']).toBe(true);
    });

    it('lets a department add its own post and its own person', async () => {
      const post = await call('POST', `/roster/${rescueDept}/posts`, rescueToken, {
        title: `Station Officer ${RUN}`,
      });
      expect(post.status).toBe(201);

      const person = await call('POST', `/roster/${rescueDept}/people`, rescueToken, {
        fullName: 'Rescue Officer One',
        phone: `0300${RUN}01`,
        seatId: post.body['seatId'],
      });
      expect(person.status).toBe(201);

      const roster = await call('GET', '/roster', rescueToken);
      const posts = roster.body['posts'] as {
        title: string;
        holder: { fullName: string } | null;
      }[];
      const created = posts.find((p) => p.title === `Station Officer ${RUN}`);
      expect(created?.holder?.fullName).toBe('Rescue Officer One');
    });

    /** The requirement, stated as a refusal. */
    it('refuses one department reading another’s roster', async () => {
      const res = await call('GET', `/roster/${rescueDept}`, policeToken);
      expect(res.status).toBe(403);
      expect(String(res.body['error'])).toContain('your own department');
    });

    it('refuses one department writing into another’s', async () => {
      const res = await call('POST', `/roster/${rescueDept}/posts`, policeToken, {
        title: 'Police Trying It On',
      });
      expect(res.status).toBe(403);

      const roster = await call('GET', '/roster', rescueToken);
      const titles = (roster.body['posts'] as { title: string }[]).map((p) => p.title);
      expect(titles).not.toContain('Police Trying It On');
    });

    it('refuses a department editing a person who holds no post in it', async () => {
      const person = await call('POST', `/roster/${rescueDept}/people`, rescueToken, {
        fullName: 'Rescue Officer Two',
        phone: `0300${RUN}02`,
      });
      const personId = person.body['personId'] as string;

      const res = await call('PATCH', `/roster/people/${personId}`, policeToken, {
        fullName: 'Renamed By Police',
      });
      expect(res.status).toBe(403);
    });

    it('lets the administration edit any department’s roster', async () => {
      const res = await call('POST', `/roster/${rescueDept}/posts`, dcToken, {
        title: `Added By The DC ${RUN}`,
      });
      expect(res.status).toBe(201);
    });

    it('refuses an unauthenticated caller with 401, not 403', async () => {
      expect((await call('GET', '/roster', null)).status).toBe(401);
    });
  });

  //----------------------------------------------------------------------------
  // The line the owner drew
  //----------------------------------------------------------------------------

  describe('routing and deadlines stay with the two offices (ADR-0010)', () => {
    /**
     * The owner was explicit that "a department edits its own data" does **not** extend to
     * the routing signals the two offices assign. This is that sentence as a test.
     *
     * The consequence if it ever passes: a department could remove the signal that sends it
     * night-time fire calls, stop receiving them, and nothing anywhere would show it.
     */
    it('refuses a department its own routing signals', async () => {
      const signal = await call('POST', `/admin/departments/${rescueDept}/signals`, rescueToken, {
        kind: 'keyword',
        pattern: 'fire',
      });
      expect(signal.status).toBe(403);
    });

    it('refuses a department its own acknowledgement deadlines', async () => {
      const res = await call('PUT', '/admin/sla', rescueToken, {
        departmentId: rescueDept,
        severity: 'critical',
        ackMinutes: 600,
      });
      expect(res.status).toBe(403);
    });

    it('refuses a department the district performance table', async () => {
      expect((await call('GET', '/admin/performance', rescueToken)).status).toBe(403);
    });

    it('refuses a department a post above station tier', async () => {
      // `evaluateRead` widens at tehsil, so a department granting itself a tehsil post would
      // be granting itself sight of every incident in the district.
      const res = await call('POST', `/roster/${rescueDept}/posts`, rescueToken, {
        title: 'Self-Promoted',
        tier: 'district',
      });
      expect(res.status).toBe(403);
    });

    it('lets the administration place a post at any tier', async () => {
      const res = await call('POST', `/roster/${policeDept}/posts`, dcToken, {
        title: `Tehsil Coordinator ${RUN}`,
        tier: 'tehsil',
      });
      expect(res.status).toBe(201);
      expect(res.body['tier']).toBe('tehsil');
    });
  });

  //----------------------------------------------------------------------------
  // A contact is not an account
  //----------------------------------------------------------------------------

  describe('adding somebody, and separately giving them a login', () => {
    it('adds a person with no account at all', async () => {
      const person = await call('POST', `/roster/${policeDept}/people`, policeToken, {
        fullName: 'Contact Only',
        phone: `0300${RUN}03`,
      });
      expect(person.status).toBe(201);
      // The district's list is ~80 officials the system must be able to notify. That is not
      // ~80 people who should have credentials.
      expect(person.body['hasAccount']).toBe(false);
    });

    it('grants a login as a separate, deliberate act', async () => {
      const person = await call('POST', `/roster/${policeDept}/people`, policeToken, {
        fullName: 'Gets A Login',
        phone: `0300${RUN}04`,
      });
      const personId = person.body['personId'] as string;

      const granted = await call('POST', `/roster/people/${personId}/account`, policeToken, {
        password: 'a-real-password-2026',
      });
      expect(granted.status).toBe(200);

      const login = await call('POST', '/auth/login', null, {
        phone: `0300${RUN}04`,
        password: 'a-real-password-2026',
      });
      expect(login.status).toBe(200);
    });

    it('refuses a password short enough to guess', async () => {
      const person = await call('POST', `/roster/${policeDept}/people`, policeToken, {
        fullName: 'Weak Password',
        phone: `0300${RUN}05`,
      });
      const res = await call(
        'POST',
        `/roster/people/${person.body['personId'] as string}/account`,
        policeToken,
        { password: 'short' },
      );
      expect(res.status).toBe(400);
    });

    /**
     * Migration 0006 put phone uniqueness only where a password hash exists: a shared office
     * handset is ordinary for a contact and impossible for an account, because "who is
     * signing in?" must have exactly one answer. This is that boundary from the roster side.
     */
    it('refuses a second login on a shared handset, loudly and at the right moment', async () => {
      const shared = `0300${RUN}99`;
      const first = await call('POST', `/roster/${policeDept}/people`, policeToken, {
        fullName: 'Shares A Handset A',
        phone: shared,
      });
      const second = await call('POST', `/roster/${policeDept}/people`, policeToken, {
        fullName: 'Shares A Handset B',
        phone: shared,
      });
      // Both load as contacts. The handset is genuinely shared (Q-19).
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);

      const a = await call(
        'POST',
        `/roster/people/${first.body['personId'] as string}/account`,
        policeToken,
        { password: 'a-real-password-2026' },
      );
      expect(a.status).toBe(200);

      const b = await call(
        'POST',
        `/roster/people/${second.body['personId'] as string}/account`,
        policeToken,
        { password: 'another-real-password-2026' },
      );
      expect(b.status).toBe(409);
      expect(String(b.body['error'])).toContain('shared handset');
    });
  });

  //----------------------------------------------------------------------------
  // Placeholders
  //----------------------------------------------------------------------------

  describe('placeholder numbers (R-01)', () => {
    it('fills a post while still counting it as unreachable', async () => {
      const post = await call('POST', `/roster/${policeDept}/posts`, policeToken, {
        title: `Awaiting A Number ${RUN}`,
      });
      await call('POST', `/roster/${policeDept}/people`, policeToken, {
        fullName: 'Number To Follow',
        phone: `1111111-${RUN}`,
        placeholder: true,
        seatId: post.body['seatId'],
      });

      const roster = await call('GET', '/roster', policeToken);
      const posts = roster.body['posts'] as {
        title: string;
        holder: { placeholder: boolean } | null;
      }[];
      const filled = posts.find((p) => p.title === `Awaiting A Number ${RUN}`);

      // The post is held — and the holder says the number is a stand-in, so nothing on any
      // screen reads as though this post can be reached.
      expect(filled?.holder?.placeholder).toBe(true);
      expect(Number(roster.body['unreachablePosts'])).toBeGreaterThan(0);
    });

    /**
     * The way a placeholder is meant to end.
     *
     * Clearing the flag automatically, rather than requiring a second deliberate action, is
     * the whole point: a placeholder that somebody forgets to clear is a post that silently
     * stops escalating, and nobody who typed a real number into a form would ever think to
     * go and clear a flag afterwards.
     */
    it('stops being a placeholder the moment a real number is typed over it', async () => {
      const person = await call('POST', `/roster/${policeDept}/people`, policeToken, {
        fullName: 'Real Number Coming',
        phone: `1111111-${RUN}-b`,
        placeholder: true,
      });
      const personId = person.body['personId'] as string;

      const updated = await call('PATCH', `/roster/people/${personId}`, policeToken, {
        phone: `0300${RUN}77`,
      });
      expect(updated.status).toBe(200);
      expect(updated.body['placeholder']).toBe(false);
    });

    it('refuses an account on a placeholder number', async () => {
      const person = await call('POST', `/roster/${policeDept}/people`, policeToken, {
        fullName: 'Placeholder Account Attempt',
        phone: `1111111-${RUN}-c`,
        placeholder: true,
      });
      const res = await call(
        'POST',
        `/roster/people/${person.body['personId'] as string}/account`,
        policeToken,
        { password: 'a-real-password-2026' },
      );
      // An account nobody can be told about, reachable at a number that is not theirs.
      expect(res.status).toBe(409);
      expect(String(res.body['error'])).toContain('real number');
    });
  });

  //----------------------------------------------------------------------------
  // Handovers, and what they must not erase
  //----------------------------------------------------------------------------

  describe('handovers', () => {
    it('moves a post to a new holder and ends the old assignment', async () => {
      const post = await call('POST', `/roster/${rescueDept}/posts`, rescueToken, {
        title: `Handover Post ${RUN}`,
      });
      const seatId = post.body['seatId'] as string;

      const outgoing = await call('POST', `/roster/${rescueDept}/people`, rescueToken, {
        fullName: 'Outgoing Officer',
        phone: `0300${RUN}11`,
        seatId,
      });
      const incoming = await call('POST', `/roster/${rescueDept}/people`, rescueToken, {
        fullName: 'Incoming Officer',
        phone: `0300${RUN}12`,
      });

      const moved = await call('POST', `/roster/posts/${seatId}/assign`, rescueToken, {
        personId: incoming.body['personId'],
      });
      expect(moved.status).toBe(200);

      const roster = await call('GET', '/roster', rescueToken);
      const posts = roster.body['posts'] as {
        seatId: string;
        holder: { fullName: string } | null;
      }[];
      expect(posts.find((p) => p.seatId === seatId)?.holder?.fullName).toBe('Incoming Officer');

      // The outgoing officer's dates stay in the record. A handover with no history is how
      // "who was on duty that night" becomes unanswerable (ADR-0004).
      const past = await pool.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM duty_assignment WHERE person_id = $1 AND to_at IS NOT NULL',
        [outgoing.body['personId']],
      );
      expect(Number(past.rows[0]!.n)).toBe(1);
    });

    it('will not relieve somebody without a reason', async () => {
      const post = await call('POST', `/roster/${rescueDept}/posts`, rescueToken, {
        title: `Reasonless Relief ${RUN}`,
      });
      const seatId = post.body['seatId'] as string;
      await call('POST', `/roster/${rescueDept}/people`, rescueToken, {
        fullName: 'Will Stay Put',
        phone: `0300${RUN}13`,
        seatId,
      });

      // This is the change most likely to be asked about afterwards: who took the duty
      // officer off that post the week nobody answered?
      expect((await call('POST', `/roster/posts/${seatId}/relieve`, rescueToken, {})).status).toBe(
        400,
      );
    });

    it('retiring a post takes its holder off it, so nothing is notified into a void', async () => {
      const post = await call('POST', `/roster/${rescueDept}/posts`, rescueToken, {
        title: `Short-Lived Post ${RUN}`,
      });
      const seatId = post.body['seatId'] as string;
      await call('POST', `/roster/${rescueDept}/people`, rescueToken, {
        fullName: 'Briefly Posted',
        phone: `0300${RUN}14`,
        seatId,
      });

      const retired = await call('POST', `/roster/posts/${seatId}/retire`, rescueToken, {
        reason: 'post abolished after the season',
      });
      expect(retired.status).toBe(200);
      expect(retired.body['holder']).toBeNull();
    });

    it('will not let somebody remove themselves', async () => {
      const me = await call('GET', '/auth/me', dcToken);
      const personId = (me.body['identity'] as { personId: string }).personId;

      // For the last administrator this would leave the district with nobody able to undo
      // it, and for anybody it ends their own session mid-request.
      const res = await call('POST', `/roster/people/${personId}/remove`, dcToken, {
        reason: 'testing',
      });
      expect(res.status).toBe(409);
    });

    it('removing somebody keeps them in the record and out of the roster', async () => {
      const person = await call('POST', `/roster/${rescueDept}/people`, rescueToken, {
        fullName: 'Transferred Away',
        phone: `0300${RUN}15`,
      });
      const personId = person.body['personId'] as string;

      const removed = await call('POST', `/roster/people/${personId}/remove`, rescueToken, {
        reason: 'transferred out of the district',
      });
      expect(removed.status).toBe(200);

      const roster = await call('GET', '/roster', rescueToken);
      const names = (roster.body['people'] as { fullName: string }[]).map((p) => p.fullName);
      expect(names).not.toContain('Transferred Away');

      // Still there, so every event naming them keeps resolving to a name (ADR-0001).
      const still = await pool.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM person WHERE person_id = $1',
        [personId],
      );
      expect(Number(still.rows[0]!.n)).toBe(1);
    });
  });

  //----------------------------------------------------------------------------
  // The thing the roster is for
  //----------------------------------------------------------------------------

  describe('what the roster actually buys', () => {
    /**
     * The whole point, end to end: an emergency reaches a department, the notifier looks for
     * somebody to tell, and finds them **because a human typed them in on a screen**.
     */
    it('a person added from the roster becomes the one who gets notified', async () => {
      const dept = await seedDepartment(pool, `Notifiable ${RUN}`);
      await pool.query(
        `INSERT INTO routing_signal (department_id, kind, pattern) VALUES ($1, 'category', $2)`,
        [dept, `roster-notify-${RUN}`],
      );

      // Before anybody is in it, the department has a signal and nobody to tell.
      const before = await call('POST', '/incidents', dcToken, {
        category: `roster-notify-${RUN}`,
      });
      await runNotifyPass(pool, { incidentIds: [before.body['incidentId'] as string] });
      const beforeState = foldIncident(
        before.body['incidentId'] as string,
        await loadIncident(pool, before.body['incidentId'] as string),
      );
      expect(beforeState.notifications[0]?.state).toBe('failed');

      // The administration staffs it from the console.
      const post = await call('POST', `/roster/${dept}/posts`, dcToken, {
        title: `Duty Officer ${RUN}`,
      });
      await call('POST', `/roster/${dept}/people`, dcToken, {
        fullName: 'Now There Is Somebody',
        phone: `0300${RUN}88`,
        seatId: post.body['seatId'],
      });

      const after = await call('POST', '/incidents', dcToken, { category: `roster-notify-${RUN}` });
      await runNotifyPass(pool, { incidentIds: [after.body['incidentId'] as string] });
      const afterState = foldIncident(
        after.body['incidentId'] as string,
        await loadIncident(pool, after.body['incidentId'] as string),
      );
      expect(afterState.notifications[0]?.state).not.toBe('failed');
    });

    it('records every roster change with who made it and why', async () => {
      const res = await call('GET', '/admin/history', dcToken);
      const changes = res.body as unknown as {
        subject: string;
        action: string;
        reason: string | null;
      }[];

      expect(changes.some((c) => c.subject === 'seat')).toBe(true);
      expect(changes.some((c) => c.subject === 'person')).toBe(true);
      // Anything that stops somebody being reachable carries its reason.
      const retire = changes.find((c) => c.subject === 'person' && c.action === 'retired');
      expect(retire?.reason).toBeTruthy();
    });

    it('never writes a contact number into the configuration log', async () => {
      // `config_event` is rendered on a screen and copied into every backup. The person row
      // is the one place a number needs to live, and `obs/log.ts` already keeps one out of
      // a log line — this is the same rule, one table over.
      const leaked = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM config_event
          WHERE (after::text LIKE $1 OR before::text LIKE $1)`,
        [`%0300${RUN}%`],
      );
      expect(Number(leaked.rows[0]!.n)).toBe(0);
    });
  });

  it('a department officer sees their own roster after signing in fresh', async () => {
    // Belt and braces on the scoping: a real login, not a seeded token.
    const person = await pool.query<{ phone: string }>(
      `SELECT p.phone FROM person p
         JOIN duty_assignment d ON d.person_id = p.person_id AND d.to_at IS NULL
         JOIN seat s ON s.seat_id = d.seat_id
        WHERE s.title = $1`,
      [`Rescue Duty (roster ${RUN})`],
    );
    const login = await call('POST', '/auth/login', null, {
      phone: person.rows[0]!.phone,
      password: TEST_PASSWORD,
    });
    expect(login.status).toBe(200);

    const roster = await call('GET', '/roster', login.body['token'] as string);
    expect(roster.body['departmentId']).toBe(rescueDept);
  });
});
