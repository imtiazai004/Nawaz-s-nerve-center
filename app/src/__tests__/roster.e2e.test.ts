/**
 * The roster on a real screen — M1a-10.
 *
 * `api/__tests__/roster.test.ts` proves the endpoints and the scoping. This proves the two
 * things that only exist once something renders them:
 *
 *   1. **A department officer can maintain their own roster**, from their own tab, without
 *      knowing their department's uuid and without touching anybody else's.
 *   2. **A post nothing can reach says so, in words** — empty, or holding a stand-in number.
 *      Both mean an alert sent there is recorded as failed, and both are the reason this
 *      screen exists (ADR-0005, INV-04).
 *
 * The end-to-end claim underneath it: Rescue 1122's missing number stops being a thing
 * somebody has to ask a developer for.
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

describe.skipIf(dbUrl === undefined)('M1a-10: the roster', () => {
  let pool: Pool;
  let api: Server;
  let origin: string;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  let dc: TestActor;
  let rescue: TestActor;
  let rescueDept: string;

  /**
   * Answer the next dialogs, in order.
   *
   * Not two `page.once('dialog')` calls. Both are listeners for the same event, so both fire
   * on the **first** dialog — the second `accept()` then throws against an already-handled
   * one, and the flow stalls waiting for a prompt nobody answered. One listener, one queue.
   */
  function answer(replies: readonly (string | true)[]): void {
    const pending = [...replies];
    const handler = (dialog: {
      accept(v?: string): Promise<void>;
      dismiss(): Promise<void>;
    }): void => {
      const next = pending.shift();
      if (next === undefined) void dialog.dismiss();
      else void dialog.accept(next === true ? undefined : next);
      if (pending.length === 0) page.off('dialog', handler);
    };
    page.on('dialog', handler);
  }

  async function signIn(actor: TestActor): Promise<void> {
    await context.clearCookies();
    await page.goto(origin);
    await page.waitForSelector('#login');
    await page.fill('#phone', actor.phone);
    await page.fill('#password', TEST_PASSWORD);
    await page.click('#loginSubmit');
    await page.waitForSelector('#nav:not([hidden])');
  }

  beforeAll(async () => {
    const webRoot = await buildWeb();
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    api = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test', webRoot });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    const dcDept = await seedDepartment(pool, `DC Office (roster e2e ${RUN})`);
    await pool.query('UPDATE department SET is_administration = true WHERE department_id = $1', [
      dcDept,
    ]);
    dc = await seedActor(pool, {
      title: `Deputy Commissioner (roster e2e ${RUN})`,
      departmentId: dcDept,
      tier: 'district',
    });

    rescueDept = await seedDepartment(pool, `Rescue (roster e2e ${RUN})`);
    rescue = await seedActor(pool, {
      title: `Rescue Duty (roster e2e ${RUN})`,
      departmentId: rescueDept,
    });

    browser = await chromium.launch();
    context = await browser.newContext();
    page = await context.newPage();
  }, 240_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => api?.close(() => r()));
    await pool?.end();
  });

  it('1. offers a department officer their own roster, and not the console', async () => {
    await signIn(rescue);
    await page.waitForSelector('#navMine:not([hidden])');

    expect(await page.locator('#navMine').isVisible()).toBe(true);
    // Routing signals and deadlines are the district's decisions about a department, not
    // the department's about itself (ADR-0010).
    expect(await page.locator('#navAdmin').isVisible()).toBe(false);
  });

  it('2. shows their own department without them naming it', async () => {
    await page.click('#navMine');
    await page.waitForSelector('#rosterBody');

    // Resolved from their seat, server-side. An officer should not have to know a uuid, and
    // must not be able to change the answer by sending a different one.
    expect(await page.locator('#rosterBody').getAttribute('data-department')).toBe(rescueDept);
    expect(await page.textContent('.rostername')).toContain(`Rescue (roster e2e ${RUN})`);
  });

  it('3. lists the post this officer already holds', async () => {
    // `seedActor` creates a seat and puts the officer in it, so the department is never
    // postless here — an earlier version of this test asserted the empty-department message
    // and waited thirty seconds for a state the fixture cannot produce. The "no posts at
    // all" wording is covered from the console in test 9, against a department created with
    // none.
    const posts = await page.locator('.post').count();
    expect(posts).toBeGreaterThan(0);
    expect(await page.locator('.post .pname').first().textContent()).toBeTruthy();
  });

  it('4. a department adds its own post, and the post says nobody holds it', async () => {
    await page.fill('.addpost .tt', `Station Officer ${RUN}`);
    await page.click('.addpost button');

    const card = page.locator('.post', { hasText: `Station Officer ${RUN}` });
    await card.waitFor();

    // The gap the roster exists to close, named on the card rather than left to be worked
    // out from a blank space.
    expect(await card.locator('.nobody').textContent()).toContain('reaches no one');
  });

  it('5. a department adds its own person and puts them in the post', async () => {
    await page.fill('.addperson .pn', 'Station Officer On Duty');
    await page.fill('.addperson .pp', `0300${RUN}21`);
    await page.selectOption('.addperson .ps', { label: `Station Officer ${RUN}` });
    await page.click('.addperson button');

    const card = page.locator('.post', { hasText: `Station Officer ${RUN}` });
    await card.locator('.holder').waitFor();

    expect(await card.locator('.pname').textContent()).toBe('Station Officer On Duty');
    // Added as a contact, not as an account. Those are separate decisions.
    expect(await card.locator('.holder .tag').count()).toBe(0);
    expect(await page.locator('.unreachable').count()).toBe(0);
  });

  it('6. a stand-in number fills the post and still reads as unreachable (R-01)', async () => {
    await page.fill('.addpost .tt', `Awaiting A Number ${RUN}`);
    await page.click('.addpost button');
    await page.locator('.post', { hasText: `Awaiting A Number ${RUN}` }).waitFor();

    await page.fill('.addperson .pn', 'Number To Follow');
    await page.fill('.addperson .pp', '1111111');
    await page.selectOption('.addperson .ps', { label: `Awaiting A Number ${RUN}` });
    await page.check('.addperson .pc');
    await page.click('.addperson button');

    const card = page.locator('.post', { hasText: `Awaiting A Number ${RUN}` });
    await card.locator('.holder').waitFor();

    // Filled, and still saying nothing will be sent. This is the whole point of the
    // placeholder flag: a fake number that looked like a contact would silence the warning
    // while changing nothing about whether anybody is told.
    expect(await card.locator('.warn').textContent()).toContain('nothing will be sent');
    expect(await page.textContent('.unreachable')).toContain('cannot be reached');
  });

  it('7. typing the real number over it clears the warning', async () => {
    // Changed from the person's own card, which is where an operator would do it.
    const personCard = page.locator('.rosterperson', { hasText: 'Number To Follow' });
    answer([`0300${RUN}22`]);
    await personCard.getByRole('button', { name: 'Change number' }).click();

    await page.waitForFunction(() => document.querySelectorAll('.holder .warn').length === 0);
    expect(await page.locator('.unreachable').count()).toBe(0);
  });

  it('8. giving somebody a login is a separate, deliberate act', async () => {
    const personCard = page.locator('.rosterperson', { hasText: 'Station Officer On Duty' });

    // Confirm, then a password. Two dialogs, on purpose: an account for somebody who has
    // never been told the system exists is a password nobody chose, on an account nobody
    // watches. The confirmation is the pause where an operator remembers that.
    answer([true, 'a-real-password-2026']);
    await personCard.getByRole('button', { name: 'Give a login' }).click();

    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll('.rosterperson')).some(
        (c) =>
          c.textContent?.includes('Station Officer On Duty') === true &&
          c.textContent.includes('can sign in'),
      ),
    );
  });

  it('9. the administration reaches every department’s roster from the console', async () => {
    await signIn(dc);
    await page.click('#navAdmin');
    await page.click('#adminTabs button[data-tab="roster"]');
    await page.waitForSelector('#rosterPicker');

    await page.selectOption('#rosterPicker', rescueDept);
    await page.waitForFunction(
      (id) => document.querySelector('#rosterBody')?.getAttribute('data-department') === id,
      rescueDept,
    );

    // Same component, same markup — one definition of what a roster is, reached two ways.
    expect(await page.locator('.post', { hasText: `Station Officer ${RUN}` }).count()).toBe(1);
  });

  it('9b. a department created with no posts says nothing can ever be sent to it', async () => {
    // Created here rather than seeded, because a department with genuinely zero posts is
    // exactly what the console produces on the "Add department" button — and it is the state
    // in which a routing signal sends emergencies into a void.
    await page.click('#adminTabs button[data-tab="departments"]');
    await page.waitForSelector('#adminDepartments');
    await page.fill('#newDeptName', `Brand New Cell ${RUN}`);
    await page.click('#addDepartmentSubmit');
    await page.locator('.dept', { hasText: `Brand New Cell ${RUN}` }).waitFor();

    await page.click('#adminTabs button[data-tab="roster"]');
    await page.waitForSelector('#rosterPicker');
    await page.selectOption('#rosterPicker', { label: `Brand New Cell ${RUN}` });

    await page.waitForFunction(
      () => document.querySelector('.nobody')?.textContent?.includes('no posts') === true,
    );
  });

  it('10. and the department view disappears the moment the operator signs out', async () => {
    await page.click('#logout');
    await page.waitForSelector('#nav[hidden]', { state: 'attached' });
    expect(await page.locator('#mineView').isVisible()).toBe(false);
    expect(await page.locator('#navMine').isVisible()).toBe(false);
  });
});
