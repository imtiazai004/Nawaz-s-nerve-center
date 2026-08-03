/**
 * The nightly backup — M0-53.
 *
 * P-08 held this up for weeks: the backup was built and verified and nothing scheduled it.
 * These tests are about the ways a schedule silently stops happening, which is the failure
 * that matters — a backup nobody notices has stopped is worse than no backup, because the
 * district spends a year believing it is covered.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPool, migrate, type Pool } from '../../db/pool.js';
import { createNightly, BACKUP_HOUR, type Nightly } from '../nightly.js';
import type { OffsiteStore } from '../../ops/offsite.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const PASSPHRASE = 'a-passphrase-long-enough-to-be-accepted';

/**
 * Where `pg_dump` lives.
 *
 * The local cluster is portable and deliberately not on PATH (see `scripts/dev-db.ps1`), so
 * the binaries are found by configuration rather than by luck — the same way a deployment
 * does it, and the same fallback `ops/__tests__/backup.test.ts` uses.
 */
const pgBin =
  process.env['PG_BIN'] ??
  (process.env['LOCALAPPDATA'] === undefined
    ? undefined
    : join(process.env['LOCALAPPDATA'], 'dnc-postgres', 'pgsql', 'bin'));

function fakeStore(): OffsiteStore & { puts: Map<string, Buffer> } {
  const puts = new Map<string, Buffer>();
  return {
    puts,
    name: 'fake',
    configured: true,
    why: null,
    put: async (key, bytes) => {
      puts.set(key, bytes);
    },
    list: async () => [...puts.entries()].map(([key, b]) => ({ key, bytes: b.length })),
  };
}

describe.skipIf(dbUrl === undefined)('the nightly backup (integration)', () => {
  let pool: Pool;
  let directory: string;

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);
    directory = await mkdtemp(join(tmpdir(), 'dnc-nightly-'));
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  function nightly(at: Date, store: OffsiteStore, over: { hour?: number } = {}): Nightly {
    return createNightly({
      pool,
      backup: {
        directory,
        // The database the pool is on, not whatever `DATABASE_URL` happens to say. In this
        // repository those differ — the pool is on `dnc_test` and `DATABASE_URL` points at
        // `dnc_dev` — and without this the job dumps one and verifies against the other.
        // `runBackup`'s event-count check caught exactly that, which is the check earning
        // its keep rather than a reason to leave the ambiguity in place.
        connectionString: dbUrl!,
        ...(pgBin === undefined ? {} : { pgBin }),
      },
      store,
      env: { BACKUP_PASSPHRASE: PASSPHRASE },
      now: () => at,
      ...(over.hour === undefined ? {} : { hour: over.hour }),
    });
  }

  /** Clear today's successes so a test can assert on "none taken yet". */
  async function forgetToday(): Promise<void> {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    await pool.query(
      `UPDATE backup_run SET finished_at = finished_at - interval '2 days'
        WHERE finished_at >= $1`,
      [start.toISOString()],
    );
  }

  it('does nothing before the hour it is set for', async () => {
    const at = new Date();
    at.setHours(BACKUP_HOUR - 1, 0, 0, 0);

    const outcome = await nightly(at, fakeStore()).tick();
    expect(outcome.ran).toBe(false);
    expect(outcome.reason).toContain('before');
  });

  /**
   * The reason this is a poll and not a timer.
   *
   * A district server gets rebooted, loses power, and is occasionally a laptop somebody
   * closed. A timer set for eight hours away is a timer that never fires, and nobody notices
   * a backup that did not happen.
   */
  it('still takes tonight’s backup on a server that was off at 02:00', async () => {
    await forgetToday();

    const at = new Date();
    at.setHours(6, 30, 0, 0);

    const outcome = await nightly(at, fakeStore()).tick();
    expect(outcome.ran).toBe(true);
    expect(outcome.backupOk).toBe(true);
  }, 120_000);

  it('does not take a second one the same day', async () => {
    const at = new Date();
    at.setHours(23, 0, 0, 0);

    // The previous test already took today's.
    const outcome = await nightly(at, fakeStore()).tick();
    expect(outcome.ran).toBe(false);
    expect(outcome.reason).toContain('already taken today');
  });

  it('writes a dump and sends an encrypted copy out of the district', async () => {
    await forgetToday();
    const store = fakeStore();

    const at = new Date();
    at.setHours(3, 0, 0, 0);
    const outcome = await nightly(at, store).tick();

    expect(outcome.backupOk).toBe(true);
    expect(outcome.offsiteOk).toBe(true);

    const files = await readdir(directory);
    expect(files.some((f) => f.endsWith('.sql'))).toBe(true);

    // What left the building is encrypted, and it is not the file on disk.
    expect(store.puts.size).toBeGreaterThan(0);
    const [key] = [...store.puts.keys()];
    expect(key).toMatch(/\.sql\.enc$/);
  }, 120_000);

  /**
   * A district with no bucket still gets a local backup, and the ledger still says the copy
   * did not leave. "We did not try" must not render as "it worked" (R-06).
   */
  it('takes the local backup even when nothing can leave the building', async () => {
    await forgetToday();

    const unconfigured: OffsiteStore = {
      name: 'none',
      configured: false,
      why: 'no bucket yet (R-06)',
      put: () => Promise.reject(new Error('not configured')),
      list: () => Promise.resolve([]),
    };

    const at = new Date();
    at.setHours(3, 0, 0, 0);
    const outcome = await nightly(at, unconfigured).tick();

    expect(outcome.backupOk).toBe(true);
    expect(outcome.offsiteOk).toBe(false);
    expect(outcome.offsiteSkipped).toContain('R-06');
  }, 120_000);

  it('takes one on demand, whatever the hour', async () => {
    // The console's "back up now" button. It ignores the schedule on purpose: an
    // administrator pressing it has a reason, usually just before something risky.
    const at = new Date();
    at.setHours(11, 0, 0, 0);

    const outcome = await nightly(at, fakeStore()).runNow();
    expect(outcome.ran).toBe(true);
    expect(outcome.reason).toBe('asked for');
  }, 120_000);

  it('refuses to start a second run while one is in flight', async () => {
    // Two `pg_dump`s competing for the same disk produce two dumps of the same night and
    // make the slower one slower still.
    const at = new Date();
    at.setHours(3, 0, 0, 0);
    const job = nightly(at, fakeStore());

    const [first, second] = await Promise.all([job.runNow(), job.runNow()]);
    const ran = [first, second].filter((o) => o.ran);
    const refused = [first, second].filter((o) => !o.ran);

    expect(ran).toHaveLength(1);
    expect(refused[0]?.reason).toContain('already running');
  }, 120_000);
});
