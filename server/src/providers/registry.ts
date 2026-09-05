/**
 * The provider registry: everything that makes talking to an upstream safe.
 *
 * Providers themselves are dumb - they know how to phrase one request. All the
 * behaviour that keeps a flaky dependency from taking the product down lives
 * here, once, and applies to every provider uniformly:
 *
 *   request -> single-flight -> rate limit -> circuit breaker -> retry
 *           -> timeout -> reconcile -> confidence
 *
 * The ordering matters and is not arbitrary:
 *
 *  - **Single-flight first.** Deduplicating identical concurrent requests
 *    before they consume rate-limit tokens is the difference between a
 *    40-symbol refresh costing 40 upstream calls and costing 80.
 *  - **Rate limit before the breaker**, so a throttled request is skipped
 *    rather than counted as a provider failure - our own budget running out
 *    is not evidence the provider is unhealthy.
 *  - **Breaker outside retry.** Retrying against an open breaker is pointless
 *    work; the breaker's job is to stop us generating the load at all.
 */

import { createLogger } from '../infra/logger.js';
import {
  CircuitBreaker,
  LatencyWindow,
  SingleFlight,
  TokenBucket,
  withTimeout,
  retry,
} from '../infra/resilience.js';
import type { Clock } from '../infra/clock.js';
import type { MarketClock } from '../domain/marketClock.js';
import { systemClock } from '../infra/clock.js';
import type {
  Bar,
  CorporateAction,
  ProviderHealth,
  Quote,
  RawQuote,
} from '../domain/types.js';
import {
  SymbolNotFoundError,
  TransientProviderError,
  type MarketDataProvider,
} from './types.js';
import { reconcileQuotes, type ReconcileOptions } from './reconcile.js';

const log = createLogger('providers');

export interface RegistryOptions {
  breaker: {
    windowMs: number;
    minSamples: number;
    failureRatio: number;
    openMs: number;
    halfOpenProbes: number;
  };
  requestTimeoutMs: number;
  reconcile: Omit<ReconcileOptions, 'preference'>;
  retry?: { attempts: number; baseMs: number; maxMs: number };
  clock?: Clock;
  /**
   * The market clock, so freshness is judged against trading hours rather than
   * the wall clock - see classifyFreshness.
   */
  marketClock: MarketClock;
}

/**
 * Raised when no provider was even *attempted* because our own rate limiter
 * held them all back.
 *
 * Deliberately distinct from AllProvidersFailedError. Conflating the two was a
 * real bug: our own budget running out was being recorded as an upstream
 * failure, which tripped the circuit breaker against a provider that was
 * answering every request in half a second, and drove the scheduler into
 * exponential backoff. A protective mechanism that reports itself as an outage
 * is worse than no protection at all.
 */
export class LocallyThrottledError extends Error {
  constructor(
    readonly symbol: string,
    readonly retryAfterMs: number,
  ) {
    super(`local rate limit reached for ${symbol}; retry in ${retryAfterMs}ms`);
    this.name = 'LocallyThrottledError';
  }
}

/** Raised when every configured provider refused or failed. */
export class AllProvidersFailedError extends Error {
  constructor(
    readonly symbol: string,
    readonly reasons: ReadonlyArray<{ provider: string; error: string }>,
  ) {
    super(
      `no provider could quote ${symbol}: ` +
        reasons.map((r) => `${r.provider}=${r.error}`).join(', '),
    );
    this.name = 'AllProvidersFailedError';
  }
}

interface Entry {
  provider: MarketDataProvider;
  breaker: CircuitBreaker;
  bucket: TokenBucket;
  latency: LatencyWindow;
  lastError: string | null;
  lastOkAt: number | null;
  skipped: number;
}

export class ProviderRegistry {
  private readonly entries: Entry[] = [];
  private readonly quoteFlight = new SingleFlight<Quote>();
  private readonly historyFlight = new SingleFlight<Bar[]>();
  private readonly clock: Clock;

  constructor(
    providers: readonly MarketDataProvider[],
    private readonly opts: RegistryOptions,
  ) {
    this.clock = opts.clock ?? systemClock;

    for (const provider of providers) {
      this.entries.push({
        provider,
        breaker: new CircuitBreaker(provider.name, opts.breaker, this.clock),
        /*
         * Capacity is a full minute's allowance, refilled continuously.
         *
         * A smaller bucket looks more careful and is actually worse: the
         * scheduler claims a *batch* of symbols at once, so a capacity below
         * the batch size guarantees the tail of every batch is refused before
         * a single request has actually been sent. That is self-inflicted
         * throttling, not politeness. A full-minute burst followed by a steady
         * drip is what "30 per minute" is supposed to mean.
         */
        bucket: new TokenBucket(
          Math.max(1, provider.capabilities.requestsPerMinute),
          provider.capabilities.requestsPerMinute / 60,
          this.clock,
        ),
        latency: new LatencyWindow(128),
        lastError: null,
        lastOkAt: null,
        skipped: 0,
      });
    }

    if (this.entries.length === 0) throw new Error('registry needs at least one provider');
    log.info('registry ready', { providers: this.entries.map((e) => e.provider.name).join(',') });
  }

