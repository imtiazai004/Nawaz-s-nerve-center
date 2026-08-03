/**
 * Who to ring, and on what number — M5.
 *
 * The owner's correction, 2026-08-03, after I built a great deal that was not asked for:
 *
 *   > mai ye chahta tha k jub departments k sath ju numbers hain … un ko DC and AC HQ offices
 *   > ya koi bhi … kese department ko asign karna chahe tou un k number pr directly call kar
 *   > skte ho, es ka ye matlab nhe hai k software call karega … ju banda alert jare karega ya
 *   > escalate karega … un ko mutalqa number mil jaye and us pr click kare tou contact karne
 *   > ka channel selection mai ho … es mai Meta business account, telephony ya SMS gateway ki
 *   > koi zarurt nhe hai
 *
 * So this endpoint does one thing: **it hands an officer the number.** What happens next is a
 * `wa.me` link, a `tel:` link or an `sms:` link opening on their own handset, and a human
 * having a conversation. Nothing here sends anything, and nothing here needs an account with
 * anybody.
 *
 * That is a better design than the one it replaces, and not only because it is smaller. A
 * ladder of providers can fail in ways nobody sees — a template unapproved, a gateway out of
 * credit, a modem with no signal — and every one of those failures is discovered on the night
 * it matters. An officer who dialled a number knows within ten seconds whether it rang.
 *
 * ## What this is careful about
 *
 * **Behind a session, always.** These are officers' personal mobiles. The dashboard's own
 * safety check still refuses to let a number anywhere near a screen a room can read — this is
 * the other kind of screen, the one a named person signed into.
 *
 * **A placeholder is never offered as a number.** A stand-in fills a post so the roster is
 * complete; dialling it reaches nobody, and finding that out at 02:00 is the failure this
 * whole system exists to prevent. It is returned, and it is returned marked.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from '../db/pool.js';
import type { Identity } from '../auth/sessions.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ContactLine {
  /** The post — "District Emergency Officer". Authority attaches here, not to a name. */
  readonly seatTitle: string;
  /** Who currently holds it. Null when nobody does, which is a fact worth showing. */
  readonly holder: string | null;
  readonly phone: string | null;
  /**
   * A stand-in number, filling the post so the roster is complete.
   *
   * Offered, and offered marked. Hiding it would leave a post looking unreachable when it is
   * merely un-filled, and those need different actions from the district.
   */
  readonly placeholder: boolean;
}

export interface DepartmentContacts {
  readonly departmentId: string;
  readonly name: string;
  /** The department's own published or office line. Answered in office hours, if at all. */
  readonly officePhone: string | null;
  /** The posts, duty-bearing first — that is who somebody escalating is looking for. */
  readonly posts: readonly ContactLine[];
}

export interface ContactsReply {
  readonly status: number;
  readonly body: unknown;
}

/**
 * Every way to reach one department.
 *
 * Posts first and the office number second, because the two answer different questions: the
 * post is who is on duty now, and the office is what to try when nobody is.
 */
export async function departmentContacts(
  pool: Pool,
  departmentId: string,
): Promise<DepartmentContacts | null> {
  const found = await pool.query<{ department_id: string; name: string; contact_phone: string | null }>(
    'SELECT department_id, name, contact_phone FROM department WHERE department_id = $1',
    [departmentId],
  );

  const department = found.rows[0];
  if (department === undefined) return null;

  const posts = await pool.query<{
    title: string;
    full_name: string | null;
    phone: string | null;
    placeholder: boolean | null;
  }>(
    `SELECT s.title,
            p.full_name,
            p.phone,
            p.placeholder
       FROM seat s
       LEFT JOIN duty_assignment a
              ON a.seat_id = s.seat_id
             AND a.from_at <= now()
             AND (a.to_at IS NULL OR a.to_at > now())
       LEFT JOIN person p
              ON p.person_id = a.person_id
             AND p.removed_at IS NULL
             AND p.disabled_at IS NULL
      WHERE s.department_id = $1
        AND s.retired_at IS NULL
      -- A post somebody holds, before an empty one: whoever is escalating wants a person.
      ORDER BY p.phone IS NULL, s.title`,
    [departmentId],
  );

  return {
    departmentId: department.department_id,
    name: department.name,
    officePhone: department.contact_phone,
    posts: posts.rows.map((row) => ({
      seatTitle: row.title,
      holder: row.full_name,
      phone: row.phone,
      placeholder: row.placeholder ?? false,
    })),
  };
}

/**
 * Serve the numbers for a department.
 *
 * **Any signed-in officer may read these, and that is the point.** The person who needs to
 * reach Rescue at 02:00 is whoever is awake, not whoever happens to hold the right department.
 * Scoping this the way the roster is scoped would mean a control room that can see an
 * emergency is with Rescue and cannot see how to ring them.
 *
 * The line that is *not* crossed: this is behind a session, and the numbers never reach the
 * dashboard, which is the screen a room can read (ADR-0013 §1).
 */
export async function handleContacts(
  pool: Pool,
  req: IncomingMessage,
  path: string,
  identity: Identity,
): Promise<ContactsReply> {
  if (req.method !== 'GET') return { status: 405, body: { error: 'method not allowed' } };

  const match = /^\/contacts\/department\/([^/]+)$/.exec(path);
  if (match === null) return { status: 404, body: { error: 'no such endpoint' } };

  const id = match[1]!;
  if (!UUID_RE.test(id)) return { status: 400, body: { error: 'which department?' } };

  const contacts = await departmentContacts(pool, id);
  if (contacts === null) return { status: 404, body: { error: 'no such department' } };

  // `identity` is required by the route and deliberately not used to narrow the result. See
  // the note above: narrowing it would break the case this exists for.
  void identity;

  return { status: 200, body: contacts };
}

export function writeContacts(res: ServerResponse, reply: ContactsReply): void {
  const body = JSON.stringify(reply.body);
  res.writeHead(reply.status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    // Never cached. A number that changed this morning must not be served from this morning.
    'cache-control': 'no-store',
  });
  res.end(body);
}
