/**
 * Response deadlines and the timestamp problem. See ADR-0002 and
 * docs/02-connectivity-ladder.md.
 *
 * An incident reported at 14:02 during an outage may reach the server at 16:40. If SLA
 * logic uses receipt time, the response looks instantaneous and the metrics lie. If it
 * uses report time, a reconnect fires two hours of retroactive escalations at once.
 * Neither is acceptable, so the two uses are separated explicitly:
 *
 *   measurement      -> occurredAt   (tells the truth: this took 2h 41m)
 *   escalation firing -> recordedAt   (one labelled late-arrival alert, not a storm)
 *
 * The gap between them is not noise to be smoothed away. It is the district's real
 * connectivity picture, and it is what the DC needs to see.
 */

import type { Instant, Severity } from './events.js';

export const MINUTE_MS = 60_000;

/** Acknowledgement deadlines per severity, in minutes. Placeholders until Q-06 is answered. */
export type SlaTargets = Readonly<Record<Severity, number>>;

export const PLACEHOLDER_SLA: SlaTargets = {
  critical: 5,
  high: 15,
  moderate: 60,
  low: 240,
};

/**
 * Grace applied to escalation firing after a late arrival, so a two-hour outage produces
 * one alert per incident rather than a retroactive cascade (INV-08).
 */
export const LATE_ARRIVAL_GRACE_MINUTES = 10;

/** Beyond this, an incident is tagged as late-arriving and surfaced to the control room. */
export const LATE_ARRIVAL_THRESHOLD_MINUTES = 15;

function ms(a: Instant, b: Instant): number {
  return Date.parse(b) - Date.parse(a);
}

export function minutesBetween(a: Instant, b: Instant): number {
  return ms(a, b) / MINUTE_MS;
}

/** How long the district actually took. Always measured from when it happened. */
export function responseMinutes(occurredAt: Instant, acknowledgedAt: Instant): number {
  return minutesBetween(occurredAt, acknowledgedAt);
}

/** How long the report spent unseen by the server. The connectivity signal. */
export function arrivalGapMinutes(occurredAt: Instant, recordedAt: Instant): number {
  return Math.max(0, minutesBetween(occurredAt, recordedAt));
}

export function isLateArrival(occurredAt: Instant, recordedAt: Instant): boolean {
  return arrivalGapMinutes(occurredAt, recordedAt) > LATE_ARRIVAL_THRESHOLD_MINUTES;
}

export interface EscalationCheck {
  readonly severity: Severity;
  readonly occurredAt: Instant;
  readonly recordedAt: Instant;
  readonly acknowledgedAt: Instant | null;
  readonly now: Instant;
}

export interface EscalationVerdict {
  readonly shouldEscalate: boolean;
  /** True when the deadline was already past on arrival — label it, do not storm. */
  readonly lateArrival: boolean;
  /** Minutes past the acknowledgement deadline, measured honestly from occurredAt. */
  readonly overdueByMinutes: number;
  readonly reason: string;
}

/**
 * Decide whether an unacknowledged incident should escalate now.
 *
 * This runs on the server, from a durable job queue — never on a client. A closed laptop
 * must not stop an escalation (INV-07).
 */
export function checkEscalation(
  check: EscalationCheck,
  targets: SlaTargets = PLACEHOLDER_SLA,
): EscalationVerdict {
  const target = targets[check.severity];
  const deadlineFromOccurrence = minutesBetween(check.occurredAt, check.now) - target;

  if (check.acknowledgedAt !== null) {
    return {
      shouldEscalate: false,
      lateArrival: false,
      overdueByMinutes: Math.max(0, deadlineFromOccurrence),
      reason: 'acknowledged',
    };
  }

  const gap = arrivalGapMinutes(check.occurredAt, check.recordedAt);
  const lateArrival = gap > target;

  // Escalation is timed from when we could first have acted on it, plus grace. Anything
  // else punishes the district for a network outage it did not cause and cannot fix.
  const clockStart = lateArrival ? check.recordedAt : check.occurredAt;
  const allowance = lateArrival ? LATE_ARRIVAL_GRACE_MINUTES : target;
  const elapsed = minutesBetween(clockStart, check.now);

  return {
    shouldEscalate: elapsed >= allowance,
    lateArrival,
    overdueByMinutes: Math.max(0, deadlineFromOccurrence),
    reason: lateArrival
      ? `arrived ${Math.round(gap)}m after it happened; grace window ${LATE_ARRIVAL_GRACE_MINUTES}m`
      : `unacknowledged past ${target}m target`,
  };
}
