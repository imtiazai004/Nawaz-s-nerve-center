/**
 * The dashboard, against a real database — M4.
 *
 * Two things are pinned here.
 *
 * **It is scoped to whoever asked.** The two administrative offices see the district; a
 * department sees its own work. Getting this wrong in the generous direction is a read leak
 * of exactly the kind migration 0010 already produced once, when every loaded post defaulted
 * to `district` and every department could read every other department's emergencies.
 *
 * **It carries nothing private.** The same response appears on a large screen in an office,
 * where it is read by whoever is in the room. That boundary is one careless join away from
 * breaking, in a file somebody edits for an unrelated reason, so it is asserted against a
 * live response rather than trusted.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { createPool, migrate, type Pool } from '../../db/pool.js';
import { buildDashboard, handleDashboard, viewerFor } from '../dashboard.js';
import { wallSafetyViolations } from '../../domain/wall.js';
import type { Identity } from '../../auth/sessions.js';

const dbUrl = process.env['TEST_DATABASE_URL'];

function request(method = 'GET'): IncomingMessage {
  return { method, headers: {} } as unknown as IncomingMessage;
}

function officer(overrides: Partial<Identity> = {}): Identity {
  return {
    personId: randomUUID(),
    fullName: 'An Officer',
    seatId: null,
    seatTitle: null,
    departmentId: null,
    departmentName: null,
    tier: 'district',
    canBreakGlass: false,
    isAdministration: false,
    ...overrides,
  } as unknown as Identity;
}

const DISTRICT = { scope: 'District', departmentId: null, isAdministration: true };

describe.skipIf(dbUrl === undefined)('the dashboard', () => {
  let pool: Pool;
  let departmentId: string;
  let departmentName: string;

  beforeAll(async () => {
    pool = createPool(dbUrl!);
    await migrate(pool, join(process.cwd(), 'db', 'migrations'));

    const created = await pool.query<{ department_id: string; name: string }>(
      `INSERT INTO department (code, name) VALUES ($1, $2) RETURNING department_id, name`,
      [`dash-${randomUUID().slice(0, 8)}`, `Dashboard Test ${randomUUID().slice(0, 6)}`],
    );
    departmentId = created.rows[0]!.department_id;
    departmentName = created.rows[0]!.name;
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  const asDepartment = (): { scope: string; departmentId: string; isAdministration: boolean } => ({
    scope: departmentName,
    departmentId,
    isAdministration: false,
  });

  describe('whose dashboard it is', () => {
    it('gives the two offices the district', () => {
      const viewer = viewerFor(officer({ isAdministration: true, departmentId: 'x' }));

      expect(viewer.departmentId).toBeNull();
      expect(viewer.scope).toBe('District');
    });

    it('gives a department its own name and its own scope', () => {
      const viewer = viewerFor(officer({ departmentId: 'dept-1', departmentName: 'Rescue 1122' }));

      expect(viewer.departmentId).toBe('dept-1');
      expect(viewer.scope).toBe('Rescue 1122');
    });

    it('gives a seat with no department the district, rather than nothing', () => {
      // A control-room post holds no department. Showing it an empty dashboard would be
      // technically consistent and useless — the district *is* its work.
      const viewer = viewerFor(officer({ departmentId: null }));

      expect(viewer.departmentId).toBeNull();
      expect(viewer.scope).toBe('District');
    });
  });

  describe('what it contains', () => {
    it('says whose it is, and when it was folded', async () => {
      const feed = await buildDashboard(pool, DISTRICT);

      expect(feed.scope).toBe('District');
      expect(new Date(feed.asOf).getTime()).not.toBeNaN();
    });

    it('answers with counts, never with rows', async () => {
      const feed = await buildDashboard(pool, DISTRICT);

      expect(typeof feed.district.openIncidents).toBe('number');
      // An id is a thing somebody can look up. Rows belong on the board, where the authority
      // model can scope them per incident.
      expect(JSON.stringify(feed)).not.toMatch(/incidentId|reportId/);
    });

    it('carries an age for every reported panel', async () => {
      const feed = await buildDashboard(pool, DISTRICT);

      for (const row of [...feed.utilities, ...feed.presence]) {
        if (row.freshness === 'never') {
          expect(row.asOf).toBeNull();
        } else {
          expect(row.asOf).not.toBeNull();
          expect(typeof row.ageMinutes).toBe('number');
        }
      }
    });

    it('gives the category the words the report form uses', async () => {
      const feed = await buildDashboard(pool, DISTRICT);

      for (const row of feed.categories) expect(row.label).not.toBe('rta');
    });
  });

  describe('what a department is and is not shown', () => {
    it('withholds the system condition from a department', async () => {
      // Not secrecy — these are the two offices' to fix. Three red rows a department can do
      // nothing about teaches it to ignore red rows.
      const feed = await buildDashboard(pool, asDepartment());

      expect(feed.condition).toEqual([]);
    });

    it('gives the two offices the system condition, named in full', async () => {
      const feed = await buildDashboard(pool, DISTRICT);

      // Two, not three. "Alerts leave the building" went with the provider ladder — the
      // software no longer sends anything, so there is nothing about sending that can be
      // quietly broken (ADR-0012 superseded).
      expect(feed.condition.map((c) => c.what)).toEqual(['Record backed up', 'Second machine']);

      for (const item of feed.condition) expect(item.detail.length).toBeGreaterThan(3);
    });

    it("counts none of another department's emergencies", async () => {
      const mine = await buildDashboard(pool, asDepartment());
      const district = await buildDashboard(pool, DISTRICT);

      // A brand-new department holds nothing, so every assigned emergency in the district is
      // somebody else's. Whatever it counts can only be the unassigned pile.
      expect(mine.departments).toEqual([]);
      expect(mine.district.openIncidents).toBeLessThanOrEqual(district.district.openIncidents);
    });

    it('still shows a department the weather, the utilities and the numbers', async () => {
      // These belong to everybody. A department planning around a power cut needs to know
      // about the power cut.
      const feed = await buildDashboard(pool, asDepartment());

      expect(feed.utilities.length).toBeGreaterThan(0);
      expect(feed.weather).toHaveProperty('ageMinutes');
      expect(Array.isArray(feed.contacts)).toBe(true);
    });
  });

  describe('what it must never say', () => {
    it('passes its own safety check for both kinds of viewer', async () => {
      expect(wallSafetyViolations(await buildDashboard(pool, DISTRICT))).toEqual([]);
      expect(wallSafetyViolations(await buildDashboard(pool, asDepartment()))).toEqual([]);
    });

    it('carries no personal name, number or coordinate', async () => {
      const text = JSON.stringify(await buildDashboard(pool, DISTRICT));

      // Presence is by **seat** — "AAC Domel", not whoever currently holds it. A seat title
      // is a public post; a person's name on an office screen is not the district's to put
      // there (ADR-0004 is why this shape was available at all).
      expect(text).not.toMatch(/"fullName"/);
      expect(text).not.toMatch(/"personId"/);
      expect(text).not.toMatch(/"phone"/);
    });

    it('catches a leak wherever it is nested', () => {
      expect(
        wallSafetyViolations({ panels: [{ rows: [{ t: 'call 0333-1234567' }] }] }),
      ).toHaveLength(1);
    });
  });

  describe('who may read it', () => {
    it('serves a signed-in officer', async () => {
      const reply = await handleDashboard(pool, request(), officer({ isAdministration: true }));

      expect(reply.status).toBe(200);
      expect((reply.body as { scope: string }).scope).toBe('District');
    });

    it('refuses anything but a read', async () => {
      // The dashboard is a view. Nothing is entered on it — utilities and presence are
      // reported through /status, emergencies through the report screen.
      const reply = await handleDashboard(pool, request('POST'), officer());

      expect(reply.status).toBe(405);
    });
  });
});
