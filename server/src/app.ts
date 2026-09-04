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
import { FinnhubProvider } from './providers/finnhub.js';
import { ProviderRegistry } from './providers/registry.js';
import type { MarketDataProvider } from './providers/types.js';
import { ALL_ENTRIES, BENCHMARK, STARTER_SYMBOLS } from './providers/universe.js';
import { DetectionEngine, thresholdsFromConfig } from './services/detection.js';
import { IngestService } from './services/ingest.js';
import { ViewService } from './services/view.js';
import { Scheduler } from './ingest/scheduler.js';

const log = createLogger('app');

export interface App {
  config: Config;
  sql: SqlClient;
  clock: Clock;
  marketClock: MarketClock;
  faults: FaultState;

  market: MarketRepo;
  users: UserRepo;
  signals: SignalRepo;
  jobs: IngestRepo;

  registry: ProviderRegistry;
  detection: DetectionEngine;
  ingest: IngestService;
  view: ViewService;
  scheduler: Scheduler;

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
  const usingSynthetic = config.providers.enabled.includes('synthetic');
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
  });

  const market = new MarketRepo(sql, marketClock);
  const users = new UserRepo(sql);
  const signals = new SignalRepo(sql);
  const jobs = new IngestRepo(sql);

  const detection = new DetectionEngine(signals, marketClock, thresholdsFromConfig(config));

  const ingest = new IngestService(registry, market, jobs, detection, marketClock, {
    historySessions: config.providers.historySessions,
    freshness: config.freshness,
    maxBackfillSessions: 90,
  });

  const view = new ViewService(users, market, signals, jobs, registry, marketClock, {
    freshness: config.freshness,
    digest: config.digest,
    recencyHalfLifeMs: config.signals.recencyHalfLifeMs,
    minBarsForStats: config.signals.minBarsForStats,
  });

  const scheduler = new Scheduler(jobs, signals, ingest, marketClock, clock, {
    tickMs: config.ingest.tickMs,
    batchSize: config.ingest.batchSize,
    hotIntervalMs: config.ingest.hotIntervalMs,
    warmIntervalMs: config.ingest.warmIntervalMs,
    coldIntervalMs: config.ingest.coldIntervalMs,
    hotWindowMs: config.ingest.hotWindowMs,
    closedMultiplier: config.ingest.closedMultiplier,
    retentionMs: config.digest.maxLookbackMs * 2,
  });

  const app: App = {
    config,
    sql,
    clock,
    marketClock,
    faults,
    market,
    users,
    signals,
    jobs,
    registry,
    detection,
    ingest,
    view,
    scheduler,

    async bootstrap() {
      const now = clock.now();

      /*
       * Register instrument metadata for the whole universe up front so search
       * works immediately, but do NOT seed price history for all of them -
       * that is hundreds of rows per symbol for instruments nobody may ever
       * watch. History is seeded lazily when a symbol is first added to a list.
       */
      if (usingSynthetic) {
        for (const entry of ALL_ENTRIES) {
          await market.upsertInstrument({
            symbol: entry.symbol,
            name: entry.name,
            exchange: 'SIMULATED',
            currency: 'USD',
            sector: entry.sector,
            isBenchmark: entry.symbol === BENCHMARK.symbol,
            now,
          });
        }

        // The benchmark is the exception: every market-adjusted detector needs
        // its history, so it is seeded eagerly and polled always.
        await ingest.ensureInstrument(BENCHMARK.symbol, now, {
          isBenchmark: true,
          pollIntervalMs: config.ingest.warmIntervalMs,
        });
      }

      await ensureDemoUser(app, now);
      log.info('bootstrap complete', {
        clock: marketClock.name,
        providers: registry.providerNames.join(','),
      });
    },

    async shutdown() {
      await scheduler.stop();
      await sql.close();
    },
  };

  return app;
}

function buildProviders(
  config: Config,
  marketClock: MarketClock,
  faults: FaultState,
  clock: Clock,
): MarketDataProvider[] {
  const providers: MarketDataProvider[] = [];

  for (const name of config.providers.enabled) {
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
async function ensureDemoUser(app: App, now: number): Promise<void> {
  const existing = await app.users.findUserByHandle('demo');
  if (existing) return;

  const user = await app.users.createUser('demo', now);
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
