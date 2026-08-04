/**
 * What happened in the district over a chosen period — capability group 9.
 *
 * *"District summaries for any period"* was in the scope list. What existed was the console's
 * performance table, fixed to a rolling window of recent arrivals, offered only to the two
 * offices. Somebody asked "how did we do in July" and there was no way to answer.
 *
 * Three things this shares rather than reimplements, and each for a reason already paid for:
 *
 * 1. **The selection is `loadIncidentsMatching`** — the same occurred-at window search uses.
 *    A summary of July must mean emergencies that *happened* in July. A report captured on a
 *    handset with no signal on 30 June and delivered on 2 July belongs to June, and counting
 *    it in July would move the district's worst nights into whichever month the network came
 *    back (ADR-0002).
 * 2. **The calculation is `performanceOver`** — the same medians the console shows. A second
 *    one would eventually disagree with the table in front of the officer it is about.
 * 3. **The scoping is `evaluateRead`**, per incident, exactly as on the board. A department
 *    may summarise its own work and learns nothing about a neighbour's.
 *
 * So a summary cannot say something the board, the export and the console would not also say
 * about the same emergencies. What is new here is only the window and who may ask.
 */

import { loadIncidentsMatching } from '../db/eventStore.js';
import type { Pool } from '../db/pool.js';
import type { IncidentEvent } from '../domain/events.js';
import { evaluateRead, type Seat } from '../domain/authority.js';
import { foldIncident } from '../domain/incident.js';
import { performanceOver, type DistrictPerformance } from './performance.js';
import { windowFor, type SearchRequest } from './search.js';

/** How many incidents one summary may fold. Truncation is reported, never silent. */
export const SUMMARY_LIMIT = 5000;

export interface Summary {
  readonly period: { readonly from: string; readonly to: string };
  /**
   * True when more incidents happened in the period than could be folded.
   *
   * **A summary is the one thing that must never quietly under-count.** A board that shows
   * fewer rows is visibly a list; a total that is short is a number somebody writes into a
   * report and defends in a meeting. Said out loud, so the answer can be "narrow the period"
   * rather than a wrong figure nobody questioned.
   */
  readonly truncated: boolean;
  readonly scope: 'district' | 'department';
  readonly performance: DistrictPerformance;
}

export async function districtSummaryFor(
  pool: Pool,
  seat: Seat,
  request: SearchRequest,
  now = new Date(),
): Promise<Summary> {
  const { from, to } = windowFor(request, now);

  const grouped = await loadIncidentsMatching(pool, {
    from,
    to,
    limit: SUMMARY_LIMIT + 1,
  });

  const truncated = grouped.length > SUMMARY_LIMIT;
  const considered = truncated ? grouped.slice(0, SUMMARY_LIMIT) : grouped;

  // Scoped before anything is counted. A department's summary must be built from its own
  // incidents, not from the district's totals with a filter applied afterwards — the second
  // would leak through any aggregate somebody forgot to filter (INV-05).
  const visible: (readonly IncidentEvent[])[] = [];
  for (const events of considered) {
    const first = events[0];
    if (first === undefined) continue;

    const state = foldIncident(first.incidentId, events);
    const readable = evaluateRead({
      seat,
      responsibleDepartmentIds: state.responsibleDepartmentIds,
    });
    if (readable.allowed) visible.push(events);
  }

  const days = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000));

  return {
    period: { from, to },
    truncated,
    scope: seat.tier === 'district' ? 'district' : 'department',
    performance: await performanceOver(pool, visible, { now: now.toISOString(), days }),
  };
}
