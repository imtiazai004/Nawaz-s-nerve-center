/**
 * The incident lifecycle as commands: triage, route, acknowledge, act, reassign, override,
 * resolve, close. M0-24…28, 30, 31.
 *
 * Until now this logic existed and was proven, and was reachable only by a client appending
 * raw events through `/sync`. That is fine for a device replaying what it captured offline —
 * it is not fine for an operator action, because a raw append trusts the caller to have
 * checked their own authority. This module is the gate `domain/authority.ts` describes:
 * the policy table decides, and every command passes through it (INV-05).
 *
 * Three properties hold for every command here:
 *
 * 1. **Nothing mutates.** A command appends one event. There is no update path, here or in
 *    the store beneath it (ADR-0001).
 * 2. **The actor is stamped from the session**, never read from the body — the same rule
 *    `/sync` follows, for the same reason: the audit trail is the record, and a record that
 *    can be told who to name is not one.
 * 3. **The decision is data.** No command compares a role. It builds a `WriteAttempt` and
 *    asks the policy table, so adding a department stays rows rather than a release.
 */

import { randomUUID } from 'node:crypto';

import { append, loadIncident } from '../db/eventStore.js';
import type { Pool } from '../db/pool.js';
import {
  defaultRules,
  evaluateRead,
  evaluateWrite,
  type Decision,
  type Seat,
} from '../domain/authority.js';
import {
  SEVERITY_ORDER,
  type AssessedSeverity,
  type IncidentEvent,
  type Uuid,
} from '../domain/events.js';
import { foldIncident, type IncidentState } from '../domain/incident.js';
import { route, type RoutingDecision } from '../domain/routing.js';
import { loadRoutingSignals } from '../db/configStore.js';
import { departmentDirectory } from '../ops/directory.js';
import { log } from '../obs/log.js';
import type { Identity } from '../auth/sessions.js';

/**
 * What intake fills in when a caller did not say.
 *
 * Defined in `domain/assumptions.ts` and re-exported here, because routing must also know
 * what a placeholder looks like in order to refuse to route on one, and a domain module
 * importing from the API layer would be the wrong way round.
 */
import { ASSUMED_CATEGORY, ASSUMED_SEVERITY } from '../domain/assumptions.js';

export { ASSUMED_CATEGORY, ASSUMED_SEVERITY };

export type CommandKind =
  'triage' | 'route' | 'acknowledge' | 'log_action' | 'reassign' | 'override' | 'resolve' | 'close';

export type Command =
  | {
      readonly kind: 'triage';
      readonly severity: AssessedSeverity;
      readonly category: string;
      readonly reason?: string;
    }
  | { readonly kind: 'route'; readonly departmentIds: readonly Uuid[]; readonly reason: string }
  | { readonly kind: 'acknowledge'; readonly reason?: string }
  | {
      readonly kind: 'log_action';
      readonly note: string;
      /**
       * When it actually happened, if not now.
       *
       * An operator logs "on scene" ten minutes after arriving, and a crew back from a call
       * writes up an hour of work at once. Recording all of it as happening at the moment
       * somebody typed would put a lie in the one record a post-incident report is folded
       * from — and it is the same lie ADR-0002 already refuses for a report captured
       * offline. A stated time in the future is ignored rather than trusted.
       */
      readonly occurredAt?: string;
    }
  | { readonly kind: 'reassign'; readonly departmentIds: readonly Uuid[]; readonly reason: string }
  | {
      readonly kind: 'override';
      readonly field: 'severity' | 'category';
      readonly value: string;
      readonly reason: string;
    }
  | { readonly kind: 'resolve'; readonly outcome: string }
  | { readonly kind: 'close'; readonly notes: string };

export type CommandResult =
  | { readonly ok: true; readonly event: IncidentEvent; readonly state: IncidentState }
  | { readonly ok: false; readonly status: number; readonly error: string };

function refuse(status: number, error: string): CommandResult {
  return { ok: false, status, error };
}

/**
 * The seat the caller holds right now, or null if they hold none.
 *
 * Authority comes from the seat, never from the person (ADR-0004). An officer between
 * postings is authenticated and can do nothing, which is the correct amount.
 */
