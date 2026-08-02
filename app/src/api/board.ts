/**
 * The central board — M0-33.
 *
 * One projection, not a copy. This reads the same event log everything else reads and folds
 * it on demand; there is no board table to fall out of step with the record (ADR-0001, and
 * root idea #4: one source of truth).
 *
 * Three properties this file exists to hold:
 *
 * 1. **It never renders stale data as current (INV-02).** Every response carries `asOf` and
 *    every row carries `lastRecordedAt`, so a client can always say how old what it is
 *    showing actually is. A board with no clock on it is a board that lies during an outage.
 * 2. **It never hides a critical, and never hides an unassessed report either (INV-04,
 *    ADR-0009).** The summary reports both numbers and folds neither into the other.
 * 3. **Scoping is server-side (INV-05).** Rows a seat may not see are not sent and then
 *    hidden — they are not sent.
 */

import { loadRecentIncidents } from '../db/eventStore.js';
import type { Pool } from '../db/pool.js';
import { evaluateRead, type Seat } from '../domain/authority.js';
import {
  isAssessed,
  severityRank,
  type AssessedSeverity,
  type Instant,
  type Severity,
  type Uuid,
} from '../domain/events.js';
import { districtSeverity, foldIncident, type IncidentState } from '../domain/incident.js';
import { unmetObligations } from '../domain/notifications.js';
import { checkEscalation, PLACEHOLDER_SLA, type SlaTargets } from '../domain/sla.js';

export interface BoardRow {
  readonly incidentId: Uuid;
  readonly status: IncidentState['status'];
  readonly severity: Severity;
  /** False when nobody has assessed it. The label, never a colour, carries this (INV-04). */
  readonly assessed: boolean;
  /** Present only when a higher authority replaced the department's own value (ADR-0003). */
  readonly overriddenFrom: AssessedSeverity | 'unknown' | null;
  readonly category: string;
  readonly responsibleDepartmentIds: readonly Uuid[];
  readonly occurredAt: Instant | null;
  /** How current this row is. The client renders it; it does not get to omit it (INV-02). */
  readonly lastRecordedAt: Instant | null;
  readonly acknowledgedAt: Instant | null;
  readonly escalationCount: number;
  /** Past its acknowledgement deadline and still unacknowledged. Decided server-side. */
  readonly overdue: boolean;
  readonly overdueByMinutes: number;
  /**
   * Notifications that have not reached anybody — INV-03's "unmet obligation".
   *
   * Two numbers, not one. `failed` means the attempt could not be made at all (a vacant
   * post, a dead gateway) and needs someone to fix a roster or a channel. `undelivered`
   * means it was queued and nobody has picked it up, which needs someone to pick up a
   * phone. Collapsing them would leave the control room unable to tell which.
   */
  readonly notificationsFailed: number;
  readonly notificationsUndelivered: number;
}

export interface Board {
  /** Server time when this was folded. A client showing it without this is guessing. */
  readonly asOf: Instant;
  readonly summary: {
    readonly open: number;
    readonly unacknowledged: number;
    readonly overdue: number;
    /** The worst severity anyone actually assessed. */
    readonly worst: AssessedSeverity | null;
    /** How many nobody has assessed. Never folded into `worst` (ADR-0009). */
    readonly unassessed: number;
    /**
     * Incidents where somebody was supposed to be told and demonstrably was not.
     *
     * INV-03 in one number, on the board, where the invariant says it must be — *an unmet
     * obligation, not a log line*.
     */
    readonly notificationsUnmet: number;
  };
  readonly incidents: readonly BoardRow[];
}

const CLOSED: ReadonlySet<IncidentState['status']> = new Set(['closed', 'resolved']);

/**
 * Order for a work queue, which is not the same thing as a rank for an aggregate.
 *
 * ADR-0009 forbids giving `unknown` a rank *in aggregation*, because both available answers
 * lie about what the district's severity is. A queue is a different question — "what should
 * a human look at first?" — and there it has an honest answer: **immediately after
 * critical.** A report nobody has assessed could be anything, including worse than the
 * `high` beneath it, so it does not wait behind assessed work. It is still labelled
 * `unassessed` in every row; it is ordered, never relabelled.
 */
