import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

import { append, loadSince } from '../db/eventStore.js';
import type { Pool } from '../db/pool.js';
import type { IncidentEvent } from '../domain/events.js';
import { validateBatch, type PullResponse, type PushResponse } from './protocol.js';

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

/**
 * Accept a batch a device has been holding.
 *
 * The response names every event the server now holds, whether it was appended just now
 * or was already present. That distinction does not matter to the client — what matters is
 * that it can safely stop holding them. Anything absent from `accepted` stays queued.
 */
async function handlePush(pool: Pool, res: ServerResponse, raw: string): Promise<void> {
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

  // recorded_at is assigned by the database, never by the caller. A device with a wrong
  // clock can misreport when something happened; it must not be able to misreport when we
  // learned of it, because escalation timing depends on that.
  const toStore = valid as unknown as readonly IncidentEvent[];
  const result = await append(pool, toStore);

  const cursorRow = await pool.query<{ max: string | null }>(
    'SELECT MAX(seq)::text AS max FROM incident_event',
  );

  const response: PushResponse = {
    accepted: valid.map((e) => e.eventId),
    rejected,
    appended: result.appended,
    duplicates: result.duplicates,
    cursor: Number(cursorRow.rows[0]?.max ?? 0),
  };

  json(res, 200, response);
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
  const authMode = options.authMode ?? 'stub';
  const nodeEnv = options.nodeEnv ?? process.env['NODE_ENV'] ?? 'development';

  assertAuthUsable(authMode, nodeEnv);

  return createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');

        if (req.method === 'GET' && url.pathname === '/health') {
          try {
            await pool.query('SELECT 1');
            json(res, 200, { ok: true, db: 'up', authMode });
          } catch {
            // A health check that hides a dead database is worse than none.
            json(res, 503, { ok: false, db: 'down', authMode });
          }
          return;
        }

        if (req.method === 'POST' && url.pathname === '/sync') {
          await handlePush(pool, res, await readBody(req));
          return;
        }

        if (req.method === 'GET' && url.pathname === '/sync') {
          await handlePull(pool, res, url);
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
        // Never leak internals to a caller, but never swallow the cause either.
        // eslint-disable-next-line no-console
        console.error('[sync] unhandled', err);
        json(res, 500, { error: 'internal error' });
      }
    })();
  });
}
