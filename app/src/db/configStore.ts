/**
 * Reading and writing the district's configuration — departments, routing signals, SLA
 * targets — and recording every change.
 *
 * The write functions here all follow one shape: **do the thing and append a `config_event`
 * in the same transaction.** Not as a courtesy. A settings table that only holds the current
 * value cannot answer "why was this not flagged late?" six weeks later, and the two offices'
 * own decisions become unattributable. Migration 0007 has the longer argument.
 *
 * No authority checks live in this file. It is the store; `api/admin.ts` is the gate
 * (INV-05, and the same split `api/lifecycle.ts` uses for incidents).
 */

import type { Pool, PoolClient } from 'pg';

import type { Severity, Uuid } from '../domain/events.js';
import { normalise, type RoutingSignal, type SignalKind } from '../domain/routing.js';
import type { SlaTargets } from '../domain/sla.js';

export interface Department {
  readonly departmentId: Uuid;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly contactPhone: string | null;
  readonly isAdministration: boolean;
  readonly retiredAt: string | null;
}

export interface ConfigActor {
  readonly seatId: Uuid | null;
  readonly personId: Uuid | null;
}

export type ConfigSubject = 'department' | 'routing_signal' | 'sla_target';
export type ConfigAction = 'created' | 'updated' | 'retired' | 'restored';

export interface ConfigChange {
  readonly eventId: Uuid;
  readonly seq: string;
  readonly subject: ConfigSubject;
  readonly subjectId: Uuid;
  readonly action: ConfigAction;
  readonly before: unknown;
  readonly after: unknown;
  readonly actorSeatId: Uuid | null;
  readonly actorSeatTitle: string | null;
  readonly actorName: string | null;
  readonly reason: string | null;
  readonly recordedAt: string;
}

interface DepartmentRow {
  department_id: string;
  code: string;
  name: string;
  description: string | null;
  contact_phone: string | null;
  is_administration: boolean;
  // Already an ISO string, not a Date: `db/pool.ts` installs a type parser for timestamptz
  // so every timestamp in the system has one representation. Typing it as `Date` here and
  // calling `.toISOString()` on it threw at runtime and passed the typechecker, which is
  // the exact hazard of describing a driver's output rather than checking it.
  retired_at: string | null;
}

function toDepartment(r: DepartmentRow): Department {
  return {
    departmentId: r.department_id,
    code: r.code,
    name: r.name,
    description: r.description,
    contactPhone: r.contact_phone,
    isAdministration: r.is_administration,
    retiredAt: r.retired_at,
  };
}

const DEPARTMENT_COLUMNS = `department_id, code, name, description, contact_phone,
                            is_administration, retired_at`;

/**
 * Append a configuration change. Always inside the caller's transaction.
 *
 * Taking a `PoolClient` rather than a `Pool` is the point: the change and its record commit
 * together or not at all. A configuration change with no record of who made it is exactly
 * the thing this table exists to prevent, and a separate connection would make that a
 * possible outcome of a badly timed crash.
 */
async function recordChange(
  tx: PoolClient,
  entry: {
    subject: ConfigSubject;
    subjectId: Uuid;
    action: ConfigAction;
    before: unknown;
    after: unknown;
    actor: ConfigActor;
    reason?: string | undefined;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO config_event
       (subject, subject_id, action, before, after, actor_seat_id, actor_person_id, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entry.subject,
      entry.subjectId,
      entry.action,
      entry.before === null || entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === null || entry.after === undefined ? null : JSON.stringify(entry.after),
      entry.actor.seatId,
      entry.actor.personId,
      entry.reason ?? null,
    ],
  );
}

async function inTransaction<T>(pool: Pool, fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const result = await fn(tx);
    await tx.query('COMMIT');
    return result;
  } catch (err) {
    await tx.query('ROLLBACK');
    throw err;
  } finally {
    tx.release();
  }
}

//------------------------------------------------------------------------------
// Departments
//------------------------------------------------------------------------------

/** Every department, retired ones included. The console needs to show and restore them. */
export async function listDepartments(pool: Pool): Promise<readonly Department[]> {
  const { rows } = await pool.query<DepartmentRow>(
    `SELECT ${DEPARTMENT_COLUMNS} FROM department ORDER BY retired_at IS NOT NULL, name`,
  );
  return rows.map(toDepartment);
}

export async function findDepartment(pool: Pool, id: Uuid): Promise<Department | null> {
  const { rows } = await pool.query<DepartmentRow>(
    `SELECT ${DEPARTMENT_COLUMNS} FROM department WHERE department_id = $1`,
    [id],
  );
  const row = rows[0];
  return row === undefined ? null : toDepartment(row);
}

