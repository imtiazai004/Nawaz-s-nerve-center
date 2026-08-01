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
