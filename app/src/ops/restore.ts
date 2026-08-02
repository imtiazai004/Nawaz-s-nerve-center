/**
 * Restore — the half of M0-37 that actually matters, and the mechanism M0-38 drills.
 *
 * **A backup is a claim. A restore is the evidence.** Everything in `backup.ts` is
 * worthless until this has been run by somebody who did not write it, against a dump they
 * did not produce, on a day when it matters. That is M0-38 and it needs a person.
 *
 * What this file can do is make the path known-good, so the person running the drill is
 * following a procedure that has been executed rather than one that has been written down.
 * `docs/08-runbook.md` is the human version of exactly these steps.
 *
 * Two things it deliberately refuses to do:
 *
 * - **It will not restore over an existing database.** Every restore goes into a named
 *   target that the caller has to state. A restore tool whose easiest path overwrites
 *   production is a tool that will eventually overwrite production, at 02:00, by someone
 *   tired.
 * - **It will not report success on `psql` exiting 0.** The dump is replayed and then the
 *   result is *counted and compared*. "The command completed" is not "the district's
 *   emergencies are back".
 */

import { readFile } from 'node:fs/promises';

import { createPool, type Pool } from '../db/pool.js';
import { runTool } from './backup.js';
import { join } from 'node:path';

function binary(name: string, pgBin?: string): string {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  return pgBin === undefined || pgBin === '' ? exe : join(pgBin, exe);
}

export interface RestoreOptions {
  /** The dump to replay. */
  readonly dumpPath: string;
  /**
   * A connection string for the **target**, which must already exist and should be empty.
   * Never defaulted, never inferred: naming the target is the safety mechanism.
   */
  readonly targetUrl: string;
  readonly pgBin?: string;
  /** Compare the restored event count against this. Usually the live database's count. */
  readonly expectEvents?: number;
}

export interface RestoreResult {
  readonly ok: boolean;
  readonly eventCount: number;
  readonly error?: string;
  /** Wall-clock seconds. The drill has to be timed — a restore nobody timed is untested. */
  readonly seconds: number;
}

/**
 * Replay a dump into a named target and verify what came back.
 *
 * The verification is the point. It reloads the event log, counts it, and — when the caller
 * says what to expect — refuses to call a short restore a success.
 */
export async function restoreInto(options: RestoreOptions): Promise<RestoreResult> {
  const startedAt = Date.now();
  const seconds = (): number => Math.round((Date.now() - startedAt) / 100) / 10;

  const sql = await readFile(options.dumpPath, 'utf8').catch(() => null);
  if (sql === null) {
    return { ok: false, eventCount: 0, error: `cannot read ${options.dumpPath}`, seconds: 0 };
  }

  // `ON_ERROR_STOP` is not optional. Without it psql reports success after replaying a dump
  // that half-failed, which is the single most dangerous default in this whole procedure:
  // you get a database, it is missing things, and nothing said so.
  const replay = await runTool(binary('psql', options.pgBin), [
    '--quiet',
    '--set',
    'ON_ERROR_STOP=1',
    '--file',
    options.dumpPath,
    options.targetUrl,
  ]);

  if (replay.code !== 0) {
    return {
      ok: false,
      eventCount: 0,
      error: `psql exited ${String(replay.code)}: ${replay.stderr || 'no output'}`,
      seconds: seconds(),
    };
  }

  let pool: Pool | null = null;
  try {
    pool = createPool(options.targetUrl);
    const res = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM incident_event');
    const eventCount = Number(res.rows[0]?.n ?? 0);

    if (options.expectEvents !== undefined && eventCount < options.expectEvents) {
      return {
        ok: false,
        eventCount,
        error: `restored ${eventCount} events, expected at least ${options.expectEvents}`,
        seconds: seconds(),
      };
    }

    return { ok: true, eventCount, seconds: seconds() };
  } catch (err) {
    return {
      ok: false,
      eventCount: 0,
      error: `restored database is not queryable: ${String(err)}`,
      seconds: seconds(),
    };
  } finally {
    await pool?.end();
  }
}

export interface IntegrityReport {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

/**
 * Is the restored database actually the system, or just its data?
 *
 * The distinction has bitten real projects: a restore that brings back rows but not the
 * append-only triggers gives you a database where the event log can be edited, and nobody
 * notices until an audit. The whole of `ADR-0001` is enforced by those triggers, so a
 * restore that loses them has restored the data and lost the guarantee.
 */
export async function verifyRestoredIntegrity(pool: Pool): Promise<IntegrityReport> {
  const problems: string[] = [];

  const triggers = await pool.query<{ tgname: string }>(
    `SELECT tgname FROM pg_trigger
      WHERE tgrelid = 'incident_event'::regclass AND NOT tgisinternal`,
  );
  if (triggers.rows.length === 0) {
    problems.push(
      'incident_event has no append-only triggers: the data is back but ADR-0001 is not enforced',
    );
  }

  // Prove it rather than trust the catalogue: try an actual mutation and require it to be
  // refused.
  //
  // Two details, both learned by getting this wrong. The guard is a **row-level** trigger
  // (migration 0001), so a probe with `WHERE false` matches nothing, fires nothing, and
  // reports a healthy database as broken. It has to target a real row. And it runs inside a
  // transaction that is **always** rolled back, so that on the one database where this
  // check matters — the one where the guard is missing — the probe cannot be the thing that
  // rewrites history.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const target = await client.query<{ event_id: string }>(
      'SELECT event_id FROM incident_event LIMIT 1',
    );
    const eventId = target.rows[0]?.event_id;

    if (eventId === undefined) {
      // Nothing to probe with. Saying so is the honest answer — an empty table cannot
      // demonstrate that its guard works, and reporting success here would be a guess.
      problems.push(
        'incident_event is empty, so the append-only guard could not be proven by trying it',
      );
    } else {
      const res = await client.query(
        'UPDATE incident_event SET source_channel = source_channel WHERE event_id = $1',
        [eventId],
      );
      if ((res.rowCount ?? 0) > 0) {
        problems.push('UPDATE on incident_event was accepted; the append-only guard is not active');
      }
    }
  } catch {
    // Expected on a healthy database: the trigger raised.
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }

  const migrations = await pool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM schema_migration',
  );
  if (Number(migrations.rows[0]?.n ?? 0) === 0) {
    problems.push('schema_migration is empty: the restored database will re-run every migration');
  }

  return { ok: problems.length === 0, problems };
}
