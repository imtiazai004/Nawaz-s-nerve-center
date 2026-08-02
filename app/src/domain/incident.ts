/**
 * The fold: events -> current state. See ADR-0001.
 *
 * `Incident` has no mutable status column anywhere in this system. Its state is computed
 * from its events every time. That is what makes the audit trail incapable of disagreeing
 * with the data, and it is what makes offline replay and central override fall out of one
 * mechanism instead of three.
 */

import type { Instant, IncidentEvent, Severity, SeveritySummary, Uuid } from './events.js';
import { worstSeverity } from './events.js';

export type IncidentStatus =
  'reported' | 'triaged' | 'routed' | 'acknowledged' | 'responding' | 'resolved' | 'closed';

export interface Actor {
  readonly personId: Uuid | null;
  readonly seatId: Uuid | null;
}

/**
 * A value plus the answer to "who set this, when, and was it overridden?".
 *
 * ADR-0003: an override never erases what the department entered. Both are carried, so
 * nobody can be blamed for a figure they did not enter, and the UI can always show the
 * department's own assessment alongside the district's correction.
 */
export interface Provenanced<T> {
  readonly value: T;
  readonly setBy: Actor;
  readonly setAt: Instant;
  readonly overriddenFrom?: {
    readonly value: T;
    readonly setBy: Actor;
    readonly setAt: Instant;
    readonly reason: string;
    readonly overriddenBy: Actor;
    readonly overriddenAt: Instant;
  };
}

export interface ResponseAction {
  readonly at: Instant;
  readonly by: Actor;
  readonly note: string;
}

/**
 * One notification attempt and what became of it.
 *
 * Kept as a list on the incident, never reduced to `notified: true` — that reduction is
 * precisely what INV-03 forbids, because it is the step that makes a failure invisible.
 */
export interface NotificationAttempt {
  readonly attemptId: Uuid;
  /** Null when the obligation was to a department with no post to notify. See INV-03. */
  readonly seatId: Uuid | null;
  /** Present when the obligation was to a department rather than a named seat. */
  readonly departmentId?: Uuid;
  readonly channel: string;
  readonly reason: string;
  readonly attemptedAt: Instant;
  readonly state: 'pending' | 'delivered' | 'failed';
  /** Why it failed. Present only when `state` is `failed`. */
  readonly failure?: string;
  readonly settledAt?: Instant;
}

export interface IncidentState {
  readonly incidentId: Uuid;
  readonly status: IncidentStatus;
  readonly severity: Provenanced<Severity> | null;
  readonly category: Provenanced<string> | null;
  readonly responsibleDepartmentIds: readonly Uuid[];
  /**
   * When routing last ran, or null if it never has.
   *
   * The distinction this exists for: **nobody has looked yet** and **we looked and found
   * nobody** are different emergencies. Both leave `responsibleDepartmentIds` empty, and
   * only the second one is a configuration gap the administration can close. Without this
   * they are the same row on a screen (ADR-0005).
   */
  readonly routingAttemptedAt: Instant | null;
  /** Routing ran and matched no department. Needs a human to assign it (ADR-0010). */
  readonly unassigned: boolean;
  /**
   * Departments that held this and no longer do.
   *
   * Kept because a handover has two sides. The department losing an incident has to be told
   * it is no longer theirs, and without this the projection cannot say who that was.
   */
  readonly reassignedFrom: readonly Uuid[];
  readonly reportIds: readonly Uuid[];
  readonly acknowledgedAt: Instant | null;
  readonly acknowledgedBySeatId: Uuid | null;
  readonly escalationCount: number;
  readonly currentEscalationSeatId: Uuid | null;
  readonly assignedResourceIds: readonly Uuid[];
  readonly actions: readonly ResponseAction[];
  /** Every attempt, in order, with its outcome. Never collapsed to a boolean (INV-03). */
  readonly notifications: readonly NotificationAttempt[];
  readonly mergedIncidentIds: readonly Uuid[];
  readonly resolution: string | null;
  readonly closureNotes: string | null;
  readonly reopenCount: number;
  /** First `occurredAt` seen — when the emergency actually happened, per the reporter. */
  readonly occurredAt: Instant | null;
  /** Latest `recordedAt` seen — how current this projection is. */
  readonly lastRecordedAt: Instant | null;
  readonly eventCount: number;
}

