/**
 * Turning several providers' answers into one number we are willing to show,
 * plus an honest statement of how much we trust it.
 *
 * The rule this module exists to enforce: **never silently pick a winner.**
 *
 * When two feeds disagree about what a stock is worth, the naive move is to
 * take the first one and carry on. That is how a watchlist ends up telling
 * someone their position moved 3% when it did not. Here, a disagreement beyond
 * tolerance is recorded on the quote, lowers its confidence, and is surfaced
 * to the user - because "our sources disagree about this price" is itself
 * information they need, and often more urgent than the price.
 */

import type { Freshness, Quote, QuoteConflict, RawQuote } from '../domain/types.js';

export interface ReconcileOptions {
  /** Relative price disagreement above which we call it a conflict. */
  tolerance: number;
  /** Freshness thresholds, so confidence can reflect staleness. */
  freshMs: number;
  delayedMs: number;
  staleMs: number;
  /** Provider preference: earlier names win ties. */
  preference: readonly string[];
  /** How many bars of history this symbol has, for the confidence penalty. */
  bars?: number;
  minBarsForStats?: number;
  /**
   * Market state, so freshness can be judged against the *market's* clock
   * rather than the wall clock. Without these, every price is "stale" all
   * weekend even though nothing has traded to make it so.
   */
  marketOpen?: boolean;
  /** Canonical timestamp of the last completed session. */
  lastSessionCloseAt?: number;
}

export function classifyFreshness(
  asOf: number,
  now: number,
  o: Pick<
    ReconcileOptions,
    'freshMs' | 'delayedMs' | 'staleMs' | 'marketOpen' | 'lastSessionCloseAt'
  >,
): Freshness {
  const age = now - asOf;

  // A timestamp meaningfully in the future means a broken clock somewhere.
  // "unknown" is the honest label: we cannot place it on the ladder at all.
  if (age < -60_000) return 'unknown';

  /*
   * When the market is shut, age against the wall clock is meaningless.
   *
   * A price stamped at Friday's close is the correct, current, actionable
   * price on Saturday - there has been no trading to miss. Judging it by
   * wall-clock age marks it stale, which both cries wolf and suppresses the
   * statistical analysis that is still perfectly valid.
   *
   * It is only genuinely stale if it predates the last completed session:
   * that means we missed a whole session, which *is* a failure.
   */
  if (o.marketOpen === false && typeof o.lastSessionCloseAt === 'number') {
    // A little grace, since the closing print can lag the bell slightly.
    const GRACE_MS = 90 * 60_000;
    if (asOf >= o.lastSessionCloseAt - GRACE_MS) return 'closed';
    return 'stale';
  }

  if (age <= o.freshMs) return 'fresh';
  if (age <= o.delayedMs) return 'delayed';
  return 'stale';
}

/**
 * Confidence in a price, on 0..1.
 *
 * Deliberately multiplicative: each independent reason for doubt compounds.
 * A stale price from disagreeing sources on a thinly-historied instrument
 * should end up obviously untrustworthy, not merely slightly discounted.
 */
export function computeConfidence(args: {
  freshness: Freshness;
  conflictSpread: number | null;
  tolerance: number;
  halted: boolean;
  bars?: number;
  minBarsForStats?: number;
}): number {
  let c = 1;

  switch (args.freshness) {
    case 'fresh':
      break;
    // A closing price during a closed market is fully trustworthy.
    case 'closed':
      break;
    case 'delayed':
      c *= 0.85;
      break;
    case 'stale':
      c *= 0.4;
      break;
    case 'unknown':
      c *= 0.3;
      break;
  }

  if (args.conflictSpread !== null && args.conflictSpread > args.tolerance) {
    // Scale the penalty by how badly they disagree: a 0.6% spread is a rounding
    // difference between venues, a 6% spread means one of them is simply wrong.
    const excess = args.conflictSpread / Math.max(args.tolerance, 1e-9);
    c *= Math.max(0.25, 1 / (1 + Math.log2(excess)));
  }

  // A halted instrument's last price is real but no longer actionable.
  if (args.halted) c *= 0.6;

  // Thin history means the *statistics* around the price are unreliable, which
  // is what the signal engine actually consumes.
  if (args.bars !== undefined && args.minBarsForStats !== undefined) {
    if (args.bars < args.minBarsForStats) {
      c *= Math.max(0.35, args.bars / Math.max(args.minBarsForStats, 1));
    }
  }

  return Math.max(0, Math.min(1, c));
}

