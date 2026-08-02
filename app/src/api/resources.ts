/**
 * What a department can send, over HTTP — M1-02 and M1-03.
 *
 * Scoped exactly like the roster: **a department manages its own units, the two offices
 * manage anyone's** (ADR-0010). The gate is `reach`, imported rather than reimplemented, so
 * there is one function to audit for both screens.
 *
 * Two kinds of thing live here and the split matters:
 *
 * - **The registry** — what exists, what is on the run, who is on which team. Configuration,
 *   recorded in `config_event`.
 * - **Dispatch and release** — what is committed to an incident right now. Those are facts
 *   about an *emergency*, so they are `incident_event`s and go through the same authority
 *   check as every other incident command (INV-05).
 *
 * Putting dispatch in the incident log rather than in a resource table is what makes "which
 * ambulance went to the bazaar fire, and when did it leave" answerable a year later.
 */

import { randomUUID } from 'node:crypto';

import type { Pool } from '../db/pool.js';
import type { Identity } from '../auth/sessions.js';
import type { IncidentEvent, Uuid } from '../domain/events.js';
import { append, loadIncident } from '../db/eventStore.js';
import { foldIncident } from '../domain/incident.js';
import {
  canDispatch,
  summarise,
  type ResourceAvailability,
  type ResourceKind,
} from '../domain/resources.js';
import {
  addMember,
  availabilityFor,
  commitmentsFor,
  createResource,
  departmentOfResource,
  findResource,
  removeMember,
  setOutOfService,
  setResourceRetired,
  updateResource,
  type ResourceResult,
} from '../db/resourceStore.js';
import type { AdminResult } from './admin.js';
import { reach } from './roster.js';

function refuse<T>(status: number, error: string): AdminResult<T> {
  return { ok: false, status, error };
}

function settle<T>(result: ResourceResult<T>): AdminResult<T> {
  return result.ok ? { ok: true, value: result.value } : refuse(409, result.why);
}

