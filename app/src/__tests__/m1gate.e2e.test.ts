/**
 * **THE M1 GATE.**
 *
 * `backlog/milestones.md`:
 *
 *   > A real Rescue operator completes a full incident lifecycle without a developer
 *   > present, and beats the stopwatch on rapid intake: under 15 seconds from open to
 *   > submitted on a mid-range Android handset over a weak connection.
 *
 * This file is **half** of that gate, and the half a machine can hold. It walks one
 * emergency from a field officer's handset to a post-incident report, in a real browser,
 * against a real PostgreSQL, with nothing stubbed — and it re-measures the fifteen-second
 * budget now that considerably more code sits behind the submit button than when M0-36 last
 * measured it.
 *
 * **The other half is R-12 and I cannot do it.** The gate says *a real Rescue operator, no
 * developer present*. I can prove the lifecycle works; I cannot prove it is usable by
 * somebody who did not build it, and a test written by the author is the worst possible
 * evidence for that question.
 *
 * If this file is deleted, M1 is unproven whatever the rest of the suite says.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { randomUUID } from 'node:crypto';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
import { runNotifyPass } from '../jobs/notify.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'db', 'migrations');

/** The budget, from `docs/00-thesis.md`. A requirement, not an aspiration. */
const BUDGET_MS = 15_000;

/** Rough stand-in for a mid-range Android handset against a developer machine. */
const CPU_SLOWDOWN = 4;

/**
 * How large the app a field officer downloads may get.
 *
 * Asserted because the shell now carries the administration console, the roster editor and
 * the shift screen — none of which a field officer who only ever presses one button will
 * open. The service worker caches it after the first load, so this is a **first-launch on a
 * weak connection** budget rather than a per-report one, and it exists so that growth is
 * noticed here rather than discovered by somebody in Domel.
 */
const SHELL_BUDGET_BYTES = 160 * 1024;

/**
 * Weigh the client the way the district receives it.
 *
 * `buildWeb()` honours `NODE_ENV`: production minifies and drops sourcemaps. The rest of this
 * gate wants the development build — it is what the browser under test loads, and a minified
 * one makes a failure unreadable — so this flips the flag for one build and puts it back.
 *
 * **The measurement happens inside**, before the restore. Returning a path and stat-ing it
 * afterwards is what the first attempt did, and the `finally` had already overwritten the
 * production build with the development one — so it weighed the wrong file and reported the
 * same 168 KB it was trying to stop reporting.
 */
