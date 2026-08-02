/**
 * The notification pass — M0-32, INV-03.
 *
 * `domain/notifications.ts` knows who is owed a message. This is the thing that actually
 * tries, and — far more importantly — the thing that records what happened when it did.
 *
 * The order of operations is the whole design:
 *
 *   1. work out who is owed a notification, from **state**, not from the last event
 *   2. append `notified` *before* attempting anything
 *   3. attempt delivery
 *   4. append `notification_delivered` or `notification_failed`
 *
 * Step 2 looks redundant and is not. A crash between 2 and 4 leaves a **pending** attempt,
 * which the board shows as an unmet obligation — the correct answer, because we genuinely
 * do not know whether anyone was told. Attempting first and recording afterwards would
 * leave nothing at all, and INV-03 would be violated by a process dying quietly.
 *
 * Idempotency comes from comparing obligations against attempts already in the log, the
 * same way escalation compares against the ladder. No marker anyone has to remember to set.
 */

import { randomUUID } from 'node:crypto';

import { append, loadIncident } from '../db/eventStore.js';
import type { Pool } from '../db/pool.js';
import { foldIncident } from '../domain/incident.js';
import { alreadyAttempted, obligationsFor } from '../domain/notifications.js';
import type { IncidentEvent, NotifyReason, Uuid } from '../domain/events.js';

const LOOKBACK_DAYS = 7;

/**
 * A way of reaching a seat.
 *
 * One method, and it returns a **reason** on failure rather than throwing, because "why did
 * this not arrive" is the question the control room will ask and an exception message is
 * not an answer anyone can act on.
 *
 * The interface exists so SMS and voice (M3, blocked on Q-07) slot in without touching the
 * ledger around them. Do not let a channel decide whether an attempt is worth recording —
 * that decision belongs to the caller, and a channel that skipped the record is exactly how
 * a failure becomes invisible.
 */
export interface NotificationChannel {
  readonly name: 'web' | 'sms' | 'call';
  deliver(target: {
    readonly seatId: Uuid;
    readonly incidentId: Uuid;
    readonly reason: NotifyReason;
  }): Promise<{ readonly ok: true } | { readonly ok: false; readonly failure: string }>;
}

/**
 * In-app delivery: the message waits in the seat holder's inbox until they fetch it.
 *
 * **Delivery means the holder's client actually collected it**, which is why this channel
 * does not report success here — it reports only whether there is anybody to collect it.
 * A message queued for a vacant post has not been delivered to anyone, and saying otherwise
 * would be the exact lie INV-03 exists to prevent (and the same failure a vacant post
 * causes in escalation: ADR-0004, a post with nobody in it must never swallow an
 * obligation).
 *
 * The inbox itself is not a table. It is a query over the event log — attempts for my seat
 * with no outcome yet — so there is no second store to fall out of step with the record.
 */