/**
 * Causal order: when it happened, then the client's own sequence, then when we learned of
 * it, then the id as a last resort.
 *
 * `clientSeq` carries the weight. An earlier version ordered by timestamps and fell back
 * to `eventId`, which is a random uuid — and an integration test caught the consequence: a
 * batch of events created in the same millisecond, stored in one transaction with an
 * identical `recordedAt`, folded in random order. `triaged` landed after `overridden` and
 * silently discarded a district override.
 *
 * That version was deterministic. It was also wrong. Determinism was never the hard part.
 */
export function compareEvents(a: IncidentEvent, b: IncidentEvent): number {
  if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? -1 : 1;
  if (a.clientSeq !== b.clientSeq) return a.clientSeq < b.clientSeq ? -1 : 1;
  if (a.recordedAt !== b.recordedAt) return a.recordedAt < b.recordedAt ? -1 : 1;
  if (a.eventId !== b.eventId) return a.eventId < b.eventId ? -1 : 1;
  return 0;
}

export interface FoldOptions {
  /**
   * Reconstruct a past state.
   *
   * `knownAt` answers "what did the control room see at 14:20?" — it filters on
   * `recordedAt`, so events that had not yet synced are correctly absent.
   *
   * `happenedBy` answers "what was actually true at 14:20?" — it filters on `occurredAt`,
   * including events that only reached the server hours later.
   *
   * These give different answers during an outage, and both questions get asked after a
   * serious incident. Neither is the "right" one, so the caller must choose.
   */
  readonly knownAt?: Instant;
  readonly happenedBy?: Instant;
}

const EMPTY_ACTOR: Actor = { personId: null, seatId: null };

function actorOf(e: IncidentEvent): Actor {
  return { personId: e.actorPersonId, seatId: e.actorSeatId };
}

/**
 * Replace a value while keeping what it replaced.
 *
 * The immediately previous value is carried in `overriddenFrom` so the UI can always show
 * both without a second query. The complete chain, if an override is itself overridden,
 * remains in the event log — which is the record. This is the projection.
 */
function withOverride<T>(
  prev: Provenanced<T> | null,
  value: T,
  reason: string,
  by: Actor,
  at: Instant,
): Provenanced<T> {
  if (prev === null) return { value, setBy: by, setAt: at };
  return {
    value,
    setBy: by,
    setAt: at,
    overriddenFrom: {
      value: prev.value,
      setBy: prev.setBy,
      setAt: prev.setAt,
      reason,
      overriddenBy: by,
      overriddenAt: at,
    },
  };
}

/**
 * Fold an incident's events into its current state.
 *
 * Duplicate `eventId`s are dropped rather than applied twice. That is what makes an
 * offline client safe to retry after an ambiguous network failure, and what stops a
 * reconnect from double-counting (INV-08).
 */
