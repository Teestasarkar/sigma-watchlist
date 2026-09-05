/**
 * The detection cycle: run every detector for one symbol, drive each through
 * the episode state machine, and persist exactly what changed.
 *
 * This runs once per symbol globally, never per user. That single decision is
 * what makes the cost of the system scale with the number of *instruments*
 * people care about rather than with the number of people - ten thousand
 * users watching AAPL cost one detection cycle, not ten thousand.
 */

import type {
  Freshness,
  InstrumentStats,
  Quote,
  Signal,
  SignalKind,
} from '../domain/types.js';
import type { MarketClock } from '../domain/marketClock.js';
import {
  DETECTORS,
  INTEGRITY_KINDS,
  STATE_KINDS,
  type DetectorContext,
  type Observation,
  type Thresholds,
} from '../domain/signals/detectors.js';
import { step, type EpisodeOutcome } from '../domain/signals/hysteresis.js';
import type { SignalRepo, SignalStateRow } from '../db/signalRepo.js';
import { contentId } from '../infra/ids.js';
import { createLogger } from '../infra/logger.js';

const log = createLogger('detect');

export interface DetectionInput {
  symbol: string;
  quote: Quote;
  stats: InstrumentStats | null;
  freshness: Freshness;
  benchmark: { quote: Quote; stats: InstrumentStats } | null;
  now: number;
}

export interface DetectionResult {
  symbol: string;
  created: Signal[];
  intensified: number;
  closed: number;
}

export class DetectionEngine {
  constructor(
    private readonly signals: SignalRepo,
    private readonly clock: MarketClock,
    private readonly thresholds: Thresholds,
  ) {}

