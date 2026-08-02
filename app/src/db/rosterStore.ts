/**
 * The roster: who holds which post in which department, and how to reach them.
 *
 * The system routes to a **post**, not a person (ADR-0004). "Rescue 1122 — District
 * Emergency Officer" exists whether or not anyone is sitting in it, and it survives every
 * transfer order. This module is what turns *tell the District Emergency Officer* into a
 * human with a number.
 *
 * Three rules run through everything here, and all three are the same rule:
 *
 * 1. **Nothing is deleted.** Posts retire, people are removed, assignments end. Past events
 *    name the seat that acted and the person who held it, and those must keep resolving
 *    (ADR-0001). A deleted post makes its own history unreadable.
 * 2. **A directory contact is not an account.** Adding somebody so the system can *notify*
 *    them is one act; giving them a *login* is a second, deliberate one. Creating a
 *    credential for a person who has never been told this system exists is a liability, not
 *    a convenience — a password nobody chose, on an account nobody watches.
 * 3. **Every change is recorded** in `config_event`, with a reason where it stops somebody
 *    being reachable. *Who took the duty officer off that post the week nobody answered?* is
 *    the question this table exists to answer.
 *
 * Scoping lives in `api/roster.ts`, not here. This is the store.
 */

import type { Pool, PoolClient } from 'pg';

import type { Uuid } from '../domain/events.js';
import { inTransaction, recordChange, type ConfigActor } from './configStore.js';
import { hashPassword } from '../auth/passwords.js';

export type { Tier } from '../domain/authority.js';
import type { Tier } from '../domain/authority.js';

export interface RosterPerson {
  readonly personId: Uuid;
  readonly fullName: string;
  readonly phone: string;
  /** The number is a stand-in, not theirs. Never notified, always labelled (migration 0008). */
  readonly placeholder: boolean;
  /** They can sign in. A directory contact cannot, and most of the district's list cannot. */
  readonly hasAccount: boolean;
  readonly disabledAt: string | null;
}

export interface RosterPost {
  readonly seatId: Uuid;
  readonly title: string;
  readonly departmentId: Uuid | null;
  readonly tier: Tier;
  readonly retiredAt: string | null;
  /** Whoever holds it right now, or null. A null holder is a real operational gap. */
  readonly holder: RosterPerson | null;
  readonly heldSince: string | null;
}

export interface DepartmentRoster {
  readonly departmentId: Uuid;
  readonly departmentName: string;
  readonly posts: readonly RosterPost[];
  /** Live posts with nobody in them, or with a placeholder number. Nothing can reach these. */
  readonly unreachablePosts: number;
}

interface PostRow {
  seat_id: string;
  title: string;
  department_id: string | null;
  tier: Tier;
  retired_at: string | null;
  person_id: string | null;
  full_name: string | null;
  phone: string | null;
  placeholder: boolean | null;
  has_account: boolean | null;
  disabled_at: string | null;
  from_at: string | null;
}

function toPost(r: PostRow): RosterPost {
  return {
    seatId: r.seat_id,
    title: r.title,
    departmentId: r.department_id,
    tier: r.tier,
    retiredAt: r.retired_at,
    holder:
      r.person_id === null
        ? null
        : {
            personId: r.person_id,
            fullName: r.full_name ?? '',
            phone: r.phone ?? '',
            placeholder: r.placeholder === true,
            hasAccount: r.has_account === true,
            disabledAt: r.disabled_at,
          },
    heldSince: r.from_at,
  };
}

/**
 * The `has_account` column is derived, not stored.
 *
 * A person can authenticate exactly when they have a password hash — the same condition
 * `login()` filters on (migration 0006). Storing a second boolean beside it would create two
 * answers to "can this person sign in?", and they would disagree eventually.
 */
const POST_SELECT = `
  SELECT s.seat_id, s.title, s.department_id, s.tier, s.retired_at,
         p.person_id, p.full_name, p.phone, p.placeholder,
         (p.password_hash IS NOT NULL) AS has_account,
         p.disabled_at, d.from_at
    FROM seat s
    LEFT JOIN duty_assignment d
           ON d.seat_id = s.seat_id AND d.to_at IS NULL
    LEFT JOIN person p
           ON p.person_id = d.person_id AND p.removed_at IS NULL`;

