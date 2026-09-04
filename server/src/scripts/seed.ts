/**
 * Warm the database: seed history for every instrument in the universe and
 * run enough ingest cycles that the briefing has something in it.
 *
 * Useful for a fresh deployment, where the first visitor would otherwise
 * arrive before the scheduler has done a full pass.
 */
import { buildApp } from '../app.js';
import { ALL_ENTRIES } from '../providers/universe.js';
import { createLogger } from '../infra/logger.js';

const log = createLogger('seed');

const app = await buildApp();
await app.bootstrap();

const now = app.clock.now();
for (const entry of ALL_ENTRIES) {
  try {
    const result = await app.ingest.ensureInstrument(entry.symbol, now, {
      pollIntervalMs: app.config.ingest.warmIntervalMs,
    });
    log.info('seeded', { symbol: entry.symbol, bars: result.bars });
  } catch (err) {
    log.warn('seed failed', {
      symbol: entry.symbol,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

// A few passes so detection has consecutive observations to work from.
for (let i = 0; i < 4; i++) {
  const processed = await app.scheduler.tick(app.clock.now());
  log.info('tick', { pass: i + 1, processed });
}

log.info('seed complete', { signals: await app.signals.countAll() });
await app.shutdown();
process.exit(0);
