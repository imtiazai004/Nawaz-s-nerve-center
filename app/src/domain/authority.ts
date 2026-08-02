/**
 * Authority as data, not `if` statements. See ADR-0003 and docs/04-authority-model.md.
 *
 * Every writable field carries a rule. The rules are a table an administrator can read
 * and change; they are not scattered role comparisons that nobody can audit. Adding a
 * department is rows, not a release.
 *
 * Nothing here is a substitute for enforcing this server-side at every mutation endpoint
 * (INV-05). This module is the decision; the endpoint is the gate.
 */

import type { Uuid } from './events.js';

/**
 * Where a seat sits in the ladder. Higher wins a conflict. **There are two rungs.**
 *
 * This was `station | tehsil | district | provincial` — a generic hierarchy invented before
 * anybody had told us how Bannu is organised. ADR-0010 replaced it with the district's own
 * answer, and migration 0010 collapsed the column to match.
 *
 * The two dead values were not harmless while they lasted. The contact list has no tier
 * column, so the loader defaulted all 83 of the district's posts to `district` — and
 * `evaluateRead` widened at tehsil, which meant every department could read every other
 * department's incidents. Four values nobody chose from produced a default nobody noticed.
 *
 * A seat is `district` exactly when its office is administrative, or when it belongs to no
 * department at all. That is not a caller's choice: a database trigger derives it (0010).
 */
export type Tier = 'department' | 'district';

export const TIER_ORDER: readonly Tier[] = ['department', 'district'];

export function tierRank(t: Tier): number {
  return TIER_ORDER.indexOf(t);
}

export interface Seat {
  readonly seatId: Uuid;
  readonly departmentId: Uuid | null;
  readonly tier: Tier;
  /** Seats permitted to act outside the policy table, with a reason. Always audited. */
  readonly canBreakGlass?: boolean;
}

export interface AuthorityRule {
  readonly fieldKey: string;
  /** The department that owns the field. `null` means system-owned. */
  readonly ownerDepartmentId: Uuid | null;
  /** Seat ids, or tiers, permitted to override the owner. */
  readonly overrideSeatIds?: readonly Uuid[];
  readonly overrideTiers?: readonly Tier[];
  readonly reasonRequired: boolean;
  readonly visibleToOwner: 'none' | 'yes' | 'yes_and_notify';
  /** Append-only fields cannot be overridden by anyone. */
  readonly appendOnly?: boolean;
}

export type Decision =
  | { readonly allowed: true; readonly as: 'owner' | 'override' | 'break_glass' }
  | { readonly allowed: false; readonly why: string };

export interface WriteAttempt {
  readonly fieldKey: string;
  readonly seat: Seat;
  readonly reason?: string | undefined;
  /** Set only when the actor is deliberately invoking emergency powers. */
  readonly breakGlass?: boolean;
}

/**
 * Decide whether a write is permitted.
 *
 * Order matters: ownership first, then delegated override authority, then break-glass.
 * Break-glass is deliberately last and deliberately present — an escape hatch that does
 * not exist gets replaced by shared passwords, which is strictly worse than one that is
 * logged and reviewed.
 */
export function evaluateWrite(rule: AuthorityRule, attempt: WriteAttempt): Decision {
  if (rule.fieldKey !== attempt.fieldKey) {
    return { allowed: false, why: `rule ${rule.fieldKey} does not govern ${attempt.fieldKey}` };
  }

  const isOwner =
    rule.ownerDepartmentId !== null && attempt.seat.departmentId === rule.ownerDepartmentId;

  if (rule.appendOnly) {
    return isOwner
      ? { allowed: true, as: 'owner' }
      : { allowed: false, why: `${rule.fieldKey} is append-only by its owning department` };
  }

  if (isOwner) return { allowed: true, as: 'owner' };

  const bySeat = rule.overrideSeatIds?.includes(attempt.seat.seatId) ?? false;
  const byTier = rule.overrideTiers?.includes(attempt.seat.tier) ?? false;

  if (bySeat || byTier) {
    if (rule.reasonRequired && !isNonEmpty(attempt.reason)) {
      return { allowed: false, why: `${rule.fieldKey} requires a reason to override` };
    }
    return { allowed: true, as: 'override' };
  }

  if (attempt.breakGlass === true && attempt.seat.canBreakGlass === true) {
    // Never waived, no matter who is asking. An unexplained emergency override is
    // indistinguishable from an abuse of one.
    if (!isNonEmpty(attempt.reason)) {
      return { allowed: false, why: 'break-glass always requires a reason' };
    }
    return { allowed: true, as: 'break_glass' };
  }

  return {
    allowed: false,
    why: `seat ${attempt.seat.seatId} has no authority over ${rule.fieldKey}`,
  };
}