export function seatOf(identity: Identity): Seat | null {
  if (identity.seatId === null || identity.tier === null) return null;
  return {
    seatId: identity.seatId,
    departmentId: identity.departmentId,
    tier: identity.tier,
    canBreakGlass: identity.canBreakGlass,
  };
}

function isNonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * An **assessed** severity, which is the only kind a command may set.
 *
 * `unknown` is deliberately not accepted here (ADR-0009). Triage is the act of assessing;
 * revising an assessment to "no assessment" is not a thing an operator does, and letting a
 * command write it would put the one value only intake may produce back into play.
 */
export function isSeverity(v: unknown): v is AssessedSeverity {
  return typeof v === 'string' && (SEVERITY_ORDER as readonly string[]).includes(v);
}

/**
 * Which policy rows govern which command.
 *
 * In one place, so the mapping can be read and tested rather than discovered by reading
 * eight handlers. A command lists every field it touches: `triage` writes severity *and*
 * category, so it needs authority over both, while an override names the one field it is
 * changing and must not require authority over the other.
 */
export function governedFields(command: Command): readonly string[] {
  switch (command.kind) {
    case 'triage':
      return ['incident.severity', 'incident.category'];
    case 'route':
    case 'reassign':
      return ['incident.responsibleDepartment'];
    case 'acknowledge':
      return ['incident.acknowledgement'];
    case 'log_action':
      return ['incident.actions'];
    case 'override':
      return [`incident.${command.field}`];
    case 'resolve':
    case 'close':
      return ['incident.closure'];
  }
}

function reasonOf(command: Command): string | undefined {
  return 'reason' in command && isNonEmpty(command.reason) ? command.reason : undefined;
}

/**
 * Ask the policy table about every field a command touches.
 *
 * All of them must permit it. A triage that may set category but not severity is not a
 * triage half-allowed — it is refused, because a partially applied command would leave the
 * operator believing something happened that did not.
 */
function authorise(command: Command, seat: Seat, state: IncidentState): Decision {
  const rules = defaultRules(state.responsibleDepartmentIds[0] ?? null);
  const reason = reasonOf(command);

  let best: Decision = { allowed: true, as: 'owner' };

  for (const fieldKey of governedFields(command)) {
    const rule = rules.find((r) => r.fieldKey === fieldKey);
    if (rule === undefined) {
      // A command naming a field with no rule must fail closed. An unknown field is not an
      // unrestricted one.
      return { allowed: false, why: `no authority rule governs ${fieldKey}` };
    }

    const decision = evaluateWrite(rule, { fieldKey, seat, reason });
    if (!decision.allowed) return decision;
    if (decision.as === 'override' && best.allowed) best = decision;
  }

  return best;
}

/**
 * Refuse commands that cannot mean anything in the incident's current state.
 *
 * These are not authority checks — an operator with every permission still cannot
 * acknowledge an incident that was never routed anywhere. Each returns the state the caller
 * is actually in, because "cannot acknowledge" without saying why sends them to the phone.
 */
function checkPrecondition(command: Command, state: IncidentState): string | null {
  if (state.status === 'closed' && command.kind !== 'log_action') {
    return 'incident is closed; reopen it before making further changes';
  }

  switch (command.kind) {
    case 'route':
      return state.responsibleDepartmentIds.length > 0
        ? 'incident is already routed; use reassign, which records a reason and notifies the ' +
            'department losing it'
        : null;

    case 'reassign':
      return state.responsibleDepartmentIds.length === 0
        ? 'incident has never been routed; use route'
        : null;

    case 'acknowledge':
      if (state.responsibleDepartmentIds.length === 0) {
        return 'incident has not been routed to a department; there is nothing to acknowledge';
      }
      if (state.acknowledgedAt !== null) {
        return `already acknowledged at ${state.acknowledgedAt}`;
      }
      if (state.status === 'resolved') return 'incident is already resolved';
      return null;

    case 'close':
      // Closing straight past resolution is how incidents get closed blank, and closure
      // completeness is one of the metrics this system exists to be honest about. The
      // outcome has to be recorded before the incident stops being live.
      return state.status === 'resolved' ? null : 'resolve the incident before closing it';

    case 'resolve':
      return state.status === 'resolved' ? 'incident is already resolved' : null;

    default:
      return null;
  }
}

