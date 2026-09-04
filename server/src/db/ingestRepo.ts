/**
 * Persistence for the ingestion queue, view activity, and request replay
 * protection.
 *
 * The queue is a table, not a set of timers. That matters twice over: it
 * survives restarts without losing schedule, and "what is due now" is one
 * indexed query rather than N in-memory timers - so the cost of the 10,000th
 * symbol is a row, not a timer.
 */

import { chunk, MAX_BIND_PARAMS } from '../infra/chunk.js';
import { n, nOrNull, placeholders, type SqlClient } from './sql.js';

export type Tier = 'hot' | 'warm' | 'cold';

export interface Job {
  symbol: string;
  tier: Tier;
  intervalMs: number;
  nextRunAt: number;
  lastRunAt: number | null;
  lastOkAt: number | null;
  lastError: string | null;
  failStreak: number;
}

type Row = Record<string, unknown>;

const mapJob = (r: Row): Job => ({
  symbol: r.symbol as string,
  tier: r.tier as Tier,
  intervalMs: n(r.interval_ms),
  nextRunAt: n(r.next_run_at),
  lastRunAt: nOrNull(r.last_run_at),
  lastOkAt: nOrNull(r.last_ok_at),
  lastError: (r.last_error as string | null) ?? null,
  failStreak: n(r.fail_streak),
});

export class IngestRepo {
  constructor(private readonly sql: SqlClient) {}

  // ───────────────────────────────────────────────────────── queue

  /** Register a symbol for polling. An existing schedule is left alone. */
  async ensureJob(symbol: string, intervalMs: number, nextRunAt: number): Promise<void> {
    await this.sql.query(
      `INSERT INTO ingest_jobs (symbol, tier, interval_ms, next_run_at)
       VALUES ($1, 'warm', $2, $3)
       ON CONFLICT (symbol) DO NOTHING`,
      [symbol, intervalMs, nextRunAt],
    );
  }

  async ensureJobs(
    symbols: readonly string[],
    intervalMs: number,
    nextRunAt: number,
  ): Promise<void> {
    if (symbols.length === 0) return;
    for (const batch of chunk(symbols, 500)) {
      const tuples = batch.map((_, i) => `($${i + 3}::text, 'warm', $1::bigint, $2::bigint)`);
      await this.sql.query(
        `INSERT INTO ingest_jobs (symbol, tier, interval_ms, next_run_at)
         VALUES ${tuples.join(', ')}
         ON CONFLICT (symbol) DO NOTHING`,
        [intervalMs, nextRunAt, ...batch],
      );
    }
  }

  /**
   * Claim up to `limit` due symbols.
   *
   * One statement does both the select and the lease: `FOR UPDATE SKIP LOCKED`
   * hands each concurrent worker a *disjoint* batch instead of all of them
   * fighting over the same head-of-queue rows, and pushing `next_run_at`
   * forward in the same statement is the lease itself. Without that lease, two
   * scheduler ticks - or two instances after a scale-up - would claim the same
   * symbol and double-fetch it.
   *
   * This is the piece that lets the ingest tier scale horizontally with no
   * coordination service.
   */
  async claimDue(now: number, limit: number, leaseMs: number): Promise<Job[]> {
    const rows = await this.sql.query<Row>(
      `WITH due AS (
         SELECT symbol FROM ingest_jobs
         WHERE next_run_at <= $1
         ORDER BY next_run_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       UPDATE ingest_jobs j
       SET next_run_at = $1 + $3, last_run_at = $1
       FROM due
       WHERE j.symbol = due.symbol
       RETURNING j.*`,
      [now, limit, leaseMs],
    );
    return rows.map(mapJob);
  }

  /** Record a successful poll and schedule the next one. */
  async completeOk(symbol: string, nextRunAt: number, now: number): Promise<void> {
    await this.sql.query(
      `UPDATE ingest_jobs
       SET next_run_at = $2, last_ok_at = $3, last_error = NULL, fail_streak = 0
       WHERE symbol = $1`,
      [symbol, nextRunAt, now],
    );
  }

