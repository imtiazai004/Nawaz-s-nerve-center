/**
 * What is wrong with the district's configuration, right now — W-01.
 *
 * Not a health check. `/health` answers *is the server up*; this answers *would an emergency
 * reported in the next ten minutes actually reach a human*, which is a different question
 * with a much worse failure mode. Every finding here is a gap that is silent today and
 * expensive at 02:00.
 *
 * **It reports. It never fixes.** Everything it finds is either a decision for the district
 * (a post nobody has filled) or a fact somebody has to look at (two officers on one handset).
 * A sweep that quietly corrected things would destroy the evidence that anything was wrong,
 * which is the opposite of what this project does with gaps (ADR-0005).
 *
 * Findings carry a severity, and the scale is deliberately about **consequence**, not
 * tidiness:
 *
 *   `blocking` — an emergency will be lost or will reach nobody. Fix today.
 *   `serious`  — the system will work but somebody will be surprised. Fix this week.
 *   `note`     — real, and possibly fine. Somebody should have seen it.
 *
 * Read the queries as the specification: each one is a sentence about how the district can
 * be misconfigured, and the comment above it says what happens when it is.
 */

import type { Pool } from '../db/pool.js';

export type FindingSeverity = 'blocking' | 'serious' | 'note';

export interface Finding {
  readonly code: string;
  readonly severity: FindingSeverity;
  /** One sentence, in the district's terms, not the schema's. */
  readonly what: string;
  /** What it costs, stated concretely. Never "this may cause issues". */
  readonly consequence: string;
  readonly count: number;
  /** Up to ten, so the report is actionable without being a data dump. */
  readonly examples: readonly string[];
}

export interface IntegrityReport {
  readonly asOf: string;
  readonly findings: readonly Finding[];
  readonly summary: {
    readonly blocking: number;
    readonly serious: number;
    readonly notes: number;
    readonly departments: number;
    readonly posts: number;
    readonly people: number;
  };
}

const SEVERITY_ORDER: readonly FindingSeverity[] = ['blocking', 'serious', 'note'];

interface Check {
  readonly code: string;
  readonly severity: FindingSeverity;
  readonly what: string;
  readonly consequence: string;
  readonly sql: string;
}

/**
 * Every check, as data.
 *
 * A list rather than a function per check, for the same reason the authority rules are a
 * table (ADR-0003): somebody who is not a programmer should be able to read down this and
 * say "that one is wrong for Bannu". Each query returns rows of `label`.
 */
