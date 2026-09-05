/**
 * Replay stored history through the detectors.
 *
 * Why this exists
 * ---------------
 * Detection runs on live quotes, so a freshly-seeded instance knows a year of
 * prices but has *no signal history at all*. Open the app at the weekend and
 * the briefing is empty — not because nothing happened, but because nothing
 * happened while we were watching.
 *
 * That is a real product failure, not just a demo problem. A user adding a
 * symbol on Saturday should immediately be able to see that it gapped 8% on
 * Wednesday and broke its 52-week high on Thursday. The data is already there;
 * only the analysis is missing.
 *
 * So: walk the bars, synthesise the quote each session would have produced,
 * and drive the same detectors and the same episode state machine over them.
 * Because the state machine is fed in chronological order, the episodes come
 * out exactly as they would have if we had been running all along — one signal
 * per episode, with hysteresis, not one per bar.
 *
 * Two honest limits, both stated rather than hidden:
 *
 *  - **A daily bar is not an intraday path.** A session that fell 5% and
 *    recovered looks flat. Volume and range are real, but the sequence within
 *    the day is lost, so intraday-shaped signals are not recoverable.
 *  - **Statistics are computed as-of each replayed session,** not from the full
 *    history, or every signal would be judged against volatility that had not
 *    happened yet. That is what makes it a replay rather than hindsight.
 */

import type { Bar, InstrumentStats, Quote, Signal } from '../domain/types.js';
import type { MarketClock } from '../domain/marketClock.js';
import { computeStats } from '../domain/stats.js';
import type { MarketRepo } from '../db/marketRepo.js';
import type { DetectionEngine } from './detection.js';
import { createLogger } from '../infra/logger.js';

const log = createLogger('replay');

export interface ReplayOptions {
  /** How many recent sessions to replay. */
  sessions: number;
  /**
   * Minimum bars that must precede a replayed session before we will judge it.
   * Below this the volatility estimate is not worth trusting, so we walk
   * forward without emitting.
   */
  minHistory: number;
}

export interface ReplayResult {
  symbol: string;
  sessionsReplayed: number;
  signalsCreated: number;
}

export class ReplayService {
  constructor(
    private readonly market: MarketRepo,
    private readonly detection: DetectionEngine,
    private readonly clock: MarketClock,
    private readonly opts: ReplayOptions,
  ) {}

  /**
   * Build the quote a completed session would have produced.
   *
   * The close becomes the price and the prior close becomes the previous
   * close, which is exactly what the detectors expect. `asOf` is the session's
   * own timestamp, so freshness and horizon maths are evaluated as of *then*
   * rather than now.
   */
  private quoteFromBar(bar: Bar, previous: Bar | undefined): Quote {
    return {
      symbol: bar.symbol,
      price: bar.close,
      prevClose: previous?.close ?? bar.open,
      dayOpen: bar.open,
      dayHigh: bar.high,
      dayLow: bar.low,
      volume: bar.volume,
      asOf: bar.ts,
      receivedAt: bar.ts,
      source: `${bar.source}:replay`,
      // Full confidence: this is a settled, completed session, which is the
      // most reliable data the system ever holds.
      confidence: 1,
      halted: false,
      conflict: null,
    };
  }

