/**
 * The administration console — M1a.
 *
 * ADR-0010 made the DC Office and the AC Headquarter Bannu Office the authority for the
 * whole district. This module is what that authority actually does: create and retire
 * departments, set the routing signals that decide where an emergency goes, set the
 * acknowledgement deadlines everything is measured against, and see the district whole.
 *
 * Two rules run through every function here.
 *
 * **The gate is one function.** `requireAdministration` is the only place the question is
 * asked, so there is exactly one thing to audit and exactly one thing to get wrong. It is
 * asked on reads as well as writes: the district-wide performance view is every department's
 * responsiveness in one table, which is not a thing one department gets to browse about
 * another (INV-05).
 *
 * **Nothing is deleted.** Departments and signals retire; the config log keeps every change.
 * A department that stops existing must not take its incidents' meaning with it (ADR-0001).
 */

import type { Pool } from '../db/pool.js';
import type { Identity } from '../auth/sessions.js';
import type { Severity, Uuid } from '../domain/events.js';
import { SEVERITY_ORDER } from '../domain/events.js';
import {
  addRoutingSignal,
  createDepartment,
  findDepartment,
  listDepartments,
  loadSlaConfiguration,
  recentConfigChanges,
  retireRoutingSignal,
  setDepartmentRetired,
  setSlaTarget,
  loadRoutingSignals,
  updateDepartment,
  type ConfigActor,
  type Department,
} from '../db/configStore.js';
import type { RoutingSignal, SignalKind } from '../domain/routing.js';

export type AdminResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly status: number; readonly error: string };

function refuse<T>(status: number, error: string): AdminResult<T> {
  return { ok: false, status, error };
}

/**
 * The gate.
 *
 * **403 rather than 404**, which is the opposite of what incident reads do — and the
 * difference is deliberate. An incident's existence is itself sensitive, so a seat with no
 * authority over one is told it does not exist. The administration console is not a secret:
 * every officer in the district knows the DC Office exists and knows they are not it. A 404
 * there would only make a legitimate configuration problem — someone transferred, someone
 * holding no seat — look like a broken URL at the moment they are trying to fix something.
 *
 * The flag comes from the **department**, resolved fresh on every request (ADR-0010). An
 * officer transferred out of the DC Office an hour ago does not still hold the district.
 */
export function requireAdministration<T>(identity: Identity): AdminResult<T> | null {
  if (identity.seatId === null) {
    return refuse(403, 'you hold no seat right now, so you hold no authority (ADR-0004)');
  }
  if (!identity.isAdministration) {
    return refuse(
      403,
      'only the DC Office and the AC Headquarter Bannu Office may configure the district',
    );
  }
  return null;
}

function actorOf(identity: Identity): ConfigActor {
  return { seatId: identity.seatId, personId: identity.personId };
}

//------------------------------------------------------------------------------
// The department registry, as the console needs it
//------------------------------------------------------------------------------

export interface DepartmentView extends Department {
  readonly signals: readonly RoutingSignal[];
  /** Only the severities this department has overridden. Empty means it uses the default. */
  readonly slaOverrides: Partial<Record<Severity, number>>;
  /**
   * Live posts in this department that nobody currently holds.
   *
   * Surfaced next to the routing signals on purpose. A department with signals and no
   * holder is a department that will be sent emergencies it cannot be told about — which is
   * exactly Rescue 1122's situation in the district's own contact list, and exactly the kind
   * of gap that stays invisible until the night it matters (ADR-0005).
   */
  readonly vacantSeats: number;
  readonly seats: number;
}

export async function departmentsForConsole(
  pool: Pool,
  identity: Identity,
): Promise<AdminResult<readonly DepartmentView[]>> {
  const denied = requireAdministration<readonly DepartmentView[]>(identity);
  if (denied !== null) return denied;

  // Four queries, whatever the district's size.
  //
  // This loop used to call `signalsForDepartment` per department — one round trip each. With
  // Bannu's 79 that is 79 sequential queries on every open of the console, and it grows with
  // every department somebody adds. A test database that had accumulated 1528 departments
  // turned it into a screen that never finished loading, which is how it was found; the
  // production symptom would have been a console that felt broken on the night it mattered.
  //
  // `loadSlaConfiguration` right below already carries a comment explaining why it reads the
  // whole table in one query. I wrote that comment and then did the opposite one function
  // later.
  const [departments, sla, staffing, signals] = await Promise.all([
    listDepartments(pool),
    loadSlaConfiguration(pool),
    seatCounts(pool),
    signalsByDepartment(pool),
  ]);

  return {
    ok: true,
    value: departments.map((d) => ({
      ...d,
      signals: signals[d.departmentId] ?? [],
      slaOverrides: sla.byDepartment[d.departmentId] ?? {},
      seats: staffing[d.departmentId]?.seats ?? 0,
      vacantSeats: staffing[d.departmentId]?.vacant ?? 0,
    })),
  };
}

