/**
 * The post-incident report — M1-06.
 *
 * The report exists so that a department does not retype what the system already knows. So
 * the tests are mostly about two things:
 *
 *   **Is it actually folded?** Every field is checked against something that was *done*
 *   during the test, never against something the test also typed into the report.
 *
 *   **Does it say what is missing?** A report handed to a review with the holes removed reads
 *   as a clean response, and that is the one thing this document must never do. The
 *   bare-incident test at the bottom is the important one in the file.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSyncServer } from '../server.js';
import { createPool, migrate, type Pool } from '../../db/pool.js';
import { seedActor, seedDepartment } from '../../testing/seed.js';
import type { PostIncidentReport } from '../../domain/report.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const RUN = randomUUID().slice(0, 8);

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe.skipIf(dbUrl === undefined)('the post-incident report (integration)', () => {
  let pool: Pool;
  let server: Server;
  let base: string;

  let dcToken: string;
  let rescueToken: string;
  let rescueDept: string;
  let outsiderToken: string;

  /** Named rather than passed inline, so `afterAll` has something to delete. */
  let evidenceRoot: string;

  beforeAll(async () => {
    evidenceRoot = await mkdtemp(join(tmpdir(), 'dnc-report-'));
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    server = createSyncServer({
      pool,
      authMode: 'stub',
      nodeEnv: 'test',
      evidenceRoot,
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const dcDept = await seedDepartment(pool, `DC Office (report ${RUN})`);
    await pool.query('UPDATE department SET is_administration = true WHERE department_id = $1', [
      dcDept,
    ]);
    dcToken = (
      await seedActor(pool, { title: `DC (report ${RUN})`, departmentId: dcDept, tier: 'district' })
    ).token;

    rescueDept = await seedDepartment(pool, `Rescue 1122 (report ${RUN})`);
    rescueToken = (
      await seedActor(pool, { title: `Rescue Duty (report ${RUN})`, departmentId: rescueDept })
    ).token;

    const other = await seedDepartment(pool, `Unrelated (report ${RUN})`);
    outsiderToken = (await seedActor(pool, { title: `Outsider ${RUN}`, departmentId: other }))
      .token;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
    // The directory this suite made, removed. Five suites created one and only one deleted
    // it, so every full run left its dumps and evidence behind in the system temp folder —
    // 287 directories and 840 MB of them by the time somebody's disk filled up. A test that
    // litters is a test that eventually stops the machine it runs on.
    if (evidenceRoot !== undefined) await rm(evidenceRoot, { recursive: true, force: true });
  });

  async function call(
    method: string,
    path: string,
    token: string | null,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const raw = await res.text();
    return {
      status: res.status,
      body: raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>),
    };
  }

  async function report(incidentId: string, token: string): Promise<PostIncidentReport> {
    const res = await call('GET', `/incidents/${incidentId}/report`, token);
    expect(res.status).toBe(200);
    return res.body as unknown as PostIncidentReport;
  }

  /** An incident routed to Rescue and nothing else. */
  async function bare(category: string): Promise<string> {
    const created = await call('POST', '/incidents', dcToken, { category });
    const id = created.body['incidentId'] as string;
    await call('POST', `/incidents/${id}/route`, dcToken, {
      departmentIds: [rescueDept],
      reason: 'report test',
    });
    return id;
  }

  /**
   * An incident taken all the way through, the way a real one would be.
   *
   * The unit name is unique per call. Several tests build one of these, and a fixed name
   * meant the second call collided with the first — two live units with the same name in one
   * department is refused, correctly, and the dispatch that followed then had nothing to
   * send. The report was right; the fixture was wrong.
   */
  async function complete(): Promise<{ id: string; unit: string; unitName: string }> {
    const id = await bare(`full-${RUN}`);
    const unitName = `Ambulance ${RUN}-${randomUUID().slice(0, 6)}`;

    await call('POST', `/incidents/${id}/triage`, rescueToken, {
      severity: 'critical',
      category: `structure fire ${RUN}`,
    });
    await call('POST', `/incidents/${id}/acknowledge`, rescueToken, {});

    const created = await call('POST', `/fleet/${rescueDept}/units`, rescueToken, {
      kind: 'vehicle',
      name: unitName,
    });
    expect(created.status).toBe(201);
    const unit = created.body['resourceId'] as string;

    await call('POST', `/incidents/${id}/dispatch`, rescueToken, { resourceIds: [unit] });
    await call('POST', `/incidents/${id}/actions`, rescueToken, {
      note: 'first crew on scene, two casualties',
    });
    await call('POST', `/incidents/${id}/release`, rescueToken, {
      resourceIds: [unit],
      reason: 'casualties removed',
    });

    await fetch(`${base}/incidents/${id}/evidence`, {
      method: 'POST',
      headers: {
        'content-type': 'image/png',
        'x-filename': `scene-${RUN}.png`,
        authorization: `Bearer ${rescueToken}`,
      },
      body: new Uint8Array(PNG),
    });

    await call('POST', `/incidents/${id}/resolve`, rescueToken, {
      outcome: 'fire extinguished, two casualties to DHQ',
    });
    await call('POST', `/incidents/${id}/close`, rescueToken, { notes: 'handed to Police' });

    return { id, unit, unitName };
  }

  //----------------------------------------------------------------------------

  describe('it is folded, not typed', () => {
    it('names what happened and who assessed it', async () => {
      const { id } = await complete();
      const r = await report(id, rescueToken);

      expect(r.what.category).toBe(`structure fire ${RUN}`);
      expect(r.what.severity).toBe('critical');
      expect(r.what.severityAssessed).toBe(true);
      // The seat, because authority attaches to the post (ADR-0004).
      expect(r.what.severitySetBy?.seatTitle).toContain('Rescue Duty');
    });

    it('names the department that held it', async () => {
      const { id } = await complete();
      const r = await report(id, rescueToken);
      expect(r.who.departments).toContain(`Rescue 1122 (report ${RUN})`);
    });

    it('lists what was sent, and for how long', async () => {
      const { id, unitName } = await complete();
      const r = await report(id, rescueToken);

      expect(r.unitsSent).toHaveLength(1);
      expect(r.unitsSent[0]?.name).toBe(unitName);
      // Stood down, so the commitment has an end. A unit still out would read as null rather
      // than as zero minutes.
      expect(r.unitsSent[0]?.releasedAt).not.toBeNull();
      expect(r.unitsSent[0]?.minutesCommitted).not.toBeNull();
    });

    it('carries the action log, in the order things happened', async () => {
      const { id } = await complete();
      const r = await report(id, rescueToken);

      const actions = r.narrative.filter((e) => e.what === 'Action');
      expect(actions[0]?.detail).toBe('first crew on scene, two casualties');

      const times = r.narrative.map((e) => Date.parse(e.at));
      expect(times).toEqual([...times].sort((a, b) => a - b));
    });

    it('lists the evidence by the name the device gave it', async () => {
      const { id } = await complete();
      const r = await report(id, rescueToken);
      expect(r.evidence.map((e) => e.filename)).toContain(`scene-${RUN}.png`);
    });

    it('carries the outcome and the closing notes', async () => {
      const { id } = await complete();
      const r = await report(id, rescueToken);
      expect(r.outcome).toContain('fire extinguished');
      expect(r.closureNotes).toBe('handed to Police');
    });

    it('names a retired unit rather than rendering its id', async () => {
      // A report may describe a night on which an ambulance the district has since retired
      // attended. Rendering it as a uuid is the failure the department registry ended.
      const { id, unit, unitName } = await complete();
      await call('POST', `/fleet/units/${unit}/retire`, rescueToken, { reason: 'sold' });

      const r = await report(id, rescueToken);
      expect(r.unitsSent[0]?.name).toBe(unitName);
    });
  });

  describe('times are measured from when it happened', () => {
    it('reports every milestone as minutes from the emergency itself', async () => {
      const { id } = await complete();
      const r = await report(id, rescueToken);

      const acknowledged = r.timings.find((t) => t.label === 'Acknowledged');
      expect(acknowledged?.at).not.toBeNull();
      expect(acknowledged?.minutesFromOccurrence).not.toBeNull();
      expect(acknowledged?.missing).toBeNull();
    });

    /**
     * ADR-0002, in the one document that will be read by somebody deciding whether the
     * district responded well. Measuring from arrival would turn an hour on a handset with no
     * signal into an apparently instant response.
     */
    it('states the gap between happening and arriving as its own fact', async () => {
      const { id } = await complete();
      const r = await report(id, rescueToken);
      expect(typeof r.connectivity.arrivalGapMinutes).toBe('number');
    });
  });

  //----------------------------------------------------------------------------
  // The important one
  //----------------------------------------------------------------------------

  describe('it says what the record does not contain', () => {
    /**
     * The most valuable section, and the one a hand-written report always omits.
     *
     * This incident was reported and routed and then nothing happened to it. Every one of
     * those absences is a separate finding, because a review handed a document with the holes
     * removed reads a clean response.
     */
    it('names every hole in an incident nobody acted on', async () => {
      const id = await bare(`abandoned-${RUN}`);
      const r = await report(id, rescueToken);

      const gaps = r.gaps.map((g) => g.what);
      expect(gaps).toContain('Nobody acknowledged this');
      expect(gaps).toContain('Nobody assessed the severity');
      expect(gaps).toContain('Nothing was recorded as sent');
      expect(gaps).toContain('No actions were logged');
      expect(gaps).toContain('No photographs or files were attached');
      expect(gaps).toContain('No outcome was recorded');
    });

    it('explains each hole rather than only naming it', async () => {
      const id = await bare(`explained-${RUN}`);
      const r = await report(id, rescueToken);

      // "Nothing was recorded as sent" and "we cannot tell whether anything went" are
      // different statements, and a review needs the second.
      const sent = r.gaps.find((g) => g.what === 'Nothing was recorded as sent');
      expect(sent?.why).toContain('cannot tell them apart');
      for (const gap of r.gaps) expect(gap.why.length).toBeGreaterThan(20);
    });

    it('has nothing to report about an incident that was handled fully', async () => {
      const { id } = await complete();
      const r = await report(id, rescueToken);

      // Notifications are the one thing this test does not drive, so they may legitimately
      // appear. Everything a human did is present.
      const gaps = r.gaps.map((g) => g.what);
      expect(gaps).not.toContain('Nobody acknowledged this');
      expect(gaps).not.toContain('No actions were logged');
      expect(gaps).not.toContain('No outcome was recorded');
    });
  });

  //----------------------------------------------------------------------------

  describe('as a document', () => {
    it('renders as plain text somebody can paste into a form', async () => {
      const { id, unitName } = await complete();
      const res = await fetch(`${base}/incidents/${id}/report?format=text`, {
        headers: { authorization: `Bearer ${rescueToken}` },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/plain');

      const text = await res.text();
      expect(text).toContain('POST-INCIDENT REPORT');
      expect(text).toContain(`structure fire ${RUN}`);
      expect(text).toContain(unitName);
      expect(text).toContain('first crew on scene');
      expect(text).toContain('fire extinguished');
      // Q-02: the platform produces the account rather than integrating with whatever
      // receives it, and nobody on the other end should need this software installed.
      expect(text).toContain('WHAT THIS RECORD DOES NOT CONTAIN');
    });

    it('says in the document that it was folded rather than typed', async () => {
      const { id } = await complete();
      const res = await fetch(`${base}/incidents/${id}/report?format=text`, {
        headers: { authorization: `Bearer ${rescueToken}` },
      });
      expect(await res.text()).toContain('folded from the event log, not typed');
    });

    it('spells out an absence in the text, not as a blank line', async () => {
      const id = await bare(`blank-${RUN}`);
      const res = await fetch(`${base}/incidents/${id}/report?format=text`, {
        headers: { authorization: `Bearer ${rescueToken}` },
      });
      const text = await res.text();

      expect(text).toContain('Never acknowledged by anybody');
      expect(text).toContain('Nothing was recorded as sent');
      expect(text).toContain('No outcome was recorded');
    });
  });

  describe('who may take one', () => {
    it('refuses somebody who cannot read the incident, as a 404', async () => {
      const { id } = await complete();
      const res = await call('GET', `/incidents/${id}/report`, outsiderToken);
      // Same as an incident read: confirming it exists is itself a disclosure.
      expect(res.status).toBe(404);
    });

    it('refuses an unauthenticated caller', async () => {
      const { id } = await complete();
      expect((await call('GET', `/incidents/${id}/report`, null)).status).toBe(401);
    });

    it('lets the administration take a report of any incident', async () => {
      const { id } = await complete();
      expect((await call('GET', `/incidents/${id}/report`, dcToken)).status).toBe(200);
    });
  });

  describe('an override is shown as both values', () => {
    it('keeps what the department said as well as what replaced it', async () => {
      const id = await bare(`override-${RUN}`);
      await call('POST', `/incidents/${id}/triage`, rescueToken, {
        severity: 'moderate',
        category: `rta ${RUN}`,
      });
      await call('POST', `/incidents/${id}/override`, dcToken, {
        field: 'severity',
        value: 'critical',
        reason: 'second reporter confirms multiple casualties',
      });

      const r = await report(id, dcToken);

      expect(r.what.severity).toBe('critical');
      // An override that erased what the department originally said would be the system
      // taking a side (ADR-0003).
      expect(r.what.severityOverriddenFrom).toBe('moderate');
      expect(r.what.overrideReason).toContain('second reporter');
    });
  });
});
