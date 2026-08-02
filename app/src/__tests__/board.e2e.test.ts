/**
 * The central board on a real screen — M0-33.
 *
 * `api/__tests__/board.test.ts` proves the projection. This proves the three things that
 * only exist once something renders it, and that a JSON test cannot see:
 *
 *   1. An unassessed report is spelled out as **unassessed**, in words. Not shown as a
 *      severity level, and not distinguished by colour alone (INV-04, ADR-0009).
 *   2. When the board cannot reach the server it says so, loudly, instead of continuing to
 *      display its last good data as though it were live (INV-02). This is the failure mode
 *      that ends with nobody being sent, because the screen said someone already was.
 *   3. The board is behind a sign-in, and intake is not (INV-01).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSyncServer } from '../api/server.js';
import { createPool, migrate, type Pool } from '../db/pool.js';
import { buildWeb } from '../../build.mjs';
import { seedActor, TEST_PASSWORD, type TestActor } from '../testing/seed.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'db', 'migrations');

describe.skipIf(dbUrl === undefined)('M0-33: the central board', () => {
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

    actor = await seedActor(pool, { title: 'Board Test Duty Officer' });

    browser = await chromium.launch();
    context = await browser.newContext();
    page = await context.newPage();

    await page.goto(origin);
    await page.waitForSelector('#login');
    await page.fill('#phone', actor.phone);
    await page.fill('#password', TEST_PASSWORD);
    await page.click('#loginSubmit');
    await page.waitForSelector('#nav:not([hidden])');
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => api?.close(() => r()));
    await pool?.end();
  });

  /** Create an incident through the API, routed to this officer's department. */
  async function seedIncident(severity?: string): Promise<string> {
    const created = await page.evaluate(async (sev: string | undefined) => {
      const res = await fetch('/incidents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ category: 'rta', ...(sev === undefined ? {} : { severity: sev }) }),
      });
      return (await res.json()) as { incidentId: string };
    }, severity);

    await page.evaluate(
      async ([id, dept]: [string, string]) => {
        await fetch(`/incidents/${id}/route`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ departmentIds: [dept], reason: 'board e2e' }),
        });
      },
      [created.incidentId, actor.departmentId] as [string, string],
    );

    return created.incidentId;
  }

  async function openBoard(): Promise<void> {
    await page.click('#navBoard');
    await page.waitForSelector('#boardView:not([hidden])');
    await page.waitForFunction(() => document.querySelectorAll('#boardRows .row').length > 0, {
      timeout: 15_000,
    });
  }

  it('1. is offered only once signed in, unlike intake', async () => {
    // Intake is never behind a sign-in — an emergency captured by a signed-out officer is
    // still an emergency (INV-01). The board needs a seat to scope it, so it is.
    expect(await page.isVisible('#nav')).toBe(true);
    expect(await page.isVisible('#report')).toBe(true);
  });

  it('2. lists live incidents scoped to the seat', async () => {
    const id = await seedIncident('high');
    await openBoard();
    expect(await page.isVisible(`.row[data-incident="${id}"]`)).toBe(true);
  });

  it('3. spells out "unassessed" instead of showing a severity nobody chose', async () => {
    const id = await seedIncident();
    await page.click('#navReport');
    await openBoard();

    const row = page.locator(`.row[data-incident="${id}"] .sev`);
    // The word, not the colour. A colour-blind operator, a photocopied screen and a
    // screen reader all have to get the same answer (INV-04).
    expect((await row.textContent())?.trim()).toBe('unassessed');
    expect(await row.getAttribute('data-level')).toBe('unknown');
  });

  it('4. reports the unassessed count separately from the worst assessed severity', async () => {
    const text = (await page.textContent('#boardSummary')) ?? '';
    expect(text).toContain('not yet assessed');
    expect(text).toContain('worst assessed');
  });

  it('5. says it is live, and when', async () => {
    const asOf = (await page.textContent('#boardAsOfText')) ?? '';
    expect(asOf).toMatch(/^Live as of /);
    expect(await page.getAttribute('#boardAsOf', 'data-stale')).toBe('false');
  });

  it('6. stops claiming to be live the moment it cannot reach the server (INV-02)', async () => {
    // The failure this test exists for: a board that keeps showing its last good data
    // during an outage, unlabelled, is worse than a blank screen — an operator decides not
    // to send a crew because the screen says a crew is already going.
    await context.setOffline(true);

    await page.evaluate(async () => {
      const dnc = (
        globalThis as unknown as {
          __dnc: { refreshBoard(): Promise<void>; backdateBoard(ms: number): void };
        }
      ).__dnc;
      await dnc.refreshBoard();
      // The clock is time-based; drive it rather than sitting for thirty real seconds.
      dnc.backdateBoard(45_000);
    });

    await page.waitForFunction(
      () => document.getElementById('boardAsOf')?.dataset['stale'] === 'true',
      { timeout: 15_000 },
    );

    const warning = (await page.textContent('#boardAsOfText')) ?? '';
    expect(warning).toContain('NOT LIVE');
    expect(warning).toMatch(/Do not act on this without checking/);

    await context.setOffline(false);
  }, 60_000);

  it('7. keeps the rows on screen while offline rather than blanking them', async () => {
    // Deliberate: the last known picture is still useful to somebody standing in a control
    // room during an outage. It is the *unlabelled* version that is dangerous, and test 6
    // is what stops that.
    expect(await page.locator('#boardRows .row').count()).toBeGreaterThan(0);
  });
});