export function foldIncident(
  incidentId: Uuid,
  events: readonly IncidentEvent[],
  options: FoldOptions = {},
): IncidentState {
  const seen = new Set<string>();
  const ordered = events
    .filter((e) => {
      if (e.incidentId !== incidentId) return false;
      if (options.knownAt !== undefined && e.recordedAt > options.knownAt) return false;
      if (options.happenedBy !== undefined && e.occurredAt > options.happenedBy) return false;
      if (seen.has(e.eventId)) return false;
      seen.add(e.eventId);
      return true;
    })
    .sort(compareEvents);

  let status: IncidentStatus = 'reported';
  let severity: Provenanced<Severity> | null = null;
  let category: Provenanced<string> | null = null;
  let responsibleDepartmentIds: readonly Uuid[] = [];
  let routingAttemptedAt: Instant | null = null;
  const reassignedFrom: Uuid[] = [];
  const reportIds: Uuid[] = [];
  let acknowledgedAt: Instant | null = null;
  let acknowledgedBySeatId: Uuid | null = null;
  let escalationCount = 0;
  let currentEscalationSeatId: Uuid | null = null;
  const assignedResourceIds: Uuid[] = [];
  const actions: ResponseAction[] = [];
  // Keyed by attemptId so an outcome updates its attempt rather than appending beside it.
  const notifications = new Map<Uuid, NotificationAttempt>();
  const mergedIncidentIds: Uuid[] = [];
  let resolution: string | null = null;
  let closureNotes: string | null = null;
  let reopenCount = 0;
  let occurredAt: Instant | null = null;
  let lastRecordedAt: Instant | null = null;

  for (const e of ordered) {
    if (occurredAt === null) occurredAt = e.occurredAt;
    if (lastRecordedAt === null || e.recordedAt > lastRecordedAt) lastRecordedAt = e.recordedAt;

    switch (e.type) {
      case 'reported': {
        reportIds.push(e.payload.reportId);
        if (severity === null) {
          severity = { value: e.payload.severity, setBy: actorOf(e), setAt: e.occurredAt };
        }
        if (category === null) {
          category = { value: e.payload.category, setBy: actorOf(e), setAt: e.occurredAt };
        }
        break;
      }

      case 'triaged': {
        // A department reassessment never silently discards a district override. The
        // override stands until it is itself changed by someone with the authority.
        if (severity?.overriddenFrom === undefined) {
          severity = { value: e.payload.severity, setBy: actorOf(e), setAt: e.occurredAt };
        }
        category = { value: e.payload.category, setBy: actorOf(e), setAt: e.occurredAt };
        if (status === 'reported') status = 'triaged';
        break;
      }

      case 'routed': {
        responsibleDepartmentIds = [...e.payload.departmentIds];
        routingAttemptedAt = e.occurredAt;
        // Only advance the status if it actually reached somebody. A `routed` event with an
        // empty department list records that routing ran and matched nothing; calling that
        // "routed" on a board would tell an operator help is on its way to a department
        // that does not exist.
        if (e.payload.departmentIds.length > 0 && (status === 'reported' || status === 'triaged')) {
          status = 'routed';
        }
        break;
      }

      case 'acknowledged': {
        if (acknowledgedAt === null) {
          acknowledgedAt = e.occurredAt;
          acknowledgedBySeatId = e.payload.seatId;
        }
        if (status !== 'resolved' && status !== 'closed') status = 'acknowledged';
        break;
      }

      case 'assigned': {
        for (const id of e.payload.resourceIds) {
          if (!assignedResourceIds.includes(id)) assignedResourceIds.push(id);
        }
        if (status === 'acknowledged') status = 'responding';
        break;
      }

      case 'released': {
        // Removed from the live set rather than flagged. "Assigned, then released" stays
        // fully readable in the event history; what the projection has to answer is the live
        // question — is this unit committed *right now* — and a list that only grows cannot
        // answer it.
        for (const id of e.payload.resourceIds) {
          const at = assignedResourceIds.indexOf(id);
          if (at !== -1) assignedResourceIds.splice(at, 1);
        }
        break;
      }

      case 'action_logged': {
        actions.push({ at: e.occurredAt, by: actorOf(e), note: e.payload.note });
        if (status === 'acknowledged' || status === 'routed') status = 'responding';
        break;
      }

      case 'escalated': {
        escalationCount += 1;
        currentEscalationSeatId = e.payload.toSeatId;
        break;
      }

      case 'reassigned': {
        // Prefer what the event recorded; fall back to what we currently believe, so an
        // event written before `fromDepartmentIds` was populated still yields the truth.
        const from =
          e.payload.fromDepartmentIds.length > 0
            ? e.payload.fromDepartmentIds
            : responsibleDepartmentIds;
        for (const id of from) {
          if (!reassignedFrom.includes(id)) reassignedFrom.push(id);
        }
        responsibleDepartmentIds = [...e.payload.toDepartmentIds];
        break;
      }

      case 'overridden': {
        // The heart of ADR-0003. The previous value is carried forward, not replaced.
        if (e.payload.field === 'severity') {
          const prev: Provenanced<Severity> | null = severity;
          severity = withOverride(
            prev,
            e.payload.value as Severity,
            e.payload.reason,
            actorOf(e),
            e.occurredAt,
          );
        } else if (e.payload.field === 'category') {
          const prev: Provenanced<string> | null = category;
          category = withOverride(
            prev,
            e.payload.value,
            e.payload.reason,
            actorOf(e),
            e.occurredAt,
          );
        }
        break;
      }

      case 'merged': {
        if (!mergedIncidentIds.includes(e.payload.absorbedIncidentId)) {
          mergedIncidentIds.push(e.payload.absorbedIncidentId);
        }
        break;
      }

      case 'unmerged': {
        const i = mergedIncidentIds.indexOf(e.payload.restoredIncidentId);
        if (i !== -1) mergedIncidentIds.splice(i, 1);
        break;
      }

      case 'resolved': {
        resolution = e.payload.outcome;
        status = 'resolved';
        break;
      }

      case 'closed': {
        closureNotes = e.payload.notes;
        status = 'closed';
        break;
      }

      case 'reopened': {
        reopenCount += 1;
        closureNotes = null;
        resolution = null;
        status = 'responding';
        break;
      }

      case 'notified': {
        notifications.set(e.payload.attemptId, {
          attemptId: e.payload.attemptId,
          seatId: e.payload.seatId,
          channel: e.payload.channel,
          reason: e.payload.reason,
          attemptedAt: e.occurredAt,
          state: 'pending',
        });
        break;
      }

      case 'notification_delivered': {
        const attempt = notifications.get(e.payload.attemptId);
        // An outcome for an attempt we never saw is not discarded — it is still evidence
        // that something was delivered, and dropping it would make the ledger disagree with
        // the log it is folded from.
        notifications.set(e.payload.attemptId, {
          attemptId: e.payload.attemptId,
          seatId: e.payload.seatId,
          channel: e.payload.channel,
          reason: attempt?.reason ?? 'unknown',
          attemptedAt: attempt?.attemptedAt ?? e.occurredAt,
          state: 'delivered',
          settledAt: e.occurredAt,
        });
        break;
      }

      case 'notification_failed': {
        const attempt = notifications.get(e.payload.attemptId);
        notifications.set(e.payload.attemptId, {
          attemptId: e.payload.attemptId,
          seatId: e.payload.seatId,
          channel: e.payload.channel,
          reason: attempt?.reason ?? 'unknown',
          attemptedAt: attempt?.attemptedAt ?? e.occurredAt,
          state: 'failed',
          failure: e.payload.failure,
          settledAt: e.occurredAt,
        });
        break;
      }

      case 'late_arrival_flagged':
        // Recorded for audit; no effect on incident state.
        break;
    }
  }

  return {
    incidentId,
    status,
    severity,
    category,
    responsibleDepartmentIds,
    routingAttemptedAt,
    unassigned: routingAttemptedAt !== null && responsibleDepartmentIds.length === 0,
    reassignedFrom,
    reportIds,
    acknowledgedAt,
    acknowledgedBySeatId,
    escalationCount,
    currentEscalationSeatId,
    assignedResourceIds,
    actions,
    notifications: [...notifications.values()],
    mergedIncidentIds,
    resolution,
    closureNotes,
    reopenCount,
    occurredAt,
    lastRecordedAt,
    eventCount: ordered.length,
  };
}

/**
 * The district's live picture: the worst thing anyone assessed, and how much nobody has
 * looked at yet.
 *
 * Unacknowledged criticals are the thing that must never be lost in a summary (INV-04), and
 * an unassessed report is the thing that must never be *made to look* assessed (ADR-0009).
 * Both are returned; neither is folded into the other.
 */
export function districtSeverity(states: readonly IncidentState[]): SeveritySummary {
  return worstSeverity(
    states
      .filter((s) => s.status !== 'closed' && s.status !== 'resolved')
      .map((s) => s.severity?.value)
      .filter((s): s is Severity => s !== undefined),
  );
}

export { EMPTY_ACTOR };
