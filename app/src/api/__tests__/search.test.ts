/**
 * Full-history search — capability group 9.
 *
 * The reason this exists is the first test below: **an incident older than the board's window
 * was reachable only by already knowing its id.** Everything else here guards the ways a
 * search can go wrong that a passing "it finds things" test would not notice — a department
 * finding a neighbour's emergency, and an empty result that does not say what it looked at.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createPool, migrate, type Pool } from '../../db/pool.js';
import { append } from '../../db/eventStore.js';
import { seedDepartment } from '../../testing/seed.js';
import { search, windowFor, MAX_SEARCH_DAYS } from '../search.js';
import type { Seat } from '../../domain/authority.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const migrationsDir = join(process.cwd(), 'db', 'migrations');

describe.skipIf(dbUrl === undefined)('searching the record', () => {
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
    rescue = await seedDepartment(pool, `Rescue Search ${randomUUID().slice(0, 6)}`);
    police = await seedDepartment(pool, `Police Search ${randomUUID().slice(0, 6)}`);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  /**
   * An incident that **happened** a given number of days ago, routed to one department.
   *
   * `recordedAt` is required by the type and ignored by `append` — the server assigns it and a
   * client may not, deliberately (a device with a wrong clock must not be able to misreport
   * when we learned of something). So every incident built here has `recorded_at` of *now* and
   * `occurred_at` in the past, which is precisely the offline-delivery shape ADR-0002 is
   * about, and precisely what makes these tests meaningful: if search filtered on arrival,
   * every one of them would match every window and prove nothing.
   */
  async function oldIncident(
    daysAgo: number,
    departmentId: string,
    words: string,
  ): Promise<string> {
    const incidentId = randomUUID();
    const at = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
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
        payload: {
          reportId: randomUUID(),
          category: 'rta',
          severity: 'unknown',
          description: words,
        },
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
        payload: { departmentIds: [departmentId], ruleId: 'search-test', reason: 'search test' },
      },
    ]);

    return incidentId;
  }

  describe('reaching past the board', () => {
    /**
     * The whole reason for this endpoint.
     *
     * `buildBoard` looks at the last seven days. Before search, an emergency from March could
     * be turned into a post-incident report by somebody who had written its id down, and by
     * nobody else — a record with no way to look anything up in it.
     */
    it('finds an incident far older than the board would ever show', async () => {
      const id = await oldIncident(200, rescue, 'tanker overturned near the bypass');

      const result = await search(pool, seatIn(null, 'district'), {
        text: 'tanker overturned',
        from: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
      });

      expect(result.incidents.map((r) => r.incidentId)).toContain(id);
    });

    /**
     * The distinction that makes every other test in this file mean something.
     *
     * `append` assigns `recorded_at` server-side and ignores whatever a client says, so an
     * incident seeded here *happened* 200 days ago and *arrived* a moment ago — the exact
     * shape of a report captured on a handset with no signal and delivered when the network
     * returned (ADR-0002).
     *
     * If search filtered on arrival, this incident would match a window covering only today,
     * and the district's worst weeks — the ones where devices were offline longest — would be
     * exactly the weeks that searched emptiest.
     */
    it('files an offline report under when it happened, not when it arrived', async () => {
      const id = await oldIncident(200, rescue, 'flood-marker-' + randomUUID());
      const words = (await search(pool, seatIn(null, 'district'), { text: 'flood-marker-' }))
        .searched.text;

      expect(words).toBe('flood-marker-');

      // A window covering only the last week must NOT contain it: it arrived seconds ago, but
      // it happened in the spring.
      const recent = await search(pool, seatIn(null, 'district'), {
        text: 'flood-marker-',
        from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      });
      expect(recent.incidents.map((r) => r.incidentId)).not.toContain(id);

      // A window covering when it actually happened must.
      const historical = await search(pool, seatIn(null, 'district'), {
        text: 'flood-marker-',
        from: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
      });
      expect(historical.incidents.map((r) => r.incidentId)).toContain(id);
    });

    it('matches the reporter’s own words, case-insensitively', async () => {
      const id = await oldIncident(120, rescue, 'Collapsed ROOF at the grain market');

      const result = await search(pool, seatIn(null, 'district'), {
        text: 'collapsed roof',
        from: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
      });

      expect(result.incidents.map((r) => r.incidentId)).toContain(id);
    });
  });

  describe('scoping is the board’s scoping (INV-05)', () => {
    /**
     * A search is a read, and a read the caller has no authority for returns nothing —
     * not a hidden row, not a count, nothing that reveals the emergency exists.
     */
    it('never returns another department’s incident, however specific the search', async () => {
      const theirs = await oldIncident(30, police, 'unique-marker-' + randomUUID());
      const marker = (await search(pool, seatIn(police, 'department'), { text: 'unique-marker-' }))
        .incidents;

      // The owning department can find it, so the text really does match.
      expect(marker.map((r) => r.incidentId)).toContain(theirs);

      const outsider = await search(pool, seatIn(rescue, 'department'), {
        text: 'unique-marker-',
      });

      expect(outsider.incidents.map((r) => r.incidentId)).not.toContain(theirs);
    });

    it('shows the two offices everything, as the board does', async () => {
      const a = await oldIncident(40, rescue, 'district-wide-marker');
      const b = await oldIncident(40, police, 'district-wide-marker');

      const result = await search(pool, seatIn(null, 'district'), { text: 'district-wide-marker' });
      const found = result.incidents.map((r) => r.incidentId);

      expect(found).toContain(a);
      expect(found).toContain(b);
    });
  });

  describe('saying what it actually looked at', () => {
    /**
     * ADR-0005, applied to a query: an absence must never be rendered as a fact.
     *
     * "No results" and "no results in the fortnight you happened to search" are different
     * statements, and only the response can tell them apart. A screen that cannot name the
     * window invites the first reading when the truth is the second.
     */
    it('echoes the resolved window even when nothing matched', async () => {
      const result = await search(pool, seatIn(null, 'district'), {
        text: 'nothing-will-ever-match-' + randomUUID(),
      });

      expect(result.incidents).toHaveLength(0);
      expect(result.searched.from).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(result.searched.to).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(result.truncated).toBe(false);
    });

    it('reports truncation as its own fact, not as a full page', async () => {
      // "Exactly N results" and "at least N results" are different answers, and only one of
      // them means somebody should narrow the search.
      const result = await search(pool, seatIn(null, 'district'), { limit: 1 });

      if (result.truncated) expect(result.incidents.length).toBeLessThanOrEqual(1);
      expect(typeof result.truncated).toBe('boolean');
    });
  });

  describe('the window', () => {
    const now = new Date('2026-08-04T00:00:00.000Z');

    it('defaults to a period that covers ordinary "what happened recently" questions', () => {
      const w = windowFor({}, now);
      const days = (Date.parse(w.to) - Date.parse(w.from)) / 86_400_000;

      expect(days).toBeGreaterThanOrEqual(30);
    });

    it('clamps an over-wide request instead of refusing it', () => {
      // Somebody asking for ten years wants everything there is. An error teaches them to
      // stop using search rather than to pick a better date.
      const w = windowFor({ from: '2000-01-01T00:00:00.000Z' }, now);
      const days = (Date.parse(w.to) - Date.parse(w.from)) / 86_400_000;

      expect(days).toBeLessThanOrEqual(MAX_SEARCH_DAYS);
      expect(days).toBeGreaterThan(MAX_SEARCH_DAYS - 2);
    });

    it('ignores an unparseable date rather than searching from the epoch', () => {
      const w = windowFor({ from: 'last tuesday' }, now);

      expect(Date.parse(w.from)).toBeGreaterThan(Date.parse('2026-01-01T00:00:00.000Z'));
    });
  });
});
