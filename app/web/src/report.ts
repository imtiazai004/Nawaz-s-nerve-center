/**
 * The post-incident report, on a screen and on paper — capability group 9.
 *
 * `M1-06` built the report and `GET /incidents/:id/report` served it. **Nothing in the client
 * ever called it**, which is the same fault search and export shipped with: an endpoint with
 * no door is not a capability. An operator asked for a report had no way to get one.
 *
 * ## Why this is the PDF answer
 *
 * The scope list asks for PDF output. The boring way to produce a PDF from a web application
 * is **the browser's own print dialogue**, and on this project boring is the requirement, not
 * a compromise: ADR-0007 asks of every new dependency *"who restarts this when it fails, and
 * how do they know it failed?"* — and a PDF library is a rendering engine, a font stack, and a
 * layout implementation that will differ from the screen and drift from it. A print stylesheet
 * has none of those, works offline, needs no server round trip, and produces a document that
 * is by construction the same one the operator was just looking at.
 *
 * ## Nothing is retyped
 *
 * Every value here comes from the fold. That is M1-06's rule and it survives onto paper: if an
 * operator retypes what the system already knows, the retyped version becomes a second account
 * free to disagree with the first, and a review then has two documents and no record.
 */

interface Actor {
  seatTitle: string | null;
  personName: string | null;
}

interface Timing {
  label: string;
  at: string | null;
  minutesFromOccurrence: number | null;
  missing: string | null;
}

interface Entry {
  at: string;
  recordedLaterMinutes: number;
  what: string;
  by: Actor;
  detail: string | null;
}

interface Report {
  incidentId: string;
  generatedAt: string;
  what: {
    category: string;
    severity: string;
    severityAssessed: boolean;
    severityOverriddenFrom: string | null;
    overrideReason: string | null;
  };
  who: { reportedBy: Actor; departments: string[]; acknowledgedBy: Actor | null };
  timings: Timing[];
  connectivity: { arrivalGapMinutes: number; lateArrival: boolean };
  unitsSent: { name: string; minutesCommitted: number | null }[];
  narrative: Entry[];
  notifications: { attempted: number; delivered: number; failed: number; stillPending: number };
  escalations: number;
  evidence: { filename: string }[];
  outcome: string | null;
  closureNotes: string | null;
  gaps: { what: string; why: string }[];
}

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

/** A seat first, then the person — a uuid does not answer "who" (ADR-0004). */
function actorWords(actor: Actor | null): string {
  if (actor === null) return 'the system';
  const seat = actor.seatTitle ?? 'an unnamed post';
  return actor.personName === null ? seat : `${seat} — ${actor.personName}`;
}

function when(iso: string | null): string {
  return iso === null ? '—' : new Date(iso).toLocaleString();
}

function section(heading: string): HTMLElement {
  const h = document.createElement('h3');
  h.textContent = heading;
  return h;
}

