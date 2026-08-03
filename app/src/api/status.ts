/**
 * Reporting the district's own condition — M4-02, M4-03, ADR-0013.
 *
 * Two facts the system did not previously hold, and one credential:
 *
 *   * **Utilities** — is the power on, the water, the gas, the line?
 *   * **Presence** — is the AAC in his office, in the field, or on leave?
 *   * **Wall screens** — the identity a television signs in as.
 *
 * The scoping follows the rule already established for the roster, and for the same stated
 * reason (owner, 2026-08-02): a department manages **its own** data, and nobody types on its
 * behalf. PESCO says whether PESCO is up. The AAC's office says where the AAC is. The two
 * administrative offices may do either for anyone, because somebody has to be able to correct
 * a department that has gone quiet — but they do it visibly, through the same recorded path.
 *
 * What a department may **not** do is decide which utilities the district watches, or issue a
 * screen a credential. Those are configuration, and configuration belongs to the two offices
 * for the same reason routing signals do (ADR-0010): a department able to remove itself from
 * the list could go quiet without anybody seeing it happen.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from '../db/pool.js';
import type { Identity } from '../auth/sessions.js';
import { inTransaction, recordChange } from '../db/configStore.js';
import {
  addUtility,
  issueWallScreen,
  listPresence,
  listUtilities,
  listWallScreens,
  reportPresence,
  reportUtility,
  retireUtility,
  revokeWallScreen,
  seatDepartment,
  utilityOwner,
} from '../db/wallStore.js';
import type { PresenceStatus, UtilityStatus } from '../domain/wall.js';

const UTILITY_STATUSES: readonly string[] = ['normal', 'degraded', 'down'];
const PRESENCE_STATUSES: readonly string[] = ['office', 'field', 'leave'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Free text that reaches a wall four metres away. Long enough to be useful, short enough to read. */
const MAX_NOTE = 120;

export interface StatusReply {
  readonly status: number;
  readonly body: unknown;
}

function bad(status: number, error: string): StatusReply {
  return { status, body: { error } };
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, max);
}

/**
 * Who may speak for a department.
 *
 * The administration may speak for anyone. Anybody else may speak only for their own
 * department — and a caller with no department at all (a control-room seat, a district post
 * outside the two offices) may speak for nobody, which is correct: they have no department
 * whose condition they could report.
 */
function mayReportFor(identity: Identity, departmentId: string | null): boolean {
  if (identity.isAdministration) return true;
  if (departmentId === null) return false;

  return identity.departmentId === departmentId;
}

