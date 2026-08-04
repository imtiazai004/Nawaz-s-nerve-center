/**
 * Searching the record, on a real screen — capability group 9.
 *
 * `api/__tests__/search.test.ts` proves the query. This proves the part that only exists once
 * something renders it, and it is the part this screen was built for:
 *
 *   1. **A search that finds nothing says what it looked at.** "Nothing matched" and "nothing
 *      matched in the window you happened to pick" are different statements about the
 *      district, and only the screen can tell them apart. ADR-0005, applied to a query.
 *   2. **A found incident reads exactly as it does on the board**, because both are built by
 *      the same renderer. A second one would drift, and then an emergency would say
 *      `unassessed` on one screen and something else on the other (INV-04).
 *   3. **The endpoint is reachable by a person**, which is the whole reason this file exists:
 *      `/search` shipped with nothing calling it, and an endpoint with no door is not a
 *      capability.
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

describe.skipIf(dbUrl === undefined)('searching the record, on a screen', () => {
  let pool: Pool;
  let api: Server;
  let origin: string;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let actor: TestActor;
  let controlRoom: TestActor;

  beforeAll(async () => {
    const webRoot = await buildWeb();
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    api = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test', webRoot });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    actor = await seedActor(pool, { title: 'Search Test Duty Officer' });
    controlRoom = await seedActor(pool, { title: 'Search Test Control Room', tier: 'district' });

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

  /** An incident routed to this officer's department, so it is genuinely theirs to find. */
  async function seedIncident(description: string): Promise<string> {
    const created = await page.evaluate(async (words: string) => {
      const res = await fetch('/incidents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ category: 'rta', description: words }),
      });
      return (await res.json()) as { incidentId: string };
    }, description);

    const routed = await fetch(`${origin}/incidents/${created.incidentId}/route`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${controlRoom.token}`,
      },
      body: JSON.stringify({ departmentIds: [actor.departmentId], reason: 'search e2e' }),
    });
    expect(routed.status).toBe(200);

    return created.incidentId;
  }

  async function openSearch(): Promise<void> {
    await page.click('#navSearch');
    await page.waitForSelector('#searchView:not([hidden])');
  }

  it('is reachable from the navigation, which is the point of it', async () => {
    await openSearch();

    // The date range fills itself in, so the first search somebody tries is a real one
    // rather than an error about a missing field.
    expect(await page.inputValue('#searchFrom')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(await page.inputValue('#searchTo')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('finds an incident by the words in the report', async () => {
    const marker = `bypass-tanker-${Date.now()}`;
    const id = await seedIncident(marker);

    await openSearch();
    await page.fill('#searchText', marker);
    await page.click('#searchForm button[type="submit"]');

    await page.waitForSelector(`#searchRows .row[data-incident="${id}"]`);
    expect(await page.locator('#searchSummary').textContent()).toMatch(/emergenc/);
  });

  /**
   * The reason the response echoes its window at all.
   *
   * An operator who searches, finds nothing, and is shown only "no results" concludes the
   * emergency never happened. The truth may be that it happened outside the fortnight they
   * happened to pick. The screen has to say which.
   */
  it('says what it searched when it finds nothing, rather than only "nothing"', async () => {
    await openSearch();
    await page.fill('#searchText', `no-such-thing-${Date.now()}`);
    await page.click('#searchForm button[type="submit"]');

    await page.waitForFunction(() => {
      const text = document.getElementById('searchSummary')?.textContent ?? '';
      return text.includes('Nothing');
    });

    const summary = (await page.locator('#searchSummary').textContent()) ?? '';

    // The window, in words, both ends of it.
    expect(summary).toMatch(/between .+ to .+/);
    expect(await page.locator('#searchRows .row').count()).toBe(0);
  });

  /**
   * One renderer, so a found incident cannot read differently from a live one.
   *
   * An unassessed report says the **word** on the board (INV-04, ADR-0009); if search built
   * its own rows it would eventually stop doing that, and the screen somebody uses to write a
   * post-incident report would be the one telling a different story.
   */
  it('renders a found incident exactly as the board does', async () => {
    const marker = `same-renderer-${Date.now()}`;
    const id = await seedIncident(marker);

    await openSearch();
    await page.fill('#searchText', marker);
    await page.click('#searchForm button[type="submit"]');
    await page.waitForSelector(`#searchRows .row[data-incident="${id}"]`);

    const inSearch = await page.locator(`#searchRows .row[data-incident="${id}"]`).innerHTML();

    await page.click('#navBoard');
    await page.waitForSelector(`#boardRows .row[data-incident="${id}"]`);
    const onBoard = await page.locator(`#boardRows .row[data-incident="${id}"]`).innerHTML();

    expect(inSearch).toBe(onBoard);
  });

  it('opens an incident from a result, through the same detail screen', async () => {
    const marker = `open-from-search-${Date.now()}`;
    const id = await seedIncident(marker);

    await openSearch();
    await page.fill('#searchText', marker);
    await page.click('#searchForm button[type="submit"]');
    await page.click(`#searchRows .row[data-incident="${id}"]`);

    await page.waitForSelector('#detailView:not([hidden])');
  });

  /**
   * The post-incident report, and the PDF the scope list asks for.
   *
   * M1-06 built the report and served it at `GET /incidents/:id/report`. Like search and
   * export, **nothing in the client ever called it** — an operator asked for a report had no
   * way to get one. It is reached from the incident it is about rather than from a tab,
   * because nobody wants "a report": they want the report for the emergency in front of them.
   *
   * The PDF is the browser's own print dialogue driven by a print stylesheet, so there is
   * nothing to assert about the file itself — only that the document exists, says the true
   * things, and that the navigation is marked not to print.
   */
  describe('the post-incident report', () => {
    async function openReportFor(marker: string): Promise<string> {
      const id = await seedIncident(marker);

      await openSearch();
      await page.fill('#searchText', marker);
      await page.click('#searchForm button[type="submit"]');
      await page.click(`#searchRows .row[data-incident="${id}"]`);
      await page.waitForSelector('#detailView:not([hidden])');

      await page.click('#detailReport');
      await page.waitForSelector('#piReportView:not([hidden])');
      await page.waitForFunction(() =>
        (document.getElementById('piReportBody')?.textContent ?? '').includes('Incident'),
      );

      return id;
    }

    it('is reached from the incident, and folds without anything being typed', async () => {
      const id = await openReportFor(`report-screen-${Date.now()}`);

      const text = (await page.locator('#piReportBody').textContent()) ?? '';
      expect(text).toContain(id);
      expect(text).toMatch(/Post-incident report/);
    });

    /**
     * The section a hand-written report always omits, and the one a review most needs.
     *
     * Printed always — including when there is nothing missing, because "we checked and found
     * no gaps" and "nobody looked" must not read identically (ADR-0005).
     */
    it('always states what the record does not contain', async () => {
      await openReportFor(`report-gaps-${Date.now()}`);

      expect(await page.locator('#piReportBody').textContent()).toMatch(
        /What this record does not contain/,
      );
    });

    it('keeps the navigation off the printed page', async () => {
      // The PDF is the browser's print of this screen. A printed page has no tab bar, and a
      // report carrying one is a report somebody has to explain when they file it.
      const marked = await page.evaluate(
        () => document.getElementById('piReportActions')?.classList.contains('noPrint') ?? false,
      );

      expect(marked).toBe(true);
    });
  });

  describe('taking the record out', () => {
    it('offers the export from the board, as a real download link', async () => {
      await page.click('#navBoard');
      await page.waitForSelector('#boardView:not([hidden])');

      const href = await page.getAttribute('#boardExportLink', 'href');
      expect(href).toMatch(/^\/export\/incidents\.csv/);
      // A plain link, so the browser does the download. A fetch-and-blob would take that away.
      expect(await page.getAttribute('#boardExportLink', 'download')).not.toBeNull();
    });

    it('serves a spreadsheet that carries the caller’s own incidents', async () => {
      const marker = `exported-${Date.now()}`;
      const id = await seedIncident(marker);

      const csv = await page.evaluate(async () => {
        const res = await fetch('/export/incidents.csv?days=7', { cache: 'no-store' });
        return {
          status: res.status,
          type: res.headers.get('content-type'),
          body: await res.text(),
        };
      });

      expect(csv.status).toBe(200);
      expect(csv.type).toMatch(/text\/csv/);
      expect(csv.body).toContain(id);
      // Capability 12: nothing a reporter told us in confidence leaves in this file.
      expect(csv.body).not.toMatch(/\+92|03\d{9}/);
    });
  });
});