export async function rosterFor(pool: Pool, departmentId: Uuid): Promise<DepartmentRoster | null> {
  const dept = await pool.query<{ name: string }>(
    'SELECT name FROM department WHERE department_id = $1',
    [departmentId],
  );
  if (dept.rows[0] === undefined) return null;

  const { rows } = await pool.query<PostRow>(
    `${POST_SELECT}
      WHERE s.department_id = $1
      ORDER BY s.retired_at IS NOT NULL, s.title`,
    [departmentId],
  );

  const posts = rows.map(toPost);
  return {
    departmentId,
    departmentName: dept.rows[0].name,
    posts,
    // A post nothing can reach, counted the same way whether it is empty or holds a
    // stand-in number. Both mean the same thing on the night it matters, and the console
    // should not make an administrator work out that they are equivalent.
    unreachablePosts: posts.filter(
      (p) => p.retiredAt === null && (p.holder === null || p.holder.placeholder),
    ).length,
  };
}

/** People a department may put into its posts: its own, plus anyone unassigned. */
export async function peopleFor(pool: Pool, departmentId: Uuid): Promise<readonly RosterPerson[]> {
  const { rows } = await pool.query<{
    person_id: string;
    full_name: string;
    phone: string;
    placeholder: boolean;
    has_account: boolean;
    disabled_at: string | null;
  }>(
    `SELECT DISTINCT p.person_id, p.full_name, p.phone, p.placeholder,
            (p.password_hash IS NOT NULL) AS has_account, p.disabled_at
       FROM person p
       JOIN duty_assignment d ON d.person_id = p.person_id AND d.to_at IS NULL
       JOIN seat s ON s.seat_id = d.seat_id
      WHERE s.department_id = $1 AND p.removed_at IS NULL
      ORDER BY p.full_name`,
    [departmentId],
  );

  return rows.map((r) => ({
    personId: r.person_id,
    fullName: r.full_name,
    phone: r.phone,
    placeholder: r.placeholder,
    hasAccount: r.has_account,
    disabledAt: r.disabled_at,
  }));
}

//------------------------------------------------------------------------------
// Posts
//------------------------------------------------------------------------------

export type RosterResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly why: string };

async function readPost(tx: PoolClient, seatId: Uuid): Promise<RosterPost | null> {
  const { rows } = await tx.query<PostRow>(`${POST_SELECT} WHERE s.seat_id = $1`, [seatId]);
  return rows[0] === undefined ? null : toPost(rows[0]);
}

export async function createPost(
  pool: Pool,
  departmentId: Uuid,
  title: string,
  tier: Tier,
  actor: ConfigActor,
): Promise<RosterResult<RosterPost>> {
  return inTransaction(pool, async (tx) => {
    const dept = await tx.query<{ retired_at: string | null }>(
      'SELECT retired_at FROM department WHERE department_id = $1',
      [departmentId],
    );
    if (dept.rows[0] === undefined) return { ok: false as const, why: 'no such department' };
    if (dept.rows[0].retired_at !== null) {
      return { ok: false as const, why: 'that department is retired' };
    }

    const dup = await tx.query(
      'SELECT 1 FROM seat WHERE department_id = $1 AND lower(title) = lower($2) AND retired_at IS NULL',
      [departmentId, title],
    );
    if ((dup.rowCount ?? 0) > 0) {
      // Two live posts with the same title make "who do I notify" ambiguous in exactly the
      // way `duty_one_current_holder_per_seat` exists to prevent one level down.
      return { ok: false as const, why: 'this department already has a post with that title' };
    }

    const { rows } = await tx.query<{ seat_id: string }>(
      `INSERT INTO seat (title, department_id, tier, can_break_glass)
       VALUES ($1, $2, $3, false) RETURNING seat_id`,
      [title, departmentId, tier],
    );
    const post = (await readPost(tx, rows[0]!.seat_id))!;

    await recordChange(tx, {
      subject: 'seat',
      subjectId: post.seatId,
      action: 'created',
      before: null,
      after: { title, departmentId, tier },
      actor,
    });
    return { ok: true as const, value: post };
  });
}

