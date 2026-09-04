/**
 * Process entry point.
 *
 * Startup order matters: migrate and bootstrap *before* binding the port, so
 * the instance never accepts traffic it cannot serve. On a rolling deploy that
 * is the difference between a clean handover and a window of 500s.
 */

import { buildApp } from './app.js';
import { buildServer } from './api/server.js';
import { config } from './config.js';
import { createLogger } from './infra/logger.js';

const log = createLogger('main');

async function start(): Promise<void> {
  const app = await buildApp();
  await app.bootstrap();

  const server = await buildServer({ app });

  if (config.ingest.enabled) {
    app.scheduler.start();
  } else {
    log.warn('ingestion disabled (INGEST_ENABLED=0)');
  }

  await server.listen({ port: config.port, host: config.host });
  log.info('listening', {
    url: `http://${config.host}:${config.port}`,
    driver: app.sql.driver,
    clock: app.marketClock.name,
  });

  /*
   * Graceful shutdown.
   *
   * Stop accepting connections, let in-flight requests finish, then stop the
   * scheduler and close the pool. Without this, a deploy can kill a process
   * mid-transaction and leave leased ingest jobs stranded until their lease
   * expires.
   */
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { signal });

    // Hard deadline: if a request hangs, exit anyway rather than letting the
    // platform SIGKILL us at an arbitrary point.
    const timer = setTimeout(() => {
      log.error('shutdown timed out; exiting');
      process.exit(1);
    }, 10_000);
    timer.unref();

    try {
      await server.close();
      await app.shutdown();
      log.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      log.error('shutdown failed', { err: err instanceof Error ? err.message : String(err) });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // An unhandled rejection leaves the process in an unknown state. Log it
  // loudly rather than letting Node's default terminate us silently.
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection', {
      err: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
    });
  });
}

start().catch((err: unknown) => {
  log.error('failed to start', {
    err: err instanceof Error ? (err.stack ?? err.message) : String(err),
  });
  process.exit(1);
});
