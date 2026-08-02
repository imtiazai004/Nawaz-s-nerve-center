/**
 * Loading the district directory — M0-51.
 *
 * The source is a list the district maintains: department/office, officer name,
 * designation, mobile number. Each row becomes a **seat** (the post), optionally held by a
 * **person** (whoever is in it today) — which is precisely the model ADR-0004 already
 * describes, so nothing new is invented to hold it.
 *
 * Three rules, and all three exist because a directory is where a system quietly starts
 * lying about the district:
 *
 * 1. **Nothing is inferred.** The department is the row's own "Department/Office" value,
 *    verbatim. Several of those are obviously posts within a larger body — `ADC (General)`
 *    sits under the DC Office, `DSP City` under the DPO — but *which* belongs to *what* is a
 *    fact about how Bannu is organised, and this file is not the place to guess it. The
 *    grouping is Q-18.
 * 2. **A directory entry is not an account.** People are loaded with no password hash, which
 *    means they cannot sign in. The system needs to notify these officers; it has no mandate
 *    to create logins for people who have not been told it exists.
 * 3. **Conflicts are reported, never resolved.** Two different names on one mobile number is
 *    either a typo or a shared handset, and the two need opposite fixes. Guessing produces a
 *    directory that is confidently wrong, which is worse than one that is visibly incomplete.
 *
 * Idempotent: run it again after the district sends more rows and only the new ones land.
 */

import type { Pool } from '../db/pool.js';

export interface DirectoryRow {
  /** The "Department/Office" column, verbatim. */
  readonly department: string;
  /** The post. Falls back to the department name when the source leaves it blank. */
  readonly designation?: string;
  readonly name?: string;
  readonly phone?: string;
  readonly tier?: 'station' | 'tehsil' | 'district' | 'provincial';
}

export interface DirectoryProblem {
  readonly row: DirectoryRow;
  readonly problem: string;
}

export interface DirectoryOutcome {
  readonly departments: number;
  readonly seats: number;
  readonly people: number;
  readonly assignments: number;
  /** Rows with no officer named or no number. Loaded as a vacant post, and counted. */
  readonly vacant: number;
  /** Rows that could not be loaded without a guess. Never silently dropped. */
  readonly problems: readonly DirectoryProblem[];
}

/** A stable slug for a department name. Deterministic, so re-running matches what is there. */
export function codeFor(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/**
 * Normalise a Pakistani mobile number to a comparable form.
 *
 * Only enough to spot that `0332 364 9000` and `03323649000` are the same number. It does
 * **not** try to validate: a number that looks wrong is still the number the district gave
 * us, and refusing it would lose a contact to satisfy a regex.
 */
export function normalisePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+92')) return `0${digits.slice(3)}`;
  if (digits.startsWith('92') && digits.length > 10) return `0${digits.slice(2)}`;
  return digits;
}

function isBlank(v: string | undefined): boolean {
  return v === undefined || v.trim().length === 0;
}

/**
 * Load a directory into the database. Safe to run repeatedly.
 *
 * Returns what it did and what it refused to do. The caller is expected to look at
 * `problems` — a loader whose failures are only visible if someone reads the logs is the
 * same mistake as a notification with no delivery state (INV-03).
 */