const CHECKS: readonly Check[] = [
  {
    code: 'department-with-no-post',
    severity: 'blocking',
    what: 'Departments with no post at all',
    consequence:
      'Nothing can ever be sent here. An emergency routed to one is recorded as a failed ' +
      'notification and nobody is told.',
    sql: `SELECT d.name AS label
            FROM department d
           WHERE d.retired_at IS NULL
             AND NOT EXISTS (
                   SELECT 1 FROM seat s
                    WHERE s.department_id = d.department_id AND s.retired_at IS NULL
                 )
           ORDER BY d.name`,
  },
  {
    code: 'signals-but-unreachable',
    severity: 'blocking',
    what: 'Departments that receive emergencies but have nobody reachable',
    consequence:
      'The routing signals will send emergencies here and every alert will fail. This is the ' +
      'worst combination in the list: the district believes the department is covered.',
    sql: `SELECT d.name AS label
            FROM department d
           WHERE d.retired_at IS NULL
             AND EXISTS (
                   SELECT 1 FROM routing_signal r
                    WHERE r.department_id = d.department_id AND r.retired_at IS NULL
                 )
             AND NOT EXISTS (
                   SELECT 1
                     FROM seat s
                     JOIN duty_assignment da ON da.seat_id = s.seat_id AND da.to_at IS NULL
                     JOIN person p ON p.person_id = da.person_id
                    WHERE s.department_id = d.department_id
                      AND s.retired_at IS NULL
                      AND p.removed_at IS NULL
                      AND NOT p.placeholder
                 )
           ORDER BY d.name`,
  },
  {
    code: 'no-administration',
    severity: 'blocking',
    what: 'The district has no administrative office',
    consequence:
      'Nobody can configure routing, set deadlines, create departments or assign an ' +
      'unassigned emergency. ADR-0010 says two offices hold the district; this reports when ' +
      'there are none.',
    sql: `SELECT 'no department is marked as administration' AS label
           WHERE NOT EXISTS (
                   SELECT 1 FROM department
                    WHERE is_administration AND retired_at IS NULL
                 )`,
  },
  {
    code: 'vacant-post',
    severity: 'serious',
    what: 'Posts nobody currently holds',
    consequence:
      'An alert addressed to one is recorded as failed rather than delivered. Correct ' +
      'behaviour, and still a person who has not been told.',
    sql: `SELECT d.name || ' — ' || s.title AS label
            FROM seat s
            LEFT JOIN department d ON d.department_id = s.department_id
           WHERE s.retired_at IS NULL
             AND NOT EXISTS (
                   SELECT 1 FROM duty_assignment da
                    WHERE da.seat_id = s.seat_id AND da.to_at IS NULL
                 )
           ORDER BY 1`,
  },
  {
    code: 'placeholder-number',
    severity: 'serious',
    what: 'Posts held by somebody with a stand-in number',
    consequence:
      'The post looks filled and cannot be reached. Nothing is ever dialled at these ' +
      'numbers — see R-01.',
    sql: `SELECT coalesce(d.name, 'no department') || ' — ' || s.title || ' (' || p.full_name || ')' AS label
            FROM person p
            JOIN duty_assignment da ON da.person_id = p.person_id AND da.to_at IS NULL
            JOIN seat s ON s.seat_id = da.seat_id
            LEFT JOIN department d ON d.department_id = s.department_id
           WHERE p.placeholder AND p.removed_at IS NULL
           ORDER BY 1`,
  },
  {
    code: 'department-with-no-signal',
    severity: 'serious',
    what: 'Departments no routing signal points at',
    consequence:
      'Nothing reaches them automatically. Every relevant emergency lands as unassigned on ' +
      'the two administrative dashboards for a human to route by hand.',
    sql: `SELECT d.name AS label
            FROM department d
           WHERE d.retired_at IS NULL
             AND NOT d.is_administration
             AND NOT EXISTS (
                   SELECT 1 FROM routing_signal r
                    WHERE r.department_id = d.department_id AND r.retired_at IS NULL
                 )
           ORDER BY d.name`,
  },
  {
    code: 'unregistered-department',
    severity: 'serious',
    what: 'Departments created by the migration backfill, never named by anybody',
    consequence:
      'These were seats pointing at a department id that did not exist when migration 0005 ' +
      'added the foreign key. They are real gaps in the registry wearing a generated name.',
    sql: `SELECT name AS label FROM department WHERE code LIKE 'unregistered-%' ORDER BY name`,
  },
  {
    code: 'account-without-post',
    severity: 'serious',
    what: 'People who can sign in but hold no post',
    consequence:
      'They can authenticate and can do nothing — correct (ADR-0004), and confusing enough ' +
      'to be reported as a broken system. Either give them a post or disable the account.',
    sql: `SELECT p.full_name AS label
            FROM person p
           WHERE p.password_hash IS NOT NULL
             AND p.disabled_at IS NULL
             AND p.removed_at IS NULL
             AND NOT EXISTS (
                   SELECT 1 FROM duty_assignment da
                    WHERE da.person_id = p.person_id AND da.to_at IS NULL
                 )
           ORDER BY p.full_name`,
  },
  {
    code: 'shared-handset',
    severity: 'note',
    what: 'One number listed against more than one person',
    consequence:
      'Ordinary here — an office handset covering two posts (Q-19). It is also exactly the ' +
      'shape of a mistyped digit, and nothing in the data tells the two apart.',
    sql: `SELECT string_agg(full_name, ' / ' ORDER BY full_name) AS label
            FROM person
           WHERE removed_at IS NULL
           GROUP BY phone
          HAVING count(*) > 1
           ORDER BY 1`,
  },
  {
    code: 'open-unassigned',
    severity: 'serious',
    what: 'Open emergencies no department holds',
    consequence:
      'Routing matched nothing and nobody has picked them up. They sit on both ' +
      'administrative dashboards until a human assigns one.',
    sql: `SELECT e.incident_id::text AS label
            FROM incident_event e
           WHERE e.type = 'routed'
             AND e.payload->'departmentIds' = '[]'::jsonb
             AND NOT EXISTS (
                   SELECT 1 FROM incident_event later
                    WHERE later.incident_id = e.incident_id
                      AND later.type IN ('routed', 'reassigned', 'closed', 'resolved')
                      AND later.seq > e.seq
                 )
           ORDER BY e.recorded_at DESC`,
  },
  {
    code: 'tier-disagrees-with-office',
    severity: 'blocking',
    what: 'Posts whose tier disagrees with the office they belong to',
    consequence:
      'A district-tier post in an ordinary department can read every incident in Bannu. ' +
      'Migration 0010 derives tier by trigger, so this should be impossible — if it fires, ' +
      'something bypassed the trigger and the read model is wider than anybody intended.',
    sql: `SELECT coalesce(d.name, 'no department') || ' — ' || s.title || ' (' || s.tier || ')' AS label
            FROM seat s
            LEFT JOIN department d ON d.department_id = s.department_id
           WHERE s.tier <> CASE
                             WHEN s.department_id IS NULL THEN 'district'
                             WHEN d.is_administration THEN 'district'
                             ELSE 'department'
                           END
           ORDER BY 1`,
  },
];

