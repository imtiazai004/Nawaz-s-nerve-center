/**
 * Reading and writing what a wall screen shows — M4, ADR-0013.
 *
 * Four separate things live here because they are read by one screen and by nothing else:
 * utility reports, presence reports, the identities televisions sign in as, and the cached
 * weather reading.
 *
 * The shape that repeats: **the latest report, with its own timestamp.** Never a status
 * column. A column answers "what is it now" and destroys "since when, and who says so",
 * which on an unattended screen is the entire question (ADR-0013 §3).
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import type { PresenceStatus, UtilityStatus } from '../domain/wall.js';

export interface Utility {
  readonly utilityId: string;
  readonly name: string;
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
    `SELECT u.utility_id, u.name, u.department_id, d.name AS department_name,
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
  input: { name: string; departmentId: string | null; staleMinutes?: number; position?: number },
): Promise<string> {
  const result = await pool.query<{ utility_id: string }>(
    `INSERT INTO utility (name, department_id, stale_minutes, position)
     VALUES ($1, $2, COALESCE($3, 240), COALESCE($4, 0))
     RETURNING utility_id`,
    [input.name, input.departmentId, input.staleMinutes ?? null, input.position ?? null],
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

export interface WallScreen {
  readonly screenId: string;
  readonly label: string;
  readonly issuedAt: string;
  readonly issuedBy: string | null;
  readonly revokedAt: string | null;
  readonly lastSeenAt: string | null;
}

interface ScreenRow {
  screen_id: string;
  label: string;
  issued_at: string;
  issued_by: string | null;
  revoked_at: string | null;
  last_seen_at: string | null;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Issue a screen its own credential.
 *
 * The token is returned **once**, here, and never again. A console that could redisplay it
 * would be putting it in every nightly dump in readable form, and the dump leaves the
 * district (ADR-0011).
 *
 * A wall token is long and random rather than memorable. Nobody types it: it goes into the
 * television's browser once, on the day it is mounted.
 */
export async function issueWallScreen(
  pool: Pool,
  input: { label: string; issuedBy: string | null },
): Promise<{ screenId: string; token: string }> {
  const token = randomBytes(32).toString('base64url');

  const result = await pool.query<{ screen_id: string }>(
    `INSERT INTO wall_screen (label, token_hash, issued_by)
     VALUES ($1, $2, $3)
     RETURNING screen_id`,
    [input.label, hashToken(token), input.issuedBy],
  );

  return { screenId: result.rows[0]!.screen_id, token };
}

export async function listWallScreens(pool: Pool): Promise<WallScreen[]> {
  const result = await pool.query<ScreenRow>(
    `SELECT w.screen_id, w.label, w.issued_at, s.title AS issued_by, w.revoked_at, w.last_seen_at
       FROM wall_screen w
       LEFT JOIN seat s ON s.seat_id = w.issued_by
      ORDER BY w.revoked_at NULLS FIRST, w.label`,
  );

  return result.rows.map((row) => ({
    screenId: row.screen_id,
    label: row.label,
    issuedAt: row.issued_at,
    issuedBy: row.issued_by,
    revokedAt: row.revoked_at,
    lastSeenAt: row.last_seen_at,
  }));
}

export async function revokeWallScreen(pool: Pool, screenId: string): Promise<boolean> {
  const result = await pool.query(
    'UPDATE wall_screen SET revoked_at = now() WHERE screen_id = $1 AND revoked_at IS NULL',
    [screenId],
  );

  return (result.rowCount ?? 0) > 0;
}

/**
 * Resolve a token presented by a television, and mark the screen as having called home.
 *
 * The comparison is `timingSafeEqual` over the hashes rather than a SQL `=` on the token
 * hash. Both are constant-ish in practice, but this one is constant by construction and the
 * cost is a full-table scan over a table with as many rows as the district has televisions.
 */
export async function resolveWallToken(
  pool: Pool,
  token: string,
): Promise<{ screenId: string; label: string } | null> {
  if (token.length === 0) return null;

  const presented = Buffer.from(hashToken(token), 'hex');

  const result = await pool.query<{ screen_id: string; label: string; token_hash: string }>(
    'SELECT screen_id, label, token_hash FROM wall_screen WHERE revoked_at IS NULL',
  );

  for (const row of result.rows) {
    const stored = Buffer.from(row.token_hash, 'hex');

    if (stored.length === presented.length && timingSafeEqual(stored, presented)) {
      // Best effort. A screen that renders but fails to record the visit is a worse outcome
      // than a slightly stale `last_seen_at`.
      await pool
        .query('UPDATE wall_screen SET last_seen_at = now() WHERE screen_id = $1', [row.screen_id])
        .catch(() => undefined);

      return { screenId: row.screen_id, label: row.label };
    }
  }

  return null;
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
