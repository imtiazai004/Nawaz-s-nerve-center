import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from 'pg';

/**
 * Say so, once per run, when the local test database has drifted out of the shape of a district.
 *
 * The test database is never cleaned. Every run leaves its departments, seats and events
 * behind, and after a few weeks the count is in the thousands where Bannu has 79. That is not
 * a cosmetic problem: the administration console renders every department, so at 1900 of them
 * two browser tests spend their entire 30-second budget painting a screen no real district
 * will ever produce, and `pg_dump` starts failing the backup round trip. Four tests go red
 * for a reason that has nothing to do with the code under test — which is the worst kind of
 * failure, because it teaches you to distrust the suite.
 *
 * This has now cost an evening twice. So the run says it out loud, in the one place nobody
 * can miss, and names the command that fixes it.
 *
 * It is a **warning, not a failure**. A drifted database still runs every assertion; it just
 * runs them slowly. Stopping the run would be a worse trade than printing four lines.
 *
 * CI never sees this — the workflow starts a fresh PostgreSQL container every run — so the
 * query costs a build server nothing and a laptop one round trip.
 */

/** Bannu has 79 departments. Past this, the data is the suite's own residue, not a district. */
const DRIFTED = 200;

export async function setup(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = join(here, '..', '..', '.env');

  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }

  const url = process.env['TEST_DATABASE_URL'];

  if (url === undefined || process.env['CI'] !== undefined) {
    return;
  }

  const client = new Client(url);

  try {
    await client.connect();
    const result = await client.query<{ n: string }>('SELECT count(*)::text AS n FROM department');
    const departments = Number(result.rows[0]?.n ?? '0');

    if (departments > DRIFTED) {
      process.stderr.write(
        `\n  The test database holds ${String(departments)} departments. Bannu has 79.\n` +
          '  This is leftover data from previous runs, not a district. It will make the\n' +
          '  administration console tests slow, and can time them out.\n\n' +
          '      npm run test:reset\n\n',
      );
    }
  } catch {
    // No cluster, no schema, no permission — every one of those is the suites' own problem to
    // report, in their own words. A hygiene check must never be the thing that fails a run.
  } finally {
    await client.end().catch(() => undefined);
  }
}