/** Turn a validated command into the single event that records it. */
function eventFor(
  command: Command,
  incidentId: Uuid,
  identity: Identity,
  now: string,
  clientSeq: number,
  state: IncidentState,
): IncidentEvent {
  // `recordedAt` is always now and is never the caller's to state — it is when the server
  // learned of it, and a client that could set it could rewrite how long the district took.
  // `occurredAt` may be earlier when the actor says so, which is the whole point of keeping
  // the two apart (ADR-0002).
  const stated =
    command.kind === 'log_action' && isNonEmpty(command.occurredAt) ? command.occurredAt : null;
  const occurredAt = stated !== null && stated <= now ? stated : now;

  const envelope = {
    eventId: randomUUID(),
    incidentId,
    occurredAt,
    recordedAt: now,
    clientSeq,
    // Stamped from the session. Whatever the body claimed is not consulted.
    actorPersonId: identity.personId,
    actorSeatId: identity.seatId,
    sourceChannel: 'web' as const,
  };

  switch (command.kind) {
    case 'triage':
      return {
        ...envelope,
        type: 'triaged',
        payload: {
          severity: command.severity,
          category: command.category,
          ...(isNonEmpty(command.reason) ? { reason: command.reason } : {}),
        },
      } as IncidentEvent;

    case 'route':
      return {
        ...envelope,
        type: 'routed',
        payload: {
          departmentIds: command.departmentIds,
          ruleId: 'manual',
          reason: command.reason,
        },
      } as IncidentEvent;

    case 'acknowledge':
      return {
        ...envelope,
        type: 'acknowledged',
        // The seat is the session's, not the body's. Acknowledging on someone else's behalf
        // is a thing the record must not be able to be told.
        payload: { seatId: identity.seatId },
      } as IncidentEvent;

    case 'log_action':
      return {
        ...envelope,
        type: 'action_logged',
        payload: { note: command.note },
      } as IncidentEvent;

    case 'reassign':
      return {
        ...envelope,
        type: 'reassigned',
        payload: {
          // Who is losing it, recorded at the moment it happens. An earlier version wrote
          // an empty array here, which made the event unable to answer half of what a
          // handover is — and the department being handed *from* is the one that has to be
          // told it is no longer going.
          fromDepartmentIds: state.responsibleDepartmentIds,
          toDepartmentIds: command.departmentIds,
          reason: command.reason,
        },
      } as IncidentEvent;

    case 'override':
      return {
        ...envelope,
        type: 'overridden',
        payload: { field: command.field, value: command.value, reason: command.reason },
      } as IncidentEvent;

    case 'resolve':
      return {
        ...envelope,
        type: 'resolved',
        payload: { outcome: command.outcome },
      } as IncidentEvent;

    case 'close':
      return {
        ...envelope,
        type: 'closed',
        payload: { notes: command.notes },
      } as IncidentEvent;
  }
}

export interface ApplyOptions {
  readonly now?: string;
}

/**
 * Run one command against one incident.
 *
 * Order is deliberate: exist, then may-you-see-it, then does-it-make-sense, then
 * may-you-do-it. A caller with no authority over an incident learns that it exists and
 * nothing else, and a caller who cannot even read it learns nothing at all — an authority
 * check that answers "no, and here is what you were refused" is a disclosure.
 */
export async function applyCommand(
  pool: Pool,
  incidentId: Uuid,
  command: Command,
  identity: Identity,
  options: ApplyOptions = {},
): Promise<CommandResult> {
  const seat = seatOf(identity);
  if (seat === null) {
    return refuse(403, 'no current duty assignment; you hold no seat and cannot act');
  }

  const events = await loadIncident(pool, incidentId);
  if (events.length === 0) return refuse(404, 'no such incident');

  const state = foldIncident(incidentId, events);

  const readable = evaluateRead({ seat, responsibleDepartmentIds: state.responsibleDepartmentIds });
  if (!readable.allowed) return refuse(404, 'no such incident');

  const precondition = checkPrecondition(command, state);
  if (precondition !== null) return refuse(409, precondition);

  const decision = authorise(command, seat, state);
  if (!decision.allowed) return refuse(403, decision.why);

  const now = options.now ?? new Date().toISOString();

  // `eventCount + 1` follows the escalation job's convention for server-issued events.
  // Ordering does not actually rest on it here — a command's `occurredAt` is server time
  // and strictly later than everything already stored — but a consistent sequence keeps
  // the comparator's tie-breaks meaningful when a server event and an offline batch land
  // in the same millisecond (ADR-0008).
  const event = eventFor(command, incidentId, identity, now, state.eventCount + 1, state);

  await append(pool, [event]);

  return { ok: true, event, state: foldIncident(incidentId, [...events, event]) };
}

