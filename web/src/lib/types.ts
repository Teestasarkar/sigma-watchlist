/**
 * The API's response shapes, mirrored from server/src/domain/types.ts.
 *
 * Duplicated deliberately rather than shared through a workspace package. The
 * two sides are separately deployable and the contract is small; a shared
 * package would couple their build graphs and force a rebuild of both to
 * change either. The duplication is caught the moment it drifts, because the
 * frontend typechecks against these and the integration tests exercise the
 * real payloads.
 */

export type Freshness = 'fresh' | 'delayed' | 'stale' | 'closed' | 'unknown';
export type Direction = 'up' | 'down' | 'neutral';

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
  | 'data_conflict';

export interface QuoteConflict {
  spread: number;
  resolution: 'single' | 'preferred' | 'median';
  quotes: Array<{ source: string; price: number; asOf: number }>;
}

export interface Quote {
  symbol: string;
  price: number;
  prevClose: number;
  dayOpen: number;
  dayHigh: number;
  dayLow: number;
  volume: number;
  asOf: number;
  receivedAt: number;
  source: string;
  confidence: number;
  halted: boolean;
  conflict: QuoteConflict | null;
}

export interface Bar {
  symbol: string;
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  source: string;
}

export interface InstrumentStats {
  symbol: string;
  computedAt: number;
  bars: number;
  sigmaDaily: number;
  sigmaShort: number;
  atrPct: number;
  beta: number;
  residSigma: number;
  hi52w: number;
  lo52w: number;
  hi30d: number;
  lo30d: number;
  medVol20: number;
  sma20: number;
  sma50: number;
  peak52w: number;
}

export interface Signal {
  id: string;
  symbol: string;
  kind: SignalKind;
  episodeKey: string;
  direction: Direction;
  severity: number;
  detectedAt: number;
  asOf: number;
  headline: string;
  evidence: Record<string, number | string | boolean>;
  supersededAt: number | null;
}

export interface ScoredSignal extends Signal {
  score: number;
  rationale: string;
  isRead: boolean;
}

export interface WatchlistItem {
  symbol: string;
  addedAt: number;
  pinned: boolean;
  muted: boolean;
  minSigma: number | null;
  note: string | null;
  sortKey: number;
}

export interface Watchlist {
  id: string;
  userId: string;
  name: string;
  createdAt: number;
  version: number;
  items?: WatchlistItem[];
}

export interface WatchRow {
  symbol: string;
  name: string;
  sector: string | null;
  item: WatchlistItem;
  quote: Quote | null;
  freshness: Freshness;
  stats: Pick<InstrumentStats, 'sigmaDaily' | 'atrPct' | 'beta' | 'bars'> | null;
  sinceSeen: {
    from: number | null;
    fromAt: number | null;
    changePct: number | null;
    sigma: number | null;
  };
  today: { changePct: number | null };
  rvol: number | null;
  openSignals: number;
  topSignal: Signal | null;
}

export interface ProviderHealth {
  provider: string;
  breaker: 'closed' | 'open' | 'half_open';
  ok: number;
  fail: number;
  p95Ms: number | null;
  lastError: string | null;
  lastOkAt: number | null;
}

export interface DataHealth {
  worstFreshness: Freshness;
  stale: string[];
  conflicted: string[];
  halted: string[];
  thinHistory: string[];
  providers: ProviderHealth[];
}

export interface DigestGroup {
  symbol: string;
  name: string;
  signals: ScoredSignal[];
  topScore: number;
}

export interface Digest {
  generatedAt: number;
  window: { from: number; to: number; isFirstVisit: boolean; clamped: boolean };
  groups: DigestGroup[];
  suppressedCount: number;
  quiet: Array<{ symbol: string; changePct: number | null; sigma: number | null }>;
  health: DataHealth;
}

export interface User {
  id: string;
  handle: string;
  createdAt: number;
}

export interface Meta {
  signalKinds: Array<{ kind: SignalKind; weight: number }>;
  thresholds: {
    sigmaEnter: number;
    sigmaExit: number;
    idioEnter: number;
    rvolEnter: number;
  };
  digest: { maxItems: number; maxPerSymbol: number };
  marketClock: { name: string; sessionMs: number; simulated: boolean };
  providers: string[];
  devTools: boolean;
}

export interface SymbolDetail {
  instrument: {
    symbol: string;
    name: string;
    exchange: string | null;
    currency: string;
    sector: string | null;
    status: 'active' | 'delisted' | 'unknown';
    isBenchmark: boolean;
    firstSeenAt: number;
  };
  quote: Quote | null;
  freshness: Freshness;
  stats: InstrumentStats | null;
  bars: Bar[];
  signals: Signal[];
  mark: {
    symbol: string;
    seenAt: number;
    seenPrice: number | null;
    prevSeenAt: number | null;
    prevSeenPrice: number | null;
  } | null;
  job: {
    symbol: string;
    tier: 'hot' | 'warm' | 'cold';
    intervalMs: number;
    nextRunAt: number;
    lastOkAt: number | null;
    lastError: string | null;
    failStreak: number;
  } | null;
}

export interface Diagnostics {
  scheduler: {
    running: boolean;
    ticks: number;
    refreshed: number;
    failed: number;
    signalsCreated: number;
    lastTickDurationMs: number | null;
    queueDepth: number;
    tiers: Record<string, number>;
  };
  signals: { total: number };
  providers: {
    inflight: { quotes: number; history: number };
    providers: Array<Record<string, unknown>>;
  };
  faults: Record<string, unknown>;
  jobs: Array<{
    symbol: string;
    tier: string;
    intervalMs: number;
    dueInMs: number;
    failStreak: number;
    lastError: string | null;
    lastOkAgoMs: number | null;
  }>;
}

export interface AuthPolicy {
  minPasswordLength: number;
  maxPasswordLength: number;
  handlePattern: string;
  sessionTtlMs: number;
  /** Published deliberately when dev tools are on; null otherwise. */
  demo: { handle: string; password: string } | null;
}

export interface SessionSummary {
  /** Last six characters of the token - enough to identify, useless if seen. */
  id: string;
  current: boolean;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number | null;
  userAgent: string | null;
}
