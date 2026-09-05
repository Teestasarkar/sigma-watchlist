/**
 * Persistence for instruments, bars, quotes and statistics.
 *
 * Every SQL statement in the project lives in a repository like this one.
 * Keeping that boundary sharp is what lets the interesting logic - detectors,
 * scoring, reconciliation - stay pure and unit-testable with no database.
 */

import type { Bar, InstrumentStats, Quote, QuoteConflict } from '../domain/types.js';
import type { MarketClock } from '../domain/marketClock.js';
import { batchMap } from '../infra/chunk.js';
import { b, json, n, nOrNull, placeholders, type SqlClient } from './sql.js';

export interface InstrumentRow {
  symbol: string;
  name: string;
  exchange: string | null;
  currency: string;
  sector: string | null;
  status: 'active' | 'delisted' | 'unknown';
  isBenchmark: boolean;
  isSectorProxy: boolean;
  firstSeenAt: number;
}

type Row = Record<string, unknown>;

const mapInstrument = (r: Row): InstrumentRow => ({
  symbol: r.symbol as string,
  name: r.name as string,
  exchange: (r.exchange as string | null) ?? null,
  currency: r.currency as string,
  sector: (r.sector as string | null) ?? null,
  status: r.status as InstrumentRow['status'],
  isBenchmark: b(r.is_benchmark),
  isSectorProxy: b(r.is_sector_proxy),
  firstSeenAt: n(r.first_seen_at),
});

const mapQuote = (r: Row): Quote => ({
  symbol: r.symbol as string,
  price: n(r.price),
  prevClose: n(r.prev_close),
  dayOpen: n(r.day_open),
  dayHigh: n(r.day_high),
  dayLow: n(r.day_low),
  volume: n(r.volume),
  asOf: n(r.as_of),
  receivedAt: n(r.received_at),
  source: r.source as string,
  confidence: n(r.confidence),
  halted: b(r.halted),
  conflict:
    r.conflict === null || r.conflict === undefined
      ? null
      : json<QuoteConflict | null>(r.conflict, null),
});

const mapBar = (r: Row): Bar => ({
  symbol: r.symbol as string,
  ts: n(r.ts),
  open: n(r.open),
  high: n(r.high),
  low: n(r.low),
  close: n(r.close),
  adjClose: nOrNull(r.adj_close),
  volume: n(r.volume),
  source: r.source as string,
});

const mapStats = (r: Row): InstrumentStats => ({
  symbol: r.symbol as string,
  computedAt: n(r.computed_at),
  bars: n(r.bars),
  sigmaDaily: n(r.sigma_daily),
  sigmaShort: n(r.sigma_short),
  atrPct: n(r.atr_pct),
  beta: n(r.beta),
  betaSector: nOrNull(r.beta_sector),
  sectorSymbol: (r.sector_symbol as string | null) ?? null,
  sectorMarketBeta: nOrNull(r.sector_market_beta),
  residSigma: n(r.resid_sigma),
  hi52w: n(r.hi_52w),
  lo52w: n(r.lo_52w),
  hi30d: n(r.hi_30d),
  lo30d: n(r.lo_30d),
  medVol20: n(r.med_vol_20),
  sma20: n(r.sma_20),
  sma50: n(r.sma_50),
  peak52w: n(r.peak_52w),
});

const BAR_COLUMNS = 'symbol, ts, open, high, low, close, adj_close, volume, source';

export class MarketRepo {
  /**
   * The clock is injected because "which trading session does this timestamp
   * belong to" is not a storage concern, and the answer genuinely differs
   * between the live exchange and the simulator.
   */
  constructor(
    private readonly sql: SqlClient,
    private readonly clock: MarketClock,
  ) {}

  // ───────────────────────────────────────────────────────── instruments

  async upsertInstrument(i: {
    symbol: string;
    name: string;
    exchange?: string | null;
    currency?: string;
    sector?: string | null;
    isBenchmark?: boolean;
    isSectorProxy?: boolean;
    now: number;
  }): Promise<void> {
    await this.sql.query(
      `INSERT INTO instruments
         (symbol, name, exchange, currency, sector, status, is_benchmark,
          is_sector_proxy, first_seen_at)
       VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8)
       ON CONFLICT (symbol) DO UPDATE SET
         name     = excluded.name,
         exchange = COALESCE(excluded.exchange, instruments.exchange),
         sector   = COALESCE(excluded.sector, instruments.sector),
         is_sector_proxy = excluded.is_sector_proxy,
         status   = 'active'`,
      [
        i.symbol,
        i.name,
        i.exchange ?? null,
        i.currency ?? 'USD',
        i.sector ?? null,
        i.isBenchmark ?? false,
        i.isSectorProxy ?? false,
        i.now,
      ],
    );
  }