export interface IntakeInput {
  readonly category?: unknown;
  readonly severity?: unknown;
  readonly occurredAt?: unknown;
  readonly placeId?: unknown;
  readonly description?: unknown;
}

export interface IntakeResult {
  readonly incidentId: Uuid;
  readonly reportId: Uuid;
  readonly event: IncidentEvent;
  /** Fields the server supplied because the caller did not. Never silently filled. */
  readonly assumed: readonly string[];
  /** Departments the routing signals matched. Empty means it needs a human (ADR-0010). */
  readonly routedTo: readonly Uuid[];
  /** True when routing ran and matched nothing. Surfaced, never swallowed. */
  readonly unassigned: boolean;
  /** Plain language, for the reporter's confirmation screen and for the audit trail. */
  readonly routingReason: string;
}

/**
 * Take a report. **This endpoint does not refuse** (M0-24, INV-01).
 *
 * Every other endpoint in this file can say no. This one cannot, because the thing on the
 * other end of it is someone telling us an emergency is happening, and a validation error
 * returned to a caller under stress is an emergency the system chose to lose. Missing
 * fields are filled with a stated assumption and recorded as assumed; unusable values are
 * replaced rather than rejected.
 *
 * The one thing it will not do is invent an `occurredAt` in the future — a clock skewed
 * forward would push the SLA deadline out and quietly buy the incident extra time before
 * it escalates.
 */
export async function intake(
  pool: Pool,
  input: IntakeInput,
  identity: Identity,
  options: ApplyOptions = {},
): Promise<IntakeResult> {
  const now = options.now ?? new Date().toISOString();
  const assumed: string[] = [];

  let category = ASSUMED_CATEGORY;
  if (isNonEmpty(input.category)) {
    category = input.category.trim();
  } else {
    assumed.push('category');
  }

  let severity = ASSUMED_SEVERITY;
  if (isSeverity(input.severity)) {
    severity = input.severity;
  } else {
    assumed.push('severity');
  }

  let occurredAt = now;
  if (typeof input.occurredAt === 'string' && Number.isFinite(Date.parse(input.occurredAt))) {
    const stated = new Date(input.occurredAt).toISOString();
    if (stated <= now) occurredAt = stated;
    else assumed.push('occurredAt');
  } else if (input.occurredAt !== undefined) {
    assumed.push('occurredAt');
  }

  const incidentId = randomUUID();
  const reportId = randomUUID();

  const event = {
    eventId: randomUUID(),
    incidentId,
    type: 'reported',
    occurredAt,
    recordedAt: now,
    clientSeq: 1,
    actorPersonId: identity.personId,
    actorSeatId: identity.seatId,
    sourceChannel: 'web',
    payload: {
      reportId,
      category,
      severity,
      ...(typeof input.placeId === 'string' ? { placeId: input.placeId } : {}),
      ...(isNonEmpty(input.description) ? { description: input.description.trim() } : {}),
      // Which values came from the reporter and which from this function. A downstream
      // consumer can then tell an assessment from a placeholder, the same way location
      // capture records which layers actually produced a fix.
      ...(assumed.length > 0 ? { assumed } : {}),
    },
  } as unknown as IncidentEvent;

  await append(pool, [event]);

  const routing = await autoRoute(
    pool,
    incidentId,
    { category, description: input.description },
    now,
  );

  return {
    incidentId,
    reportId,
    event,
    assumed,
    routedTo: routing.departmentIds,
    unassigned: routing.unassigned,
    routingReason: routing.reason,
  };
}

