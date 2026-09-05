/**
 * A second live quote source, so reconciliation is demonstrated rather than
 * merely implemented.
 *
 * Cross-vendor conflict detection is one of the more interesting things this
 * system does, and with a single provider it is dead code - the median is
 * never taken, the spread is always zero, the confidence penalty never fires.
 * Every alternative I looked at wanted an API key, which turns "watch two
 * feeds disagree" into something a reviewer has to go and arrange. CNBC's
 * public quote service does not, and it is genuinely independent of Yahoo: a
 * different vendor, a different consolidator, different rounding, and
 * occasionally a different last print.
 *
 * **Quotes only.** History stays with Yahoo. Merging two vendors' bar series
 * means reconciling different split-adjustment conventions and different
 * session boundaries, and getting that subtly wrong would corrupt every
 * volatility estimate downstream - which is the number the entire product is
 * built on. One coherent history is worth more than two blended ones.
 *
 * The same caveat as Yahoo applies, and is precisely what the breaker, the
 * limiter and the provider ordering exist for: this is an undocumented
 * endpoint that owes us nothing.
 */

import type { Bar, RawQuote } from '../domain/types.js';
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

const log = createLogger('cnbc');

const ENDPOINT = 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol';

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
  Accept: 'application/json,text/plain,*/*',
} as const;

interface CnbcQuote {
  symbol?: string;
  /** 0 on success. Anything else means the symbol was not recognised. */
  code?: number;
  last?: string;
  open?: string;
  high?: string;
  low?: string;
  volume?: string;
  previous_day_closing?: string;
  /** Session date of the last print, as `YYYY-MM-DD`. No time component. */
  last_time?: string;
  curmktstatus?: string;
}

interface CnbcResponse {
  FormattedQuoteResult?: { FormattedQuote?: CnbcQuote[] };
}

/**
 * Parse a display-formatted number.
 *
 * This payload is built for a web page, not for a machine: volume arrives as
 * `"35,660,636"` and percentages as `"-2.51%"`. `Number()` returns NaN for
 * both, and a NaN would sail straight into a price field.
 */
function parseNumber(value: string | undefined): number | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[,%$\s]/g, '');
  if (cleaned === '' || cleaned === '-') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

interface Pending {
  resolve: (q: RawQuote) => void;
  reject: (err: unknown) => void;
}

export class CnbcProvider implements MarketDataProvider {
  readonly name = 'cnbc';

  readonly capabilities: ProviderCapabilities = {
    // Yahoo owns history; see the file header.
    history: false,
    /*
     * Sized generously on purpose. The registry spends one token per *symbol*,
     * but micro-batching below collapses a whole refresh cycle into a single
     * HTTP request - so the bucket counts roughly a dozen times more traffic
     * than actually leaves the process. Over-counting is the safe direction,
     * and the headroom keeps us from refusing our own batch.
     */
    requestsPerMinute: 120,
    delayed: false,
  };

  /**
   * Micro-batching.
   *
   * The endpoint accepts many symbols in one request, and a refresh cycle asks
   * for a dozen of them within milliseconds of each other. Coalescing turns
   * twelve round trips into one - which matters most under an undocumented
   * rate limit, where the cost of finding the ceiling is being cut off.
   *
   * This is deliberately *not* the registry's single-flight, which collapses
   * identical concurrent calls. This collapses *different* ones that happen to
   * be in flight together, which is the actual shape of the workload here.
   */
  private readonly pending = new Map<string, Pending[]>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  /** How long to wait for companions before firing the batch. */
  private readonly batchWindowMs: number;
  private readonly maxBatch = 20;

  constructor(
    private readonly marketClock: MarketClock,
    private readonly wall: Clock = systemClock,
    opts: { batchWindowMs?: number } = {},
  ) {
    this.batchWindowMs = opts.batchWindowMs ?? 25;
  }

