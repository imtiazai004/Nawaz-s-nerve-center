/**
 * Server-side sessions, seat-scoped.
 *
 * `docs/05-stack.md` chose server-side sessions over tokens for one reason: **revocation
 * must be instant.** A compromised account in a district emergency system cannot wait for
 * a JWT to expire, and there is no acceptable answer to "how long until that officer loses
 * access?" other than "immediately".
 *
 * The token is never stored. Only its SHA-256 is, so a leaked database hands out no live
 * sessions.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { Pool } from '../db/pool.js';
import type { Tier } from '../domain/authority.js';
import { verifyPassword } from './passwords.js';

/** Long enough to cover a full shift without a re-login during an incident. */
export const SESSION_TTL_HOURS = 12;

export interface Identity {
  readonly personId: string;
  readonly fullName: string;
  /** Null when the person holds no seat right now — authenticated, but with no authority. */
  readonly seatId: string | null;
  readonly departmentId: string | null;
  readonly tier: Tier | null;
  readonly canBreakGlass: boolean;
}

export interface LoginResult {
  readonly token: string;
  readonly identity: Identity;
}

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

interface IdentityRow {
  person_id: string;
  full_name: string;
  seat_id: string | null;
  department_id: string | null;
  tier: Tier | null;
  can_break_glass: boolean | null;
}

function toIdentity(r: IdentityRow): Identity {
  return {
    personId: r.person_id,
    fullName: r.full_name,
    seatId: r.seat_id,
    departmentId: r.department_id,
    tier: r.tier,
    canBreakGlass: r.can_break_glass === true,
  };
}

/**
 * Authenticate and open a session.
 *
 * Returns null for every failure — unknown phone, wrong password, disabled account — with
 * no indication of which. Distinguishing them tells an attacker which numbers are real
 * officers, which is exactly the list they want.
 */
export async function login(
  pool: Pool,
  phone: string,
  password: string,
): Promise<LoginResult | null> {
  // Only people who can actually authenticate are candidates.
  //
  // A phone number no longer identifies exactly one person: two officers may share an office
  // handset, and both are in the directory (migration 0006). Directory entries have no
  // password hash and cannot sign in, so excluding them here keeps "who is signing in?"
  // single-valued. Without this filter the query could return the contact row and the
  // account row and pick between them arbitrarily.
  const res = await pool.query<{
    person_id: string;
    password_hash: string;
    disabled_at: string | null;
  }>(
    `SELECT person_id, password_hash, disabled_at
       FROM person
      WHERE phone = $1 AND password_hash IS NOT NULL`,
    [phone],
  );

  const row = res.rows[0];

  // Always run a verification, even with no such person, so the response time does not
  // reveal whether the number exists.
  const hash =
    row?.password_hash ??
    'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  const ok = await verifyPassword(password, hash);

  if (row === undefined || !ok || row.disabled_at !== null) return null;

  const identity = await resolveIdentity(pool, row.person_id);
  if (identity === null) return null;

  const token = randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO session (token_hash, person_id, seat_id, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(hours => $4))`,
    [hashToken(token), identity.personId, identity.seatId, SESSION_TTL_HOURS],
  );

  return { token, identity };
}

/** The seat a person holds *right now*. Null seat means no current duty assignment. */
export async function resolveIdentity(pool: Pool, personId: string): Promise<Identity | null> {
  const res = await pool.query<IdentityRow>(
    `SELECT p.person_id,
            p.full_name,
            s.seat_id,
            s.department_id,
            s.tier,
            s.can_break_glass
       FROM person p
       LEFT JOIN duty_assignment d
              ON d.person_id = p.person_id AND d.to_at IS NULL
       LEFT JOIN seat s ON s.seat_id = d.seat_id
      WHERE p.person_id = $1 AND p.disabled_at IS NULL`,
    [personId],
  );

  const row = res.rows[0];
  return row === undefined ? null : toIdentity(row);
}

/**
 * Resolve a bearer token to an identity, or null.
 *
 * The seat is re-resolved from the current roster on every request rather than trusted
 * from the session row. If an officer was relieved of a post ten seconds ago, the next
 * request must reflect that — a cached seat would leave real authority in the hands of
 * someone who no longer holds the post.
 */
export async function resolveSession(pool: Pool, token: string): Promise<Identity | null> {
  if (token.length === 0 || token.length > 200) return null;

  const res = await pool.query<{ session_id: string; token_hash: Buffer; person_id: string }>(
    `SELECT session_id, token_hash, person_id
       FROM session
      WHERE token_hash = $1
        AND revoked_at IS NULL
        AND expires_at > now()`,
    [hashToken(token)],
  );

  const row = res.rows[0];
  if (row === undefined) return null;

  // Belt and braces: the lookup was already by exact hash, but compare in constant time
  // so this stays correct if the query is ever loosened.
  const expected = hashToken(token);
  if (row.token_hash.length !== expected.length || !timingSafeEqual(row.token_hash, expected)) {
    return null;
  }

  await pool.query('UPDATE session SET last_seen_at = now() WHERE session_id = $1', [
    row.session_id,
  ]);

  return resolveIdentity(pool, row.person_id);
}

export async function revokeSession(pool: Pool, token: string): Promise<void> {
  await pool.query(
    'UPDATE session SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
    [hashToken(token)],
  );
}

/** Revoke every session for a person. The response to a compromised account. */
export async function revokeAllForPerson(pool: Pool, personId: string): Promise<number> {
  const res = await pool.query(
    'UPDATE session SET revoked_at = now() WHERE person_id = $1 AND revoked_at IS NULL',
    [personId],
  );
  return res.rowCount ?? 0;
}
