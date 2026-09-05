/**
 * Composition root.
 *
 * Every dependency is constructed here and injected downward. Nothing below
 * this file reaches for a singleton, reads `process.env`, or calls `Date.now()`
 * directly - which is what makes the whole system testable: a test builds an
 * `App` against an in-memory database, a manual clock and a seeded feed, and
 * gets the real code paths with no mocking framework in sight.
 */

import { config as defaultConfig, type Config } from './config.js';
import { createSqlClient, type SqlClient } from './db/sql.js';
import { migrate } from './db/migrate.js';
import { MarketRepo } from './db/marketRepo.js';
import { UserRepo } from './db/userRepo.js';
import { AuthRepo } from './db/authRepo.js';
import { SignalRepo } from './db/signalRepo.js';
import { IngestRepo } from './db/ingestRepo.js';
import {
  exchangeClock,
  SimulatedMarketClock,
  type MarketClock,
} from './domain/marketClock.js';
import { systemClock, type Clock } from './infra/clock.js';
import { createLogger } from './infra/logger.js';
import { createFaultState, type FaultState } from './providers/faults.js';
import { SyntheticProvider } from './providers/synthetic.js';
import { YahooProvider } from './providers/yahoo.js';
import { CnbcProvider } from './providers/cnbc.js';
import { FinnhubProvider } from './providers/finnhub.js';
import { ProviderRegistry } from './providers/registry.js';
import type { MarketDataProvider } from './providers/types.js';
import { ALL_ENTRIES, BENCHMARK, STARTER_SYMBOLS } from './providers/universe.js';
import { hashPassword } from './infra/password.js';
import { DetectionEngine, thresholdsFromConfig } from './services/detection.js';
import { IngestService } from './services/ingest.js';
import { CorporateActionService } from './services/corporateActions.js';
import { ActionsRepo } from './db/actionsRepo.js';
import { ViewService } from './services/view.js';
import { ReplayService } from './services/replay.js';
import { Scheduler } from './ingest/scheduler.js';
import { MarketEventBus } from './services/events.js';

const log = createLogger('app');

export interface App {
  config: Config;
  sql: SqlClient;
  clock: Clock;
  marketClock: MarketClock;
  faults: FaultState;

  market: MarketRepo;
  users: UserRepo;
  auth: AuthRepo;
  signals: SignalRepo;
  jobs: IngestRepo;
  actions: ActionsRepo;

  registry: ProviderRegistry;
  detection: DetectionEngine;
  ingest: IngestService;
  replay: ReplayService;
  view: ViewService;
  scheduler: Scheduler;
  /** Broadcasts 'something moved' to connected browsers. */
  events: MarketEventBus;

