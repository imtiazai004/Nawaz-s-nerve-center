/**
 * The district whole — every department's work and responsiveness in one table.
 *
 * This is the thing the two administrative offices exist to see (ADR-0010), and it is the
 * one screen in the system whose entire purpose is comparison. That makes it the easiest
 * place to accidentally lie, so three rules apply to every number on it:
 *
 * 1. **A number is never an average of things that are not comparable.** Acknowledgement
 *    time is measured from `occurredAt`, so a two-hour connectivity outage shows up as two
 *    hours (ADR-0002). It is not quietly re-based on arrival to make the district look
 *    faster.
 * 2. **A median, not a mean.** One incident acknowledged nine hours later after a flood
 *    should not make a department's whole month look bad, and one instant acknowledgement
 *    should not rescue it. The mean is reported too, because the gap between them is itself
 *    the signal, but the median leads.
 * 3. **Nothing missing is rendered as zero.** A department with no incidents this period has
 *    `null` response times, not `0`. Zero minutes is the best possible performance and no
 *    data is no performance at all; a table that confuses them ranks the idle above the
 *    excellent (ADR-0005).
 *
 * Folded from the event log like everything else. There is no metrics table to drift.
 */

import { loadRecentIncidents } from '../db/eventStore.js';
import type { Pool } from '../db/pool.js';
import type { Identity } from '../auth/sessions.js';
import type { IncidentEvent, Instant, Uuid } from '../domain/events.js';
import { foldIncident, type IncidentState } from '../domain/incident.js';
import { unmetObligations } from '../domain/notifications.js';
import { checkEscalation, responseMinutes, targetsFor, type SlaConfig } from '../domain/sla.js';
import { listDepartments, loadSlaConfiguration } from '../db/configStore.js';
import { requireAdministration, type AdminResult } from './admin.js';

export interface DepartmentPerformance {
  readonly departmentId: Uuid;
  readonly name: string;
  readonly retired: boolean;
  /** Incidents this department held at any point in the window. */
  readonly total: number;
  readonly open: number;
  readonly unacknowledged: number;
  /** Open, unacknowledged, and past the deadline that applies to it. */
  readonly overdue: number;
  readonly escalated: number;
  readonly closed: number;
  /** Minutes from when it happened to when somebody took it. Null when nothing was. */
  readonly medianAckMinutes: number | null;
  readonly meanAckMinutes: number | null;
  readonly slowestAckMinutes: number | null;
  /** Share of acknowledged incidents that made their deadline, 0–1. Null when none were. */
  readonly withinTarget: number | null;
  /** Somebody was supposed to be told and was not (INV-03). */
  readonly notificationsUnmet: number;
}

export interface DistrictPerformance {
  readonly asOf: Instant;
  readonly windowDays: number;
  readonly departments: readonly DepartmentPerformance[];
  readonly district: {
    readonly total: number;
    readonly open: number;
    readonly overdue: number;
    /**
     * Emergencies the routing signals could not place.
     *
     * Deliberately at district level and not attributed to any department, because no
     * department has them. They belong to the two offices, and their existence is a
     * configuration gap rather than anyone's poor performance.
     */
    readonly unassigned: number;
    readonly medianAckMinutes: number | null;
    readonly notificationsUnmet: number;
  };
}