/**
 * A stable slug from a name.
 *
 * The code is what the seed file and the code can both name while ids are generated and
 * names get corrected. Non-Latin names — and the district writes some — would slugify to
 * nothing, so those fall back to a generated code rather than colliding on the empty string.
 */
export function slugify(name: string, fallback: string): string {
  const slug = normalise(name)
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? fallback : slug;
}

export interface NewDepartment {
  readonly name: string;
  readonly description?: string | undefined;
  readonly contactPhone?: string | undefined;
}

export async function createDepartment(
  pool: Pool,
  input: NewDepartment,
  actor: ConfigActor,
): Promise<Department> {
  return inTransaction(pool, async (tx) => {
    const name = input.name.trim();
    let code = slugify(name, `department-${Date.now().toString(36)}`);

    // A name can legitimately repeat the slug of a retired one. Rather than refusing, take
    // the next free suffix: an administrator adding a department in the middle of an
    // incident should not have to think about slugs.
    for (let attempt = 2; attempt < 100; attempt += 1) {
      const clash = await tx.query('SELECT 1 FROM department WHERE code = $1', [code]);
      if (clash.rowCount === 0) break;
      code = `${slugify(name, 'department')}-${String(attempt)}`;
    }

    const { rows } = await tx.query<DepartmentRow>(
      `INSERT INTO department (code, name, description, contact_phone)
       VALUES ($1, $2, $3, $4)
       RETURNING ${DEPARTMENT_COLUMNS}`,
      [code, name, input.description?.trim() ?? null, input.contactPhone?.trim() ?? null],
    );

    const created = toDepartment(rows[0]!);
    await recordChange(tx, {
      subject: 'department',
      subjectId: created.departmentId,
      action: 'created',
      before: null,
      after: created,
      actor,
    });
    return created;
  });
}

export interface DepartmentEdit {
  readonly name?: string | undefined;
  readonly description?: string | null | undefined;
  readonly contactPhone?: string | null | undefined;
}

/**
 * Edit a department's own fields.
 *
 * `code` and `is_administration` are deliberately absent. The code is what other records
 * name it by, and the administration flag is not the administration's to grant (ADR-0010).
 */
export async function updateDepartment(
  pool: Pool,
  id: Uuid,
  edit: DepartmentEdit,
  actor: ConfigActor,
): Promise<Department | null> {
  return inTransaction(pool, async (tx) => {
    const { rows: existing } = await tx.query<DepartmentRow>(
      `SELECT ${DEPARTMENT_COLUMNS} FROM department WHERE department_id = $1 FOR UPDATE`,
      [id],
    );
    if (existing[0] === undefined) return null;
    const before = toDepartment(existing[0]);

    const name = edit.name === undefined ? before.name : edit.name.trim();
    const description =
      edit.description === undefined
        ? before.description
        : edit.description === null
          ? null
          : edit.description.trim();
    const contactPhone =
      edit.contactPhone === undefined
        ? before.contactPhone
        : edit.contactPhone === null
          ? null
          : edit.contactPhone.trim();

    const { rows } = await tx.query<DepartmentRow>(
      `UPDATE department
          SET name = $2, description = $3, contact_phone = $4, updated_at = now()
        WHERE department_id = $1
        RETURNING ${DEPARTMENT_COLUMNS}`,
      [id, name, description, contactPhone],
    );

    const after = toDepartment(rows[0]!);
    await recordChange(tx, {
      subject: 'department',
      subjectId: id,
      action: 'updated',
      before,
      after,
      actor,
    });
    return after;
  });
}

/**
 * Retire a department, or bring one back.
 *
 * Never a delete. Its incidents must stay readable and the events naming it must keep
 * meaning what they meant (ADR-0001). Retiring also retires its routing signals, because a
 * department that no longer exists must stop receiving emergencies — leaving the signals
 * live would route work to nobody, silently, which is the worst available outcome.
 */
export async function setDepartmentRetired(
  pool: Pool,
  id: Uuid,
  retired: boolean,
  reason: string,
  actor: ConfigActor,
): Promise<Department | null> {
  return inTransaction(pool, async (tx) => {
    const { rows: existing } = await tx.query<DepartmentRow>(
      `SELECT ${DEPARTMENT_COLUMNS} FROM department WHERE department_id = $1 FOR UPDATE`,
      [id],
    );
    if (existing[0] === undefined) return null;
    const before = toDepartment(existing[0]);

    const { rows } = await tx.query<DepartmentRow>(
      `UPDATE department SET retired_at = ${retired ? 'now()' : 'NULL'}, updated_at = now()
        WHERE department_id = $1
        RETURNING ${DEPARTMENT_COLUMNS}`,
      [id],
    );

    if (retired) {
      await tx.query(
        'UPDATE routing_signal SET retired_at = now() WHERE department_id = $1 AND retired_at IS NULL',
        [id],
      );
    }

    const after = toDepartment(rows[0]!);
    await recordChange(tx, {
      subject: 'department',
      subjectId: id,
      action: retired ? 'retired' : 'restored',
      before,
      after,
      actor,
      reason,
    });
    return after;
  });
}

