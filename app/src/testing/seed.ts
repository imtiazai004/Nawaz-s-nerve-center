/**
 * Test identities.
 *
 * Every suite that touches `/sync` now needs a real session, because there is no longer a
 * way in without one — which is the point of INV-05. This creates a person holding a seat
 * and returns a usable token.
 */

import { randomUUID } from 'node:crypto';

import type { Pool } from '../db/pool.js';
import { hashPassword } from '../auth/passwords.js';
import { login } from '../auth/sessions.js';

export const TEST_PASSWORD = 'test-duty-officer-2026';

export interface TestActor {
  readonly personId: string;
  readonly seatId: string;
  readonly departmentId: string;
  readonly phone: string;
  readonly token: string;
}

export async function seedActor(
  pool: Pool,
  options: {
    title?: string;
    departmentId?: string;
    tier?: 'station' | 'tehsil' | 'district' | 'provincial';
    canBreakGlass?: boolean;
  } = {},
): Promise<TestActor> {
  const departmentId = options.departmentId ?? randomUUID();

  const seat = await pool.query<{ seat_id: string }>(
    `INSERT INTO seat (title, department_id, tier, can_break_glass)
     VALUES ($1, $2, $3, $4) RETURNING seat_id`,
    [
      options.title ?? 'Test Duty Seat',
      departmentId,
      options.tier ?? 'station',
      options.canBreakGlass ?? false,
    ],
  );
  const seatId = seat.rows[0]!.seat_id;

  const phone = `+92300${Math.floor(Math.random() * 900 + 100)}${randomUUID().slice(0, 6)}`;
  const person = await pool.query<{ person_id: string }>(
    `INSERT INTO person (full_name, phone, password_hash)
     VALUES ($1, $2, $3) RETURNING person_id`,
    ['Test Officer', phone, await hashPassword(TEST_PASSWORD)],
  );
  const personId = person.rows[0]!.person_id;

  await pool.query('INSERT INTO duty_assignment (seat_id, person_id) VALUES ($1, $2)', [
    seatId,
    personId,
  ]);

  const result = await login(pool, phone, TEST_PASSWORD);
  if (result === null) throw new Error('seedActor: login failed immediately after seeding');

  return { personId, seatId, departmentId, phone, token: result.token };
}

/** Headers for an authenticated JSON request. */
export function authHeaders(token: string): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${token}` };
}
