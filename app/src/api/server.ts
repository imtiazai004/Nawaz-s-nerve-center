import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

import { append, currentCursor, loadSince } from '../db/eventStore.js';
import type { Pool } from '../db/pool.js';
import type { IncidentEvent } from '../domain/events.js';
import {
  login,
  resolveSession,
  revokeSession,
  SESSION_TTL_HOURS,
  type Identity,
} from '../auth/sessions.js';
import { validateBatch, type PullResponse, type PushResponse } from './protocol.js';
import {
  applyCommand,
  intake,
  isSeverity,
  readIncident,
  seatOf,
  type Command,
  type CommandKind,
} from './lifecycle.js';
import { buildBoard } from './board.js';
import { inbox, markSeen } from './notifications.js';
import {
  addDepartment,
  addSignal,
  configHistory,
  departmentsForConsole,
  editDepartment,
  removeSignal,
  setRetired,
  setTarget,
  slaForConsole,
  integrity,
  type AdminResult,
} from './admin.js';
import { districtPerformance } from './performance.js';
import {
  addPost,
  addRosterPerson,
  assign,
  editPost,
  editRosterPerson,
  grantRosterAccount,
  readRoster,
  relieve,
  removeRosterPerson,
  retirePost,
} from './roster.js';
import {
  addResource,
  crew,
  dispatch,
  editResource,
  readFleet,
  release,
  retireResource,
  serviceState,
} from './resources.js';
import { download, listEvidence, upload } from './evidenceRoutes.js';
import { postIncidentReport } from './report.js';
import { listFor } from '../ops/evidence.js';
import { backupHealth } from '../ops/backup.js';
import { correlationIdFrom, log, withContext } from '../obs/log.js';

/**
 * The sync server. Plain `node:http`, no framework — see ADR-0007.
 *
 * Two endpoints carry the whole offline story: push a batch the device has been holding,
 * and pull whatever the device has missed. Everything else in the product is built on top
 * of these two.
 */

const MAX_BODY_BYTES = 5 * 1024 * 1024;

export type AuthMode = 'stub' | 'session';

export interface ServerOptions {
  readonly pool: Pool;
  /**
   * `stub` accepts any caller and is for local development only. Startup refuses it
   * outside development — see `assertAuthUsable`.
   */
  readonly authMode?: AuthMode;
  readonly nodeEnv?: string;
  /** Directory of built web assets. When absent, the server is API-only. */
  readonly webRoot?: string;
  /**
   * Where evidence files are written (M1-05).
   *
   * Outside the web root, always — a directory the server serves statically is a directory
   * where an uploaded file becomes a URL somebody's browser will open.
   */
  readonly evidenceRoot?: string;
}

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/**
 * Serve a built asset.
 *
 * `sw.js` is served with `Cache-Control: no-cache` on purpose. If the browser were allowed
 * to cache the service worker itself, a broken one could become unreplaceable — the very
 * component responsible for offline behaviour would be the one you could not fix.
 */
async function serveStatic(
  webRoot: string,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');

  // Refuse anything that escapes the web root. `..` in a URL is not a mistake to forgive.
  const target = normalize(join(webRoot, rel));
  if (!target.startsWith(normalize(webRoot) + sep) && target !== normalize(webRoot)) {
    res.writeHead(403).end();
    return true;
  }

  let body: Buffer;
  try {
    body = await readFile(target);
  } catch {
    return false;
  }

  const ext = extname(target);
  const isServiceWorker = rel === 'sw.js';

  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'content-length': body.length,
    'cache-control': isServiceWorker ? 'no-cache' : 'no-cache',
    // The service worker must be able to control the whole origin, not just /assets.
    ...(isServiceWorker ? { 'service-worker-allowed': '/' } : {}),
  });
  res.end(body);
  return true;
}

/**
 * Refuse to start with development authentication outside development.
 *
 * This exists because "shipped with the auth stub still in place" is a routine way for
 * systems like this to be compromised, and a comment does not prevent it. INV-05 says the
 * UI is never the enforcement layer; this says the same about a developer's memory.
 */
