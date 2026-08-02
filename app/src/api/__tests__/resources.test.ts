/**
 * What a department can send, and sending it — M1-02 and M1-03, over HTTP.
 *
 * Two things this file is really about.
 *
 * **Commitment is derived, not stored.** There is no status column, so every test that
 * checks whether an ambulance is free is checking a fold over the event log. The tests that
 * matter are the ones where those could disagree: dispatch, then release, then close.
 *
 * **The system does not get a veto.** A unit already committed elsewhere can still be sent,
 * with a warning — a district with one ambulance and two road accidents has to be able to
 * move it. Only facts about the world (retired, in the workshop) refuse.
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

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const RUN = randomUUID().slice(0, 8);

describe.skipIf(dbUrl === undefined)('resources and dispatch (integration)', () => {
  let pool: Pool;
  let server: Server;
  let base: string;

  let dcToken: string;
  let rescueToken: string;
  let rescueDept: string;
  let policeToken: string;
  let policeDept: string;

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    server = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const dcDept = await seedDepartment(pool, `DC Office (fleet ${RUN})`);
    await pool.query('UPDATE department SET is_administration = true WHERE department_id = $1', [
      dcDept,
    ]);
    dcToken = (
      await seedActor(pool, { title: `DC (fleet ${RUN})`, departmentId: dcDept, tier: 'district' })
    ).token;

    rescueDept = await seedDepartment(pool, `Rescue (fleet ${RUN})`);
    rescueToken = (
      await seedActor(pool, { title: `Rescue Duty (fleet ${RUN})`, departmentId: rescueDept })
    ).token;

    policeDept = await seedDepartment(pool, `Police (fleet ${RUN})`);
    policeToken = (
      await seedActor(pool, { title: `Police Duty (fleet ${RUN})`, departmentId: policeDept })
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
    const raw = await res.text();
    return {
      status: res.status,
      body: raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>),
    };
  }

  async function unit(
    token: string,
    dept: string,
    name: string,
    kind = 'vehicle',
  ): Promise<string> {
    const res = await call('POST', `/fleet/${dept}/units`, token, { kind, name });
    expect(res.status).toBe(201);
    return res.body['resourceId'] as string;
  }

  /** An open incident held by Rescue. */
  async function incident(category = `fleet-${RUN}`): Promise<string> {
    const created = await call('POST', '/incidents', dcToken, { category, severity: 'critical' });
    const id = created.body['incidentId'] as string;
    await call('POST', `/incidents/${id}/route`, dcToken, {
      departmentIds: [rescueDept],
      reason: 'test fixture',
    });
    return id;
  }

  //----------------------------------------------------------------------------
  // The registry
  //----------------------------------------------------------------------------

  describe('a department keeps its own units', () => {
    it('adds a vehicle and reports it as available', async () => {
      await unit(rescueToken, rescueDept, `Ambulance ${RUN}`);

      const fleet = await call('GET', '/fleet', rescueToken);
      expect(fleet.status).toBe(200);
      expect(fleet.body['departmentId']).toBe(rescueDept);

      const units = fleet.body['units'] as { resource: { name: string }; blockedBy: string[] }[];
      const found = units.find((u) => u.resource.name === `Ambulance ${RUN}`);
      expect(found?.blockedBy).toEqual([]);
    });

    it('refuses two live units with the same name', async () => {
      // Two "Ambulance 3"s make a radio call ambiguous, which is the exact failure the name
      // exists to prevent.
      await unit(rescueToken, rescueDept, `Duplicate ${RUN}`);
      const second = await call('POST', `/fleet/${rescueDept}/units`, rescueToken, {
        kind: 'vehicle',
        name: `duplicate ${RUN}`,
      });
      expect(second.status).toBe(409);
    });

    it('refuses one department adding a unit to another', async () => {
      const res = await call('POST', `/fleet/${rescueDept}/units`, policeToken, {
        kind: 'vehicle',
        name: `Police Trying It On ${RUN}`,
      });
      expect(res.status).toBe(403);
    });

    it('lets the administration add a unit to any department', async () => {
      const res = await call('POST', `/fleet/${policeDept}/units`, dcToken, {
        kind: 'vehicle',
        name: `Added By DC ${RUN}`,
      });
      expect(res.status).toBe(201);
    });

    it('will not take a unit off the run without a reason', async () => {
      const id = await unit(rescueToken, rescueDept, `Reasonless ${RUN}`);
      expect((await call('POST', `/fleet/units/${id}/off-run`, rescueToken, {})).status).toBe(400);
    });

    it('takes a unit off the run and repeats the reason back', async () => {
      const id = await unit(rescueToken, rescueDept, `Workshop ${RUN}`);
      const off = await call('POST', `/fleet/units/${id}/off-run`, rescueToken, {
        reason: 'gearbox stripped, at the workshop',
      });
      expect(off.status).toBe(200);

      const fleet = await call('GET', '/fleet', rescueToken);
      const units = fleet.body['units'] as {
        resource: { name: string; outOfServiceReason: string | null };
        blockedBy: string[];
      }[];
      const found = units.find((u) => u.resource.name === `Workshop ${RUN}`);
      expect(found?.blockedBy).toContain('out_of_service');
      // The reason the district gave, not a generic "unavailable". Whoever reads this is
      // deciding what to send instead.
      expect(found?.resource.outOfServiceReason).toContain('gearbox');
    });
  });

  describe('teams have people; vehicles do not', () => {
    it('puts somebody on a team', async () => {
      const team = await unit(rescueToken, rescueDept, `Team ${RUN}`, 'team');
      const person = await call('POST', `/roster/${rescueDept}/people`, rescueToken, {
        fullName: `Crew Member ${RUN}`,
        phone: `0300-crew-${RUN}`,
      });

      const added = await call('POST', `/fleet/units/${team}/crew`, rescueToken, {
        personId: person.body['personId'],
      });
      expect(added.status).toBe(200);

      const fleet = await call('GET', '/fleet', rescueToken);
      const units = fleet.body['units'] as {
        resource: { name: string; members: { fullName: string }[] };
      }[];
      const found = units.find((u) => u.resource.name === `Team ${RUN}`);
      expect(found?.resource.members.map((m) => m.fullName)).toContain(`Crew Member ${RUN}`);
    });

    it('refuses to put somebody on a vehicle', async () => {
      // A vehicle's crew is a team assigned alongside it. Two ways to express one thing
      // would leave no way to query either.
      const vehicle = await unit(rescueToken, rescueDept, `Not A Team ${RUN}`);
      const person = await call('POST', `/roster/${rescueDept}/people`, rescueToken, {
        fullName: `Not Crew ${RUN}`,
        phone: `0300-notcrew-${RUN}`,
      });
      const res = await call('POST', `/fleet/units/${vehicle}/crew`, rescueToken, {
        personId: person.body['personId'],
      });
      expect(res.status).toBe(409);
      expect(String(res.body['error'])).toContain('only a team');
    });
  });

  //----------------------------------------------------------------------------
  // Dispatch
  //----------------------------------------------------------------------------

  describe('dispatch', () => {
    it('sends a unit and records it on the incident', async () => {
      const id = await incident();
      const ambulance = await unit(rescueToken, rescueDept, `Dispatchable ${RUN}`);

      const sent = await call('POST', `/incidents/${id}/dispatch`, rescueToken, {
        resourceIds: [ambulance],
      });
      expect(sent.status).toBe(200);
      expect(sent.body['warnings']).toEqual([]);

      // On the incident log, not in a resource table — so "which ambulance went to the
      // bazaar fire" stays answerable a year later.
      const state = foldIncident(id, await loadIncident(pool, id));
      expect(state.assignedResourceIds).toContain(ambulance);
    });

    it('shows the unit as committed on the fleet, without any status being written', async () => {
      const id = await incident();
      const ambulance = await unit(rescueToken, rescueDept, `Committed ${RUN}`);
      await call('POST', `/incidents/${id}/dispatch`, rescueToken, { resourceIds: [ambulance] });

      const fleet = await call('GET', '/fleet', rescueToken);
      const units = fleet.body['units'] as {
        resource: { resourceId: string };
        blockedBy: string[];
        commitments: { incidentId: string }[];
      }[];
      const found = units.find((u) => u.resource.resourceId === ambulance);

      expect(found?.blockedBy).toContain('committed');
      expect(found?.commitments.map((c) => c.incidentId)).toEqual([id]);

      // And the database really has no status column to have written.
      const columns = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'resource'`,
      );
      expect(columns.rows.map((c) => c.column_name)).not.toContain('status');
    });

    /**
     * The rule the whole module turns on.
     *
     * A district with one ambulance and two road accidents must be able to move it. Refusing
     * would be software overruling the only person who can see both scenes. What it owes
     * them is that the consequence is said out loud.
     */
    it('allows a committed unit to be sent again, and warns', async () => {
      const first = await incident();
      const second = await incident();
      const ambulance = await unit(rescueToken, rescueDept, `Only One ${RUN}`);

      await call('POST', `/incidents/${first}/dispatch`, rescueToken, { resourceIds: [ambulance] });
      const again = await call('POST', `/incidents/${second}/dispatch`, rescueToken, {
        resourceIds: [ambulance],
      });

      expect(again.status).toBe(200);
      const warnings = again.body['warnings'] as string[];
      expect(warnings.join(' ')).toContain('already committed');
      // And it says what it does *not* do: this screen never stands a unit down from an
      // emergency it is not looking at.
      expect(warnings.join(' ')).toContain('committed to both');
    });

    it('refuses a unit that is in the workshop', async () => {
      const id = await incident();
      const broken = await unit(rescueToken, rescueDept, `Broken ${RUN}`);
      await call('POST', `/fleet/units/${broken}/off-run`, rescueToken, { reason: 'no driver' });

      const sent = await call('POST', `/incidents/${id}/dispatch`, rescueToken, {
        resourceIds: [broken],
      });
      expect(sent.status).toBe(409);
      expect(String(sent.body['error'])).toContain('no driver');
    });

    it('refuses to send another department’s unit', async () => {
      const id = await incident();
      const theirs = await unit(policeToken, policeDept, `Police Van ${RUN}`);

      const sent = await call('POST', `/incidents/${id}/dispatch`, rescueToken, {
        resourceIds: [theirs],
      });
      expect(sent.status).toBe(403);
      expect(String(sent.body['error'])).toContain('another department');
    });

    /**
     * All or nothing.
     *
     * A partial dispatch would leave the operator believing three units were sent when two
     * went — and the one that did not go is precisely the one they would have replaced.
     */
    it('sends nothing at all if any named unit cannot go', async () => {
      const id = await incident();
      const good = await unit(rescueToken, rescueDept, `Fine ${RUN}`);
      const broken = await unit(rescueToken, rescueDept, `Also Broken ${RUN}`);
      await call('POST', `/fleet/units/${broken}/off-run`, rescueToken, { reason: 'tyres' });

      const sent = await call('POST', `/incidents/${id}/dispatch`, rescueToken, {
        resourceIds: [good, broken],
      });
      expect(sent.status).toBe(409);

      const state = foldIncident(id, await loadIncident(pool, id));
      expect(state.assignedResourceIds).toEqual([]);
    });

    it('refuses to send anything to a closed incident', async () => {
      const id = await incident();
      const ambulance = await unit(rescueToken, rescueDept, `Too Late ${RUN}`);
      await call('POST', `/incidents/${id}/acknowledge`, rescueToken, {});
      await call('POST', `/incidents/${id}/resolve`, rescueToken, { outcome: 'stood down' });
      await call('POST', `/incidents/${id}/close`, rescueToken, { notes: 'done' });

      const sent = await call('POST', `/incidents/${id}/dispatch`, rescueToken, {
        resourceIds: [ambulance],
      });
      expect(sent.status).toBe(409);
    });
  });

  //----------------------------------------------------------------------------
  // Standing down
  //----------------------------------------------------------------------------

  describe('standing a unit down', () => {
    it('frees the unit, and says who and why', async () => {
      const id = await incident();
      const ambulance = await unit(rescueToken, rescueDept, `Returns ${RUN}`);
      await call('POST', `/incidents/${id}/dispatch`, rescueToken, { resourceIds: [ambulance] });

      const stood = await call('POST', `/incidents/${id}/release`, rescueToken, {
        resourceIds: [ambulance],
        reason: 'needed at the bypass',
      });
      expect(stood.status).toBe(200);

      const state = foldIncident(id, await loadIncident(pool, id));
      expect(state.assignedResourceIds).not.toContain(ambulance);

      const fleet = await call('GET', '/fleet', rescueToken);
      const units = fleet.body['units'] as {
        resource: { resourceId: string };
        blockedBy: string[];
      }[];
      expect(units.find((u) => u.resource.resourceId === ambulance)?.blockedBy).toEqual([]);
    });

    it('will not stand a unit down without a reason', async () => {
      const id = await incident();
      const ambulance = await unit(rescueToken, rescueDept, `No Reason ${RUN}`);
      await call('POST', `/incidents/${id}/dispatch`, rescueToken, { resourceIds: [ambulance] });

      const stood = await call('POST', `/incidents/${id}/release`, rescueToken, {
        resourceIds: [ambulance],
      });
      expect(stood.status).toBe(400);
    });

    it('refuses to stand down a unit that was never on this incident', async () => {
      // Usually means the operator is looking at the wrong incident, which is worth saying
      // rather than accepting quietly.
      const id = await incident();
      const elsewhere = await unit(rescueToken, rescueDept, `Never Sent ${RUN}`);

      const stood = await call('POST', `/incidents/${id}/release`, rescueToken, {
        resourceIds: [elsewhere],
        reason: 'confusion',
      });
      expect(stood.status).toBe(409);
    });

    it('keeps the whole history readable: sent, then stood down', async () => {
      const id = await incident();
      const ambulance = await unit(rescueToken, rescueDept, `History ${RUN}`);
      await call('POST', `/incidents/${id}/dispatch`, rescueToken, { resourceIds: [ambulance] });
      await call('POST', `/incidents/${id}/release`, rescueToken, {
        resourceIds: [ambulance],
        reason: 'no longer required',
      });

      // The live set is empty and the record still says everything that happened. That is
      // the difference between a projection and a log (ADR-0001).
      const events = await loadIncident(pool, id);
      const types = events.map((e) => e.type);
      expect(types).toContain('assigned');
      expect(types).toContain('released');
    });

    it('closing an incident frees its units without anybody standing them down', async () => {
      // Commitment is derived from open incidents, so closure releases everything by
      // definition. A stored status would have needed a cleanup step somebody could forget.
      const id = await incident();
      const ambulance = await unit(rescueToken, rescueDept, `Freed By Closure ${RUN}`);
      await call('POST', `/incidents/${id}/dispatch`, rescueToken, { resourceIds: [ambulance] });

      await call('POST', `/incidents/${id}/acknowledge`, rescueToken, {});
      await call('POST', `/incidents/${id}/resolve`, rescueToken, { outcome: 'handled' });

      const fleet = await call('GET', '/fleet', rescueToken);
      const units = fleet.body['units'] as {
        resource: { resourceId: string };
        blockedBy: string[];
      }[];
      expect(units.find((u) => u.resource.resourceId === ambulance)?.blockedBy).toEqual([]);
    });
  });

  describe('what a department can field, in four numbers', () => {
    it('adds up', async () => {
      const dept = await seedDepartment(pool, `Counting ${RUN}`);
      const token = (await seedActor(pool, { title: `Counter ${RUN}`, departmentId: dept })).token;

      const free = await unit(token, dept, `Free ${RUN}`);
      const busy = await unit(token, dept, `Busy ${RUN}`);
      const broken = await unit(token, dept, `Off Run ${RUN}`);
      await call('POST', `/fleet/units/${broken}/off-run`, token, { reason: 'servicing' });

      const id = await call('POST', '/incidents', dcToken, { category: `counting-${RUN}` });
      const incidentId = id.body['incidentId'] as string;
      await call('POST', `/incidents/${incidentId}/route`, dcToken, {
        departmentIds: [dept],
        reason: 'test',
      });
      await call('POST', `/incidents/${incidentId}/dispatch`, token, { resourceIds: [busy] });

      const fleet = await call('GET', '/fleet', token);
      const summary = fleet.body['summary'] as Record<string, number>;

      expect(summary).toEqual({ total: 3, available: 1, committed: 1, outOfService: 1 });
      expect(summary['available']! + summary['committed']! + summary['outOfService']!).toBe(
        summary['total'],
      );
      expect(free).toBeTruthy();
    });
  });
});