  get providerNames(): string[] {
    return this.entries.map((e) => e.provider.name);
  }

  /** Preference order for reconciliation: registration order. */
  private get preference(): string[] {
    return this.providerNames;
  }

  // ───────────────────────────────────────────────────── quotes

  /**
   * Fetch and reconcile a quote from every available provider.
   *
   * `bars` is passed through purely so confidence can be penalised for thin
   * history - the registry does not otherwise know about instruments.
   */
  async getQuote(symbol: string, bars?: number): Promise<Quote> {
    return this.quoteFlight.run(`q:${symbol}`, async () => {
      const raws: RawQuote[] = [];
      const reasons: Array<{ provider: string; error: string }> = [];
      let notFoundCount = 0;
      let throttledCount = 0;
      let soonestRetryMs = Number.POSITIVE_INFINITY;

      // Providers are queried in parallel: a slow one must not delay a fast
      // one, and the timeout is per-provider.
      await Promise.all(
        this.entries.map(async (entry) => {
          const outcome = await this.call(entry, `quote:${symbol}`, (signal) =>
            entry.provider.getQuote(symbol, signal),
          );

          if (outcome.ok) {
            raws.push(outcome.value);
          } else {
            if (outcome.notFound) notFoundCount++;
            if (outcome.throttled) {
              throttledCount++;
              soonestRetryMs = Math.min(soonestRetryMs, outcome.retryAfterMs);
            }
            reasons.push({ provider: entry.provider.name, error: outcome.error });
          }
        }),
      );

      if (raws.length === 0) {
        // Unanimous "never heard of it" is a different fact from "everyone is
        // down", and the caller needs to distinguish them: one means stop
        // asking, the other means try again shortly.
        if (notFoundCount === this.entries.length) throw new SymbolNotFoundError(symbol);
        // Nobody was even asked - our own budget, not their health.
        if (throttledCount === this.entries.length) {
          throw new LocallyThrottledError(symbol, Number.isFinite(soonestRetryMs) ? soonestRetryMs : 1000);
        }
        throw new AllProvidersFailedError(symbol, reasons);
      }

      const now = this.clock.now();
      const quote = reconcileQuotes(raws, now, {
        ...this.opts.reconcile,
        preference: this.preference,
        bars,
        marketOpen: this.opts.marketClock.isOpen(now),
        lastSessionCloseAt: this.opts.marketClock.lastCompletedSessionAt(now),
      });

      if (!quote) {
        throw new AllProvidersFailedError(symbol, [
          ...reasons,
          { provider: 'reconcile', error: 'all quotes were unusable' },
        ]);
      }

      if (quote.conflict) {
        log.warn('provider disagreement', {
          symbol,
          spread: quote.conflict.spread,
          resolution: quote.conflict.resolution,
        });
      }

      return quote;
    });
  }

  // ───────────────────────────────────────────────────── history

  /**
   * Daily bars from the most preferred provider that can supply them.
   *
   * History is not reconciled across providers. Merging two vendors' bar
   * series is a genuinely hard problem (different adjustment conventions,
   * different session boundaries) and getting it subtly wrong would corrupt
   * every volatility estimate. Taking one coherent series is the honest
   * choice; the fallback is to the next provider, not to a blend.
   */
  async getHistory(symbol: string, sessions: number): Promise<Bar[]> {
    return this.historyFlight.run(`h:${symbol}:${sessions}`, async () => {
      const reasons: Array<{ provider: string; error: string }> = [];

      for (const entry of this.entries) {
        if (!entry.provider.capabilities.history) continue;

        const outcome = await this.call(entry, `history:${symbol}`, (signal) =>
          entry.provider.getHistory(symbol, sessions, signal),
        );

        if (outcome.ok && outcome.value.length > 0) return outcome.value;
        if (!outcome.ok) reasons.push({ provider: entry.provider.name, error: outcome.error });
      }

      if (reasons.length === 0) return [];
      throw new AllProvidersFailedError(symbol, reasons);
    });
  }

  /**
   * Splits and dividends from the first provider that reports them.
   *
   * Not reconciled across providers: two vendors disagreeing about whether
   * a split happened is not something to average. Take the first coherent
   * answer, or none.
   */
  async getCorporateActions(symbol: string, sessions: number): Promise<CorporateAction[]> {
    for (const entry of this.entries) {
      if (!entry.provider.getCorporateActions) continue;
      const outcome = await this.call(entry, `actions:${symbol}`, (signal) =>
        entry.provider.getCorporateActions!(symbol, sessions, signal),
      );
      if (outcome.ok) return outcome.value;
    }
    return [];
  }