  async getInstrument(symbol: string): Promise<InstrumentRow | null> {
    const r = await this.sql.one<Row>(`SELECT * FROM instruments WHERE symbol = $1`, [symbol]);
    return r ? mapInstrument(r) : null;
  }

  async listInstruments(): Promise<InstrumentRow[]> {
    const rows = await this.sql.query<Row>(`SELECT * FROM instruments ORDER BY symbol`);
    return rows.map(mapInstrument);
  }

  async getInstruments(symbols: readonly string[]): Promise<Map<string, InstrumentRow>> {
    return batchMap(symbols, async (batch) => {
      const rows = await this.sql.query<Row>(
        `SELECT * FROM instruments WHERE symbol IN (${placeholders(batch.length)})`,
        batch as string[],
      );
      return new Map(rows.map((r) => [r.symbol as string, mapInstrument(r)]));
    });
  }

  /** Symbol/name search for the add-symbol box. */
  async searchInstruments(q: string, limit = 12): Promise<InstrumentRow[]> {
    const term = q.trim().toUpperCase();
    const rows = await this.sql.query<Row>(
      `SELECT * FROM instruments
       WHERE NOT is_benchmark
         -- Sector proxies are polled and have statistics, but they are
         -- machinery, not something anyone means to watch.
         AND NOT is_sector_proxy
         AND (symbol LIKE $1 OR UPPER(name) LIKE $1)
       ORDER BY
         CASE WHEN symbol = $2 THEN 0
              WHEN symbol LIKE $3 THEN 1
              ELSE 2 END,
         symbol
       LIMIT $4`,
      [`%${term}%`, term, `${term}%`, limit],
    );
    return rows.map(mapInstrument);
  }

  async markStatus(symbol: string, status: InstrumentRow['status']): Promise<void> {
    await this.sql.query(`UPDATE instruments SET status = $1 WHERE symbol = $2`, [status, symbol]);
  }

  /**
    * Sector proxy symbols, keyed by the sector they stand for.
    *
    * Read from the database rather than the static map so a proxy that failed
    * to seed simply does not appear - the sector factor is then absent for
    * that sector, which is the honest outcome, rather than every regression
    * against it silently returning no overlap.
    */
  async getSectorProxies(): Promise<Map<string, string>> {
    const rows = await this.sql.query<Row>(
      `SELECT symbol, sector FROM instruments WHERE is_sector_proxy AND sector IS NOT NULL`,
    );
    return new Map(rows.map((r) => [r.sector as string, r.symbol as string]));
  }

  async getBenchmarkSymbol(): Promise<string | null> {
    const r = await this.sql.one<Row>(`SELECT symbol FROM instruments WHERE is_benchmark LIMIT 1`);
    return (r?.symbol as string | undefined) ?? null;
  }

  // ───────────────────────────────────────────────────────── bars

  /**
   * Insert or update a daily bar.
   *
   * The incoming timestamp is snapped to the canonical session close, so the
   * primary key *is* the trading session: a provider re-reporting a session
   * with a slightly different timestamp updates the row rather than adding a
   * duplicate.
   *
   * High and low use GREATEST/LEAST rather than last-write-wins, because a
   * late correction that only observed part of the session should widen the
   * range, never shrink it.
   */
  async upsertBar(bar: Bar): Promise<void> {
    await this.upsertBars([bar]);
  }