//------------------------------------------------------------------------------
// Routing signals
//------------------------------------------------------------------------------

interface SignalRow {
  signal_id: string;
  department_id: string;
  kind: SignalKind;
  pattern: string;
}

/** Live signals only. Retired ones must never influence where an emergency goes. */
export async function loadRoutingSignals(pool: Pool): Promise<readonly RoutingSignal[]> {
  const { rows } = await pool.query<SignalRow>(
    `SELECT signal_id, department_id, kind, pattern
       FROM routing_signal
      WHERE retired_at IS NULL
      ORDER BY created_at, signal_id`,
  );
  return rows.map((r) => ({
    signalId: r.signal_id,
    departmentId: r.department_id,
    kind: r.kind,
    pattern: r.pattern,
  }));
}

export async function signalsForDepartment(
  pool: Pool,
  departmentId: Uuid,
): Promise<readonly RoutingSignal[]> {
  const { rows } = await pool.query<SignalRow>(
    `SELECT signal_id, department_id, kind, pattern
       FROM routing_signal
      WHERE department_id = $1 AND retired_at IS NULL
      ORDER BY kind, pattern`,
    [departmentId],
  );
  return rows.map((r) => ({
    signalId: r.signal_id,
    departmentId: r.department_id,
    kind: r.kind,
    pattern: r.pattern,
  }));
}

export type AddSignalResult =
  | { readonly ok: true; readonly signal: RoutingSignal }
  | { readonly ok: false; readonly why: string };

export async function addRoutingSignal(
  pool: Pool,
  departmentId: Uuid,
  kind: SignalKind,
  rawPattern: string,
  actor: ConfigActor,
): Promise<AddSignalResult> {
  // Normalised on the way in, so matching never depends on how it was typed. The stored
  // value is the one that will be compared, which keeps the screen honest about the rule.
  const pattern = normalise(rawPattern);
  if (pattern === '') return { ok: false, why: 'a routing signal needs a pattern' };

  return inTransaction(pool, async (tx) => {
    const dept = await tx.query<{ retired_at: string | null }>(
      'SELECT retired_at FROM department WHERE department_id = $1',
      [departmentId],
    );
    if (dept.rows[0] === undefined) return { ok: false as const, why: 'no such department' };
    if (dept.rows[0].retired_at !== null) {
      return { ok: false as const, why: 'that department is retired' };
    }

    const { rows } = await tx.query<SignalRow>(
      `INSERT INTO routing_signal (department_id, kind, pattern)
       VALUES ($1, $2, $3)
       ON CONFLICT (department_id, kind, pattern) WHERE retired_at IS NULL DO NOTHING
       RETURNING signal_id, department_id, kind, pattern`,
      [departmentId, kind, pattern],
    );

    if (rows[0] === undefined) {
      return { ok: false as const, why: 'that department already has this signal' };
    }

    const signal: RoutingSignal = {
      signalId: rows[0].signal_id,
      departmentId: rows[0].department_id,
      kind: rows[0].kind,
      pattern: rows[0].pattern,
    };
    await recordChange(tx, {
      subject: 'routing_signal',
      subjectId: signal.signalId,
      action: 'created',
      before: null,
      after: signal,
      actor,
    });
    return { ok: true as const, signal };
  });
}

export async function retireRoutingSignal(
  pool: Pool,
  signalId: Uuid,
  reason: string,
  actor: ConfigActor,
): Promise<boolean> {
  return inTransaction(pool, async (tx) => {
    const { rows } = await tx.query<SignalRow>(
      `UPDATE routing_signal SET retired_at = now()
        WHERE signal_id = $1 AND retired_at IS NULL
        RETURNING signal_id, department_id, kind, pattern`,
      [signalId],
    );
    if (rows[0] === undefined) return false;

    await recordChange(tx, {
      subject: 'routing_signal',
      subjectId: signalId,
      action: 'retired',
      before: rows[0],
      after: null,
      actor,
      reason,
    });
    return true;
  });
}

//------------------------------------------------------------------------------
// SLA targets
//------------------------------------------------------------------------------

export interface SlaConfiguration {
  /** Applied when a department has set nothing of its own. */
  readonly district: SlaTargets;
  /** departmentId → the severities that department has overridden. Partial by design. */
  readonly byDepartment: Readonly<Record<string, Partial<Record<Severity, number>>>>;
}

interface SlaRow {
  department_id: string | null;
  severity: Severity;
  ack_minutes: number;
}