function pairs(rows: readonly (readonly [string, string])[]): HTMLElement {
  const dl = document.createElement('dl');
  dl.className = 'reportPairs';
  for (const [label, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.append(dt, dd);
  }
  return dl;
}

export interface ReportPanel {
  show(incidentId: string): Promise<void>;
}

export function mountReport(): ReportPanel {
  const body = el('piReportBody');
  const error = el('piReportError');

  return {
    async show(incidentId: string): Promise<void> {
      error.hidden = true;
      body.replaceChildren(document.createTextNode('Folding the record…'));

      let report: Report;
      try {
        const res = await fetch(`/incidents/${incidentId}/report`, { cache: 'no-store' });
        if (!res.ok) {
          error.hidden = false;
          error.textContent =
            res.status === 404
              ? 'No such incident, or not one you hold.'
              : 'Could not build the report. The record is fine — this screen could not reach it.';
          body.replaceChildren();
          return;
        }
        report = (await res.json()) as Report;
      } catch {
        error.hidden = false;
        error.textContent =
          'No connection. A report is folded from the record on the server, so it needs one.';
        body.replaceChildren();
        return;
      }

      const out = document.createDocumentFragment();

      const title = document.createElement('h2');
      title.textContent = `Post-incident report — ${report.what.category}`;
      out.append(title);

      const stamp = document.createElement('p');
      stamp.className = 'meta';
      // On paper, a document with no generation time is a document nobody can date later.
      stamp.textContent = `Incident ${report.incidentId} · folded ${when(report.generatedAt)}`;
      out.append(stamp);

      out.append(
        section('What happened'),
        pairs([
          ['Kind', report.what.category],
          [
            'Severity',
            report.what.severityAssessed
              ? report.what.severity
              : 'unassessed — nobody assigned a level',
          ],
          ...(report.what.severityOverriddenFrom === null
            ? []
            : ([
                ['Originally assessed', report.what.severityOverriddenFrom],
                ['Reason for the override', report.what.overrideReason ?? 'none recorded'],
              ] as [string, string][])),
        ]),
      );

      out.append(
        section('Who'),
        pairs([
          ['Reported by', actorWords(report.who.reportedBy)],
          [
            'Held by',
            report.who.departments.length > 0
              ? report.who.departments.join(', ')
              : 'nobody — routing matched no department',
          ],
          [
            'Acknowledged by',
            report.who.acknowledgedBy === null
              ? 'nobody acknowledged it'
              : actorWords(report.who.acknowledgedBy),
          ],
        ]),
      );

      out.append(
        section('Times'),
        pairs(
          report.timings.map(
            (t) =>
              [
                t.label,
                t.at === null
                  ? (t.missing ?? 'not recorded')
                  : `${when(t.at)}${
                      t.minutesFromOccurrence === null
                        ? ''
                        : ` · ${String(t.minutesFromOccurrence)} min from occurrence`
                    }`,
              ] as [string, string],
          ),
        ),
      );

      if (report.connectivity.lateArrival) {
        const gap = document.createElement('p');
        gap.className = 'note';
        // The district's real coverage picture, not noise (ADR-0002). An hour on a handset
        // with no signal must read as an hour, never as speed.
        gap.textContent =
          `This report spent ${String(report.connectivity.arrivalGapMinutes)} minutes on a ` +
          'device before the server saw it. Every duration above is measured from when it ' +
          'happened, not from when it arrived.';
        out.append(gap);
      }

      if (report.unitsSent.length > 0) {
        out.append(
          section('What was sent'),
          pairs(
            report.unitsSent.map(
              (u) =>
                [
                  u.name,
                  u.minutesCommitted === null
                    ? 'still committed'
                    : `${String(u.minutesCommitted)} min`,
                ] as [string, string],
            ),
          ),
        );
      }

      out.append(section('What was done'));
      const log = document.createElement('ol');
      log.className = 'reportNarrative';
      for (const entry of report.narrative) {
        const li = document.createElement('li');
        const head = document.createElement('b');
        head.textContent = entry.what;
        const meta = document.createElement('span');
        meta.className = 'meta';
        meta.textContent =
          ` — ${when(entry.at)} · ${actorWords(entry.by)}` +
          (entry.recordedLaterMinutes >= 15
            ? ` · recorded ${String(entry.recordedLaterMinutes)} min later`
            : '');
        li.append(head, meta);
        if (entry.detail !== null) {
          const detail = document.createElement('div');
          detail.textContent = entry.detail;
          li.append(detail);
        }
        log.append(li);
      }
      out.append(log);

      out.append(
        section('Outcome'),
        pairs([
          ['Outcome', report.outcome ?? 'none recorded'],
          ['Closing notes', report.closureNotes ?? 'none recorded'],
          ['Escalations', String(report.escalations)],
          [
            'Notifications',
            `${String(report.notifications.delivered)} delivered, ` +
              `${String(report.notifications.failed)} failed, ` +
              `${String(report.notifications.stillPending)} never picked up`,
          ],
          ['Evidence', report.evidence.length > 0 ? `${String(report.evidence.length)} file(s)` : 'none'],
        ]),
      );

      /**
       * The section a hand-written report always omits, and the one a review most needs.
       *
       * Printed last and printed always — including when it is empty, because "we checked and
       * there were no gaps" and "nobody looked" must not read identically (ADR-0005).
       */
      out.append(section('What this record does not contain'));
      if (report.gaps.length === 0) {
        const none = document.createElement('p');
        none.textContent = 'Nothing missing. Every stage of this incident was recorded.';
        out.append(none);
      } else {
        const gaps = document.createElement('ul');
        gaps.className = 'reportGaps';
        for (const gap of report.gaps) {
          const li = document.createElement('li');
          const what = document.createElement('b');
          what.textContent = gap.what;
          li.append(what, document.createTextNode(` — ${gap.why}`));
          gaps.append(li);
        }
        out.append(gaps);
      }

      body.replaceChildren(out);
    },
  };
}