function attentionRank(row: BoardRow): number {
  if (!row.assessed) return severityRank('critical') - 0.5;
  return severityRank(row.severity as AssessedSeverity);
}

function compareRows(a: BoardRow, b: BoardRow): number {
  // Work to do, before work already picked up.
  const ackA = a.acknowledgedAt === null ? 0 : 1;
  const ackB = b.acknowledgedAt === null ? 0 : 1;
  if (ackA !== ackB) return ackA - ackB;

  if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;

  const rankA = attentionRank(a);
  const rankB = attentionRank(b);
  if (rankA !== rankB) return rankB - rankA;

  // Oldest first. The same reason the escalation scan is oldest-first: without it, whichever
  // incident keeps losing the ordering lottery is the one that gets forgotten.
  return (a.occurredAt ?? '') < (b.occurredAt ?? '') ? -1 : 1;
}

export interface BoardOptions {
  readonly now?: Instant;
  readonly targets?: SlaTargets;
  readonly days?: number;
  readonly limit?: number;
  /** Include resolved and closed incidents. The board defaults to live work only. */
  readonly includeClosed?: boolean;
}

function toRow(state: IncidentState, now: Instant, targets: SlaTargets): BoardRow {
  const severity: Severity = state.severity?.value ?? 'unknown';
  const unmet = unmetObligations(state.notifications, now);

  const verdict =
    state.occurredAt === null || state.lastRecordedAt === null
      ? null
      : checkEscalation(
          {
            severity,
            occurredAt: state.occurredAt,
            recordedAt: state.lastRecordedAt,
            acknowledgedAt: state.acknowledgedAt,
            now,
          },
          targets,
        );

  return {
    incidentId: state.incidentId,
    status: state.status,
    severity,
    assessed: isAssessed(severity),
    overriddenFrom: state.severity?.overriddenFrom?.value ?? null,
    category: state.category?.value ?? 'unknown',
    responsibleDepartmentIds: state.responsibleDepartmentIds,
    occurredAt: state.occurredAt,
    lastRecordedAt: state.lastRecordedAt,
    acknowledgedAt: state.acknowledgedAt,
    escalationCount: state.escalationCount,
    overdue: state.acknowledgedAt === null && (verdict?.shouldEscalate ?? false),
    overdueByMinutes: Math.round(verdict?.overdueByMinutes ?? 0),
    notificationsFailed: unmet.filter((u) => u.why === 'failed').length,
    notificationsUndelivered: unmet.filter((u) => u.why === 'undelivered').length,
  };
}

/**
 * Build the board one seat is entitled to see.
 *
 * The department board (M0-34) is this same function with the same arguments — the scoping
 * falls out of the seat, not out of a second endpoint with a second query that would
 * eventually disagree with this one.
 */
export async function buildBoard(
  pool: Pool,
  seat: Seat,
  options: BoardOptions = {},
): Promise<Board> {
  const now = options.now ?? new Date().toISOString();
  const targets = options.targets ?? PLACEHOLDER_SLA;

  const grouped = await loadRecentIncidents(pool, options.days ?? 7, options.limit ?? 500);

  const visible: IncidentState[] = [];
  for (const events of grouped) {
    const first = events[0];
    if (first === undefined) continue;

    const state = foldIncident(first.incidentId, events);

    const readable = evaluateRead({
      seat,
      responsibleDepartmentIds: state.responsibleDepartmentIds,
    });
    if (!readable.allowed) continue;

    visible.push(state);
  }

  const live = visible.filter((s) => !CLOSED.has(s.status));
  const shown = options.includeClosed === true ? visible : live;

  const rows = shown.map((s) => toRow(s, now, targets)).sort(compareRows);
  const summary = districtSeverity(live);

  return {
    asOf: now,
    summary: {
      open: live.length,
      unacknowledged: live.filter((s) => s.acknowledgedAt === null).length,
      overdue: rows.filter((r) => r.overdue).length,
      worst: summary.worst,
      unassessed: summary.unassessed,
      notificationsUnmet: rows.filter(
        (r) => r.notificationsFailed > 0 || r.notificationsUndelivered > 0,
      ).length,
    },
    incidents: rows,
  };
}