function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function mean(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function round(x: number | null): number | null {
  return x === null ? null : Math.round(x * 10) / 10;
}

interface Bucket {
  total: number;
  open: number;
  unacknowledged: number;
  overdue: number;
  escalated: number;
  closed: number;
  ackMinutes: number[];
  withinTarget: number;
  ackedForTarget: number;
  notificationsUnmet: number;
}

function emptyBucket(): Bucket {
  return {
    total: 0,
    open: 0,
    unacknowledged: 0,
    overdue: 0,
    escalated: 0,
    closed: 0,
    ackMinutes: [],
    withinTarget: 0,
    ackedForTarget: 0,
    notificationsUnmet: 0,
  };
}

const CLOSED: ReadonlySet<IncidentState['status']> = new Set(['closed', 'resolved']);

export interface PerformanceOptions {
  readonly now?: Instant;
  readonly days?: number;
  readonly limit?: number;
}

/**
 * Fold the district's recent incidents into a per-department picture.
 *
 * An incident held by two departments counts for **both**. Not a bug and not double
 * counting in any sense that matters: both were told, both were expected to act, and
 * splitting the credit would mean neither shows a full incident on a screen designed to ask
 * "did you answer?".
 */
/**
 * The console's view: every department, for the two offices.
 *
 * The authority check lives here and the calculation lives in `computePerformance` below,
 * because the dashboard needs to show a department **its own** row without handing it
 * everybody else's — and the alternative was a second median, computed elsewhere, that would
 * eventually disagree with this table in front of the officer it is about.
 */
export async function districtPerformance(
  pool: Pool,
  identity: Identity,
  options: PerformanceOptions = {},
): Promise<AdminResult<DistrictPerformance>> {
  const denied = requireAdministration<DistrictPerformance>(identity);
  if (denied !== null) return denied;

  return { ok: true, value: await computePerformance(pool, options) };
}

/** The calculation, with no authority check. Callers scope what they show. */
export async function computePerformance(
  pool: Pool,
  options: PerformanceOptions = {},
): Promise<DistrictPerformance> {
  const grouped = await loadRecentIncidents(pool, options.days ?? 30, options.limit ?? 5000);
  return performanceOver(pool, grouped, options);
}

/**
 * The calculation itself, over incidents somebody else selected.
 *
 * Split out when the arbitrary-period summary arrived, for the third time in this codebase and
 * the same reason each time (`projectIncidents`, `incidentRow`): **two ways of selecting is
 * fine, two ways of calculating is not.** A second median computed elsewhere would eventually
 * disagree with this table in front of the officer it is about.
 *
 * The caller decides which incidents and, if it needs to, which the asking seat may see.
 */
export async function performanceOver(
  pool: Pool,
  grouped: readonly (readonly IncidentEvent[])[],
  options: PerformanceOptions = {},
): Promise<DistrictPerformance> {
  const now = options.now ?? new Date().toISOString();
  const windowDays = options.days ?? 30;

  const [departments, config] = await Promise.all([
    listDepartments(pool),
    loadSlaConfiguration(pool) as Promise<SlaConfig>,
  ]);

  const buckets = new Map<Uuid, Bucket>();
  for (const d of departments) buckets.set(d.departmentId, emptyBucket());

  let districtTotal = 0;
  let districtOpen = 0;
  let districtOverdue = 0;
  let districtUnassigned = 0;
  let districtUnmet = 0;
  const districtAck: number[] = [];

  for (const events of grouped) {
    const first = events[0];
    if (first === undefined) continue;
    const state = foldIncident(first.incidentId, events);

    const live = !CLOSED.has(state.status);
    const targets = targetsFor(config, state.responsibleDepartmentIds);
    const severity = state.severity?.value ?? 'unknown';

    const overdue =
      live &&
      state.acknowledgedAt === null &&
      state.occurredAt !== null &&
      state.lastRecordedAt !== null &&
      checkEscalation(
        {
          severity,
          occurredAt: state.occurredAt,
          recordedAt: state.lastRecordedAt,
          acknowledgedAt: null,
          now,
        },
        targets,
      ).shouldEscalate;

    const ack =
      state.acknowledgedAt !== null && state.occurredAt !== null
        ? responseMinutes(state.occurredAt, state.acknowledgedAt)
        : null;

    const unmet = unmetObligations(state.notifications, now).length;

    districtTotal += 1;
    if (live) districtOpen += 1;
    if (overdue) districtOverdue += 1;
    if (state.unassigned && live) districtUnassigned += 1;
    if (unmet > 0) districtUnmet += 1;
    if (ack !== null) districtAck.push(ack);

    // Every department that has held this incident, including any it was taken from. A
    // department that dropped an emergency and had it reassigned away does not get to
    // disappear from the record of that emergency.
    const held = new Set<Uuid>([...state.responsibleDepartmentIds, ...state.reassignedFrom]);

    for (const departmentId of held) {
      let bucket = buckets.get(departmentId);
      if (bucket === undefined) {
        // An id with no registry row. Counted under its id rather than dropped — a
        // department that vanished from the registry is a real problem and a missing row on
        // this table would conceal it.
        bucket = emptyBucket();
        buckets.set(departmentId, bucket);
      }

      bucket.total += 1;
      if (live) bucket.open += 1;
      else bucket.closed += 1;
      if (live && state.acknowledgedAt === null) bucket.unacknowledged += 1;
      if (overdue) bucket.overdue += 1;
      if (state.escalationCount > 0) bucket.escalated += 1;
      if (unmet > 0) bucket.notificationsUnmet += 1;

      if (ack !== null) {
        bucket.ackMinutes.push(ack);
        bucket.ackedForTarget += 1;
        if (ack <= targets[severity]) bucket.withinTarget += 1;
      }
    }
  }

  const named = new Map(departments.map((d) => [d.departmentId, d]));

  const rows: DepartmentPerformance[] = [...buckets.entries()].map(([departmentId, b]) => ({
    departmentId,
    name: named.get(departmentId)?.name ?? departmentId,
    retired: named.get(departmentId)?.retiredAt !== null && named.has(departmentId),
    total: b.total,
    open: b.open,
    unacknowledged: b.unacknowledged,
    overdue: b.overdue,
    escalated: b.escalated,
    closed: b.closed,
    medianAckMinutes: round(median(b.ackMinutes)),
    meanAckMinutes: round(mean(b.ackMinutes)),
    slowestAckMinutes: b.ackMinutes.length === 0 ? null : round(Math.max(...b.ackMinutes)),
    withinTarget: b.ackedForTarget === 0 ? null : b.withinTarget / b.ackedForTarget,
    notificationsUnmet: b.notificationsUnmet,
  }));

  // Ordered by what needs attention, not alphabetically. A table sorted by name makes the
  // reader do the ranking, and the reader is the person this screen is supposed to help.
  rows.sort((a, b) => {
    if (a.overdue !== b.overdue) return b.overdue - a.overdue;
    if (a.unacknowledged !== b.unacknowledged) return b.unacknowledged - a.unacknowledged;
    if (a.notificationsUnmet !== b.notificationsUnmet) {
      return b.notificationsUnmet - a.notificationsUnmet;
    }
    if (a.open !== b.open) return b.open - a.open;
    return a.name.localeCompare(b.name);
  });

  return {
    asOf: now,
    windowDays,
    departments: rows,
    district: {
      total: districtTotal,
      open: districtOpen,
      overdue: districtOverdue,
      unassigned: districtUnassigned,
      medianAckMinutes: round(median(districtAck)),
      notificationsUnmet: districtUnmet,
    },
  };
}