export interface ReadAttempt {
  readonly seat: Seat;
  /** Empty while an incident is still unrouted — nobody owns it yet. */
  readonly responsibleDepartmentIds: readonly Uuid[];
}

/**
 * Decide whether a seat may read an incident at all.
 *
 * Cross-department access is denied by default (docs/04-authority-model.md). A station-tier
 * Police seat has no business reading Rescue's incidents, and "the UI does not link to it"
 * is not a control (INV-05).
 *
 * Two deliberate widenings:
 *
 * - **The two administrative offices may read everything.** Not a convenience. They hold
 *   the routing and override authority in the policy table, and authority to change a value
 *   you are not allowed to look at is not authority, it is guesswork. This used to say
 *   "tehsil and above", which in the district's real data meant everybody — see `Tier`.
 * - **An unrouted incident is readable by any seat.** Until routing has happened nobody owns
 *   it, and an emergency nobody is permitted to see is an emergency nobody picks up
 *   (INV-01). The window is small and closes at the first `routed` event.
 */
export function evaluateRead(attempt: ReadAttempt): Decision {
  if (attempt.responsibleDepartmentIds.length === 0) {
    return { allowed: true, as: 'owner' };
  }

  if (
    attempt.seat.departmentId !== null &&
    attempt.responsibleDepartmentIds.includes(attempt.seat.departmentId)
  ) {
    return { allowed: true, as: 'owner' };
  }

  if (tierRank(attempt.seat.tier) >= tierRank('district')) {
    return { allowed: true, as: 'override' };
  }

  return {
    allowed: false,
    why: `seat ${attempt.seat.seatId} is not in a responsible department for this incident`,
  };
}

/**
 * Resolve two writes to the same field in the same window.
 *
 * Authority first, then time. The loser is never silently discarded — the caller is
 * expected to surface it as a visible conflict, so a disagreement between a department
 * and the control room is made explicit rather than settled by whoever saved last.
 */
export function resolveConflict(
  a: { readonly seat: Seat; readonly at: string },
  b: { readonly seat: Seat; readonly at: string },
): { readonly winner: 'a' | 'b'; readonly by: 'authority' | 'time' } {
  const ra = tierRank(a.seat.tier);
  const rb = tierRank(b.seat.tier);
  if (ra !== rb) return { winner: ra > rb ? 'a' : 'b', by: 'authority' };
  return { winner: a.at >= b.at ? 'a' : 'b', by: 'time' };
}

function isNonEmpty(s: string | undefined): s is string {
  return typeof s === 'string' && s.trim().length > 0;
}

/**
 * The starting policy table from docs/04-authority-model.md.
 *
 * Department ids are placeholders until the registry exists. This lives in code only
 * until there is a database to hold it — it is a table, not logic, by design.
 *
 * `responsibleDepartmentId` is null while an incident is unrouted. Every owner-held field
 * then has no owner, which leaves only the override tiers — so an untriaged, unrouted
 * incident can be acted on by the control room and by nobody else. That is the correct
 * answer: before routing, the control room is who holds it.
 */
export function defaultRules(responsibleDepartmentId: Uuid | null): readonly AuthorityRule[] {
  return [
    {
      fieldKey: 'incident.severity',
      ownerDepartmentId: responsibleDepartmentId,
      overrideTiers: ['district'],
      reasonRequired: true,
      visibleToOwner: 'yes',
    },
    {
      fieldKey: 'incident.category',
      ownerDepartmentId: responsibleDepartmentId,
      overrideTiers: ['district'],
      reasonRequired: true,
      visibleToOwner: 'yes',
    },
    {
      fieldKey: 'incident.responsibleDepartment',
      ownerDepartmentId: null,
      overrideTiers: ['district'],
      reasonRequired: true,
      visibleToOwner: 'yes_and_notify',
    },
    {
      /**
       * New row (M0-28). Acknowledgement is an act of the department that owns the
       * incident — but the escalation ladder can move the obligation to a district seat
       * when the department stays silent (ADR-0004, ADR-0005), and that seat must then be
       * able to take it. Hence a district override, with a reason: the control room
       * acknowledging on a department's behalf is exactly the thing that should be
       * explainable afterwards, since acknowledgement stops the SLA clock.
       */
      fieldKey: 'incident.acknowledgement',
      ownerDepartmentId: responsibleDepartmentId,
      overrideTiers: ['district'],
      reasonRequired: true,
      visibleToOwner: 'yes_and_notify',
    },
    {
      fieldKey: 'incident.actions',
      ownerDepartmentId: responsibleDepartmentId,
      reasonRequired: false,
      visibleToOwner: 'none',
      appendOnly: true,
    },
    {
      fieldKey: 'incident.closure',
      ownerDepartmentId: responsibleDepartmentId,
      overrideTiers: ['district'],
      reasonRequired: true,
      visibleToOwner: 'yes_and_notify',
    },
  ];
}
