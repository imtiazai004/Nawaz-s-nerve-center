/**
 * Process entry point.
 *
 * One process runs the API, serves the client, and drives the escalation loop — ADR-0007's
 * single deployable. Splitting them would mean two things to start, two to monitor and two
 * to restart at 02:00, in exchange for nothing this district needs.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSyncServer } from './api/server.js';
import { createPool, migrate } from './db/pool.js';
import { createScheduler } from './jobs/scheduler.js';

const here = dirname(fileURLToPath(import.meta.url));

function log(level: 'info' | 'warn' | 'error', message: string, fields: object = {}): void {
  // Structured from the start. Whoever is debugging this at 02:00 will be reading a log
  // file, not attaching a debugger.
  // eslint-disable-next-line no-console
  console[level === 'error' ? 'error' : 'log'](
    JSON.stringify({ ts: new Date().toISOString(), level, message, ...fields }),
  );
}

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
    onError: (err) => log('error', 'escalation pass failed', { error: String(err) }),
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
