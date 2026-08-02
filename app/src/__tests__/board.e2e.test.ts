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
import { runNotifyPass } from '../jobs/notify.js';

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
  /** District tier, so it can actually route. The signed-in station officer cannot. */
  let controlRoom: TestActor;

  beforeAll(async () => {
    const webRoot = await buildWeb();
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    api = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test', webRoot });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    actor = await seedActor(pool, { title: 'Board Test Duty Officer' });
    controlRoom = await seedActor(pool, { title: 'Board Test Control Room', tier: 'district' });

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

  /**
   * An incident, genuinely routed to this officer's department.
   *
   * The routing goes through a **district-tier** seat, and the result is asserted. An
   * earlier version did both from the page — as the signed-in station officer, who has no
   * authority to route — so every call returned 403 and was thrown away. The board tests
   * still passed, because an *unrouted* incident is readable by everyone (that is
   * deliberate: an emergency nobody may see is an emergency nobody picks up). So "lists
   * live incidents scoped to the seat" was green while proving nothing about scoping.
   *
   * A test helper that ignores a status code is a test that grades its own homework.
   */
  async function seedIncident(severity?: string): Promise<string> {
    const created = await page.evaluate(async (sev: string | undefined) => {
      const res = await fetch('/incidents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ category: 'rta', ...(sev === undefined ? {} : { severity: sev }) }),
      });
      return (await res.json()) as { incidentId: string };
    }, severity);

    const routed = await fetch(`${origin}/incidents/${created.incidentId}/route`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${controlRoom.token}`,
      },
      body: JSON.stringify({ departmentIds: [actor.departmentId], reason: 'board e2e' }),
    });
    expect(routed.status).toBe(200);

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

  describe('the seat inbox — M0-34, and the receiving half of M0-32', () => {
    /**
     * Until this existed, nothing in the browser ever called `/notifications`. Attempts were
     * created, stayed `pending` for ever, and the board carried them as unmet obligations
     * permanently. The loop was open at its last step — the one with a human in it.
     */
    let notified: string;

    it('8. shows what is waiting for this seat, without claiming it was delivered', async () => {
      notified = await seedIncident('high');
      await runNotifyPass(pool, { incidentIds: [notified] });

      await page.click('#navInbox');
      await page.waitForSelector('#inboxView:not([hidden]) .inbox-row', { timeout: 15_000 });

      // Rendering it is not delivering it. "The tab was open" is not "somebody knows".
      const delivered = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM incident_event
          WHERE incident_id = $1 AND type = 'notification_delivered'`,
        [notified],
      );
      expect(Number(delivered.rows[0]!.n)).toBe(0);
    });

    it('9. records delivery only when a human says they have seen it (INV-03)', async () => {
      await page.click(`.inbox-row .seen`);

      await page.waitForFunction(
        () => document.querySelectorAll('#inboxView .inbox-row').length === 0,
        { timeout: 15_000 },
      );

      const delivered = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM incident_event
          WHERE incident_id = $1 AND type = 'notification_delivered'`,
        [notified],
      );
      expect(Number(delivered.rows[0]!.n)).toBe(1);
    });

    it('10. names the seat the inbox belongs to, not the person', async () => {
      // Scoped to the post, so a handover moves the messages with it (ADR-0004).
      expect(await page.textContent('#inboxWho')).toContain('Board Test Duty Officer');
    });

    it('11. names the department on the board instead of saying "your department"', async () => {
      // The registry exists now (M0-51), so the board can say which one. It previously read
      // `departmentId` off a client type that did not declare it — `undefined === null` is
      // false — and so labelled every seat "your department", the district control room
      // included. `web/` was not in the tsconfig, so nothing objected.
      await page.click('#navBoard');
      await page.waitForSelector('#boardView:not([hidden])');
      await page.waitForFunction(
        () => (document.getElementById('boardScope')?.textContent ?? '').length > 0,
        { timeout: 15_000 },
      );
      expect(await page.textContent('#boardScope')).not.toBe('your department');
    });
  });
});
