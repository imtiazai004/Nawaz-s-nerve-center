import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Load app/.env if present. Node 22+ can do this without a dependency, so we do.
 *
 * Absent .env is not an error — the domain tests need no database at all, and that is
 * deliberate (ADR-0002, ADR-0007). Only the db suite requires TEST_DATABASE_URL, and it
 * says so loudly rather than passing vacuously.
 */
const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, '..', '..', '.env');

if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

/**
 * On a build server, a missing database is a failure — never a quiet skip.
 *
 * Locally, `describe.skipIf(dbUrl === undefined)` is a kindness: you can run the domain
 * tests on a laptop with no cluster started. In CI that same kindness is a trap. A
 * misconfigured secret would drop every integration suite, and the run would go **green
 * with roughly fifty tests instead of three hundred** — a build that reports success while
 * proving almost nothing, which is the exact failure mode this project keeps finding and
 * refusing (see the notes on faked databases in CLAUDE.md).
 *
 * So: if `CI` is set, the database is mandatory and its absence stops the run here.
 */
if (process.env['CI'] !== undefined && process.env['TEST_DATABASE_URL'] === undefined) {
  throw new Error(
    'TEST_DATABASE_URL is not set and CI is. Refusing to run: the integration suites would ' +
      'skip and the build would pass having tested almost nothing. Set TEST_DATABASE_URL, ' +
      'or unset CI if you genuinely want the domain-only run.',
  );
}