  /**
   * Record a failure. The caller computes the backed-off next run time; the
   * streak is tracked here so the delay can grow and so the UI can say how
   * long a symbol has been unreachable.
   */
  async completeFail(symbol: string, nextRunAt: number, error: string): Promise<void> {
    await this.sql.query(
      `UPDATE ingest_jobs
       SET next_run_at = $2, last_error = $3, fail_streak = fail_streak + 1
       WHERE symbol = $1`,
      [symbol, nextRunAt, error.slice(0, 500)],
    );
  }

  async setTier(symbol: string, tier: Tier, intervalMs: number): Promise<void> {
    await this.sql.query(`UPDATE ingest_jobs SET tier = $2, interval_ms = $3 WHERE symbol = $1`, [
      symbol,
      tier,
      intervalMs,
    ]);
  }

  /** Apply many tier changes at once - the re-tier sweep touches everything. */
  async setTiers(
    updates: ReadonlyArray<{ symbol: string; tier: Tier; intervalMs: number }>,
  ): Promise<void> {
    if (updates.length === 0) return;
    for (const batch of chunk(updates, 400)) {
      const tuples = batch.map(
        (_, i) => `($${i * 3 + 1}::text, $${i * 3 + 2}::text, $${i * 3 + 3}::bigint)`,
      );
      const params: unknown[] = [];
      for (const u of batch) params.push(u.symbol, u.tier, u.intervalMs);
      await this.sql.query(
        `UPDATE ingest_jobs j
         SET tier = v.tier, interval_ms = v.interval_ms
         FROM (VALUES ${tuples.join(', ')}) AS v(symbol, tier, interval_ms)
         WHERE j.symbol = v.symbol`,
        params,
      );
    }
  }

  /** Bring a symbol's next poll forward - used when a user opens it. */
  async expedite(symbol: string, at: number): Promise<void> {
    await this.sql.query(
      `UPDATE ingest_jobs SET next_run_at = LEAST(next_run_at, $2) WHERE symbol = $1`,
      [symbol, at],
    );
  }

  async getJob(symbol: string): Promise<Job | null> {
    const r = await this.sql.one<Row>(`SELECT * FROM ingest_jobs WHERE symbol = $1`, [symbol]);
    return r ? mapJob(r) : null;
  }

  async listJobs(): Promise<Job[]> {
    const rows = await this.sql.query<Row>(`SELECT * FROM ingest_jobs ORDER BY next_run_at`);
    return rows.map(mapJob);
  }

  async deleteJobs(symbols: readonly string[]): Promise<number> {
    if (symbols.length === 0) return 0;
    let removed = 0;
    for (const batch of chunk(symbols, MAX_BIND_PARAMS - 2)) {
      const rows = await this.sql.query<Row>(
        `DELETE FROM ingest_jobs WHERE symbol IN (${placeholders(batch.length)}) RETURNING symbol`,
        batch as string[],
      );
      removed += rows.length;
    }
    return removed;
  }

  // ───────────────────────────────────────────────────────── fan-in

  /**
   * Every symbol at least one person watches, plus any benchmark.
   *
   * This query is what makes the system scale: the poller works from the
   * *union* of all watchlists, so a symbol held by ten thousand users costs
   * exactly one upstream request per cycle - the same as a symbol held by one.
   */
  async watchedSymbols(): Promise<string[]> {
    const rows = await this.sql.query<Row>(
      `SELECT symbol FROM watchlist_items
       UNION
       SELECT symbol FROM instruments WHERE is_benchmark
       ORDER BY symbol`,
    );
    return rows.map((r) => r.symbol as string);
  }

