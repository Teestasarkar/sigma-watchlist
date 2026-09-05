/**
 * Live market data from Yahoo Finance.
 *
 * Why this one: it is the only genuinely free source I found that returns both
 * a live quote *and* a year of daily history, for equities, with no API key and
 * no registration. Alpha Vantage gives 25 requests a day; Finnhub's free tier
 * dropped daily candles; Stooq now sits behind a JavaScript proof-of-work
 * challenge. For a watchlist that needs a year of history per symbol to say
 * anything at all, those are not options.
 *
 * What it costs: this is an undocumented endpoint. It can change or start
 * refusing traffic without notice, which is precisely why every provider in
 * this project sits behind a circuit breaker, a rate limiter and a fallback.
 * The architecture treats an unreliable upstream as the normal case.
 *
 * Three things about this API that will bite anyone who does not check:
 *
 *  1. **`chartPreviousClose` is not yesterday's close.** It is the close before
 *     the *requested range* began - so with `range=1y` it is a year old. Using
 *     it would report AAPL as +33.9% every single day. The real previous close
 *     is the second-to-last bar in the series.
 *  2. **The OHLCV arrays contain nulls.** Halted sessions and bad ticks come
 *     back as `null` inside otherwise-valid arrays, so a naive `.map()`
 *     produces NaN prices that propagate into every statistic.
 *  3. **One call answers both questions.** Quote and history come from the same
 *     payload, so fetching them separately doubles the request count against an
 *     endpoint with unknown limits, for no benefit.
 */

import type { Bar, CorporateAction, RawQuote } from '../domain/types.js';
import type { MarketClock } from '../domain/marketClock.js';
import type { Clock } from '../infra/clock.js';
import { systemClock } from '../infra/clock.js';
import {
  SymbolNotFoundError,
  TransientProviderError,
  type MarketDataProvider,
  type ProviderCapabilities,
} from './types.js';
import { createLogger } from '../infra/logger.js';

const log = createLogger('yahoo');

/** Widest to narrowest, so a cached wide range can serve a narrow request. */
const RANGE_ORDER = ['5d', '1mo', '3mo', '6mo', '1y', '2y'];

const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];

/**
 * Yahoo refuses requests without a browser-ish User-Agent. This is not an
 * attempt to disguise the client - the string names the project - it is the
 * minimum the endpoint accepts.
 */
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; SigmaWatchlist/1.0; +https://github.com/Teestasarkar)',
  Accept: 'application/json,text/plain,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
} as const;

interface ChartMeta {
  symbol?: string;
  currency?: string;
  fullExchangeName?: string;
  exchangeName?: string;
  longName?: string;
  shortName?: string;
  regularMarketPrice?: number;
  regularMarketTime?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  regularMarketVolume?: number;
  regularMarketChangePercent?: number;
  chartPreviousClose?: number;
  instrumentType?: string;
}

interface ChartResult {
  meta: ChartMeta;
  timestamp?: number[];
  indicators?: {
    quote?: Array<{
      open?: Array<number | null>;
      high?: Array<number | null>;
      low?: Array<number | null>;
      close?: Array<number | null>;
      volume?: Array<number | null>;
    }>;
    adjclose?: Array<{ adjclose?: Array<number | null> }>;
  };
  events?: {
    splits?: Record<
      string,
      { date?: number; numerator?: number; denominator?: number; splitRatio?: string }
    >;
    dividends?: Record<string, { date?: number; amount?: number }>;
  };
}

interface ChartResponse {
  chart?: {
    result?: ChartResult[] | null;
    error?: { code?: string; description?: string } | null;
  };
}

/** A parsed payload, usable as a quote, a bar series and an action list. */
interface Parsed {
  meta: ChartMeta;
  bars: Bar[];
  actions: CorporateAction[];
  fetchedAt: number;
}

export class YahooProvider implements MarketDataProvider {
  readonly name = 'yahoo';
  readonly capabilities: ProviderCapabilities = {
    history: true,
    /*
     * Conservative, but not so conservative that we throttle ourselves.
     *
     * The real limit is undocumented and enforced by IP. 30/min sounded
     * prudent and was in fact too low: eleven symbols on a 20-second cycle is
     * 33 requests a minute, so the limiter was refusing our own traffic while
     * the endpoint was answering every probe in half a second. Being blocked
     * is worse than being late, but throttling yourself below your actual
     * workload is just an outage you built yourself.
     */
    requestsPerMinute: 90,
    /** Yahoo's equity quotes are real-time for most US venues. */
    delayed: false,
  };