  async resolve(symbol: string): Promise<{
    symbol: string;
    name: string;
    exchange?: string;
    currency?: string;
    sector?: string;
  } | null> {
    for (const entry of this.entries) {
      if (!entry.provider.resolve) continue;
      const outcome = await this.call(entry, `resolve:${symbol}`, (signal) =>
        entry.provider.resolve!(symbol, signal),
      );
      if (outcome.ok) return outcome.value;
      if (outcome.notFound) return null;
    }
    return null;
  }

  // ───────────────────────────────────────────────────── the guarded call

  /**
   * One guarded upstream call.
   *
   * Returns a result object rather than throwing, because the caller's job is
   * to aggregate across providers - a failure here is expected input to that
   * decision, not an exception to propagate.
   */
  private async call<T>(
    entry: Entry,
    label: string,
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<
    | { ok: true; value: T }
    | { ok: false; error: string; notFound: boolean; throttled: boolean; retryAfterMs: number }
  > {
    if (!entry.bucket.tryTake()) {
      entry.skipped++;
      const retryAfterMs = entry.bucket.waitMs();
      // Not a failure. We chose not to ask.
      return {
        ok: false,
        error: `rate limited locally (retry in ${retryAfterMs}ms)`,
        notFound: false,
        throttled: true,
        retryAfterMs,
      };
    }

    if (!entry.breaker.canAttempt()) {
      entry.skipped++;
      return {
        ok: false,
        error: 'circuit open',
        notFound: false,
        throttled: false,
        retryAfterMs: 0,
      };
    }

    const started = this.clock.now();

    try {
      const value = await retry(
        () => withTimeout(this.opts.requestTimeoutMs, (signal) => fn(signal)),
        {
          attempts: this.opts.retry?.attempts ?? 2,
          baseMs: this.opts.retry?.baseMs ?? 150,
          maxMs: this.opts.retry?.maxMs ?? 1200,
          // Never retry a permanent answer. Retrying "unknown symbol" burns
          // the rate-limit budget on a request that cannot ever succeed.
          isRetryable: (err) => !(err instanceof SymbolNotFoundError),
          onRetry: (attempt, delayMs, err) =>
            log.debug('retrying', {
              provider: entry.provider.name,
              label,
              attempt,
              delayMs,
              err: err instanceof Error ? err.message : String(err),
            }),
        },
      );

      entry.breaker.recordSuccess();
      entry.latency.record(this.clock.now() - started);
      entry.lastOkAt = this.clock.now();
      entry.lastError = null;
      return { ok: true, value };
    } catch (err) {
      const notFound = err instanceof SymbolNotFoundError;
      const message = err instanceof Error ? err.message : String(err);

      // A symbol that does not exist is not the provider's fault, so it must
      // not count toward the failure ratio. Without this carve-out, one user
      // adding a handful of typo'd tickers would trip the breaker for
      // everybody.
      if (!notFound) {
        entry.breaker.recordFailure(err);
        entry.lastError = message;
      }

      entry.latency.record(this.clock.now() - started);
      return { ok: false, error: message, notFound, throttled: false, retryAfterMs: 0 };
    }
  }

  // ───────────────────────────────────────────────────── health

  health(): ProviderHealth[] {
    return this.entries.map((e) => {
      const snap = e.breaker.snapshot();
      return {
        provider: e.provider.name,
        breaker: snap.state,
        ok: snap.ok,
        fail: snap.fail,
        p95Ms: e.latency.percentile(95),
        lastError: e.lastError,
        lastOkAt: e.lastOkAt,
      };
    });
  }

  /** Diagnostics for the data-health panel. */
  diagnostics(): Record<string, unknown> {
    return {
      inflight: { quotes: this.quoteFlight.size, history: this.historyFlight.size },
      providers: this.entries.map((e) => ({
        name: e.provider.name,
        tokensAvailable: Math.floor(e.bucket.available),
        requestsPerMinute: e.provider.capabilities.requestsPerMinute,
        skippedRequests: e.skipped,
        delayed: e.provider.capabilities.delayed,
        supportsHistory: e.provider.capabilities.history,
        ...e.breaker.snapshot(),
      })),
    };
  }

  /** Force a provider's breaker open. Used by the fault-injection endpoints. */
  tripBreaker(providerName: string): boolean {
    const e = this.entries.find((x) => x.provider.name === providerName);
    if (!e) return false;
    e.breaker.forceOpen();
    e.lastError = 'manually tripped';
    return true;
  }

  resetBreakers(): void {
    for (const e of this.entries) {
      e.breaker.reset();
      e.lastError = null;
      e.skipped = 0;
    }
  }
}

/** Re-exported so callers can classify errors without importing two modules. */
export { SymbolNotFoundError, TransientProviderError };