export function assertAuthUsable(authMode: AuthMode, nodeEnv: string): void {
  if (authMode === 'stub' && nodeEnv !== 'development' && nodeEnv !== 'test') {
    throw new Error(
      `Refusing to start: authMode="stub" is development-only and NODE_ENV="${nodeEnv}". ` +
        'Real authentication is M0-19 and is not implemented yet.',
    );
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const SESSION_COOKIE = 'dnc_session';

function readCookie(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie;
  if (header === undefined) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

/**
 * The credential, in order of preference.
 *
 * The cookie is the browser path. The `Authorization: Bearer` header exists for the SMS
 * gateway and any future non-browser client, and because an auth model that can only be
 * exercised through a browser cannot be tested from outside the UI — which is precisely
 * what INV-05 requires.
 */
function readToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (auth !== undefined && auth.startsWith('Bearer ')) return auth.slice(7);
  return readCookie(req, SESSION_COOKIE);
}

function sessionCookie(token: string, secure: boolean, maxAgeSeconds: number): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Accept a batch a device has been holding.
 *
 * The response names every event the server now holds, whether it was appended just now
 * or was already present. That distinction does not matter to the client — what matters is
 * that it can safely stop holding them. Anything absent from `accepted` stays queued.
 */
async function handlePush(
  pool: Pool,
  res: ServerResponse,
  raw: string,
  identity: Identity,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    json(res, 400, { error: 'invalid json' });
    return;
  }

  const body = parsed as { events?: unknown };
  if (!Array.isArray(body.events)) {
    json(res, 400, { error: 'events must be an array' });
    return;
  }

  const { valid, rejected } = validateBatch(body.events);

  // Identity is stamped from the session, never taken from the payload.
  //
  // Without this, any authenticated user could submit an event claiming to be the DC seat,
  // and the audit trail — which is the whole record (ADR-0001) — would faithfully preserve
  // the lie. Whatever the client sent in `actorPersonId` / `actorSeatId` is discarded.
  // Same principle as `recorded_at`: facts the client is not entitled to assert are
  // assigned by the server.
  const attributed = valid.map((e) => ({
    ...e,
    actorPersonId: identity.personId,
    actorSeatId: identity.seatId,
  }));

  // recorded_at is assigned by the database, never by the caller. A device with a wrong
  // clock can misreport when something happened; it must not be able to misreport when we
  // learned of it, because escalation timing depends on that.
  const toStore = attributed as unknown as readonly IncidentEvent[];
  const result = await append(pool, toStore);

  const response: PushResponse = {
    accepted: valid.map((e) => e.eventId),
    rejected,
    appended: result.appended,
    duplicates: result.duplicates,
    cursor: await currentCursor(pool),
  };

  json(res, 200, response);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COMMAND_PATHS: Readonly<Record<string, CommandKind>> = {
  triage: 'triage',
  route: 'route',
  acknowledge: 'acknowledge',
  actions: 'log_action',
  reassign: 'reassign',
  override: 'override',
  resolve: 'resolve',
  close: 'close',
};

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function departmentIds(v: unknown): readonly string[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  if (!v.every((d): d is string => typeof d === 'string' && UUID_RE.test(d))) return null;
  return v;
}

/**
 * Body to command, or a reason it is not one.
 *
 * Strict, unlike intake and unlike a sync payload. These are operator actions taken against
 * a system that is answering them: a reassignment missing its reason has to be refused
 * loudly, because accepting it would put an unexplained change into the record — and the
 * record is the whole point (ADR-0001, INV-06).
 */
function parseCommand(kind: CommandKind, body: Record<string, unknown>): Command | string {
  switch (kind) {
    case 'triage': {
      if (!isSeverity(body['severity'])) return 'severity must be low, moderate, high or critical';
      if (!nonEmpty(body['category'])) return 'category is required';
      return {
        kind,
        severity: body['severity'],
        category: body['category'].trim(),
        ...(nonEmpty(body['reason']) ? { reason: body['reason'].trim() } : {}),
      };
    }

    case 'route':
    case 'reassign': {
      const ids = departmentIds(body['departmentIds']);
      if (ids === null) return 'departmentIds must be a non-empty array of uuids';
      if (!nonEmpty(body['reason'])) return 'reason is required';
      return { kind, departmentIds: ids, reason: body['reason'].trim() };
    }

    case 'acknowledge':
      return {
        kind,
        ...(nonEmpty(body['reason']) ? { reason: body['reason'].trim() } : {}),
      };

    case 'log_action': {
      if (!nonEmpty(body['note'])) return 'note is required';

      // A stated time is accepted only if it parses and is not in the future. A clock skewed
      // forward would otherwise let an action be logged as having happened after the
      // incident closed, and the timeline would read as nonsense to whoever reviews it.
      const stated = body['occurredAt'];
      const when =
        typeof stated === 'string' && Number.isFinite(Date.parse(stated))
          ? new Date(stated).toISOString()
          : null;

      return {
        kind,
        note: body['note'].trim(),
        ...(when !== null && when <= new Date().toISOString() ? { occurredAt: when } : {}),
      };
    }

    case 'override': {
      const field = body['field'];
      if (field !== 'severity' && field !== 'category') {
        return "field must be 'severity' or 'category'";
      }
      if (!nonEmpty(body['value'])) return 'value is required';
      if (field === 'severity' && !isSeverity(body['value'])) {
        return 'severity must be low, moderate, high or critical';
      }
      if (!nonEmpty(body['reason'])) return 'reason is required';
      return { kind, field, value: body['value'].trim(), reason: body['reason'].trim() };
    }

    case 'resolve':
      if (!nonEmpty(body['outcome'])) return 'outcome is required';
      return { kind, outcome: body['outcome'].trim() };

    case 'close':
      if (!nonEmpty(body['notes'])) return 'notes are required';
      return { kind, notes: body['notes'].trim() };
  }
}

/** `/incidents`, `/incidents/:id`, `/incidents/:id/:action`. */
function matchIncidentRoute(
  pathname: string,
): { readonly incidentId: string | null; readonly action: string | null } | null {
  const parts = pathname.split('/').filter((p) => p.length > 0);
  if (parts[0] !== 'incidents') return null;
  if (parts.length === 1) return { incidentId: null, action: null };
  if (parts.length === 2) return { incidentId: parts[1]!, action: null };
  if (parts.length === 3) return { incidentId: parts[1]!, action: parts[2]! };
  return null;
}

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const raw = await readBody(req);
  if (raw.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The administration console — M1a. Everything under `/admin`.
 *
 * The authority check is **not** here. Every function in `api/admin.ts` asks
 * `requireAdministration` itself, so an endpoint added to this switch without a check is
 * still refused rather than silently open. A gate that lives in the router is a gate that
 * gets bypassed by the next route somebody adds in a hurry (INV-05).
 *
 * Malformed JSON is a 400 here, unlike intake, which cannot refuse anything (INV-01). The
 * asymmetry is the point: nobody's emergency is lost because a configuration form was
 * mis-submitted, and silently accepting a broken routing rule would be far worse than
 * rejecting it.
 */
async function handleAdmin(
  pool: Pool,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  identity: Identity,
): Promise<void> {
  const send = <T>(result: AdminResult<T>): void => {
    if (!result.ok) json(res, result.status, { error: result.error });
    else json(res, 200, result.value);
  };

  const body = async (): Promise<Record<string, unknown> | null> => bodyOf(req);

  if (req.method === 'GET' && pathname === '/admin/departments') {
    send(await departmentsForConsole(pool, identity));
    return;
  }

  if (req.method === 'POST' && pathname === '/admin/departments') {
    const input = await body();
    if (input === null) {
      json(res, 400, { error: 'that was not valid json' });
      return;
    }
    const result = await addDepartment(pool, identity, input);
    if (!result.ok) json(res, result.status, { error: result.error });
    else json(res, 201, result.value);
    return;
  }

  const department = /^\/admin\/departments\/([^/]+)(\/[a-z]+)?$/.exec(pathname);
  if (department !== null) {
    const departmentId = department[1]!;
    const action = department[2] ?? null;

    if (!UUID_RE.test(departmentId)) {
      json(res, 404, { error: 'no such department' });
      return;
    }

    const input = await body();
    if (input === null) {
      json(res, 400, { error: 'that was not valid json' });
      return;
    }

    if (req.method === 'PATCH' && action === null) {
      send(await editDepartment(pool, identity, departmentId, input));
      return;
    }
    if (req.method === 'POST' && action === '/retire') {
      send(await setRetired(pool, identity, departmentId, true, input['reason']));
      return;
    }
    if (req.method === 'POST' && action === '/restore') {
      send(await setRetired(pool, identity, departmentId, false, input['reason']));
      return;
    }
    if (req.method === 'POST' && action === '/signals') {
      const result = await addSignal(pool, identity, departmentId, input);
      if (!result.ok) json(res, result.status, { error: result.error });
      else json(res, 201, result.value);
      return;
    }

    json(res, 405, { error: 'method not allowed' });
    return;
  }

  const signal = /^\/admin\/signals\/([^/]+)\/retire$/.exec(pathname);
  if (req.method === 'POST' && signal !== null) {
    const input = await body();
    if (input === null) {
      json(res, 400, { error: 'that was not valid json' });
      return;
    }
    send(await removeSignal(pool, identity, signal[1]!, input['reason']));
    return;
  }

  if (pathname === '/admin/sla') {
    if (req.method === 'GET') {
      send(await slaForConsole(pool, identity));
      return;
    }
    if (req.method === 'PUT') {
      const input = await body();
      if (input === null) {
        json(res, 400, { error: 'that was not valid json' });
        return;
      }
      send(await setTarget(pool, identity, input));
      return;
    }
    json(res, 405, { error: 'method not allowed' });
    return;
  }

  if (req.method === 'GET' && pathname === '/admin/performance') {
    send(await districtPerformance(pool, identity));
    return;
  }

  if (req.method === 'GET' && pathname === '/admin/integrity') {
    send(await integrity(pool, identity));
    return;
  }

  if (req.method === 'GET' && pathname === '/admin/history') {
    send(await configHistory(pool, identity));
    return;
  }

  json(res, 404, { error: 'not found' });
}

/**
 * The roster — M1a-10. Everything under `/roster`.
 *
 * Separate from `/admin` because the gate is different, and the difference is the point: a
 * department may edit **its own** people and posts, while `/admin` remains the two offices
 * only. Routing signals and SLA deadlines stay on `/admin` deliberately (ADR-0010) — a
 * department able to edit its own routing could quietly stop receiving night-time calls.
 *
 * The literal segments `posts` and `people` are matched before the `:departmentId` pattern,
 * or `/roster/posts/...` would be read as a department whose id is "posts".
 */
async function handleRoster(
  pool: Pool,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  identity: Identity,
): Promise<void> {
  const send = <T>(result: AdminResult<T>, okStatus = 200): void => {
    if (!result.ok) json(res, result.status, { error: result.error });
    else json(res, okStatus, result.value);
  };

  const body = async (): Promise<Record<string, unknown> | null> => bodyOf(req);
  const bad = (): void => void json(res, 400, { error: 'that was not valid json' });

  // A post, by id.
  const post = /^\/roster\/posts\/([^/]+)(?:\/([a-z]+))?$/.exec(pathname);
  if (post !== null) {
    const seatId = post[1]!;
    const action = post[2] ?? null;
    if (!UUID_RE.test(seatId)) {
      json(res, 404, { error: 'no such post' });
      return;
    }

    const input = await body();
    if (input === null) return bad();

    if (req.method === 'PATCH' && action === null) {
      send(await editPost(pool, identity, seatId, input));
      return;
    }
    if (req.method === 'POST' && action === 'retire') {
      send(await retirePost(pool, identity, seatId, true, input['reason']));
      return;
    }
    if (req.method === 'POST' && action === 'restore') {
      send(await retirePost(pool, identity, seatId, false, input['reason']));
      return;
    }
    if (req.method === 'POST' && action === 'assign') {
      send(await assign(pool, identity, seatId, input));
      return;
    }
    if (req.method === 'POST' && action === 'relieve') {
      send(await relieve(pool, identity, seatId, input['reason']));
      return;
    }
    json(res, 405, { error: 'method not allowed' });
    return;
  }

  // A person, by id.
  const person = /^\/roster\/people\/([^/]+)(?:\/([a-z]+))?$/.exec(pathname);
  if (person !== null) {
    const personId = person[1]!;
    const action = person[2] ?? null;
    if (!UUID_RE.test(personId)) {
      json(res, 404, { error: 'no such person' });
      return;
    }

    const input = await body();
    if (input === null) return bad();

    if (req.method === 'PATCH' && action === null) {
      send(await editRosterPerson(pool, identity, personId, input));
      return;
    }
    if (req.method === 'POST' && action === 'remove') {
      send(await removeRosterPerson(pool, identity, personId, input['reason']));
      return;
    }
    if (req.method === 'POST' && action === 'account') {
      send(await grantRosterAccount(pool, identity, personId, input));
      return;
    }
    json(res, 405, { error: 'method not allowed' });
    return;
  }

  // `/roster` with no id: whatever department the caller's own seat sits in. A department
  // officer should not have to know their own uuid, and must not be able to change the
  // answer by sending a different one.
  if (req.method === 'GET' && pathname === '/roster') {
    send(await readRoster(pool, identity, null));
    return;
  }

  const department = /^\/roster\/([^/]+)(?:\/([a-z]+))?$/.exec(pathname);
  if (department !== null) {
    const departmentId = department[1]!;
    const action = department[2] ?? null;
    if (!UUID_RE.test(departmentId)) {
      json(res, 404, { error: 'no such department' });
      return;
    }

    if (req.method === 'GET' && action === null) {
      send(await readRoster(pool, identity, departmentId));
      return;
    }

    const input = await body();
    if (input === null) return bad();

    if (req.method === 'POST' && action === 'posts') {
      send(await addPost(pool, identity, departmentId, input), 201);
      return;
    }
    if (req.method === 'POST' && action === 'people') {
      send(await addRosterPerson(pool, identity, departmentId, input), 201);
      return;
    }
    json(res, 405, { error: 'method not allowed' });
    return;
  }

  json(res, 404, { error: 'not found' });
}

/**
 * What a department can send — M1-02. Everything under `/fleet`.
 *
 * Beside `/roster` and gated the same way, because they are the same question asked about
 * two kinds of thing: what a department has. Dispatch itself is **not** here — sending a
 * unit is a fact about an emergency, so it lives on the incident (`/incidents/:id/dispatch`)
 * and lands in the incident log where "which ambulance went to the bazaar fire" stays
 * answerable a year later.
 */
async function handleFleet(
  pool: Pool,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  identity: Identity,
): Promise<void> {
  const send = <T>(result: AdminResult<T>, okStatus = 200): void => {
    if (!result.ok) json(res, result.status, { error: result.error });
    else json(res, okStatus, result.value);
  };
  const bad = (): void => void json(res, 400, { error: 'that was not valid json' });

  const unit = /^\/fleet\/units\/([^/]+)(?:\/([a-z-]+))?$/.exec(pathname);
  if (unit !== null) {
    const resourceId = unit[1]!;
    const action = unit[2] ?? null;
    if (!UUID_RE.test(resourceId)) {
      json(res, 404, { error: 'no such unit' });
      return;
    }

    const input = await bodyOf(req);
    if (input === null) return bad();

    if (req.method === 'PATCH' && action === null) {
      send(await editResource(pool, identity, resourceId, input));
      return;
    }
    if (req.method === 'POST' && action === 'off-run') {
      send(await serviceState(pool, identity, resourceId, true, input['reason']));
      return;
    }
    if (req.method === 'POST' && action === 'on-run') {
      send(await serviceState(pool, identity, resourceId, false, input['reason']));
      return;
    }
    if (req.method === 'POST' && action === 'retire') {
      send(await retireResource(pool, identity, resourceId, true, input['reason']));
      return;
    }
    if (req.method === 'POST' && action === 'restore') {
      send(await retireResource(pool, identity, resourceId, false, input['reason']));
      return;
    }
    if (req.method === 'POST' && action === 'crew') {
      send(await crew(pool, identity, resourceId, input['personId'], true));
      return;
    }
    if (req.method === 'POST' && action === 'uncrew') {
      send(await crew(pool, identity, resourceId, input['personId'], false));
      return;
    }
    json(res, 405, { error: 'method not allowed' });
    return;
  }

  if (req.method === 'GET' && pathname === '/fleet') {
    send(await readFleet(pool, identity, null));
    return;
  }

  const department = /^\/fleet\/([^/]+)(?:\/(units))?$/.exec(pathname);
  if (department !== null) {
    const departmentId = department[1]!;
    if (!UUID_RE.test(departmentId)) {
      json(res, 404, { error: 'no such department' });
      return;
    }

    if (req.method === 'GET' && department[2] === undefined) {
      send(await readFleet(pool, identity, departmentId));
      return;
    }
    if (req.method === 'POST' && department[2] === 'units') {
      const input = await bodyOf(req);
      if (input === null) return bad();
      send(await addResource(pool, identity, departmentId, input), 201);
      return;
    }
    json(res, 405, { error: 'method not allowed' });
    return;
  }

  json(res, 404, { error: 'not found' });
}

async function handleIncidents(
  pool: Pool,
  req: IncomingMessage,
  res: ServerResponse,
  route: { readonly incidentId: string | null; readonly action: string | null },
  identity: Identity,
  evidenceRoot: string,
  wantsText = false,
): Promise<void> {
  const readJson = async (): Promise<Record<string, unknown> | null> => bodyOf(req);

  if (route.incidentId === null) {
    // The central board (M0-33). Scoped by the caller's seat, server-side — rows this seat
    // may not see are never sent, rather than sent and hidden (INV-05).
    if (req.method === 'GET') {
      const seat = seatOf(identity);
      if (seat === null) {
        json(res, 403, { error: 'no current duty assignment; you hold no seat' });
        return;
      }
      json(res, 200, await buildBoard(pool, seat));
      return;
    }

    // Intake. The one endpoint here that does not refuse — see `intake`.
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' });
      return;
    }
    // Even unreadable JSON does not lose the report: an empty body still records that
    // someone said something happened, with every field marked assumed (INV-01).
    const body = (await readJson()) ?? {};
    const result = await intake(pool, body, identity);
    json(res, 201, {
      incidentId: result.incidentId,
      reportId: result.reportId,
      assumed: result.assumed,
      // Where it went, told to the person who just reported it. Someone standing at the
      // scene needs to know whether help has actually been summoned — "received" and
      // "received, and nobody has it" are different answers (ADR-0005).
      routedTo: result.routedTo,
      unassigned: result.unassigned,
      routingReason: result.routingReason,
    });
    return;
  }

  if (!UUID_RE.test(route.incidentId)) {
    json(res, 404, { error: 'no such incident' });
    return;
  }

  if (route.action === null) {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' });
      return;
    }
    const result = await readIncident(pool, route.incidentId, identity);
    if (!result.ok) {
      json(res, result.status, { error: result.error });
      return;
    }
    json(res, 200, {
      state: result.state,
      events: result.events,
      actors: result.actors,
      responsibleDepartments: result.responsibleDepartments,
      // Sent with the incident rather than fetched separately. The detail screen needs both
      // to render one timeline, and a second round trip is a second thing that can be
      // half-loaded on a bad connection.
      evidence: await listFor(pool, route.incidentId),
    });
    return;
  }

  // The post-incident report (M1-06).
  //
  // Two formats from one fold: JSON for a screen, plain text for submitting upward. Q-02
  // made export the point rather than integration, and plain text can be pasted into an
  // email, a register or a form with no tooling on the other end — a district office should
  // never need this software installed to read what it produced.
  if (route.action === 'report') {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' });
      return;
    }
    const result = await postIncidentReport(pool, route.incidentId, identity);
    if (!result.ok) {
      json(res, result.status, { error: result.error });
      return;
    }
    if (wantsText) {
      const body = Buffer.from(result.text, 'utf8');
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': body.length,
        'cache-control': 'no-store',
      });
      res.end(body);
      return;
    }
    json(res, 200, result.report);
    return;
  }

  // Evidence (M1-05). Authority comes from the incident, so these sit inside the incident
  // handler rather than beside it.
  if (route.action === 'evidence') {
    if (req.method === 'POST') {
      const reply = await upload(pool, evidenceRoot, req, route.incidentId, identity);
      if (!reply.ok) json(res, reply.status, { error: reply.error });
      else json(res, reply.status, reply.body);
      return;
    }
    if (req.method === 'GET') {
      const reply = await listEvidence(pool, route.incidentId, identity);
      if (!reply.ok) json(res, reply.status, { error: reply.error });
      else json(res, reply.status, reply.body);
      return;
    }
    json(res, 405, { error: 'method not allowed' });
    return;
  }

  // Dispatch and stand-down (M1-03).
  //
  // Handled before the policy-table commands because their authority question is a different
  // one: not "may this seat change this field of this incident" but "is this unit yours to
  // send". A department that holds the incident may commit what it has and may not commit
  // another department's ambulance — see `api/resources.ts`.
  if (route.action === 'dispatch' || route.action === 'release') {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' });
      return;
    }
    const body = await readJson();
    if (body === null) {
      json(res, 400, { error: 'invalid json' });
      return;
    }

    const result =
      route.action === 'dispatch'
        ? await dispatch(pool, identity, route.incidentId, body)
        : await release(pool, identity, route.incidentId, body);

    if (!result.ok) json(res, result.status, { error: result.error });
    else json(res, 200, result.value);
    return;
  }

  const kind = COMMAND_PATHS[route.action];
  if (kind === undefined) {
    json(res, 404, { error: 'not found' });
    return;
  }

  if (req.method !== 'POST') {
    json(res, 405, { error: 'method not allowed' });
    return;
  }

  const body = await readJson();
  if (body === null) {
    json(res, 400, { error: 'invalid json' });
    return;
  }

  const command = parseCommand(kind, body);
  if (typeof command === 'string') {
    json(res, 400, { error: command });
    return;
  }

  const result = await applyCommand(pool, route.incidentId, command, identity);
  if (!result.ok) {
    json(res, result.status, { error: result.error });
    return;
  }

  json(res, 200, { event: result.event, state: result.state });
}

