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

/** Acknowledgement deadlines per severity, in minutes. */
export type SlaTargets = Readonly<Record<Severity, number>>;

/**
 * The values a fresh install starts from — **not** the district's rule.
 *
 * Q-06 asked what Bannu's real acknowledgement targets are; the owner's answer was that the
 * DC and AC Headquarter offices set them inside the software. Migration 0007 seeds these
 * five numbers into `sla_target` so nothing changes behaviour on the day it runs, and from
 * that point the database is the authority. Everything that reads a deadline should be
 * reading configuration, not this constant.
 *
 * It survives for two honest uses: the seed, and the fallback when configuration cannot be
 * read at all. A board that refuses to draw because it could not load a settings table is
 * worse than a board drawn against last week's defaults, provided it is drawn once and not
 * relied on quietly — which is why `loadSlaConfiguration` failing is logged loudly.
 */
export const PLACEHOLDER_SLA: SlaTargets = {
  critical: 5,
  high: 15,
  moderate: 60,
  low: 240,
  /**
   * `unknown` is not a level (ADR-0009), but it still needs a deadline — and a tight one.
   *
   * An unassessed report must reach a human quickly; that is exactly why intake used to
   * guess `high`. It now expresses that urgency **here**, through the deadline, instead of
   * through a severity value that would lie on a screen. Same effect on escalation, no
   * false claim about what anyone assessed.
   */
  unknown: 15,
};

/**
 * The whole district's deadlines: a default per severity, plus whatever departments have
 * overridden. Mirrors the `sla_target` table; see `db/configStore.ts` for the loader.
 */
export interface SlaConfig {
  readonly district: SlaTargets;
  readonly byDepartment: Readonly<Record<string, Partial<Record<Severity, number>>>>;
}

/**
 * The deadlines that apply to an incident, given who is responsible for it.
 *
 * Two steps, and they are different operations — conflating them was a real bug caught by
 * the M1a tests, where a department given a *longer* deadline than the district silently
 * kept the district's shorter one.
 *
 * 1. **Per department, an override replaces the default.** If the district says 240 minutes
 *    for `low` and a department is set to 999, that department's answer is 999. An override
 *    that only ever tightens is not an override; it is a floor, and nobody asked for a
 *    floor. The administration set 999 deliberately and the screen must say 999.
 *
 * 2. **Across departments, the tightest wins.** If Rescue must acknowledge a critical in 5
 *    minutes and Police in 15, the incident is late at 5 — at that moment one of the two
 *    responsible departments is genuinely late, and showing "on time" would be reporting the
 *    more comfortable of two true statements. Same principle as the severity aggregate:
 *    never let one row's good news hide another's bad.
 *
 * An unrouted incident falls to the district default, which is correct — nobody has a
 * department deadline until somebody has the incident.
 */
export function targetsFor(config: SlaConfig, departmentIds: readonly string[]): SlaTargets {
  if (departmentIds.length === 0) return config.district;

  let merged: Record<string, number> | null = null;

  for (const id of departmentIds) {
    // Step 1: this department's own view of the deadlines.
    const effective: Record<string, number> = { ...config.district, ...config.byDepartment[id] };

    if (merged === null) {
      merged = effective;
      continue;
    }

    // Step 2: the strictest obligation among the departments that hold it.
    for (const [severity, minutes] of Object.entries(effective)) {
      const current = merged[severity];
      if (current === undefined || minutes < current) merged[severity] = minutes;
    }
  }

  return (merged ?? config.district) as unknown as SlaTargets;
}

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
