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
      // A placeholder holder is not a holder.
      //
      // Migration 0008 lets a post be filled with a stand-in contact so the roster is
      // complete and editable before the real number arrives. Counting one as reachable
      // would silence the vacant-post warning while changing nothing about whether anybody
      // is actually told — which is worse than the empty post it replaced, because the
      // screen would stop asking for the number.
      const res = await pool.query<{ real: string; placeholder: string }>(
        `SELECT count(*) FILTER (WHERE NOT p.placeholder)::text AS real,
                count(*) FILTER (WHERE p.placeholder)::text     AS placeholder
           FROM duty_assignment d
           JOIN person p ON p.person_id = d.person_id
          WHERE d.seat_id = $1 AND d.to_at IS NULL`,
        [target.seatId],
      );

      if (Number(res.rows[0]?.real ?? 0) > 0) return { ok: true };

      return {
        ok: false,
        failure:
          Number(res.rows[0]?.placeholder ?? 0) > 0
            ? 'placeholder_contact: this post holds a stand-in number, not a real one — nothing was sent'
            : 'no_duty_holder: nobody currently holds this seat, so nothing was sent',
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
  /** The in-app channel. Overridden by tests; never by configuration. */
  readonly channel?: NotificationChannel;
}

/**
 * One pass. Safe to call repeatedly and safe to call concurrently (see `scheduler.ts`).
 *
 * **One obligation, one channel: the in-app inbox.**
 *
 * There used to be a ladder here — WhatsApp, then a voice call, then SMS, then a modem in the
 * DC office — and it is gone, at the owner's instruction (ADR-0012 superseded, 2026-08-03).
 * The software sends nothing. It records what each post is owed, shows it in that post's
 * inbox, and an officer who needs to reach somebody presses **Reach them** and rings them.
 *
 * What this job still does is the part that matters and is not obvious: it writes the
 * obligation **before** anything is attempted, so a crash leaves a visibly pending duty rather
 * than nothing at all. "Delivered" means the seat holder's own client collected it — not that
 * a queue accepted it — which is why the in-app channel is the only one whose delivery ever
 * meant anything (INV-03).
 */
export async function runNotifyPass(
  pool: Pool,
  options: NotifyOptions = {},
): Promise<NotifyOutcome> {
  const now = options.now ?? new Date().toISOString();
  const limit = options.limit ?? 500;
  const inApp = options.channel ?? inAppChannel(pool);

  const ids = await candidates(pool, limit, options.incidentIds);

  let attempted = 0;
  let failed = 0;

  for (const incidentId of ids) {
    const events = await loadIncident(pool, incidentId);
    if (events.length === 0) continue;

    const state = foldIncident(incidentId, events);

    // A running sequence, not `state.eventCount + 1` per append.
    //
    // Two obligations on one incident used to produce two events with the same
    // `clientSeq`, and a ladder of five rungs would produce ten. Ordering then fell to the
    // event id, which is random — deterministic, and causally wrong, which is the exact
    // mistake ADR-0008 was written about.
    let seq = state.eventCount;
    const nextSeq = (): number => (seq += 1);

    for (const target of obligationsFor(state)) {
      const seatId =
        target.seatId ??
        (target.departmentId === null ? null : await dutySeatFor(pool, target.departmentId));

      // A department with no post at all is a configuration gap, and it is recorded **on
      // the incident** rather than only counted here.
      //
      // This used to `continue` after incrementing a counter, which meant the board showed
      // nothing: an emergency routed to a department with no posts looked notified. INV-03
      // says an unmet obligation surfaces on the board and not as a log line, and a number
      // in a job's return value is a log line.
      if (seatId === null && target.departmentId === null) continue;

      const key = { seatId, departmentId: target.departmentId };

      const record = async (attemptId: string, channelName: 'web'): Promise<void> => {
        // Recorded before anything is attempted. A crash between the two leaves a visibly
        // pending obligation rather than nothing at all — see the header.
        await append(pool, [
          {
            eventId: randomUUID(),
            incidentId,
            occurredAt: now,
            recordedAt: now,
            actorPersonId: null,
            actorSeatId: null,
            sourceChannel: 'system' as const,
            type: 'notified',
            clientSeq: nextSeq(),
            payload: {
              attemptId,
              seatId,
              ...(target.departmentId === null ? {} : { departmentId: target.departmentId }),
              channel: channelName,
              reason: target.reason,
            },
          } as unknown as IncidentEvent,
        ]);
        attempted += 1;
      };

      const settle = async (
        attemptId: string,
        channelName: 'web',
        result: { ok: true } | { ok: false; failure: string },
      ): Promise<void> => {
        await append(pool, [
          {
            eventId: randomUUID(),
            incidentId,
            occurredAt: now,
            recordedAt: now,
            actorPersonId: null,
            actorSeatId: null,
            sourceChannel: 'system' as const,
            type: result.ok ? 'notification_delivered' : 'notification_failed',
            clientSeq: nextSeq(),
            payload: {
              attemptId,
              seatId,
              channel: channelName,
              ...(result.ok ? {} : { failure: result.failure }),
            },
          } as unknown as IncidentEvent,
        ]);
        if (!result.ok) failed += 1;
      };

      //------------------------------------------------------------------
      // The inbox. Always, and never part of the ladder.
      //------------------------------------------------------------------

      if (!alreadyAttempted(state.notifications, key, target.reason, 'web')) {
        const attemptId = randomUUID();
        await record(attemptId, 'web');

        const result =
          seatId === null
            ? {
                ok: false as const,
                failure:
                  'no_post: this department has no post to notify — nobody can be told until one exists',
              }
            : await inApp
                .deliver({ seatId, incidentId, reason: target.reason })
                .catch((err: unknown) => ({
                  ok: false as const,
                  failure: `channel threw: ${String(err)}`,
                }));

        // On success nothing further is written **here**. The in-app attempt stays
        // `pending` until the seat holder's client actually collects it, because "we queued
        // it" is not "somebody knows". `POST /notifications/:attemptId/seen` settles it.
        if (!result.ok) await settle(attemptId, 'web', result);
      }
    }
  }

  return { scanned: ids.length, attempted, failed, truncated: ids.length >= limit };
}
