/**
 * The district counters lead to exactly what they counted.
 *
 * The owner's requirement, in their words: a counter reading `Unassigned 5` must be clickable
 * **straight to those unassigned** — *"naa k randomly clickable"*.
 *
 * So the property under test is not "does the click do something". It is **that the number and
 * the rows agree**. A counter saying 5 that lands on 4 rows is worse than one nobody can
 * click: the number is on the district's home screen, it is the thing somebody reads at 02:00,
 * and a board that quietly disagrees with it teaches that neither can be trusted.
 *
 * That agreement is why every flag behind these is decided **on the server**, in the same fold
 * that produced the count (`BoardRow.held`, `.acknowledged`, `.occurredToday`,
 * `.notificationsUnmet`). A predicate re-derived in the browser would be a second
 * implementation of each rule, and the first to drift would break exactly this.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
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

describe.skipIf(dbUrl === undefined)('the district counters', () => {
  let pool: Pool;
  let api: Server;
  let origin: string;
  let browser: Browser;
  let page: Page;
  let office: TestActor;

  beforeAll(async () => {
    const webRoot = await buildWeb();
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    api = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test', webRoot });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    // A district-tier seat: the DC and AC HQ offices, whose dashboard this is.
    office = await seedActor(pool, { title: 'Keys Test DC Office', tier: 'district' });

    browser = await chromium.launch();
    page = await browser.newPage();

    await page.goto(origin);
    await page.waitForSelector('#login');
    await page.fill('#phone', office.phone);
    await page.fill('#password', TEST_PASSWORD);
    await page.click('#loginSubmit');
    await page.waitForSelector('#nav:not([hidden])');
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => api?.close(() => r()));
    await pool?.end();
  });

  /** An emergency nobody is routed to — no routing signals exist, so this is the real path. */
  async function unroutedIncident(): Promise<void> {
    const res = await fetch(`${origin}/incidents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${office.token}` },
      body: JSON.stringify({ category: 'rta', severity: 'high' }),
    });
    expect(res.status).toBe(201);
  }

  async function openDashboard(): Promise<void> {
    await page.click('#navDashboard');
    await page.waitForSelector('#dashboardView:not([hidden])');
    await page.waitForFunction(() => (document.querySelectorAll('#dashKeys .key').length ?? 0) > 0);
  }

  /** The number a named counter is showing. */
  async function counter(label: string): Promise<number> {
    return page.evaluate((want: string) => {
      for (const node of Array.from(document.querySelectorAll('#dashKeys .key'))) {
        if (node.querySelector('.k')?.textContent === want) {
          return Number(node.querySelector('.n')?.textContent ?? '0');
        }
      }
      return -1;
    }, label);
  }

  async function clickCounter(label: string): Promise<void> {
    await page.evaluate((want: string) => {
      for (const node of Array.from(document.querySelectorAll('#dashKeys .key'))) {
        if (node.querySelector('.k')?.textContent === want) (node as HTMLElement).click();
      }
    }, label);
    await page.waitForSelector('#boardView:not([hidden])');
    // The board refetches on arrival; wait for the filter bar it lands with.
    await page.waitForSelector('#boardFilter:not([hidden]), #boardRows .row');
    await page.waitForTimeout(600);
  }

  /**
   * What the click actually selected: which rows are shown, and which are hidden.
   *
   * **Asserted as set membership rather than as a total**, deliberately. The local test
   * database is shared and never cleaned, so other suites are inserting incidents while this
   * one runs — a first version compared the counter's number to the row count and failed with
   * 129 against 127, because the dashboard's fetch and the board's fetch are moments apart and
   * the district had moved in between. The numbers were right; the assertion was measuring
   * the clock.
   *
   * Membership is the stronger property anyway, and it is the one the owner asked for:
   * *straight to those, not randomly clickable.* Every row shown carries the flag, and every
   * row hidden does not — which cannot be satisfied by a filter that merely narrows.
   */
  async function selection(
    attr: string,
    want: string,
  ): Promise<{ wrongShown: number; wrongHidden: number; shown: number }> {
    return page.evaluate(
      ({ attr: a, want: w }) => {
        const rows = Array.from(document.querySelectorAll('#boardRows .row')) as HTMLElement[];
        return {
          shown: rows.filter((r) => !r.hidden).length,
          wrongShown: rows.filter((r) => !r.hidden && r.dataset[a] !== w).length,
          wrongHidden: rows.filter((r) => r.hidden && r.dataset[a] === w).length,
        };
      },
      { attr, want },
    );
  }

  it('leads Unassigned to exactly the emergencies with nobody', async () => {
    await unroutedIncident();
    await unroutedIncident();

    await openDashboard();
    expect(await counter('Unassigned')).toBeGreaterThan(0);

    await clickCounter('Unassigned');

    const { shown, wrongShown, wrongHidden } = await selection('held', 'false');
    expect(shown).toBeGreaterThan(0);
    // Nothing shown that is held by a department, and nothing with nobody left out.
    expect(wrongShown).toBe(0);
    expect(wrongHidden).toBe(0);
    expect(await page.locator('#boardFilterText').textContent()).toMatch(/with nobody/);
  });

  it('leads Not acknowledged to exactly the ones nobody has acknowledged', async () => {
    await unroutedIncident();

    await openDashboard();
    expect(await counter('Not acknowledged')).toBeGreaterThan(0);

    await clickCounter('Not acknowledged');

    const { shown, wrongShown, wrongHidden } = await selection('acknowledged', 'false');
    expect(shown).toBeGreaterThan(0);
    expect(wrongShown).toBe(0);
    expect(wrongHidden).toBe(0);
  });

  /**
   * The one that would have been wrong without asking the board for closed rows.
   *
   * "Reported today" counts everything that happened today whether or not it is still open —
   * an emergency dealt with by lunchtime still happened today. The board's default view hides
   * closed incidents, so this counter would have led to fewer rows than it displayed.
   */
  it('leads Reported today to today’s emergencies, closed ones included', async () => {
    await unroutedIncident();

    await openDashboard();
    expect(await counter('Reported today')).toBeGreaterThan(0);

    await clickCounter('Reported today');

    const { shown, wrongShown, wrongHidden } = await selection('today', 'true');
    expect(shown).toBeGreaterThan(0);
    expect(wrongShown).toBe(0);
    expect(wrongHidden).toBe(0);

    // The board was asked for closed rows, which the default view does not carry.
    const askedForClosed = await page.evaluate(() =>
      performance.getEntriesByType('resource').some((e) => e.name.includes('/incidents?closed=1')),
    );
    expect(askedForClosed).toBe(true);
  });

  it('leads Open now to the whole live board, with no filter left on it', async () => {
    await openDashboard();
    expect(await counter('Open now')).toBeGreaterThan(0);

    await clickCounter('Open now');

    // No filter bar: this counter is the board itself, not a slice of it, so nothing is hidden.
    expect(await page.locator('#boardFilter').isHidden()).toBe(true);
    const hidden = await page.evaluate(
      () =>
        (Array.from(document.querySelectorAll('#boardRows .row')) as HTMLElement[]).filter(
          (r) => r.hidden,
        ).length,
    );
    expect(hidden).toBe(0);
  });

  describe('a counter that counted nothing', () => {
    /**
     * A zero opening a board that says "nothing matches" answers a question the counter had
     * already answered — and teaches that these numbers lead somewhere unreliable, which is
     * expensive for the one that matters at 02:00.
     */
    it('is not clickable', async () => {
      await openDashboard();

      const zeros = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#dashKeys .key'))
          .filter((n) => Number(n.querySelector('.n')?.textContent ?? '0') === 0)
          .map((n) => ({
            label: n.querySelector('.k')?.textContent ?? '',
            clickable: n.classList.contains('go'),
          })),
      );

      for (const zero of zeros) {
        expect(zero.clickable, `"${zero.label}" reads 0 and should not be clickable`).toBe(false);
      }
    });

    it('says so on the ones that did count something', async () => {
      await openDashboard();

      const live = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#dashKeys .key'))
          .filter((n) => Number(n.querySelector('.n')?.textContent ?? '0') > 0)
          .map((n) => ({
            clickable: n.classList.contains('go'),
            // Says where it goes before it is clicked, rather than after.
            label: n.getAttribute('aria-label') ?? '',
          })),
      );

      expect(live.length).toBeGreaterThan(0);
      for (const key of live) {
        expect(key.clickable).toBe(true);
        expect(key.label).toMatch(/^Show /);
      }
    });
  });
});
