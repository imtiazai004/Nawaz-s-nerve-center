/**
 * Who has to be told, and when not being told becomes a visible failure. INV-03.
 *
 * The invariant is one sentence — *a message that did not reach the duty officer surfaces
 * on the central board as an unmet obligation, not as a log line* — and everything here
 * exists to make that literally true rather than aspirationally true.
 *
 * Three states, never two. "Sent" is not "delivered", and a system that conflates them is
 * telling the control room an officer knows about an emergency when nobody has established
 * that. An attempt is `pending` until something settles it; pending for too long is itself
 * the failure, because an obligation nobody has picked up is indistinguishable from one
 * nobody was told about.
 *
 * **What this is not.** The channel is in-app only (Q-07 has not been answered, so which
 * channels actually work in Bannu is still unverified and this file does not pretend
 * otherwise). An officer who is not looking at the app is not reached. That is a real gap,
 * it is M3's to close, and the shape here — attempt, then outcome, per channel — is what
 * lets SMS or voice slot in without any of this changing.
 */

import type { IncidentState, NotificationAttempt } from './incident.js';
import type { NotifyReason, Uuid } from './events.js';

/**
 * How long an attempt may sit unacknowledged before it counts as an unmet obligation.
 *
 * Deliberately tighter than any SLA target: the point is to catch a notification that never
 * landed *before* the acknowledgement deadline it was supposed to prompt, not afterwards
 * when the escalation has already fired and the question is why nobody moved.
 */
export const UNDELIVERED_AFTER_MINUTES = 3;

export interface NotifyTarget {
  /** The seat acquiring — or losing — the obligation. */
  readonly seatId: Uuid | null;
  /** Resolved from the department when no seat is named directly. */
  readonly departmentId: Uuid | null;
  readonly reason: NotifyReason;
}

/**
 * The obligations an incident's current state implies, regardless of what has been sent.
 *
 * Derived from state rather than from "the last event", so a pass that crashes halfway
 * through simply produces the same answer next time. Idempotency comes from comparing this
 * against the attempts already in the log, not from a marker someone has to remember to
 * write — the same reasoning as the escalation ladder.
 */
export function obligationsFor(state: IncidentState): readonly NotifyTarget[] {
  const targets: NotifyTarget[] = [];

  // Whoever currently owns it has to know they own it. `routed` and `reassigned` are the
  // same obligation from the recipient's side, and the reason is recorded so the message
  // can differ even though the duty is identical.
  for (const departmentId of state.responsibleDepartmentIds) {
    targets.push({
      seatId: null,
      departmentId,
      reason: state.reassignedFrom.length > 0 ? 'reassigned' : 'routed',
    });
  }

  // The department it was taken away from is told too. A handover nobody announced is how
  // two departments each assume the other went (docs/04-authority-model.md).
  for (const departmentId of state.reassignedFrom) {
    if (state.responsibleDepartmentIds.includes(departmentId)) continue;
    targets.push({ seatId: null, departmentId, reason: 'lost_responsibility' });
  }

  // An escalation that nobody is told about is just a row in a table.
  if (state.currentEscalationSeatId !== null) {
    targets.push({
      seatId: state.currentEscalationSeatId,
      departmentId: null,
      reason: 'escalated',
    });
  }

  return targets;
}

/** An obligation is met once an attempt for that seat and reason exists in any state. */
/**
 * What makes two attempts the same obligation.
 *
 * A seat when there is one; the department when there is not. Without the second half, every
 * pass would record a fresh failure against a department that has no post — the notification
 * storm INV-08 exists to prevent, aimed at the one department least able to answer it.
 */
export function targetKey(target: {
  readonly seatId: Uuid | null;
  readonly departmentId?: Uuid | null;
}): string {
  return target.seatId ?? `department:${String(target.departmentId ?? 'unknown')}`;
}

/**
 * Has this exact rung already been tried for this obligation?
 *
 * **Per channel**, because the ladder is a sequence: WhatsApp having been tried and failed is
 * precisely the reason to try a voice call, and a check that ignored the channel would stop
 * the ladder at its first rung forever.
 */
export function alreadyAttempted(
  attempts: readonly NotificationAttempt[],
  target: { readonly seatId: Uuid | null; readonly departmentId?: Uuid | null },
  reason: NotifyReason,
  channel?: string,
): boolean {
  const key = targetKey(target);
  return attempts.some(
    (a) =>
      targetKey(a) === key &&
      a.reason === reason &&
      (channel === undefined || a.channel === channel),
  );
}

/**
 * Has anything already reached this person for this obligation?
 *
 * The ladder stops at the first success and **must not restart on the next pass**. Without
 * this, a notification delivered by WhatsApp at 02:00 would be followed by a voice call at
 * 02:00 and thirty seconds, because `voice` had never been attempted — a notification storm
 * aimed at somebody who is already awake and driving (INV-08).
 *
 * The in-app rung does not count. It settles only when the holder's client collects it, so
 * "pending in an inbox nobody has opened" is not somebody having been told, and the external
 * ladder must still run.
 */
export function externallyReached(
  attempts: readonly NotificationAttempt[],
  target: { readonly seatId: Uuid | null; readonly departmentId?: Uuid | null },
  reason: NotifyReason,
): boolean {
  const key = targetKey(target);
  return attempts.some(
    (a) =>
      targetKey(a) === key && a.reason === reason && a.channel !== 'web' && a.state === 'delivered',
  );
}

export interface UnmetObligation {
  readonly attempt: NotificationAttempt;
  readonly why: 'failed' | 'undelivered';
  readonly minutesWaiting: number;
}

/**
 * Attempts that have not reached anybody — the list the central board must never be able
 * to render as empty when it is not.
 *
 * A failure and a silence are reported as different things on purpose. "The post is vacant"
 * needs someone to fill a roster; "sent, never picked up" needs someone to pick up a phone.
 * Collapsing them into one number would leave the control room unable to tell which.
 */
export function unmetObligations(
  attempts: readonly NotificationAttempt[],
  now: string,
  afterMinutes = UNDELIVERED_AFTER_MINUTES,
): readonly UnmetObligation[] {
  const unmet: UnmetObligation[] = [];

  for (const attempt of attempts) {
    if (attempt.state === 'delivered') continue;

    const minutesWaiting = Math.max(
      0,
      (Date.parse(now) - Date.parse(attempt.attemptedAt)) / 60_000,
    );

    if (attempt.state === 'failed') {
      unmet.push({ attempt, why: 'failed', minutesWaiting });
      continue;
    }

    if (minutesWaiting >= afterMinutes) {
      unmet.push({ attempt, why: 'undelivered', minutesWaiting });
    }
  }

  return unmet;
}