async function handlePull(pool: Pool, res: ServerResponse, url: URL): Promise<void> {
  const cursor = Number(url.searchParams.get('cursor') ?? 0);
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 500), 1000);

  if (!Number.isFinite(cursor) || cursor < 0) {
    json(res, 400, { error: 'cursor must be a non-negative number' });
    return;
  }

  const page = await loadSince(pool, cursor, limit);
  const response: PullResponse = {
    events: page.events,
    nextCursor: page.nextCursor,
    hasMore: page.events.length === limit,
  };

  json(res, 200, response);
}

export function createSyncServer(options: ServerOptions): Server {
  const { pool, webRoot } = options;
  // Defaulted rather than required, so every existing caller keeps working — but defaulted
  // to a directory **outside** the web root, because a directory the server serves
  // statically is a directory where an uploaded file becomes a URL a browser will open.
  const evidenceRoot = options.evidenceRoot ?? join(process.cwd(), 'var', 'evidence');
  const authMode = options.authMode ?? 'stub';
  const nodeEnv = options.nodeEnv ?? process.env['NODE_ENV'] ?? 'development';

  assertAuthUsable(authMode, nodeEnv);

  return createServer((req, res) => {
    // Every request gets a correlation id, in the response header and on every log line it
    // causes — including the escalation and notification work it triggers downstream
    // (M0-03). Without it, "I filed a report at 14:20 and it vanished" has no answer.
    const correlationId = correlationIdFrom(req.headers['x-correlation-id']);
    res.setHeader('x-correlation-id', correlationId);

    const startedAt = Date.now();

    void withContext({ correlationId }, async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');

        if (req.method === 'GET' && url.pathname === '/health') {
          try {
            await pool.query('SELECT 1');
            // Backup freshness lives here because /health is the one endpoint anybody
            // actually checks. A backup that stopped working three weeks ago and told
            // nobody is the normal way this goes wrong (M0-37, ADR-0005).
            //
            // **Reported as `degraded`, never as a failing status code.** A 503 here would
            // take the node out of a load balancer and stop the district reporting
            // emergencies — because a backup was old. That trade is unacceptable in both
            // directions: INV-01 outranks a stale dump, and an operator who cannot file a
            // report has no way to know a backup was the reason. Liveness and the backup
            // obligation are different questions and this answers both separately.
            const backup = await backupHealth(pool);
            json(res, 200, { ok: true, db: 'up', authMode, degraded: !backup.ok, backup });
          } catch {
            // A health check that hides a dead database is worse than none.
            json(res, 503, { ok: false, db: 'down', authMode });
          }
          return;
        }

        if (req.method === 'POST' && url.pathname === '/auth/login') {
          let body: { phone?: unknown; password?: unknown };
          try {
            body = JSON.parse(await readBody(req)) as typeof body;
          } catch {
            json(res, 400, { error: 'invalid json' });
            return;
          }

          if (typeof body.phone !== 'string' || typeof body.password !== 'string') {
            json(res, 400, { error: 'phone and password are required' });
            return;
          }

          const result = await login(pool, body.phone, body.password);
          if (result === null) {
            // One message for every failure. Distinguishing "no such number" from "wrong
            // password" hands an attacker the list of real officers.
            json(res, 401, { error: 'invalid credentials' });
            return;
          }

          res.setHeader(
            'set-cookie',
            sessionCookie(result.token, nodeEnv === 'production', SESSION_TTL_HOURS * 3600),
          );
          json(res, 200, { token: result.token, identity: result.identity });
          return;
        }

        if (req.method === 'POST' && url.pathname === '/auth/logout') {
          const token = readToken(req);
          if (token !== null) await revokeSession(pool, token);
          res.setHeader('set-cookie', sessionCookie('', nodeEnv === 'production', 0));
          json(res, 200, { ok: true });
          return;
        }

        // Everything below requires a session. There is no path around this check, and no
        // reliance on the UI hiding anything (INV-05).
        // The operator's inbox (M0-32). Behind a session, scoped to the seat — never to the
        // person, so a handover moves the post's messages with the post (ADR-0004).
        if (url.pathname === '/notifications' || url.pathname.startsWith('/notifications/')) {
          const token = readToken(req);
          const identity = token === null ? null : await resolveSession(pool, token);

          if (identity === null) {
            json(res, 401, { error: 'authentication required' });
            return;
          }

          if (req.method === 'GET' && url.pathname === '/notifications') {
            if (identity.seatId === null) {
              // Holding no seat is not an error here: there is genuinely nothing addressed
              // to you, and an empty inbox says that more honestly than a 403.
              json(res, 200, { notifications: [] });
              return;
            }
            json(res, 200, { notifications: await inbox(pool, identity.seatId) });
            return;
          }

          const seen = /^\/notifications\/([^/]+)\/seen$/.exec(url.pathname);
          if (req.method === 'POST' && seen !== null) {
            const result = await markSeen(pool, seen[1]!, identity);
            if (!result.ok) {
              json(res, result.status, { error: result.error });
              return;
            }
            json(res, 200, { ok: true });
            return;
          }

          json(res, 404, { error: 'not found' });
          return;
        }

        // The administration console (M1a). Behind a session; the authority check itself
        // lives inside each handler in `api/admin.ts`.
        if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
          const token = readToken(req);
          const identity = token === null ? null : await resolveSession(pool, token);

          if (identity === null) {
            json(res, 401, { error: 'authentication required' });
            return;
          }

          await handleAdmin(pool, req, res, url.pathname, identity);
          return;
        }

        // Fetching one file. Scoped by the incident it belongs to, resolved inside.
        const evidenceFile = /^\/evidence\/([^/]+)$/.exec(url.pathname);
        if (evidenceFile !== null) {
          if (req.method !== 'GET') {
            json(res, 405, { error: 'method not allowed' });
            return;
          }
          const token = readToken(req);
          const identity = token === null ? null : await resolveSession(pool, token);
          if (identity === null) {
            json(res, 401, { error: 'authentication required' });
            return;
          }
          if (!UUID_RE.test(evidenceFile[1]!)) {
            json(res, 404, { error: 'no such evidence' });
            return;
          }

          const reply = await download(pool, evidenceRoot, res, evidenceFile[1]!, identity);
          if (reply !== null && !reply.ok) json(res, reply.status, { error: reply.error });
          return;
        }

        // What a department can send (M1-02). Same gate as the roster.
        if (url.pathname === '/fleet' || url.pathname.startsWith('/fleet/')) {
          const token = readToken(req);
          const identity = token === null ? null : await resolveSession(pool, token);

          if (identity === null) {
            json(res, 401, { error: 'authentication required' });
            return;
          }

          await handleFleet(pool, req, res, url.pathname, identity);
          return;
        }

        // The roster (M1a-10). Behind a session; a department may edit its own, the two
        // offices may edit any. The scoping itself lives in `api/roster.ts` → `reach`.
        if (url.pathname === '/roster' || url.pathname.startsWith('/roster/')) {
          const token = readToken(req);
          const identity = token === null ? null : await resolveSession(pool, token);

          if (identity === null) {
            json(res, 401, { error: 'authentication required' });
            return;
          }

          await handleRoster(pool, req, res, url.pathname, identity);
          return;
        }

        const incidentRoute = matchIncidentRoute(url.pathname);

        if (incidentRoute !== null) {
          const token = readToken(req);
          const identity = token === null ? null : await resolveSession(pool, token);

          if (identity === null) {
            json(res, 401, { error: 'authentication required' });
            return;
          }

          // Authenticated but holding no seat: they may look at nothing and do nothing.
          // Authority comes from the seat, never from the person (ADR-0004).
          if (identity.seatId === null) {
            json(res, 403, {
              error: 'no current duty assignment; you hold no seat and cannot act',
            });
            return;
          }

          await handleIncidents(
            pool,
            req,
            res,
            incidentRoute,
            identity,
            evidenceRoot,
            url.searchParams.get('format') === 'text',
          );
          return;
        }

        if (url.pathname === '/auth/me' || url.pathname === '/sync') {
          const token = readToken(req);
          const identity = token === null ? null : await resolveSession(pool, token);

          if (identity === null) {
            json(res, 401, { error: 'authentication required' });
            return;
          }

          if (url.pathname === '/auth/me') {
            json(res, 200, { identity });
            return;
          }

          if (req.method === 'POST') {
            // Authenticated but holding no seat: they may sign in, and may do nothing.
            // Authority comes from the seat, never from the person (ADR-0004).
            if (identity.seatId === null) {
              json(res, 403, {
                error: 'no current duty assignment; you hold no seat and cannot act',
              });
              return;
            }
            await handlePush(pool, res, await readBody(req), identity);
            return;
          }

          if (req.method === 'GET') {
            await handlePull(pool, res, url);
            return;
          }

          json(res, 405, { error: 'method not allowed' });
          return;
        }

        // Static assets last, so an API route can never be shadowed by a file on disk.
        if (webRoot !== undefined && req.method === 'GET') {
          if (await serveStatic(webRoot, res, url.pathname)) return;
          // Unknown path with no matching file: fall back to the shell so client-side
          // routes work, both online and from the service worker cache.
          if (req.headers.accept?.includes('text/html') === true) {
            if (await serveStatic(webRoot, res, '/')) return;
          }
        }

        json(res, 404, { error: 'not found' });
      } catch (err) {
        // Never leak internals to a caller, but never swallow the cause either. The
        // correlation id is already on this line, so the 500 an operator saw can be found.
        log('error', 'unhandled request error', {
          method: req.method,
          path: safePath(req.url),
          error: String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        json(res, 500, { error: 'internal error' });
      } finally {
        logRequest(req, res, startedAt);
      }
    });
  });
}