  async detect(input: DetectionInput): Promise<DetectionResult> {
    const { symbol, quote, stats, freshness, benchmark, now } = input;

    const ctx: DetectorContext = {
      symbol,
      now,
      quote,
      stats,
      freshness,
      clock: this.clock,
      benchmark,
      thresholds: this.thresholds,
    };

    const priorStates = await this.signals.getStates(symbol);

    const created: Signal[] = [];
    const statesToWrite: SignalStateRow[] = [];
    let intensified = 0;
    let closed = 0;

    for (const detector of DETECTORS) {
      let observation: Observation | null;
      try {
        observation = detector(ctx);
      } catch (err) {
        // A detector throwing must not abort the others. Losing one signal is
        // recoverable; losing the whole cycle for a symbol is not.
        log.error('detector threw', {
          symbol,
          err: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      if (!observation) continue;

      /*
       * Suppress market analysis on untrustworthy prices.
       *
       * Computing "3.4 sigma move" from a price that may be an hour old is
       * confident nonsense, and worse than saying nothing - the user cannot
       * tell the difference. Integrity detectors are exempt, because reporting
       * that the data is stale is precisely what should happen here.
       */
      if (
        !INTEGRITY_KINDS.has(observation.kind) &&
        // 'closed' is deliberately absent: a closing price in a shut market is
        // the correct current price, and the analysis built on it is valid.
        (freshness === 'stale' || freshness === 'unknown')
      ) {
        observation = { ...observation, value: 0 };
      }

      const prior = priorStates.get(observation.kind) ?? null;
      const outcome = step(observation, prior, now);

      if (outcome.state) {
        // The state machine is pure and does not know the symbol; stamp it.
        statesToWrite.push({ ...outcome.state, symbol, kind: observation.kind });
      }

      /*
       * Cold start: record the condition without announcing it.
       *
       * On the first ever observation of a standing condition - a drawdown, a
       * trend, an elevated volatility regime - the condition is not news, it
       * is the situation we are joining midway. Persisting the episode without
       * emitting a signal means the *next* transition is reported correctly
       * while the user's first briefing is not twenty items of backstory.
       */
      if (prior === null && STATE_KINDS.has(observation.kind) && outcome.action === 'open') {
        log.debug('adopting existing condition silently', {
          symbol,
          kind: observation.kind,
        });
        continue;
      }

      const applied = await this.apply(symbol, observation, outcome, quote.asOf, now);
      if (applied.created) created.push(applied.created);
      if (applied.intensified) intensified++;
      if (applied.closed) closed++;
    }

    if (statesToWrite.length > 0) await this.signals.putStates(statesToWrite);

    return { symbol, created, intensified, closed };
  }

  /**
   * Persist the consequence of one state-machine transition.
   *
   * `insertIfAbsent` rather than a plain insert is what makes the whole cycle
   * idempotent: replaying it - after a crash, a duplicate tick, or from a
   * second worker - produces no duplicate signals, because the unique index on
   * (symbol, kind, episode_key) is the arbiter rather than application logic.
   */
  private async apply(
    symbol: string,
    observation: Observation,
    outcome: EpisodeOutcome,
    asOf: number,
    now: number,
  ): Promise<{ created: Signal | null; intensified: boolean; closed: boolean }> {
    let createdSignal: Signal | null = null;
    let didIntensify = false;
    let didClose = false;

    if (outcome.closingEpisodeKey) {
      await this.signals.supersede(symbol, observation.kind, outcome.closingEpisodeKey, now);
      didClose = true;
    }

    if ((outcome.action === 'open' || outcome.action === 'reopen') && outcome.episodeKey) {
      const signal: Signal = {
        // Deterministic id from content, so even a bypassed unique index
        // could not produce two rows for one episode.
        id: contentId(symbol, observation.kind, outcome.episodeKey),
        symbol,
        kind: observation.kind,
        episodeKey: outcome.episodeKey,
        direction: observation.direction,
        severity: observation.severity,
        detectedAt: now,
        asOf,
        headline: observation.headline,
        evidence: observation.evidence,
        supersededAt: null,
      };

      const inserted = await this.signals.insertIfAbsent(signal);
      if (inserted) {
        createdSignal = signal;
        log.info('signal', {
          symbol,
          kind: signal.kind,
          dir: signal.direction,
          severity: Number(signal.severity.toFixed(2)),
        });
      }
    }

    if (outcome.action === 'intensify' && outcome.episodeKey) {
      didIntensify = await this.signals.intensify(symbol, observation.kind, outcome.episodeKey, {
        severity: observation.severity,
        headline: observation.headline,
        evidence: observation.evidence,
        asOf,
      });
    }

    return { created: createdSignal, intensified: didIntensify, closed: didClose };
  }
}

/** Build the threshold bundle from configuration. */
export function thresholdsFromConfig(cfg: {
  signals: {
    sigmaEnter: number;
    sigmaExit: number;
    idioEnter: number;
    idioExit: number;
    gapEnterAtr: number;
    rvolEnter: number;
    rvolExit: number;
    volRegimeEnter: number;
    volRegimeExit: number;
    rangeBreakBuffer: number;
    drawdownBuckets: readonly number[];
    minBarsForStats: number;
  };
  freshness: { staleMs: number };
}): Thresholds {
  return {
    sigmaEnter: cfg.signals.sigmaEnter,
    sigmaExit: cfg.signals.sigmaExit,
    idioEnter: cfg.signals.idioEnter,
    idioExit: cfg.signals.idioExit,
    gapEnterAtr: cfg.signals.gapEnterAtr,
    rvolEnter: cfg.signals.rvolEnter,
    rvolExit: cfg.signals.rvolExit,
    volRegimeEnter: cfg.signals.volRegimeEnter,
    volRegimeExit: cfg.signals.volRegimeExit,
    rangeBreakBuffer: cfg.signals.rangeBreakBuffer,
    drawdownBuckets: cfg.signals.drawdownBuckets,
    minBarsForStats: cfg.signals.minBarsForStats,
    staleMs: cfg.freshness.staleMs,
  };
}

/** Signal kinds, exported for the UI's filter chips. */
export const ALL_SIGNAL_KINDS: readonly SignalKind[] = [
  'sigma_move',
  'idio_move',
  'gap',
  'range_break',
  'volume_spike',
  'trend_flip',
  'vol_regime',
  'drawdown',
  'stale_data',
  'data_conflict',
];
