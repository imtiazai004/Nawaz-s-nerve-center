/**
 * "How did we do in July" — capability group 9.
 *
 * The two properties that matter are not the arithmetic — `performance.test.ts` covers that,
 * and this deliberately reuses the same calculation rather than growing a second one.
 *
 * **A summary must be scoped before it is counted.** A department summarising its own month
 * must be built from its own incidents, not from the district's totals with a filter applied
 * afterwards: the second leaks through any aggregate somebody forgot to filter (INV-05).
 *
 * **A summary must never quietly under-count.** A board showing fewer rows is visibly a list;
 * a total that is short is a number somebody writes into a report and defends in a meeting.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createPool, migrate, type Pool } from '../../db/pool.js';
import { append } from '../../db/eventStore.js';
import { seedDepartment } from '../../testing/seed.js';
import { districtSummaryFor } from '../summary.js';
import type { Seat } from '../../domain/authority.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const migrationsDir = join(process.cwd(), 'db', 'migrations');

describe.skipIf(dbUrl === undefined)('a summary for a chosen period', () => {
  let pool: Pool;
  let rescue: string;
  let police: string;

  const seatIn = (departmentId: string | null, tier: 'department' | 'district'): Seat => ({
    seatId: randomUUID(),
    departmentId,
    tier,
  });

  beforeAll(async () => {
    pool = createPool(dbUrl!);
    await migrate(pool, migrationsDir);
    rescue = await seedDepartment(pool, `Rescue Summary ${randomUUID().slice(0, 6)}`);
    police = await seedDepartment(pool, `Police Summary ${randomUUID().slice(0, 6)}`);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  /** An incident that happened `daysAgo`, routed to one department. */
  async function incidentOn(daysAgo: number, departmentId: string): Promise<string> {
    const incidentId = randomUUID();
    const at = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
    const now = new Date().toISOString();

    await append(pool, [
      {
        eventId: randomUUID(),
        incidentId,
        type: 'reported',
        occurredAt: at,
        recordedAt: now,
        actorPersonId: null,
        actorSeatId: null,
        sourceChannel: 'web',
        clientSeq: 1,
        payload: { reportId: randomUUID(), category: 'rta', severity: 'high' },
      },
      {
        eventId: randomUUID(),
        incidentId,
        type: 'routed',
        occurredAt: at,
        recordedAt: now,
        actorPersonId: null,
        actorSeatId: null,
        sourceChannel: 'web',
        clientSeq: 2,
        payload: { departmentIds: [departmentId], ruleId: 'summary-test' },
      },
    ]);

    return incidentId;
  }

  const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();

  /**
   * This department's own total, not the district's.
   *
   * **The local test database is shared and never cleaned**, so it holds whatever every other
   * suite has left behind — an assertion on a district total would be measuring the rest of
   * the test run. Each department here is created fresh in `beforeAll`, so its row contains
   * only what these tests put in it. A first version of this file asserted district totals
   * were zero and found 199 incidents from elsewhere; the numbers were right and the
   * assertion was measuring the wrong thing.
   */
  function totalFor(
    summary: Awaited<ReturnType<typeof districtSummaryFor>>,
    departmentId: string,
  ): number {
    return summary.performance.departments.find((d) => d.departmentId === departmentId)?.total ?? 0;
  }

  describe('the period is the period', () => {
    it('counts what happened inside the window and not outside it', async () => {
      await incidentOn(120, rescue);

      const inside = await districtSummaryFor(pool, seatIn(null, 'district'), {
        from: daysAgo(150),
        to: daysAgo(90),
      });
      const outside = await districtSummaryFor(pool, seatIn(null, 'district'), {
        from: daysAgo(30),
        to: daysAgo(1),
      });

      expect(totalFor(inside, rescue)).toBeGreaterThan(0);
      expect(totalFor(outside, rescue)).toBe(0);

      // The window is echoed so a screen can say what it counted, for the same reason search
      // echoes it: an empty summary and an empty window read identically otherwise (ADR-0005).
      expect(inside.period.from.slice(0, 10)).toBe(daysAgo(150).slice(0, 10));
      expect(inside.period.to.slice(0, 10)).toBe(daysAgo(90).slice(0, 10));
    });

    /**
     * A summary of July means emergencies that *happened* in July.
     *
     * Every incident these tests seed arrived seconds ago — `append` assigns `recorded_at`
     * server-side and ignores the client — so if the window were on arrival, the 200-day-old
     * incident below would land in every period, including "the last week". That is the
     * ADR-0002 failure: the district's worst nights would move into whichever month the
     * network came back.
     */
    it('files an offline report in the month it happened, not the month it arrived', async () => {
      await incidentOn(200, police);

      const recent = await districtSummaryFor(pool, seatIn(null, 'district'), {
        from: daysAgo(7),
      });
      const historical = await districtSummaryFor(pool, seatIn(null, 'district'), {
        from: daysAgo(365),
        to: daysAgo(180),
      });

      expect(totalFor(historical, police)).toBeGreaterThan(0);
      // It arrived seconds ago. It must not be in a summary of the last week.
      expect(totalFor(recent, police)).toBe(0);
    });
  });

  describe('scoped before it is counted (INV-05)', () => {
    it('gives a department its own totals and none of a neighbour’s', async () => {
      await incidentOn(10, rescue);
      await incidentOn(10, police);
      await incidentOn(10, police);

      const theirs = await districtSummaryFor(pool, seatIn(rescue, 'department'), {
        from: daysAgo(20),
      });
      const district = await districtSummaryFor(pool, seatIn(null, 'district'), {
        from: daysAgo(20),
      });

      expect(theirs.scope).toBe('department');
      expect(district.scope).toBe('district');

      // Rescue's own summary counts Rescue's incidents and none of Police's — asserted on the
      // rows rather than on a district total, which the shared test database would pollute.
      expect(totalFor(theirs, rescue)).toBeGreaterThan(0);
      expect(totalFor(theirs, police)).toBe(0);

      // The district sees both.
      expect(totalFor(district, rescue)).toBeGreaterThan(0);
      expect(totalFor(district, police)).toBeGreaterThan(0);
    });

    it('never lets a department read a neighbour’s row out of the per-department table', async () => {
      await incidentOn(5, police);

      const theirs = await districtSummaryFor(pool, seatIn(rescue, 'department'), {
        from: daysAgo(20),
      });

      const policeRow = theirs.performance.departments.find((d) => d.departmentId === police);

      // The row may exist (every department is listed) but it must be empty of the
      // neighbour's work — nothing was counted into it, because nothing was visible.
      expect(policeRow?.total ?? 0).toBe(0);
    });
  });

  describe('what it says about its own completeness', () => {
    it('reports truncation as a field rather than leaving a short total to speak for itself', async () => {
      const summary = await districtSummaryFor(pool, seatIn(null, 'district'), {
        from: daysAgo(365),
      });

      // A total nobody can tell is short is the failure this field exists to prevent.
      expect(typeof summary.truncated).toBe('boolean');
      expect(summary.truncated).toBe(false);
    });
  });
});
