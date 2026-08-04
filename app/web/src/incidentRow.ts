/**
 * One incident, as a row — used by the board and by search.
 *
 * Moved out of `main.ts` when search arrived, for the same reason `projectIncidents` was
 * split out of `buildBoard` on the server: **the two surfaces already share one projection,
 * and it would be undone by two renderers.** A second copy of this drifts within a month, and
 * then the same emergency reads as `unassessed` on one screen and `unknown` on the other, or
 * shows its unmet notification on the board and not in the search result somebody found it in.
 *
 * Everything load-bearing about how an incident is *displayed* lives here and nowhere else:
 * the severity word carrying the meaning rather than the colour (INV-04), "not yet routed"
 * said out loud rather than left blank, and an unmet notification spelled out on the row it
 * belongs to rather than counted in a corner (INV-03).
 */

import { categoryWords, duration } from './words.js';

export interface IncidentRowData {
  incidentId: string;
  status: string;
  severity: string;
  assessed: boolean;
  overriddenFrom: string | null;
  category: string;
  occurredAt: string | null;
  acknowledgedAt: string | null;
  escalationCount: number;
  overdue: boolean;
  overdueByMinutes: number;
  notificationsFailed: number;
  notificationsUndelivered: number;
  responsibleDepartments: string[];
  unassigned: boolean;
  /**
   * Server-decided, so the dashboard's counters land on exactly what they counted.
   *
   * Not recomputed here. Each of these is the same predicate the counter used, on the same
   * fold — `occurredToday` especially, which is measured against the *server's* midnight and
   * would ask a different question if a handset decided it locally.
   */
  held: boolean;
  acknowledged: boolean;
  occurredToday: boolean;
  notificationsUnmet: boolean;
}

/** How long ago, in words. `—` for an incident with no stated time rather than a fake one. */
export function ago(iso: string | null, from: number): string {
  if (iso === null) return '—';
  const mins = Math.floor((from - Date.parse(iso)) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours}h ${mins % 60}m ago` : `${Math.floor(hours / 24)}d ago`;
}

export function incidentRow(row: IncidentRowData, at: number): HTMLElement {
  const div = document.createElement('div');
  div.className = 'row';
  div.dataset['overdue'] = String(row.overdue);
  div.dataset['unassigned'] = String(row.unassigned);
  div.dataset['incident'] = row.incidentId;
  // What the dashboard filters on when somebody arrives from one of its panels. Every one of
  // these is a value the server decided; nothing here re-derives a rule the counters used.
  div.dataset['category'] = row.category;
  div.dataset['departments'] = row.responsibleDepartments.join('');
  div.dataset['held'] = String(row.held);
  div.dataset['acknowledged'] = String(row.acknowledged);
  div.dataset['today'] = String(row.occurredToday);
  div.dataset['unmet'] = String(row.notificationsUnmet);

  const sev = document.createElement('span');
  sev.className = 'sev';
  sev.dataset['level'] = row.severity;
  // The word carries the meaning; the colour only repeats it (INV-04). "Unassessed"
  // is spelled out rather than shown as a level nobody chose.
  sev.textContent = row.assessed ? row.severity : 'unassessed';

  const cat = document.createElement('span');
  cat.className = 'cat';
  cat.textContent = categoryWords(row.category);
  if (row.overriddenFrom !== null) {
    const note = document.createElement('span');
    note.className = 'meta';
    note.textContent = ` (overridden from ${row.overriddenFrom})`;
    cat.append(note);
  }

  const state = document.createElement('span');
  state.className = 'state';
  state.textContent =
    row.acknowledgedAt !== null
      ? row.status
      : row.overdue
        ? `unacknowledged · ${duration(row.overdueByMinutes)} past deadline`
        : 'unacknowledged';
  if (row.overdue) state.classList.add('flag');

  const meta = document.createElement('span');
  meta.className = 'meta';
  // Whose incident it is, by name (M0-51). "Not yet routed" is said out loud rather
  // than left blank — an unrouted emergency is a state somebody has to act on.
  const who =
    row.responsibleDepartments.length > 0
      ? row.responsibleDepartments.join(', ')
      : 'not yet routed';
  meta.textContent = `${who} · ${ago(row.occurredAt, at)}${
    row.escalationCount > 0 ? ` · escalated ${row.escalationCount}×` : ''
  }`;

  div.append(sev, cat, state, meta);

  // Spelled out, on the row, next to the incident it concerns. A count in a corner
  // tells you the district has a problem; this tells you which incident nobody is
  // coming to (INV-03).
  if (row.notificationsFailed > 0 || row.notificationsUndelivered > 0) {
    const unmet = document.createElement('span');
    unmet.className = 'flag unmet';
    unmet.textContent =
      row.notificationsFailed > 0
        ? `could not notify the duty seat (${row.notificationsFailed})`
        : `notified, nobody has picked it up (${row.notificationsUndelivered})`;
    div.append(unmet);
  }
  return div;
}
