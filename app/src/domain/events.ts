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

export type Severity = 'low' | 'moderate' | 'high' | 'critical';

/** Ordered worst-last so aggregation can take a max and never hide a critical (INV-04). */
export const SEVERITY_ORDER: readonly Severity[] = ['low', 'moderate', 'high', 'critical'];

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

export function severityRank(s: Severity): number {
  return SEVERITY_ORDER.indexOf(s);
}

/** Max-severity semantics. An average could hide a critical; a max cannot (INV-04). */
export function worstSeverity(severities: readonly Severity[]): Severity | null {
  let worst: Severity | null = null;
  for (const s of severities) {
    if (worst === null || severityRank(s) > severityRank(worst)) worst = s;
  }
  return worst;
}
