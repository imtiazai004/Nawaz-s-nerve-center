/**
 * The escalation job. INV-07 made true of a running system rather than only of a function.
 *
 * `domain/sla.ts` has known *when* to escalate since the first day. Nothing invoked it, so
 * the invariant held in theory and not in fact — a closed laptop still stopped an
 * escalation, because no server-side thing was watching. This is that thing.
 *
 * One rule shapes the design: **the escalation rule is never duplicated in SQL.** The
 * query narrows candidates; `checkEscalation` decides. Business rules expressed twice
 * drift, and a district would eventually be escalating by one rule and reporting by
 * another.
 */

import { append, loadIncident } from '../db/eventStore.js';
import type { Pool } from '../db/pool.js';
import { foldIncident } from '../domain/incident.js';
import {
  checkEscalation,
  targetsFor,
  type SlaConfig,
  type SlaTargets,
  PLACEHOLDER_SLA,
} from '../domain/sla.js';
import { loadSlaConfiguration } from '../db/configStore.js';
import { TIER_ORDER, tierRank, type Tier } from '../domain/authority.js';
import type { IncidentEvent } from '../domain/events.js';
import { randomUUID } from 'node:crypto';

/** How far back to look. An incident older than this is a records problem, not a live one. */
const LOOKBACK_DAYS = 7;

export interface EscalationOutcome {
  readonly scanned: number;
  readonly escalated: number;
  /** Past SLA, but there is no higher seat to reach. Needs a human, urgently. */
  readonly exhausted: readonly string[];
  /** Past SLA, but the tier above has nobody on duty. Also needs a human. */
  readonly noHolder: readonly string[];
  /**
   * The scan hit its cap, so open incidents were left unexamined this pass.
   *
   * Surfaced rather than swallowed: a district with more open incidents than the cap is
   * either in a genuine crisis or has a backlog nobody is closing, and both are things
   * the control room needs told rather than quietly absorbed by a `LIMIT`.
   */
  readonly truncated: boolean;
}

interface SeatRow {
  seat_id: string;
  tier: Tier;
  department_id: string | null;
  has_holder: boolean;
}

/**
 * The next seat up the ladder from a given tier.
 *
 * Prefers a seat in the same department, then falls back to a department-agnostic seat at
 * that tier — which is how the district control room and the DC are modelled. Tries each
 * tier in turn, so a missing tehsil tier escalates straight to district rather than
 * stalling.
 */
export async function nextSeatUp(
  pool: Pool,
  fromTier: Tier,
  departmentId: string | null,
): Promise<{ seatId: string; tier: Tier; hasHolder: boolean } | null> {
  const higher = TIER_ORDER.filter((t) => tierRank(t) > tierRank(fromTier));
  if (higher.length === 0) return null;

  const res = await pool.query<SeatRow>(
    `SELECT s.seat_id,
            s.tier,
            s.department_id,
            EXISTS (
              SELECT 1 FROM duty_assignment d
               WHERE d.seat_id = s.seat_id AND d.to_at IS NULL
            ) AS has_holder
       FROM seat s
      WHERE s.tier = ANY($1::text[])
        AND (s.department_id = $2 OR s.department_id IS NULL)`,
    [higher, departmentId],
  );

  for (const tier of higher) {
    const atTier = res.rows.filter((r) => r.tier === tier);
    // Same department first, then the department-agnostic control-room seats.
    const preferred =
      atTier.find((r) => r.department_id === departmentId && r.has_holder) ??
      atTier.find((r) => r.department_id === null && r.has_holder) ??
      atTier.find((r) => r.department_id === departmentId) ??
      atTier[0];

    if (preferred !== undefined) {
      return { seatId: preferred.seat_id, tier: preferred.tier, hasHolder: preferred.has_holder };
    }
  }

  return null;
}

/**
 * Incidents that might need escalating, **oldest first**.
 *
 * Deliberately loose about severity and deadlines: evaluating those here would be the
 * escalation rule written a second time, in a second language, free to drift from the
 * first.
 *
 * The ordering is not cosmetic. An earlier version selected an arbitrary `LIMIT` of the
 * open set, so once the district had more open incidents than the cap, *which* ones got
 * scanned was down to whatever order Postgres happened to return — and the same incident
 * could lose that lottery on every pass and sit unescalated indefinitely. Oldest-first
 * means the most overdue is always seen, and nothing can be starved.
 */
async function candidates(
  pool: Pool,
  limit: number,
  only?: readonly string[],
): Promise<readonly string[]> {
  const res = await pool.query<{ incident_id: string }>(
    `SELECT e.incident_id, MIN(e.recorded_at) AS first_seen
       FROM incident_event e
      WHERE e.recorded_at > now() - make_interval(days => $1)
        AND ($3::uuid[] IS NULL OR e.incident_id = ANY($3::uuid[]))
        AND NOT EXISTS (
              SELECT 1 FROM incident_event x
               WHERE x.incident_id = e.incident_id
                 AND x.type IN ('acknowledged', 'resolved', 'closed')
            )
      GROUP BY e.incident_id
      ORDER BY first_seen ASC
      LIMIT $2`,
    [LOOKBACK_DAYS, limit, only ?? null],
  );
  return res.rows.map((r) => r.incident_id);
}