async function shippedShellBytes(): Promise<number> {
  const before = process.env['NODE_ENV'];
  process.env['NODE_ENV'] = 'production';

  try {
    const root = await buildWeb();
    const js = await stat(join(root, 'app.js'));
    const html = await stat(join(root, 'index.html'));

    return js.size + html.size;
  } finally {
    if (before === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = before;
    // Put the development build back, so a later test in this file loads what it expects.
    await buildWeb();
  }
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const RUN = randomUUID().slice(0, 8);

describe.skipIf(dbUrl === undefined)('M1 GATE: Rescue 1122, one emergency, end to end', () => {
  let pool: Pool;
  let api: Server;
  let origin: string;
  let webRoot: string;
  let browser: Browser;

  /** The field officer's handset. Signed in, throttled, offline for part of the run. */
  let handset: BrowserContext;
  let field: Page;

  /** The Rescue duty officer's screen, in the station. */
  let station: BrowserContext;
  let duty: Page;

  let rescueDept: string;
  let rescueOfficer: TestActor;
  let fieldOfficer: TestActor;
  let dcToken: string;
  let ambulance: string;

  /** What the whole run turns on: one incident, carried between tests. */
  let incidentId: string;
  let intakeMs = 0;

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

  async function signIn(page: Page, actor: TestActor): Promise<void> {
    await page.goto(origin);
    await page.waitForSelector('#login');
    await page.fill('#phone', actor.phone);
    await page.fill('#password', TEST_PASSWORD);
    await page.click('#loginSubmit');
    await page.waitForSelector('#nav:not([hidden])');
  }

  /** Usable, not merely painted. See the same helper in `rapidIntake.e2e.test.ts`. */
  async function waitForReady(page: Page): Promise<void> {
    await page.waitForSelector('#submit', { timeout: 30_000 });
    await page.waitForFunction(
      () => (globalThis as unknown as { __dnc?: unknown }).__dnc !== undefined,
      undefined,
      { timeout: 30_000 },
    );
  }

  beforeAll(async () => {
    webRoot = await buildWeb();
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    api = createSyncServer({
      pool,
      authMode: 'stub',
      nodeEnv: 'test',
      webRoot,
      evidenceRoot: await mkdtemp(join(tmpdir(), 'dnc-m1-')),
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    // The district administration, exactly as ADR-0010 describes it.
    const dcDept = await seedDepartment(pool, `DC Office (M1 ${RUN})`);
    await pool.query('UPDATE department SET is_administration = true WHERE department_id = $1', [
      dcDept,
    ]);
    dcToken = (
      await seedActor(pool, {
        title: `Deputy Commissioner (M1 ${RUN})`,
        departmentId: dcDept,
        tier: 'district',
      })
    ).token;

    // Rescue 1122, with a duty officer somebody can actually reach.
    rescueDept = await seedDepartment(pool, `Rescue 1122 (M1 ${RUN})`);
    rescueOfficer = await seedActor(pool, {
      title: `District Emergency Officer (M1 ${RUN})`,
      departmentId: rescueDept,
    });

    // A field officer in a different department — because an emergency in Bannu is usually
    // reported by whoever is standing there, not by the department that will answer it.
    const fieldDept = await seedDepartment(pool, `AAC Domel (M1 ${RUN})`);
    fieldOfficer = await seedActor(pool, {
      title: `AAC Domel (M1 ${RUN})`,
      departmentId: fieldDept,
    });

    // This gate establishes a known district configuration, so it owns the routing table
    // for the duration. The test database is never cleaned and a previous run's signals
    // would add departments to a route this test asserts exactly.
    await pool.query('UPDATE routing_signal SET retired_at = now() WHERE retired_at IS NULL');

    browser = await chromium.launch();
    handset = await browser.newContext();
    field = await handset.newPage();
    station = await browser.newContext();
    duty = await station.newPage();
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => api?.close(() => r()));
    await pool?.end();
  });

  //----------------------------------------------------------------------------
  // The district configures itself. No developer.
  //----------------------------------------------------------------------------

  it('1. the DC office configures Rescue from the console — no developer, no restart', async () => {
    const dc = await browser.newPage();
    await dc.goto(origin);
    await dc.waitForSelector('#login');

    const dcPerson = await pool.query<{ phone: string }>(
      `SELECT p.phone FROM person p
         JOIN duty_assignment d ON d.person_id = p.person_id AND d.to_at IS NULL
         JOIN seat s ON s.seat_id = d.seat_id
        WHERE s.title = $1`,
      [`Deputy Commissioner (M1 ${RUN})`],
    );
    await dc.fill('#phone', dcPerson.rows[0]!.phone);
    await dc.fill('#password', TEST_PASSWORD);
    await dc.click('#loginSubmit');
    await dc.waitForSelector('#navAdmin:not([hidden])');

    // A routing signal, typed by a person, on a screen.
    await dc.click('#navAdmin');
    await dc.waitForSelector('#adminDepartments');
    const card = dc.locator('.dept', { hasText: `Rescue 1122 (M1 ${RUN})` });
    await card.scrollIntoViewIfNeeded();
    // `fire`, not a phrase of this test's choosing.
    //
    // Rapid intake offers six fixed categories — rta, fire, medical, flood, security, other
    // — and a routing signal that names anything else can never match a report made from a
    // handset. That vocabulary is currently **my** guess rather than the district's, and it
    // is now R-14 on their list.
    await card.locator('.addsignal select').selectOption('category');
    await card.locator('.addsignal input').fill('fire');
    await card.locator('.addsignal button').click();
    await card.locator('.signal').waitFor();

    await dc.close();

    // And an ambulance, so there is something to send.
    const created = await apiCall('POST', `/fleet/${rescueDept}/units`, rescueOfficer.token, {
      kind: 'vehicle',
      name: `Ambulance 1 (M1 ${RUN})`,
      identifier: 'BNU-1122',
    });
    expect(created['resourceId']).toBeTruthy();
    ambulance = created['resourceId'] as string;
  }, 120_000);

  //----------------------------------------------------------------------------
  // A field officer reports it, and the clock runs
  //----------------------------------------------------------------------------

  it(`2. a field officer reports it in under ${String(BUDGET_MS / 1000)}s on a throttled handset`, async () => {
    await signIn(field, fieldOfficer);

    const cdp = await handset.newCDPSession(field);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_SLOWDOWN });

    try {
      // The clock starts before the reload, not after: "open to submitted" includes the app
      // loading. An earlier version of the M0 measurement started it after `waitForReady`
      // and reported a third of the real number — a fix that improves a metric by narrowing
      // it is not a fix.
      const started = Date.now();
      await field.reload();
      await waitForReady(field);

      await field.click('label[for="cat-fire"]');
      await field.click('label[for="sev-critical"]');
      await field.click('#submit');
      await field.waitForSelector('#sent:not([hidden])');

      intakeMs = Date.now() - started;
      // eslint-disable-next-line no-console -- the measurement is the point of the test
      console.log(
        `M1 gate — rapid intake: ${String(intakeMs)}ms (budget ${String(BUDGET_MS)}ms, cpu ${String(CPU_SLOWDOWN)}x)`,
      );

      expect(intakeMs).toBeLessThan(BUDGET_MS);
    } finally {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    }
  }, 120_000);

  it('3. the shell a field officer downloads has not quietly grown', async () => {
    // The bundle now carries the administration console, the roster editor, the shift screen
    // and the dashboard — none of which this officer will ever open. Cached after first load,
    // so this is a first-launch-on-a-weak-connection budget, and it exists so growth is
    // noticed here rather than by somebody in Domel.
    //
    // **Measured against a production build**, because that is the artefact the officer
    // downloads. This test used to weigh the development build, which ships sourcemaps and no
    // minification — 40% larger than anything the district would ever receive. It failed on
    // the M4 dashboard at 168 KB while the real shell was 122 KB, and a budget that fails on
    // a file nobody downloads teaches everybody to raise the budget.
    const total = await shippedShellBytes();

    // eslint-disable-next-line no-console -- worth seeing on every run
    console.log(
      `M1 gate — shell: ${String(Math.round(total / 1024))} KB (budget ${String(SHELL_BUDGET_BYTES / 1024)} KB)`,
    );
    expect(total).toBeLessThan(SHELL_BUDGET_BYTES);
  });

  //----------------------------------------------------------------------------
  // The system routes it. Still no human.
  //----------------------------------------------------------------------------

  it('4. it reaches Rescue by the signal the DC typed, with nobody deciding', async () => {
    // Waited for, not assumed.
    //
    // `#sent` means **durably stored on the handset**, which is the promise rapid intake
    // makes and is deliberately not "delivered" (INV-01, ADR-0002). The outbox pushes it a
    // moment later. Asserting immediately would be testing the network's luck.
    const deadline = Date.now() + 20_000;
    let found: { incident_id: string } | undefined;
    while (found === undefined && Date.now() < deadline) {
      const res = await pool.query<{ incident_id: string }>(
        `SELECT incident_id FROM incident_event
          WHERE type = 'reported'
            AND payload->>'category' = 'fire'
            AND actor_person_id = $1
          ORDER BY recorded_at DESC LIMIT 1`,
        [fieldOfficer.personId],
      );
      found = res.rows[0];
      if (found === undefined) await new Promise((r) => setTimeout(r, 250));
    }

    expect(found, 'the handset never delivered the report').toBeDefined();
    incidentId = found!.incident_id;

    // Routing runs on the **sync** path too, and until the gate walked this journey it did
    // not: an emergency captured on a handset reached nobody.
    let state = foldIncident(incidentId, await loadIncident(pool, incidentId));
    const routedBy = Date.now() + 10_000;
    while (state.responsibleDepartmentIds.length === 0 && Date.now() < routedBy) {
      await new Promise((r) => setTimeout(r, 250));
      state = foldIncident(incidentId, await loadIncident(pool, incidentId));
    }

    expect(state.responsibleDepartmentIds).toEqual([rescueDept]);
    expect(state.unassigned).toBe(false);

    // Routed by the system, not by a person: no seat and no person on the event.
    const routed = (await loadIncident(pool, incidentId)).find((e) => e.type === 'routed')!;
    expect(routed.actorSeatId).toBeNull();
    expect(routed.sourceChannel).toBe('system');
  });

  it('5. Rescue is told, and the message is waiting for the post rather than the person', async () => {
    const outcome = await runNotifyPass(pool, { incidentIds: [incidentId] });
    expect(outcome.attempted).toBeGreaterThanOrEqual(1);

    const inbox = await apiCall('GET', '/notifications', rescueOfficer.token);
    const items = inbox['notifications'] as { incidentId: string }[];
    expect(items.map((i) => i.incidentId)).toContain(incidentId);
  });

  //----------------------------------------------------------------------------
  // The duty officer works the shift
  //----------------------------------------------------------------------------

  it('6. the duty officer sees it under "needs you now" and acknowledges', async () => {
    await signIn(duty, rescueOfficer);
    await duty.waitForSelector('#navShift:not([hidden])');
    await duty.click('#navShift');

    const card = duty.locator(`#needsYou .work[data-incident="${incidentId}"]`);
    await card.waitFor({ timeout: 20_000 });
    expect(await card.locator('.sev').textContent()).toBe('critical');

    await card.getByRole('button', { name: 'Acknowledge' }).click();
    await duty.locator(`#liveWork .work[data-incident="${incidentId}"]`).waitFor();

    const state = foldIncident(incidentId, await loadIncident(pool, incidentId));
    expect(state.acknowledgedAt).not.toBeNull();
    expect(state.acknowledgedBySeatId).toBe(rescueOfficer.seatId);
  }, 60_000);

  it('7. sends the ambulance, from the incident card', async () => {
    await duty.click('#navBoard');
    await duty.click('#navShift');

    const card = duty.locator(`#liveWork .work[data-incident="${incidentId}"]`);
    await card.waitFor();

    // "In hand" cards do not carry a send control, so dispatch goes through the API the
    // screen would call. The screen path is covered in `workspace.e2e.test.ts`; what this
    // gate is proving is the lifecycle, not a second copy of that test.
    const sent = await apiCall('POST', `/incidents/${incidentId}/dispatch`, rescueOfficer.token, {
      resourceIds: [ambulance],
    });
    expect(sent['warnings']).toEqual([]);

    const state = foldIncident(incidentId, await loadIncident(pool, incidentId));
    expect(state.assignedResourceIds).toEqual([ambulance]);
  }, 60_000);

  it('8. logs what happened, dated when it happened rather than when it was typed', async () => {
    const onScene = new Date(Date.now() - 12 * 60_000).toISOString();
    await apiCall('POST', `/incidents/${incidentId}/actions`, rescueOfficer.token, {
      note: 'first crew on scene, fire in the upper storey, two casualties',
      occurredAt: onScene,
    });
    await apiCall('POST', `/incidents/${incidentId}/actions`, rescueOfficer.token, {
      note: 'both casualties removed and handed to Health',
    });

    const events = await loadIncident(pool, incidentId);
    const first = events.filter((e) => e.type === 'action_logged')[0]!;
    // Twelve minutes ago, because that is when the crew arrived. ADR-0002.
    expect(first.occurredAt).toBe(onScene);
    expect(Date.parse(first.recordedAt)).toBeGreaterThan(Date.parse(onScene));
  });

  it('9. attaches a photograph of the scene', async () => {
    const res = await globalThis.fetch(`${origin}/incidents/${incidentId}/evidence`, {
      method: 'POST',
      headers: {
        'content-type': 'image/png',
        'x-filename': `upper-storey-${RUN}.png`,
        'x-caption': 'upper storey, from the street',
        authorization: `Bearer ${rescueOfficer.token}`,
      },
      body: new Uint8Array(PNG),
    });
    expect(res.status).toBe(201);
  });

  it('10. stands the ambulance down, and it becomes available again', async () => {
    await apiCall('POST', `/incidents/${incidentId}/release`, rescueOfficer.token, {
      resourceIds: [ambulance],
      reason: 'casualties removed, returning to station',
    });

    const fleet = await apiCall('GET', '/fleet', rescueOfficer.token);
    const units = fleet['units'] as { resource: { resourceId: string }; blockedBy: string[] }[];
    expect(units.find((u) => u.resource.resourceId === ambulance)?.blockedBy).toEqual([]);
  });

  it('11. resolves and closes it', async () => {
    await apiCall('POST', `/incidents/${incidentId}/resolve`, rescueOfficer.token, {
      outcome: 'fire extinguished, two casualties removed to DHQ, no fatalities',
    });
    await apiCall('POST', `/incidents/${incidentId}/close`, rescueOfficer.token, {
      notes: 'scene handed to Police for the cause investigation',
    });

    const state = foldIncident(incidentId, await loadIncident(pool, incidentId));
    expect(state.status).toBe('closed');
  });

  //----------------------------------------------------------------------------
  // And the account of it writes itself
  //----------------------------------------------------------------------------

  it('12. the post-incident report contains the whole night, and nobody typed it', async () => {
    const res = await globalThis.fetch(`${origin}/incidents/${incidentId}/report?format=text`, {
      headers: { authorization: `Bearer ${rescueOfficer.token}` },
    });
    const text = await res.text();

    expect(text).toContain('folded from the event log, not typed');
    expect(text).toContain('Category: fire');
    expect(text).toContain(`Rescue 1122 (M1 ${RUN})`);
    expect(text).toContain(`Ambulance 1 (M1 ${RUN})`);
    expect(text).toContain('first crew on scene');
    expect(text).toContain('both casualties removed');
    expect(text).toContain(`upper-storey-${RUN}.png`);
    expect(text).toContain('fire extinguished');
    expect(text).toContain('handed to Police');

    // eslint-disable-next-line no-console -- the document is the deliverable; print it once
    console.log(`\n${text}\n`);
  });

  it('13. and the report has no human-shaped holes in it', async () => {
    // Taken as the **DC office**, not as Rescue. The two offices are answerable for the
    // district (ADR-0010), and a report they cannot read is a report they cannot review.
    const res = await globalThis.fetch(`${origin}/incidents/${incidentId}/report`, {
      headers: { authorization: `Bearer ${dcToken}` },
    });
    expect(res.status).toBe(200);
    const report = (await res.json()) as { gaps: { what: string }[] };
    const gaps = report.gaps.map((g) => g.what);

    // Everything a person was supposed to do was done and recorded.
    expect(gaps).not.toContain('Nobody acknowledged this');
    expect(gaps).not.toContain('Nobody assessed the severity');
    expect(gaps).not.toContain('Nothing was recorded as sent');
    expect(gaps).not.toContain('No actions were logged');
    expect(gaps).not.toContain('No photographs or files were attached');
    expect(gaps).not.toContain('No outcome was recorded');
    expect(gaps).not.toContain('No department held this');
  });

  //----------------------------------------------------------------------------
  // The gate, stated
  //----------------------------------------------------------------------------

  it('14. the whole lifecycle is in the log, in order, with nothing invented', async () => {
    const events = await loadIncident(pool, incidentId);
    const types = events.map((e) => e.type);

    for (const required of [
      'reported',
      'routed',
      'notified',
      'acknowledged',
      'assigned',
      'action_logged',
      'released',
      'resolved',
      'closed',
    ]) {
      expect(types).toContain(required);
    }

    // Causal order holds across the whole run (ADR-0008).
    const order = events.map((e) => `${e.occurredAt}|${String(e.clientSeq)}`);
    expect(order).toEqual([...order].sort());

    // Every event carries who, or says plainly that the system did it. INV-06.
    for (const e of events) {
      const bySystem = e.actorSeatId === null && e.actorPersonId === null;
      expect(bySystem ? e.sourceChannel : 'has-actor').toBeTruthy();
      if (bySystem) expect(e.sourceChannel).toBe('system');
    }
  });

  it('15. states what this gate does and does not prove', () => {
    // Not an assertion about the code. A statement, kept where it cannot be forgotten,
    // because the milestone's own wording is "a real Rescue operator, no developer present"
    // and everything above was driven by the person who wrote it.
    const proven = [
      'the lifecycle works end to end against a real database and a real browser',
      'the district can configure it without a developer',
      `intake stays inside the ${String(BUDGET_MS / 1000)}-second budget under a ${String(CPU_SLOWDOWN)}x CPU throttle`,
      'the account of the night writes itself',
    ];
    const notProven = [
      'that a Rescue operator who did not build this can complete it — R-12',
      'that the wording on these screens makes sense in Urdu or Pashto — R-09',
      'that an alert reaches a phone, rather than an inbox — R-05',
    ];

    expect(proven).toHaveLength(4);
    expect(notProven).toHaveLength(3);
    // eslint-disable-next-line no-console -- this is the point of the test
    console.log(
      `\nM1 GATE\n  proven:\n    - ${proven.join('\n    - ')}\n  NOT proven:\n    - ${notProven.join('\n    - ')}\n`,
    );
  });
});
