/**
 * The database seam.
 *
 * One SQL dialect - Postgres - with two drivers behind a single interface:
 *
 *  - **PGlite** (Postgres compiled to WASM) for local development and tests.
 *    Real Postgres semantics with no install step, so `npm run dev` works on a
 *    clean machine.
 *  - **node-postgres** against a managed Postgres in production.
 *
 * The alternative - SQLite locally, Postgres in production - was rejected
 * deliberately. Two dialects means every query is tested against a database
 * that is not the one users hit, and the differences (upsert semantics,
 * GREATEST vs MAX, jsonb, `FOR UPDATE SKIP LOCKED`) are precisely where the
 * interesting bugs live.
 *
 * Transactions travel through AsyncLocalStorage rather than being threaded
 * through every call signature. That keeps the repositories readable, and it
 * means a repository method composes correctly whether it is called standalone
 * or from inside someone else's transaction.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { createLogger } from '../infra/logger.js';

const log = createLogger('sql');

export interface SqlClient {
  readonly driver: 'pglite' | 'postgres';

  /** Parameterised query. Always use `$n` placeholders - never interpolate. */
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;

  /** Single-row convenience. Returns null rather than throwing on empty. */
  one<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T | null>;

  /** Number of rows affected by a write. */
  write(sql: string, params?: readonly unknown[]): Promise<number>;

  /** Multi-statement DDL. Not parameterised. */
  exec(sql: string): Promise<void>;

  /**
   * Run `fn` in a transaction. Nesting is a no-op: an inner call joins the
   * outer transaction rather than opening a second one, so a repository method
   * that wants atomicity can ask for it without knowing its caller.
   */
  tx<T>(fn: () => Promise<T>): Promise<T>;

  close(): Promise<void>;
}

/**
 * Carries the connection bound to the innermost open transaction.
 *
 * It returns the affected-row count alongside the rows because an UPDATE or
 * DELETE without RETURNING yields no rows at all. Reporting `rows.length` for
 * those would make every "did this actually change anything" check silently
 * answer no as soon as it ran inside a transaction - which is exactly where
 * the writes that need the answer live.
 */
interface TxContext {
  run<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[],
  ): Promise<{ rows: T[]; affected: number }>;
  /**
   * Multi-statement DDL, routed through the transaction's own connection.
   *
   * This must exist. Both drivers serialise on a single connection while a
   * transaction is open, so issuing DDL against the pool or the base handle
   * from inside `tx()` deadlocks against the transaction that is waiting for
   * it - which is precisely what a transactional migration does.
   */
  exec(sql: string): Promise<void>;
}

const txStore = new AsyncLocalStorage<TxContext>();

// ─────────────────────────────────────────────────────────── helpers

/**
 * Build a placeholder list for `IN (...)`, continuing from an existing
 * parameter count.
 *
 * Returns `('$3, $4, $5')`. Postgres has no equivalent of SQLite's forgiving
 * dynamic binding, so this is needed everywhere a batch read happens.
 */
export function placeholders(count: number, startAt = 1): string {
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(`$${startAt + i}`);
  return out.join(', ');
}

/**
 * Coerce a Postgres numeric to a JS number.
 *
 * `BIGINT` and `NUMERIC` arrive as strings from node-postgres by default,
 * because they can exceed IEEE-754 range. Every value we store in one is an
 * epoch-millisecond or a count, both far inside safe-integer range, so
 * coercing at the mapping boundary is correct - and doing it here rather than
 * via a global type parser keeps the two drivers behaving identically.
 */
export function n(v: unknown): number {
  if (typeof v === 'number') return v;
  if (v === null || v === undefined) return 0;
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** As `n`, but preserves null. */
export function nOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  return n(v);
}

export function b(v: unknown): boolean {
  return v === true || v === 't' || v === 1 || v === '1';
}

/** jsonb columns come back parsed from both drivers; guard anyway. */
export function json<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return v as T;
}

// ─────────────────────────────────────────────────────────── PGlite

/**
 * Embedded Postgres. `dataDir` persists to disk; omit it for an ephemeral
 * in-memory database, which is what the test suite uses.
 */
