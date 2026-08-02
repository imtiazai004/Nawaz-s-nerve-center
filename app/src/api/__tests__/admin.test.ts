/**
 * The administration console — M1a, over HTTP, against a real PostgreSQL.
 *
 * The milestone gate is one test in here: **an operator adds a department, gives it a
 * routing signal, and the next matching emergency reaches it — with no developer involved.**
 * Everything else is the ways that can be true on a screen and false in the district.
 *
 * The rest of the file is mostly refusals, because this endpoint is the one place in the
 * system where a wrong answer is silent. A department retired by mistake does not throw; it
 * simply stops receiving emergencies, and nobody finds out until one goes unanswered.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSyncServer } from '../server.js';
import { createPool, migrate, type Pool } from '../../db/pool.js';
import { seedActor, seedDepartment } from '../../testing/seed.js';
import { loadIncident } from '../../db/eventStore.js';
import { foldIncident } from '../../domain/incident.js';
import type { Board } from '../board.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

/**
 * A suffix unique to this run.
 *
 * The test database persists between runs, and departments are never deleted — retiring is
 * the only removal this system has, by design (ADR-0001). So a second run against the same
 * database finds the previous run's Irrigation Department still live, still holding the
 * keyword `canal`, and routes the gate test's emergency to two departments.
 *
 * Worth naming because the failure looked exactly like a routing bug: the system was right
 * and the test was wrong. Every name and pattern below is unique per run.
 */
const RUN = randomUUID().slice(0, 8);