export async function renamePost(
  pool: Pool,
  seatId: Uuid,
  title: string,
  actor: ConfigActor,
): Promise<RosterResult<RosterPost>> {
  return inTransaction(pool, async (tx) => {
    const before = await readPost(tx, seatId);
    if (before === null) return { ok: false as const, why: 'no such post' };

    await tx.query('UPDATE seat SET title = $2 WHERE seat_id = $1', [seatId, title]);
    const after = (await readPost(tx, seatId))!;

    await recordChange(tx, {
      subject: 'seat',
      subjectId: seatId,
      action: 'updated',
      before: { title: before.title },
      after: { title },
      actor,
    });
    return { ok: true as const, value: after };
  });
}

/**
 * Retire a post, or bring one back.
 *
 * Retiring ends the current assignment too. A post that no longer exists cannot be held, and
 * leaving somebody attached to it would keep them in the notification path for work nobody
 * is meant to be doing — silently, which is the failure mode that matters.
 */
export async function setPostRetired(
  pool: Pool,
  seatId: Uuid,
  retired: boolean,
  reason: string,
  actor: ConfigActor,
): Promise<RosterResult<RosterPost>> {
  return inTransaction(pool, async (tx) => {
    const before = await readPost(tx, seatId);
    if (before === null) return { ok: false as const, why: 'no such post' };

    await tx.query(
      `UPDATE seat SET retired_at = ${retired ? 'now()' : 'NULL'} WHERE seat_id = $1`,
      [seatId],
    );
    if (retired) {
      await tx.query(
        'UPDATE duty_assignment SET to_at = now() WHERE seat_id = $1 AND to_at IS NULL',
        [seatId],
      );
    }

    const after = (await readPost(tx, seatId))!;
    await recordChange(tx, {
      subject: 'seat',
      subjectId: seatId,
      action: retired ? 'retired' : 'restored',
      // Summarised, not the whole post. A `RosterPost` carries its holder's **phone number**,
      // and `config_event` is rendered on a screen and copied into every backup that leaves
      // the district. The person row is the one place a contact number needs to live — the
      // same rule `obs/log.ts` applies to log lines, one table over. A test pins it.
      before: { title: before.title, heldBy: before.holder?.fullName ?? null },
      after: { title: after.title, heldBy: after.holder?.fullName ?? null },
      actor,
      reason,
    });
    return { ok: true as const, value: after };
  });
}

//------------------------------------------------------------------------------
// People
//------------------------------------------------------------------------------

export interface NewPerson {
  readonly fullName: string;
  readonly phone: string;
  /** Mark the number as a stand-in. Filled post, no real contact (migration 0008). */
  readonly placeholder?: boolean;
}

/**
 * Add somebody to the directory, and optionally put them straight into a post.
 *
 * **No password.** They become someone the system can notify, not someone who can sign in;
 * see rule 2 in the header. `grantAccount` is the separate, deliberate second step.
 */
export async function addPerson(
  pool: Pool,
  input: NewPerson,
  seatId: Uuid | null,
  actor: ConfigActor,
): Promise<RosterResult<RosterPerson>> {
  return inTransaction(pool, async (tx) => {
    const fullName = input.fullName.trim();
    const phone = input.phone.trim();

    const { rows } = await tx.query<{ person_id: string }>(
      `INSERT INTO person (full_name, phone, placeholder, created_by_seat_id)
       VALUES ($1, $2, $3, $4) RETURNING person_id`,
      [fullName, phone, input.placeholder === true, actor.seatId],
    );
    const personId = rows[0]!.person_id;

    if (seatId !== null) {
      const assigned = await assignWithin(tx, seatId, personId, actor);
      if (!assigned.ok) return assigned;
    }

    const person: RosterPerson = {
      personId,
      fullName,
      phone,
      placeholder: input.placeholder === true,
      hasAccount: false,
      disabledAt: null,
    };

    await recordChange(tx, {
      subject: 'person',
      subjectId: personId,
      action: 'created',
      before: null,
      // The number is deliberately not written into the log. `config_event` is read on a
      // screen and dumped in backups; the person row is the one place a contact number
      // needs to live, and `obs/log.ts` already refuses to let one reach a log line.
      after: { fullName, placeholder: input.placeholder === true },
      actor,
    });
    return { ok: true as const, value: person };
  });
}

