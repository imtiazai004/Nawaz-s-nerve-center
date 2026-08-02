/**
 * The post-incident report — M1-06.
 *
 * **Folded from the event log. Nothing here is typed by anybody.** If an operator has to
 * retype what the system already knows, the system has failed — and worse, the retyped
 * version becomes a second account of the same night, free to disagree with the first.
 *
 * Q-01 established that departments already run other systems and Q-02 turned that into an
 * export target rather than an integration one: this produces the account a department has to
 * submit upward, so the platform **replaces** work instead of adding to it. That is the
 * single strongest argument against the double-entry problem that kills adoption.
 *
 * Three rules, and all three are the same rule in different places:
 *
 * 1. **A gap is stated, never omitted.** No acknowledgement, no evidence, nobody notified —
 *    each says so in words. A report that silently leaves out what did not happen reads as a
 *    clean response, which is exactly the reading a review must not be handed.
 * 2. **Every duration is measured from `occurredAt`.** The district's real response time
 *    includes the hour a report spent on a handset with no signal. Measuring from arrival
 *    would make an outage look like speed (ADR-0002).
 * 3. **Nothing is inferred.** Where the log does not say, the report says the log does not
 *    say.
 */

import type { Instant, IncidentEvent, Uuid } from './events.js';
import type { IncidentState, NotificationAttempt } from './incident.js';
import { arrivalGapMinutes, minutesBetween } from './sla.js';

export interface Actor {
  readonly seatId: Uuid | null;
  readonly seatTitle: string | null;
  readonly personName: string | null;
}

/** One line of the narrative. Ordered by when it happened, not by when it was recorded. */
export interface ReportEntry {
  readonly at: Instant;
  /** How much later the server learned of it. Zero for anything done online. */
  readonly recordedLaterMinutes: number;
  readonly what: string;
  readonly by: Actor;
  readonly detail: string | null;
}

export interface ReportTiming {
  readonly label: string;
  readonly at: Instant | null;
  /** Minutes from when the emergency happened. Null when the moment never came. */
  readonly minutesFromOccurrence: number | null;
  /** Present when the moment never came, saying so rather than leaving a blank. */
  readonly missing: string | null;
}

export interface UnitInvolvement {
  readonly resourceId: Uuid;
  readonly name: string;
  readonly sentAt: Instant;
  readonly releasedAt: Instant | null;
  readonly minutesCommitted: number | null;
}

export interface ReportGap {
  readonly what: string;
  readonly why: string;
}

export interface PostIncidentReport {
  readonly incidentId: Uuid;
  readonly generatedAt: Instant;

  readonly what: {
    readonly category: string;
    readonly categorySetBy: Actor | null;
    readonly severity: string;
    readonly severityAssessed: boolean;
    readonly severitySetBy: Actor | null;
    /** Both values, when a higher authority replaced the department's own (ADR-0003). */
    readonly severityOverriddenFrom: string | null;
    readonly overrideReason: string | null;
  };

  readonly who: {
    readonly reportedBy: Actor;
    readonly departments: readonly string[];
    readonly departmentsItLeft: readonly string[];
    readonly acknowledgedBy: Actor | null;
  };

  readonly timings: readonly ReportTiming[];

  readonly connectivity: {
    /** Minutes the report spent unseen by the server. The district's real coverage picture. */
    readonly arrivalGapMinutes: number;
    readonly lateArrival: boolean;
  };

  readonly unitsSent: readonly UnitInvolvement[];
  readonly narrative: readonly ReportEntry[];

  readonly notifications: {
    readonly attempted: number;
    readonly delivered: number;
    readonly failed: number;
    readonly stillPending: number;
    readonly failures: readonly string[];
  };

  readonly escalations: number;
  readonly evidence: readonly { readonly filename: string; readonly capturedAt: Instant | null }[];

  readonly outcome: string | null;
  readonly closureNotes: string | null;

  /** Everything the log does not contain. Stated, because a review must see the holes. */
  readonly gaps: readonly ReportGap[];
}

