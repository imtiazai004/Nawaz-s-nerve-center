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
import { alreadyAttempted, externallyReached, obligationsFor } from '../domain/notifications.js';
import {
  canAttempt,
  ladderForNotification,
  type LadderChannel,
  type LadderConfig,
  type NotifyChannel,
} from '../domain/channels.js';
import {
  buildProviders,
  renderMessage,
  templateFor,
  type ProviderSet,
} from '../channels/providers.js';
import { incidentSummary, loadLadder, recipientFor } from '../db/channelStore.js';
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
  /** WhatsApp, voice, SMS, GSM. Defaults to whatever the environment has configured. */
  readonly providers?: ProviderSet;
  readonly ladder?: LadderConfig;
  /**
   * Send this one a particular way, instead of walking the configured ladder.
   *
   * The owner asked for it directly — *the user should be able to choose to route a
   * notification to another channel when they need to*. It replaces the ladder rather than
   * prepending to it: "send this by SMS" means SMS, not SMS after two minutes of WhatsApp.
   */
  readonly only?: readonly LadderChannel[];
}

/**
 * One pass. Safe to call repeatedly and safe to call concurrently (see `scheduler.ts`).
 *
 * The shape of one obligation, since M3-01:
 *
 *   1. **The in-app inbox, always.** Not a rung — it costs nothing and it is the only channel
 *      whose "delivered" means a human actually collected the message.
 *   2. **The ladder, in order**, until one rung succeeds (ADR-0012). Every rung tried is its
 *      own recorded attempt with its own outcome, because "WhatsApp failed, the call got
 *      through" and "we notified them" are different facts and only the first one is useful
 *      at 03:00.
 *
 * The ladder does not restart once something has reached them. Without that check a message
 * delivered by WhatsApp would be followed thirty seconds later by a phone call, because the
 * voice rung had never been attempted — a storm aimed at somebody already driving (INV-08).
 */
export async function runNotifyPass(
  pool: Pool,
  options: NotifyOptions = {},
): Promise<NotifyOutcome> {
  const now = options.now ?? new Date().toISOString();
  const limit = options.limit ?? 500;
  const inApp = options.channel ?? inAppChannel(pool);
  const providers = options.providers ?? buildProviders(process.env);
  const ladder = options.ladder ?? (await loadLadder(pool));

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

    let summary: { departmentName: string | null } | null = null;

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

      const record = async (attemptId: string, channelName: NotifyChannel): Promise<void> => {
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
        channelName: NotifyChannel,
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

      //------------------------------------------------------------------
      // The ladder (ADR-0012)
      //------------------------------------------------------------------

      if (seatId === null) continue;
      if (externallyReached(state.notifications, key, target.reason)) continue;

      const recipient = await recipientFor(pool, seatId);
      summary ??= await incidentSummary(pool, incidentId);

      const body = renderMessage({
        incidentId,
        category: state.category?.value ?? 'emergency',
        severity: state.severity?.value ?? 'unknown',
        departmentName: summary.departmentName,
        reason: target.reason,
        occurredAt: state.occurredAt,
      });

      for (const rung of ladderForNotification(ladder, seatId, options.only)) {
        if (alreadyAttempted(state.notifications, key, target.reason, rung)) continue;

        /**
         * A rung with no account behind it is **skipped, not failed**.
         *
         * This is the one place where "record every failure" is the wrong instinct. Until
         * R-05 there are no providers, so recording each rung would put five
         * `not_configured` failures on every obligation of every incident in the district —
         * a board permanently reading "nobody reached" for a reason that is a purchase order,
         * not an emergency. The reliable outcome of that is a control room that stops reading
         * the number.
         *
         * INV-03 is still kept, and by the right thing: the in-app attempt above stays
         * `pending` until a human collects it, so the obligation is visibly unmet on the
         * board either way. What changes is *where* "the district has no way to phone
         * anybody" is reported — once, at district level, in the configuration sweep and on
         * the console, which is where somebody can actually do something about it.
         */
        if (!providers.byChannel[rung].configured) continue;

        const attemptId = randomUUID();
        await record(attemptId, rung);

        // Checked before the provider is called, so the recorded failure names something an
        // administrator can act on — "this post holds a stand-in number" rather than
        // whatever a gateway returns when handed nonsense.
        const verdict = canAttempt(rung, recipient);
        const result = verdict.canSend
          ? await providers.byChannel[rung]
              .send({ recipient, incidentId, body, template: templateFor(target.reason) })
              .catch((err: unknown) => ({
                ok: false as const,
                failure: `provider threw: ${String(err)}`,
              }))
          : { ok: false as const, failure: verdict.failure };

        await settle(attemptId, rung, result);

        // First success wins. Trying the rest would be telling somebody the same thing
        // three ways, which is how a district learns to ignore the second and third.
        if (result.ok) break;
      }
    }
  }

  return { scanned: ids.length, attempted, failed, truncated: ids.length >= limit };
}