export async function updatePerson(
  pool: Pool,
  personId: Uuid,
  edit: { readonly fullName?: string; readonly phone?: string },
  actor: ConfigActor,
): Promise<RosterResult<RosterPerson>> {
  return inTransaction(pool, async (tx) => {
    const existing = await tx.query<{
      full_name: string;
      phone: string;
      placeholder: boolean;
      has_account: boolean;
      disabled_at: string | null;
    }>(
      `SELECT full_name, phone, placeholder, (password_hash IS NOT NULL) AS has_account, disabled_at
         FROM person WHERE person_id = $1 AND removed_at IS NULL FOR UPDATE`,
      [personId],
    );
    const before = existing.rows[0];
    if (before === undefined) return { ok: false as const, why: 'no such person' };

    const fullName = edit.fullName?.trim() ?? before.full_name;
    const phone = edit.phone?.trim() ?? before.phone;

    // Typing a real number over a stand-in is how a placeholder is meant to end. Clearing
    // the flag here rather than requiring a second action means nobody has to remember —
    // and a placeholder nobody remembers to clear is a post that silently stops escalating.
    const stillPlaceholder = before.placeholder && phone === before.phone;

    await tx.query(
      'UPDATE person SET full_name = $2, phone = $3, placeholder = $4 WHERE person_id = $1',
      [personId, fullName, phone, stillPlaceholder],
    );

    await recordChange(tx, {
      subject: 'person',
      subjectId: personId,
      action: 'updated',
      before: { fullName: before.full_name, placeholder: before.placeholder },
      after: { fullName, placeholder: stillPlaceholder },
      actor,
    });

    return {
      ok: true as const,
      value: {
        personId,
        fullName,
        phone,
        placeholder: stillPlaceholder,
        hasAccount: before.has_account,
        disabledAt: before.disabled_at,
      },
    };
  });
}

/**
 * Remove somebody from the roster.
 *
 * Not a delete. They stop being offered as a contact and stop holding any post; every event
 * naming them still resolves to a name. An account, if they had one, is disabled and its
 * sessions are left to expire on their own short TTL.
 */
export async function removePerson(
  pool: Pool,
  personId: Uuid,
  reason: string,
  actor: ConfigActor,
): Promise<RosterResult<{ readonly removed: true }>> {
  return inTransaction(pool, async (tx) => {
    const existing = await tx.query<{ full_name: string }>(
      'SELECT full_name FROM person WHERE person_id = $1 AND removed_at IS NULL FOR UPDATE',
      [personId],
    );
    if (existing.rows[0] === undefined) return { ok: false as const, why: 'no such person' };

    await tx.query(
      'UPDATE person SET removed_at = now(), disabled_at = coalesce(disabled_at, now()) WHERE person_id = $1',
      [personId],
    );
    await tx.query(
      'UPDATE duty_assignment SET to_at = now() WHERE person_id = $1 AND to_at IS NULL',
      [personId],
    );
    await tx.query(
      'UPDATE session SET revoked_at = now() WHERE person_id = $1 AND revoked_at IS NULL',
      [personId],
    );

    await recordChange(tx, {
      subject: 'person',
      subjectId: personId,
      action: 'retired',
      before: { fullName: existing.rows[0].full_name },
      after: null,
      actor,
      reason,
    });
    return { ok: true as const, value: { removed: true } };
  });
}

/**
 * Give somebody a login.
 *
 * Separate from adding them, and it stays separate. The district's contact list is ~80
 * officials the system must be able to reach; that is not ~80 people who should have
 * credentials. Creating an account for someone who has not been told the system exists is a
 * password nobody chose on an account nobody watches.
 *
 * A shared office handset is fine for a contact and impossible for an account: migration
 * 0006 puts phone uniqueness only where a password hash exists, so this fails loudly at the
 * moment somebody tries — which is the right moment and the right person to tell.
 */
