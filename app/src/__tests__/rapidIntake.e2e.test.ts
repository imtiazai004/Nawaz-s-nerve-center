/**
 * M0-36: the fifteen-second budget, measured rather than asserted.
 *
 * From `docs/00-thesis.md`: the system must be faster than the phone call it replaces. If
 * a Rescue operator can make a call in eight seconds and this takes forty, the system
 * loses, operators go back to the phone, and the central board goes quietly false. That
 * makes intake speed a correctness property, not a polish item.
 *
 * The CPU is throttled 4× to approximate a mid-range Android handset, because measuring
 * this on a developer machine would prove nothing about the device it will actually run
 * on. The clock starts when the screen is usable and stops when the report is **durably
 * stored** — not when the network confirms it, because the operator's job is done at the
 * point the emergency cannot be lost.
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
import { loadIncident } from '../db/eventStore.js';
import { foldIncident } from '../domain/incident.js';
import { buildWeb } from '../../build.mjs';
import { seedActor, TEST_PASSWORD, type TestActor } from '../testing/seed.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'db', 'migrations');

/** The budget. A requirement from the thesis, not an aspiration. */
const BUDGET_MS = 15_000;

/** Rough stand-in for a mid-range Android handset against a developer machine. */
const CPU_SLOWDOWN = 4;