export async function handleStatus(
  pool: Pool,
  req: IncomingMessage,
  path: string,
  identity: Identity,
  body: Record<string, unknown> | null,
): Promise<StatusReply> {
  const method = req.method ?? 'GET';

  //--------------------------------------------------------------------------------
  // Reading
  //--------------------------------------------------------------------------------

  if (method === 'GET' && path === '/status') {
    // Everyone signed in sees the whole picture. There is nothing private in it — it is the
    // same aggregate a television shows — and a department that cannot see whether the power
    // is out cannot plan around it.
    const [utilities, presence] = await Promise.all([
      listUtilities(pool),
      listPresence(pool, identity.isAdministration ? null : identity.departmentId),
    ]);

    return {
      status: 200,
      body: {
        utilities,
        presence,
        // What this caller is allowed to change, so the screen renders the right controls
        // rather than offering buttons that will be refused.
        canConfigure: identity.isAdministration,
        departmentId: identity.departmentId,
      },
    };
  }

  //--------------------------------------------------------------------------------
  // Reporting a utility
  //--------------------------------------------------------------------------------

  if (method === 'POST' && path === '/status/utility') {
    const utilityId = typeof body?.['utilityId'] === 'string' ? body['utilityId'] : '';
    const status = body?.['status'];

    if (!UUID_RE.test(utilityId)) return bad(400, 'which utility?');
    if (typeof status !== 'string' || !UTILITY_STATUSES.includes(status)) {
      return bad(400, 'status must be normal, degraded or down');
    }

    const owner = await utilityOwner(pool, utilityId);
    if (owner === null) return bad(404, 'no such utility');

    if (!mayReportFor(identity, owner.departmentId)) {
      return bad(403, 'only the department answerable for this utility may report it');
    }

    await reportUtility(pool, {
      utilityId,
      status: status as UtilityStatus,
      note: text(body?.['note'], MAX_NOTE),
      reportedBy: identity.seatId,
    });

    return { status: 201, body: { ok: true } };
  }

  //--------------------------------------------------------------------------------
  // Reporting presence
  //--------------------------------------------------------------------------------

  if (method === 'POST' && path === '/status/presence') {
    const seatId = typeof body?.['seatId'] === 'string' ? body['seatId'] : '';
    const status = body?.['status'];

    if (!UUID_RE.test(seatId)) return bad(400, 'which seat?');
    if (typeof status !== 'string' || !PRESENCE_STATUSES.includes(status)) {
      return bad(400, 'status must be office, field or leave');
    }

    const departmentId = await seatDepartment(pool, seatId);
    if (departmentId === false) return bad(404, 'no such seat');

    if (!mayReportFor(identity, departmentId)) {
      return bad(403, 'a department sets presence for its own seats');
    }

    /**
     * `field` and `leave` must say when they end; `office` need not.
     *
     * Not arbitrary. "In office" degrades safely — the worst case is somebody walks to a desk
     * and finds it empty. "In the field" and "on leave" are claims the district plans around,
     * and one left open forever becomes a permanent grey box that nobody trusts and nobody
     * fixes. Requiring an end means the record expires by itself instead of rotting.
     */
    const until = text(body?.['untilAt'], 40);

    if (status !== 'office') {
      if (until === null) return bad(400, 'say when this ends');
      if (Number.isNaN(new Date(until).getTime())) return bad(400, 'that is not a time');
    }

    await reportPresence(pool, {
      seatId,
      status: status as PresenceStatus,
      note: text(body?.['note'], MAX_NOTE),
      untilAt: status === 'office' ? null : until,
      reportedBy: identity.seatId,
    });

    return { status: 201, body: { ok: true } };
  }

  //--------------------------------------------------------------------------------
  // Which utilities the district watches — configuration, so the two offices only
  //--------------------------------------------------------------------------------

  if (method === 'POST' && path === '/status/utilities') {
    if (!identity.isAdministration) return bad(403, 'only the DC or AC Headquarter office');

    const name = text(body?.['name'], 60);
    if (name === null) return bad(400, 'a utility needs a name');

    const departmentId = typeof body?.['departmentId'] === 'string' ? body['departmentId'] : null;
    if (departmentId !== null && !UUID_RE.test(departmentId)) return bad(400, 'which department?');

    const stale = Number(body?.['staleMinutes'] ?? 240);
    if (!Number.isFinite(stale) || stale < 5 || stale > 10_080) {
      return bad(400, 'a report stays believable between 5 minutes and a week');
    }

    const utilityId = await addUtility(pool, {
      name,
      departmentId,
      staleMinutes: Math.round(stale),
    });

    await inTransaction(pool, (tx) =>
      recordChange(tx, {
        subject: 'utility',
        subjectId: utilityId,
        action: 'created',
        before: null,
        // The name and who answers for it. Never a number: config_event is rendered on a
        // screen and copied into every backup that leaves the district.
        after: { name, departmentId, staleMinutes: Math.round(stale) },
        actor: { seatId: identity.seatId, personId: identity.personId },
        reason: text(body?.['reason'], MAX_NOTE) ?? 'added to the district status board',
      }),
    );

    return { status: 201, body: { utilityId } };
  }

  if (method === 'POST' && path === '/status/utilities/retire') {
    if (!identity.isAdministration) return bad(403, 'only the DC or AC Headquarter office');

    const utilityId = typeof body?.['utilityId'] === 'string' ? body['utilityId'] : '';
    if (!UUID_RE.test(utilityId)) return bad(400, 'which utility?');

    const reason = text(body?.['reason'], MAX_NOTE);
    if (reason === null) return bad(400, 'say why');

    if (!(await retireUtility(pool, utilityId))) return bad(404, 'no such utility');

    await inTransaction(pool, (tx) =>
      recordChange(tx, {
        subject: 'utility',
        subjectId: utilityId,
        action: 'retired',
        before: null,
        after: null,
        actor: { seatId: identity.seatId, personId: identity.personId },
        reason,
      }),
    );

    return { status: 200, body: { ok: true } };
  }

  //--------------------------------------------------------------------------------
  // The screens themselves
  //--------------------------------------------------------------------------------

  if (method === 'GET' && path === '/status/screens') {
    if (!identity.isAdministration) return bad(403, 'only the DC or AC Headquarter office');

    return { status: 200, body: { screens: await listWallScreens(pool) } };
  }

  if (method === 'POST' && path === '/status/screens') {
    if (!identity.isAdministration) return bad(403, 'only the DC or AC Headquarter office');

    const label = text(body?.['label'], 60);
    if (label === null) return bad(400, 'name the room this screen is in');

    const issued = await issueWallScreen(pool, { label, issuedBy: identity.seatId });

    await inTransaction(pool, (tx) =>
      recordChange(tx, {
        subject: 'wall_screen',
        subjectId: issued.screenId,
        action: 'created',
        before: null,
        // The label and nothing else. Logging the token would put it in every nightly dump
        // in readable form, and the dump leaves the district (ADR-0011).
        after: { label },
        actor: { seatId: identity.seatId, personId: identity.personId },
        reason: text(body?.['reason'], MAX_NOTE) ?? 'a screen was mounted',
      }),
    );

    return {
      status: 201,
      body: {
        screenId: issued.screenId,
        label,
        token: issued.token,
        // Said on the screen, not only in a document, because this is the one moment it can
        // be said to the person who needs to act on it.
        note: 'This is shown once. It cannot be recovered — issue a new screen if it is lost.',
      },
    };
  }

  if (method === 'POST' && path === '/status/screens/revoke') {
    if (!identity.isAdministration) return bad(403, 'only the DC or AC Headquarter office');

    const screenId = typeof body?.['screenId'] === 'string' ? body['screenId'] : '';
    if (!UUID_RE.test(screenId)) return bad(400, 'which screen?');

    const reason = text(body?.['reason'], MAX_NOTE);
    if (reason === null) return bad(400, 'say why');

    if (!(await revokeWallScreen(pool, screenId)))
      return bad(404, 'no such screen, or already revoked');

    await inTransaction(pool, (tx) =>
      recordChange(tx, {
        subject: 'wall_screen',
        subjectId: screenId,
        action: 'retired',
        before: null,
        after: null,
        actor: { seatId: identity.seatId, personId: identity.personId },
        reason,
      }),
    );

    return { status: 200, body: { ok: true } };
  }

  return bad(404, 'no such endpoint');
}

export function writeStatus(res: ServerResponse, reply: StatusReply): void {
  const body = JSON.stringify(reply.body);
  res.writeHead(reply.status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}