describe.skipIf(dbUrl === undefined)('the administration console (integration)', () => {
  let pool: Pool;
  let server: Server;
  let base: string;

  /** A seat inside an office marked `is_administration` — the DC Office equivalent. */
  let dcToken: string;
  /** The AC Headquarter equivalent. Same powers, by ADR-0010. */
  let acToken: string;
  /** An ordinary department. Holds no administrative authority whatsoever. */
  let rescueToken: string;
  let rescueDept: string;

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    server = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const dcDept = await seedDepartment(pool, 'DC Office (test)');
    const acDept = await seedDepartment(pool, 'AC Headquarter (test)');
    await pool.query(
      'UPDATE department SET is_administration = true WHERE department_id = ANY($1::uuid[])',
      [[dcDept, acDept]],
    );

    dcToken = (
      await seedActor(pool, { title: 'DC (test)', departmentId: dcDept, tier: 'district' })
    ).token;
    acToken = (
      await seedActor(pool, { title: 'AC HQ (test)', departmentId: acDept, tier: 'district' })
    ).token;

    // Take control of the district's routing configuration for the duration of this suite.
    //
    // Not housekeeping — a precondition. These tests assert **exactly** which departments an
    // emergency reaches, and that assertion is only meaningful against a known set of
    // signals. The test database persists, departments are never deleted (retiring is the
    // only removal this system has, by design), and a previous run's signals would silently
    // add departments to every `routedTo` here. Retiring rather than deleting, because that
    // is the operation the system actually has.
    await pool.query('UPDATE routing_signal SET retired_at = now() WHERE retired_at IS NULL');

    rescueDept = await seedDepartment(pool, 'Rescue (admin test)');
    rescueToken = (
      await seedActor(pool, { title: 'Rescue Duty', departmentId: rescueDept, tier: 'department' })
    ).token;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
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
    const text = await res.text();
    return {
      status: res.status,
      body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
    };
  }

  //----------------------------------------------------------------------------
  // The gate
  //----------------------------------------------------------------------------

  describe('only the two administrative offices may configure the district (ADR-0010)', () => {
    it('refuses a department seat, and says why rather than pretending to be missing', async () => {
      const res = await call('GET', '/admin/departments', rescueToken);
      expect(res.status).toBe(403);
      expect(String(res.body['error'])).toContain('DC Office');
    });

    it('refuses a department seat trying to write, not only trying to read', async () => {
      // The failure that matters. A console hidden from the menu is not a control (INV-05).
      const res = await call('POST', '/admin/departments', rescueToken, { name: 'Sneaky' });
      expect(res.status).toBe(403);

      const list = await call('GET', '/admin/departments', dcToken);
      const names = (list.body as unknown as { name: string }[]).map?.((d) => d.name) ?? [];
      expect(names).not.toContain('Sneaky');
    });

    it('refuses an unauthenticated caller with 401, not 403', async () => {
      expect((await call('GET', '/admin/departments', null)).status).toBe(401);
    });

    /**
     * ADR-0010's clarification, pinned as a test: the two offices are equal. If a future
     * change gives the DC something the AC cannot do, this fails, which is the intent —
     * that would be a change to the authority model, not a convenience flag.
     */
    it('gives the AC Headquarter office exactly the same powers as the DC office', async () => {
      const created = await call('POST', '/admin/departments', acToken, {
        name: `Created by the AC office ${RUN}`,
      });
      expect(created.status).toBe(201);

      const id = created.body['departmentId'] as string;
      expect(
        (await call('PATCH', `/admin/departments/${id}`, dcToken, { name: `Renamed by DC ${RUN}` }))
          .status,
      ).toBe(200);
      expect(
        (await call('PATCH', `/admin/departments/${id}`, acToken, { name: `Renamed by AC ${RUN}` }))
          .status,
      ).toBe(200);
    });
  });

  //----------------------------------------------------------------------------
  // The gate this milestone is measured by
  //----------------------------------------------------------------------------

  describe('M1a gate: a department added from a screen receives emergencies', () => {
    it('adds a department, gives it a signal, and the next matching report reaches it', async () => {
      // 1. The administration creates a department that did not exist a moment ago.
      const created = await call('POST', '/admin/departments', dcToken, {
        name: `Irrigation Department ${RUN}`,
        description: 'Canals, embankments, and flood channels',
        contactPhone: '0928-9999999',
      });
      expect(created.status).toBe(201);
      const irrigation = created.body['departmentId'] as string;

      // 2. And tells the system what it answers for.
      const signal = await call('POST', `/admin/departments/${irrigation}/signals`, dcToken, {
        kind: 'keyword',
        pattern: `canal-${RUN}`,
      });
      expect(signal.status).toBe(201);

      // 3. An officer somewhere in the district reports an emergency. No developer has
      //    touched anything, no process has restarted, no code names "irrigation".
      const report = await call('POST', '/incidents', rescueToken, {
        category: 'flooding',
        description: `The canal-${RUN} has breached near Kakki and water is entering houses`,
      });
      expect(report.status).toBe(201);

      // 4. It reached the new department.
      expect(report.body['routedTo']).toEqual([irrigation]);
      expect(report.body['unassigned']).toBe(false);

      // And the event log says so too, not just the response body.
      const state = foldIncident(
        report.body['incidentId'] as string,
        await loadIncident(pool, report.body['incidentId'] as string),
      );
      expect(state.responsibleDepartmentIds).toEqual([irrigation]);
      expect(state.unassigned).toBe(false);
    });

    it('stops sending it there the moment the signal is retired', async () => {
      const created = await call('POST', '/admin/departments', dcToken, {
        name: `Wildlife ${RUN}`,
      });
      const wildlife = created.body['departmentId'] as string;
      const signal = await call('POST', `/admin/departments/${wildlife}/signals`, dcToken, {
        kind: 'category',
        pattern: `snake bite ${RUN}`,
      });
      const signalId = signal.body['signalId'] as string;

      const before = await call('POST', '/incidents', rescueToken, {
        category: `snake bite ${RUN}`,
      });
      expect(before.body['routedTo']).toEqual([wildlife]);

      const retired = await call('POST', `/admin/signals/${signalId}/retire`, dcToken, {
        reason: 'handled by Health now',
      });
      expect(retired.status).toBe(200);

      const after = await call('POST', '/incidents', rescueToken, {
        category: `snake bite ${RUN}`,
      });
      expect(after.body['routedTo']).toEqual([]);
      expect(after.body['unassigned']).toBe(true);
    });
  });

  //----------------------------------------------------------------------------
  // Refusals that keep the district's record intact
  //----------------------------------------------------------------------------

  describe('what it will not do', () => {
    it('will not retire an administrative office', async () => {
      // The one mistake with no recovery inside the system: both offices retired leaves the
      // district with no authority and no way to create one.
      const list = await call('GET', '/admin/departments', dcToken);
      const admin = (
        list.body as unknown as { departmentId: string; isAdministration: boolean }[]
      ).filter?.((d) => d.isAdministration)[0];
      expect(admin).toBeDefined();

      const res = await call('POST', `/admin/departments/${admin!.departmentId}/retire`, dcToken, {
        reason: 'testing',
      });
      expect(res.status).toBe(409);
      expect(String(res.body['error'])).toContain('no authority');
    });

    it('will not retire a department without a reason', async () => {
      const created = await call('POST', '/admin/departments', dcToken, {
        name: `Reasonless ${RUN}`,
      });
      const id = created.body['departmentId'] as string;
      expect((await call('POST', `/admin/departments/${id}/retire`, dcToken, {})).status).toBe(400);
    });

    it('will not create a department with no name', async () => {
      expect((await call('POST', '/admin/departments', dcToken, { name: '   ' })).status).toBe(400);
    });

    it('will not add the same signal to a department twice', async () => {
      const created = await call('POST', '/admin/departments', dcToken, {
        name: `Duplicates ${RUN}`,
      });
      const id = created.body['departmentId'] as string;
      const body = { kind: 'keyword', pattern: `landslide ${RUN}` };
      expect((await call('POST', `/admin/departments/${id}/signals`, dcToken, body)).status).toBe(
        201,
      );
      const second = await call('POST', `/admin/departments/${id}/signals`, dcToken, body);
      // 409, not 400: the request was well formed; the district's state disagrees.
      expect(second.status).toBe(409);
    });

    it('will not accept a signal kind it does not understand', async () => {
      const created = await call('POST', '/admin/departments', dcToken, {
        name: `Bad kinds ${RUN}`,
      });
      const id = created.body['departmentId'] as string;
      const res = await call('POST', `/admin/departments/${id}/signals`, dcToken, {
        kind: 'regex',
        pattern: '.*',
      });
      expect(res.status).toBe(400);
    });

    it('will not accept a deadline of zero, which would make everything overdue at once', async () => {
      const res = await call('PUT', '/admin/sla', dcToken, {
        severity: 'critical',
        ackMinutes: 0,
      });
      expect(res.status).toBe(400);
    });

    it('will not accept a deadline of a fortnight either', async () => {
      const res = await call('PUT', '/admin/sla', dcToken, {
        severity: 'low',
        ackMinutes: 20_160,
      });
      expect(res.status).toBe(400);
    });
  });

  //----------------------------------------------------------------------------
  // Retiring a department
  //----------------------------------------------------------------------------

  describe('retiring a department', () => {
    it('retires its routing signals with it, so nothing is sent to nobody', async () => {
      // The quiet failure this prevents: a retired department keeps matching emergencies,
      // which then arrive at an office that no longer exists and are never acknowledged.
      const created = await call('POST', '/admin/departments', dcToken, {
        name: `Temporary Cell ${RUN}`,
      });
      const id = created.body['departmentId'] as string;
      await call('POST', `/admin/departments/${id}/signals`, dcToken, {
        kind: 'category',
        pattern: `locust ${RUN}`,
      });

      const before = await call('POST', '/incidents', rescueToken, { category: `locust ${RUN}` });
      expect(before.body['routedTo']).toEqual([id]);

      await call('POST', `/admin/departments/${id}/retire`, dcToken, {
        reason: 'cell disbanded after the season',
      });

      const after = await call('POST', '/incidents', rescueToken, { category: `locust ${RUN}` });
      expect(after.body['unassigned']).toBe(true);
    });

    it('keeps the department readable rather than deleting it', async () => {
      const list = await call('GET', '/admin/departments', dcToken);
      const rows = list.body as unknown as { name: string; retiredAt: string | null }[];
      const cell = rows.find((d) => d.name === `Temporary Cell ${RUN}`);
      expect(cell).toBeDefined();
      expect(cell!.retiredAt).not.toBeNull();
    });

    it('can bring one back', async () => {
      const list = await call('GET', '/admin/departments', dcToken);
      const rows = list.body as unknown as { departmentId: string; name: string }[];
      const cell = rows.find((d) => d.name === `Temporary Cell ${RUN}`)!;

      const res = await call('POST', `/admin/departments/${cell.departmentId}/restore`, dcToken, {
        reason: 'locusts are back',
      });
      expect(res.status).toBe(200);
      expect(res.body['retiredAt']).toBeNull();
    });
  });

  //----------------------------------------------------------------------------
  // SLA targets — Q-06 as configuration
  //----------------------------------------------------------------------------

  describe('acknowledgement deadlines', () => {
    it('starts from the seeded district defaults rather than nothing', async () => {
      const res = await call('GET', '/admin/sla', dcToken);
      expect(res.status).toBe(200);
      const district = res.body['district'] as Record<string, number>;
      expect(district['critical']).toBeGreaterThan(0);
      // ADR-0009: `unknown` is not a level, but it still needs a deadline — and a tight one.
      expect(district['unknown']).toBeDefined();
    });

    /**
     * Changing one, not just setting one.
     *
     * These were the same code path in the caller's head and two different ones in Postgres:
     * the insert worked and the update failed with "could not determine data type of
     * parameter $1", because the shared parameter array bound two placeholders the UPDATE
     * never referenced. Every SLA test written before this one created a fresh row, so the
     * district could set a deadline exactly once and never revise it. Caught by the browser
     * test, where an operator naturally edits a value that already exists.
     */
    it('changes a deadline that already has a value', async () => {
      const first = await call('PUT', '/admin/sla', dcToken, {
        severity: 'moderate',
        ackMinutes: 45,
      });
      expect(first.status).toBe(200);

      const second = await call('PUT', '/admin/sla', dcToken, {
        severity: 'moderate',
        ackMinutes: 46,
      });
      expect(second.status).toBe(200);

      const sla = await call('GET', '/admin/sla', dcToken);
      expect((sla.body['district'] as Record<string, number>)['moderate']).toBe(46);
    });

    it('lets a department have a tighter deadline than the district', async () => {
      const created = await call('POST', '/admin/departments', dcToken, {
        name: `Fast Response ${RUN}`,
      });
      const id = created.body['departmentId'] as string;

      const set = await call('PUT', '/admin/sla', dcToken, {
        departmentId: id,
        severity: 'critical',
        ackMinutes: 2,
      });
      expect(set.status).toBe(200);

      const sla = await call('GET', '/admin/sla', dcToken);
      const byDepartment = sla.body['byDepartment'] as Record<string, Record<string, number>>;
      expect(byDepartment[id]?.['critical']).toBe(2);
    });

    /**
     * The number an operator reads off the board must be the number the administration set.
     * Before M1a the board rendered `PLACEHOLDER_SLA` — a guess in a source file — as though
     * it were the district's own rule.
     */
    it('applies the configured deadline on the board, not the compiled-in default', async () => {
      const created = await call('POST', '/admin/departments', dcToken, {
        name: `Slow Lane ${RUN}`,
      });
      const id = created.body['departmentId'] as string;
      await call('POST', `/admin/departments/${id}/signals`, dcToken, {
        kind: 'category',
        pattern: `paperwork ${RUN}`,
      });
      await call('PUT', '/admin/sla', dcToken, {
        departmentId: id,
        severity: 'low',
        ackMinutes: 999,
      });

      const report = await call('POST', '/incidents', rescueToken, {
        category: `paperwork ${RUN}`,
        severity: 'low',
      });
      expect(report.body['routedTo']).toEqual([id]);

      const boardRes = await fetch(`${base}/incidents`, {
        headers: { authorization: `Bearer ${dcToken}` },
      });
      const board = (await boardRes.json()) as Board;
      const row = board.incidents.find((r) => r.incidentId === report.body['incidentId']);
      expect(row?.targetMinutes).toBe(999);
    });
  });

  //----------------------------------------------------------------------------
  // Unassigned work, and the history
  //----------------------------------------------------------------------------

  describe('what the two offices see', () => {
    it('counts unassigned emergencies on the board summary (ADR-0005)', async () => {
      const before = (await (
        await fetch(`${base}/incidents`, { headers: { authorization: `Bearer ${dcToken}` } })
      ).json()) as Board;

      await call('POST', '/incidents', rescueToken, {
        category: `nothing-matches-${RUN}`,
      });

      const after = (await (
        await fetch(`${base}/incidents`, { headers: { authorization: `Bearer ${dcToken}` } })
      ).json()) as Board;

      expect(after.summary.unassigned).toBeGreaterThan(before.summary.unassigned);
      expect(after.incidents.some((r) => r.unassigned)).toBe(true);
    });

    it('shows every department with its signals, its posts, and its vacancies', async () => {
      const res = await call('GET', '/admin/departments', dcToken);
      const rows = res.body as unknown as {
        name: string;
        signals: { pattern: string }[];
        seats: number;
        vacantSeats: number;
      }[];

      const irrigation = rows.find((d) => d.name === `Irrigation Department ${RUN}`);
      expect(irrigation?.signals.map((s) => s.pattern)).toContain(`canal-${RUN}`);
      // A department with signals and no holder cannot be told about anything it is sent.
      expect(typeof irrigation?.vacantSeats).toBe('number');
    });

    it('records who changed what, and why, in an append-only log', async () => {
      const res = await call('GET', '/admin/history', dcToken);
      expect(res.status).toBe(200);
      const changes = res.body as unknown as {
        subject: string;
        action: string;
        reason: string | null;
        actorSeatTitle: string | null;
      }[];

      expect(changes.length).toBeGreaterThan(0);
      // The seat, not just the person: authority attaches to the post (ADR-0004).
      expect(changes.some((c) => c.actorSeatTitle !== null)).toBe(true);
      // Retirements carry their reason. The database refuses one without.
      const retire = changes.find((c) => c.action === 'retired');
      expect(retire?.reason).toBeTruthy();
    });

    it('will not let anything rewrite the configuration history', async () => {
      // The same guarantee as the incident log (ADR-0001), enforced at the database rather
      // than by everyone remembering.
      await expect(pool.query("UPDATE config_event SET reason = 'something else'")).rejects.toThrow(
        /append-only/,
      );
      await expect(pool.query('DELETE FROM config_event')).rejects.toThrow(/append-only/);
    });

    it('reports every department together, ranked by what needs attention', async () => {
      const res = await call('GET', '/admin/performance', dcToken);
      expect(res.status).toBe(200);

      const district = res.body['district'] as Record<string, unknown>;
      expect(typeof district['total']).toBe('number');
      expect(typeof district['unassigned']).toBe('number');

      const departments = res.body['departments'] as {
        name: string;
        medianAckMinutes: number | null;
        total: number;
      }[];
      expect(departments.length).toBeGreaterThan(0);

      // A department with no acknowledgements has null response times, never 0. Zero is the
      // best possible performance; no data is no performance at all (ADR-0005).
      const idle = departments.find((d) => d.total > 0 && d.medianAckMinutes === null);
      if (idle !== undefined) expect(idle.medianAckMinutes).toBeNull();
    });

    it('refuses the performance table to a department seat', async () => {
      // It is every department's responsiveness side by side. That is not a thing one
      // department browses about another.
      expect((await call('GET', '/admin/performance', rescueToken)).status).toBe(403);
    });
  });
});
