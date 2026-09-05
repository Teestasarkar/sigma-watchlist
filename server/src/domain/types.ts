/** Core domain vocabulary. Shared verbatim with the frontend via web/src/lib/types.ts. */

export type Millis = number;

// ─────────────────────────────────────────────────────────── market data

export interface Bar {
  symbol: string;
  /** Session close timestamp (epoch ms). One bar per trading day. */
  ts: Millis;
  open: number;
  high: number;
  low: number;
  /** The price it actually traded at. What a human should be shown. */
  close: number;
  /**
   * Close adjusted for splits and dividends. What statistics must use.
   *
   * Without it a 4-for-1 split is a -75% return, which poisons the volatility
   * estimate for a year and makes every subsequent sigma meaningless. The
   * provider's convention is that the *newest* bar's adjusted close equals its
   * raw close and history is scaled, so an adjusted series stays directly
   * comparable to the live price - no conversion needed at the boundary.
   *
   * Null when the provider does not supply one; callers fall back to `close`.
   */
  adjClose: number | null;
  volume: number;
  source: string;
}

/** A single provider's answer. Not yet reconciled or trusted. */
export interface RawQuote {
  symbol: string;
  price: number;
  prevClose: number;
  dayOpen: number;
  dayHigh: number;
  dayLow: number;
  volume: number;
  /** When the *market* produced this price, per the provider. */
  asOf: Millis;
  source: string;
  /** Provider-declared or inferred: does this venue think trading is halted? */
  halted?: boolean;
}

/**
 * How much to trust a stored price.
 *
 * `closed` is the state that is easy to miss and wrong to omit. A Friday
 * closing print read on a Saturday is not stale data we failed to fetch - it
 * *is* the current price, because there is no trading to have missed.
 * Collapsing it into `stale` makes the product cry wolf all weekend and, worse,
 * suppresses the market analysis that is still perfectly valid.
 */
export type Freshness = 'fresh' | 'delayed' | 'stale' | 'closed' | 'unknown';

/** Why we might not fully trust a price. Surfaced to the user, never swallowed. */
export interface QuoteConflict {
  /** Relative spread between the highest and lowest provider price. */
  spread: number;
  quotes: Array<{ source: string; price: number; asOf: Millis }>;
  /**
   * How the accepted price was chosen:
   *  - `single`    only one source was usable
   *  - `preferred` sources agreed, so the highest-priority one was taken
   *  - `median`    sources disagreed beyond tolerance, so we took the middle
   *                rather than trusting either extreme
   */
  resolution: 'single' | 'preferred' | 'median';
}

/** The reconciled, stored view of "what is this worth right now". */
export interface Quote {
  symbol: string;
  price: number;
  prevClose: number;
  dayOpen: number;
  dayHigh: number;
  dayLow: number;
  volume: number;
  asOf: Millis;
  receivedAt: Millis;
  /** Which provider(s) the accepted price came from. */
  source: string;
  /** 0..1 — degraded by staleness, conflict, and thin history. */
  confidence: number;
  halted: boolean;
  conflict: QuoteConflict | null;
}

/** Precomputed per-symbol statistics. Materialized on bar close, not per request. */
export interface InstrumentStats {
  symbol: string;
  computedAt: Millis;
  bars: number;
  /** Stdev of daily log returns (fraction, e.g. 0.021 = 2.1%/day). */
  sigmaDaily: number;
  /** Average true range as a fraction of price. */
  atrPct: number;
  /** Sensitivity to the market factor, from OLS on daily returns. */
  beta: number;
  /** Stdev of the market-adjusted (residual) daily return. */
  residSigma: number;
  /** Short-window vol, for regime detection. */
  sigmaShort: number;
  hi52w: number;
  lo52w: number;
  hi30d: number;
  lo30d: number;
  medVol20: number;
  sma20: number;
  sma50: number;
  /** Peak close in the trailing year — the reference for drawdown. */
  peak52w: number;
}

// ─────────────────────────────────────────────────────────── signals

export type SignalKind =
  | 'sigma_move'
  | 'idio_move'
  | 'gap'
  | 'range_break'
  | 'volume_spike'
  | 'trend_flip'
  | 'vol_regime'
  | 'drawdown'
  | 'stale_data'
  | 'data_conflict'
  | 'corporate_action';

export type Direction = 'up' | 'down' | 'neutral';

/**
 * A detected, de-duplicated change. Signals are computed **once per symbol**,
 * globally — never per user. Personalisation happens at read time by comparing
 * `detectedAt` against the reader's watermark.
 */
