/**
 * A real market data provider (Finnhub), to prove the abstraction holds.
 *
 * Nothing in the rest of the system changes when this is enabled - the same
 * registry wraps it in the same breaker, rate limiter and reconciliation, and
 * the same detectors consume its output. Set `FINNHUB_API_KEY` and
 * `PROVIDERS=finnhub,synthetic` and the simulator becomes the fallback for
 * whatever the live feed cannot answer.
 *
 * The awkward realities of a free tier, handled explicitly rather than
 * discovered in production:
 *
 *  - Daily candles moved behind a paid plan. A 403 on history is reported as
 *    "no history from this provider" so the registry falls through to the next
 *    one, rather than being treated as an outage that trips the breaker.
 *  - The quote endpoint returns zeros for an unknown symbol instead of a 404,
 *    so that has to be detected by value.
 *  - Timestamps are unix *seconds*.
 */

import type { Bar, RawQuote } from '../domain/types.js';
import type { MarketClock } from '../domain/marketClock.js';
import {
  SymbolNotFoundError,
  TransientProviderError,
  type MarketDataProvider,
  type ProviderCapabilities,
} from './types.js';
import { createLogger } from '../infra/logger.js';

const log = createLogger('finnhub');
const BASE = 'https://finnhub.io/api/v1';

interface FinnhubQuote {
  c: number; // current
  h: number; // high
  l: number; // low
  o: number; // open
  pc: number; // previous close
  t: number; // unix seconds
}

interface FinnhubCandles {
  s: string; // 'ok' | 'no_data'
  t?: number[];
  o?: number[];
  h?: number[];
  l?: number[];
  c?: number[];
  v?: number[];
}

interface FinnhubProfile {
  name?: string;
  exchange?: string;
  currency?: string;
  finnhubIndustry?: string;
}

export class FinnhubProvider implements MarketDataProvider {
  readonly name = 'finnhub';
  readonly capabilities: ProviderCapabilities = {
    history: true,
    // Free tier is 60/min. We stay under it; the registry's token bucket
    // enforces this locally so we never actually receive a 429.
    requestsPerMinute: 50,
    delayed: false,
  };

  /** Remembers a 403 on candles so we stop asking every cycle. */
  private historyForbidden = false;

  constructor(
    private readonly apiKey: string,
    private readonly clock: MarketClock,
  ) {
    if (!apiKey) throw new Error('FinnhubProvider requires an API key');
  }

  private async get<T>(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<T> {
    const url = new URL(`${BASE}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    // The key goes in a header rather than the query string so it cannot leak
    // through logs or error messages that echo the URL.
    const res = await fetch(url, {
      signal: signal ?? null,
      headers: { 'X-Finnhub-Token': this.apiKey, Accept: 'application/json' },
    });

    if (res.status === 429) {
      throw new TransientProviderError('finnhub rate limit exceeded', 429);
    }
    if (res.status === 403) {
      // Permanent for this endpoint, but not an outage. The caller decides.
      const err = new TransientProviderError('finnhub: forbidden (plan limit)', 403);
      throw err;
    }
    if (res.status >= 500) {
      throw new TransientProviderError(`finnhub upstream ${res.status}`, res.status);
    }
    if (!res.ok) {
      throw new TransientProviderError(`finnhub responded ${res.status}`, res.status);
    }

    return (await res.json()) as T;
  }

  async getQuote(symbol: string, signal?: AbortSignal): Promise<RawQuote> {
    const q = await this.get<FinnhubQuote>('/quote', { symbol }, signal);

    // Finnhub answers an unknown ticker with an all-zero payload and HTTP 200.
    // Treating that as a price of $0.00 would show a -100% move, so it has to
    // be caught here rather than downstream.
    if (!q || !Number.isFinite(q.c) || q.c <= 0 || !Number.isFinite(q.pc) || q.pc <= 0) {
      throw new SymbolNotFoundError(symbol);
    }

    const asOf = Number.isFinite(q.t) && q.t > 0 ? q.t * 1000 : Date.now();

    return {
      symbol: symbol.toUpperCase(),
      price: q.c,
      prevClose: q.pc,
      dayOpen: q.o > 0 ? q.o : q.pc,
      dayHigh: Math.max(q.h > 0 ? q.h : q.c, q.c),
      dayLow: Math.min(q.l > 0 ? q.l : q.c, q.c),
      // The free quote endpoint carries no volume. Zero is honest here; the
      // volume detector requires a positive median and will simply not fire.
      volume: 0,
      asOf,
      source: this.name,
      halted: false,
    };
  }

  async getHistory(symbol: string, days: number, signal?: AbortSignal): Promise<Bar[]> {
    if (this.historyForbidden) return [];

    const to = Math.floor(Date.now() / 1000);
    // Ask for calendar days, not sessions, since weekends return nothing.
    const from = to - Math.ceil(days * 1.5) * 86_400;

    let data: FinnhubCandles;
    try {
      data = await this.get<FinnhubCandles>(
        '/stock/candle',
        { symbol, resolution: 'D', from: String(from), to: String(to) },
        signal,
      );
    } catch (err) {
      if (err instanceof TransientProviderError && err.status === 403) {
        this.historyForbidden = true;
        log.warn('daily candles not available on this plan; history disabled for finnhub');
        return [];
      }
      throw err;
    }

    if (data.s !== 'ok' || !data.t || !data.c) return [];

    const bars: Bar[] = [];
    for (let i = 0; i < data.t.length; i++) {
      const ts = (data.t[i] as number) * 1000;
      const close = data.c[i] as number;
      if (!Number.isFinite(close) || close <= 0) continue;
      bars.push({
        symbol: symbol.toUpperCase(),
        ts: this.clock.sessionCloseOf(ts),
        open: (data.o?.[i] as number) ?? close,
        high: (data.h?.[i] as number) ?? close,
        low: (data.l?.[i] as number) ?? close,
        close,
        // Finnhub's candle endpoint returns unadjusted prices only.
        adjClose: null,
        volume: (data.v?.[i] as number) ?? 0,
        source: this.name,
      });
    }

    return bars;
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
    const p = await this.get<FinnhubProfile>('/stock/profile2', { symbol }, signal);
    if (!p || !p.name) throw new SymbolNotFoundError(symbol);
    return {
      symbol: symbol.toUpperCase(),
      name: p.name,
      exchange: p.exchange,
      currency: p.currency ?? 'USD',
      sector: p.finnhubIndustry,
    };
  }
}