/** Every live routing signal, grouped by department. One query. */
async function signalsByDepartment(pool: Pool): Promise<Readonly<Record<string, RoutingSignal[]>>> {
  const all = await loadRoutingSignals(pool);
  const out: Record<string, RoutingSignal[]> = {};
  for (const s of all) (out[s.departmentId] ??= []).push(s);
  for (const list of Object.values(out)) {
    list.sort((a, b) => a.kind.localeCompare(b.kind) || a.pattern.localeCompare(b.pattern));
  }
  return out;
}

async function seatCounts(
  pool: Pool,
): Promise<Readonly<Record<string, { seats: number; vacant: number }>>> {
  const { rows } = await pool.query<{ department_id: string; seats: string; vacant: string }>(
    `SELECT s.department_id,
            count(*)                                   AS seats,
            count(*) FILTER (WHERE d.person_id IS NULL) AS vacant
       FROM seat s
       LEFT JOIN duty_assignment d
              ON d.seat_id = s.seat_id AND d.to_at IS NULL
      WHERE s.department_id IS NOT NULL
      GROUP BY s.department_id`,
  );

  const out: Record<string, { seats: number; vacant: number }> = {};
  for (const r of rows) {
    out[r.department_id] = { seats: Number(r.seats), vacant: Number(r.vacant) };
  }
  return out;
}

export interface CreateDepartmentInput {
  readonly name?: unknown;
  readonly description?: unknown;
  readonly contactPhone?: unknown;
}