  async getQuote(symbol: string, signal?: AbortSignal): Promise<RawQuote> {
    const sym = symbol.toUpperCase();

    return new Promise<RawQuote>((resolve, reject) => {
      // An already-aborted signal never emits the event, so check first.
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });

      const waiters = this.pending.get(sym);
      if (waiters) waiters.push({ resolve, reject });
      else this.pending.set(sym, [{ resolve, reject }]);

      if (this.pending.size >= this.maxBatch) {
        void this.flush();
        return;
      }
      this.flushTimer ??= setTimeout(() => void this.flush(), this.batchWindowMs);
    });
  }

  /** Fetch everything queued, then settle each caller with its own result. */
  private async flush(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const batch = new Map(this.pending);
    this.pending.clear();
    if (batch.size === 0) return;

    try {
      const quotes = await this.fetchBatch([...batch.keys()]);

      for (const [sym, waiters] of batch) {
        const raw = quotes.get(sym);
        for (const w of waiters) {
          if (raw) w.resolve(raw);
          // Absent from a response that did arrive means CNBC does not know
          // the symbol - a permanent answer, so the registry stops retrying.
          else w.reject(new SymbolNotFoundError(sym));
        }
      }
    } catch (err) {
      // A transport failure fails everyone in the batch, which is correct:
      // they were all one request.
      for (const waiters of batch.values()) {
        for (const w of waiters) w.reject(err);
      }
    }
  }

  private async fetchBatch(symbols: readonly string[]): Promise<Map<string, RawQuote>> {
    const url = new URL(ENDPOINT);
    url.searchParams.set('symbols', symbols.join('|'));
    url.searchParams.set('requestMethod', 'itv');
    url.searchParams.set('noform', '1');
    url.searchParams.set('partnerId', '2');
    url.searchParams.set('fund', '1');
    url.searchParams.set('exthrs', '1');
    url.searchParams.set('output', 'json');

    const res = await fetch(url, { headers: HEADERS });

    if (res.status === 429) throw new TransientProviderError('cnbc rate limit exceeded', 429);
    if (res.status >= 500) {
      throw new TransientProviderError(`cnbc upstream ${res.status}`, res.status);
    }
    if (!res.ok) throw new TransientProviderError(`cnbc responded ${res.status}`, res.status);

    let body: CnbcResponse;
    try {
      body = (await res.json()) as CnbcResponse;
    } catch {
      throw new TransientProviderError('cnbc returned a non-JSON body', res.status);
    }

    const out = new Map<string, RawQuote>();
    const now = this.wall.now();

    for (const q of body.FormattedQuoteResult?.FormattedQuote ?? []) {
      const sym = (q.symbol ?? '').toUpperCase();
      if (sym === '') continue;

      // A non-zero code means the symbol was not recognised. The response
      // still carries an entry for it, so this flag is the only way to tell.
      if (typeof q.code === 'number' && q.code !== 0) continue;

      const price = parseNumber(q.last);
      const prevClose = parseNumber(q.previous_day_closing);
      if (price === null || price <= 0 || prevClose === null || prevClose <= 0) continue;

      const open = parseNumber(q.open) ?? prevClose;
      const high = parseNumber(q.high) ?? Math.max(open, price);
      const low = parseNumber(q.low) ?? Math.min(open, price);

      out.set(sym, {
        symbol: sym,
        price,
        prevClose,
        dayOpen: open,
        // Clamp so the range always contains the price. If CNBC's last print
        // is an extended-hours trade outside the regular-session range, an
        // unclamped high/low would read downstream as a range breakout.
        dayHigh: Math.max(high, price),
        dayLow: Math.min(low, price),
        volume: parseNumber(q.volume) ?? 0,
        asOf: this.asOfFor(q.last_time, now),
        source: this.name,
        halted: false,
      });
    }

    if (out.size === 0) log.debug('cnbc returned no usable quotes', { requested: symbols.length });

    return out;
  }

  /**
   * Turn CNBC's session date into a timestamp on the same coordinate system
   * everything else uses.
   *
   * This matters more than it looks. The payload carries a *date* and no time
   * - I checked every field, including the extended-hours block - so the
   * tempting shortcut is to stamp the quote with our own receive time. That
   * would be actively harmful: `reconcileQuotes` takes the newest `asOf`
   * across sources, so a receive-time stamp would win every comparison and
   * drag the reconciled quote's freshness to "fresh" permanently. All weekend,
   * with the exchange shut and Yahoo correctly reporting Friday's close, the
   * quote would claim to be seconds old. That silently disables the `closed`
   * freshness state and the stale-data detector along with it.
   *
   * So the date is mapped to that session's closing bell, which is exactly the
   * canonical instant Yahoo's bars and every checkpoint are keyed to.
   *
   * The clamp handles the live-session case, where that close has not happened
   * yet and claiming it would put `asOf` in the future - which classifies as
   * "unknown" and tanks confidence. During an open session this does degrade
   * to receive time, and that is a real limitation: we cannot detect CNBC
   * serving a half-hour-old intraday price, because it does not tell us. It is
   * also why CNBC is the secondary source and Yahoo, which timestamps
   * properly, is preferred.
   */
  private asOfFor(lastTime: string | undefined, now: number): number {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(lastTime ?? '');
    if (!m) return now;

    // 16:00 UTC is midday in New York under either DST offset, so it lands
    // inside the intended session no matter the time of year.
    const middayEt = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 16);
    if (!Number.isFinite(middayEt)) return now;

    return Math.min(this.marketClock.sessionCloseOf(middayEt), now);
  }

  /**
   * Unreachable: the registry skips providers that declare `history: false`.
   *
   * Throwing rather than returning `[]` on purpose. An empty history is not an
   * error anywhere downstream - it just means "no statistics", so a broken
   * guard would quietly switch the whole signal engine off for every symbol
   * instead of failing where the mistake is.
   */
  async getHistory(): Promise<Bar[]> {
    throw new Error('cnbc does not serve history; the registry should not have asked');
  }

  async resolve(symbol: string): Promise<{ symbol: string; name: string; currency?: string }> {
    const sym = symbol.toUpperCase();
    const found = (await this.fetchBatch([sym])).get(sym);
    if (!found) throw new SymbolNotFoundError(sym);
    // Yahoo resolves names and sectors; this only has to confirm the symbol is
    // real, and the registry takes the first provider that answers.
    return { symbol: sym, name: sym, currency: 'USD' };
  }
}
