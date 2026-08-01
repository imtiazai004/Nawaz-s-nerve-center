/**
 * M0-12: the app must open with no network.
 *
 * Until the service worker existed, a handset that closed the browser during a shutdown
 * could not reach the app at all — the queued report was safe on disk and completely
 * unreachable. This suite is the proof that is no longer true.
 *
 * It also guards the single most dangerous thing a cache could do here: serve a stale
 * `/sync` response. That would tell a client its emergency was accepted when it was not,
 * and the outbox — which releases only what the server confirms — would delete it. INV-01
 * violated silently, by a caching layer, with no error anywhere.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSyncServer } from '../api/server.js';
import { createPool, migrate, type Pool } from '../db/pool.js';
import { buildWeb } from '../../build.mjs';
import { seedActor, TEST_PASSWORD } from '../testing/seed.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'db', 'migrations');

describe.skipIf(dbUrl === undefined)('M0-12: the app opens with no network', () => {
  let pool: Pool;
  let api: Server;
  let origin: string;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  /**
   * Unique per run. The event table is append-only by design and is never cleaned between
   * runs, so any test that asserts on a count must isolate itself through its data — the
   * same discipline the eventStore suite uses with fresh incident ids.
   */
  const place = `Bannu-Kohat road, near Mandan [${randomUUID()}]`;

  beforeAll(async () => {
    const webRoot = await buildWeb();

    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    api = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test', webRoot });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    browser = await chromium.launch();
    context = await browser.newContext();
    page = await context.newPage();
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => api?.close(() => r()));
    await pool?.end();
  });

  async function serviceWorkerReady(): Promise<void> {
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
      timeout: 20_000,
    });
  }

  it('1. loads online and registers a service worker', async () => {
    await page.goto(origin);
    await page.waitForSelector('#report');

    // Sign in through the real endpoint. The session cookie is then carried automatically
    // by the transport, as it would be on a handset.
    const actor = await seedActor(pool, { title: 'Offline Launch Duty Officer' });
    const loggedIn = await page.evaluate(
      async ([phone, password]) => {
        const res = await fetch('/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ phone, password }),
        });
        return res.ok;
      },
      [actor.phone, TEST_PASSWORD],
    );
    expect(loggedIn).toBe(true);

    // First load registers; the worker claims clients on activate.
    await serviceWorkerReady();

    const controlled = await page.evaluate(() => navigator.serviceWorker.controller !== null);
    expect(controlled).toBe(true);
  });

  it('2. opens with the network cut — the whole point of M0-12', async () => {
    await context.setOffline(true);

    // Would have failed with ERR_INTERNET_DISCONNECTED before the service worker existed.
    await page.reload();
    await page.waitForSelector('#report', { timeout: 20_000 });

    const heading = await page.textContent('h1');
    expect(heading).toContain('District Nerve Center');
  });

  it('3. says plainly that it is offline, rather than implying anything', async () => {
    // The status must settle from an actual sync attempt, not from navigator.onLine.
    await page.waitForFunction(
      () => document.getElementById('status')?.dataset['state'] === 'offline',
      undefined,
      { timeout: 15_000 },
    );

    const text = await page.textContent('#status');
    expect(text).toMatch(/saved on this device/i);
    expect(text).not.toMatch(/delivered immediately/i);
  });

  it('3b. never trusts navigator.onLine to claim it is connected', async () => {
    // The regression this pins: Playwright cuts the network at the driver, but Chromium
    // still reports navigator.onLine === true. A handset on a cell tower with dead
    // backhaul does exactly the same. An app that trusts it displays "Connected. Reports
    // are delivered immediately." during precisely the outage the operator needs to know
    // about — INV-02 applied to connectivity itself.
    const browserThinksOnline = await page.evaluate(() => navigator.onLine);
    const displayed = await page.getAttribute('#status', 'data-state');

    expect(browserThinksOnline).toBe(true);
    expect(displayed).toBe('offline');
  });

  it('4. captures a critical report while offline', async () => {
    await page.selectOption('#category', 'rta');
    await page.selectOption('#severity', 'critical');
    await page.fill('#place', place);
    await page.click('#submit');

    await page.waitForFunction(
      () => document.querySelectorAll('#entries .entry').length === 1,
      undefined,
      { timeout: 10_000 },
    );

    const badge = await page.textContent('.badge');
    // Never a tick, never "sent". Only what is actually true.
    expect(badge).toMatch(/saved on this device/i);
    expect(badge).not.toMatch(/sent|delivered/i);
  });

  it('5. the offline report survives closing and reopening the app, still offline', async () => {
    await page.reload();
    await page.waitForSelector('#report', { timeout: 20_000 });

    await page.waitForFunction(
      () => document.querySelectorAll('#entries .entry').length === 1,
      undefined,
      { timeout: 10_000 },
    );

    expect(await page.textContent('#count')).toBe('(1)');
  });

  it('6. delivers itself when signal returns', async () => {
    await context.setOffline(false);

    await page.evaluate(async () => {
      await (globalThis as unknown as { __dnc: { trySync(): Promise<void> } }).__dnc.trySync();
    });

    await page.waitForFunction(
      () => document.querySelectorAll('#entries .entry').length === 0,
      undefined,
      { timeout: 15_000 },
    );

    const stored = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM incident_event WHERE payload->>'place' = $1`,
      [place],
    );
    expect(Number(stored.rows[0]!.n)).toBe(1);
  });

  describe('the cache must never serve /sync', () => {
    it('7. no sync or health response is in any cache', async () => {
      const cached = await page.evaluate(async () => {
        const names = await caches.keys();
        const urls: string[] = [];
        for (const name of names) {
          const cache = await caches.open(name);
          for (const req of await cache.keys()) urls.push(new URL(req.url).pathname);
        }
        return urls;
      });

      expect(cached).not.toContain('/sync');
      expect(cached).not.toContain('/health');
      // ...but the shell is there, which is what makes offline launch work.
      expect(cached).toContain('/index.html');
    });

    it('8. a push while offline fails rather than being answered from cache', async () => {
      // A cached "accepted" would make the outbox delete an emergency the server never got.
      await context.setOffline(true);

      const outcome = await page.evaluate(async () => {
        try {
          const res = await fetch('/sync', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ deviceId: 'x', events: [] }),
          });
          return { threw: false, status: res.status };
        } catch {
          return { threw: true, status: 0 };
        }
      });

      expect(outcome.threw).toBe(true);
      await context.setOffline(false);
    });

    it('9. a queued report is never released on a failed push', async () => {
      await context.setOffline(true);

      const result = await page.evaluate(async () => {
        const dnc = (
          globalThis as unknown as {
            __dnc: {
              outbox: {
                enqueue(d: unknown): Promise<{ eventId: string }>;
                sync(): Promise<{ offline: boolean; pushed: number }>;
                pendingCount(): Promise<number>;
              };
            };
          }
        ).__dnc;

        await dnc.outbox.enqueue({
          eventId: crypto.randomUUID(),
          incidentId: crypto.randomUUID(),
          type: 'reported',
          occurredAt: new Date().toISOString(),
          actorPersonId: null,
          actorSeatId: null,
          sourceChannel: 'mobile',
          payload: { severity: 'critical', category: 'fire' },
        });

        // Restoring the network at the end of the previous test fires the browser's
        // `online` event, which starts a sync of its own. `sync()` deliberately joins a
        // run already in progress rather than racing it, so the first call here can
        // legitimately return that earlier run's online answer. Drive it until a sync
        // actually starts while offline — that is the state under test.
        let sync = await dnc.outbox.sync();
        for (let i = 0; i < 20 && !sync.offline; i++) {
          await new Promise((r) => setTimeout(r, 50));
          sync = await dnc.outbox.sync();
        }

        return {
          offline: sync.offline,
          pushed: sync.pushed,
          pending: await dnc.outbox.pendingCount(),
        };
      });

      expect(result.offline).toBe(true);
      expect(result.pushed).toBe(0);
      // The property that actually matters: a failed push never releases the report.
      expect(result.pending).toBe(1);

      await context.setOffline(false);
    });
  });

  it('10. a navigation to an unknown path still resolves offline', async () => {
    await context.setOffline(true);

    await page.goto(`${origin}/incidents/${randomUUID()}`);
    await page.waitForSelector('#report', { timeout: 20_000 });

    expect(await page.textContent('h1')).toContain('District Nerve Center');
    await context.setOffline(false);
  });
});
