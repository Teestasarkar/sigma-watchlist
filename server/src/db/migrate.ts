import { MIGRATIONS, SCHEMA_VERSION } from './schema.js';
import type { SqlClient } from './sql.js';
import { n } from './sql.js';
import { createLogger } from '../infra/logger.js';

const log = createLogger('migrate');

/** Arbitrary but fixed application lock id. */
const LOCK_ID = 0x5194a;

/**
 * Bring the database up to `SCHEMA_VERSION`, one step at a time.
 *
 * Everything happens inside a single transaction, so the database ends up
 * either fully migrated or untouched - never half-way. Postgres supports
 * transactional DDL, which is what makes that possible, and is one of the
 * reasons the local driver is embedded Postgres rather than SQLite.
 *
 * A concurrent second instance starting at the same moment is handled by the
 * advisory lock: the loser waits, then reads the version, finds it current, and
 * does nothing.
 */
export async function migrate(sql: SqlClient): Promise<void> {
  await sql.tx(async () => {
    await sql.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);

    const current = await readVersion(sql);

    if (current > SCHEMA_VERSION) {
      throw new Error(
        `database schema v${current} is newer than this build (v${SCHEMA_VERSION}); refusing to downgrade`,
      );
    }
    if (current === SCHEMA_VERSION) return;

    for (const step of MIGRATIONS) {
      if (step.version <= current) continue;
      await sql.exec(step.sql);
      log.info('applied migration', { version: step.version, name: step.name });
    }

    await sql.query(
      `INSERT INTO schema_meta (key, value) VALUES ('version', $1)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      [String(SCHEMA_VERSION)],
    );

    log.info('schema migrated', { from: current, to: SCHEMA_VERSION });
  });
}

async function readVersion(sql: SqlClient): Promise<number> {
  // `to_regclass` returns null for a missing table, which lets us probe
  // without relying on catching an error inside an open transaction - in
  // Postgres a failed statement poisons the transaction until rollback.
  const probe = await sql.one<{ present: boolean }>(
    `SELECT to_regclass('public.schema_meta') IS NOT NULL AS present`,
  );
  if (!probe?.present) return 0;

  const row = await sql.one<{ value: string }>(
    `SELECT value FROM schema_meta WHERE key = 'version'`,
  );
  return row ? n(row.value) : 0;
}

/** Drop everything. Used by `npm run reset` and by the test helpers. */
export async function dropAll(sql: SqlClient): Promise<void> {
  await sql.exec(`
    DROP TABLE IF EXISTS idempotency_keys, symbol_activity, ingest_jobs,
      signal_reads, user_symbol_marks, signal_state, signals,
      watchlist_items, watchlists, instrument_stats, quotes_latest, bars,
      corporate_actions, instruments, sessions, users, schema_meta CASCADE;
  `);
}