  /** Symbols with a poll job that nobody watches any more. */
  async orphanedJobSymbols(): Promise<string[]> {
    const rows = await this.sql.query<Row>(
      `SELECT j.symbol FROM ingest_jobs j
       WHERE NOT EXISTS (SELECT 1 FROM watchlist_items i WHERE i.symbol = j.symbol)
         AND NOT EXISTS (
           SELECT 1 FROM instruments n WHERE n.symbol = j.symbol AND n.is_benchmark
         )`,
    );
    return rows.map((r) => r.symbol as string);
  }

  /**
   * How many distinct users watch each symbol, and when it was last viewed.
   *
   * One query feeds the whole tier calculation, rather than asking per symbol.
   */
  async priorityInputs(): Promise<Map<string, { watchers: number; lastViewedAt: number | null }>> {
    const rows = await this.sql.query<Row>(
      `SELECT j.symbol,
              COALESCE(w.watchers, 0) AS watchers,
              a.last_viewed_at        AS last_viewed_at
       FROM ingest_jobs j
       LEFT JOIN (
         SELECT i.symbol, COUNT(DISTINCT wl.user_id) AS watchers
         FROM watchlist_items i
         JOIN watchlists wl ON wl.id = i.watchlist_id
         GROUP BY i.symbol
       ) w ON w.symbol = j.symbol
       LEFT JOIN symbol_activity a ON a.symbol = j.symbol`,
    );
    return new Map(
      rows.map((r) => [
        r.symbol as string,
        { watchers: n(r.watchers), lastViewedAt: nOrNull(r.last_viewed_at) },
      ]),
    );
  }

  // ───────────────────────────────────────────────────────── activity

  /**
   * Note that a human just looked at these symbols.
   *
   * The scheduler promotes recently-viewed symbols to the hot tier, so
   * *attention* rather than mere list membership is what earns fast polling.
   * A user with 400 symbols on a dashboard does not make all 400 urgent.
   */
  async touchActivity(symbols: readonly string[], now: number): Promise<void> {
    if (symbols.length === 0) return;
    for (const batch of chunk(symbols, 500)) {
      const tuples = batch.map((_, i) => `($${i + 2}::text, $1::bigint, 1::bigint)`);
      await this.sql.query(
        `INSERT INTO symbol_activity (symbol, last_viewed_at, view_count)
         VALUES ${tuples.join(', ')}
         ON CONFLICT (symbol) DO UPDATE SET
           last_viewed_at = GREATEST(symbol_activity.last_viewed_at, excluded.last_viewed_at),
           view_count     = symbol_activity.view_count + 1`,
        [now, ...batch],
      );
    }
  }

  // ───────────────────────────────────────────────────────── idempotency

  /**
   * Look up a previous response for an idempotency key.
   *
   * The stored request hash is compared by the caller: reusing one key for a
   * *different* request body is a client bug, and silently returning the first
   * response would swallow the second, different, intent.
   */
  async getIdempotent(
    key: string,
    userId: string,
  ): Promise<{ requestHash: string; status: number; response: string } | null> {
    const r = await this.sql.one<Row>(
      `SELECT request_hash, status, response FROM idempotency_keys
       WHERE key = $1 AND user_id = $2`,
      [key, userId],
    );
    return r
      ? {
          requestHash: r.request_hash as string,
          status: n(r.status),
          response: r.response as string,
        }
      : null;
  }

  async putIdempotent(rec: {
    key: string;
    userId: string;
    method: string;
    path: string;
    requestHash: string;
    status: number;
    response: string;
    now: number;
  }): Promise<void> {
    await this.sql.query(
      `INSERT INTO idempotency_keys
         (key, user_id, method, path, request_hash, status, response, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (key) DO NOTHING`,
      [
        rec.key,
        rec.userId,
        rec.method,
        rec.path,
        rec.requestHash,
        rec.status,
        rec.response,
        rec.now,
      ],
    );
  }

  async pruneIdempotent(cutoff: number): Promise<number> {
    const rows = await this.sql.query<Row>(
      `DELETE FROM idempotency_keys WHERE created_at < $1 RETURNING key`,
      [cutoff],
    );
    return rows.length;
  }
}