export interface Signal {
  id: string;
  symbol: string;
  kind: SignalKind;
  /**
   * Identifies the *episode* this signal belongs to. While a symbol stays above
   * the exit threshold it remains in one episode, so a stock that is 3σ up for
   * two days produces one signal, not one per poll.
   */
  episodeKey: string;
  direction: Direction;
  /** 0..1 normalised intensity, comparable across kinds. */
  severity: number;
  detectedAt: Millis;
  /** Market timestamp the detection was based on. */
  asOf: Millis;
  headline: string;
  /** The numbers behind the claim, so the UI can show its work. */
  evidence: Record<string, number | string | boolean>;
  /** Set when a later signal of the same kind replaces this one. */
  supersededAt: Millis | null;
}

/** A signal plus the per-reader context that makes it rankable. */
export interface ScoredSignal extends Signal {
  score: number;
  /** Human-readable justification for the ranking. */
  rationale: string;
  isRead: boolean;
}

// ─────────────────────────────────────────────────────────── user state

/**
 * A split or a dividend.
 *
 * Recorded because it is the one kind of price change that is not news, and
 * that a naive watchlist reports as catastrophe: a 10-for-1 split looks like
 * -90%. Recording it lets us adjust the user's checkpoint instead of alarming
 * them, and tell them we did.
 */
export interface CorporateAction {
  symbol: string;
  /** Effective session, as a canonical timestamp. */
  ts: Millis;
  kind: 'split' | 'dividend';
  /** For a split: shares after. A 10-for-1 has numerator 10. */
  numerator: number;
  denominator: number;
  /** For a dividend: amount per share. */
  amount: number | null;
  detectedAt: Millis;
}

export interface User {
  id: string;
  handle: string;
  createdAt: Millis;
}

export interface Watchlist {
  id: string;
  userId: string;
  name: string;
  createdAt: Millis;
  /** Bumped on every mutation; clients send it back for optimistic concurrency. */
  version: number;
}

export interface WatchlistItem {
  symbol: string;
  addedAt: Millis;
  pinned: boolean;
  muted: boolean;
  /** Per-symbol override: don't tell me about moves smaller than this many sigma. */
  minSigma: number | null;
  note: string | null;
  sortKey: number;
}

/**
 * The watermark. This is the heart of the product: it records the last state of
 * the world the user actually acknowledged, so "what changed" has a fixed
 * reference point that a page refresh cannot destroy.
 */
export interface SymbolMark {
  symbol: string;
  seenAt: Millis;
  seenPrice: number | null;
  /** One level of undo, so "Catch me up" is a safe, reversible action. */
  prevSeenAt: Millis | null;
  prevSeenPrice: number | null;
}

// ─────────────────────────────────────────────────────────── read models

/** One row of the watchlist view: price now, and the delta *since you looked*. */
export interface WatchRow {
  symbol: string;
  name: string;
  sector: string | null;
  item: WatchlistItem;
  quote: Quote | null;
  freshness: Freshness;
  stats: Pick<InstrumentStats, 'sigmaDaily' | 'atrPct' | 'beta' | 'bars'> | null;
  /** Change vs the user's watermark — the number this product is actually about. */
  sinceSeen: {
    from: number | null;
    fromAt: Millis | null;
    changePct: number | null;
    /** Move expressed in standard deviations over the elapsed horizon. */
    sigma: number | null;
  };
  /** Conventional today's-change, kept because people expect to see it. */
  today: { changePct: number | null };
  rvol: number | null;
  openSignals: number;
  topSignal: Signal | null;
}

export interface DigestGroup {
  symbol: string;
  name: string;
  signals: ScoredSignal[];
  topScore: number;
}

export interface Digest {
  generatedAt: Millis;
  /** The window this briefing covers. */
  window: { from: Millis; to: Millis; isFirstVisit: boolean; clamped: boolean };
  groups: DigestGroup[];
  /** Signals that scored above zero but lost to the noise budget. */
  suppressedCount: number;
  /** Symbols we looked at and deliberately found nothing notable about. */
  quiet: Array<{ symbol: string; changePct: number | null; sigma: number | null }>;
  health: DataHealth;
}

export interface DataHealth {
  /** Worst-case freshness across the user's symbols. */
  worstFreshness: Freshness;
  stale: string[];
  conflicted: string[];
  halted: string[];
  thinHistory: string[];
  providers: ProviderHealth[];
}

export interface ProviderHealth {
  provider: string;
  breaker: 'closed' | 'open' | 'half_open';
  ok: number;
  fail: number;
  p95Ms: number | null;
  lastError: string | null;
  lastOkAt: Millis | null;
}