  /** Ensure the universe, benchmark and a demo account exist. */
  bootstrap(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface BuildOptions {
  config?: Config;
  clock?: Clock;
  /** Force an ephemeral in-memory database. Used by the test suite. */
  inMemory?: boolean;
}

export async function buildApp(options: BuildOptions = {}): Promise<App> {
  const config = options.config ?? defaultConfig;
  const clock = options.clock ?? systemClock;

  const sql = await createSqlClient({
    databaseUrl: options.inMemory ? '' : config.databaseUrl,
    dataDir: options.inMemory ? undefined : config.dataDir,
  });
  await migrate(sql);

  const faults = createFaultState();

  /*
   * Choosing the market clock.
   *
   * The simulated feed compresses a trading session into seconds, so it needs
   * a clock that agrees with that compression - otherwise every tick would be
   * measured against a real 6.5-hour session and read as a 40-sigma event.
   * With a real provider configured we use real exchange hours.
   */
  /*
   * The clock follows the *primary* provider, not merely whether the simulator
   * is present at all.
   *
   * A live feed reports real exchange timestamps, so it needs real NYSE hours;
   * the simulator compresses a session into seconds and needs a clock that
   * agrees with that compression. Listing the simulator as a *fallback* behind
   * a live feed must not drag the whole system onto the compressed grid - so
   * this looks at what comes first.
   */
  const primaryProvider = config.providers.enabled[0] ?? 'synthetic';
  const usingSynthetic = primaryProvider === 'synthetic' || primaryProvider === 'synthetic-alt';
  const marketClock: MarketClock = usingSynthetic
    ? new SimulatedMarketClock(
        clock.now(),
        config.providers.syntheticSessionMs,
        config.providers.historySessions,
      )
    : exchangeClock;

  const providers = buildProviders(config, marketClock, faults, clock);

  const registry = new ProviderRegistry(providers, {
    breaker: config.breaker,
    requestTimeoutMs: config.providers.requestTimeoutMs,
    reconcile: {
      tolerance: config.reconcile.tolerance,
      freshMs: config.freshness.freshMs,
      delayedMs: config.freshness.delayedMs,
      staleMs: config.freshness.staleMs,
      minBarsForStats: config.signals.minBarsForStats,
    },
    clock,
    marketClock,
  });

  const market = new MarketRepo(sql, marketClock);
  const users = new UserRepo(sql);
  const auth = new AuthRepo(sql);
  const signals = new SignalRepo(sql);
  const jobs = new IngestRepo(sql);
  const actionsRepo = new ActionsRepo(sql);

  const detection = new DetectionEngine(signals, marketClock, thresholdsFromConfig(config));

  const corporateActions = new CorporateActionService(
    registry,
    market,
    actionsRepo,
    signals,
    config.providers.historySessions,
  );

  /*
   * The change bus.
   *
   * Constructed before ingest because ingest publishes to it. Nothing
   * subscribes until a browser connects, and publishing with no
   * subscribers is a no-op - so this costs nothing when unused.
   */
  const events = new MarketEventBus(clock, { coalesceMs: config.ingest.eventCoalesceMs });

  const ingest = new IngestService(

    registry,
    market,
    jobs,
    detection,
    corporateActions,
    events,
    marketClock,
    {
    historySessions: config.providers.historySessions,
    freshness: config.freshness,
      maxBackfillSessions: 90,
    },
  );

  const replay = new ReplayService(market, detection, marketClock, {
    sessions: config.replay.sessions,
    minHistory: config.replay.minHistory,
  });

  const view = new ViewService(users, market, signals, jobs, registry, marketClock, {
    freshness: config.freshness,
    digest: config.digest,
    recencyHalfLifeMs: config.signals.recencyHalfLifeMs,
    minBarsForStats: config.signals.minBarsForStats,
  });

  const scheduler = new Scheduler(jobs, signals, auth, ingest, marketClock, clock, {
    tickMs: config.ingest.tickMs,
    batchSize: config.ingest.batchSize,
    hotIntervalMs: config.ingest.hotIntervalMs,
    warmIntervalMs: config.ingest.warmIntervalMs,
    coldIntervalMs: config.ingest.coldIntervalMs,
    hotWindowMs: config.ingest.hotWindowMs,
    closedMultiplier: config.ingest.closedMultiplier,
    // Twice the maximum digest lookback: anything older can never be shown.
    retentionSessions: config.digest.maxLookbackSessions * 3,
  });

  const app: App = {
    config,
    sql,
    clock,
    marketClock,
    faults,
    market,
    users,
    auth,
    signals,
    jobs,
    actions: actionsRepo,
    registry,
    detection,
    ingest,
    replay,
    view,
    scheduler,
    events,

    async bootstrap() {
      const now = clock.now();

      /*
       * Register instrument metadata for the whole universe up front so search
       * works immediately, but do NOT seed price history for all of them -
       * that is hundreds of rows per symbol for instruments nobody may ever
       * watch. History is seeded lazily when a symbol is first added.
       *
       * This runs in live mode too. The tickers, names and sectors in
       * universe.ts are the real ones, so they are correct metadata whichever
       * feed supplies the prices - and without it, search is empty and there
       * is no benchmark, which silently disables every market-adjusted signal.
       */
      for (const entry of ALL_ENTRIES) {
        await market.upsertInstrument({
          symbol: entry.symbol,
          name: entry.name,
          exchange: usingSynthetic ? 'SIMULATED' : null,
          currency: 'USD',
          sector: entry.sector,
          isBenchmark: entry.symbol === BENCHMARK.symbol,
          now,
        });
      }

      /*
       * The benchmark is the exception to lazy seeding: every market-adjusted
       * detector needs its history to compute a beta, so it is fetched eagerly
       * and polled always, whether or not anyone watches it.
       */
      try {
        await ingest.ensureInstrument(BENCHMARK.symbol, now, {
          isBenchmark: true,
          pollIntervalMs: config.ingest.warmIntervalMs,
        });
      } catch (err) {
        // A benchmark we cannot fetch costs us the market-adjusted signals,
        // not the whole product. Start anyway and retry on the next cycle.
        log.error('could not seed the benchmark; market-adjusted signals are disabled until it recovers', {
          symbol: BENCHMARK.symbol,
          err: err instanceof Error ? err.message : String(err),
        });
      }

      await ensureDemoUser(app, now);

      /*
       * Replay real history through the detectors.
       *
       * Without this, a freshly-seeded instance knows a year of prices and has
       * no signals at all - so the briefing is empty until something happens
       * while we happen to be watching. Opening the app at the weekend would
       * show nothing, even though the week was full of events.
       *
       * Detection is idempotent, so this is safe to run on every boot; it only
       * emits for symbols whose episodes have not already been recorded.
       */
      if (config.replay.enabled) {
        const watched = await jobs.watchedSymbols();
        await replay.replayMissing(watched);
      }

      log.info('bootstrap complete', {
        clock: marketClock.name,
        providers: registry.providerNames.join(','),
      });
    },

    async shutdown() {
      events.stop();
      await scheduler.stop();
      await sql.close();
    },
  };

  return app;
}

/** Providers that produce prices for the *real* market. */
const LIVE_PROVIDERS = new Set(['yahoo', 'cnbc', 'finnhub']);
/** Providers that produce prices for a simulated market. */
const SIMULATED_PROVIDERS = new Set(['synthetic', 'synthetic-alt']);

function buildProviders(
  config: Config,
  marketClock: MarketClock,
  faults: FaultState,
  clock: Clock,
): MarketDataProvider[] {
  const providers: MarketDataProvider[] = [];

  /*
   * Live and simulated feeds are mutually exclusive, and this is not a
   * limitation to work around - mixing them would be actively wrong.
   *
   * They describe different universes. Real AAPL is $320; simulated AAPL is
   * $170. Reconciling those produces a permanent "sources disagree by 47%",
   * and interleaving their bars produces a price series with a cliff in the
   * middle that would read as the largest gap in market history. So whichever
   * kind comes first in PROVIDERS wins, and the other kind is dropped with a
   * warning rather than silently corrupting the data.
   */
  const primary = config.providers.enabled[0] ?? 'synthetic';
  const wantLive = LIVE_PROVIDERS.has(primary);

  for (const name of config.providers.enabled) {
    const isLive = LIVE_PROVIDERS.has(name);
    const isSimulated = SIMULATED_PROVIDERS.has(name);

    if (wantLive && isSimulated) {
      log.warn('ignoring simulated provider behind a live one', {
        provider: name,
        because: 'its prices describe a different market and cannot be reconciled with real ones',
      });
      continue;
    }
    if (!wantLive && isLive) {
      log.warn('ignoring live provider behind a simulated one', {
        provider: name,
        because: 'its prices describe a different market and cannot be reconciled with simulated ones',
      });
      continue;
    }

    switch (name) {
      case 'synthetic': {
        if (!(marketClock instanceof SimulatedMarketClock)) {
          throw new Error('the synthetic provider requires the simulated market clock');
        }
        providers.push(
          new SyntheticProvider({
            name: 'synthetic',
            seed: config.providers.syntheticSeed,
            clock: marketClock,
            now: clock,
            faults,
          }),
        );
        break;
      }

      case 'synthetic-alt': {
        if (!(marketClock instanceof SimulatedMarketClock)) break;
        /*
         * A second, deliberately slightly-biased instance of the same feed.
         *
         * This is how provider disagreement becomes demonstrable rather than
         * theoretical: two independent sources that mostly agree and sometimes
         * do not, so `data_conflict` fires on a real spread instead of a
         * hard-coded branch.
         */
        providers.push(
          new SyntheticProvider({
            name: 'synthetic-alt',
            sourceLabel: 'synthetic-alt',
            seed: config.providers.syntheticSeed,
            clock: marketClock,
            now: clock,
            faults,
            bias: 1.0004,
          }),
        );
        break;
      }

      case 'yahoo': {
        /*
         * Live equity data, no API key. Undocumented and therefore expected to
         * misbehave - which is what the breaker, the limiter and the fallback
         * ordering in PROVIDERS are for.
         */
        providers.push(new YahooProvider(marketClock, clock));
        break;
      }

      case 'cnbc': {
        /*
         * The second live feed, and the reason cross-vendor reconciliation
         * is demonstrable rather than theoretical. Also keyless, also
         * undocumented. Quotes only - see the provider header for why its
         * history is deliberately not merged with Yahoo's.
         */
        providers.push(new CnbcProvider(marketClock, clock));
        break;
      }

      case 'finnhub': {
        if (!config.providers.finnhubKey) {
          log.warn('finnhub requested but FINNHUB_API_KEY is unset; skipping');
          break;
        }
        providers.push(new FinnhubProvider(config.providers.finnhubKey, marketClock));
        break;
      }

      default:
        log.warn('unknown provider requested', { name });
    }
  }

  if (providers.length === 0) {
    throw new Error(
      `no usable providers from PROVIDERS="${config.providers.enabled.join(',')}"`,
    );
  }

  return providers;
}

/**
 * A ready-to-explore account.
 *
 * A watchlist product with an empty watchlist demonstrates nothing, and asking
 * a reviewer to type ten tickers before seeing the point is a poor trade. The
 * starter list deliberately mixes volatility regimes so the sigma-normalised
 * ranking has something to prove.
 */
/**
 * A ready-to-explore account with a published password.
 *
 * A watchlist product with an empty watchlist demonstrates nothing, and asking
 * a reviewer to register before seeing the point is a poor trade. The
 * credentials are deliberately not a secret - see config.demoPassword.
 */
async function ensureDemoUser(app: App, now: number): Promise<void> {
  const existing = await app.auth.findAccount('demo');

  if (existing) {
    // An account created before passwords existed cannot log in. Give it one
    // rather than leaving a dead row that silently refuses every attempt.
    if (!existing.passwordHash) {
      await app.auth.setPassword(existing.id, await hashPassword(app.config.demoPassword), now);
      log.info('demo account given a password');
    }
    return;
  }

  const user = await app.auth.createAccount(
    'demo',
    await hashPassword(app.config.demoPassword),
    now,
  );

  const list = await app.users.createWatchlist(
    user.id,
    'My Watchlist',
    now,
    app.config.limits.maxWatchlistsPerUser,
  );

  for (const symbol of STARTER_SYMBOLS) {
    try {
      await app.ingest.ensureInstrument(symbol, now, {
        pollIntervalMs: app.config.ingest.warmIntervalMs,
      });
      await app.users.addItem(
        list.id,
        user.id,
        symbol,
        now,
        null,
        app.config.limits.maxSymbolsPerWatchlist,
      );
    } catch (err) {
      log.warn('could not seed starter symbol', {
        symbol,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info('demo account created', { symbols: STARTER_SYMBOLS.length });
}
