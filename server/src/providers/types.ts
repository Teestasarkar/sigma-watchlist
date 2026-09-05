/**
 * The market data provider contract.
 *
 * Deliberately narrow. A provider knows how to answer three questions and
 * nothing else - it does no caching, no retrying, no rate limiting and no
 * reconciliation. All of that lives in the registry, so it is implemented once
 * and applies uniformly rather than being re-invented (differently, and with
 * different bugs) per vendor.
 */

import type { Bar, CorporateAction, RawQuote } from '../domain/types.js';

export interface ProviderCapabilities {
  /** Can this provider return historical daily bars, or only live quotes? */
  history: boolean;
  /** Nominal request budget, used to size the token bucket. */
  requestsPerMinute: number;
  /** True if prices are delayed rather than real-time, so we can label them. */
  delayed: boolean;
}

export class SymbolNotFoundError extends Error {
  constructor(readonly symbol: string) {
    super(`unknown symbol: ${symbol}`);
    this.name = 'SymbolNotFoundError';
  }
}

/**
 * A provider failure that is worth retrying (timeout, 5xx, socket reset), as
 * opposed to one that is not (unknown symbol, bad key). The distinction stops
 * us from burning the retry budget and the rate limit on requests that will
 * never succeed.
 */
export class TransientProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'TransientProviderError';
  }
}

export interface MarketDataProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;

  /** Live (or delayed) quote for one symbol. */
  getQuote(symbol: string, signal?: AbortSignal): Promise<RawQuote>;

  /** Daily bars, oldest first. May return fewer than requested. */
  getHistory(symbol: string, days: number, signal?: AbortSignal): Promise<Bar[]>;

  /**
   * Splits and dividends over the requested window, if the provider
   * reports them. Optional: a provider that cannot say is not broken, it
   * just means adjusted closes are the only correction available.
   */
  getCorporateActions?(
    symbol: string,
    sessions: number,
    signal?: AbortSignal,
  ): Promise<CorporateAction[]>;

  /** Instrument metadata, if the provider offers it. */
  resolve?(symbol: string, signal?: AbortSignal): Promise<{
    symbol: string;
    name: string;
    exchange?: string;
    currency?: string;
    sector?: string;
  }>;
}