export async function createPgliteClient(dataDir?: string): Promise<SqlClient> {
  const { PGlite } = await import('@electric-sql/pglite');

  if (dataDir) {
    // PGlite's node filesystem calls mkdirSync without `recursive`, so it
    // fails unless every parent already exists. Create the tree ourselves.
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dataDir, { recursive: true });
  }

  const db = dataDir ? new PGlite(dataDir) : new PGlite();
  await db.waitReady;

  log.info('pglite ready', { dataDir: dataDir ?? '(memory)' });

  const run = async <T>(sql: string, params: readonly unknown[]): Promise<T[]> => {
    const ctx = txStore.getStore();
    if (ctx) return (await ctx.run<T>(sql, params)).rows;
    const res = await db.query<T>(sql, params as unknown[]);
    return res.rows;
  };

  const client: SqlClient = {
    driver: 'pglite',

    query: run,

    async one<T>(sql: string, params: readonly unknown[] = []): Promise<T | null> {
      const rows = await run<T>(sql, params);
      return rows.length > 0 ? (rows[0] as T) : null;
    },

    async write(sql: string, params: readonly unknown[] = []): Promise<number> {
      const ctx = txStore.getStore();
      if (ctx) return (await ctx.run(sql, params)).affected;
      const res = await db.query(sql, params as unknown[]);
      return res.affectedRows ?? res.rows.length;
    },

    async exec(sql: string): Promise<void> {
      const ctx = txStore.getStore();
      if (ctx) {
        await ctx.exec(sql);
        return;
      }
      await db.exec(sql);
    },

    async tx<T>(fn: () => Promise<T>): Promise<T> {
      // Already inside one: join it. Postgres savepoints would let us nest for
      // real, but no call site needs partial rollback, and pretending to
      // support it would be worse than not.
      if (txStore.getStore()) return fn();

      return db.transaction(async (t) => {
        const ctx: TxContext = {
          run: async <T2>(sql: string, params: readonly unknown[]) => {
            const res = await t.query<T2>(sql, params as unknown[]);
            return { rows: res.rows, affected: res.affectedRows ?? res.rows.length };
          },
          exec: async (ddl: string) => {
            await t.exec(ddl);
          },
        };
        return txStore.run(ctx, fn);
      }) as Promise<T>;
    },

    async close(): Promise<void> {
      await db.close();
    },
  };

  return client;
}

// ─────────────────────────────────────────────────────────── node-postgres

export async function createPostgresClient(connectionString: string): Promise<SqlClient> {
  const pg = await import('pg');
  const Pool = pg.default?.Pool ?? pg.Pool;

  const pool = new Pool({
    connectionString,
    // Managed Postgres (Neon, Supabase) terminates plaintext connections.
    // `rejectUnauthorized: false` is required for Neon's pooled endpoint,
    // which presents a certificate for a different hostname.
    ssl: /localhost|127\.0\.0\.1/.test(connectionString)
      ? false
      : { rejectUnauthorized: false },
    // Free-tier Postgres has a low connection cap, and the API is I/O bound on
    // a handful of fast indexed queries - a small pool is correct here.
    max: Number(process.env.PG_POOL_MAX ?? 6),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  // A pool error with no listener crashes the process. Log and let the pool
  // replace the connection instead.
  pool.on('error', (err: Error) => log.error('pool error', { err: err.message }));

  await pool.query('SELECT 1');
  log.info('postgres ready', { max: pool.options.max });

  const run = async <T>(sql: string, params: readonly unknown[]): Promise<T[]> => {
    const ctx = txStore.getStore();
    if (ctx) return (await ctx.run<T>(sql, params)).rows;
    const res = await pool.query(sql, params as unknown[]);
    return res.rows as T[];
  };

  const client: SqlClient = {
    driver: 'postgres',

    query: run,

    async one<T>(sql: string, params: readonly unknown[] = []): Promise<T | null> {
      const rows = await run<T>(sql, params);
      return rows.length > 0 ? (rows[0] as T) : null;
    },

    async write(sql: string, params: readonly unknown[] = []): Promise<number> {
      const ctx = txStore.getStore();
      if (ctx) return (await ctx.run(sql, params)).affected;
      const res = await pool.query(sql, params as unknown[]);
      return res.rowCount ?? 0;
    },

    async exec(sql: string): Promise<void> {
      const ctx = txStore.getStore();
      if (ctx) {
        await ctx.exec(sql);
        return;
      }
      await pool.query(sql);
    },

    async tx<T>(fn: () => Promise<T>): Promise<T> {
      if (txStore.getStore()) return fn();

      const conn = await pool.connect();
      try {
        await conn.query('BEGIN');
        const ctx: TxContext = {
          run: async <T2>(sql: string, params: readonly unknown[]) => {
            const res = await conn.query(sql, params as unknown[]);
            return { rows: res.rows as T2[], affected: res.rowCount ?? 0 };
          },
          // No parameters, so this uses the simple query protocol and can
          // carry several statements in one round trip.
          exec: async (ddl: string) => {
            await conn.query(ddl);
          },
        };
        const result = await txStore.run(ctx, fn);
        await conn.query('COMMIT');
        return result;
      } catch (err) {
        // Rolling back can itself fail if the connection died mid-transaction.
        // Swallowing that is right: the original error is the useful one, and
        // releasing the (broken) connection is what actually matters.
        await conn.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        conn.release();
      }
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };

  return client;
}

/**
 * Pick a driver from the environment: managed Postgres when DATABASE_URL is
 * set, embedded otherwise. This is the only place that decision is made.
 */
export async function createSqlClient(opts: {
  databaseUrl?: string;
  dataDir?: string;
}): Promise<SqlClient> {
  if (opts.databaseUrl && opts.databaseUrl.trim() !== '') {
    return createPostgresClient(opts.databaseUrl.trim());
  }
  return createPgliteClient(opts.dataDir);
}

/** True when the caller is already inside a transaction. For assertions. */
export function inTransaction(): boolean {
  return txStore.getStore() !== undefined;
}
