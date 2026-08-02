/**
 * The event catalog. See docs/03-data-model.md and ADR-0001.
 *
 * Events are immutable and append-only. There is no update and no delete: a mistake is
 * corrected by a new event, never by editing an old one. An incident's state is the fold
 * of its events (see incident.ts), which is why the audit trail cannot drift from the
 * data — it IS the data.
 */

export type Uuid = string;

/** ISO-8601 instant. */
export type Instant = string;

/** A severity somebody actually assessed. */
export type AssessedSeverity = 'low' | 'moderate' | 'high' | 'critical';

/**
 * `unknown` is the absence of an assessment, not a fifth level. See ADR-0009.
 *
 * Intake cannot refuse a report (INV-01), so it must store something when nobody stated a
 * severity. It records `unknown` rather than guessing a level, because on a screen a guess
 * is indistinguishable from a judgement — and a value the system invented, rendered as a
 * fact someone established, is the failure this project exists not to build.
 */
export type Severity = AssessedSeverity | 'unknown';

/**
 * Ordered worst-last so aggregation can take a max and never hide a critical (INV-04).
 *
 * `unknown` is deliberately absent. It has no rank, because a rank is precisely what it
 * does not have — see `worstSeverity`, which counts it instead of ranking it.
 */
export const SEVERITY_ORDER: readonly AssessedSeverity[] = ['low', 'moderate', 'high', 'critical'];

export function isAssessed(s: Severity): s is AssessedSeverity {
  return s !== 'unknown';
}

export type SourceChannel = 'web' | 'mobile' | 'sms' | 'call' | 'radio' | 'walk_in' | 'system';

export type EscalationTrigger = 'sla_breach' | 'manual' | 'severity' | 'no_duty_holder';

/**
 * Why someone is being told. Every one of these is an obligation arriving at a seat.
 *
 * `lost_responsibility` is the odd one and the reason this is an enum rather than a
 * boolean: the department a reassignment takes an incident *away from* has to be told too
 * (`visible_to_owner: yes_and_notify` in docs/04-authority-model.md). A handover nobody
 * announced is how two departments each assume the other went.
 */
export type NotifyReason = 'routed' | 'reassigned' | 'lost_responsibility' | 'escalated';

/**
 * Carried by every event without exception.
 *
 * `occurredAt` is when it happened, per the actor's device. `recordedAt` is when the
 * server first accepted it. They diverge whenever a client was offline, and the gap is
 * operationally meaningful — see ADR-0002 and docs/02-connectivity-ladder.md.
 *
 * `eventId` is generated on the client and is the idempotency key: replaying an event is
 * a no-op, which is what makes offline sync safe (INV-08).
 *
 * `actorSeatId` records the seat held *at that moment*, so a later transfer never
 * rewrites history (ADR-0004).
 */
export interface EventEnvelope {
  readonly eventId: Uuid;
  readonly incidentId: Uuid;
  readonly occurredAt: Instant;
  readonly recordedAt: Instant;
  /**
   * The client's own ordering of events it created, monotonic per incident.
   *
   * Timestamps are not enough. A batch created offline shares a millisecond, and
   * `recorded_at` is identical across one server transaction — so without this, ordering
   * falls to a random id and `triaged` can fold after `overridden`. Determinism was never
   * the hard part; causality is. See migration 0002.
   */
  readonly clientSeq: number;
  readonly actorPersonId: Uuid | null;
  readonly actorSeatId: Uuid | null;
  readonly sourceChannel: SourceChannel;
}

