/**
 * The nightly backup — M0-53, ADR-0011.
 *
 * P-08 held this up for weeks: the backup was built and verified and **nothing scheduled it**,
 * because where the server runs decides how. ADR-0011 answered that — a machine in the DC
 * office — so this is the thing that runs at 02:00 and puts the district's record somewhere
 * a fire cannot reach.
 *
 * Two decisions worth reading before changing anything here.
 *
 * **It checks every ten minutes rather than sleeping until 02:00.** A district server gets
 * rebooted, loses power, and is occasionally a laptop somebody closed. A timer set for eight
 * hours away is a timer that never fires, and the failure is invisible: nobody notices a
 * backup that did not happen. Asking "has one been taken today?" on a short interval survives
 * every one of those, and takes one cheap query to answer.
 *
 * **It dumps the database it verifies against.** `runBackup` falls back to `DATABASE_URL`
 * when no connection string is given, and a server whose pool was built from a different URL
 * would then back up the wrong database and compare the result against the right one. The
 * event-count check catches it — that is how this was found — but catching it is not the same
 * as not doing it, so the caller states which database this is.
 *
 * **A run that fails is louder than a run that succeeds.** Nothing is logged on success
 * beyond a line; a failure is logged at error level, recorded in the ledger, and surfaced by
 * `/health` as `degraded`. A backup that silently stopped working a year ago is worse than no
 * backup, because the district spent that year believing it was covered.
 */

import type { Pool } from '../db/pool.js';
import { log } from '../obs/log.js';
import { runBackup, type BackupOptions } from '../ops/backup.js';
import { gcsStore, uploadDump, type OffsiteEnv, type OffsiteStore } from '../ops/offsite.js';

/** How often to ask whether tonight's backup has been taken. Not how often to take one. */
const CHECK_INTERVAL_MS = 10 * 60_000;

/**
 * The hour it runs, in the district's own time.
 *
 * 02:00 local, because the emergency load in Bannu is lowest then and a `pg_dump` on a single
 * node competes with everything else the server is doing.
 */
export const BACKUP_HOUR = 2;

export interface NightlyOptions {
  readonly pool: Pool;
  readonly backup: BackupOptions;
  readonly env?: OffsiteEnv;
  readonly store?: OffsiteStore;
  readonly intervalMs?: number;
  readonly hour?: number;
  readonly now?: () => Date;
  readonly onRun?: (outcome: NightlyOutcome) => void;
}

export interface NightlyOutcome {
  readonly ran: boolean;
  readonly reason: string;
  readonly backupOk?: boolean;
  readonly offsiteOk?: boolean;
  readonly offsiteSkipped?: string;
}

export interface Nightly {
  start(): void;
  stop(): void;
  /** Run the check now. Exposed for tests and for an operator who wants one immediately. */
  tick(): Promise<NightlyOutcome>;
  /** Take one right now regardless of the schedule. The console's "back up now" button. */
  runNow(): Promise<NightlyOutcome>;
}

/**
 * Has a backup already succeeded today, in local time?
 *
 * Local rather than UTC, because "today" for the person who will be asked about it is the
 * district's day. In Bannu that is UTC+5, so a UTC-based check would treat 02:00 local as the
 * previous day and take a second backup every night.
 */
async function alreadyToday(pool: Pool, now: Date): Promise<boolean> {
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);

  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM backup_run
      WHERE status = 'ok' AND finished_at >= $1`,
    [startOfDay.toISOString()],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

export function createNightly(options: NightlyOptions): Nightly {
  const { pool } = options;
  const env = options.env ?? (process.env as OffsiteEnv);
  const store = options.store ?? gcsStore(env);
  const hour = options.hour ?? BACKUP_HOUR;
  const intervalMs = options.intervalMs ?? CHECK_INTERVAL_MS;
  const now = options.now ?? ((): Date => new Date());

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function take(reason: string): Promise<NightlyOutcome> {
    const result = await runBackup(pool, options.backup);

    if (!result.ok) {
      log('error', 'nightly backup failed', { error: result.error ?? 'unknown' });
      const outcome = { ran: true, reason, backupOk: false };
      options.onRun?.(outcome);
      return outcome;
    }

    // Uploaded only after the dump verified. Sending an unverified dump off-site would put a
    // file in the bucket that nobody can restore, which is worse than an empty bucket
    // because it looks like cover.
    const upload = await uploadDump(pool, result.backupRunId, result.path!, store, env);

    const outcome: NightlyOutcome = {
      ran: true,
      reason,
      backupOk: true,
      offsiteOk: upload.ok,
      ...(upload.skipped === undefined ? {} : { offsiteSkipped: upload.skipped }),
    };

    if (upload.ok) {
      log('info', 'nightly backup taken and sent off-site', {
        events: result.eventCount ?? 0,
        key: upload.key ?? '',
      });
    } else if (upload.skipped !== undefined) {
      // Not an error — the district has not bought a bucket yet (R-06). Said once per night
      // at warn, so it is visible without being alarming.
      log('warn', 'nightly backup taken but not sent off-site', { why: upload.skipped });
    } else {
      log('error', 'nightly backup taken but the off-site copy failed', {
        error: upload.error ?? 'unknown',
      });
    }

    options.onRun?.(outcome);
    return outcome;
  }

  async function tick(): Promise<NightlyOutcome> {
    // Overlap is possible on a slow dump and a short interval. The second run would compete
    // with the first for the same disk and produce two dumps of the same night.
    if (running) return { ran: false, reason: 'a backup is already running' };

    const at = now();
    if (at.getHours() < hour) {
      return { ran: false, reason: `before ${String(hour).padStart(2, '0')}:00` };
    }
    if (await alreadyToday(pool, at)) return { ran: false, reason: 'already taken today' };

    running = true;
    try {
      // "After 02:00 and none yet today" rather than "at exactly 02:00". A server that was
      // off at 02:00 and booted at 06:00 still takes tonight's backup, which is the whole
      // reason this is a poll and not a timer.
      return await take('scheduled');
    } finally {
      running = false;
    }
  }

  return {
    start(): void {
      if (timer !== null) return;
      timer = setInterval(() => {
        void tick().catch((err: unknown) => {
          log('error', 'nightly backup check threw', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }, intervalMs);
      timer.unref?.();
    },
    stop(): void {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
    tick,
    async runNow(): Promise<NightlyOutcome> {
      if (running) return { ran: false, reason: 'a backup is already running' };
      running = true;
      try {
        return await take('asked for');
      } finally {
        running = false;
      }
    },
  };
}