  /**
   * Bulk-insert bars in as few statements as possible.
   *
   * Seeding one symbol writes ~260 bars. Doing that as 260 round trips is the
   * difference between an instant "add symbol" and a visibly slow one - and
   * against a remote database, between 30ms and several seconds.
   */
  async upsertBars(bars: readonly Bar[]): Promise<void> {
    if (bars.length === 0) return;

    const COLS = 10;
    const perStatement = 500;

    await this.sql.tx(async () => {
      for (let start = 0; start < bars.length; start += perStatement) {
        const slice = bars.slice(start, start + perStatement);
        const tuples: string[] = [];
        const params: unknown[] = [];

        slice.forEach((bar, i) => {
          const base = i * COLS;
          tuples.push(`(${Array.from({ length: COLS }, (_, k) => `$${base + k + 1}`).join(', ')})`);
          const ts = this.clock.sessionCloseOf(bar.ts);
          params.push(
            bar.symbol,
            ts,
            this.clock.sessionKeyOf(ts),
            bar.open,
            bar.high,
            bar.low,
            bar.close,
            bar.adjClose,
            bar.volume,
            bar.source,
          );
        });

        await this.sql.query(
          `INSERT INTO bars
             (symbol, ts, session_key, open, high, low, close, adj_close, volume, source)
           VALUES ${tuples.join(', ')}
           ON CONFLICT (symbol, ts) DO UPDATE SET
             open      = excluded.open,
             high      = GREATEST(bars.high, excluded.high),
             low       = LEAST(bars.low, excluded.low),
             close     = excluded.close,
             -- Always take the newest adjustment: a split rescales every
             -- historical bar, so a re-fetch is a correction, not a duplicate.
             adj_close = COALESCE(excluded.adj_close, bars.adj_close),
             volume    = GREATEST(bars.volume, excluded.volume),
             source    = excluded.source`,
          params,
        );
      }
    });
  }

  /** Most recent `limit` bars, oldest-first - the order statistics expect. */
  async getBars(symbol: string, limit = 260): Promise<Bar[]> {
    const rows = await this.sql.query<Row>(
      `SELECT ${BAR_COLUMNS} FROM bars WHERE symbol = $1 ORDER BY ts DESC LIMIT $2`,
      [symbol, limit],
    );
    return rows.map(mapBar).reverse();
  }

  async getLastBar(symbol: string): Promise<Bar | null> {
    const r = await this.sql.one<Row>(
      `SELECT ${BAR_COLUMNS} FROM bars WHERE symbol = $1 ORDER BY ts DESC LIMIT 1`,
      [symbol],
    );
    return r ? mapBar(r) : null;
  }

  async countBars(symbol: string): Promise<number> {
    const r = await this.sql.one<Row>(`SELECT COUNT(*) AS c FROM bars WHERE symbol = $1`, [symbol]);
    return n(r?.c);
  }

  /** Latest bar timestamp per symbol, for deciding whether a session closed. */
  async lastBarTimestamps(symbols: readonly string[]): Promise<Map<string, number>> {
    return batchMap(symbols, async (batch) => {
      const rows = await this.sql.query<Row>(
        `SELECT symbol, MAX(ts) AS ts FROM bars
         WHERE symbol IN (${placeholders(batch.length)})
         GROUP BY symbol`,
        batch as string[],
      );
      return new Map(rows.map((r) => [r.symbol as string, nOrNull(r.ts) ?? 0]));
    });
  }

  // ───────────────────────────────────────────────────────── quotes

  /**
   * Store a reconciled quote, but only if it is not older than what we have.
   *
   * The `WHERE quotes_latest.as_of <= excluded.as_of` guard fixes a real and
   * easily-missed race: two concurrent fetches for one symbol can complete out
   * of order, and without it the older response overwrites the newer, making
   * the displayed price jump visibly backwards. Returns whether the write was
   * accepted so the caller can skip detection on a rejected stale write.
   */
  async upsertQuote(q: Quote): Promise<boolean> {
    const rows = await this.sql.query<Row>(
      `INSERT INTO quotes_latest
         (symbol, price, prev_close, day_open, day_high, day_low, volume,
          as_of, received_at, source, confidence, halted, conflict)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (symbol) DO UPDATE SET
         price       = excluded.price,
         prev_close  = excluded.prev_close,
         day_open    = excluded.day_open,
         day_high    = excluded.day_high,
         day_low     = excluded.day_low,
         volume      = excluded.volume,
         as_of       = excluded.as_of,
         received_at = excluded.received_at,
         source      = excluded.source,
         confidence  = excluded.confidence,
         halted      = excluded.halted,
         conflict    = excluded.conflict
       WHERE quotes_latest.as_of <= excluded.as_of
       RETURNING symbol`,
      [
        q.symbol,
        q.price,
        q.prevClose,
        q.dayOpen,
        q.dayHigh,
        q.dayLow,
        q.volume,
        q.asOf,
        q.receivedAt,
        q.source,
        q.confidence,
        q.halted,
        q.conflict ? JSON.stringify(q.conflict) : null,
      ],
    );
    return rows.length > 0;
  }

