/**
 * The scheduler.
 *
 * Deliberately not a job queue. ADR-0007 allows a Postgres-backed queue for background
 * work, and notification retries will genuinely need one — but SLA escalation is a
 * periodic *scan*, not a set of enqueued items, and building a queue to hold one recurring
 * task would be operational surface bought for nothing.
 *
 * Two instances running at once must not both escalate the same incident. A Postgres
 * advisory lock gives that in one line, with no extra table, no leader election and
 * nothing new for anyone to debug at 02:00.
 */

import type { Pool } from '../db/pool.js';
import type { SlaTargets } from '../domain/sla.js';
import { runEscalationPass, type EscalationOutcome } from './escalation.js';
import { runNotifyPass, type NotificationChannel, type NotifyOutcome } from './notify.js';

/**
 * Arbitrary but fixed. Advisory locks are keyed by number and share one namespace across
 * the database, so this must not collide with any other lock the application takes.
 */
const ESCALATION_LOCK_KEY = 4_112_026;

export interface SchedulerOptions {
  readonly pool: Pool;
  /** How often to scan. Must be well below the tightest SLA target. */
  readonly intervalMs?: number;
  /**
   * Acknowledgement deadlines. These are operational commitments made by the departments
   * and the DC office, not engineering constants — see Q-06. Injectable so they can come
   * from configuration once those numbers are agreed.
   */
  readonly targets?: SlaTargets;
  readonly onOutcome?: (outcome: EscalationOutcome) => void;
  readonly onNotify?: (outcome: NotifyOutcome) => void;
  readonly onError?: (error: unknown) => void;
  /** Injectable so a test can supply a channel that fails on purpose. */
  readonly channel?: NotificationChannel;
}

export interface PassOutcome {
  readonly escalation: EscalationOutcome;
  readonly notification: NotifyOutcome;
}

export interface Scheduler {
  start(): void;
  stop(): Promise<void>;
  /** Run one pass now, respecting the lock. Exposed for tests and for an operator. */
  tick(): Promise<PassOutcome | null>;
}

/**
 * Run one pass if this instance can take the lock.
 *
 * Returns null when another instance holds it — which is a normal outcome, not a failure.
 * The lock is released in a `finally` so a thrown pass cannot wedge every future tick.
 */
export async function runLockedPass(
  pool: Pool,
  targets?: SlaTargets,
  channel?: NotificationChannel,
): Promise<PassOutcome | null> {
  const client = await pool.connect();
  try {
    const got = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [ESCALATION_LOCK_KEY],
    );
    if (got.rows[0]?.locked !== true) return null;

    try {
      // Escalation first, then notification, and the order matters: an escalation appended
      // this tick moves the obligation to a new seat, and the notify pass reads state, so
      // that seat is told in the same tick rather than one interval later. A minute of
      // silence after an escalation is a minute nobody is moving.
      const escalation = await runEscalationPass(pool, targets === undefined ? {} : { targets });
      const notification = await runNotifyPass(pool, channel === undefined ? {} : { channel });
      return { escalation, notification };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [ESCALATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  const { pool } = options;
  const intervalMs = options.intervalMs ?? 15_000;

  let timer: NodeJS.Timeout | null = null;
  let running: Promise<unknown> | null = null;
  let stopped = false;

  async function tick(): Promise<PassOutcome | null> {
    try {
      const outcome = await runLockedPass(pool, options.targets, options.channel);
      if (outcome !== null) {
        options.onOutcome?.(outcome.escalation);
        options.onNotify?.(outcome.notification);
      }
      return outcome;
    } catch (err) {
      // A failed pass must never kill the scheduler. An escalation loop that stops after
      // one bad database moment is worse than no escalation loop, because everyone
      // believes it is still watching.
      options.onError?.(err);
      return null;
    }
  }

  return {
    start(): void {
      if (timer !== null || stopped) return;
      timer = setInterval(() => {
        // Skip a tick rather than overlap. A slow pass must not stack up behind itself.
        if (running !== null) return;
        running = tick().finally(() => {
          running = null;
        });
      }, intervalMs);
      // Do not hold the process open on this alone.
      timer.unref?.();
    },

    async stop(): Promise<void> {
      stopped = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      // Let an in-flight pass finish, so shutdown never leaves a half-written escalation.
      if (running !== null) await running.catch(() => undefined);
    },

    tick,
  };
}