  /**
   * Short-lived payload cache, keyed by symbol alone.
   *
   * Keyed by symbol rather than by (symbol, range) on purpose. One HTTP call
   * already answers both `getQuote` and `getHistory` - but only if they share
   * a cache entry. Keying by range meant a refresh cycle fetched `5d` for the
   * quote and `1y` for the backfill check and paid twice, which is how a
   * 30-requests-per-minute budget turns into 60. A cached wide range satisfies
   * a request for a narrow one; the reverse triggers a refetch.
   */
  private readonly cache = new Map<string, Parsed & { range: string }>();
  private readonly cacheTtlMs: number;

  /** Alternates hosts, so a per-host throttle is not a total outage. */
  private hostIndex = 0;

  constructor(
    private readonly marketClock: MarketClock,
    private readonly wall: Clock = systemClock,
    opts: { cacheTtlMs?: number } = {},
  ) {
    this.cacheTtlMs = opts.cacheTtlMs ?? 4_000;
  }

  // ─────────────────────────────────────────────────────── fetching

  private async fetchChart(
    symbol: string,
    range: string,
    signal?: AbortSignal,
  ): Promise<Parsed> {
    const cached = this.cache.get(symbol);
    const fresh = cached && this.wall.now() - cached.fetchedAt < this.cacheTtlMs;
    // A cached wider range answers a request for a narrower one.
    if (fresh && cached && RANGE_ORDER.indexOf(cached.range) >= RANGE_ORDER.indexOf(range)) {
      return cached;
    }

    const host = HOSTS[this.hostIndex % HOSTS.length] as string;
    this.hostIndex++;

    const url = new URL(`${host}/v8/finance/chart/${encodeURIComponent(symbol)}`);
    url.searchParams.set('range', range);
    url.searchParams.set('interval', '1d');
    url.searchParams.set('includePrePost', 'false');
    // Splits and dividends. Without these the only correction available is
    // the adjusted close, which fixes statistics but cannot tell us that a
    // stored checkpoint price needs rescaling.
    url.searchParams.set('events', 'div,split');

    const res = await fetch(url, { headers: HEADERS, signal: signal ?? null });

    if (res.status === 404) throw new SymbolNotFoundError(symbol);
    if (res.status === 429) {
      throw new TransientProviderError('yahoo rate limit exceeded', 429);
    }
    if (res.status >= 500) {
      throw new TransientProviderError(`yahoo upstream ${res.status}`, res.status);
    }
    if (!res.ok) {
      throw new TransientProviderError(`yahoo responded ${res.status}`, res.status);
    }

    let body: ChartResponse;
    try {
      body = (await res.json()) as ChartResponse;
    } catch {
      // A challenge page or an HTML error dressed as a 200.
      throw new TransientProviderError('yahoo returned a non-JSON body', res.status);
    }

    if (body.chart?.error) {
      const code = body.chart.error.code ?? '';
      if (/not found|no data/i.test(code + (body.chart.error.description ?? ''))) {
        throw new SymbolNotFoundError(symbol);
      }
      throw new TransientProviderError(`yahoo: ${body.chart.error.description ?? code}`);
    }

    const result = body.chart?.result?.[0];
    if (!result) throw new SymbolNotFoundError(symbol);

    const parsed = {
      meta: result.meta ?? {},
      bars: this.toBars(symbol, result),
      actions: this.toActions(symbol, result),
      fetchedAt: this.wall.now(),
      range,
    };

    // Bound the cache. A user could watch hundreds of symbols; entries are
    // small but there is no reason to keep them past their usefulness.
    if (this.cache.size > 600) this.cache.clear();
    this.cache.set(symbol, parsed);

    return parsed;
  }

