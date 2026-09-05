/**
 * Episodes are keyed on the session the *data* belongs to.
 *
 * This is a regression test for a bug that reached the screen: on a Saturday,
 * detectors keyed their episode on wall-clock "now", so the unchanged Friday
 * close opened a second episode and the briefing showed one signal twice.
 */

import { describe, expect, it } from 'vitest';

import {
  gap,
  idioMove,
  sigmaMove,
  volumeSpike,
  type DetectorContext,
  type Thresholds,
} from '../src/domain/signals/detectors.js';
import { exchangeClock } from '../src/domain/marketClock.js';
import type { InstrumentStats, Quote } from '../src/domain/types.js';

const THRESHOLDS: Thresholds = {
  sigmaEnter: 2,
  sigmaExit: 1,
  idioEnter: 2,
  idioExit: 1,
  gapEnterAtr: 1.5,
  rvolEnter: 2.5,
  rvolExit: 1.5,
  volRegimeEnter: 1.8,
  volRegimeExit: 1.25,
  rangeBreakBuffer: 0.002,
  drawdownBuckets: [10, 20, 30, 50],
  minBarsForStats: 25,
  staleMs: 30 * 60_000,
};

/** Friday 2026-09-04, 16:00 ET - a real closing print. */
const FRIDAY_CLOSE = Date.UTC(2026, 8, 4, 20, 0);
/** Saturday and Sunday, when nothing trades but the app is still running. */
const SATURDAY = Date.UTC(2026, 8, 5, 15, 0);
const SUNDAY = Date.UTC(2026, 8, 6, 18, 0);

function quote(over: Partial<Quote> = {}): Quote {
  return {
    symbol: 'TSLA',
    price: 354,
    prevClose: 376,
    dayOpen: 372,
    dayHigh: 377,
    dayLow: 352,
    volume: 90_000_000,
    // The data is Friday's, whatever day it is read on.
    asOf: FRIDAY_CLOSE,
    receivedAt: FRIDAY_CLOSE,
    source: 'yahoo',
    confidence: 1,
    halted: false,
    conflict: null,
    ...over,
  };
}

function stats(over: Partial<InstrumentStats> = {}): InstrumentStats {
  return {
    symbol: 'TSLA',
    computedAt: FRIDAY_CLOSE,
    bars: 252,
    sigmaDaily: 0.034,
    sigmaShort: 0.036,
    atrPct: 0.043,
    beta: 2.3,
    residSigma: 0.024,
    hi52w: 498,
    lo52w: 297,
    hi30d: 400,
    lo30d: 340,
    medVol20: 80_000_000,
    sma20: 380,
    sma50: 370,
    peak52w: 498,
    ...over,
  };
}

function ctxAt(now: number): DetectorContext {
  return {
    symbol: 'TSLA',
    now,
    quote: quote(),
    stats: stats(),
    freshness: 'closed',
    clock: exchangeClock,
    benchmark: {
      quote: quote({ symbol: 'SPY', price: 600, prevClose: 601, asOf: FRIDAY_CLOSE }),
      stats: stats({ symbol: 'SPY', beta: 1 }),
    },
    thresholds: THRESHOLDS,
  };
}

describe('episode keys follow the data, not the calendar', () => {
  const detectors = [
    ['sigmaMove', sigmaMove],
    ['idioMove', idioMove],
    ['gap', gap],
    ['volumeSpike', volumeSpike],
  ] as const;

  for (const [name, detector] of detectors) {
    it(`${name} gives the same discriminator all weekend`, () => {
      /*
       * The same Friday close, read at three different moments. Nothing about
       * the market has changed, so the episode must not either - otherwise
       * every midnight reopens it and the user is told the same thing again.
       */
      const friday = detector(ctxAt(FRIDAY_CLOSE + 60_000));
      const saturday = detector(ctxAt(SATURDAY));
      const sunday = detector(ctxAt(SUNDAY));

      expect(friday).not.toBeNull();
      expect(saturday?.discriminator).toBe(friday?.discriminator);
      expect(sunday?.discriminator).toBe(friday?.discriminator);
    });
  }

  it('still separates genuinely different sessions', () => {
    // The guard must not go so far that Monday's move joins Friday's episode.
    const MONDAY_CLOSE = Date.UTC(2026, 8, 7, 20, 0);

    const friday = sigmaMove(ctxAt(SATURDAY));
    const mondayCtx: DetectorContext = {
      ...ctxAt(MONDAY_CLOSE + 60_000),
      quote: quote({ asOf: MONDAY_CLOSE }),
    };
    const monday = sigmaMove(mondayCtx);

    expect(monday?.discriminator).not.toBe(friday?.discriminator);
  });

  it('still separates directions within one session', () => {
    const down = sigmaMove(ctxAt(SATURDAY));
    const upCtx: DetectorContext = {
      ...ctxAt(SATURDAY),
      quote: quote({ price: 400, prevClose: 376 }),
    };
    const up = sigmaMove(upCtx);

    expect(up?.discriminator).not.toBe(down?.discriminator);
  });
});
