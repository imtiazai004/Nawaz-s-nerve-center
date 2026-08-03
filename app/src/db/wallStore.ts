/**
 * What the dashboard shows about the district itself — M4.
 *
 * Three things live here because they arrived together for the dashboard: utility reports,
 * presence reports, and the cached weather reading.
 *
 * The shape that repeats: **the latest report, with its own timestamp.** Never a status
 * column. A column answers "what is it now" and destroys "since when, and who says so" —
 * which, on a panel somebody glances at from across a room, is the entire question.
 */

import type { Pool } from 'pg';
import type { PresenceStatus, UtilityStatus } from '../domain/wall.js';

export interface Utility {
  readonly utilityId: string;
  readonly name: string;
  /** Which panel it appears in: the utilities, or the district's services. */
  readonly panel: 'utility' | 'services';
  readonly departmentId: string | null;
  readonly departmentName: string | null;
  readonly staleMinutes: number;
  readonly position: number;
  readonly status: UtilityStatus | null;
  readonly note: string | null;
  readonly reportedAt: string | null;
  readonly reportedBy: string | null;
}

interface UtilityRow {
  utility_id: string;
  name: string;
  panel: 'utility' | 'services';
  department_id: string | null;
  department_name: string | null;
  stale_minutes: number;
  position: number;
  status: UtilityStatus | null;
  note: string | null;
  reported_at: string | null;
  reported_by: string | null;
}

/**
 * Every utility the district watches, each with its most recent report.
 *
 * A LATERAL join rather than a window function or a `MAX(reported_at)` self-join: with an
 * index on `(utility_id, reported_at DESC)` it reads exactly one row per utility however many
 * years of reports are behind it. The alternative sorts the whole history to discard all but
 * the last of each — which is fine at ten reports and not at ten thousand.
 *
 * Retired utilities are excluded. A service the district stopped watching is not a service
 * that has gone quiet, and a wall screen must not confuse the two.
 */
export async function listUtilities(pool: Pool): Promise<Utility[]> {
  const result = await pool.query<UtilityRow>(
    `SELECT u.utility_id, u.name, u.panel, u.department_id, d.name AS department_name,
            u.stale_minutes, u.position,
            r.status, r.note, r.reported_at, s.title AS reported_by
       FROM utility u
       LEFT JOIN department d ON d.department_id = u.department_id
       LEFT JOIN LATERAL (
            SELECT status, note, reported_at, reported_by
              FROM utility_report
             WHERE utility_id = u.utility_id
             ORDER BY reported_at DESC
             LIMIT 1
       ) r ON true
       LEFT JOIN seat s ON s.seat_id = r.reported_by
      WHERE u.retired_at IS NULL
      ORDER BY u.position, u.name`,
  );

  return result.rows.map((row) => ({
    utilityId: row.utility_id,
    name: row.name,
    panel: row.panel,
    departmentId: row.department_id,
    departmentName: row.department_name,
    staleMinutes: row.stale_minutes,
    position: row.position,
    status: row.status,
    note: row.note,
    reportedAt: row.reported_at,
    reportedBy: row.reported_by,
  }));
}

export async function addUtility(
  pool: Pool,
  input: {
    name: string;
    departmentId: string | null;
    panel?: 'utility' | 'services';
    staleMinutes?: number;
    position?: number;
  },
): Promise<string> {
  const result = await pool.query<{ utility_id: string }>(
    `INSERT INTO utility (name, panel, department_id, stale_minutes, position)
     VALUES ($1, COALESCE($2, 'utility'), $3, COALESCE($4, 240), COALESCE($5, 0))
     RETURNING utility_id`,
    [
      input.name,
      input.panel ?? null,
      input.departmentId,
      input.staleMinutes ?? null,
      input.position ?? null,
    ],
  );

  return result.rows[0]!.utility_id;
}

export async function retireUtility(pool: Pool, utilityId: string): Promise<boolean> {
  const result = await pool.query(
    'UPDATE utility SET retired_at = now() WHERE utility_id = $1 AND retired_at IS NULL',
    [utilityId],
  );

  return (result.rowCount ?? 0) > 0;
}