/**
 * The path, without the query string.
 *
 * `GET /sync?cursor=` is harmless, but a query string is the easiest place for something
 * that should not be in a log to end up later. Dropping it costs one diagnostic detail and
 * removes a whole category of accident.
 */
function safePath(url: string | undefined): string {
  const raw = url ?? '/';
  const q = raw.indexOf('?');
  return q === -1 ? raw : raw.slice(0, q);
}

/**
 * One line per request, at the end, with the outcome.
 *
 * Deliberately not one line at the start as well: doubling the volume to record that a
 * request was received buys nothing that the completion line does not already say, and a
 * log nobody can read is a log nobody reads.
 *
 * **Successful noise is filtered.** Monitoring polls `/health` continuously and the PWA
 * fetches its own assets on every launch; logging those at `info` would bury the requests
 * that matter. They are logged when they fail, which is the case anyone ever looks for.
 */
function logRequest(req: IncomingMessage, res: ServerResponse, startedAt: number): void {
  const path = safePath(req.url);
  const status = res.statusCode;

  const routine =
    status < 400 && (path === '/health' || path === '/' || /\.[a-z0-9]+$/i.test(path));
  if (routine) return;

  log(status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info', 'request', {
    method: req.method,
    path,
    status,
    ms: Date.now() - startedAt,
  });
}
