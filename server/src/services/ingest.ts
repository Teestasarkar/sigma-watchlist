/**
 * The ingestion pipeline for a single symbol.
 *
 * One pass does: fetch and reconcile a quote, store it under the
 * out-of-order guard, backfill any sessions that closed while we were not
 * looking, recompute statistics if the history changed, and run detection.
 *
 * The backfill deserves the attention. A process that has been asleep - a
 * deploy, a crash, a free-tier host spinning down overnight - wakes up with a
 * gap in its history. The naive behaviour is to carry on from the current
 * price, which silently loses every signal from the gap and corrupts the
 * volatility estimates that depend on a complete bar series. Instead we notice
 * the gap, re-fetch the sessions we missed, and let detection run over them.
 * Downtime costs latency, not correctness.
 */

import type { Bar, Freshness, InstrumentStats, Quote } from '../domain/types.js';
import type { MarketClock } from '../domain/marketClock.js';
import { computeStats } from '../domain/stats.js';
import { classifyFreshness } from '../providers/reconcile.js';
import {
  LocallyThrottledError,
  ProviderRegistry,
  SymbolNotFoundError,
} from '../providers/registry.js';
import type { MarketRepo } from '../db/marketRepo.js';
import type { IngestRepo } from '../db/ingestRepo.js';
import type { DetectionEngine } from './detection.js';
import type { CorporateActionService } from './corporateActions.js';
import { createLogger } from '../infra/logger.js';

const log = createLogger('ingest');

export interface IngestOptions {
  historySessions: number;
  freshness: { freshMs: number; delayedMs: number; staleMs: number };
  /** Cap on how many missed sessions a single backfill will pull. */
  maxBackfillSessions: number;
}

export interface RefreshResult {
  symbol: string;
  ok: boolean;
  /** False when the quote was rejected for being older than what we hold. */
  quoteAccepted: boolean;
  barsWritten: number;
  statsRecomputed: boolean;
  signalsCreated: number;
  error?: string;
  notFound?: boolean;
  /**
   * True when our own rate limiter held the request back, so nothing was
   * actually asked of the provider. The scheduler must treat this as "come
   * back shortly", not as a failure - see Scheduler.runJob.
   */
  throttled?: boolean;
  retryAfterMs?: number;
  /** Splits applied to stored checkpoints on this pass. */
  corporateActions?: number;
}

/**
 * Benchmark snapshot, loaded once per scheduler cycle rather than per symbol.
 *
 * Every market-adjusted detector needs it, so fetching it per symbol would
 * turn one query into N.
 */
export interface BenchmarkSnapshot {
  symbol: string;
  quote: Quote;
  stats: InstrumentStats;
}