export interface ReportSources {
  readonly state: IncidentState;
  readonly events: readonly IncidentEvent[];
  readonly generatedAt: Instant;
  /** seatId → title, personId → name. Resolved by the caller; this module stays pure. */
  readonly seats: Readonly<Record<string, string>>;
  readonly people: Readonly<Record<string, string>>;
  readonly departments: Readonly<Record<string, string>>;
  readonly resources: Readonly<Record<string, string>>;
  readonly evidence: readonly { readonly filename: string; readonly capturedAt: Instant | null }[];
}

function actorOf(event: IncidentEvent, sources: ReportSources): Actor {
  return {
    seatId: event.actorSeatId,
    seatTitle: event.actorSeatId === null ? null : (sources.seats[event.actorSeatId] ?? null),
    personName: event.actorPersonId === null ? null : (sources.people[event.actorPersonId] ?? null),
  };
}

/** The system, when nobody did it. Rendered as "the system", never as a blank. */
const NOBODY: Actor = { seatId: null, seatTitle: null, personName: null };

function timing(
  label: string,
  at: Instant | null,
  occurredAt: Instant | null,
  missing: string,
): ReportTiming {
  if (at === null || occurredAt === null) {
    return { label, at: null, minutesFromOccurrence: null, missing };
  }
  return {
    label,
    at,
    // From when it happened, always. Measuring from arrival would turn an hour on a handset
    // with no signal into an apparently instant response (ADR-0002).
    minutesFromOccurrence: Math.round(minutesBetween(occurredAt, at)),
    missing: null,
  };
}

function describe(
  event: IncidentEvent,
  sources: ReportSources,
): { what: string; detail: string | null } {
  switch (event.type) {
    case 'reported':
      return { what: 'Reported', detail: event.payload.category };
    case 'triaged':
      return {
        what: 'Assessed',
        detail: `${event.payload.severity} · ${event.payload.category}`,
      };
    case 'routed': {
      const names = event.payload.departmentIds.map((id) => sources.departments[id] ?? id);
      return names.length === 0
        ? { what: 'Routing found no department', detail: event.payload.reason ?? null }
        : { what: 'Routed', detail: names.join(', ') };
    }
    case 'acknowledged':
      return { what: 'Acknowledged', detail: null };
    case 'assigned':
      return {
        what: 'Sent',
        detail: event.payload.resourceIds.map((id) => sources.resources[id] ?? id).join(', '),
      };
    case 'released':
      return {
        what: 'Stood down',
        detail: `${event.payload.resourceIds
          .map((id) => sources.resources[id] ?? id)
          .join(', ')} — ${event.payload.reason}`,
      };
    case 'action_logged':
      return { what: 'Action', detail: event.payload.note };
    case 'escalated':
      return {
        what: 'Escalated',
        detail: `${sources.seats[event.payload.toSeatId] ?? event.payload.toSeatId} (${
          event.payload.trigger
        })`,
      };
    case 'reassigned':
      return {
        what: 'Reassigned',
        detail: `to ${event.payload.toDepartmentIds
          .map((id) => sources.departments[id] ?? id)
          .join(', ')} — ${event.payload.reason}`,
      };
    case 'overridden':
      return {
        what: 'Overridden',
        detail: `${event.payload.field} → ${event.payload.value} — ${event.payload.reason}`,
      };
    case 'resolved':
      return { what: 'Resolved', detail: event.payload.outcome };
    case 'closed':
      return { what: 'Closed', detail: event.payload.notes };
    case 'reopened':
      return { what: 'Reopened', detail: event.payload.reason };
    case 'late_arrival_flagged':
      return {
        what: 'Flagged as late-arriving',
        detail: `${String(Math.round(event.payload.gapMinutes))} minutes between happening and arriving`,
      };
    // Notification traffic is summarised rather than narrated. Three lines per attempt would
    // bury the response in its own plumbing.
    case 'notified':
    case 'notification_delivered':
    case 'notification_failed':
    case 'merged':
    case 'unmerged':
      return { what: '', detail: null };
  }
}

