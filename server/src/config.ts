/**
 * Central configuration. Every tunable that affects *what counts as meaningful*
 * lives here rather than being scattered as magic numbers through the detectors,
 * so the product's opinion is auditable in one place.
 */

const num = (v: string | undefined, fallback: number): number => {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const bool = (v: string | undefined, fallback: boolean): boolean => {
  if (v === undefined || v.trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
};

const list = (v: string | undefined, fallback: string[]): string[] => {
  if (!v || v.trim() === '') return fallback;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
};

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: num(process.env.PORT, 8787),
  host: process.env.HOST ?? '127.0.0.1',

  /**
   * Postgres connection string. When set, the app talks to managed Postgres;
   * when empty it runs embedded Postgres (PGlite) out of `dataDir`, so a clean
   * checkout works with no database to install. One dialect either way - see
   * docs/DECISIONS.md.
   */
  databaseUrl: process.env.DATABASE_URL ?? '',

  /** Where embedded Postgres keeps its files. Omitted entirely in tests. */
  dataDir: process.env.DATA_DIR ?? 'data/pg',

  /** Serve the built frontend from the API process (single-origin production mode). */
  serveWeb: bool(process.env.SERVE_WEB, false),

  providers: {
    /**
     * Ordered by preference. The synthetic provider is always available and is
     * the default so the app runs with zero setup and deterministic data.
     * Add real providers by setting the relevant key; they are then preferred.
     */
    enabled: list(process.env.PROVIDERS, ['synthetic']),
    finnhubKey: process.env.FINNHUB_API_KEY ?? '',
    alphaVantageKey: process.env.ALPHAVANTAGE_API_KEY ?? '',
    /** Synthetic feed seed — the same seed produces the same market, every run. */
    syntheticSeed: num(process.env.SYNTHETIC_SEED, 20260904),
    /**
     * Wall-clock ms per simulated trading session.
     *
     * This is the simulator's time compression, and the market clock scales
     * volatility horizons by the same constant - so the numbers stay honest at
     * any speed. 45s means stepping away for a coffee is genuinely a few
     * sessions of market risk, which is what makes "what changed while I was
     * gone" demonstrable without waiting a week.
     */
    syntheticSessionMs: num(process.env.SYNTHETIC_SESSION_MS, 45_000),
    /** Sessions of seeded history generated for each instrument on first sight. */
    historySessions: num(process.env.HISTORY_SESSIONS, 260),
    requestTimeoutMs: num(process.env.PROVIDER_TIMEOUT_MS, 4000),
  },

  /** Circuit breaker: trip a provider that is failing rather than hammering it. */
  breaker: {
    windowMs: num(process.env.BREAKER_WINDOW_MS, 30_000),
    minSamples: num(process.env.BREAKER_MIN_SAMPLES, 5),
    failureRatio: num(process.env.BREAKER_FAILURE_RATIO, 0.5),
    openMs: num(process.env.BREAKER_OPEN_MS, 15_000),
    halfOpenProbes: num(process.env.BREAKER_HALF_OPEN_PROBES, 2),
  },

  ingest: {
    /** Scheduler wake interval. Work is claimed from a due-queue, not a timer per symbol. */
    tickMs: num(process.env.INGEST_TICK_MS, 750),
    /** Max symbols fetched per tick — the backpressure valve. */
    batchSize: num(process.env.INGEST_BATCH, 12),
    /** Poll intervals by tier (ms). Hot = someone is looking at it right now. */
    hotIntervalMs: num(process.env.INGEST_HOT_MS, 5_000),
    warmIntervalMs: num(process.env.INGEST_WARM_MS, 20_000),
    coldIntervalMs: num(process.env.INGEST_COLD_MS, 120_000),
    /** A symbol is "hot" if someone opened it within this window. */
    hotWindowMs: num(process.env.INGEST_HOT_WINDOW_MS, 15 * 60_000),
    /** Multiply intervals by this when the market is closed. */
    closedMultiplier: num(process.env.INGEST_CLOSED_MULT, 8),
    enabled: bool(process.env.INGEST_ENABLED, true),
  },

  freshness: {
    /** Quote younger than this = fresh. */
    freshMs: num(process.env.FRESH_MS, 30_000),
    /** Younger than this = delayed (usable, flagged). Beyond = stale. */
    delayedMs: num(process.env.DELAYED_MS, 5 * 60_000),
    /** Beyond this we stop trusting it entirely and say so loudly. */
    staleMs: num(process.env.STALE_MS, 30 * 60_000),
  },

  reconcile: {
    /** Relative price disagreement above this between providers = conflict. */
    tolerance: num(process.env.RECONCILE_TOLERANCE, 0.005),
  },

  signals: {
    /** Hysteresis: enter an episode at `enter` sigma, leave it at `exit`. */
    sigmaEnter: num(process.env.SIGMA_ENTER, 2.0),
    sigmaExit: num(process.env.SIGMA_EXIT, 1.0),
    /** Idiosyncratic (market-adjusted) move thresholds. */
    idioEnter: num(process.env.IDIO_ENTER, 2.0),
    idioExit: num(process.env.IDIO_EXIT, 1.0),
    /** Gap measured in ATR multiples. */
    gapEnterAtr: num(process.env.GAP_ENTER_ATR, 1.5),
    /** Relative volume multiple vs 20-day median. */
    rvolEnter: num(process.env.RVOL_ENTER, 2.5),
    rvolExit: num(process.env.RVOL_EXIT, 1.5),
    /** Short-vol / long-vol ratio that counts as a regime change. */
    volRegimeEnter: num(process.env.VOL_REGIME_ENTER, 1.8),
    volRegimeExit: num(process.env.VOL_REGIME_EXIT, 1.25),
    /** Buffer beyond the prior extreme before a range break counts (fraction). */
    rangeBreakBuffer: num(process.env.RANGE_BREAK_BUFFER, 0.002),
    /** Drawdown buckets, in percent, that each fire once. */
    drawdownBuckets: list(process.env.DRAWDOWN_BUCKETS, ['10', '20', '30', '50']).map(Number),
    /** Half-life for the recency decay applied to attention scores. */
    recencyHalfLifeMs: num(process.env.RECENCY_HALF_LIFE_MS, 6 * 3600_000),
    /** Minimum bars of history before we trust a statistic enough to fire on it. */
    minBarsForStats: num(process.env.MIN_BARS_FOR_STATS, 25),
  },

  digest: {
    /** Noise budget. A briefing that doesn't fit on a screen isn't a briefing. */
    maxItems: num(process.env.DIGEST_MAX_ITEMS, 12),
    /** No single symbol may occupy more than this many slots. */
    maxPerSymbol: num(process.env.DIGEST_MAX_PER_SYMBOL, 2),
    /**
     * Lookback windows, in *trading sessions* rather than milliseconds.
     *
     * Sessions are the only unit that means the same thing to a live exchange
     * and to the compressed simulator clock. Expressed in wall-clock time, a
     * window that is a sensible three days against a real feed becomes a third
     * of a trading year against the simulator - and every significance figure
     * then divides by the square root of a hundred-odd sessions and reports a
     * real move as noise. See MarketClock.sessionsAgo.
     */
    firstVisitLookbackSessions: num(process.env.DIGEST_FIRST_LOOKBACK_SESSIONS, 3),
    /** Hard ceiling, so returning after three months is not a firehose. */
    maxLookbackSessions: num(process.env.DIGEST_MAX_LOOKBACK_SESSIONS, 10),
  },

  limits: {
    maxSymbolsPerWatchlist: num(process.env.MAX_SYMBOLS_PER_WATCHLIST, 500),
    maxWatchlistsPerUser: num(process.env.MAX_WATCHLISTS_PER_USER, 20),
    /** Per-session request budget (token bucket) for the public API. */
    apiRatePerMin: num(process.env.API_RATE_PER_MIN, 600),
  },

  /** Enables the /api/dev/* fault-injection endpoints used by the demo panel. */
  devTools: bool(process.env.DEV_TOOLS, true),

  /**
   * Password for the seeded `demo` account.
   *
   * Published deliberately - it exists so a reviewer can look around without
   * registering, and a demo account with a secret password is not a demo
   * account. Override it (or set DEV_TOOLS=0, which stops it being advertised)
   * for any deployment where that is not the intent.
   */
  demoPassword: process.env.DEMO_PASSWORD ?? 'sigma-demo-2026',
} as const;

export type Config = typeof config;