export function inAppChannel(pool: Pool): NotificationChannel {
  return {
    name: 'web',
    async deliver(target) {
      const res = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM duty_assignment
          WHERE seat_id = $1 AND to_at IS NULL`,
        [target.seatId],
      );

      return Number(res.rows[0]?.n ?? 0) > 0
        ? { ok: true }
        : {
            ok: false,
            failure: 'no_duty_holder: nobody currently holds this seat, so nothing was sent',
          };
    },
  };
}

export interface NotifyOutcome {
  readonly scanned: number;
  readonly attempted: number;
  /** Attempts that failed outright — a vacant post, a dead gateway. Needs a human. */
  readonly failed: number;
  readonly truncated: boolean;
}

/** Incidents recent enough to still be worth notifying anyone about. */
async function candidates(
  pool: Pool,
  limit: number,
  only?: readonly string[],
): Promise<readonly string[]> {
  const res = await pool.query<{ incident_id: string }>(
    `SELECT e.incident_id, MIN(e.recorded_at) AS first_seen
       FROM incident_event e
      WHERE e.recorded_at > now() - make_interval(days => $1)
        AND ($3::uuid[] IS NULL OR e.incident_id = ANY($3::uuid[]))
        AND NOT EXISTS (
              SELECT 1 FROM incident_event x
               WHERE x.incident_id = e.incident_id
                 AND x.type = 'closed'
            )
      GROUP BY e.incident_id
      ORDER BY first_seen ASC
      LIMIT $2`,
    [LOOKBACK_DAYS, limit, only ?? null],
  );
  return res.rows.map((r) => r.incident_id);
}

/** The seat currently holding a department's duty. Null when the department has no seat. */
async function dutySeatFor(pool: Pool, departmentId: Uuid): Promise<Uuid | null> {
  const res = await pool.query<{ seat_id: string }>(
    `SELECT s.seat_id
       FROM seat s
      WHERE s.department_id = $1
      ORDER BY EXISTS (
                 SELECT 1 FROM duty_assignment d
                  WHERE d.seat_id = s.seat_id AND d.to_at IS NULL
               ) DESC,
               s.tier ASC
      LIMIT 1`,
    [departmentId],
  );
  return res.rows[0]?.seat_id ?? null;
}

export interface NotifyOptions {
  readonly now?: string;
  readonly limit?: number;
  readonly incidentIds?: readonly string[];
  readonly channel?: NotificationChannel;
}

/**
 * One pass. Safe to call repeatedly and safe to call concurrently (see `scheduler.ts`).
 */
export async function runNotifyPass(
  pool: Pool,
  options: NotifyOptions = {},
): Promise<NotifyOutcome> {
  const now = options.now ?? new Date().toISOString();
  const limit = options.limit ?? 500;
  const channel = options.channel ?? inAppChannel(pool);

  const ids = await candidates(pool, limit, options.incidentIds);

  let attempted = 0;
  let failed = 0;

  for (const incidentId of ids) {
    const events = await loadIncident(pool, incidentId);
    if (events.length === 0) continue;

    const state = foldIncident(incidentId, events);

    for (const target of obligationsFor(state)) {
      const seatId =
        target.seatId ??
        (target.departmentId === null ? null : await dutySeatFor(pool, target.departmentId));

      if (seatId === null) {
        // A department with no seat at all cannot be notified, and that is a configuration
        // problem somebody has to fix rather than something to skip quietly. There is no
        // attempt to record against a seat that does not exist, so it surfaces through the
        // pass outcome instead.
        failed += 1;
        continue;
      }

      if (alreadyAttempted(state.notifications, seatId, target.reason)) continue;

      const attemptId = randomUUID();
      const base = {
        incidentId,
        occurredAt: now,
        recordedAt: now,
        actorPersonId: null,
        actorSeatId: null,
        sourceChannel: 'system' as const,
      };

      // Recorded before anything is attempted. See the header.
      await append(pool, [
        {
          ...base,
          eventId: randomUUID(),
          type: 'notified',
          clientSeq: state.eventCount + 1,
          payload: { attemptId, seatId, channel: channel.name, reason: target.reason },
        } as unknown as IncidentEvent,
      ]);
      attempted += 1;

      const result = await channel
        .deliver({ seatId, incidentId, reason: target.reason })
        .catch((err: unknown) => ({
          ok: false as const,
          failure: `channel threw: ${String(err)}`,
        }));

      if (!result.ok) {
        failed += 1;
        await append(pool, [
          {
            ...base,
            eventId: randomUUID(),
            type: 'notification_failed',
            clientSeq: state.eventCount + 2,
            payload: { attemptId, seatId, channel: channel.name, failure: result.failure },
          } as unknown as IncidentEvent,
        ]);
      }

      // On success nothing further is written **here**. The attempt stays `pending` until
      // the seat holder's client actually collects it, because "we queued it" is not
      // "somebody knows". `POST /notifications/:attemptId/seen` is what settles it, and
      // until then the board carries it as an unmet obligation.
    }
  }

  return { scanned: ids.length, attempted, failed, truncated: ids.length >= limit };
}