export async function grantAccount(
  pool: Pool,
  personId: Uuid,
  password: string,
  actor: ConfigActor,
): Promise<RosterResult<{ readonly granted: true }>> {
  if (password.trim().length < 12) {
    return { ok: false, why: 'a password must be at least 12 characters' };
  }

  const hash = await hashPassword(password);

  return inTransaction(pool, async (tx) => {
    const existing = await tx.query<{ placeholder: boolean; full_name: string }>(
      'SELECT placeholder, full_name FROM person WHERE person_id = $1 AND removed_at IS NULL FOR UPDATE',
      [personId],
    );
    const person = existing.rows[0];
    if (person === undefined) return { ok: false as const, why: 'no such person' };

    if (person.placeholder) {
      // The number on this row is a stand-in. An account on it would be an account nobody
      // can be told about, reached at a number that is not theirs.
      return {
        ok: false as const,
        why: 'this person holds a placeholder number — enter their real number first',
      };
    }

    try {
      await tx.query(
        'UPDATE person SET password_hash = $2, disabled_at = NULL WHERE person_id = $1',
        [personId, hash],
      );
    } catch {
      return {
        ok: false as const,
        why: 'another account already uses this number — a shared handset cannot have two logins',
      };
    }

    await recordChange(tx, {
      subject: 'person',
      subjectId: personId,
      action: 'updated',
      before: { hasAccount: false },
      after: { hasAccount: true },
      actor,
    });
    return { ok: true as const, value: { granted: true } };
  });
}

//------------------------------------------------------------------------------
// Assignments
//------------------------------------------------------------------------------

async function assignWithin(
  tx: PoolClient,
  seatId: Uuid,
  personId: Uuid,
  actor: ConfigActor,
): Promise<RosterResult<{ readonly assigned: true }>> {
  const seat = await tx.query<{ retired_at: string | null }>(
    'SELECT retired_at FROM seat WHERE seat_id = $1 FOR UPDATE',
    [seatId],
  );
  if (seat.rows[0] === undefined) return { ok: false, why: 'no such post' };
  if (seat.rows[0].retired_at !== null) return { ok: false, why: 'that post is retired' };

  // One holder per post, enforced by a unique index. Ending the previous assignment here
  // rather than failing is the honest reading of what an administrator means by "put this
  // person in that post": the handover is the point, and the outgoing holder's dates stay
  // in the record.
  await tx.query('UPDATE duty_assignment SET to_at = now() WHERE seat_id = $1 AND to_at IS NULL', [
    seatId,
  ]);
  await tx.query('INSERT INTO duty_assignment (seat_id, person_id) VALUES ($1, $2)', [
    seatId,
    personId,
  ]);

  await recordChange(tx, {
    subject: 'duty',
    subjectId: seatId,
    action: 'updated',
    before: null,
    after: { seatId, personId },
    actor,
  });
  return { ok: true, value: { assigned: true } };
}

export async function assignToPost(
  pool: Pool,
  seatId: Uuid,
  personId: Uuid,
  actor: ConfigActor,
): Promise<RosterResult<{ readonly assigned: true }>> {
  return inTransaction(pool, (tx) => assignWithin(tx, seatId, personId, actor));
}

/**
 * Take somebody out of a post without removing them from the district.
 *
 * A reason is required, and the database requires one too. This is the change most likely to
 * be asked about afterwards — *who took the duty officer off that post the week nobody
 * answered?* — and it leaves the post unreachable until somebody else is put in it.
 */
export async function relieveFromPost(
  pool: Pool,
  seatId: Uuid,
  reason: string,
  actor: ConfigActor,
): Promise<RosterResult<{ readonly relieved: true }>> {
  return inTransaction(pool, async (tx) => {
    const { rowCount } = await tx.query(
      'UPDATE duty_assignment SET to_at = now() WHERE seat_id = $1 AND to_at IS NULL',
      [seatId],
    );
    if ((rowCount ?? 0) === 0)
      return { ok: false as const, why: 'nobody currently holds that post' };

    await recordChange(tx, {
      subject: 'duty',
      subjectId: seatId,
      action: 'retired',
      before: { seatId },
      after: null,
      actor,
      reason,
    });
    return { ok: true as const, value: { relieved: true } };
  });
}
