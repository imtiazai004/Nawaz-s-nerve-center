/**
 * Incidents out, as a spreadsheet — capability group 9.
 *
 * **This exists because of a decision, not because a list asked for a feature.** Q-01 and Q-02
 * settled that the district runs independently and integrates with no government-issued
 * system. The stated price of that independence is double entry, which `CLAUDE.md` names as
 * the top adoption risk, and the stated mitigation is export. Until now the mitigation did not
 * exist: a department that has to retype this month's incidents into whatever it submits
 * upward will eventually stop using the system it has to retype *from*.
 *
 * Three things this deliberately does not do:
 *
 * 1. **It does not run its own query.** `buildBoard` already folds incidents from the log and
 *    scopes them by seat; a second query would eventually disagree with the board about what
 *    happened, and then two documents would disagree about a district's emergencies. Same
 *    rule as M0-34.
 * 2. **It never truncates quietly.** If more incidents match than can be folded in one pass,
 *    it refuses and says to narrow the range. A short file is worse than no file: nobody
 *    checks a row count before submitting a report upward, and the numbers would simply be
 *    wrong. Same reasoning as a `pg_dump` holding fewer events than the live database being
 *    recorded as a failure rather than a warning.
 * 3. **It carries no citizen contact details** — capability 12. That is true by construction
 *    rather than by filtering: `BoardRow` has never held a reporter's name, number or
 *    location, and a test pins it so that adding one to the board cannot quietly add it here.
 */

import type { Board, BoardRow } from './board.js';

/**
 * Fields that make a spreadsheet execute something when the file is opened.
 *
 * A category name, a department name and a status all originate as text somebody typed into
 * the administration console. Excel, LibreOffice and Sheets all treat a leading `=`, `+`, `-`
 * or `@` as the start of a formula, so a department named `=HYPERLINK(...)` becomes a live
 * formula in whatever office opens the file — a district's own data turned into a payload,
 * delivered by the export that exists to be trusted.
 *
 * Prefixing with an apostrophe is the standard defence: the cell shows the original text and
 * the spreadsheet treats it as literal.
 */
function neutralise(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** RFC 4180 quoting: wrap in quotes, and double any quote inside. */
function cell(value: string | number | boolean | null): string {
  if (value === null) return '';
  const text = neutralise(String(value));
  return `"${text.replace(/"/g, '""')}"`;
}

export const COLUMNS: readonly string[] = [
  'incident_id',
  'status',
  'severity',
  'assessed',
  'overridden_from',
  'category',
  'departments',
  'unassigned',
  'occurred_at',
  'acknowledged_at',
  'last_recorded_at',
  'target_minutes',
  'overdue',
  'overdue_by_minutes',
  'escalations',
  'notifications_failed',
  'notifications_undelivered',
];

function row(r: BoardRow): string {
  return [
    cell(r.incidentId),
    cell(r.status),
    // The word, always — `unassessed` is a value and never a level (ADR-0009). A spreadsheet
    // has no colour to lean on, which is the case this rule was always really about.
    cell(r.assessed ? r.severity : 'unassessed'),
    cell(r.assessed),
    cell(r.overriddenFrom),
    cell(r.category),
    // Several departments answering one emergency is correct, not a conflict (ADR-0010).
    cell(r.responsibleDepartments.join('; ')),
    cell(r.unassigned),
    cell(r.occurredAt),
    cell(r.acknowledgedAt),
    cell(r.lastRecordedAt),
    cell(r.targetMinutes),
    cell(r.overdue),
    cell(r.overdueByMinutes),
    cell(r.escalationCount),
    cell(r.notificationsFailed),
    cell(r.notificationsUndelivered),
  ].join(',');
}

/**
 * The file.
 *
 * Begins with a byte order mark. Without one, Excel reads a UTF-8 file as the local codepage
 * and every Urdu or Pashto department name arrives as mojibake — which would make the export
 * useless for exactly the district it is for. CRLF for the same audience.
 */
/** U+FEFF, written as an escape: a literal one here is invisible in every diff and editor. */
const BOM = '\uFEFF';

export function toCsv(rows: readonly BoardRow[]): string {
  return `${BOM}${[COLUMNS.join(','), ...rows.map(row)].join('\r\n')}\r\n`;
}

export interface ExportReply {
  readonly status: number;
  readonly body: string;
  readonly contentType: string;
  readonly filename?: string;
  readonly error?: string;
}

/**
 * How many incidents one pass may fold before the answer stops being trustworthy.
 *
 * `buildBoard` takes the most recent `limit` incidents and says nothing about the rest, which
 * is right for a screen — an operator reads the top of it — and wrong for a document somebody
 * submits upward.
 */
export const EXPORT_LIMIT = 5000;

export function buildExport(board: Board, days: number, limitHit: boolean): ExportReply {
  if (limitHit) {
    return {
      status: 413,
      body: '',
      contentType: 'application/json; charset=utf-8',
      error:
        `more than ${EXPORT_LIMIT} incidents match the last ${days} days, which is more than ` +
        'can be exported in one pass. Ask for a shorter period — a file that quietly left ' +
        'emergencies out would be reported upward as if it were complete',
    };
  }

  const stamp = board.asOf.slice(0, 10);
  return {
    status: 200,
    body: toCsv(board.incidents),
    contentType: 'text/csv; charset=utf-8',
    filename: `incidents-${stamp}-last-${days}-days.csv`,
  };
}