/** Which units were sent, and for how long each one was committed. */
function unitsSent(sources: ReportSources): readonly UnitInvolvement[] {
  const sent = new Map<string, { sentAt: Instant; releasedAt: Instant | null }>();

  for (const event of sources.events) {
    if (event.type === 'assigned') {
      for (const id of event.payload.resourceIds) {
        if (!sent.has(id)) sent.set(id, { sentAt: event.occurredAt, releasedAt: null });
      }
    }
    if (event.type === 'released') {
      for (const id of event.payload.resourceIds) {
        const existing = sent.get(id);
        if (existing !== undefined) existing.releasedAt = event.occurredAt;
      }
    }
  }

  return [...sent.entries()].map(([resourceId, when]) => ({
    resourceId,
    name: sources.resources[resourceId] ?? resourceId,
    sentAt: when.sentAt,
    releasedAt: when.releasedAt,
    minutesCommitted:
      when.releasedAt === null ? null : Math.round(minutesBetween(when.sentAt, when.releasedAt)),
  }));
}

function notifications(
  attempts: readonly NotificationAttempt[],
): PostIncidentReport['notifications'] {
  return {
    attempted: attempts.length,
    delivered: attempts.filter((a) => a.state === 'delivered').length,
    failed: attempts.filter((a) => a.state === 'failed').length,
    stillPending: attempts.filter((a) => a.state === 'pending').length,
    failures: attempts
      .filter((a) => a.state === 'failed')
      .map((a) => a.failure ?? 'no reason given'),
  };
}

/**
 * Everything the log does not contain.
 *
 * The most important part of the report, and the part a hand-written one always omits. A
 * review that is handed an account with the holes removed reads a clean response.
 */
function gaps(
  state: IncidentState,
  report: Omit<PostIncidentReport, 'gaps'>,
): readonly ReportGap[] {
  const found: ReportGap[] = [];

  if (state.acknowledgedAt === null) {
    found.push({
      what: 'Nobody acknowledged this',
      why: 'No seat took responsibility for it in the record.',
    });
  }
  if (state.severity === null || state.severity.value === 'unknown') {
    found.push({
      what: 'Nobody assessed the severity',
      why: 'It was handled at the deadline for an unassessed report (ADR-0009).',
    });
  }
  if (report.unitsSent.length === 0) {
    found.push({
      what: 'Nothing was recorded as sent',
      why: 'Either nothing went, or what went was never entered. The log cannot tell them apart.',
    });
  }
  if (state.actions.length === 0) {
    found.push({
      what: 'No actions were logged',
      why: 'What was done at the scene is not in this system.',
    });
  }
  if (report.evidence.length === 0) {
    found.push({ what: 'No photographs or files were attached', why: 'Nothing to corroborate.' });
  }
  if (report.notifications.attempted === 0) {
    found.push({
      what: 'Nobody was notified',
      why: 'No notification was even attempted, so nobody was told by the system.',
    });
  }
  if (report.notifications.failed > 0) {
    found.push({
      what: `${String(report.notifications.failed)} notification(s) failed`,
      why: report.notifications.failures.join('; '),
    });
  }
  if (state.responsibleDepartmentIds.length === 0) {
    found.push({
      what: 'No department held this',
      why: 'Routing matched nothing and nobody assigned it by hand.',
    });
  }
  if (state.resolution === null) {
    found.push({ what: 'No outcome was recorded', why: 'The incident was never resolved.' });
  }

  return found;
}