interface Payloads {
  reported: {
    reportId: Uuid;
    category: string;
    severity: Severity;
    placeId?: Uuid;
    /** The reporter's own words. Routing keyword signals search this (ADR-0010). */
    description?: string;
    /**
     * Fields intake supplied because the caller did not (INV-01).
     *
     * Recorded so a downstream consumer can tell an assessment from a placeholder — which
     * `domain/routing.ts` depends on, and ADR-0009 depends on for severity.
     */
    assumed?: readonly string[];
  };
  triaged: { severity: Severity; category: string; reason?: string };
  /**
   * Where this incident went — **including nowhere**.
   *
   * `departmentIds` may be empty, and that is a fact worth recording rather than an absence
   * to be inferred. It says routing ran at this time, against these signals, and matched
   * nothing. The alternative — no event at all — is indistinguishable from "the routing pass
   * has not happened yet", and ADR-0005 does not allow a system to be quiet about that.
   *
   * `ruleId` is `'manual'` when a human chose, `'auto'` when the signals did. `signalIds`
   * names the signals that matched, so a wrong route leads back to the rule that caused it.
   */
  routed: {
    departmentIds: readonly Uuid[];
    ruleId: Uuid | 'manual' | 'auto';
    signalIds?: readonly Uuid[];
    reason?: string;
  };
  /**
   * A notification was **attempted**. Not "sent", and certainly not "received".
   *
   * Recorded before delivery is tried, so a crash between the two leaves a visibly pending
   * obligation rather than nothing at all. INV-03 turns on this trio staying three separate
   * facts: an attempt, and then either a delivery or a failure. Collapsing them into a
   * boolean on the incident is the failure the invariant names.
   */
  notified: {
    attemptId: Uuid;
    /**
     * The seat that was to be told, or **null when the department has no post at all**.
     *
     * A null seat is not a missing field, it is the failure itself: an obligation to a
     * department that has nobody in it. It used to be recorded as a counter in the job's
     * return value and nowhere on the incident, which is exactly the "log line" INV-03
     * forbids — the board showed nothing, so the emergency looked notified. Now the attempt
     * exists, fails, and is counted like any other unmet obligation.
     */
    seatId: Uuid | null;
    /** Set when the obligation was to a department rather than to a named seat. */
    departmentId?: Uuid;
    channel: SourceChannel;
    reason: NotifyReason;
  };
  notification_delivered: { attemptId: Uuid; seatId: Uuid | null; channel: SourceChannel };
  notification_failed: {
    attemptId: Uuid;
    seatId: Uuid | null;
    channel: SourceChannel;
    failure: string;
  };
  acknowledged: { seatId: Uuid };
  /** Units committed to this incident: vehicles, teams, equipment (M1-02). */
  assigned: { resourceIds: readonly Uuid[] };
  /**
   * Units stood down from this incident.
   *
   * Necessary because `assigned` only ever adds. Without it a vehicle stays committed to
   * every incident it ever attended until each of those is closed, so "what can Rescue send
   * right now" degrades over a shift into a list of things that all look busy — and the
   * answer an operator gets at 02:00 is wrong in the direction that stops help going out.
   *
   * A reason is required. Standing a unit down mid-incident is a decision somebody will be
   * asked about afterwards (INV-06).
   */
  released: { resourceIds: readonly Uuid[]; reason: string };
  action_logged: { note: string; evidenceIds?: readonly Uuid[] };
  escalated: { fromSeatId: Uuid | null; toSeatId: Uuid; trigger: EscalationTrigger };
  reassigned: {
    fromDepartmentIds: readonly Uuid[];
    toDepartmentIds: readonly Uuid[];
    reason: string;
  };
  overridden: { field: string; value: string; reason: string };
  merged: { absorbedIncidentId: Uuid; reason: string };
  unmerged: { restoredIncidentId: Uuid; reason: string };
  resolved: { outcome: string; evidenceIds?: readonly Uuid[] };
  closed: { notes: string; evidenceIds?: readonly Uuid[] };
  reopened: { reason: string };
  late_arrival_flagged: { gapMinutes: number };
}

export type EventType = keyof Payloads;

/** A single immutable fact about an incident. */
export type IncidentEvent = {
  [T in EventType]: EventEnvelope & { readonly type: T; readonly payload: Payloads[T] };
}[EventType];

/** Events whose payload must carry a non-empty reason (INV-06). */
export const REASON_REQUIRED: ReadonlySet<EventType> = new Set<EventType>([
  'reassigned',
  'overridden',
  'merged',
  'unmerged',
  'reopened',
  'released',
]);

export function severityRank(s: AssessedSeverity): number {
  return SEVERITY_ORDER.indexOf(s);
}

export interface SeveritySummary {
  /** The worst severity anyone actually assessed, or null if nobody has. */
  readonly worst: AssessedSeverity | null;
  /** How many are waiting on an assessment. Never folded into `worst`. */
  readonly unassessed: number;
}

/**
 * Max-severity semantics, plus a count of what has not been assessed at all.
 *
 * Two numbers, never one, and that is the whole design (ADR-0009). An average could hide a
 * critical; a max cannot (INV-04) — but a max over a set containing unassessed reports has
 * to do something with them, and both available answers are lies. Counting them as `low`
 * hides them. Counting them as `critical` drowns the real ones and the aggregate stops
 * meaning anything within a week.
 *
 * So they are counted separately and rendered separately: *3 critical · 2 unassessed*.
 */
export function worstSeverity(severities: readonly Severity[]): SeveritySummary {
  let worst: AssessedSeverity | null = null;
  let unassessed = 0;

  for (const s of severities) {
    if (!isAssessed(s)) {
      unassessed += 1;
      continue;
    }
    if (worst === null || severityRank(s) > severityRank(worst)) worst = s;
  }

  return { worst, unassessed };
}