function text(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

/**
 * Add a department.
 *
 * This is the M1a gate in one function: an operator does it from a screen, and an emergency
 * matching its signals reaches it without anybody touching the code. What was scheduled as
 * M2's milestone gate falls out of ADR-0010 instead.
 */
export async function addDepartment(
  pool: Pool,
  identity: Identity,
  input: CreateDepartmentInput,
): Promise<AdminResult<Department>> {
  const denied = requireAdministration<Department>(identity);
  if (denied !== null) return denied;

  const name = text(input.name);
  if (name === undefined) return refuse(400, 'a department needs a name');
  if (name.length > 200) return refuse(400, 'that name is too long');

  const created = await createDepartment(
    pool,
    {
      name,
      ...(text(input.description) !== undefined ? { description: text(input.description) } : {}),
      ...(text(input.contactPhone) !== undefined ? { contactPhone: text(input.contactPhone) } : {}),
    },
    actorOf(identity),
  );
  return { ok: true, value: created };
}

export interface EditDepartmentInput {
  readonly name?: unknown;
  readonly description?: unknown;
  readonly contactPhone?: unknown;
}

export async function editDepartment(
  pool: Pool,
  identity: Identity,
  departmentId: Uuid,
  input: EditDepartmentInput,
): Promise<AdminResult<Department>> {
  const denied = requireAdministration<Department>(identity);
  if (denied !== null) return denied;

  const name = text(input.name);
  if (input.name !== undefined && name === undefined) {
    return refuse(400, 'a department cannot be renamed to nothing');
  }

  // `null` clears the field, `undefined` leaves it alone. Distinguished rather than
  // collapsed, so clearing a wrong phone number is possible without deleting the row.
  const updated = await updateDepartment(
    pool,
    departmentId,
    {
      ...(name !== undefined ? { name } : {}),
      ...(input.description !== undefined ? { description: text(input.description) ?? null } : {}),
      ...(input.contactPhone !== undefined
        ? { contactPhone: text(input.contactPhone) ?? null }
        : {}),
    },
    actorOf(identity),
  );

  return updated === null ? refuse(404, 'no such department') : { ok: true, value: updated };
}

/**
 * Retire a department, or bring one back.
 *
 * A reason is required, and the database requires it too (migration 0007). Retiring stops
 * emergencies reaching a department, which is a decision somebody will need explained.
 *
 * **The administration cannot retire itself.** Both offices retired would leave the district
 * with no authority, nobody able to create a department, and no way back except a database
 * console at 02:00. ADR-0010 says there is no rung above these two, which makes this the one
 * mistake with no in-system recovery.
 */
export async function setRetired(
  pool: Pool,
  identity: Identity,
  departmentId: Uuid,
  retired: boolean,
  reason: unknown,
): Promise<AdminResult<Department>> {
  const denied = requireAdministration<Department>(identity);
  if (denied !== null) return denied;

  const why = text(reason);
  if (why === undefined) {
    return refuse(400, retired ? 'say why it is being retired' : 'say why it is coming back');
  }

  const existing = await findDepartment(pool, departmentId);
  if (existing === null) return refuse(404, 'no such department');

  if (retired && existing.isAdministration) {
    return refuse(
      409,
      'the DC Office and the AC Headquarter Office cannot be retired — the district would ' +
        'be left with no authority and no way to restore one (ADR-0010)',
    );
  }

  const updated = await setDepartmentRetired(pool, departmentId, retired, why, actorOf(identity));
  return updated === null ? refuse(404, 'no such department') : { ok: true, value: updated };
}

//------------------------------------------------------------------------------
// Routing signals
//------------------------------------------------------------------------------

function isKind(v: unknown): v is SignalKind {
  return v === 'category' || v === 'keyword';
}

export async function addSignal(
  pool: Pool,
  identity: Identity,
  departmentId: Uuid,
  input: { readonly kind?: unknown; readonly pattern?: unknown },
): Promise<AdminResult<RoutingSignal>> {
  const denied = requireAdministration<RoutingSignal>(identity);
  if (denied !== null) return denied;

  if (!isKind(input.kind)) {
    return refuse(400, 'a signal is either a "category" or a "keyword"');
  }
  const pattern = text(input.pattern);
  if (pattern === undefined) return refuse(400, 'a routing signal needs a pattern');
  if (pattern.length > 120) return refuse(400, 'that pattern is too long to be a signal');

  const result = await addRoutingSignal(pool, departmentId, input.kind, pattern, actorOf(identity));
  // 409, not 400: the caller's request was well formed, the district's state disagrees.
  return result.ok ? { ok: true, value: result.signal } : refuse(409, result.why);
}

export async function removeSignal(
  pool: Pool,
  identity: Identity,
  signalId: Uuid,
  reason: unknown,
): Promise<AdminResult<{ readonly retired: true }>> {
  const denied = requireAdministration<{ readonly retired: true }>(identity);
  if (denied !== null) return denied;

  const why = text(reason);
  if (why === undefined) return refuse(400, 'say why this signal is being removed');

  const done = await retireRoutingSignal(pool, signalId, why, actorOf(identity));
  return done ? { ok: true, value: { retired: true } } : refuse(404, 'no such live signal');
}

//------------------------------------------------------------------------------
// SLA targets
//------------------------------------------------------------------------------

function isSeverityValue(v: unknown): v is Severity {
  return (
    typeof v === 'string' && ((SEVERITY_ORDER as readonly string[]).includes(v) || v === 'unknown')
  );
}

/**
 * Set one acknowledgement deadline — for a department, or for the district.
 *
 * `unknown` is a settable severity here, and it has to be. It is not a level (ADR-0009), but
 * an unassessed report still needs a deadline, and that deadline is precisely where the
 * urgency lives now that intake no longer guesses `high`. Leaving it unsettable would put
 * the one number that expresses "get a human to look at this" back into a source file.
 */
export async function setTarget(
  pool: Pool,
  identity: Identity,
  input: {
    readonly departmentId?: unknown;
    readonly severity?: unknown;
    readonly ackMinutes?: unknown;
  },
): Promise<AdminResult<{ readonly set: true }>> {
  const denied = requireAdministration<{ readonly set: true }>(identity);
  if (denied !== null) return denied;

  if (!isSeverityValue(input.severity)) {
    return refuse(400, 'severity must be critical, high, moderate, low, or unknown');
  }
  if (typeof input.ackMinutes !== 'number') {
    return refuse(400, 'ackMinutes must be a number of minutes');
  }

  const departmentId = typeof input.departmentId === 'string' ? input.departmentId : null;
  if (departmentId !== null && (await findDepartment(pool, departmentId)) === null) {
    return refuse(404, 'no such department');
  }

  const result = await setSlaTarget(
    pool,
    departmentId,
    input.severity,
    input.ackMinutes,
    actorOf(identity),
  );
  return result.ok ? { ok: true, value: { set: true } } : refuse(400, result.why);
}

export async function slaForConsole(
  pool: Pool,
  identity: Identity,
): Promise<AdminResult<Awaited<ReturnType<typeof loadSlaConfiguration>>>> {
  const denied = requireAdministration<Awaited<ReturnType<typeof loadSlaConfiguration>>>(identity);
  if (denied !== null) return denied;
  return { ok: true, value: await loadSlaConfiguration(pool) };
}

//------------------------------------------------------------------------------
// The configuration history
//------------------------------------------------------------------------------

export async function configHistory(
  pool: Pool,
  identity: Identity,
  limit?: number,
): Promise<AdminResult<Awaited<ReturnType<typeof recentConfigChanges>>>> {
  const denied = requireAdministration<Awaited<ReturnType<typeof recentConfigChanges>>>(identity);
  if (denied !== null) return denied;
  return { ok: true, value: await recentConfigChanges(pool, limit ?? 50) };
}
