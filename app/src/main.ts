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

  const server = createSyncServer({
    pool,
    // `assertAuthUsable` refuses to start outside development with this value, so a
    // production deployment cannot silently run without real authentication.
    authMode: 'stub',
    nodeEnv,
    webRoot: join(here, '..', 'web', 'dist'),
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

  await new Promise<void>((resolve) => server.listen(port, resolve));
  scheduler.start();
  log('info', 'started', { port, nodeEnv });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('info', 'shutting down', { signal });

    void (async () => {
      // Stop escalating first, then stop accepting requests, then release the pool.
      // Reversing this could leave a pass writing to a closed pool mid-escalation.
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
