/**
 * INV-05: the UI is never the enforcement layer.
 *
 * Every refusal below is tested by direct HTTP call. Nothing here goes through a browser,
 * because a control that only holds when you use the app is not a control at all — an
 * attacker uses curl.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSyncServer } from '../../api/server.js';
import { createPool, migrate, type Pool } from '../../db/pool.js';
import { seedDepartment } from '../../testing/seed.js';
import { loadIncident } from '../../db/eventStore.js';
import { hashPassword, verifyPassword, assertUsable } from '../passwords.js';
import { login, resolveSession, revokeAllForPerson, revokeSession } from '../sessions.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const PASSWORD = 'duty-officer-2026';

describe('password hashing', () => {
  it('verifies a correct password', async () => {
    const hash = await hashPassword(PASSWORD);
    expect(await verifyPassword(PASSWORD, hash)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword(PASSWORD);
    expect(await verifyPassword('duty-officer-2027', hash)).toBe(false);
  });

  it('produces a different hash each time', async () => {
    expect(await hashPassword(PASSWORD)).not.toBe(await hashPassword(PASSWORD));
  });

  it('returns false for a corrupted stored hash instead of throwing', async () => {
    // A bad row must not become a way to crash the login endpoint.
    for (const bad of ['', 'garbage', 'scrypt$x$y$z$q$r', 'scrypt$16384$8$1$!!!$!!!']) {
      expect(await verifyPassword(PASSWORD, bad)).toBe(false);
    }
  });

  it('never accepts a password against a zero-length or stunted key', async () => {
    // The hole this pins: base64-decoding garbage can produce an empty buffer, scrypt
    // asked for a zero-length key returns an empty buffer, and timingSafeEqual(empty,
    // empty) is true — so one corrupted row would have accepted ANY password.
    const empties = [
      'scrypt$16384$8$1$!!!$!!!',
      'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$',
      `scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$${Buffer.alloc(8).toString('base64')}`,
    ];

    for (const stored of empties) {
      expect(await verifyPassword(PASSWORD, stored)).toBe(false);
      expect(await verifyPassword('literally anything', stored)).toBe(false);
      expect(await verifyPassword('', stored)).toBe(false);
    }
  });

  it('rejects absurd scrypt parameters rather than trying to honour them', async () => {
    const salt = Buffer.alloc(16).toString('base64');
    const key = Buffer.alloc(32).toString('base64');
    expect(await verifyPassword(PASSWORD, `scrypt$1$8$1$${salt}$${key}`)).toBe(false);
    expect(await verifyPassword(PASSWORD, `scrypt$16384$0$1$${salt}$${key}`)).toBe(false);
  });

  it('refuses passwords that are too short or absurdly long', () => {
    expect(() => assertUsable('short')).toThrow();
    expect(() => assertUsable('x'.repeat(600))).toThrow();
    expect(() => assertUsable('a-reasonable-one')).not.toThrow();
  });
});

describe.skipIf(dbUrl === undefined)('authentication (integration)', () => {
  let pool: Pool;
  let server: Server;
  let base: string;

  let rescueDept: string;
  let policeDept: string;
  let rescueSeat: string;
  let policeSeat: string;
  let dcSeat: string;

  let rescuePerson: string;
  let policePerson: string;

  let rescuePhone: string;
  let policePhone: string;
  let seatlessPhone: string;

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    server = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    rescueDept = await seedDepartment(pool, 'Rescue 1122 (test)');
    policeDept = await seedDepartment(pool, 'Police (test)');

    rescueSeat = await makeSeat('Rescue 1122 Station In-Charge', rescueDept, 'station', false);
    policeSeat = await makeSeat('SHO Bannu City', policeDept, 'station', false);
    dcSeat = await makeSeat('Deputy Commissioner Bannu', null, 'district', true);

    const suffix = randomUUID().slice(0, 8);
    rescuePhone = `+9230000${suffix}`;
    policePhone = `+9230001${suffix}`;
    seatlessPhone = `+9230002${suffix}`;

    rescuePerson = await makePerson('Rescue Duty Officer', rescuePhone);
    policePerson = await makePerson('Police Duty Officer', policePhone);
    // Deliberately given no duty assignment: authenticated, but holding no seat.
    await makePerson('Transferred Officer', seatlessPhone);

    await assign(rescueSeat, rescuePerson);
    await assign(policeSeat, policePerson);
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
  });

  async function makeSeat(
    title: string,
    departmentId: string | null,
    tier: string,
    breakGlass: boolean,
  ): Promise<string> {
    const res = await pool.query<{ seat_id: string }>(
      `INSERT INTO seat (title, department_id, tier, can_break_glass)
       VALUES ($1, $2, $3, $4) RETURNING seat_id`,
      [title, departmentId, tier, breakGlass],
    );
    return res.rows[0]!.seat_id;
  }

  async function makePerson(name: string, phone: string): Promise<string> {
    const res = await pool.query<{ person_id: string }>(
      `INSERT INTO person (full_name, phone, password_hash)
       VALUES ($1, $2, $3) RETURNING person_id`,
      [name, phone, await hashPassword(PASSWORD)],
    );
    return res.rows[0]!.person_id;
  }

  async function assign(seatId: string, personId: string): Promise<void> {
    await pool.query('INSERT INTO duty_assignment (seat_id, person_id) VALUES ($1, $2)', [
      seatId,
      personId,
    ]);
  }

  async function tokenFor(phone: string): Promise<string> {
    const result = await login(pool, phone, PASSWORD);
    expect(result).not.toBeNull();
    return result!.token;
  }

  function push(token: string | null, events: unknown[]): Promise<Response> {
    return fetch(`${base}/sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({ deviceId: randomUUID(), events }),
    });
  }

  function reportEvent(incidentId: string, claimedSeat: string | null = null): unknown {
    return {
      eventId: randomUUID(),
      incidentId,
      type: 'reported',
      occurredAt: new Date().toISOString(),
      clientSeq: 1,
      actorPersonId: claimedSeat === null ? null : randomUUID(),
      actorSeatId: claimedSeat,
      sourceChannel: 'mobile',
      payload: { reportId: randomUUID(), category: 'rta', severity: 'critical' },
    };
  }

  describe('the door is shut by default', () => {
    it('refuses an unauthenticated push', async () => {
      const res = await push(null, [reportEvent(randomUUID())]);
      expect(res.status).toBe(401);
    });

    it('refuses an unauthenticated pull', async () => {
      expect((await fetch(`${base}/sync?cursor=0`)).status).toBe(401);
    });

    it('refuses a garbage token', async () => {
      expect((await push('not-a-real-token', [reportEvent(randomUUID())])).status).toBe(401);
    });

    it('refuses an absurdly long token without hitting the database hard', async () => {
      expect((await push('x'.repeat(5000), [])).status).toBe(401);
    });

    it('nothing was stored by any of those attempts', async () => {
      const incidentId = randomUUID();
      await push(null, [reportEvent(incidentId)]);
      await push('bogus', [reportEvent(incidentId)]);
      expect(await loadIncident(pool, incidentId)).toHaveLength(0);
    });
  });

  describe('login', () => {
    it('issues a session for correct credentials', async () => {
      const res = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: rescuePhone, password: PASSWORD }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { token: string; identity: { seatId: string } };
      expect(body.token).toBeTruthy();
      expect(body.identity.seatId).toBe(rescueSeat);
    });

    it('sets an HttpOnly, SameSite=Strict cookie', async () => {
      const res = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: rescuePhone, password: PASSWORD }),
      });

      const cookie = res.headers.get('set-cookie') ?? '';
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Strict/i);
    });

    it('gives the same answer for a wrong password and an unknown number', async () => {
      // Distinguishing them hands an attacker the list of real officers.
      const wrongPassword = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: rescuePhone, password: 'wrong-password-here' }),
      });
      const unknownNumber = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: '+923009999999', password: PASSWORD }),
      });

      expect(wrongPassword.status).toBe(401);
      expect(unknownNumber.status).toBe(401);
      expect(await wrongPassword.json()).toEqual(await unknownNumber.json());
    });

    it('refuses a disabled account', async () => {
      const phone = `+92300444${randomUUID().slice(0, 6)}`;
      const personId = await makePerson('Suspended Officer', phone);
      await assign(await makeSeat('Temp', rescueDept, 'station', false), personId);

      expect(await login(pool, phone, PASSWORD)).not.toBeNull();
      await pool.query('UPDATE person SET disabled_at = now() WHERE person_id = $1', [personId]);
      expect(await login(pool, phone, PASSWORD)).toBeNull();
    });
  });

  describe('impersonation is impossible', () => {
    it('discards the actor identity the client claims', async () => {
      // The hole this closes: without server-side stamping, any authenticated user could
      // submit an event claiming to be the DC seat, and the audit trail — which IS the
      // record — would faithfully preserve the lie.
      const incidentId = randomUUID();
      const token = await tokenFor(rescuePhone);

      const res = await push(token, [reportEvent(incidentId, dcSeat)]);
      expect(res.status).toBe(200);

      const [stored] = await loadIncident(pool, incidentId);
      expect(stored!.actorSeatId).toBe(rescueSeat);
      expect(stored!.actorSeatId).not.toBe(dcSeat);
      expect(stored!.actorPersonId).toBe(rescuePerson);
    });

    it('stamps identity even when the client sends none', async () => {
      const incidentId = randomUUID();
      const token = await tokenFor(policePhone);

      await push(token, [reportEvent(incidentId)]);

      const [stored] = await loadIncident(pool, incidentId);
      expect(stored!.actorSeatId).toBe(policeSeat);
      expect(stored!.actorPersonId).toBe(policePerson);
    });
  });

  describe('authority comes from the seat, not the person (ADR-0004)', () => {
    it('an authenticated person holding no seat may sign in but not act', async () => {
      const token = await tokenFor(seatlessPhone);

      const me = await fetch(`${base}/auth/me`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(me.status).toBe(200);
      expect(((await me.json()) as { identity: { seatId: null } }).identity.seatId).toBeNull();

      const res = await push(token, [reportEvent(randomUUID())]);
      expect(res.status).toBe(403);
    });

    /**
     * The same rule, on the two screens that were not applying it.
     *
     * `/sync` and `/incidents` had always refused a seatless caller. `/dashboard` and
     * `/status` had not, and both decided their scope from `departmentId === null` — which is
     * true of a control-room seat *and* of somebody holding no post at all. The second was
     * therefore handed the first's answer: the whole district. Relieving an officer widened
     * what they could see, which inverts the reason the seat is re-resolved every request.
     *
     * Asserted by direct HTTP, never through the UI (INV-05).
     */
    it('refuses a seatless caller the dashboard, rather than showing them the district', async () => {
      const token = await tokenFor(seatlessPhone);

      const res = await fetch(`${base}/dashboard`, {
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/no current duty assignment/);
    });

    it('refuses a seatless caller the status screen, which lists every seat on duty', async () => {
      const token = await tokenFor(seatlessPhone);

      const res = await fetch(`${base}/status`, {
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(403);
    });

    it('still serves the dashboard to a seat that holds no department', async () => {
      // The case the leak was hiding behind, and it must keep working: a control-room post
      // belongs to no department and the district *is* its work. What separates it from the
      // caller above is that it holds a seat at all.
      const phone = `+92300777${randomUUID().slice(0, 6)}`;
      const personId = await makePerson('Control Room Officer', phone);
      await assign(dcSeat, personId);

      const res = await fetch(`${base}/dashboard`, {
        headers: { authorization: `Bearer ${await tokenFor(phone)}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { scope: string };
      expect(body.scope).toBe('District');
    });

    it('losing the duty assignment removes authority on the very next request', async () => {
      const phone = `+92300555${randomUUID().slice(0, 6)}`;
      const personId = await makePerson('Relieved Officer', phone);
      const seatId = await makeSeat('Relief Post', rescueDept, 'station', false);
      await assign(seatId, personId);

      const token = await tokenFor(phone);
      expect((await push(token, [reportEvent(randomUUID())])).status).toBe(200);

      // Posting order: the seat is handed over.
      await pool.query(
        'UPDATE duty_assignment SET to_at = now() WHERE person_id = $1 AND to_at IS NULL',
        [personId],
      );

      // The session is still valid — but the seat is gone, so the authority is gone.
      // Nothing had to be revoked or cleaned up by anyone.
      expect((await push(token, [reportEvent(randomUUID())])).status).toBe(403);
    });
  });

  describe('revocation is instant', () => {
    it('a revoked session stops working immediately', async () => {
      const token = await tokenFor(rescuePhone);
      expect((await push(token, [reportEvent(randomUUID())])).status).toBe(200);

      await revokeSession(pool, token);

      expect((await push(token, [reportEvent(randomUUID())])).status).toBe(401);
      expect(await resolveSession(pool, token)).toBeNull();
    });

    it('logout revokes the session it was called with', async () => {
      const token = await tokenFor(rescuePhone);
      await fetch(`${base}/auth/logout`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      expect((await push(token, [reportEvent(randomUUID())])).status).toBe(401);
    });

    it('a compromised account can have every session killed at once', async () => {
      const a = await tokenFor(policePhone);
      const b = await tokenFor(policePhone);

      const killed = await revokeAllForPerson(pool, policePerson);
      expect(killed).toBeGreaterThanOrEqual(2);

      expect((await push(a, [reportEvent(randomUUID())])).status).toBe(401);
      expect((await push(b, [reportEvent(randomUUID())])).status).toBe(401);
    });

    it('an expired session is refused', async () => {
      const token = await tokenFor(rescuePhone);
      await pool
        .query(
          `UPDATE session SET expires_at = now() - interval '1 minute'
          WHERE token_hash = decode(encode(digest($1, 'sha256'), 'hex'), 'hex')`,
          [token],
        )
        .catch(async () => {
          // pgcrypto may not be installed; expire every session for this person instead.
          await pool.query(
            `UPDATE session SET expires_at = now() - interval '1 minute' WHERE person_id = $1`,
            [rescuePerson],
          );
        });

      expect(await resolveSession(pool, token)).toBeNull();
    });
  });

  describe('the session token is never stored in the clear', () => {
    it('the raw token does not appear in the session table', async () => {
      const token = await tokenFor(rescuePhone);
      const res = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM session WHERE encode(token_hash, 'escape') LIKE '%' || $1 || '%'`,
        [token],
      );
      expect(Number(res.rows[0]!.n)).toBe(0);
    });
  });
});