/**
 * Send the incident to whichever departments the district's signals name (ADR-0010).
 *
 * Runs immediately after the report lands, as the system rather than as the reporter —
 * `actorSeatId: null` and `sourceChannel: 'system'`, because nobody made this decision
 * tonight. The administration made it when they wrote the signal.
 *
 * **Three things this deliberately does not do.**
 *
 * It does not refuse. Intake cannot fail (INV-01), and a routing pass that threw would take
 * the report down with it. Anything unexpected is caught, logged, and left as unrouted —
 * which surfaces on the administrative dashboards, where a human can finish the job. A
 * failure that reaches a person beats a report that reached nobody.
 *
 * It does not guess. No match produces an empty `routed` event, not a best-effort
 * department. See the `routed` payload in `domain/events.ts` for why the empty event is
 * recorded at all rather than simply omitted.
 *
 * It does not overrule anyone. This only ever runs at intake, before any human has touched
 * the incident, so it cannot undo a reassignment somebody made deliberately.
 */
/**
 * Route an incident that arrived through **sync**, if nothing has routed it yet.
 *
 * The M1 gate found this hole, and it was the biggest one in the system: auto-routing lived
 * only in `intake()`, which is the `POST /incidents` path. **The field path does not go
 * through it.** A handset writes the report to its outbox and pushes it to `/sync`, which
 * appends raw events — so every emergency captured the way the product is actually meant to
 * be used arrived unrouted, nobody was notified, and it sat on the board as *not yet routed*
 * until a human happened to look.
 *
 * Worth naming precisely: the routing tests passed, the intake tests passed, and the one
 * journey nobody had walked end to end was the only journey that matters.
 *
 * Idempotent by inspection rather than by a marker. Sync replays events — that is what makes
 * offline safe (INV-08) — so this asks whether a `routed` event already exists and does
 * nothing if it does. A second routing pass would produce a second `routed` event and could
 * silently undo a reassignment a human made in between.
 */
export async function autoRouteIfNeeded(pool: Pool, incidentId: Uuid): Promise<void> {
  const events = await loadIncident(pool, incidentId);
  if (events.length === 0) return;
  if (events.some((e) => e.type === 'routed')) return;

  const reported = events.find((e) => e.type === 'reported');
  if (reported === undefined) return;

  const payload = reported.payload as { category?: string; description?: string };
  await autoRoute(
    pool,
    incidentId,
    { category: payload.category ?? ASSUMED_CATEGORY, description: payload.description },
    new Date().toISOString(),
  );
}

