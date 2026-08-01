/**
 * The fold: events -> current state. See ADR-0001.
 *
 * `Incident` has no mutable status column anywhere in this system. Its state is computed
 * from its events every time. That is what makes the audit trail incapable of disagreeing
 * with the data, and it is what makes offline replay and central override fall out of one
 * mechanism instead of three.
 */

import type { Instant, IncidentEvent, Severity, Uuid } from './events.js';
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

export interface IncidentState {
  readonly incidentId: Uuid;
  readonly status: IncidentStatus;
  readonly severity: Provenanced<Severity> | null;
  readonly category: Provenanced<string> | null;
  readonly responsibleDepartmentIds: readonly Uuid[];
  readonly reportIds: readonly Uuid[];
  readonly acknowledgedAt: Instant | null;
  readonly acknowledgedBySeatId: Uuid | null;
  readonly escalationCount: number;
  readonly currentEscalationSeatId: Uuid | null;
  readonly assignedResourceIds: readonly Uuid[];
  readonly actions: readonly ResponseAction[];
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
 * Deterministic order: when it happened, then when we learned of it, then the id.
 *
 * The tiebreakers matter. Offline clients produce events with identical `occurredAt`
 * timestamps, and a replay that ordered them differently on each run would make the fold
 * non-deterministic — which would defeat the whole point of deriving state from the log.
 */
export function compareEvents(a: IncidentEvent, b: IncidentEvent): number {
  if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? -1 : 1;
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
  const reportIds: Uuid[] = [];
  let acknowledgedAt: Instant | null = null;
  let acknowledgedBySeatId: Uuid | null = null;
  let escalationCount = 0;
  let currentEscalationSeatId: Uuid | null = null;
  const assignedResourceIds: Uuid[] = [];
  const actions: ResponseAction[] = [];
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
        if (status === 'reported' || status === 'triaged') status = 'routed';
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

      case 'notified':
      case 'late_arrival_flagged':
        // Recorded for audit and the notification projection; no effect on incident state.
        break;
    }
  }

  return {
    incidentId,
    status,
    severity,
    category,
    responsibleDepartmentIds,
    reportIds,
    acknowledgedAt,
    acknowledgedBySeatId,
    escalationCount,
    currentEscalationSeatId,
    assignedResourceIds,
    actions,
    mergedIncidentIds,
    resolution,
    closureNotes,
    reopenCount,
    occurredAt,
    lastRecordedAt,
    eventCount: ordered.length,
  };
}

/** Unacknowledged criticals are the thing that must never be lost in a summary (INV-04). */
export function districtSeverity(states: readonly IncidentState[]): Severity | null {
  return worstSeverity(
    states
      .filter((s) => s.status !== 'closed' && s.status !== 'resolved')
      .map((s) => s.severity?.value)
      .filter((s): s is Severity => s !== undefined),
  );
}

export { EMPTY_ACTOR };