  /**
   * Convert the column-oriented payload into bars, discarding incomplete rows.
   *
   * Yahoo returns `null` inside the OHLCV arrays for sessions it has no data
   * for - halts, holidays it included anyway, occasional gaps. Mapping without
   * filtering produces NaN closes, and a single NaN poisons every volatility
   * estimate downstream.
   */
  private toBars(symbol: string, result: ChartResult): Bar[] {
    const ts = result.timestamp ?? [];
    const q = result.indicators?.quote?.[0];
    const adj = result.indicators?.adjclose?.[0]?.adjclose;
    if (!q || ts.length === 0) return [];

    const bars: Bar[] = [];

    for (let i = 0; i < ts.length; i++) {
      const close = q.close?.[i];
      const open = q.open?.[i];
      const high = q.high?.[i];
      const low = q.low?.[i];
      const volume = q.volume?.[i];
      const t = ts[i];

      if (
        typeof t !== 'number' ||
        typeof close !== 'number' ||
        !Number.isFinite(close) ||
        close <= 0
      ) {
        continue;
      }

      // Open/high/low occasionally go missing on an otherwise valid row; the
      // close is the load-bearing value, so fall back rather than drop the bar.
      const o = typeof open === 'number' && open > 0 ? open : close;
      const h = typeof high === 'number' && high > 0 ? high : Math.max(o, close);
      const l = typeof low === 'number' && low > 0 ? low : Math.min(o, close);

      const adjusted = adj?.[i];

      bars.push({
        symbol,
        ts: this.marketClock.sessionCloseOf(t * 1000),
        open: o,
        high: Math.max(h, o, close),
        low: Math.min(l, o, close),
        close,
        // Split- and dividend-adjusted. Yahoo scales history so the newest
        // bar's adjusted close equals its raw close, which is what keeps an
        // adjusted series directly comparable with the live price.
        adjClose:
          typeof adjusted === 'number' && Number.isFinite(adjusted) && adjusted > 0
            ? adjusted
            : null,
        volume: typeof volume === 'number' && volume >= 0 ? volume : 0,
        source: this.name,
      });
    }

    return bars;
  }

  /** Splits and dividends from the payload's events block. */
  private toActions(symbol: string, result: ChartResult): CorporateAction[] {
    const out: CorporateAction[] = [];
    const now = this.wall.now();

    for (const raw of Object.values(result.events?.splits ?? {})) {
      const numerator = raw.numerator;
      const denominator = raw.denominator;
      if (
        typeof raw.date !== 'number' ||
        typeof numerator !== 'number' ||
        typeof denominator !== 'number' ||
        !(numerator > 0) ||
        !(denominator > 0)
      ) {
        continue;
      }
      out.push({
        symbol,
        ts: this.marketClock.sessionCloseOf(raw.date * 1000),
        kind: 'split',
        numerator,
        denominator,
        amount: null,
        detectedAt: now,
      });
    }

    for (const raw of Object.values(result.events?.dividends ?? {})) {
      if (typeof raw.date !== 'number' || typeof raw.amount !== 'number') continue;
      out.push({
        symbol,
        ts: this.marketClock.sessionCloseOf(raw.date * 1000),
        kind: 'dividend',
        numerator: 1,
        denominator: 1,
        amount: raw.amount,
        detectedAt: now,
      });
    }

    return out.sort((a, b) => a.ts - b.ts);
  }

  // ─────────────────────────────────────────────────────── interface

  async getQuote(symbol: string, signal?: AbortSignal): Promise<RawQuote> {
    const sym = symbol.toUpperCase();
    /*
     * Ask for the full year even though a quote only needs two closes.
     *
     * The payload is 28KB instead of 2KB, which costs nothing on a handful of
     * symbols - and it means the very same response satisfies the backfill
     * check that follows on the same tick, halving the request count against
     * an endpoint whose real rate limit is undocumented. Bandwidth is cheap;
     * getting throttled is not.
     */
    const parsed = await this.fetchChart(sym, '1y', signal);
    const { meta, bars } = parsed;

    const price = meta.regularMarketPrice;
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
      throw new TransientProviderError(`yahoo returned no usable price for ${sym}`);
    }

    /*
     * The previous close.
     *
     * NOT `meta.chartPreviousClose` - that is the close before the requested
     * range began, so at range=1y it is a year stale and would report a 30%+
     * move every day. The correct value is the last completed session's close.
     *
     * The final bar is today's (still forming) session, so the one before it is
     * the previous close. If the market is shut, the final bar *is* the last
     * completed session and matches the live price, so the one before it is
     * still right.
     */
    const prevClose = this.derivePreviousClose(bars, price, meta);
    if (prevClose === null) {
      throw new TransientProviderError(`yahoo returned no usable previous close for ${sym}`);
    }

    const last = bars[bars.length - 1];
    const asOf =
      typeof meta.regularMarketTime === 'number' && meta.regularMarketTime > 0
        ? meta.regularMarketTime * 1000
        : this.wall.now();

