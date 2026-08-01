/**
 * Signing in, from a real browser.
 *
 * Two claims matter more than the rest, and both are about telling the truth:
 *
 *   1. "Signed out" and "no signal" are shown as different things. They need different
 *      actions from the operator, and confusing them sends someone hunting for signal on a
 *      working connection while a report sits undelivered.
 *   2. An emergency can be recorded whether or not anyone is signed in. A duty officer
 *      whose session expired overnight, on a handset with no signal, cannot sign in — and
 *      refusing them would lose the emergency outright (INV-01).
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
import { seedActor, TEST_PASSWORD, type TestActor } from '../testing/seed.js';
import { revokeAllForPerson } from '../auth/sessions.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'db', 'migrations');

describe.skipIf(dbUrl === undefined)('signing in', () => {
  let pool: Pool;
  let api: Server;
  let origin: string;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let actor: TestActor;

  beforeAll(async () => {
    const webRoot = await buildWeb();
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    api = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test', webRoot });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    actor = await seedActor(pool, { title: 'Login Test Duty Officer' });

    browser = await chromium.launch();
    context = await browser.newContext();
    page = await context.newPage();
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => api?.close(() => r()));
    await pool?.end();
  });

  async function statusState(): Promise<string | null> {
    return page.getAttribute('#status', 'data-state');
  }

  async function signIn(phone: string, password: string): Promise<void> {
    await page.fill('#phone', phone);
    await page.fill('#password', password);
    await page.click('#loginSubmit');
  }

  it('1. shows the sign-in form when nobody is signed in', async () => {
    await page.goto(origin);
    await page.waitForSelector('#login');

    expect(await page.isVisible('#loginView')).toBe(true);
    expect(await page.isVisible('#who')).toBe(false);
  });

  it('2. refuses a wrong password without saying which part was wrong', async () => {
    await signIn(actor.phone, 'definitely-not-the-password');
    await page.waitForSelector('#loginError', { state: 'visible', timeout: 10_000 });

    const message = await page.textContent('#loginError');
    expect(message).toMatch(/not correct/i);
    // No hint about whether the number exists — that list is what an attacker wants.
    expect(message).not.toMatch(/no such|unknown number|user not found/i);
    expect(await page.isVisible('#loginView')).toBe(true);
  });

  it('3. signs in with correct credentials and shows who is on duty', async () => {
    await signIn(actor.phone, TEST_PASSWORD);
    await page.waitForSelector('#who', { state: 'visible', timeout: 10_000 });

    expect(await page.isVisible('#loginView')).toBe(false);
    expect(await page.textContent('#whoName')).toBeTruthy();

    await page.waitForFunction(
      () => document.getElementById('status')?.dataset['state'] === 'online',
      undefined,
      { timeout: 10_000 },
    );
  });

  it('4. stays signed in across a reload', async () => {
    await page.reload();
    await page.waitForSelector('#who', { state: 'visible', timeout: 20_000 });
    expect(await page.isVisible('#loginView')).toBe(false);
  });

  /** Poll the database for a report. Waiting on an empty queue races the submit itself. */
  async function storedCount(place: string): Promise<number> {
    const res = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM incident_event WHERE payload->>'place' = $1`,
      [place],
    );
    return Number(res.rows[0]!.n);
  }

  async function waitForStored(place: string, timeoutMs = 15_000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    let n = 0;
    while (Date.now() < deadline) {
      n = await storedCount(place);
      if (n > 0) return n;
      await new Promise((r) => setTimeout(r, 100));
    }
    return n;
  }

  it('5. a report delivers immediately while signed in', async () => {
    const place = `Signed in ${randomUUID()}`;
    await page.selectOption('#severity', 'critical');
    await page.fill('#place', place);
    await page.click('#submit');

    expect(await waitForStored(place)).toBe(1);
  });

  describe('a session that goes away underneath the operator', () => {
    const place = `Revoked ${randomUUID()}`;

    it('6. reports "signed out", not "no connection"', async () => {
      // Revoked by an administrator, exactly as a compromised account would be.
      await revokeAllForPerson(pool, actor.personId);

      await page.evaluate(async () => {
        await (globalThis as unknown as { __dnc: { trySync(): Promise<void> } }).__dnc.trySync();
      });

      await page.waitForFunction(
        () => document.getElementById('status')?.dataset['state'] === 'signedout',
        undefined,
        { timeout: 10_000 },
      );

      expect(await statusState()).toBe('signedout');
      const text = await page.textContent('#status');
      expect(text).toMatch(/signed out/i);
      // The distinction that matters: this is not a connectivity problem.
      expect(text).not.toMatch(/no connection/i);
    });

    it('7. drops back to the sign-in form', async () => {
      await page.waitForSelector('#loginView', { state: 'visible', timeout: 10_000 });
      expect(await page.isVisible('#who')).toBe(false);
    });

    it('8. still records an emergency while signed out, and keeps it', async () => {
      await page.selectOption('#severity', 'critical');
      await page.fill('#place', place);
      await page.click('#submit');

      await page.waitForFunction(
        () => document.querySelectorAll('#entries .entry').length === 1,
        undefined,
        { timeout: 10_000 },
      );

      // Held, not lost, and not claimed to be delivered.
      const badge = await page.textContent('.badge');
      expect(badge).toMatch(/saved on this device/i);
      expect(await storedCount(place)).toBe(0);
    });

    it('9. delivers it on the next sign-in, with no operator action', async () => {
      await signIn(actor.phone, TEST_PASSWORD);
      await page.waitForSelector('#who', { state: 'visible', timeout: 10_000 });

      // Nobody pressed anything to send it. Signing in was enough.
      expect(await waitForStored(place)).toBe(1);
    });

    it('10. attributes it to whoever delivered it', async () => {
      // The honest available answer. Whoever signed in is identifiable and accountable;
      // the alternative was no record at all.
      const row = await pool.query<{ actor_person_id: string | null }>(
        `SELECT actor_person_id FROM incident_event WHERE payload->>'place' = $1`,
        [place],
      );
      expect(row.rows[0]!.actor_person_id).toBe(actor.personId);
    });
  });

  describe('signing out', () => {
    it('11. returns to the sign-in form and reports being signed out', async () => {
      await page.click('#logout');
      await page.waitForSelector('#loginView', { state: 'visible', timeout: 10_000 });
      expect(await page.isVisible('#who')).toBe(false);
    });

    it('12. the old session is genuinely dead server-side, not just hidden', async () => {
      // INV-05 again: hiding the UI is not the control. The cookie must be refused.
      const cookies = await context.cookies();
      const session = cookies.find((c) => c.name === 'dnc_session');
      const res = await fetch(`${origin}/auth/me`, {
        headers: session === undefined ? {} : { cookie: `dnc_session=${session.value}` },
      });
      expect(res.status).toBe(401);
    });
  });

  describe('offline sign-in', () => {
    it('13. says signing in needs a connection, rather than failing silently', async () => {
      await context.setOffline(true);
      await page.reload();
      await page.waitForSelector('#login', { timeout: 20_000 });

      // Waits for a *measured* failure to reach the server. Chromium still reports
      // navigator.onLine === true here, so anything keyed on that would never appear —
      // which is exactly how this test caught the bug.
      await page.waitForSelector('#offlineLoginNote', { state: 'visible', timeout: 15_000 });
      expect(await page.isDisabled('#loginSubmit')).toBe(true);
      expect(await page.evaluate(() => navigator.onLine)).toBe(true);
    });

    it('14. records an emergency anyway — offline and signed out', async () => {
      // The worst case this district has: a shutdown, an expired session, and an accident.
      const place = `Offline signed out ${randomUUID()}`;
      await page.selectOption('#severity', 'critical');
      await page.fill('#place', place);
      await page.click('#submit');

      await page.waitForFunction(
        () => document.querySelectorAll('#entries .entry').length >= 1,
        undefined,
        { timeout: 10_000 },
      );

      expect(await page.textContent('.badge')).toMatch(/saved on this device/i);
      await context.setOffline(false);
    });
  });

  describe('the cache never holds an identity', () => {
    it('15. no /auth response is in any cache', async () => {
      // A cached identity on a shared handset shows the previous holder as signed in after
      // a shift change, and attributes their reports to someone who has gone home.
      const cached = await page.evaluate(async () => {
        const names = await caches.keys();
        const urls: string[] = [];
        for (const name of names) {
          const cache = await caches.open(name);
          for (const req of await cache.keys()) urls.push(new URL(req.url).pathname);
        }
        return urls;
      });

      expect(cached.filter((u) => u.startsWith('/auth'))).toHaveLength(0);
      expect(cached).toContain('/index.html');
    });
  });
});