  /**
   * Replay one symbol.
   *
   * Runs in chronological order so the hysteresis state machine sees the same
   * sequence it would have live. Statistics are recomputed on a *prefix* of
   * the history at each step - expensive, but the alternative is judging a
   * move in March against volatility measured in September, which would make
   * every historical signal wrong in a direction that flatters us.
   */
  async replaySymbol(
    symbol: string,
    benchmarkBars: readonly Bar[],
    /**
     * The instrument's sector proxy series, when it has one.
     *
     * Threaded through replay for the same reason it is threaded through live
     * ingest: without it, every historical sector-wide repricing is recorded
     * as idiosyncratic for every member, and those rows are what a returning
     * user's first briefing is built from. A replay that disagrees with live
     * detection is worse than no replay - the same event would read as company
     * news on Monday and sector news on Tuesday.
     */
    sector?: { symbol: string; bars: readonly Bar[] } | null,
  ): Promise<ReplayResult> {
    const bars = await this.market.getBars(symbol, 400);
    const result: ReplayResult = { symbol, sessionsReplayed: 0, signalsCreated: 0 };

    if (bars.length < this.opts.minHistory + 2) return result;

    const benchmarkByTs = new Map(benchmarkBars.map((b) => [b.ts, b]));
    const sectorByTs = sector ? new Map(sector.bars.map((b) => [b.ts, b])) : null;
    const sectorName = sector
      ? ((await this.market.getInstrument(symbol))?.sector ?? null)
      : null;

    const firstIndex = Math.max(this.opts.minHistory, bars.length - this.opts.sessions);
    const created: Signal[] = [];

    for (let i = firstIndex; i < bars.length; i++) {
      const bar = bars[i] as Bar;
      const previous = bars[i - 1];

      // History strictly *before* this session, so nothing uses the future.
      const prefix = bars.slice(0, i);
      const benchmarkPrefix = benchmarkBars.filter((b) => b.ts < bar.ts);

      const sectorPrefix = sector ? sector.bars.filter((b) => b.ts < bar.ts) : [];
      const sectorSeries =
        sector && sectorPrefix.length >= this.opts.minHistory
          ? { symbol: sector.symbol, bars: sectorPrefix }
          : null;

      const stats: InstrumentStats = computeStats(
        symbol,
        prefix,
        benchmarkPrefix,
        bar.ts,
        sectorSeries,
      );

      // The benchmark's own bar for this session, so the market-adjusted
      // detector has something to subtract.
      const benchBar = benchmarkByTs.get(bar.ts);
      const benchPrevious = benchmarkPrefix[benchmarkPrefix.length - 1];

      const benchmark =
        benchBar && benchPrevious && benchmarkPrefix.length >= this.opts.minHistory
          ? {
              quote: this.quoteFromBar(benchBar, benchPrevious),
              stats: computeStats(
                benchBar.symbol,
                benchmarkPrefix,
                benchmarkPrefix,
                bar.ts,
              ),
            }
          : null;

      // The sector's own bar for this session, so the decomposition has a
      // sector return to attribute rather than falling back to market-only.
      const sectorBar = sector ? sectorByTs?.get(bar.ts) : undefined;
      const sectorPrev = sectorPrefix[sectorPrefix.length - 1];

      const sectorInput =
        sector && sectorBar && sectorPrev && sectorSeries
          ? { quote: this.quoteFromBar(sectorBar, sectorPrev), name: sectorName ?? sector.symbol }
          : null;

      const detected = await this.detection.detect({
        symbol,
        quote: this.quoteFromBar(bar, previous),
        stats,
        // A completed session's close is the definitive price for it.
        freshness: 'fresh',
        benchmark,
        sector: sectorInput,
        // Detection timestamps land on the session, not on now, so the digest
        // orders them correctly and recency decay treats them as historical.
        now: bar.ts,
      });

      created.push(...detected.created);
      result.sessionsReplayed++;
    }

    result.signalsCreated = created.length;

    if (created.length > 0) {
      log.info('replayed history', {
        symbol,
        sessions: result.sessionsReplayed,
        signals: created.length,
      });
    }

    return result;
  }

  /**
   * Replay every symbol that has history but no signals yet.
   *
   * Deliberately keyed on "has no signals" so it runs once per symbol and is
   * safe to call on every boot: detection is idempotent, but recomputing a
   * year of statistics per symbol on every restart would be pure waste.
   */
  async replayMissing(symbols: readonly string[]): Promise<ReplayResult[]> {
    const benchmarkSymbol = await this.market.getBenchmarkSymbol();
    const benchmarkBars = benchmarkSymbol
      ? await this.market.getBars(benchmarkSymbol, 400)
      : [];

    if (benchmarkBars.length === 0) {
      log.warn('replaying without a benchmark; market-adjusted signals will be absent');
    }

    /*
     * Sector proxy history, loaded once for the whole replay.
     *
     * Nine series rather than one per symbol - and the same bars are reused
     * across every member of a sector, so this is the difference between nine
     * queries and several hundred.
     */
    const proxies = await this.market.getSectorProxies();
    const proxyBars = new Map<string, Bar[]>();
    for (const proxySymbol of new Set(proxies.values())) {
      proxyBars.set(proxySymbol, await this.market.getBars(proxySymbol, 400));
    }

    const results: ReplayResult[] = [];
    for (const symbol of symbols) {
      if (symbol === benchmarkSymbol) continue;
      try {
        const instrument = await this.market.getInstrument(symbol);
        const proxySymbol =
          instrument && !instrument.isBenchmark && !instrument.isSectorProxy && instrument.sector
            ? proxies.get(instrument.sector)
            : undefined;
        const bars = proxySymbol && proxySymbol !== symbol ? proxyBars.get(proxySymbol) : undefined;

        results.push(
          await this.replaySymbol(
            symbol,
            benchmarkBars,
            bars && bars.length > 0 ? { symbol: proxySymbol as string, bars } : null,
          ),
        );
      } catch (err) {
        // One symbol failing must not abort the rest.
        log.error('replay failed', {
          symbol,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const totals = results.reduce(
      (acc, r) => ({
        sessions: acc.sessions + r.sessionsReplayed,
        signals: acc.signals + r.signalsCreated,
      }),
      { sessions: 0, signals: 0 },
    );

    if (totals.signals > 0) {
      log.info('history replay complete', {
        symbols: results.length,
        sessions: totals.sessions,
        signals: totals.signals,
      });
    }

    return results;
  }

  /** Sessions available to replay, for reporting. */
  sessionsWindow(): number {
    return this.opts.sessions;
  }

  /** Exposed so callers can describe the window in market terms. */
  windowStartedAt(now: number): number {
    return this.clock.sessionsAgo(now, this.opts.sessions);
  }
}
