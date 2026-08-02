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
  reported: { reportId: Uuid; category: string; severity: Severity; placeId?: Uuid };
  triaged: { severity: Severity; category: string; reason?: string };
  routed: { departmentIds: readonly Uuid[]; ruleId: Uuid | 'manual'; reason?: string };
  notified: { attemptId: Uuid; seatId: Uuid; channel: SourceChannel };
  acknowledged: { seatId: Uuid };
  assigned: { resourceIds: readonly Uuid[] };
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
