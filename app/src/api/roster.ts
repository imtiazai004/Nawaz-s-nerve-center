/**
 * The roster over HTTP — M1a-10.
 *
 * **One set of endpoints, two audiences.** The DC and AC Headquarter offices maintain every
 * department's roster; a department maintains its own. Same operations, same screen, scoped
 * by the caller's department. Owner, 2026-08-02:
 *
 *   > department ki data sai mera matlab ye hai wo apne dashboard pr data edit kr ske, yaane
 *   > k kese ko add kar ske, remove kar ske, data daik ske… ye mera matlab nhe hai k ju
 *   > signals 2 offices assign karenge us edit kr skenge.
 *
 * So the split is exact, and it is the whole design of this file:
 *
 * | | Two offices | A department |
 * |---|---|---|
 * | Its own people and posts | yes, for all | **yes** |
 * | Another department's roster | yes | no |
 * | Routing signals, SLA deadlines | yes | **no** |
 * | Creating or retiring departments | yes | no |
 *
 * Routing signals stay with the administration for a reason worth restating: a department
 * able to edit its own routing could quietly remove the signal that sends it night-time fire
 * calls, and nothing on any screen would show that it had happened.
 *
 * Every scoping decision goes through `reach`. One function to audit, and an endpoint added
 * without calling it fails closed rather than opening a hole (INV-05).
 */

import type { Pool } from '../db/pool.js';
import type { Identity } from '../auth/sessions.js';
import type { Uuid } from '../domain/events.js';
import {
  addPerson,
  assignToPost,
  createPost,
  grantAccount,
  peopleFor,
  relieveFromPost,
  removePerson,
  renamePost,
  rosterFor,
  setPostRetired,
  updatePerson,
  type DepartmentRoster,
  type RosterPerson,
  type RosterPost,
  type RosterResult,
  type Tier,
} from '../db/rosterStore.js';
import type { AdminResult } from './admin.js';

function refuse<T>(status: number, error: string): AdminResult<T> {
  return { ok: false, status, error };
}

/**
 * May this caller touch this department's roster?
 *
 * Two ways in, and no third: you are the administration, or it is your own department.
 *
 * **403, not 404.** Unlike an incident, a department's existence is not sensitive — every
 * officer in Bannu knows the other departments exist. Pretending otherwise would turn a
 * legitimate configuration problem, like being between postings, into what looks like a
 * broken link at the moment somebody is trying to fix something.
 */
export function reach<T>(identity: Identity, departmentId: Uuid): AdminResult<T> | null {
  if (identity.seatId === null) {
    return refuse(403, 'you hold no seat right now, so you hold no authority (ADR-0004)');
  }
  if (identity.isAdministration) return null;
  if (identity.departmentId === departmentId) return null;

  return refuse(
    403,
    'you may edit your own department’s roster; only the DC Office and the AC Headquarter ' +
      'Bannu Office may edit another department’s',
  );
}

/**
 * The department a request is about, when the caller did not name one.
 *
 * A department officer opening "my department" should not have to know its uuid, and should
 * not be able to change the answer by sending a different one. Administration must name a
 * department explicitly — there is no "my department" for an office that holds all of them.
 */
export function subjectDepartment(identity: Identity, named: Uuid | null): Uuid | null {
  return named ?? identity.departmentId;
}