export async function reportUtility(
  pool: Pool,
  input: {
    utilityId: string;
    status: UtilityStatus;
    note: string | null;
    reportedBy: string | null;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO utility_report (utility_id, status, note, reported_by)
     VALUES ($1, $2, $3, $4)`,
    [input.utilityId, input.status, input.note, input.reportedBy],
  );
}

/** Which department is answerable for a utility, for the check that only they may report it. */
export async function utilityOwner(
  pool: Pool,
  utilityId: string,
): Promise<{ departmentId: string | null } | null> {
  const result = await pool.query<{ department_id: string | null }>(
    'SELECT department_id FROM utility WHERE utility_id = $1 AND retired_at IS NULL',
    [utilityId],
  );

  const row = result.rows[0];

  return row === undefined ? null : { departmentId: row.department_id };
}

export interface Presence {
  readonly seatId: string;
  readonly seatTitle: string;
  readonly departmentId: string | null;
  readonly departmentName: string | null;
  /** True for a seat in the DC Office or AC Headquarter — the posts a wall screen lists. */
  readonly isAdministration: boolean;
  readonly status: PresenceStatus | null;
  readonly note: string | null;
  readonly reportedAt: string | null;
  readonly untilAt: string | null;
}

interface PresenceRow {
  seat_id: string;
  seat_title: string;
  department_id: string | null;
  department_name: string | null;
  is_administration: boolean | null;
  status: PresenceStatus | null;
  note: string | null;
  reported_at: string | null;
  until_at: string | null;
}

/**
 * Presence for the seats the district watches.
 *
 * `departmentId` filters to one department's own seats — the path a department uses to set
 * its own people's presence. Passing null lists every live seat, which is what the two
 * offices and the wall screen see.
 *
 * A seat with no report at all is still returned. That is the point: "AAC Baka Khel — not
 * reported" is a fact the district should be looking at, and omitting the row would turn a
 * visible gap into an invisible one (ADR-0005).
 */
export async function listPresence(pool: Pool, departmentId?: string | null): Promise<Presence[]> {
  const scoped = departmentId !== undefined && departmentId !== null;

  const result = await pool.query<PresenceRow>(
    `SELECT st.seat_id, st.title AS seat_title, st.department_id, d.name AS department_name,
            d.is_administration,
            p.status, p.note, p.reported_at, p.until_at
       FROM seat st
       LEFT JOIN department d ON d.department_id = st.department_id
       LEFT JOIN LATERAL (
            SELECT status, note, reported_at, until_at
              FROM presence_report
             WHERE seat_id = st.seat_id
             ORDER BY reported_at DESC
             LIMIT 1
       ) p ON true
      WHERE st.retired_at IS NULL
        AND ($1::uuid IS NULL OR st.department_id = $1::uuid)
      ORDER BY d.name NULLS FIRST, st.title`,
    [scoped ? departmentId : null],
  );

  return result.rows.map((row) => ({
    seatId: row.seat_id,
    seatTitle: row.seat_title,
    departmentId: row.department_id,
    departmentName: row.department_name,
    isAdministration: row.is_administration ?? false,
    status: row.status,
    note: row.note,
    reportedAt: row.reported_at,
    untilAt: row.until_at,
  }));
}

export async function reportPresence(
  pool: Pool,
  input: {
    seatId: string;
    status: PresenceStatus;
    note: string | null;
    untilAt: string | null;
    reportedBy: string | null;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO presence_report (seat_id, status, note, until_at, reported_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [input.seatId, input.status, input.note, input.untilAt, input.reportedBy],
  );
}

/** Which department a seat belongs to, for the check that a department sets only its own. */
export async function seatDepartment(pool: Pool, seatId: string): Promise<string | null | false> {
  const result = await pool.query<{ department_id: string | null }>(
    'SELECT department_id FROM seat WHERE seat_id = $1 AND retired_at IS NULL',
    [seatId],
  );

  const row = result.rows[0];

  // `false` for "no such seat" so that a real seat with no department — the two offices'
  // district posts — is not indistinguishable from one that does not exist.
  return row === undefined ? false : row.department_id;
}

export interface WeatherReading {
  readonly observedAt: string;
  readonly fetchedAt: string;
  readonly payload: Record<string, unknown>;
}

export async function storeWeather(
  pool: Pool,
  input: { observedAt: string; payload: Record<string, unknown> },
): Promise<void> {
  await pool.query('INSERT INTO weather_reading (observed_at, payload) VALUES ($1, $2)', [
    input.observedAt,
    JSON.stringify(input.payload),
  ]);
}

export async function latestWeather(pool: Pool): Promise<WeatherReading | null> {
  const result = await pool.query<{
    observed_at: string;
    fetched_at: string;
    payload: Record<string, unknown>;
  }>(
    'SELECT observed_at, fetched_at, payload FROM weather_reading ORDER BY fetched_at DESC LIMIT 1',
  );

  const row = result.rows[0];

  if (row === undefined) return null;

  return { observedAt: row.observed_at, fetchedAt: row.fetched_at, payload: row.payload };
}

/**
 * Keep the last few readings and drop the rest.
 *
 * The table is written every fifteen minutes forever. Nobody will ever read the third-newest
 * row, and an unbounded table of weather observations would end up in every nightly dump the
 * district ships off-site — paid for, encrypted, and pointless.
 */
export async function pruneWeather(pool: Pool, keep = 50): Promise<number> {
  const result = await pool.query(
    `DELETE FROM weather_reading
      WHERE reading_id NOT IN (
            SELECT reading_id FROM weather_reading ORDER BY fetched_at DESC LIMIT $1
      )`,
    [keep],
  );

  return result.rowCount ?? 0;
}

//--------------------------------------------------------------------------------
// The facts about Bannu that do not change on a Tuesday
//--------------------------------------------------------------------------------

export interface DistrictFact {
  readonly key: string;
  readonly label: string;
  readonly value: string | null;
}

/**
 * Tehsils, union councils, population, area.
 *
 * Returned with `value` null when nobody has supplied one, rather than omitted. The gap is
 * the point: a district status board missing its population is a board with a job for
 * somebody, and dropping the row would turn that into a board that looks complete.
 */
export async function listFacts(pool: Pool): Promise<DistrictFact[]> {
  const result = await pool.query<{ key: string; label: string; value: string | null }>(
    'SELECT key, label, value FROM district_fact ORDER BY position, label',
  );

  return result.rows.map((row) => ({ key: row.key, label: row.label, value: row.value }));
}

export async function setFact(
  pool: Pool,
  input: { key: string; value: string | null; seatId: string | null },
): Promise<boolean> {
  const result = await pool.query(
    'UPDATE district_fact SET value = $2, updated_at = now(), updated_by = $3 WHERE key = $1',
    [input.key, input.value, input.seatId],
  );

  return (result.rowCount ?? 0) > 0;
}

//--------------------------------------------------------------------------------
// Alerts and advisories
//--------------------------------------------------------------------------------

export type AlertTag = 'vip' | 'security' | 'road' | 'weather' | 'other';

export interface DistrictAlert {
  readonly alertId: string;
  readonly tag: AlertTag;
  readonly message: string;
  readonly issuedAt: string;
  readonly issuedBy: string | null;
  readonly untilAt: string;
}

/**
 * What the district is currently advising.
 *
 * Live only: withdrawn advisories and expired ones are excluded, because an advisory board
 * that keeps yesterday's road closure on it is a board people stop reading. The rows are
 * still in the table — "we told the district the road was shut" is a thing somebody may have
 * to answer for (ADR-0001).
 */
export async function liveAlerts(pool: Pool, limit = 8): Promise<DistrictAlert[]> {
  const result = await pool.query<{
    alert_id: string;
    tag: AlertTag;
    message: string;
    issued_at: string;
    issued_by: string | null;
    until_at: string;
  }>(
    `SELECT a.alert_id, a.tag, a.message, a.issued_at, s.title AS issued_by, a.until_at
       FROM district_alert a
       LEFT JOIN seat s ON s.seat_id = a.issued_by
      WHERE a.withdrawn_at IS NULL AND a.until_at > now()
      ORDER BY a.issued_at DESC
      LIMIT $1`,
    [limit],
  );

  return result.rows.map((row) => ({
    alertId: row.alert_id,
    tag: row.tag,
    message: row.message,
    issuedAt: row.issued_at,
    issuedBy: row.issued_by,
    untilAt: row.until_at,
  }));
}

export async function issueAlert(
  pool: Pool,
  input: { tag: AlertTag; message: string; untilAt: string; issuedBy: string | null },
): Promise<string> {
  const result = await pool.query<{ alert_id: string }>(
    `INSERT INTO district_alert (tag, message, until_at, issued_by)
     VALUES ($1, $2, $3, $4)
     RETURNING alert_id`,
    [input.tag, input.message, input.untilAt, input.issuedBy],
  );

  return result.rows[0]!.alert_id;
}

export async function withdrawAlert(
  pool: Pool,
  input: { alertId: string; reason: string },
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE district_alert
        SET withdrawn_at = now(), withdrawn_reason = $2
      WHERE alert_id = $1 AND withdrawn_at IS NULL`,
    [input.alertId, input.reason],
  );

  return (result.rowCount ?? 0) > 0;
}