export async function loadDirectory(
  pool: Pool,
  rows: readonly DirectoryRow[],
): Promise<DirectoryOutcome> {
  const problems: DirectoryProblem[] = [];
  let departments = 0;
  let seats = 0;
  let people = 0;
  let assignments = 0;
  let vacant = 0;

  // phone -> the name already attached to it, so a second, different name is caught.
  const phoneOwner = new Map<string, string>();

  for (const row of rows) {
    if (isBlank(row.department)) {
      problems.push({ row, problem: 'no department/office named' });
      continue;
    }

    const departmentName = row.department.trim();
    const code = codeFor(departmentName);

    const dept = await pool.query<{ department_id: string; inserted: boolean }>(
      `INSERT INTO department (code, name) VALUES ($1, $2)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
       RETURNING department_id, (xmax = 0) AS inserted`,
      [code, departmentName],
    );
    const departmentId = dept.rows[0]!.department_id;
    if (dept.rows[0]!.inserted) departments += 1;

    // The post. Where the source leaves the designation blank, the office name is the best
    // available description of the post and is better than an empty title.
    const title = isBlank(row.designation) ? departmentName : row.designation!.trim();

    const existingSeat = await pool.query<{ seat_id: string }>(
      'SELECT seat_id FROM seat WHERE title = $1 AND department_id = $2',
      [title, departmentId],
    );

    let seatId = existingSeat.rows[0]?.seat_id;
    if (seatId === undefined) {
      const created = await pool.query<{ seat_id: string }>(
        `INSERT INTO seat (title, department_id, tier) VALUES ($1, $2, $3) RETURNING seat_id`,
        [title, departmentId, row.tier ?? 'district'],
      );
      seatId = created.rows[0]!.seat_id;
      seats += 1;
    }

    // A post with nobody named is a real and important state, not a broken row. The
    // escalation ladder and the notifier both already treat a vacant seat as something to
    // surface rather than skip (ADR-0004), so it loads as exactly that.
    if (isBlank(row.name) || isBlank(row.phone)) {
      vacant += 1;
      continue;
    }

    const fullName = row.name!.trim();
    const phone = normalisePhone(row.phone!);

    const owner = phoneOwner.get(phone);
    if (owner !== undefined && owner !== fullName) {
      // Either a typo in the source or a genuinely shared handset. Those need opposite
      // fixes, and picking one would put a confident falsehood in the roster.
      problems.push({
        row,
        problem: `phone ${phone} is already listed for "${owner}" — same number, different name`,
      });
      continue;
    }
    phoneOwner.set(phone, fullName);

    const existingPerson = await pool.query<{ person_id: string; full_name: string }>(
      'SELECT person_id, full_name FROM person WHERE phone = $1',
      [phone],
    );

    let personId = existingPerson.rows[0]?.person_id;
    if (personId === undefined) {
      // No password hash: a directory entry, not an account. See migration 0005.
      const created = await pool.query<{ person_id: string }>(
        'INSERT INTO person (full_name, phone) VALUES ($1, $2) RETURNING person_id',
        [fullName, phone],
      );
      personId = created.rows[0]!.person_id;
      people += 1;
    } else if (existingPerson.rows[0]!.full_name !== fullName) {
      problems.push({
        row,
        problem: `phone ${phone} is already in the database for "${existingPerson.rows[0]!.full_name}"`,
      });
      continue;
    }

    // One officer can hold several posts — the same ADC covers General and Relief, and one
    // XEN covers two canal divisions. The model allows it; the unique index only forbids two
    // people in one seat, which is the thing that would make "who do I notify" unanswerable.
    const held = await pool.query(
      'SELECT 1 FROM duty_assignment WHERE seat_id = $1 AND person_id = $2 AND to_at IS NULL',
      [seatId, personId],
    );

    if (held.rowCount === 0) {
      const occupied = await pool.query<{ person_id: string }>(
        'SELECT person_id FROM duty_assignment WHERE seat_id = $1 AND to_at IS NULL',
        [seatId],
      );

      if (occupied.rowCount !== 0) {
        problems.push({
          row,
          problem: `seat "${title}" is already held by someone else; a handover is a deliberate act, not an import`,
        });
        continue;
      }

      await pool.query('INSERT INTO duty_assignment (seat_id, person_id) VALUES ($1, $2)', [
        seatId,
        personId,
      ]);
      assignments += 1;
    }
  }

  return { departments, seats, people, assignments, vacant, problems };
}

export interface DepartmentSummary {
  readonly departmentId: string;
  readonly code: string;
  readonly name: string;
}

/**
 * Every department, for turning ids into names on a screen.
 *
 * Returned as a map because callers are rendering a list and would otherwise query per row —
 * the same reason the incident detail endpoint returns an actor directory alongside events.
 */
export async function departmentDirectory(
  pool: Pool,
): Promise<Readonly<Record<string, DepartmentSummary>>> {
  const res = await pool.query<{ department_id: string; code: string; name: string }>(
    'SELECT department_id, code, name FROM department WHERE retired_at IS NULL',
  );

  const byId: Record<string, DepartmentSummary> = {};
  for (const r of res.rows) {
    byId[r.department_id] = { departmentId: r.department_id, code: r.code, name: r.name };
  }
  return byId;
}