export class IngestService {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly market: MarketRepo,
    private readonly jobs: IngestRepo,
    private readonly detection: DetectionEngine,
    private readonly actions: CorporateActionService,
    private readonly clock: MarketClock,
    private readonly opts: IngestOptions,
  ) {}

  // ─────────────────────────────────────────────────── instrument setup

  /**
   * Make a symbol known to the system: resolve its metadata, seed a year of
   * history, compute statistics, and enqueue it for polling.
   *
   * Seeding history up front is what lets the very first signal for a new
   * symbol be trustworthy. Without it, the first day's "3 sigma move" would be
   * computed from a volatility estimate built on two data points.
   */
  async ensureInstrument(
    symbol: string,
    now: number,
    opts: { isBenchmark?: boolean; pollIntervalMs: number },
  ): Promise<{ created: boolean; bars: number }> {
    const sym = symbol.toUpperCase();
    const existing = await this.market.getInstrument(sym);

    if (!existing) {
      const meta = await this.registry.resolve(sym);
      if (!meta) throw new SymbolNotFoundError(sym);

      await this.market.upsertInstrument({
        symbol: sym,
        name: meta.name,
        exchange: meta.exchange ?? null,
        currency: meta.currency ?? 'USD',
        sector: meta.sector ?? null,
        isBenchmark: opts.isBenchmark ?? false,
        now,
      });
    }

    const have = await this.market.countBars(sym);
    let written = 0;

    if (have < this.opts.historySessions) {
      const bars = await this.registry.getHistory(sym, this.opts.historySessions);
      if (bars.length > 0) {
        await this.market.upsertBars(bars);
        written = bars.length;
      }
    }

    // Enqueue before computing statistics: if stats fail we still want the
    // symbol polled, and the next cycle will retry them.
    await this.jobs.ensureJob(sym, opts.pollIntervalMs, now);

    // Learn about any splits before the first statistics are computed.
    if (written > 0) await this.actions.sync(sym, now);

    if (written > 0 || !(await this.market.getStats(sym))) {
      await this.recomputeStats(sym, now);
    }

    return { created: !existing, bars: written };
  }

  // ─────────────────────────────────────────────────── statistics

  /**
   * Recompute the materialised statistics for a symbol.
   *
   * Benchmark bars are joined in so beta and residual volatility are real
   * regressions rather than assumptions. When the symbol *is* the benchmark we
   * pass its own series, which correctly yields beta = 1.
   */
  async recomputeStats(symbol: string, now: number): Promise<InstrumentStats | null> {
    const bars = await this.market.getBars(symbol, this.opts.historySessions);
    if (bars.length < 2) return null;

    const benchmarkSymbol = await this.market.getBenchmarkSymbol();
    const marketBars: readonly Bar[] =
      benchmarkSymbol && benchmarkSymbol !== symbol
        ? await this.market.getBars(benchmarkSymbol, this.opts.historySessions)
        : bars;

    const stats = computeStats(symbol, bars, marketBars, now);
    await this.market.upsertStats(stats);
    return stats;
  }

  // ─────────────────────────────────────────────────── the refresh pass

  async refresh(
    symbol: string,
    now: number,
    benchmark: BenchmarkSnapshot | null,
  ): Promise<RefreshResult> {
    const result: RefreshResult = {
      symbol,
      ok: false,
      quoteAccepted: false,
      barsWritten: 0,
      statsRecomputed: false,
      signalsCreated: 0,
    };

    let quote: Quote;
    try {
      const barCount = await this.market.countBars(symbol);
      quote = await this.registry.getQuote(symbol, barCount);
    } catch (err) {
      if (err instanceof SymbolNotFoundError) {
        // Every provider disowned it. Mark it rather than deleting it: the
        // user put it there deliberately and needs to be told it vanished.
        await this.market.markStatus(symbol, 'delisted');
        return { ...result, error: 'symbol not found upstream', notFound: true };
      }
      if (err instanceof LocallyThrottledError) {
        // Our budget, not their health. No failure streak, no backoff.
        return {
          ...result,
          error: err.message,
          throttled: true,
          retryAfterMs: err.retryAfterMs,
        };
      }
      return { ...result, error: err instanceof Error ? err.message : String(err) };
    }

    result.quoteAccepted = await this.market.upsertQuote(quote);

    /*
     * A symbol that starts resolving again must be un-marked.
     *
     * `markStatus('delisted')` above is sticky, and nothing else clears it -
     * so a transient period where every provider disowned a ticker would leave
     * it permanently flagged as gone even after it came back. The flag is a
     * statement about the present, not a tombstone.
     */
    if (result.quoteAccepted) {
      const instrument = await this.market.getInstrument(symbol);
      if (instrument && instrument.status !== 'active') {
        await this.market.markStatus(symbol, 'active');
        log.info('symbol resolving again', { symbol, was: instrument.status });
      }
    }

    // Backfill before detection, so detection sees complete history.
    result.barsWritten = await this.backfillIfNeeded(symbol, now);

    if (result.barsWritten > 0) {
      /*
       * Check for splits *before* recomputing statistics.
       *
       * New bars are the only moment a corporate action can appear, and a
       * split rescales every historical bar - so the adjusted closes the
       * statistics are about to read have just changed underneath them.
       */
      const applied = await this.actions.sync(symbol, now);
      result.corporateActions = applied.splitsApplied;

      await this.recomputeStats(symbol, now);
      result.statsRecomputed = true;
    }

    /*
     * If the stored quote is newer than the one we just fetched, our fetch lost
     * a race. Running detection on the losing quote would compute signals from
     * a price the database has already superseded - and could reopen an episode
     * the winning write just closed.
     */
    const effective = result.quoteAccepted ? quote : await this.market.getQuote(symbol);
    if (!effective) return { ...result, ok: true };

    const stats = await this.market.getStats(symbol);
    const freshness = this.freshnessOf(effective, now);

    const detected = await this.detection.detect({
      symbol,
      quote: effective,
      stats,
      freshness,
      benchmark:
        benchmark && benchmark.symbol !== symbol
          ? { quote: benchmark.quote, stats: benchmark.stats }
          : null,
      now,
    });

    result.signalsCreated = detected.created.length;
    result.ok = true;
    return result;
  }

  freshnessOf(quote: Quote, now: number): Freshness {
    return classifyFreshness(quote.asOf, now, {
      ...this.opts.freshness,
      marketOpen: this.clock.isOpen(now),
      lastSessionCloseAt: this.clock.lastCompletedSessionAt(now),
    });
  }

  /**
   * Fetch any daily bars that closed since our last stored one.
   *
   * Returns the number written; zero is the overwhelmingly common case and
   * costs one indexed query, so this is cheap to call on every pass.
   */
  private async backfillIfNeeded(symbol: string, now: number): Promise<number> {
    const last = await this.market.getLastBar(symbol);
    const lastCompleteClose = this.clock.lastCompletedSessionAt(now);

    if (last && last.ts >= lastCompleteClose) return 0;

    const missingSessions = last
      ? Math.ceil(
          this.clock.sessionsBetween(last.ts, lastCompleteClose) + 1,
        )
      : this.opts.historySessions;

    const want = Math.min(
      Math.max(missingSessions, 1),
      last ? this.opts.maxBackfillSessions : this.opts.historySessions,
    );

    let bars: Bar[];
    try {
      bars = await this.registry.getHistory(symbol, want);
    } catch (err) {
      // A failed backfill must not fail the refresh. The quote is still good,
      // and the next pass will try again.
      log.warn('backfill failed', {
        symbol,
        err: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }

    const fresh = last ? bars.filter((b) => b.ts > last.ts) : bars;
    if (fresh.length === 0) return 0;

    await this.market.upsertBars(fresh);
    log.info('backfilled', { symbol, sessions: fresh.length });
    return fresh.length;
  }

  /** Load the benchmark snapshot for a cycle, or null if unavailable. */
  async benchmarkSnapshot(): Promise<BenchmarkSnapshot | null> {
    const symbol = await this.market.getBenchmarkSymbol();
    if (!symbol) return null;
    const [quote, stats] = await Promise.all([
      this.market.getQuote(symbol),
      this.market.getStats(symbol),
    ]);
    if (!quote || !stats) return null;
    return { symbol, quote, stats };
  }
}
