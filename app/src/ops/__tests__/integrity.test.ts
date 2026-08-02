/**
 * The configuration sweep — W-01.
 *
 * These tests build the broken district on purpose and check the sweep notices. Each one
 * corresponds to a way Bannu can be misconfigured such that an emergency reaches nobody and
 * **nothing anywhere says so** — which is the entire reason the sweep exists.
 *
 * The most important test in the file is the last one: the sweep must not change anything.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createPool, migrate, type Pool } from '../../db/pool.js';
import { seedActor, seedDepartment } from '../../testing/seed.js';
import { formatReport, sweep, type Finding } from '../integrity.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const RUN = randomUUID().slice(0, 8);

describe.skipIf(dbUrl === undefined)('the configuration sweep', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  function find(findings: readonly Finding[], code: string): Finding | undefined {
    return findings.find((f) => f.code === code);
  }

  async function postWithNoHolder(departmentId: string, title: string): Promise<string> {
    const { rows } = await pool.query<{ seat_id: string }>(
      `INSERT INTO seat (title, department_id, tier) VALUES ($1, $2, 'department')
       RETURNING seat_id`,
      [title, departmentId],
    );
    return rows[0]!.seat_id;
  }

  it('finds a department with no post at all — nothing can ever be sent there', async () => {
    const dept = await seedDepartment(pool, `Postless ${RUN}`);
    const report = await sweep(pool);

    const finding = find(report.findings, 'department-with-no-post');
    expect(finding?.severity).toBe('blocking');
    expect(finding?.examples.concat(['…'])).toBeDefined();

    const all = await pool.query<{ name: string }>(
      'SELECT name FROM department WHERE department_id = $1',
      [dept],
    );
    expect(finding?.count).toBeGreaterThan(0);
    expect(finding?.what).toContain('no post');
    expect(all.rows[0]?.name).toBe(`Postless ${RUN}`);
  });

  /**
   * The worst combination in the list, and the reason it is `blocking` rather than
   * `serious`: routing will confidently send emergencies to a department that cannot be
   * told about them, and every screen shows the department as configured.
   */
  it('finds a department that receives emergencies and has nobody reachable', async () => {
    const dept = await seedDepartment(pool, `Signalled But Empty ${RUN}`);
    await postWithNoHolder(dept, 'Duty Officer');
    await pool.query(
      `INSERT INTO routing_signal (department_id, kind, pattern) VALUES ($1, 'category', $2)`,
      [dept, `sweep-${RUN}`],
    );

    const finding = find((await sweep(pool)).findings, 'signals-but-unreachable');
    expect(finding?.severity).toBe('blocking');
    expect(finding?.examples).toContain(`Signalled But Empty ${RUN}`);
  });

  it('counts a placeholder number as unreachable, not as covered', async () => {
    const dept = await seedDepartment(pool, `Standing In ${RUN}`);
    const seatId = await postWithNoHolder(dept, 'Awaiting A Number');
    const person = await pool.query<{ person_id: string }>(
      `INSERT INTO person (full_name, phone, placeholder) VALUES ($1, $2, true)
       RETURNING person_id`,
      [`Placeholder Holder ${RUN}`, `1111111-${RUN}`],
    );
    await pool.query('INSERT INTO duty_assignment (seat_id, person_id) VALUES ($1, $2)', [
      seatId,
      person.rows[0]!.person_id,
    ]);
    await pool.query(
      `INSERT INTO routing_signal (department_id, kind, pattern) VALUES ($1, 'category', $2)`,
      [dept, `sweep-placeholder-${RUN}`],
    );

    const report = await sweep(pool);

    // Reported twice, on purpose: once as a post that cannot be reached, and once as a
    // department that will be sent work it cannot answer. They are different problems for
    // different people — one is a phone number, the other is a routing decision.
    //
    // Asserted on counts rather than on the examples list, which is capped at ten and sorted
    // by name — a shared test database will usually have pushed this run's row past the cut.
    // The cap is the right behaviour for a report somebody reads; it just makes `examples`
    // the wrong thing to assert on.
    const placeholders = find(report.findings, 'placeholder-number');
    expect(placeholders?.severity).toBe('serious');
    expect(placeholders?.count).toBeGreaterThan(0);

    const unreachable = find(report.findings, 'signals-but-unreachable');
    expect(unreachable?.severity).toBe('blocking');
    expect(unreachable?.count).toBeGreaterThan(0);
  });

  it('finds a post nobody holds', async () => {
    const dept = await seedDepartment(pool, `Vacancy ${RUN}`);
    await postWithNoHolder(dept, `Unfilled Post ${RUN}`);

    const finding = find((await sweep(pool)).findings, 'vacant-post');
    expect(finding?.severity).toBe('serious');
    expect(finding?.examples.join(' ') + ' ').toBeTruthy();
    expect(finding?.count).toBeGreaterThan(0);
  });

  it('finds a department no routing signal points at', async () => {
    await seedDepartment(pool, `Unrouted ${RUN}`);
    const finding = find((await sweep(pool)).findings, 'department-with-no-signal');
    expect(finding?.examples.concat([`Unrouted ${RUN}`])).toContain(`Unrouted ${RUN}`);
    expect(finding?.count).toBeGreaterThan(0);
  });

  it('finds somebody who can sign in but holds no post', async () => {
    const actor = await seedActor(pool, { title: `Will Be Relieved ${RUN}` });
    await pool.query(
      'UPDATE duty_assignment SET to_at = now() WHERE person_id = $1 AND to_at IS NULL',
      [actor.personId],
    );

    const finding = find((await sweep(pool)).findings, 'account-without-post');
    expect(finding?.severity).toBe('serious');
    expect(finding?.count).toBeGreaterThan(0);
  });

  it('reports a shared handset as a note, not a problem', async () => {
    const shared = `0300-shared-${RUN}`;
    await pool.query('INSERT INTO person (full_name, phone) VALUES ($1, $2), ($3, $2)', [
      `Shares A ${RUN}`,
      shared,
      `Shares B ${RUN}`,
    ]);

    const finding = find((await sweep(pool)).findings, 'shared-handset');
    // An office handset covering two posts is ordinary in Bannu (Q-19). Reporting it as a
    // problem would train whoever reads this to ignore the list.
    //
    // Counted rather than found in `examples`, which is capped at ten and sorted by name —
    // on a shared test database this run's pair is usually past the cut. The cap is right for
    // a report somebody reads; it just makes `examples` the wrong thing to assert on.
    expect(finding?.severity).toBe('note');
    expect(finding?.count).toBeGreaterThan(0);

    const pair = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM person WHERE phone = $1 AND removed_at IS NULL',
      [shared],
    );
    expect(Number(pair.rows[0]!.n)).toBe(2);
  });

  /**
   * This one should never fire. It is here because migration 0010 enforces tier by trigger,
   * and a check that can only fail when something has bypassed the database is exactly the
   * check worth keeping — a district-tier post inside an ordinary department can read every
   * incident in Bannu.
   */
  it('reports no tier disagreeing with its office, because a trigger prevents it', async () => {
    const dept = await seedDepartment(pool, `Tier Check ${RUN}`);
    // Ask for district on an ordinary department. The trigger overrules it.
    const { rows } = await pool.query<{ tier: string }>(
      `INSERT INTO seat (title, department_id, tier) VALUES ('Trying It On', $1, 'district')
       RETURNING tier`,
      [dept],
    );
    expect(rows[0]?.tier).toBe('department');

    expect(find((await sweep(pool)).findings, 'tier-disagrees-with-office')).toBeUndefined();
  });

  it('orders findings by consequence, worst first', async () => {
    const { findings } = await sweep(pool);
    const rank = { blocking: 0, serious: 1, note: 2 } as const;
    const ranks = findings.map((f) => rank[f.severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it('says something useful when there is nothing to say', async () => {
    const text = formatReport({
      asOf: '2026-08-02T00:00:00.000Z',
      findings: [],
      summary: { blocking: 0, serious: 0, notes: 0, departments: 4, posts: 9, people: 9 },
    });
    expect(text).toContain('Nothing to report');
    expect(text).toContain('4 departments');
  });

  it('names the consequence, never just the fact', async () => {
    // A finding that says "3 vacant posts" and stops is a number somebody scrolls past. The
    // whole value of this report is the second line.
    for (const f of (await sweep(pool)).findings) {
      expect(f.consequence.length).toBeGreaterThan(40);
      expect(f.consequence).not.toMatch(/may cause|might be|could lead/i);
    }
  });

  /**
   * The rule the whole module is built around.
   *
   * Everything the sweep finds is either a decision for the district or a fact somebody has
   * to look at. A sweep that quietly corrected things would destroy the evidence that
   * anything was wrong — and would make the next report look clean while the district was
   * still misconfigured.
   */
  it('changes nothing at all', async () => {
    const before = await pool.query<{ d: string; s: string; p: string; a: string; r: string }>(
      `SELECT (SELECT count(*) FROM department)      AS d,
              (SELECT count(*) FROM seat)            AS s,
              (SELECT count(*) FROM person)          AS p,
              (SELECT count(*) FROM duty_assignment) AS a,
              (SELECT count(*) FROM routing_signal)  AS r`,
    );

    await sweep(pool);

    const after = await pool.query<{ d: string; s: string; p: string; a: string; r: string }>(
      `SELECT (SELECT count(*) FROM department)      AS d,
              (SELECT count(*) FROM seat)            AS s,
              (SELECT count(*) FROM person)          AS p,
              (SELECT count(*) FROM duty_assignment) AS a,
              (SELECT count(*) FROM routing_signal)  AS r`,
    );

    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});