async function autoRoute(
  pool: Pool,
  incidentId: Uuid,
  incident: { readonly category: string; readonly description?: unknown },
  now: string,
): Promise<{ departmentIds: readonly Uuid[]; unassigned: boolean; reason: string }> {
  let decision: RoutingDecision;
  try {
    const signals = await loadRoutingSignals(pool);
    decision = route(
      {
        category: incident.category,
        ...(isNonEmpty(incident.description) ? { description: incident.description } : {}),
      },
      signals,
    );
  } catch (err) {
    log('error', 'auto-routing failed; incident left for manual assignment', {
      incidentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      departmentIds: [],
      unassigned: false,
      reason: 'routing could not run; assign this manually',
    };
  }

  const event = {
    eventId: randomUUID(),
    incidentId,
    type: 'routed',
    occurredAt: now,
    recordedAt: now,
    // Second event on this incident, always. The `reported` event is first (ADR-0008).
    clientSeq: 2,
    actorPersonId: null,
    actorSeatId: null,
    sourceChannel: 'system',
    payload: {
      departmentIds: decision.departmentIds,
      ruleId: 'auto',
      signalIds: decision.matches.map((m) => m.signalId),
      reason: decision.reason,
    },
  } as unknown as IncidentEvent;

  try {
    await append(pool, [event]);
  } catch (err) {
    log('error', 'could not record the routing decision', {
      incidentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { departmentIds: [], unassigned: false, reason: 'routing could not be recorded' };
  }

  return {
    departmentIds: decision.departmentIds,
    unassigned: decision.unassigned,
    reason: decision.reason,
  };
}

export interface ActorDirectory {
  /** personId → full name. */
  readonly people: Readonly<Record<string, string>>;
  /** seatId → the post held, which is what authority actually attaches to (ADR-0004). */
  readonly seats: Readonly<Record<string, { readonly title: string; readonly tier: string }>>;
}

/**
 * Names for the ids an event carries.
 *
 * Without this, "who set this" is answered with a uuid, which is not an answer. The seat
 * matters more than the person — authority attaches to the post (ADR-0004) — so both are
 * returned and the screen leads with the seat.
 *
 * Resolved **as they are now**, which is a deliberate limitation worth stating: if an
 * officer has since been transferred, the event still names the person and seat recorded at
 * the time (that is in the log and cannot change), but the display name comes from today's
 * roster. Renaming a seat therefore retitles it throughout history. That is the right
 * trade for M0 — the alternative is denormalising names into every event — but it is a real
 * limitation, not an oversight.
 */
async function actorsFor(pool: Pool, events: readonly IncidentEvent[]): Promise<ActorDirectory> {
  const personIds = [...new Set(events.map((e) => e.actorPersonId).filter((id) => id !== null))];
  const seatIds = [...new Set(events.map((e) => e.actorSeatId).filter((id) => id !== null))];

  const people: Record<string, string> = {};
  const seats: Record<string, { title: string; tier: string }> = {};

  if (personIds.length > 0) {
    const res = await pool.query<{ person_id: string; full_name: string }>(
      'SELECT person_id, full_name FROM person WHERE person_id = ANY($1::uuid[])',
      [personIds],
    );
    for (const row of res.rows) people[row.person_id] = row.full_name;
  }

  if (seatIds.length > 0) {
    const res = await pool.query<{ seat_id: string; title: string; tier: string }>(
      'SELECT seat_id, title, tier FROM seat WHERE seat_id = ANY($1::uuid[])',
      [seatIds],
    );
    for (const row of res.rows) seats[row.seat_id] = { title: row.title, tier: row.tier };
  }

  return { people, seats };
}

/**
 * One incident: its folded state, its full history, and names for everyone in it.
 *
 * All three in one response, on purpose. Provenance has to be renderable without a second
 * request (docs/04-authority-model.md), and a detail screen that shows a value without
 * being able to answer "who set this, when, why" is the thing this project exists not to
 * build.
 */
export async function readIncident(
  pool: Pool,
  incidentId: Uuid,
  identity: Identity,
): Promise<
  | {
      readonly ok: true;
      readonly state: IncidentState;
      readonly events: readonly IncidentEvent[];
      readonly actors: ActorDirectory;
      readonly responsibleDepartments: readonly string[];
      /**
       * The same departments, by id.
       *
       * Sent alongside the names so the detail screen can offer "reach them" without a second
       * request. Names are what an operator reads; an id is what a lookup needs, and a screen
       * that has one and not the other ends up matching on a name somebody may rename.
       */
      readonly responsibleDepartmentIds: readonly string[];
    }
  | { readonly ok: false; readonly status: number; readonly error: string }
> {
  const seat = seatOf(identity);
  if (seat === null) {
    return { ok: false, status: 403, error: 'no current duty assignment; you hold no seat' };
  }

  const events = await loadIncident(pool, incidentId);
  if (events.length === 0) return { ok: false, status: 404, error: 'no such incident' };

  const state = foldIncident(incidentId, events);

  const readable = evaluateRead({ seat, responsibleDepartmentIds: state.responsibleDepartmentIds });
  // Refused reads are a 404, not a 403. Confirming an incident exists to a seat with no
  // authority over it is itself a disclosure about another department's operations.
  if (!readable.allowed) return { ok: false, status: 404, error: 'no such incident' };

  const [actors, departments] = await Promise.all([
    actorsFor(pool, events),
    departmentDirectory(pool),
  ]);

  return {
    ok: true,
    state,
    events,
    actors,
    // Named, not just identified (M0-51). An unmatched id is shown as an id rather than
    // hidden — a department missing from the registry is a problem, not a blank field.
    responsibleDepartments: state.responsibleDepartmentIds.map((id) => departments[id]?.name ?? id),
    responsibleDepartmentIds: state.responsibleDepartmentIds,
  };
}