/**
 * Run every check.
 *
 * Sequential rather than parallel, deliberately: this is a report somebody runs while
 * looking at it, not a request path, and a burst of eleven scans is a rude thing to do to a
 * single-node district server that is also handling emergencies (ADR-0007).
 */
export async function sweep(pool: Pool, options: { now?: string } = {}): Promise<IntegrityReport> {
  const findings: Finding[] = [];

  for (const check of CHECKS) {
    const { rows } = await pool.query<{ label: string | null }>(check.sql);
    if (rows.length === 0) continue;

    findings.push({
      code: check.code,
      severity: check.severity,
      what: check.what,
      consequence: check.consequence,
      count: rows.length,
      examples: rows.slice(0, 10).map((r) => r.label ?? '(unnamed)'),
    });
  }

  findings.sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      b.count - a.count ||
      a.code.localeCompare(b.code),
  );

  const totals = await pool.query<{ departments: string; posts: string; people: string }>(
    `SELECT (SELECT count(*) FROM department WHERE retired_at IS NULL) AS departments,
            (SELECT count(*) FROM seat WHERE retired_at IS NULL)       AS posts,
            (SELECT count(*) FROM person WHERE removed_at IS NULL)     AS people`,
  );

  return {
    asOf: options.now ?? new Date().toISOString(),
    findings,
    summary: {
      blocking: findings.filter((f) => f.severity === 'blocking').length,
      serious: findings.filter((f) => f.severity === 'serious').length,
      notes: findings.filter((f) => f.severity === 'note').length,
      departments: Number(totals.rows[0]?.departments ?? 0),
      posts: Number(totals.rows[0]?.posts ?? 0),
      people: Number(totals.rows[0]?.people ?? 0),
    },
  };
}

/** The report as text, for a terminal or a runbook. */
export function formatReport(report: IntegrityReport): string {
  const lines: string[] = [];
  const s = report.summary;

  lines.push(`District configuration sweep — ${report.asOf}`);
  lines.push(
    `${String(s.departments)} departments · ${String(s.posts)} posts · ${String(s.people)} people`,
  );
  lines.push(
    `${String(s.blocking)} blocking · ${String(s.serious)} serious · ${String(s.notes)} notes`,
  );
  lines.push('');

  if (report.findings.length === 0) {
    lines.push('Nothing to report. Every department has a post, a signal and somebody to call.');
    return lines.join('\n');
  }

  for (const f of report.findings) {
    lines.push(`[${f.severity.toUpperCase()}] ${f.what} — ${String(f.count)}`);
    lines.push(`  ${f.consequence}`);
    for (const example of f.examples) lines.push(`    · ${example}`);
    if (f.count > f.examples.length) {
      lines.push(`    … and ${String(f.count - f.examples.length)} more`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
