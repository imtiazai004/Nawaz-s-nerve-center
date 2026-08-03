/**
 * The department workspace — M1-01, on a real screen.
 *
 * This walks a shift: an emergency arrives, the duty officer sees it under *needs you now*,
 * acknowledges it, sends an ambulance, logs what happened, and resolves it — **without
 * leaving the screen**. That is the claim the milestone makes, and it can only be tested by
 * doing it.
 *
 * Two behaviours are load-bearing and easy to lose:
 *
 *   - **Empty says so in words.** A blank list is indistinguishable from a screen that failed
 *     to load, and that is how somebody concludes there is no emergency when there is.
 *   - **Why a unit cannot go is on the row.** "Unavailable" makes an operator leave to find
 *     out; the reason lets them pick something else.
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
import { loadIncident } from '../db/eventStore.js';
import { foldIncident } from '../domain/incident.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'db', 'migrations');

const RUN = randomUUID().slice(0, 8);

/**
 * Wait for the *record* to say something, by reading the record.
 *
 * These two waits used to be `page.waitForFunction(async …)`, and that does not do what it
 * reads as: Playwright evaluates the callback and tests its result for truthiness, and the
 * result of an async function is a **Promise**, which is always truthy. So the wait returned
 * on the first poll, every time, and the assertions after it were racing the work.
 *
 * It passed for weeks because the race was usually won. It stopped passing the day the server
 * had slightly more to do. This is the third place in this suite that pattern has appeared, so
 * this one does not go through the browser at all — it folds the log, which is the thing the
 * assertions are actually about.
 */
