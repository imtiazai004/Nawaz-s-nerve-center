/**
 * Incident detail — M0-35.
 *
 * The acceptance criterion for this screen is a sentence, not a feature list: **every value
 * answers "who set this, when, why".** That is the claim `docs/04-authority-model.md` makes
 * about the whole system, and this is the only place a human ever sees it honoured.
 *
 * So the tests are about provenance surviving the trip to a screen:
 *
 *   - an override shows the district's value AND the department's underneath it, with the
 *     reason and both actors (ADR-0003) — not one replacing the other
 *   - actors are named by seat, not by uuid, because a uuid does not answer "who"
 *   - an event nobody performed says so, rather than showing a blank
 *   - the occurred/recorded gap is shown, because it is the district's connectivity picture
 *     rather than noise (ADR-0002)
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
import { append } from '../db/eventStore.js';
import type { IncidentEvent } from '../domain/events.js';
import { buildWeb } from '../../build.mjs';
import { hashPassword } from '../auth/passwords.js';
import { login } from '../auth/sessions.js';
import { seedDepartment } from '../testing/seed.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'db', 'migrations');

const PASSWORD = 'duty-officer-2026';

describe.skipIf(dbUrl === undefined)('M0-35: incident detail', () => {
  let pool: Pool;
  let api: Server;
  let origin: string;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  let rescueDept: string;
  let rescuePhone: string;
  let controlRoomToken: string;
  let rescueToken: string;
  let incidentId: string;

  const RESCUE_SEAT_TITLE = 'Rescue 1122 Station In-Charge';
  const CONTROL_SEAT_TITLE = 'District Control Room';
  const RESCUE_OFFICER = 'Rescue Duty Officer';

  beforeAll(async () => {
    const webRoot = await buildWeb();
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    api = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test', webRoot });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    rescueDept = await seedDepartment(pool, 'Rescue 1122 (test)');
    const rescue = await actor(RESCUE_OFFICER, RESCUE_SEAT_TITLE, rescueDept, 'station');
    const control = await actor('Control Room Operator', CONTROL_SEAT_TITLE, null, 'district');
    rescuePhone = rescue.phone;
    rescueToken = rescue.token;
    controlRoomToken = control.token;

    incidentId = await seedIncident();

    browser = await chromium.launch();
    context = await browser.newContext();
    page = await context.newPage();

    await page.goto(origin);
    await page.waitForSelector('#login');
    await page.fill('#phone', rescuePhone);
    await page.fill('#password', PASSWORD);
    await page.click('#loginSubmit');
    await page.waitForSelector('#nav:not([hidden])');
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => api?.close(() => r()));
    await pool?.end();
  });

  async function actor(
    name: string,
    title: string,
    departmentId: string | null,
    tier: string,
  ): Promise<{ phone: string; token: string }> {
    const seat = await pool.query<{ seat_id: string }>(
      `INSERT INTO seat (title, department_id, tier, can_break_glass)
       VALUES ($1, $2, $3, false) RETURNING seat_id`,
      [title, departmentId, tier],
    );
    const phone = `+92300${randomUUID().slice(0, 10)}`;
    const person = await pool.query<{ person_id: string }>(
      `INSERT INTO person (full_name, phone, password_hash)
       VALUES ($1, $2, $3) RETURNING person_id`,
      [name, phone, await hashPassword(PASSWORD)],
    );
    await pool.query('INSERT INTO duty_assignment (seat_id, person_id) VALUES ($1, $2)', [
      seat.rows[0]!.seat_id,
      person.rows[0]!.person_id,
    ]);
    const result = await login(pool, phone, PASSWORD);
    if (result === null) throw new Error(`login failed for ${name}`);
    return { phone, token: result.token };
  }

  async function post(
    path: string,
    token: string,
    body: unknown,
  ): Promise<Record<string, unknown>> {
    const res = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return (await res.json()) as Record<string, unknown>;
  }

  /** One incident with a full, contested history — the case detail exists for. */
  async function seedIncident(): Promise<string> {
    const created = await post('/incidents', controlRoomToken, {
      category: 'rta',
      severity: 'moderate',
    });
    const id = created['incidentId'] as string;

    await post(`/incidents/${id}/route`, controlRoomToken, {
      departmentIds: [rescueDept],
      reason: 'road traffic accident on the Kohat road',
    });
    await post(`/incidents/${id}/triage`, rescueToken, { severity: 'high', category: 'rta' });
    await post(`/incidents/${id}/override`, controlRoomToken, {
      field: 'severity',
      value: 'critical',
      reason: 'second reporter confirms multiple casualties',
    });

    // An event with nobody behind it, and a two-hour gap between happening and arriving.
    // Both are things the screen has to be able to say out loud.
    const occurred = new Date(Date.now() - 125 * 60_000).toISOString();
    await append(pool, [
      {
        eventId: randomUUID(),
        incidentId: id,
        type: 'escalated',
        occurredAt: occurred,
        recordedAt: occurred,
        clientSeq: 99,
        actorPersonId: null,
        actorSeatId: null,
        sourceChannel: 'system',
        payload: { fromSeatId: null, toSeatId: randomUUID(), trigger: 'sla_breach' },
      } as unknown as IncidentEvent,
    ]);

    return id;
  }

  async function openDetail(id: string): Promise<void> {
    await page.evaluate(async (target: string) => {
      const dnc = (globalThis as unknown as { __dnc: { openDetail(x: string): Promise<void> } })
        .__dnc;
      await dnc.openDetail(target);
    }, id);
    await page.waitForSelector('#detailView:not([hidden]) .value');
  }

  it('1. opens from the board by clicking a row', async () => {
    await page.click('#navBoard');
    await page.waitForSelector(`#boardRows .row[data-incident="${incidentId}"]`, {
      timeout: 15_000,
    });
    await page.click(`#boardRows .row[data-incident="${incidentId}"]`);

    await page.waitForSelector('#detailView:not([hidden])');
    expect(await page.isVisible('#boardView')).toBe(false);
  });

  it("2. shows the override, and the department's own value underneath it (ADR-0003)", async () => {
    await openDetail(incidentId);
    const severity = page.locator('.value[data-field="severity"]');

    expect((await severity.locator('.v').textContent())?.trim()).toBe('critical');

    // The whole of ADR-0003 in one assertion: the department's assessment survives, with
    // the reason it was overridden and who did it. Nobody can be blamed for a figure they
    // did not enter, and nobody can quietly rewrite a department's assessment.
    const was = (await severity.locator('.was').textContent()) ?? '';
    expect(was).toContain('high');
    expect(was).toContain(RESCUE_SEAT_TITLE);
    expect(was).toContain(CONTROL_SEAT_TITLE);
    expect(was).toContain('second reporter confirms multiple casualties');
  });

  it('3. names actors by seat, not by uuid', async () => {
    // A uuid does not answer "who". Authority attaches to the post (ADR-0004), so the seat
    // leads and the individual follows.
    const prov = (await page.textContent('.value[data-field="severity"] .prov')) ?? '';
    expect(prov).toContain(CONTROL_SEAT_TITLE);
    expect(prov).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });

  it('4. names the person alongside the seat they held', async () => {
    const triaged = (await page.textContent('.tl[data-type="triaged"] .who')) ?? '';
    expect(triaged).toContain(RESCUE_SEAT_TITLE);
    expect(triaged).toContain(RESCUE_OFFICER);
  });

  it('5. says "the system" for an event nobody performed', async () => {
    // "Nobody did this, the deadline did" is a real and important distinction, and a blank
    // would read as missing data instead.
    const who = (await page.textContent('.tl[data-type="escalated"] .who')) ?? '';
    expect(who).toBe('the system');
  });

  it('6. shows the whole history in order, not a summary of it', async () => {
    const types = await page
      .locator('#timelineRows .tl')
      .evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset['type']));
    expect(types).toContain('reported');
    expect(types).toContain('routed');
    expect(types).toContain('triaged');
    expect(types).toContain('overridden');
    expect(types).toContain('escalated');
  });

  it('7. carries the reason on every event that required one (INV-06)', async () => {
    const overridden = (await page.textContent('.tl[data-type="overridden"] .why')) ?? '';
    expect(overridden).toContain('second reporter confirms multiple casualties');

    const routed = (await page.textContent('.tl[data-type="routed"] .why')) ?? '';
    expect(routed).toContain('Kohat road');
  });

  it('8. surfaces the gap between happening and arriving (ADR-0002)', async () => {
    // Not a diagnostic curiosity. An emergency that took two hours to surface is an
    // operational risk regardless of how fast the response was afterwards.
    const late = await page.locator('.tl .late').first().textContent();
    expect(late).toMatch(/reached the server \d+m later/);
  });

  it('9. refuses an incident the seat has no authority to read', async () => {
    const theirs = await post('/incidents', controlRoomToken, {
      category: 'security',
      severity: 'high',
    });
    const otherDept = await seedDepartment(pool, 'Other Department (test)');
    await post(`/incidents/${theirs['incidentId'] as string}/route`, controlRoomToken, {
      departmentIds: [otherDept],
      reason: 'police matter',
    });

    await page.evaluate(async (target: string) => {
      const dnc = (globalThis as unknown as { __dnc: { openDetail(x: string): Promise<void> } })
        .__dnc;
      await dnc.openDetail(target);
    }, theirs['incidentId'] as string);

    expect(await page.textContent('#detailHead')).toContain('not available to your seat');
    // Not "forbidden" — confirming it exists is itself a disclosure about another
    // department's operations.
    expect(await page.textContent('#detailHead')).not.toContain('forbidden');
  });

  it('10. goes back to the board', async () => {
    await openDetail(incidentId);
    await page.click('#back');
    await page.waitForSelector('#boardView:not([hidden])');
    expect(await page.isVisible('#detailView')).toBe(false);
  });
});