function text(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function isTier(v: unknown): v is Tier {
  return v === 'department' || v === 'district';
}

/** Turn a store refusal into an HTTP one. 409: well-formed request, state disagrees. */
function settle<T>(result: RosterResult<T>): AdminResult<T> {
  return result.ok ? { ok: true, value: result.value } : refuse(409, result.why);
}

//------------------------------------------------------------------------------
// Reading
//------------------------------------------------------------------------------

export interface RosterView extends DepartmentRoster {
  /** Whether this caller may change it, so the screen can render read-only honestly. */
  readonly editable: boolean;
  readonly people: readonly RosterPerson[];
}

export async function readRoster(
  pool: Pool,
  identity: Identity,
  departmentId: Uuid | null,
): Promise<AdminResult<RosterView>> {
  const target = subjectDepartment(identity, departmentId);
  if (target === null) {
    return refuse(
      404,
      'you hold a district-wide seat with no department of its own, so there is no ' +
        '"my department" to show — name one',
    );
  }

  const denied = reach<RosterView>(identity, target);
  if (denied !== null) return denied;

  const roster = await rosterFor(pool, target);
  if (roster === null) return refuse(404, 'no such department');

  return { ok: true, value: { ...roster, editable: true, people: await peopleFor(pool, target) } };
}

//------------------------------------------------------------------------------
// Posts
//------------------------------------------------------------------------------

export async function addPost(
  pool: Pool,
  identity: Identity,
  departmentId: Uuid,
  input: { readonly title?: unknown; readonly tier?: unknown },
): Promise<AdminResult<RosterPost>> {
  const denied = reach<RosterPost>(identity, departmentId);
  if (denied !== null) return denied;

  const title = text(input.title);
  if (title === undefined) return refuse(400, 'a post needs a title');
  if (title.length > 200) return refuse(400, 'that title is too long');

  // Tier is not really a parameter any more.
  //
  // Migration 0010 derives it from the department at the database, because a tier that can
  // drift out of step with `is_administration` is a silent widening of who may read what.
  // The check below therefore refuses an impossible request rather than guarding the write:
  // a department asking for a district post is asking to see every incident in Bannu, and it
  // should be told no rather than quietly given something else.
  if (!identity.isAdministration && isTier(input.tier) && input.tier !== 'department') {
    return refuse(
      403,
      'only the DC Office and the AC Headquarter Office hold district-tier posts (ADR-0010)',
    );
  }
  const tier: Tier = 'department';

  return settle(await createPost(pool, departmentId, title, tier, actorOf(identity)));
}

export async function editPost(
  pool: Pool,
  identity: Identity,
  seatId: Uuid,
  input: { readonly title?: unknown },
): Promise<AdminResult<RosterPost>> {
  const owner = await departmentOfSeat(pool, seatId);
  if (owner === null) return refuse(404, 'no such post');
  const denied = reach<RosterPost>(identity, owner);
  if (denied !== null) return denied;

  const title = text(input.title);
  if (title === undefined) return refuse(400, 'a post cannot be renamed to nothing');

  return settle(await renamePost(pool, seatId, title, actorOf(identity)));
}

export async function retirePost(
  pool: Pool,
  identity: Identity,
  seatId: Uuid,
  retired: boolean,
  reason: unknown,
): Promise<AdminResult<RosterPost>> {
  const owner = await departmentOfSeat(pool, seatId);
  if (owner === null) return refuse(404, 'no such post');
  const denied = reach<RosterPost>(identity, owner);
  if (denied !== null) return denied;

  const why = text(reason);
  if (why === undefined) {
    return refuse(400, retired ? 'say why this post is being retired' : 'say why it is returning');
  }

  return settle(await setPostRetired(pool, seatId, retired, why, actorOf(identity)));
}

//------------------------------------------------------------------------------
// People
//------------------------------------------------------------------------------

export async function addRosterPerson(
  pool: Pool,
  identity: Identity,
  departmentId: Uuid,
  input: {
    readonly fullName?: unknown;
    readonly phone?: unknown;
    readonly seatId?: unknown;
    readonly placeholder?: unknown;
  },
): Promise<AdminResult<RosterPerson>> {
  const denied = reach<RosterPerson>(identity, departmentId);
  if (denied !== null) return denied;

  const fullName = text(input.fullName);
  if (fullName === undefined) return refuse(400, 'a person needs a name');

  const phone = text(input.phone);
  if (phone === undefined) {
    return refuse(400, 'a person needs a number — mark it as a placeholder if it is a stand-in');
  }

  // Putting them into a post is optional, but if a post is named it must belong to this
  // department. Otherwise a department could staff someone else's post from its own screen.
  let seatId: Uuid | null = null;
  if (typeof input.seatId === 'string') {
    const owner = await departmentOfSeat(pool, input.seatId);
    if (owner !== departmentId) return refuse(400, 'that post is not in this department');
    seatId = input.seatId;
  }

  return settle(
    await addPerson(
      pool,
      { fullName, phone, placeholder: input.placeholder === true },
      seatId,
      actorOf(identity),
    ),
  );
}

export async function editRosterPerson(
  pool: Pool,
  identity: Identity,
  personId: Uuid,
  input: { readonly fullName?: unknown; readonly phone?: unknown },
): Promise<AdminResult<RosterPerson>> {
  const denied = await reachPerson<RosterPerson>(pool, identity, personId);
  if (denied !== null) return denied;

  return settle(
    await updatePerson(
      pool,
      personId,
      {
        ...(text(input.fullName) !== undefined ? { fullName: text(input.fullName)! } : {}),
        ...(text(input.phone) !== undefined ? { phone: text(input.phone)! } : {}),
      },
      actorOf(identity),
    ),
  );
}

export async function removeRosterPerson(
  pool: Pool,
  identity: Identity,
  personId: Uuid,
  reason: unknown,
): Promise<AdminResult<{ readonly removed: true }>> {
  const denied = await reachPerson<{ readonly removed: true }>(pool, identity, personId);
  if (denied !== null) return denied;

  const why = text(reason);
  if (why === undefined) return refuse(400, 'say why they are being removed');

  // Removing yourself would end your own session mid-request and, for the last
  // administrator, leave the district with nobody able to undo it.
  if (personId === identity.personId) {
    return refuse(409, 'you cannot remove yourself — ask the other office to do it');
  }

  return settle(await removePerson(pool, personId, why, actorOf(identity)));
}

export async function grantRosterAccount(
  pool: Pool,
  identity: Identity,
  personId: Uuid,
  input: { readonly password?: unknown },
): Promise<AdminResult<{ readonly granted: true }>> {
  const denied = await reachPerson<{ readonly granted: true }>(pool, identity, personId);
  if (denied !== null) return denied;

  const password = typeof input.password === 'string' ? input.password : '';
  if (password.length < 12) return refuse(400, 'a password must be at least 12 characters');

  return settle(await grantAccount(pool, personId, password, actorOf(identity)));
}

//------------------------------------------------------------------------------
// Assignments
//------------------------------------------------------------------------------

export async function assign(
  pool: Pool,
  identity: Identity,
  seatId: Uuid,
  input: { readonly personId?: unknown },
): Promise<AdminResult<{ readonly assigned: true }>> {
  const owner = await departmentOfSeat(pool, seatId);
  if (owner === null) return refuse(404, 'no such post');
  const denied = reach<{ readonly assigned: true }>(identity, owner);
  if (denied !== null) return denied;

  if (typeof input.personId !== 'string') return refuse(400, 'name the person to put in the post');

  return settle(await assignToPost(pool, seatId, input.personId, actorOf(identity)));
}

export async function relieve(
  pool: Pool,
  identity: Identity,
  seatId: Uuid,
  reason: unknown,
): Promise<AdminResult<{ readonly relieved: true }>> {
  const owner = await departmentOfSeat(pool, seatId);
  if (owner === null) return refuse(404, 'no such post');
  const denied = reach<{ readonly relieved: true }>(identity, owner);
  if (denied !== null) return denied;

  const why = text(reason);
  if (why === undefined) return refuse(400, 'say why they are being taken off this post');

  return settle(await relieveFromPost(pool, seatId, why, actorOf(identity)));
}

//------------------------------------------------------------------------------

function actorOf(identity: Identity): { seatId: string | null; personId: string | null } {
  return { seatId: identity.seatId, personId: identity.personId };
}

async function departmentOfSeat(pool: Pool, seatId: Uuid): Promise<Uuid | null> {
  const { rows } = await pool.query<{ department_id: string | null }>(
    'SELECT department_id FROM seat WHERE seat_id = $1',
    [seatId],
  );
  return rows[0]?.department_id ?? null;
}

/**
 * Scope a person to a department.
 *
 * Two ways a person belongs to a department, and the second one is not obvious:
 *
 * 1. **They hold a post in it.** The ordinary case.
 * 2. **A seat in it created them, and they hold no post anywhere.** Adding a contact and
 *    assigning them to a post are separate acts, deliberately — a department needs to record
 *    somebody before deciding which post they will hold, and it must be able to correct a
 *    mistyped number in between. Without this, a department could create a person and then
 *    immediately be locked out of the row it had just written.
 *
 * The moment somebody holds a post in **another** department, that department owns them and
 * this returns 403 — which is the case worth protecting: an officer who has transferred out
 * must not still have their number editable by the department they left.
 */
async function reachPerson<T>(
  pool: Pool,
  identity: Identity,
  personId: Uuid,
): Promise<AdminResult<T> | null> {
  if (identity.seatId === null) {
    return refuse(403, 'you hold no seat right now, so you hold no authority (ADR-0004)');
  }
  if (identity.isAdministration) return null;

  const { rows } = await pool.query<{
    holds_here: boolean;
    holds_anywhere: boolean;
    created_here: boolean;
  }>(
    `SELECT EXISTS (
              SELECT 1 FROM duty_assignment d
                JOIN seat s ON s.seat_id = d.seat_id
               WHERE d.person_id = $1 AND d.to_at IS NULL AND s.department_id = $2
            ) AS holds_here,
            EXISTS (
              SELECT 1 FROM duty_assignment d
               WHERE d.person_id = $1 AND d.to_at IS NULL
            ) AS holds_anywhere,
            EXISTS (
              SELECT 1 FROM person p
                JOIN seat s ON s.seat_id = p.created_by_seat_id
               WHERE p.person_id = $1 AND s.department_id = $2
            ) AS created_here`,
    [personId, identity.departmentId],
  );

  const row = rows[0];
  if (row === undefined) return refuse(403, 'no such person');
  if (row.holds_here) return null;
  if (row.created_here && !row.holds_anywhere) return null;

  return refuse(403, 'that person does not hold a post in your department');
}