export interface EscalationOptions {
  readonly targets?: SlaTargets;
  readonly now?: string;
  readonly limit?: number;
  /**
   * Evaluate only these incidents. Used to re-check specific cases after a manual change,
   * and by tests that must not depend on what else is open in the database.
   */
  readonly incidentIds?: readonly string[];
}

/**
 * One pass. Safe to call repeatedly; safe to call concurrently (see `scheduler.ts`).
 *
 * Idempotency comes from the ladder itself rather than a marker: an incident is only
 * escalated to a tier strictly above the one it has already reached. A second pass a
 * second later therefore does nothing, which is what stops a scan loop from becoming a
 * notification storm (INV-08).
 */
export async function runEscalationPass(
  pool: Pool,
  options: EscalationOptions = {},
): Promise<EscalationOutcome> {
  // The district's own deadlines, not the ones compiled into this file (Q-06). Loaded once
  // per pass rather than once per incident: a scan of 500 incidents must not become 500
  // settings queries, and a deadline that changed mid-pass would make one scan apply two
  // different rules — which is exactly the kind of thing nobody can explain afterwards.
  //
  // A pass that cannot read the configuration falls back rather than escalating nothing.
  // Skipping the pass would mean **no escalations at all** while the table is unreachable,
  // and an escalation that does not fire is the failure INV-07 exists to prevent.
  const config: SlaConfig =
    options.targets !== undefined
      ? { district: options.targets, byDepartment: {} }
      : await loadSlaConfiguration(pool).catch(() => ({
          district: PLACEHOLDER_SLA,
          byDepartment: {},
        }));
  const now = options.now ?? new Date().toISOString();
  const limit = options.limit ?? 500;
  const ids = await candidates(pool, limit, options.incidentIds);

  let escalated = 0;
  const exhausted: string[] = [];
  const noHolder: string[] = [];

  for (const incidentId of ids) {
    const events = await loadIncident(pool, incidentId);
    if (events.length === 0) continue;

    const state = foldIncident(incidentId, events);
    if (state.severity === null || state.occurredAt === null || state.lastRecordedAt === null) {
      continue;
    }

    const verdict = checkEscalation(
      {
        severity: state.severity.value,
        occurredAt: state.occurredAt,
        recordedAt: state.lastRecordedAt,
        acknowledgedAt: state.acknowledgedAt,
        now,
      },
      // Per incident, because the deadline belongs to whoever holds it. Where two
      // departments hold one incident the tightest deadline governs — see `targetsFor`.
      targetsFor(config, state.responsibleDepartmentIds),
    );

    if (!verdict.shouldEscalate) continue;

    // Where it currently sits. Before any escalation, that is the seat that last acted.
    const currentTier = await tierOfSeat(
      pool,
      state.currentEscalationSeatId ?? lastActingSeat(events),
    );
    const departmentId = state.responsibleDepartmentIds[0] ?? null;

    const next = await nextSeatUp(pool, currentTier ?? 'station', departmentId);

    if (next === null) {
      // Already at the top of the ladder and still unacknowledged. There is nothing left
      // for the system to do automatically, so it must be visible rather than silent.
      exhausted.push(incidentId);
      continue;
    }

    if (!next.hasHolder) {
      // A vacant post must not swallow an escalation (ADR-0004). Record it and surface it.
      noHolder.push(incidentId);
    }

    await append(pool, [
      {
        eventId: randomUUID(),
        incidentId,
        type: 'escalated',
        occurredAt: now,
        recordedAt: now,
        clientSeq: state.eventCount + 1,
        actorPersonId: null,
        actorSeatId: null,
        sourceChannel: 'system',
        payload: {
          fromSeatId: state.currentEscalationSeatId,
          toSeatId: next.seatId,
          // A vacant post is a materially different situation from a missed deadline, and
          // whoever reviews this afterwards needs to be able to tell them apart.
          trigger: next.hasHolder ? 'sla_breach' : 'no_duty_holder',
        },
      } as unknown as IncidentEvent,
    ]);

    escalated += 1;
  }

  return { scanned: ids.length, escalated, exhausted, noHolder, truncated: ids.length >= limit };
}

function lastActingSeat(events: readonly IncidentEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const seat = events[i]!.actorSeatId;
    if (seat !== null) return seat;
  }
  return null;
}

async function tierOfSeat(pool: Pool, seatId: string | null): Promise<Tier | null> {
  if (seatId === null) return null;
  const res = await pool.query<{ tier: Tier }>('SELECT tier FROM seat WHERE seat_id = $1', [
    seatId,
  ]);
  return res.rows[0]?.tier ?? null;
}