/**
 * Reconcile raw quotes from one or more providers into a single stored quote.
 *
 * Resolution policy, in order:
 *
 *  1. Discard anything non-finite or non-positive. A provider returning 0 or
 *     NaN for a price is a bug we must not propagate as a -100% move.
 *  2. If the sources agree within tolerance, take the most preferred provider's
 *     price - agreement means the choice does not matter much, so prefer the
 *     source we trust generally.
 *  3. If they disagree, take the **median** rather than the freshest. With
 *     three or more sources the median is robust to one bad feed; the freshest
 *     is not, and a single broken provider updating quickly would otherwise
 *     win every time. With exactly two, the median is their midpoint, which is
 *     wrong for neither in a way that is easy to explain.
 *  4. Either way, record the disagreement and let it lower confidence.
 */
export function reconcileQuotes(
  raws: readonly RawQuote[],
  now: number,
  opts: ReconcileOptions,
): Quote | null {
  const usable = raws.filter(
    (r) =>
      Number.isFinite(r.price) &&
      r.price > 0 &&
      Number.isFinite(r.asOf) &&
      Number.isFinite(r.prevClose) &&
      r.prevClose > 0,
  );
  if (usable.length === 0) return null;

  const prices = usable.map((r) => r.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const mid = (min + max) / 2;
  const spread = mid > 0 ? (max - min) / mid : 0;

  const rank = (name: string): number => {
    const i = opts.preference.indexOf(name);
    return i === -1 ? opts.preference.length : i;
  };

  const byPreference = [...usable].sort((a, b) => {
    const d = rank(a.source) - rank(b.source);
    // Freshness is the tie-break within equal preference.
    return d !== 0 ? d : b.asOf - a.asOf;
  });

  const conflicted = usable.length > 1 && spread > opts.tolerance;

  let price: number;
  let resolution: QuoteConflict['resolution'];

  if (usable.length === 1) {
    price = (byPreference[0] as RawQuote).price;
    resolution = 'single';
  } else if (conflicted) {
    price = median(prices);
    resolution = 'median';
  } else {
    price = (byPreference[0] as RawQuote).price;
    resolution = 'preferred';
  }

  // Non-price fields come from the preferred source, so the whole quote stays
  // internally consistent (an open from one feed and a high from another can
  // easily produce high < open).
  const lead = byPreference[0] as RawQuote;

  // Take the newest asOf across sources: it is the best evidence of how recent
  // our knowledge is, regardless of which price we chose.
  const asOf = Math.max(...usable.map((r) => r.asOf));
  const freshness = classifyFreshness(asOf, now, opts);
  const halted = usable.some((r) => r.halted === true);

  const conflict: QuoteConflict | null = conflicted
    ? {
        spread,
        resolution,
        quotes: usable.map((r) => ({ source: r.source, price: r.price, asOf: r.asOf })),
      }
    : null;

  const confidence = computeConfidence({
    freshness,
    conflictSpread: conflicted ? spread : null,
    tolerance: opts.tolerance,
    halted,
    bars: opts.bars,
    minBarsForStats: opts.minBarsForStats,
  });

  // Clamp the range to include the chosen price. If we took a median that sits
  // outside the leader's reported high/low, the stored quote would otherwise
  // claim a price outside its own day range - which downstream ATR and range
  // logic would treat as a breakout.
  const dayHigh = Math.max(lead.dayHigh, price);
  const dayLow = Math.min(lead.dayLow, price);

  return {
    symbol: lead.symbol,
    price,
    prevClose: lead.prevClose,
    dayOpen: lead.dayOpen,
    dayHigh,
    dayLow,
    volume: Math.max(...usable.map((r) => (Number.isFinite(r.volume) ? r.volume : 0))),
    asOf,
    receivedAt: now,
    source: usable.length === 1 ? lead.source : usable.map((r) => r.source).sort().join('+'),
    confidence,
    halted,
    conflict,
  };
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}
