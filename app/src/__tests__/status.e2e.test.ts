/**
 * The Status screen — M4, in a real browser.
 *
 * This is the screen that makes the dashboard true. Everything the dashboard displays about
 * the district's own condition is typed here, so the loop that matters is: **somebody states
 * a fact on one screen and it appears on the other**, with an author and a time attached.
 *
 * Two things are pinned besides that loop.
 *
 * **A department sees only what it may change.** The generous failure here is the same one
 * migration 0010 already produced once — a department able to act on another's data — and it
 * would be invisible until the day somebody used it.
 *
 * **A hidden control is not a control.** Every refusal asserted through the interface is also
 * asserted directly against the API, because INV-05 says the UI is never the enforcement
 * layer and a test that only clicks buttons cannot tell the difference.
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
import { seedActor, seedDepartment, TEST_PASSWORD, type TestActor } from '../testing/seed.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'db', 'migrations');

const RUN = randomUUID().slice(0, 8);

/**
 * Poll a value until it satisfies a predicate.
 *
 * Deliberately not `page.waitForFunction`: this suite has been bitten three times by that
 * function's behaviour with an async callback, and a predicate evaluated here is one that can
 * be read and debugged in the same place as the assertion it precedes.
 */
async function until<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const value = await read();
    if (done(value)) return value;

    if (Date.now() > deadline) {
      throw new Error(`condition never held; last value was ${JSON.stringify(value)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe.skipIf(dbUrl === undefined)('M4: the Status screen', () => {
  /**
   * The row for one named thing.
   *
   * `locator('.srow', { hasText: name })` looks right and is not: `hasText` searches the whole
   * subtree, and every row carries a department `<select>` whose options are department names.
   * With test departments named after the run, three unrelated rows matched, and the assertion
   * read whichever one Playwright reached first — reporting "nobody assigned" about a service
   * that had just been assigned correctly.
   *
   * Matching the `.sname` element exactly is the only form that means what it reads as.
   */
  function rowFor(page: Page, name: string) {
    return page.locator('.srow').filter({ has: page.getByText(name, { exact: true }) });
  }

  let pool: Pool;
  let api: Server;
  let origin: string;
  let browser: Browser;

  let office: BrowserContext;
  let officePage: Page;
  let department: BrowserContext;
  let departmentPage: Page;

  let deptId: string;
  let deptActor: TestActor;

  async function signIn(page: Page, actor: TestActor): Promise<void> {
    await page.goto(origin);
    await page.waitForSelector('#login');
    await page.fill('#phone', actor.phone);
    await page.fill('#password', TEST_PASSWORD);
    await page.click('#loginSubmit');
    await page.waitForSelector('#nav:not([hidden])');
  }

  async function openStatus(page: Page): Promise<void> {
    await page.click('#navStatus');
    await page.waitForFunction(
      () => (document.getElementById('statusBody')?.childElementCount ?? 0) > 0,
      undefined,
      { timeout: 15_000 },
    );
  }

  beforeAll(async () => {
    const webRoot = await buildWeb();
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    api = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test', webRoot });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    const dcDept = await seedDepartment(pool, `DC Office (status ${RUN})`);
    await pool.query('UPDATE department SET is_administration = true WHERE department_id = $1', [
      dcDept,
    ]);
    const dc = await seedActor(pool, {
      title: `Deputy Commissioner (status ${RUN})`,
      departmentId: dcDept,
      tier: 'district',
    });

    deptId = await seedDepartment(pool, `PESCO (status ${RUN})`);
    deptActor = await seedActor(pool, {
      title: `XEN (status ${RUN})`,
      departmentId: deptId,
    });

    // A service this department answers for, and one it does not.
    await pool.query(
      `INSERT INTO utility (name, panel, department_id) VALUES ($1, 'utility', $2)`,
      [`Feeder ${RUN}`, deptId],
    );

    await pool.query(`INSERT INTO utility (name, panel) VALUES ($1, 'services')`, [
      `Markets ${RUN}`,
    ]);

    browser = await chromium.launch();

    office = await browser.newContext();
    officePage = await office.newPage();
    await signIn(officePage, dc);

    department = await browser.newContext();
    departmentPage = await department.newPage();
    await signIn(departmentPage, deptActor);
  }, 240_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => api?.close(() => r()));
    await pool?.end();
  });

  it('1. is offered to everybody signed in, department and office alike', async () => {
    // Not an administration screen. Every department states its own condition, which was the
    // owner's instruction about departmental data, applied to this.
    //
    // `isVisible` rather than Playwright's `expect(...).toBeVisible()`: this suite asserts
    // with vitest's expect, which does not carry Playwright's matchers.
    expect(await officePage.isVisible('#navStatus')).toBe(true);
    expect(await departmentPage.isVisible('#navStatus')).toBe(true);
  });

  it('2. a department reports its own service, and the dashboard says so', async () => {
    await openStatus(departmentPage);

    const row = rowFor(departmentPage, `Feeder ${RUN}`);
    await row.locator('input.snote').fill('Transformer failed at Kakki');
    await row.locator('button.sbtn.down').click();

    await departmentPage.click('#navDashboard');

    // The loop this screen exists for: stated on one screen, visible on the other.
    await departmentPage.waitForFunction(
      () =>
        document.getElementById('dashUtilities')?.textContent?.includes('Transformer failed') ===
        true,
      undefined,
      { timeout: 15_000 },
    );

    const panel = (await departmentPage.textContent('#dashUtilities')) ?? '';
    expect(panel).toContain('Down');
    // The age is on the row whether or not anything is wrong, so nobody learns that a missing
    // age means fine (ADR-0005).
    expect(panel).toMatch(/just now|min ago/);
  });

  it('3. shows a department nothing it does not answer for', async () => {
    await openStatus(departmentPage);

    const body = (await departmentPage.textContent('#statusBody')) ?? '';
    expect(body).toContain(`Feeder ${RUN}`);
    expect(body).not.toContain(`Markets ${RUN}`);
  });

  it('4. refuses a department that reaches past the screen (INV-05)', async () => {
    // The interface did not offer it. That is a courtesy; this is the control.
    const refused = await departmentPage.evaluate(async () => {
      const res = await fetch('/status/alerts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tag: 'road', message: 'not mine to issue', untilAt: '2030-01-01' }),
      });
      return res.status;
    });

    expect(refused).toBe(403);
  });

  it('5. an office issues an advisory, and it reaches the dashboard', async () => {
    await openStatus(officePage);

    await officePage.fill('#alertMessage', `Kohat Road closed ${RUN}`);
    await officePage.click('#issueAlert');

    await officePage.click('#navDashboard');
    await officePage.waitForFunction(
      (needle) => document.getElementById('dashAlerts')?.textContent?.includes(needle) === true,
      `Kohat Road closed ${RUN}`,
      { timeout: 15_000 },
    );
  });

  it('6. refuses an advisory with no end, rather than accepting one that never expires', async () => {
    // The whole reason advisory boards rot: the road reopens and the notice stays up until it
    // is furniture. The server requires an end; this proves it says so rather than silently
    // storing one.
    const problem = await officePage.evaluate(async () => {
      const res = await fetch('/status/alerts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tag: 'road', message: 'no end given' }),
      });
      return { status: res.status, body: (await res.json()) as { error?: string } };
    });

    expect(problem.status).toBe(400);
    expect(problem.body.error).toContain('ends');
  });

  it('7. an office assigns a service a department, and the gap stops being a gap', async () => {
    await openStatus(officePage);

    const row = rowFor(officePage, `Markets ${RUN}`);
    expect(await row.locator('.age').textContent()).toBe('nobody assigned');

    // By value, not by label. The option's text is a department name the district chose, and
    // a test that matches on it fails the day somebody renames a department.
    await row.locator('select.sassign').selectOption(deptId);

    // The record first, then the screen. Asserting only the screen cannot tell "the write
    // failed" from "the write worked and the screen did not repaint", and those are different
    // bugs in different files.
    const stored = await until(
      async () =>
        (
          await pool.query<{ department_id: string | null }>(
            'SELECT department_id FROM utility WHERE name = $1',
            [`Markets ${RUN}`],
          )
        ).rows[0]?.department_id ?? null,
      (value) => value !== null,
    );
    expect(stored).toBe(deptId);

    // Poll the row itself. A `waitForFunction` that re-queries the document has to re-find the
    // row after every re-render, and a predicate that returns `undefined` for "not found yet"
    // is indistinguishable from one returning false for "not changed yet".
    await until(
      () => rowFor(officePage, `Markets ${RUN}`).locator('.age').textContent(),
      (text) => text !== null && !text.includes('nobody assigned'),
    );

    // And the department can now see and report it, which is the point of assigning it.
    await departmentPage.reload();
    await departmentPage.waitForSelector('#navStatus:not([hidden])');
    await openStatus(departmentPage);

    expect(await departmentPage.textContent('#statusBody')).toContain(`Markets ${RUN}`);
  });

  it('8. records who said what, in the change log', async () => {
    const changes = await pool.query<{ subject: string; reason: string | null }>(
      `SELECT subject, reason FROM config_event
        WHERE subject IN ('district_alert', 'utility')
        ORDER BY seq DESC LIMIT 5`,
    );

    // A configuration change with nobody's name on it is exactly what the log exists to
    // prevent (migration 0007).
    expect(changes.rows.length).toBeGreaterThan(0);
    expect(changes.rows.some((r) => r.subject === 'district_alert')).toBe(true);
  });
});