export function buildReport(sources: ReportSources): PostIncidentReport {
  const { state, events } = sources;

  const reported = events.find((e) => e.type === 'reported');
  const occurredAt = state.occurredAt;
  const arrivedAt = reported?.recordedAt ?? null;

  const narrative: ReportEntry[] = [];
  for (const event of events) {
    const { what, detail } = describe(event, sources);
    if (what === '') continue;
    narrative.push({
      at: event.occurredAt,
      // Zero online; hours after a shutdown. Shown per line because a report where one entry
      // arrived two hours late and the rest did not is a different night from one where
      // everything did.
      recordedLaterMinutes: Math.round(arrivalGapMinutes(event.occurredAt, event.recordedAt)),
      what,
      detail,
      by:
        event.actorSeatId === null && event.actorPersonId === null
          ? NOBODY
          : actorOf(event, sources),
    });
  }

  const resolvedEvent = events.find((e) => e.type === 'resolved');
  const closedEvent = events.find((e) => e.type === 'closed');

  const withoutGaps: Omit<PostIncidentReport, 'gaps'> = {
    incidentId: state.incidentId,
    generatedAt: sources.generatedAt,

    what: {
      category: state.category?.value ?? 'not stated',
      categorySetBy:
        state.category === null
          ? null
          : {
              seatId: state.category.setBy.seatId,
              seatTitle:
                state.category.setBy.seatId === null
                  ? null
                  : (sources.seats[state.category.setBy.seatId] ?? null),
              personName:
                state.category.setBy.personId === null
                  ? null
                  : (sources.people[state.category.setBy.personId] ?? null),
            },
      severity: state.severity?.value ?? 'unknown',
      severityAssessed: state.severity !== null && state.severity.value !== 'unknown',
      severitySetBy:
        state.severity === null
          ? null
          : {
              seatId: state.severity.setBy.seatId,
              seatTitle:
                state.severity.setBy.seatId === null
                  ? null
                  : (sources.seats[state.severity.setBy.seatId] ?? null),
              personName:
                state.severity.setBy.personId === null
                  ? null
                  : (sources.people[state.severity.setBy.personId] ?? null),
            },
      // Both values, never just the winner. An override that erased what the department
      // originally said would be the system taking a side (ADR-0003).
      severityOverriddenFrom: state.severity?.overriddenFrom?.value ?? null,
      overrideReason: state.severity?.overriddenFrom?.reason ?? null,
    },

    who: {
      reportedBy: reported === undefined ? NOBODY : actorOf(reported, sources),
      departments: state.responsibleDepartmentIds.map((id) => sources.departments[id] ?? id),
      departmentsItLeft: state.reassignedFrom.map((id) => sources.departments[id] ?? id),
      acknowledgedBy:
        state.acknowledgedBySeatId === null
          ? null
          : {
              seatId: state.acknowledgedBySeatId,
              seatTitle: sources.seats[state.acknowledgedBySeatId] ?? null,
              personName: null,
            },
    },

    timings: [
      timing('Happened', occurredAt, occurredAt, 'The reporter did not say when.'),
      timing('Reached the server', arrivedAt, occurredAt, 'No report event.'),
      timing('Acknowledged', state.acknowledgedAt, occurredAt, 'Never acknowledged by anybody.'),
      timing(
        'First unit sent',
        events.find((e) => e.type === 'assigned')?.occurredAt ?? null,
        occurredAt,
        'Nothing was recorded as sent.',
      ),
      timing('Resolved', resolvedEvent?.occurredAt ?? null, occurredAt, 'Never resolved.'),
      timing('Closed', closedEvent?.occurredAt ?? null, occurredAt, 'Never closed.'),
    ],

    connectivity: {
      arrivalGapMinutes:
        occurredAt === null || arrivedAt === null
          ? 0
          : Math.round(arrivalGapMinutes(occurredAt, arrivedAt)),
      lateArrival: events.some((e) => e.type === 'late_arrival_flagged'),
    },

    unitsSent: unitsSent(sources),
    narrative,
    notifications: notifications(state.notifications),
    escalations: state.escalationCount,
    evidence: sources.evidence,
    outcome: state.resolution,
    closureNotes: state.closureNotes,
  };

  return { ...withoutGaps, gaps: gaps(state, withoutGaps) };
}

/**
 * The report as plain text, for submitting upward.
 *
 * Q-02: departments keep their existing reporting obligations, and this platform generates
 * the account rather than integrating with the system that receives it. Plain text because it
 * can be pasted into anything — an email, a register, a form — with no tooling on the other
 * end, and because a district office should never need this software installed to read what
 * it produced.
 */