  /**
   * Backdate stored quote timestamps.
   *
   * Only reachable from the DEV_TOOLS routes. It exists because the honest way
   * to exercise the staleness ladder is to make our *stored* knowledge old -
   * which is what actually happens when a feed goes quiet. Backdating the
   * provider's `asOf` instead does not work, and correctly so: `upsertQuote`
   * refuses to accept a quote older than the one it holds, which is the
   * out-of-order guard doing its job.
   */
  async backdateQuotes(symbols: readonly string[], byMs: number): Promise<number> {
    if (symbols.length === 0 || byMs <= 0) return 0;
    const rows = await this.sql.query<Row>(
      `UPDATE quotes_latest SET as_of = as_of - $1
       WHERE symbol IN (${placeholders(symbols.length, 2)})
       RETURNING symbol`,
      [byMs, ...symbols],
    );
    return rows.length;
  }

  async getQuote(symbol: string): Promise<Quote | null> {
    const r = await this.sql.one<Row>(`SELECT * FROM quotes_latest WHERE symbol = $1`, [symbol]);
    return r ? mapQuote(r) : null;
  }

  /** Batch read for the watchlist view - one query regardless of list size. */
  async getQuotes(symbols: readonly string[]): Promise<Map<string, Quote>> {
    return batchMap(symbols, async (batch) => {
      const rows = await this.sql.query<Row>(
        `SELECT * FROM quotes_latest WHERE symbol IN (${placeholders(batch.length)})`,
        batch as string[],
      );
      return new Map(rows.map((r) => [r.symbol as string, mapQuote(r)]));
    });
  }

  // ───────────────────────────────────────────────────────── stats

  async upsertStats(s: InstrumentStats): Promise<void> {
    await this.sql.query(
      `INSERT INTO instrument_stats
         (symbol, computed_at, bars, sigma_daily, sigma_short, atr_pct, beta,
          resid_sigma, hi_52w, lo_52w, hi_30d, lo_30d, med_vol_20, sma_20, sma_50, peak_52w,
          beta_sector, sector_symbol, sector_market_beta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT (symbol) DO UPDATE SET
         computed_at = excluded.computed_at,
         bars        = excluded.bars,
         sigma_daily = excluded.sigma_daily,
         sigma_short = excluded.sigma_short,
         atr_pct     = excluded.atr_pct,
         beta        = excluded.beta,
         resid_sigma = excluded.resid_sigma,
         hi_52w      = excluded.hi_52w,
         lo_52w      = excluded.lo_52w,
         hi_30d      = excluded.hi_30d,
         lo_30d      = excluded.lo_30d,
         med_vol_20  = excluded.med_vol_20,
         sma_20      = excluded.sma_20,
         sma_50      = excluded.sma_50,
         peak_52w    = excluded.peak_52w,
         beta_sector = excluded.beta_sector,
         sector_symbol = excluded.sector_symbol,
         sector_market_beta = excluded.sector_market_beta`,
      [
        s.symbol,
        s.computedAt,
        s.bars,
        s.sigmaDaily,
        s.sigmaShort,
        s.atrPct,
        s.beta,
        s.residSigma,
        s.hi52w,
        s.lo52w,
        s.hi30d,
        s.lo30d,
        s.medVol20,
        s.sma20,
        s.sma50,
        s.peak52w,
        s.betaSector,
        s.sectorSymbol,
        s.sectorMarketBeta,
      ],
    );
  }

  async getStats(symbol: string): Promise<InstrumentStats | null> {
    const r = await this.sql.one<Row>(`SELECT * FROM instrument_stats WHERE symbol = $1`, [symbol]);
    return r ? mapStats(r) : null;
  }

  async getStatsMany(symbols: readonly string[]): Promise<Map<string, InstrumentStats>> {
    return batchMap(symbols, async (batch) => {
      const rows = await this.sql.query<Row>(
        `SELECT * FROM instrument_stats WHERE symbol IN (${placeholders(batch.length)})`,
        batch as string[],
      );
      return new Map(rows.map((r) => [r.symbol as string, mapStats(r)]));
    });
  }

  /**
   * Symbols whose statistics are older than their newest bar.
   *
   * Recomputation is driven off this rather than done eagerly on every quote,
   * so a busy tick does not turn into a year of arithmetic per symbol.
   */
  async symbolsNeedingStats(limit = 50): Promise<string[]> {
    const rows = await this.sql.query<Row>(
      `SELECT b.symbol
       FROM (SELECT symbol, MAX(ts) AS last_ts FROM bars GROUP BY symbol) b
       LEFT JOIN instrument_stats s ON s.symbol = b.symbol
       WHERE s.symbol IS NULL OR s.computed_at < b.last_ts
       LIMIT $1`,
      [limit],
    );
    return rows.map((r) => r.symbol as string);
  }
}
