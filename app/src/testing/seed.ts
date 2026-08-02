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

/**
 * A department row, because `seat.department_id` is a real foreign key from migration 0005.
 *
 * Before that, tests invented a uuid and the database accepted it — which was the whole
 * problem: a department id that referenced nothing, rendered to operators as a uuid. Tests
 * now have to create the thing they point at, exactly as the district does.
 */
export async function seedDepartment(pool: Pool, name?: string): Promise<string> {
  return ensureDepartment(pool, randomUUID(), name);
}

/**
 * Make sure a specific department id exists.
 *
 * Some suites pin a department to a constant so the same id appears in fixtures and
 * assertions. Those ids used to reference nothing, which the database happily allowed — the
 * exact bug M0-51 fixes. Rather than make every such suite remember to create the row, the
 * helper they already call guarantees it.
 */
export async function ensureDepartment(
  pool: Pool,
  departmentId: string,
  name?: string,
): Promise<string> {
  await pool.query(
    `INSERT INTO department (department_id, code, name) VALUES ($1, $2, $3)
     ON CONFLICT (department_id) DO NOTHING`,
    [departmentId, `test-${departmentId}`, name ?? `Test Department ${departmentId.slice(0, 8)}`],
  );
  return departmentId;
}

export async function seedActor(
  pool: Pool,
  options: {
    title?: string;
    departmentId?: string;
    tier?: 'department' | 'district';
    canBreakGlass?: boolean;
  } = {},
): Promise<TestActor> {
  const departmentId =
    options.departmentId === undefined
      ? await seedDepartment(pool)
      : await ensureDepartment(pool, options.departmentId);

  // Asking for a district-tier seat means asking for an administrative office.
  //
  // Migration 0010 derives tier from the department, so a seat in an ordinary department is
  // `department` tier whatever the INSERT says — and a test that asked for `district` and
  // silently got `department` would go on to fail somewhere far away, as a 403 on the board
  // rather than as "this seat is not what you asked for". Marking the office administrative
  // is the honest way to get the thing the caller wanted, and it matches ADR-0010: the only
  // district-tier posts belong to the two offices, or to no department at all.
  if (options.tier === 'district') {
    await pool.query('UPDATE department SET is_administration = true WHERE department_id = $1', [
      departmentId,
    ]);
  }

  const seat = await pool.query<{ seat_id: string }>(
    `INSERT INTO seat (title, department_id, tier, can_break_glass)
     VALUES ($1, $2, $3, $4) RETURNING seat_id`,
    [
      options.title ?? 'Test Duty Seat',
      departmentId,
      options.tier ?? 'department',
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