/**
 * Read the whole SLA configuration in one query.
 *
 * One query rather than one per department because the board evaluates deadlines for every
 * open incident in the district at once, and a per-row lookup there is the classic way a
 * board that was fast in testing becomes slow on the night it matters.
 */
export async function loadSlaConfiguration(pool: Pool): Promise<SlaConfiguration> {
  const { rows } = await pool.query<SlaRow>(
    'SELECT department_id, severity, ack_minutes FROM sla_target',
  );

  const district: Record<string, number> = {};
  const byDepartment: Record<string, Partial<Record<Severity, number>>> = {};

  for (const r of rows) {
    if (r.department_id === null) {
      district[r.severity] = r.ack_minutes;
    } else {
      (byDepartment[r.department_id] ??= {})[r.severity] = r.ack_minutes;
    }
  }

  return { district: district as unknown as SlaTargets, byDepartment };
}

export type SetTargetResult = { readonly ok: true } | { readonly ok: false; readonly why: string };

/**
 * Set one acknowledgement deadline.
 *
 * `departmentId === null` sets the district default. Bounds are enforced here as well as in
 * the CHECK constraint, so the caller gets a sentence rather than a Postgres error string.
 */
export async function setSlaTarget(
  pool: Pool,
  departmentId: Uuid | null,
  severity: Severity,
  ackMinutes: number,
  actor: ConfigActor,
): Promise<SetTargetResult> {
  if (!Number.isInteger(ackMinutes) || ackMinutes < 1 || ackMinutes > 10_080) {
    return { ok: false, why: 'a deadline must be a whole number of minutes between 1 and 10080' };
  }

  return inTransaction(pool, async (tx) => {
    const existing = await tx.query<SlaRow & { target_id: string }>(
      departmentId === null
        ? `SELECT target_id, department_id, severity, ack_minutes FROM sla_target
            WHERE department_id IS NULL AND severity = $1 FOR UPDATE`
        : `SELECT target_id, department_id, severity, ack_minutes FROM sla_target
            WHERE department_id = $2 AND severity = $1 FOR UPDATE`,
      departmentId === null ? [severity] : [severity, departmentId],
    );

    const before = existing.rows[0] ?? null;

    const { rows } = await tx.query<{ target_id: string }>(
      before === null
        ? `INSERT INTO sla_target (department_id, severity, ack_minutes)
           VALUES ($1, $2, $3) RETURNING target_id`
        : `UPDATE sla_target SET ack_minutes = $3, updated_at = now()
            WHERE target_id = $4 RETURNING target_id`,
      before === null
        ? [departmentId, severity, ackMinutes]
        : [departmentId, severity, ackMinutes, before.target_id],
    );

    await recordChange(tx, {
      subject: 'sla_target',
      subjectId: rows[0]!.target_id,
      action: before === null ? 'created' : 'updated',
      before,
      after: { department_id: departmentId, severity, ack_minutes: ackMinutes },
      actor,
    });
    return { ok: true as const };
  });
}

//------------------------------------------------------------------------------
// The history
//------------------------------------------------------------------------------

/**
 * Recent configuration changes, newest first, with the actor resolved to a name.
 *
 * Joined rather than stored denormalised: the seat is the record (ADR-0004), and the name
 * is a convenience for the screen. If the holder changes, the change stays attributed to
 * the seat that made it and the display simply follows whoever holds it now.
 */
export async function recentConfigChanges(
  pool: Pool,
  limit = 50,
): Promise<readonly ConfigChange[]> {
  const { rows } = await pool.query<{
    event_id: string;
    seq: string;
    subject: ConfigSubject;
    subject_id: string;
    action: ConfigAction;
    before: unknown;
    after: unknown;
    actor_seat_id: string | null;
    seat_title: string | null;
    full_name: string | null;
    reason: string | null;
    recorded_at: string;
  }>(
    `SELECT c.event_id, c.seq, c.subject, c.subject_id, c.action, c.before, c.after,
            c.actor_seat_id, s.title AS seat_title, p.full_name, c.reason, c.recorded_at
       FROM config_event c
       LEFT JOIN seat   s ON s.seat_id   = c.actor_seat_id
       LEFT JOIN person p ON p.person_id = c.actor_person_id
      ORDER BY c.seq DESC
      LIMIT $1`,
    [Math.min(Math.max(1, limit), 500)],
  );

  return rows.map((r) => ({
    eventId: r.event_id,
    seq: r.seq,
    subject: r.subject,
    subjectId: r.subject_id,
    action: r.action,
    before: r.before,
    after: r.after,
    actorSeatId: r.actor_seat_id,
    actorSeatTitle: r.seat_title,
    actorName: r.full_name,
    reason: r.reason,
    recordedAt: r.recorded_at,
  }));
}