export function renderReport(report: PostIncidentReport): string {
  const out: string[] = [];
  const who = (a: Actor | null): string => {
    if (a === null) return 'nobody recorded';
    if (a.seatTitle === null && a.personName === null) return 'the system';
    if (a.personName === null) return a.seatTitle ?? 'unknown seat';
    return a.seatTitle === null ? a.personName : `${a.seatTitle} (${a.personName})`;
  };

  out.push('POST-INCIDENT REPORT');
  out.push(`Incident ${report.incidentId}`);
  out.push(`Generated ${report.generatedAt} — folded from the event log, not typed`);
  out.push('');

  out.push('WHAT HAPPENED');
  out.push(`  Category: ${report.what.category}  (set by ${who(report.what.categorySetBy)})`);
  out.push(
    report.what.severityAssessed
      ? `  Severity: ${report.what.severity}  (assessed by ${who(report.what.severitySetBy)})`
      : '  Severity: never assessed by anybody',
  );
  if (report.what.severityOverriddenFrom !== null) {
    out.push(
      `  Overridden from "${report.what.severityOverriddenFrom}" — ${
        report.what.overrideReason ?? 'no reason given'
      }`,
    );
  }
  out.push('');

  out.push('WHO');
  out.push(`  Reported by: ${who(report.who.reportedBy)}`);
  out.push(
    `  Held by: ${report.who.departments.length === 0 ? 'no department' : report.who.departments.join(', ')}`,
  );
  if (report.who.departmentsItLeft.length > 0) {
    out.push(`  Previously held by: ${report.who.departmentsItLeft.join(', ')}`);
  }
  out.push(`  Acknowledged by: ${who(report.who.acknowledgedBy)}`);
  out.push('');

  out.push('TIMES  (measured from when it happened, not from when we heard)');
  for (const t of report.timings) {
    out.push(
      t.at === null
        ? `  ${t.label.padEnd(20)} — ${t.missing ?? 'not recorded'}`
        : `  ${t.label.padEnd(20)} ${t.at}  (+${String(t.minutesFromOccurrence ?? 0)} min)`,
    );
  }
  if (report.connectivity.arrivalGapMinutes > 0) {
    out.push(
      `  The report spent ${String(report.connectivity.arrivalGapMinutes)} minutes unseen by the server${
        report.connectivity.lateArrival ? ' and was flagged as late-arriving' : ''
      }.`,
    );
  }
  out.push('');

  out.push('WHAT WAS SENT');
  if (report.unitsSent.length === 0) out.push('  Nothing was recorded as sent.');
  for (const u of report.unitsSent) {
    out.push(
      u.releasedAt === null
        ? `  ${u.name} — sent ${u.sentAt}, never stood down in the record`
        : `  ${u.name} — sent ${u.sentAt}, stood down after ${String(u.minutesCommitted ?? 0)} min`,
    );
  }
  out.push('');

  out.push('WHAT HAPPENED, IN ORDER');
  for (const e of report.narrative) {
    const late =
      e.recordedLaterMinutes > 0
        ? ` [reached the server ${String(e.recordedLaterMinutes)}m later]`
        : '';
    out.push(`  ${e.at}  ${e.what}${e.detail === null ? '' : `: ${e.detail}`}`);
    out.push(`      by ${who(e.by)}${late}`);
  }
  out.push('');

  out.push('NOTIFICATIONS');
  out.push(
    `  ${String(report.notifications.attempted)} attempted, ${String(
      report.notifications.delivered,
    )} delivered, ${String(report.notifications.failed)} failed, ${String(
      report.notifications.stillPending,
    )} never settled`,
  );
  for (const f of report.notifications.failures) out.push(`  Failed: ${f}`);
  out.push('');

  if (report.escalations > 0) {
    out.push(`ESCALATED ${String(report.escalations)} time(s)`);
    out.push('');
  }

  out.push('EVIDENCE');
  if (report.evidence.length === 0) out.push('  None attached.');
  for (const e of report.evidence) {
    out.push(`  ${e.filename}${e.capturedAt === null ? '' : `  (taken ${e.capturedAt})`}`);
  }
  out.push('');

  out.push('OUTCOME');
  out.push(`  ${report.outcome ?? 'No outcome was recorded.'}`);
  if (report.closureNotes !== null) out.push(`  Closing notes: ${report.closureNotes}`);
  out.push('');

  // Last, and never omitted. A report handed to a review with the holes removed reads as a
  // clean response, and that is the one thing this document must not do.
  out.push('WHAT THIS RECORD DOES NOT CONTAIN');
  if (report.gaps.length === 0) {
    out.push('  Nothing. Every step of this incident is in the record.');
  }
  for (const g of report.gaps) out.push(`  ${g.what} — ${g.why}`);

  return out.join('\n');
}