function text(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function isKind(v: unknown): v is ResourceKind {
  return v === 'vehicle' || v === 'team' || v === 'equipment';
}

function actorOf(identity: Identity): { seatId: string | null; personId: string | null } {
  return { seatId: identity.seatId, personId: identity.personId };
}

//------------------------------------------------------------------------------
// The registry
//------------------------------------------------------------------------------

export interface FleetView {
  readonly departmentId: Uuid;
  readonly units: readonly ResourceAvailability[];
  readonly summary: ReturnType<typeof summarise>;
}

export async function readFleet(
  pool: Pool,
  identity: Identity,
  departmentId: Uuid | null,
): Promise<AdminResult<FleetView>> {
  const target = departmentId ?? identity.departmentId;
  if (target === null) {
    return refuse(404, 'you hold no department of your own — name one');
  }

  const denied = reach<FleetView>(identity, target);
  if (denied !== null) return denied;

  const units = await availabilityFor(pool, target);
  return { ok: true, value: { departmentId: target, units, summary: summarise(units) } };
}

export async function addResource(
  pool: Pool,
  identity: Identity,
  departmentId: Uuid,
  input: { readonly kind?: unknown; readonly name?: unknown; readonly identifier?: unknown },
): Promise<AdminResult<unknown>> {
  const denied = reach<unknown>(identity, departmentId);
  if (denied !== null) return denied;

  if (!isKind(input.kind)) {
    return refuse(400, 'a unit is a "vehicle", a "team" or a piece of "equipment"');
  }
  const name = text(input.name);
  if (name === undefined) return refuse(400, 'a unit needs a name somebody would say on the radio');
  if (name.length > 120) return refuse(400, 'that name is too long');

  return settle(
    await createResource(
      pool,
      departmentId,
      {
        kind: input.kind,
        name,
        ...(text(input.identifier) !== undefined ? { identifier: text(input.identifier) } : {}),
      },
      actorOf(identity),
    ),
  );
}

/** Resolve a unit to its department, then apply the same gate the roster uses. */
async function reachResource<T>(
  pool: Pool,
  identity: Identity,
  resourceId: Uuid,
): Promise<AdminResult<T> | null> {
  const owner = await departmentOfResource(pool, resourceId);
  if (owner === null) return refuse(404, 'no such unit');
  return reach<T>(identity, owner);
}

export async function editResource(
  pool: Pool,
  identity: Identity,
  resourceId: Uuid,
  input: { readonly name?: unknown; readonly identifier?: unknown },
): Promise<AdminResult<unknown>> {
  const denied = await reachResource<unknown>(pool, identity, resourceId);
  if (denied !== null) return denied;

  return settle(
    await updateResource(
      pool,
      resourceId,
      {
        ...(text(input.name) !== undefined ? { name: text(input.name)! } : {}),
        ...(input.identifier !== undefined ? { identifier: text(input.identifier) ?? null } : {}),
      },
      actorOf(identity),
    ),
  );
}

export async function serviceState(
  pool: Pool,
  identity: Identity,
  resourceId: Uuid,
  out: boolean,
  reason: unknown,
): Promise<AdminResult<unknown>> {
  const denied = await reachResource<unknown>(pool, identity, resourceId);
  if (denied !== null) return denied;

  const why = text(reason);
  if (why === undefined) {
    // "Out of service" with no reason is a decision the next shift cannot act on: they
    // cannot tell whether to wait an hour or find another ambulance.
    return refuse(400, out ? 'say why it is off the run' : 'say why it is back');
  }

  return settle(await setOutOfService(pool, resourceId, out, why, actorOf(identity)));
}

export async function retireResource(
  pool: Pool,
  identity: Identity,
  resourceId: Uuid,
  retired: boolean,
  reason: unknown,
): Promise<AdminResult<unknown>> {
  const denied = await reachResource<unknown>(pool, identity, resourceId);
  if (denied !== null) return denied;

  const why = text(reason);
  if (why === undefined) return refuse(400, 'say why');

  return settle(await setResourceRetired(pool, resourceId, retired, why, actorOf(identity)));
}

export async function crew(
  pool: Pool,
  identity: Identity,
  resourceId: Uuid,
  personId: unknown,
  add: boolean,
): Promise<AdminResult<unknown>> {
  const denied = await reachResource<unknown>(pool, identity, resourceId);
  if (denied !== null) return denied;

  if (typeof personId !== 'string') return refuse(400, 'name the person');

  const result = add
    ? await addMember(pool, resourceId, personId, actorOf(identity))
    : await removeMember(pool, resourceId, personId, actorOf(identity));

  return settle<unknown>(result);
}

//------------------------------------------------------------------------------
// Dispatch — M1-03
//------------------------------------------------------------------------------

export interface DispatchResult {
  readonly incidentId: Uuid;
  readonly assigned: readonly Uuid[];
  /**
   * Things the operator should know, having already been done.
   *
   * Warnings, not refusals. A unit already committed elsewhere may still be sent — that is
   * the duty officer's call and the system does not get a veto (see `domain/resources.ts`).
   * What it owes them is that the consequence is said out loud rather than discovered.
   */
  readonly warnings: readonly string[];
}

/**
 * Send units to an incident.
 *
 * **Authority is the department's own.** Dispatch is the act of committing your own vehicles
 * and crews, so the check is "is this unit yours", not the incident policy table — a
 * department that holds the incident can send what it has, and cannot send another
 * department's ambulance. The two administrative offices can do either, as everywhere else.
 *
 * All-or-nothing on refusals: if any named unit cannot go, none of them do. A partial
 * dispatch would leave the operator believing they had sent three things when two went, and
 * the one that did not go is the one they would have replaced.
 */
export async function dispatch(
  pool: Pool,
  identity: Identity,
  incidentId: Uuid,
  input: { readonly resourceIds?: unknown },
): Promise<AdminResult<DispatchResult>> {
  if (identity.seatId === null) {
    return refuse(403, 'you hold no seat right now, so you hold no authority (ADR-0004)');
  }

  const ids = Array.isArray(input.resourceIds)
    ? input.resourceIds.filter((v): v is string => typeof v === 'string')
    : [];
  if (ids.length === 0) return refuse(400, 'name at least one unit to send');

  const events = await loadIncident(pool, incidentId);
  if (events.length === 0) return refuse(404, 'no such incident');
  const state = foldIncident(incidentId, events);

  if (state.status === 'closed') {
    return refuse(409, 'this incident is closed; reopen it before sending anything');
  }

  const warnings: string[] = [];

  for (const resourceId of ids) {
    const resource = await findResource(pool, resourceId);
    if (resource === null) return refuse(404, `no such unit: ${resourceId}`);

    const denied = reach<DispatchResult>(identity, resource.departmentId);
    if (denied !== null) {
      return refuse(
        403,
        `${resource.name} belongs to another department — ask them to send it, or reassign ` +
          'the incident',
      );
    }

    const commitments = (await commitmentsFor(pool, resource.departmentId))[resourceId] ?? [];
    const verdict = canDispatch(
      resource,
      commitments.filter((c) => c.incidentId !== incidentId),
    );

    if (!verdict.allowed) return refuse(409, verdict.why ?? `${resource.name} cannot be sent`);
    if (verdict.warning !== null) warnings.push(verdict.warning);
  }

  const now = new Date().toISOString();
  await append(pool, [
    {
      eventId: randomUUID(),
      incidentId,
      type: 'assigned',
      occurredAt: now,
      recordedAt: now,
      clientSeq: state.eventCount + 1,
      actorPersonId: identity.personId,
      actorSeatId: identity.seatId,
      sourceChannel: 'web',
      payload: { resourceIds: ids },
    } as unknown as IncidentEvent,
  ]);

  return { ok: true, value: { incidentId, assigned: ids, warnings } };
}

/**
 * Stand units down from an incident.
 *
 * A reason is required — by this function, by `REASON_REQUIRED`, and by whoever reviews the
 * incident afterwards. Taking a unit off a live emergency is the decision most likely to be
 * asked about, and "it was needed elsewhere" and "it was never actually sent" are very
 * different answers.
 */
export async function release(
  pool: Pool,
  identity: Identity,
  incidentId: Uuid,
  input: { readonly resourceIds?: unknown; readonly reason?: unknown },
): Promise<AdminResult<{ readonly released: readonly Uuid[] }>> {
  if (identity.seatId === null) {
    return refuse(403, 'you hold no seat right now, so you hold no authority (ADR-0004)');
  }

  const reason = text(input.reason);
  if (reason === undefined) return refuse(400, 'say why it is being stood down');

  const ids = Array.isArray(input.resourceIds)
    ? input.resourceIds.filter((v): v is string => typeof v === 'string')
    : [];
  if (ids.length === 0) return refuse(400, 'name at least one unit to stand down');

  const events = await loadIncident(pool, incidentId);
  if (events.length === 0) return refuse(404, 'no such incident');
  const state = foldIncident(incidentId, events);

  for (const resourceId of ids) {
    if (!state.assignedResourceIds.includes(resourceId)) {
      // Not an error to be forgiving about. "Release X" when X was never on this incident
      // usually means the operator is looking at the wrong incident.
      return refuse(409, 'that unit is not currently on this incident');
    }
    const owner = await departmentOfResource(pool, resourceId);
    if (owner === null) return refuse(404, 'no such unit');
    const denied = reach<{ readonly released: readonly Uuid[] }>(identity, owner);
    if (denied !== null) return denied;
  }

  const now = new Date().toISOString();
  await append(pool, [
    {
      eventId: randomUUID(),
      incidentId,
      type: 'released',
      occurredAt: now,
      recordedAt: now,
      clientSeq: state.eventCount + 1,
      actorPersonId: identity.personId,
      actorSeatId: identity.seatId,
      sourceChannel: 'web',
      payload: { resourceIds: ids, reason },
    } as unknown as IncidentEvent,
  ]);

  return { ok: true, value: { released: ids } };
}
