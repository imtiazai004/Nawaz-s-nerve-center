/**
 * Process entry point.
 *
 * One process runs the API, serves the client, and drives the escalation loop — ADR-0007's
 * single deployable. Splitting them would mean two things to start, two to monitor and two
 * to restart at 02:00, in exchange for nothing this district needs.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSyncServer } from './api/server.js';
import { createPool, migrate } from './db/pool.js';
import { createScheduler } from './jobs/scheduler.js';
import { createNightly } from './jobs/nightly.js';
import { refreshWeather } from './ops/weather.js';
import { log } from './obs/log.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Load `app/.env` if it is there.
 *
 * `docs/05-stack.md` and `CLAUDE.md` both say connection strings live in `app/.env`, and
 * until now **only the test setup ever read it** — the actual process started, found no
 * `DATABASE_URL`, and exited. The documented way to configure the system did not configure
 * the system.
 *
 * Absent is not an error: a real deployment will pass real environment variables, and a
 * file that is not there simply means they came from somewhere else. Node 22 can do this
 * without a dependency, so it does.
 */
const envPath = join(here, '..', '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);

async function start(): Promise<void> {
  const nodeEnv = process.env['NODE_ENV'] ?? 'development';
  const port = Number(process.env['PORT'] ?? 3000);

  const pool = createPool();
  const applied = await migrate(pool, join(here, '..', 'db', 'migrations'));
  if (applied.length > 0) log('info', 'migrations applied', { applied });

  const backupDirectory = process.env['BACKUP_DIR'] ?? join(here, '..', 'var', 'backups');

  const server = createSyncServer({
    pool,
    // `assertAuthUsable` refuses to start outside development with this value, so a
    // production deployment cannot silently run without real authentication.
    authMode: 'stub',
    nodeEnv,
    webRoot: join(here, '..', 'web', 'dist'),
    backupDirectory,
    // Late-bound on purpose: the server is created before the job, and the console's
    // "back up now" button needs the job rather than a copy of its options.
    get nightly() {
      return nightly;
    },
  });

  const scheduler = createScheduler({
    pool,
    intervalMs: Number(process.env['ESCALATION_INTERVAL_MS'] ?? 15_000),
    onOutcome: (o) => {
      // Only worth a line when something happened. A loop that logs every quiet tick
      // trains everyone to ignore it.
      if (o.escalated > 0 || o.exhausted.length > 0 || o.noHolder.length > 0 || o.truncated) {
        log(o.truncated ? 'warn' : 'info', 'escalation pass', {
          scanned: o.scanned,
          escalated: o.escalated,
          exhausted: o.exhausted,
          noHolder: o.noHolder,
          // More open incidents than the pass can examine: either a real crisis or a
          // backlog nobody is closing. Both need saying out loud.
          truncated: o.truncated,
        });
      }
    },
    onNotify: (o) => {
      if (o.attempted > 0 || o.failed > 0 || o.truncated) {
        log(o.failed > 0 ? 'warn' : 'info', 'notification pass', {
          scanned: o.scanned,
          attempted: o.attempted,
          // A vacant post or a dead channel. Somebody has to be told that nobody was told
          // (INV-03) — this is the log half of that; the board is the half operators see.
          failed: o.failed,
          truncated: o.truncated,
        });
      }
    },
    onError: (err) => log('error', 'background pass failed', { error: String(err) }),
  });

  /**
   * The nightly backup (M0-53, ADR-0011).
   *
   * P-08 held this up for weeks: the backup was built and verified and nothing scheduled it,
   * because where the server runs decides how. ADR-0011 answered that, so it runs here — on
   * the machine in the DC office, at 02:00, with an encrypted copy going out of the district.
   *
   * Started even when there is no bucket yet. The local dump still happens and the ledger
   * still records that the off-site copy did not, which is the fact `/health` and the console
   * need in order to say the district is only half covered (R-06).
   */
  const nightly = createNightly({
    pool,
    backup: {
      directory: backupDirectory,
      // Stated rather than inherited. `runBackup` would fall back to `DATABASE_URL` anyway
      // here, and being explicit is what stops the job dumping one database and verifying
      // against another the day those two stop agreeing.
      ...(process.env['DATABASE_URL'] === undefined
        ? {}
        : { connectionString: process.env['DATABASE_URL'] }),
      ...(process.env['PG_BIN'] === undefined ? {} : { pgBin: process.env['PG_BIN'] }),
    },
    onRun: (o) => {
      if (!o.ran) return;
      log(o.backupOk === true && o.offsiteOk === true ? 'info' : 'warn', 'nightly backup', {
        reason: o.reason,
        backupOk: o.backupOk ?? false,
        offsiteOk: o.offsiteOk ?? false,
        ...(o.offsiteSkipped === undefined ? {} : { offsiteSkipped: o.offsiteSkipped }),
      });
    },
  });

  /**
   * The weather, refreshed for every screen at once (M4-04, ADR-0013).
   *
   * Fifteen minutes, and the first fetch happens at startup so a freshly installed screen has
   * something on it inside a minute rather than at the top of the next quarter hour.
   *
   * A failure is logged at `warn` and changes nothing else. Weather is the least important
   * thing on the wall and must never be able to take the process down with it — the previous
   * reading stays exactly where it was, ageing visibly, which is the honest outcome.
   */
  const weatherTimer = setInterval(
    () => {
      void refreshWeather(pool).then((r) => {
        if (!r.ok) log('warn', 'weather refresh failed', { error: r.error ?? 'unknown' });
      });
    },
    15 * 60 * 1000,
  );
  weatherTimer.unref();

  void refreshWeather(pool).then((r) => {
    if (!r.ok) log('warn', 'weather refresh failed', { error: r.error ?? 'unknown' });
  });

  await new Promise<void>((resolve) => server.listen(port, resolve));
  scheduler.start();
  nightly.start();
  log('info', 'started', { port, nodeEnv });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('info', 'shutting down', { signal });

    void (async () => {
      // Stop escalating first, then stop accepting requests, then release the pool.
      // Reversing this could leave a pass writing to a closed pool mid-escalation.
      nightly.stop();
      clearInterval(weatherTimer);
      await scheduler.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
      log('info', 'stopped');
      process.exit(0);
    })();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err: unknown) => {
  log('error', 'failed to start', { error: String(err) });
  process.exit(1);
});
