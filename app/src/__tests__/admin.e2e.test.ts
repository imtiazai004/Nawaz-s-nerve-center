/**
 * The administration console on a real screen — M1a.
 *
 * `api/__tests__/admin.test.ts` proves the endpoints. This proves the things that only exist
 * once something renders them, and that a JSON test cannot see:
 *
 *   1. **The tab is not offered to a department**, and — the part that matters — offering it
 *      was never the control. A department seat that reaches the endpoint anyway is refused
 *      by the server (INV-05).
 *   2. **The whole loop happens in a browser.** An operator types a department name, types a
 *      routing signal, and an emergency reaches it. No developer, no restart, no code.
 *   3. **Unassigned emergencies are loud.** Above the summary, above every row, in words
 *      (ADR-0005, INV-04).
 *   4. **A department with no routing signal says so**, rather than sitting there looking
 *      configured. Nothing will ever reach it, and that is not a neutral default.
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

/** Unique per run: departments are never deleted, so a fixed name collides on the second run. */
const RUN = randomUUID().slice(0, 8);

describe.skipIf(dbUrl === undefined)('M1a: the administration console', () => {
  let pool: Pool;
  let api: Server;
  let origin: string;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  let dc: TestActor;
  let rescue: TestActor;

  async function signIn(actor: TestActor): Promise<void> {
    // Clear the session first, or the sign-in form is not there to fill in.
    //
    // The suite signs in as two different officers, and the second call sat waiting for a
    // `#login` that stays hidden while somebody is still signed in — which is the app
    // behaving correctly. Sessions are HttpOnly cookies, so dropping the cookie is how a
    // test starts from signed-out; reaching for the sign-out button would only work when
    // the previous test happened to leave the page in a state that shows one.
    await context.clearCookies();
    await page.goto(origin);
    await page.waitForSelector('#login');
    await page.fill('#phone', actor.phone);
    await page.fill('#password', TEST_PASSWORD);
    await page.click('#loginSubmit');
    await page.waitForSelector('#nav:not([hidden])');
  }

  /**
   * Poll in the test process until a condition holds.
   *
   * Not `page.waitForFunction`. Given an async callback it resolves on the returned Promise
   * object, which is always truthy, so it succeeded instantly and the assertion after it read
   * a value the server had not been given yet. That produced a failure that looked like the
   * SLA configuration being ignored, and was a broken wait.
   */
  async function until<T>(read: () => Promise<T>, holds: (v: T) => boolean): Promise<T> {
    const deadline = Date.now() + 10_000;
    let last = await read();
    while (!holds(last) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      last = await read();
    }
    return last;
  }

  beforeAll(async () => {
    const webRoot = await buildWeb();
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    api = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test', webRoot });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    const dcDept = await seedDepartment(pool, `DC Office (e2e ${RUN})`);
    await pool.query('UPDATE department SET is_administration = true WHERE department_id = $1', [
      dcDept,
    ]);

    dc = await seedActor(pool, {
      title: `Deputy Commissioner (e2e ${RUN})`,
      departmentId: dcDept,
      tier: 'district',
    });
    rescue = await seedActor(pool, { title: `Rescue Duty (e2e ${RUN})`, tier: 'station' });

    // This suite asserts exactly where an emergency goes, so it needs to own the district's
    // routing configuration. See the same note in `api/__tests__/admin.test.ts`.
    await pool.query('UPDATE routing_signal SET retired_at = now() WHERE retired_at IS NULL');

    browser = await chromium.launch();
    context = await browser.newContext();
    page = await context.newPage();
  }, 240_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => api?.close(() => r()));
    await pool?.end();
  });

  it('1. does not offer the console to a department seat', async () => {
    await signIn(rescue);
    expect(await page.locator('#navAdmin').isVisible()).toBe(false);
  });

  it('2. and refuses it server-side when the tab is bypassed entirely (INV-05)', async () => {
    // The tab being hidden is a courtesy. This is the control. A department officer who
    // knows the URL — or a stolen session in a script — gets the same answer.
    const status = await page.evaluate(async () => {
      const res = await fetch('/admin/departments');
      return res.status;
    });
    expect(status).toBe(403);
  });

  it('3. offers it to the administration', async () => {
    await signIn(dc);
    await page.waitForSelector('#navAdmin:not([hidden])');
    expect(await page.locator('#navAdmin').isVisible()).toBe(true);
  });

  it('4. the gate: an operator adds a department and an emergency reaches it', async () => {
    await page.click('#navAdmin');
    await page.waitForSelector('#adminDepartments');

    // Typed into the form, by a person, on a screen.
    await page.fill('#newDeptName', `Irrigation e2e ${RUN}`);
    await page.fill('#newDeptPhone', '0928-000000');
    await page.click('#addDepartmentSubmit');

    const card = page.locator('.dept', { hasText: `Irrigation e2e ${RUN}` });
    await card.waitFor();

    // A department with no routing signals is named as such rather than left looking done.
    // Nothing will ever reach it, and a blank space would not say that.
    expect(await card.locator('.nosignals').count()).toBe(1);

    await card.locator('.addsignal select').selectOption('keyword');
    await card.locator('.addsignal input').fill(`nehr${RUN}`);
    await card.locator('.addsignal button').click();

    await page
      .locator('.dept', { hasText: `Irrigation e2e ${RUN}` })
      .locator('.signal')
      .waitFor();

    // Now an emergency, reported by a different officer entirely, with nothing restarted.
    const departmentId = await page
      .locator('.dept', { hasText: `Irrigation e2e ${RUN}` })
      .getAttribute('data-department');

    const routed = await page.evaluate(
      async ([pattern]) => {
        const res = await fetch('/incidents', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            category: 'flooding',
            description: `the ${String(pattern)} has breached near Kakki`,
          }),
        });
        return (await res.json()) as { routedTo: string[]; unassigned: boolean };
      },
      [`nehr${RUN}`],
    );

    expect(routed.unassigned).toBe(false);
    expect(routed.routedTo).toEqual([departmentId]);
  });

  it('5. shows an unassigned emergency loudly on the board, in words', async () => {
    await page.evaluate(async () => {
      await fetch('/incidents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ category: 'a category nobody has configured a signal for' }),
      });
    });

    await page.click('#navBoard');
    await page.waitForSelector('#boardUnassigned:not([hidden])');

    const banner = (await page.textContent('#boardUnassigned')) ?? '';
    // The word, not a colour. And it names the fix as well as the fact, because an
    // unassigned emergency is both a thing to assign and a signal nobody wrote.
    expect(banner).toContain('no department');
    expect(banner).toContain('routing signal');

    const tally = (await page.textContent('#boardSummary .tally[data-kind="unassigned"]')) ?? '';
    expect(tally).toContain('nobody has it');
  });

  it('6. sets an acknowledgement deadline, and the board measures against it', async () => {
    await page.click('#navAdmin');
    await page.click('#adminTabs button[data-tab="deadlines"]');
    await page.waitForSelector('#adminDeadlines');

    // The district default for `unknown` — the deadline that carries the urgency an
    // unassessed report used to express by pretending to be `high` (ADR-0009).
    const input = page.locator('#adminDeadlines .district input.ack[data-severity="unknown"]');
    await input.fill('37');
    await input.blur();

    // Read it back from the server rather than from the field we just typed into.
    const stored = await until(
      () =>
        page.evaluate(async () => {
          const res = await fetch('/admin/sla');
          const body = (await res.json()) as { district: { unknown: number } };
          return body.district.unknown;
        }),
      (v) => v === 37,
    );
    expect(stored).toBe(37);

    const applied = await page.evaluate(async () => {
      const res = await fetch('/incidents');
      const board = (await res.json()) as {
        incidents: { targetMinutes: number; assessed: boolean }[];
      };
      return board.incidents.find((r) => !r.assessed)?.targetMinutes;
    });
    expect(applied).toBe(37);
  });

  it('7. shows every department side by side, with a dash where there is no data', async () => {
    await page.click('#adminTabs button[data-tab="performance"]');
    await page.waitForSelector('#performanceTable');

    const rows = await page.locator('#performanceTable tbody tr').count();
    expect(rows).toBeGreaterThan(0);

    // A department that has acknowledged nothing shows "—", never "0". Zero minutes is the
    // best possible performance; no data is no performance at all (ADR-0005).
    const cells = await page.locator('#performanceTable tbody tr td').allTextContents();
    expect(cells.some((c) => c === '—')).toBe(true);
  });

  it('8. records who changed what, and why, where the operator can read it', async () => {
    await page.click('#adminTabs button[data-tab="history"]');
    await page.waitForSelector('#adminHistory');

    const entries = await page.locator('.change').count();
    expect(entries).toBeGreaterThan(0);

    // The seat, because authority attaches to the post and survives the transfer (ADR-0004).
    const who = await page.locator('.change .who').first().textContent();
    expect(who).toContain('Deputy Commissioner');
  });

  it('9. refuses a bad deadline and says so, rather than appearing to save it', async () => {
    await page.click('#adminTabs button[data-tab="deadlines"]');
    await page.waitForSelector('#adminDeadlines');

    // Zero would make every incident overdue the instant it arrived.
    await page.evaluate(async () => {
      await fetch('/admin/sla', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ severity: 'critical', ackMinutes: 0 }),
      });
    });

    const still = await page.evaluate(async () => {
      const res = await fetch('/admin/sla');
      const body = (await res.json()) as { district: { critical: number } };
      return body.district.critical;
    });
    expect(still).toBeGreaterThan(0);
  });

  it('10. hides the console again the moment the operator signs out', async () => {
    await page.click('#logout');
    // `attached`, not the default `visible`: the assertion is that these go away, and an
    // element that is hidden never becomes visible, so the default state would wait forever
    // for the thing the test wants gone.
    await page.waitForSelector('#nav[hidden]', { state: 'attached' });
    expect(await page.locator('#adminView').isVisible()).toBe(false);
    expect(await page.locator('#navAdmin').isVisible()).toBe(false);
  });
});