describe.skipIf(dbUrl === undefined)('M0-36: rapid intake', () => {
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

    actor = await seedActor(pool, { title: 'Rapid Intake Duty Officer' });

    browser = await chromium.launch();
    context = await browser.newContext({
      // A real handset in a hand, not a desktop window.
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      geolocation: { latitude: 32.9889, longitude: 70.6056 }, // Bannu
      permissions: ['geolocation'],
    });
    page = await context.newPage();

    await page.goto(origin);
    await page.waitForSelector('#login');
    await page.fill('#phone', actor.phone);
    await page.fill('#password', TEST_PASSWORD);
    await page.click('#loginSubmit');
    await page.waitForSelector('#who', { state: 'visible', timeout: 15_000 });
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => api?.close(() => r()));
    await pool?.end();
  });

  async function throttle(rate: number): Promise<void> {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  }

  /**
   * Wait until the app is actually usable, not merely painted.
   *
   * `#submit` is in the static HTML, so it appears the moment the document parses — before
   * `boot()` has opened IndexedDB and published `__dnc`. Waiting on it alone proved nothing,
   * and under the 4× CPU throttle in test 5 the gap was wide enough that CI hit
   * `Cannot read properties of undefined (reading 'store')`.
   *
   * It also makes the budget measurement honest. The clock is supposed to start "when the
   * operator could first act", and an operator cannot act on a button whose handler is not
   * attached — starting it at first paint quietly measured less than the real thing.
   */
  async function waitForReady(target: Page = page): Promise<void> {
    await target.waitForSelector('#submit', { timeout: 30_000 });
    await target.waitForFunction(
      () => (globalThis as unknown as { __dnc?: unknown }).__dnc !== undefined,
      undefined,
      { timeout: 30_000 },
    );
  }

  async function queueLength(): Promise<number> {
    return page.evaluate(
      async () =>
        (
          await (
            globalThis as unknown as { __dnc: { store: { all(): Promise<unknown[]> } } }
          ).__dnc.store.all()
        ).length,
    );
  }

  describe('the critical path', () => {
    it('1. needs no typing at all', async () => {
      await page.reload();
      await waitForReady();

      // Two taps and the button. Nothing on the critical path accepts text.
      const textInputs = await page.locator('#report input[type="text"], #report textarea').count();
      expect(textInputs).toBe(0);
    });

    it('2. will not submit until what happened is chosen', async () => {
      // Severity is pre-set, so the only required choice is the category. Submitting a
      // report with no category would produce a record nobody can route.
      expect(await page.isDisabled('#submit')).toBe(true);

      // Clicking the label, which is what a hand does. The radio itself is visually
      // hidden — it exists so the group stays keyboard- and screen-reader-navigable.
      await page.click('label[for="cat-rta"]');
      expect(await page.isDisabled('#submit')).toBe(false);
    });

    it('3. offers targets big enough for a hand in a hurry', async () => {
      for (const id of ['#cat-rta', '#sev-critical']) {
        const box = await page.locator(`label[for="${id.slice(1)}"]`).boundingBox();
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }
      const submitBox = await page.locator('#submit').boundingBox();
      expect(submitBox!.height).toBeGreaterThanOrEqual(60);
    });

    it('4. severity does not rely on colour alone (INV-04)', async () => {
      const label = await page.textContent('label[for="sev-critical"]');
      expect(label?.trim()).toBe('Critical');
    });
  });

  describe('the budget', () => {
    it(`5. open to durably stored in under ${BUDGET_MS / 1000}s on a throttled handset`, async () => {
      await throttle(CPU_SLOWDOWN);
      try {
        const before = await queueLength();

        // The clock starts at **open**, and open means the operator tapped the icon — not
        // the moment the app finished booting.
        //
        // Worth stating, because fixing the readiness race briefly moved this line below
        // `waitForReady()` and the measured time fell from ~800ms to ~260ms. Nothing got
        // faster; the measurement stopped counting the load. The thesis asks for "under 15
        // seconds from open to submitted", and an operator standing at a road accident is
        // waiting through startup exactly as much as through the taps.
        const started = Date.now();
        await page.reload();
        await waitForReady();

        await page.click('label[for="cat-rta"]');
        await page.click('label[for="sev-critical"]');
        await page.click('#submit');

        // Stops when it is durably stored — the moment the emergency cannot be lost.
        await page.waitForFunction(
          (n) =>
            (
              globalThis as unknown as { __dnc: { store: { all(): Promise<unknown[]> } } }
            ).__dnc.store
              .all()
              .then((all) => all.length > n),
          before,
          { timeout: 30_000 },
        );

        const elapsed = Date.now() - started;
        // eslint-disable-next-line no-console
        console.log(`rapid intake: ${elapsed}ms (budget ${BUDGET_MS}ms, cpu ${CPU_SLOWDOWN}x)`);
        expect(elapsed).toBeLessThan(BUDGET_MS);
      } finally {
        await throttle(1);
      }
    });

    it('6. does not wait on the network to consider the report saved', async () => {
      await context.setOffline(true);
      try {
        await page.reload();
        await waitForReady();
        const before = await queueLength();
        const started = Date.now();

        await page.click('label[for="cat-fire"]');
        await page.click('#submit');
        await page.waitForSelector('#sent', { state: 'visible', timeout: 20_000 });

        const elapsed = Date.now() - started;
        expect(elapsed).toBeLessThan(BUDGET_MS);
        expect(await queueLength()).toBe(before + 1);
      } finally {
        await context.setOffline(false);
      }
    });

    it('7. does not wait on a location fix either', async () => {
      // An operator indoors on an old handset may never get a fix. Blocking on one would
      // spend the whole budget on coordinates that matter far less than the report.
      const denied = await browser.newContext({
        viewport: { width: 390, height: 844 },
        permissions: [],
      });
      const p = await denied.newPage();
      try {
        await p.goto(origin);
        await waitForReady(p);
        const started = Date.now();

        await p.click('label[for="cat-medical"]');
        await p.click('#submit');
        await p.waitForSelector('#sent', { state: 'visible', timeout: 20_000 });

        expect(Date.now() - started).toBeLessThan(BUDGET_MS);
      } finally {
        await denied.close();
      }
    });
  });

  describe('submit first, enrich after', () => {
    let incidentId: string;

    it('8. a report with no location or description is accepted (INV-01)', async () => {
      await page.reload();
      await waitForReady();

      await page.click('label[for="cat-flood"]');
      await page.click('label[for="sev-critical"]');
      await page.click('#submit');
      await page.waitForSelector('#sent', { state: 'visible', timeout: 20_000 });

      const deadline = Date.now() + 20_000;
      let found: string | null = null;
      while (Date.now() < deadline && found === null) {
        const res = await pool.query<{ incident_id: string }>(
          `SELECT incident_id FROM incident_event
            WHERE payload->>'category' = 'flood' AND actor_person_id = $1
            ORDER BY recorded_at DESC LIMIT 1`,
          [actor.personId],
        );
        found = res.rows[0]?.incident_id ?? null;
        if (found === null) await new Promise((r) => setTimeout(r, 150));
      }

      expect(found).not.toBeNull();
      incidentId = found!;
    });

    it('9. detail added afterwards appends to the same incident', async () => {
      const note = `Near the bridge ${randomUUID()}`;
      await page.fill('#place', note);
      await page.click('#addDetail');

      const deadline = Date.now() + 20_000;
      let types: string[] = [];
      while (Date.now() < deadline && !types.includes('action_logged')) {
        types = (await loadIncident(pool, incidentId)).map((e) => e.type);
        if (!types.includes('action_logged')) await new Promise((r) => setTimeout(r, 150));
      }

      // Appended, never edited — what was first said and what was added are both history.
      // The `routed` between them is the automatic pass that runs when a synced report
      // arrives; before the M1 gate forced that fix, an emergency captured on a handset was
      // never routed at all.
      expect(types).toEqual(['reported', 'routed', 'action_logged']);

      const state = foldIncident(incidentId, await loadIncident(pool, incidentId));
      expect(state.severity?.value).toBe('critical');
      expect(state.actions).toHaveLength(1);
    });

    it('10. records which location layers actually produced something', async () => {
      // So a downstream consumer can tell a GPS fix from an operator's best guess, rather
      // than treating every location as equally certain.
      const events = await loadIncident(pool, incidentId);
      const enrichment = events.find((e) => e.type === 'action_logged');
      const location = (enrichment!.payload as { location?: { layers?: string[] } }).location;

      expect(location?.layers).toContain('text');
    });
  });
});