async function untilIncident(
  pool: Pool,
  incidentId: string,
  done: (state: ReturnType<typeof foldIncident>) => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const state = foldIncident(incidentId, await loadIncident(pool, incidentId));
    if (done(state)) return;

    if (Date.now() > deadline) {
      throw new Error(`incident ${incidentId} never reached the expected state`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

describe.skipIf(dbUrl === undefined)('M1-01: the department workspace', () => {
  let pool: Pool;
  let api: Server;
  let origin: string;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  let rescue: TestActor;
  let rescueDept: string;
  let dcToken: string;

  async function apiCall(
    method: string,
    path: string,
    token: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const res = await globalThis.fetch(`${origin}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const raw = await res.text();
    return raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
  }

  /** An emergency routed to Rescue, as the district administration would route one. */
  async function emergency(category: string): Promise<string> {
    const created = await apiCall('POST', '/incidents', dcToken, {
      category,
      severity: 'critical',
    });
    const id = created['incidentId'] as string;
    await apiCall('POST', `/incidents/${id}/route`, dcToken, {
      departmentIds: [rescueDept],
      reason: 'workspace test',
    });
    return id;
  }

  beforeAll(async () => {
    const webRoot = await buildWeb();
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    api = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test', webRoot });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    const dcDept = await seedDepartment(pool, `DC Office (shift ${RUN})`);
    await pool.query('UPDATE department SET is_administration = true WHERE department_id = $1', [
      dcDept,
    ]);
    dcToken = (
      await seedActor(pool, { title: `DC (shift ${RUN})`, departmentId: dcDept, tier: 'district' })
    ).token;

    rescueDept = await seedDepartment(pool, `Rescue (shift ${RUN})`);
    rescue = await seedActor(pool, {
      title: `Rescue Duty Officer (shift ${RUN})`,
      departmentId: rescueDept,
    });

    browser = await chromium.launch();
    context = await browser.newContext();
    page = await context.newPage();

    await page.goto(origin);
    await page.waitForSelector('#login');
    await page.fill('#phone', rescue.phone);
    await page.fill('#password', TEST_PASSWORD);
    await page.click('#loginSubmit');
    await page.waitForSelector('#nav:not([hidden])');
  }, 240_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => api?.close(() => r()));
    await pool?.end();
  });

  it('1. is offered to a duty officer, and names the shift they are on', async () => {
    await page.waitForSelector('#navShift:not([hidden])');
    await page.click('#navShift');
    await page.waitForSelector('#shift');

    expect(await page.textContent('#shiftWho')).toContain(`Rescue (shift ${RUN})`);
  });

  /**
   * The empty state, in words.
   *
   * A blank area and a screen that failed to load look identical, and an operator who reads
   * a failure as "nothing is happening" is the failure mode ADR-0005 exists to prevent.
   */
  it('2. says "nothing is waiting" rather than showing an empty space', async () => {
    const quiet = (await page.textContent('#needsYou .quiet')) ?? '';
    expect(quiet).toContain('Nothing is waiting');
  });

  it('3. says the department has nothing to send, rather than showing an empty list', async () => {
    const quiet = (await page.textContent('#canSend .quiet')) ?? '';
    // Not a tidy empty state. It is the reason a dispatch will not happen tonight.
    expect(quiet).toContain('No vehicles');
  });

  it('4. an emergency arrives and appears under "needs you now"', async () => {
    const id = await emergency(`shift-${RUN}`);

    await page.reload();
    await page.waitForSelector('#navShift:not([hidden])');
    await page.click('#navShift');
    await page.locator(`#needsYou .work[data-incident="${id}"]`).waitFor();

    const card = page.locator(`.work[data-incident="${id}"]`);
    expect(await card.locator('.sev').textContent()).toBe('critical');
    /**
     * The category is shown in words, and a category nobody has a word for is shown as the
     * district typed it, capitalised — never invented into a nearby one.
     *
     * This test uses a made-up category so it cannot collide with a real run's data, so it is
     * exercising exactly that fallback. The six the report form offers ("rta" → "Road
     * accident") are covered in the board suite.
     */
    const shown = `Shift-${RUN}`;
    expect(await card.locator('.cat').textContent()).toBe(shown);
  });

  it('5. the officer acknowledges it without leaving the screen', async () => {
    const card = page.locator('#needsYou .work').first();
    const id = await card.getAttribute('data-incident');

    await card.getByRole('button', { name: 'Acknowledge' }).click();

    // It moves out of "needs you now" and into "in hand" — same screen, no navigation.
    await page.locator(`#liveWork .work[data-incident="${id!}"]`).waitFor();

    const state = foldIncident(id!, await loadIncident(pool, id!));
    expect(state.acknowledgedAt).not.toBeNull();
  });

  it('6. the fleet appears once the department has something, with each unit ready', async () => {
    await apiCall('POST', `/fleet/${rescueDept}/units`, rescue.token, {
      kind: 'vehicle',
      name: `Ambulance ${RUN}`,
      identifier: 'BNU-0001',
    });

    await page.click('#navBoard');
    await page.click('#navShift');
    await page.locator('#canSend .unit').first().waitFor();

    const unit = page.locator('.unit', { hasText: `Ambulance ${RUN}` });
    expect(await unit.locator('.ready').textContent()).toBe('ready');
    expect(await page.textContent('#canSend .tally[data-kind="available"]')).toContain('ready');
  });

  it('7. sends the ambulance from the incident card itself', async () => {
    const id = await emergency(`dispatch-${RUN}`);

    await page.click('#navBoard');
    await page.click('#navShift');
    const card = page.locator(`#needsYou .work[data-incident="${id}"]`);
    await card.waitFor();

    await card.locator('select.send').selectOption({ label: `Ambulance ${RUN}` });

    await page.waitForFunction(
      (incidentId) =>
        document
          .querySelector(`.work[data-incident="${incidentId}"] .meta`)
          ?.textContent?.includes('Ambulance') === true ||
        document.querySelector('.unit[data-state="out"]') !== null,
      id,
    );

    const state = foldIncident(id, await loadIncident(pool, id));
    expect(state.assignedResourceIds).toHaveLength(1);
  });

  it('8. the unit now reads as out, and says where', async () => {
    const unit = page.locator('.unit', { hasText: `Ambulance ${RUN}` });
    expect(await unit.getAttribute('data-state')).toBe('out');
    // Where it is, not just that it is busy. An operator deciding what to send next needs
    // the second fact and not the first.
    expect(await unit.locator('.why').textContent()).toContain(`dispatch-${RUN}`);
  });

  it('9. a unit off the run says why, on the row', async () => {
    const created = await apiCall('POST', `/fleet/${rescueDept}/units`, rescue.token, {
      kind: 'vehicle',
      name: `Spare ${RUN}`,
    });
    await apiCall('POST', `/fleet/units/${created['resourceId'] as string}/off-run`, rescue.token, {
      reason: 'gearbox at the workshop',
    });

    await page.click('#navBoard');
    await page.click('#navShift');
    const unit = page.locator('.unit', { hasText: `Spare ${RUN}` });
    await unit.waitFor();

    expect(await unit.getAttribute('data-state')).toBe('off');
    // The reason the district entered — "gearbox" and "no driver" lead somewhere different.
    expect(await unit.locator('.why').textContent()).toContain('gearbox');
  });

  it('10. logs what happened, and resolves, from the same screen', async () => {
    const card = page.locator('#liveWork .work').first();
    const id = await card.getAttribute('data-incident');

    page.once('dialog', (d) => void d.accept('casualty removed to DHQ'));
    await card.getByRole('button', { name: 'Log what happened' }).click();
    await untilIncident(pool, id!, (state) => state.actions.length > 0);

    page.once('dialog', (d) => void d.accept('all casualties removed, scene handed over'));
    await page
      .locator(`#liveWork .work[data-incident="${id!}"]`)
      .getByRole('button', { name: 'Resolve' })
      .click();

    await untilIncident(pool, id!, (state) => state.status === 'resolved');

    const state = foldIncident(id!, await loadIncident(pool, id!));
    expect(state.actions[0]?.note).toBe('casualty removed to DHQ');
    expect(state.resolution).toContain('all casualties removed');
  });

  it('11. opening a card goes to the same detail view the board uses', async () => {
    const id = await emergency(`detail-from-shift-${RUN}`);

    await page.click('#navBoard');
    await page.click('#navShift');
    await page.locator(`#needsYou .work[data-incident="${id}"]`).click();

    // One definition of what an incident looks like, two ways in — rather than a second
    // detail screen that drifts from the first.
    //
    // The view is revealed *before* its fetch resolves, on purpose — a screen that stays
    // blank until data arrives looks broken on a slow line. So waiting for the panel is not
    // waiting for the content, and asserting straight after it is a race this test lost only
    // once the server had a little more to do. Wait for the heading to stop saying "Loading".
    await page.waitForSelector('#detailView:not([hidden])');
    await page.waitForFunction(
      (want) => document.getElementById('detailHead')?.textContent?.includes(want) === true,
      `detail-from-shift-${RUN}`,
    );
  });

  it('12. stops polling the moment the operator leaves it', async () => {
    // A background refresh against a screen nobody is looking at is a request the district's
    // one server did not need to serve — and this is a screen that refreshes every ten
    // seconds while it is open.
    await page.click('#navBoard');

    let hits = 0;
    await page.route('**/fleet', (route) => {
      hits += 1;
      void route.continue();
    });
    await new Promise((r) => setTimeout(r, 12_000));
    await page.unroute('**/fleet');

    expect(hits).toBe(0);
  }, 30_000);

  it('13. hides the shift screen when the operator signs out', async () => {
    await page.click('#logout');
    await page.waitForSelector('#nav[hidden]', { state: 'attached' });
    expect(await page.locator('#shiftView').isVisible()).toBe(false);
    expect(await page.locator('#navShift').isVisible()).toBe(false);
  });
});