    const dayHigh =
      typeof meta.regularMarketDayHigh === 'number' && meta.regularMarketDayHigh > 0
        ? meta.regularMarketDayHigh
        : (last?.high ?? price);
    const dayLow =
      typeof meta.regularMarketDayLow === 'number' && meta.regularMarketDayLow > 0
        ? meta.regularMarketDayLow
        : (last?.low ?? price);

    return {
      symbol: sym,
      price,
      prevClose,
      dayOpen: last?.open ?? price,
      // Clamp so the stored quote can never claim a price outside its own
      // range, which the range-break detector would read as a breakout.
      dayHigh: Math.max(dayHigh, price),
      dayLow: Math.min(dayLow, price),
      volume:
        typeof meta.regularMarketVolume === 'number' && meta.regularMarketVolume >= 0
          ? meta.regularMarketVolume
          : (last?.volume ?? 0),
      asOf,
      source: this.name,
      halted: false,
    };
  }

  /**
   * The close of the last *completed* session.
   *
   * Cross-checked against Yahoo's own `regularMarketChangePercent` where it is
   * available: if our derived previous close implies a wildly different day
   * change than Yahoo reports, we prefer Yahoo's own figure. That guard is what
   * would have caught the `chartPreviousClose` mistake automatically.
   */
  private derivePreviousClose(bars: readonly Bar[], price: number, meta: ChartMeta): number | null {
    const closes = bars.map((b) => b.close).filter((c) => Number.isFinite(c) && c > 0);

    let candidate: number | null = null;
    if (closes.length >= 2) {
      const lastClose = closes[closes.length - 1] as number;
      const priorClose = closes[closes.length - 2] as number;
      // If the final bar's close equals the live price, that bar *is* today and
      // the previous close is the one before it. Otherwise the final bar is
      // already the last completed session.
      candidate = Math.abs(lastClose - price) < 1e-6 ? priorClose : lastClose;
    } else if (closes.length === 1) {
      candidate = closes[0] as number;
    }

    const reported = meta.regularMarketChangePercent;
    if (typeof reported === 'number' && Number.isFinite(reported) && reported > -100) {
      const implied = price / (1 + reported / 100);
      if (implied > 0) {
        // Disagreement beyond a rounding error means our derivation is wrong;
        // trust the venue's own change figure.
        if (candidate === null || Math.abs(candidate - implied) / implied > 0.005) {
          if (candidate !== null) {
            log.debug('preferring reported change over derived previous close', {
              derived: candidate,
              implied,
            });
          }
          return implied;
        }
      }
    }

    return candidate;
  }

  async getHistory(symbol: string, sessions: number, signal?: AbortSignal): Promise<Bar[]> {
    const sym = symbol.toUpperCase();
    // Yahoo only accepts a fixed set of range tokens.
    const range = sessions <= 30 ? '3mo' : sessions <= 130 ? '6mo' : sessions <= 260 ? '1y' : '2y';
    const parsed = await this.fetchChart(sym, range, signal);

    /*
     * Drop the final bar when it is the session currently in progress.
     *
     * Yahoo includes today's partial session in the series. Storing it as a
     * completed bar bakes a half-day into the volatility estimate and makes
     * every statistic wrong until the close.
     */
    const bars = parsed.bars;
    const lastCompleted = this.marketClock.lastCompletedSessionAt(this.wall.now());
    const completed = bars.filter((b) => b.ts <= lastCompleted);

    return completed.slice(-sessions);
  }

  async getCorporateActions(
    symbol: string,
    sessions: number,
    signal?: AbortSignal,
  ): Promise<CorporateAction[]> {
    const range = sessions <= 130 ? '6mo' : sessions <= 260 ? '1y' : '2y';
    const { actions } = await this.fetchChart(symbol.toUpperCase(), range, signal);
    return actions;
  }

  async resolve(
    symbol: string,
    signal?: AbortSignal,
  ): Promise<{
    symbol: string;
    name: string;
    exchange?: string;
    currency?: string;
    sector?: string;
  }> {
    const sym = symbol.toUpperCase();
    const { meta } = await this.fetchChart(sym, '5d', signal);

    return {
      symbol: meta.symbol ?? sym,
      name: meta.longName ?? meta.shortName ?? sym,
      exchange: meta.fullExchangeName ?? meta.exchangeName,
      currency: meta.currency ?? 'USD',
      // The chart endpoint carries no sector. Left undefined rather than
      // guessed; the UI already handles a missing sector.
      sector: undefined,
    };
  }
}
