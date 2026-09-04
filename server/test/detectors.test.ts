/**
 * The detectors.
 *
 * These tests are the specification for what this product considers
 * meaningful. Where a threshold is asserted, the number is the product
 * decision - if it changes, the test should change with it deliberately, not
 * be relaxed to make a failure go away.
 */

import { describe, expect, it } from 'vitest';

import {
  dataConflict,
  drawdown,
  gap,
  idioMove,
  rangeBreak,
  sigmaMove,
  staleData,
  trendFlip,
  volRegime,
  volumeSpike,
  type DetectorContext,
  type Thresholds,
} from '../src/domain/signals/detectors.js';
import { SimulatedMarketClock } from '../src/domain/marketClock.js';
import type { InstrumentStats, Quote } from '../src/domain/types.js';

const SESSION_MS = 60_000;
const EPOCH = 1_700_000_000_000;
const clock = new SimulatedMarketClock(EPOCH, SESSION_MS, 260);

/** Mid-session, so `sessionProgress` is a stable 0.5. */
const NOW = EPOCH + SESSION_MS / 2;

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

function quote(over: Partial<Quote> = {}): Quote {
  return {
    symbol: 'TEST',
    price: 100,
    prevClose: 100,
    dayOpen: 100,
    dayHigh: 101,
    dayLow: 99,
    volume: 1_000_000,
    asOf: NOW,
    receivedAt: NOW,
    source: 'test',
    confidence: 1,
    halted: false,
    conflict: null,
    ...over,
  };
}

function stats(over: Partial<InstrumentStats> = {}): InstrumentStats {
  return {
    symbol: 'TEST',
    computedAt: NOW,
    bars: 260,
    sigmaDaily: 0.02,
    sigmaShort: 0.02,
    atrPct: 0.02,
    beta: 1,
    residSigma: 0.015,
    hi52w: 130,
    lo52w: 70,
    hi30d: 110,
    lo30d: 92,
    medVol20: 2_000_000,
    sma20: 100,
    sma50: 100,
    peak52w: 130,
    ...over,
  };
}

function ctx(over: Partial<DetectorContext> = {}): DetectorContext {
  return {
    symbol: 'TEST',
    now: NOW,
    quote: quote(),
    stats: stats(),
    freshness: 'fresh',
    clock,
    benchmark: null,
    thresholds: THRESHOLDS,
    ...over,
  };
}

describe('sigmaMove', () => {
  it('scores a move against the instrument own volatility', () => {
    // Half a session elapsed, so the expected move is 0.02 * sqrt(0.5) ~ 1.41%.
    const obs = sigmaMove(ctx({ quote: quote({ price: 104, prevClose: 100 }) }));
    expect(obs).not.toBeNull();
    expect(obs?.value).toBeCloseTo(0.04 / (0.02 * Math.sqrt(0.5)), 5);
    expect(obs?.direction).toBe('up');
  });

  it('is the central claim: identical percentages, different significance', () => {
    const move = { price: 102, prevClose: 100 };
    const utility = sigmaMove(ctx({ quote: quote(move), stats: stats({ sigmaDaily: 0.007 }) }));
    const meme = sigmaMove(ctx({ quote: quote(move), stats: stats({ sigmaDaily: 0.06 }) }));

    expect(utility?.value).toBeGreaterThan(THRESHOLDS.sigmaEnter);
    expect(meme?.value).toBeLessThan(1);
  });

  it('refuses to judge an instrument with thin history', () => {
    // Returning null rather than a confident number is the whole point.
    expect(sigmaMove(ctx({ stats: stats({ bars: 5 }) }))).toBeNull();
    expect(sigmaMove(ctx({ stats: null }))).toBeNull();
    expect(sigmaMove(ctx({ stats: stats({ sigmaDaily: 0 }) }))).toBeNull();
  });

  it('rejects nonsensical prices instead of reporting -100%', () => {
    expect(sigmaMove(ctx({ quote: quote({ prevClose: 0 }) }))).toBeNull();
    expect(sigmaMove(ctx({ quote: quote({ price: 0 }) }))).toBeNull();
  });

  it('gives up and down moves the same intensity', () => {
    const up = sigmaMove(ctx({ quote: quote({ price: 104 }) }));
    const down = sigmaMove(ctx({ quote: quote({ price: 96 }) }));
    expect(up?.severity).toBeCloseTo(down?.severity ?? -1, 6);
    expect(up?.direction).toBe('up');
    expect(down?.direction).toBe('down');
  });

  it('separates episodes by session and by direction', () => {
    const up = sigmaMove(ctx({ quote: quote({ price: 104 }) }));
    const down = sigmaMove(ctx({ quote: quote({ price: 96 }) }));
    // A stock that swings from +3 sigma to -3 sigma has done two things.
    expect(up?.discriminator).not.toBe(down?.discriminator);
  });
});

describe('idioMove', () => {
  const benchmark = (changePct: number): DetectorContext['benchmark'] => ({
    quote: quote({ symbol: 'SPY', price: 400 * (1 + changePct), prevClose: 400 }),
    stats: stats({ symbol: 'SPY' }),
  });

  it('says nothing happened when the market explains the move', () => {
    // Up 3% on a day the market is up 3%, with beta 1: no company news.
    const obs = idioMove(
      ctx({
        quote: quote({ price: 103, prevClose: 100 }),
        stats: stats({ beta: 1 }),
        benchmark: benchmark(0.03),
      }),
    );

    expect(obs).not.toBeNull();
    expect(obs?.value).toBe(0);
    expect(obs?.evidence.marketExplains).toBe(true);
    expect(obs?.headline).toContain('moved with the market');
  });

  it('flags a move the market does not explain', () => {
    // Up 3% while the market is flat: that is about this company.
    const obs = idioMove(
      ctx({
        quote: quote({ price: 103, prevClose: 100 }),
        stats: stats({ beta: 1, residSigma: 0.01 }),
        benchmark: benchmark(0),
      }),
    );

    expect(obs?.value).toBeGreaterThan(THRESHOLDS.idioEnter);
    expect(obs?.evidence.marketExplains).toBe(false);
  });

  it('can invert the sign of the headline number', () => {
    // Up 1% on a day everything else is up 4%: relative *weakness*, and the
    // detector must report it as down even though the price rose.
    const obs = idioMove(
      ctx({
        quote: quote({ price: 101, prevClose: 100 }),
        stats: stats({ beta: 1, residSigma: 0.01 }),
        benchmark: benchmark(0.04),
      }),
    );

    expect(obs?.direction).toBe('down');
    expect(obs?.value).toBeLessThan(0);
  });

  it('accounts for beta rather than assuming one', () => {
    // A 2x-beta name up 4% when the market is up 2% has done nothing unusual.
    const obs = idioMove(
      ctx({
        quote: quote({ price: 104, prevClose: 100 }),
        stats: stats({ beta: 2, residSigma: 0.01 }),
        benchmark: benchmark(0.02),
      }),
    );
    expect(Math.abs(obs?.value ?? 99)).toBeLessThan(0.5);
  });

  it('does nothing without a benchmark', () => {
    expect(idioMove(ctx({ benchmark: null }))).toBeNull();
  });
});

describe('gap', () => {
  it('measures the overnight jump in ATR multiples', () => {
    const obs = gap(ctx({ quote: quote({ dayOpen: 106, prevClose: 100 }), stats: stats({ atrPct: 0.02 }) }));
    expect(obs?.value).toBeCloseTo(0.06 / 0.02, 6);
    expect(obs?.direction).toBe('up');
  });

  it('treats the same percentage differently for a volatile name', () => {
    const wide = gap(ctx({ quote: quote({ dayOpen: 106, prevClose: 100 }), stats: stats({ atrPct: 0.08 }) }));
    expect(wide?.value).toBeLessThan(THRESHOLDS.gapEnterAtr);
  });

  it('closes as soon as the session rolls over', () => {
    // A gap is an event, not a state: enter and exit thresholds are equal, so
    // the episode cannot persist into the next session.
    const obs = gap(ctx({ quote: quote({ dayOpen: 106, prevClose: 100 }) }));
    expect(obs?.enter).toBe(obs?.exit);
  });
});

describe('rangeBreak', () => {
  it('reports a new 52-week high', () => {
    const obs = rangeBreak(ctx({ quote: quote({ price: 131 }), stats: stats({ hi52w: 130 }) }));
    expect(obs?.direction).toBe('up');
    expect(obs?.evidence.scope).toBe('52-week high');
    expect(obs?.value).toBeGreaterThan(obs?.enter ?? 0);
  });

  it('prefers the 52-week scope over the 30-day one', () => {
    // Above both; the bigger news should win.
    const obs = rangeBreak(ctx({ quote: quote({ price: 140 }), stats: stats({ hi52w: 130, hi30d: 110 }) }));
    expect(obs?.evidence.scope).toBe('52-week high');
  });

  it('falls back to the 30-day scope when inside the yearly range', () => {
    const obs = rangeBreak(ctx({ quote: quote({ price: 111 }), stats: stats({ hi52w: 130, hi30d: 110 }) }));
    expect(obs?.evidence.scope).toBe('30-day high');
  });

  it('changes discriminator when the scope escalates, so it fires again', () => {
    const thirty = rangeBreak(ctx({ quote: quote({ price: 111 }), stats: stats({ hi30d: 110 }) }));
    const yearly = rangeBreak(ctx({ quote: quote({ price: 131 }), stats: stats({ hi52w: 130 }) }));
    expect(thirty?.discriminator).not.toBe(yearly?.discriminator);
  });

  it('requires a buffer, so hovering on the level does not flap', () => {
    // Exactly at the 52-week high is not a break. The 30-day levels are set
    // outside the price so only the yearly check is under test here.
    const obs = rangeBreak(
      ctx({
        quote: quote({ price: 130 }),
        stats: stats({ hi52w: 130, lo52w: 70, hi30d: 140, lo30d: 120 }),
      }),
    );
    expect(obs?.value).toBe(0);
  });

  it('reports inactivity so an open episode can close', () => {
    const obs = rangeBreak(ctx({ quote: quote({ price: 100 }) }));
    expect(obs?.value).toBeLessThan(obs?.exit ?? 1);
  });
});

describe('volumeSpike', () => {
  it('paces volume by how much of the session has elapsed', () => {
    // Half a session in, the median-so-far is half the daily median.
    const obs = volumeSpike(ctx({ quote: quote({ volume: 3_000_000 }), stats: stats({ medVol20: 2_000_000 }) }));
    expect(obs?.value).toBeCloseTo(3_000_000 / 1_000_000, 6);
  });

  it('does not call an ordinary afternoon a volume surge', () => {
    // Without pacing, 900k against a 2m daily median late in the day would
    // read as quiet - and 900k early would read as quiet too. Pacing fixes it.
    const obs = volumeSpike(ctx({ quote: quote({ volume: 1_000_000 }), stats: stats({ medVol20: 2_000_000 }) }));
    expect(obs?.value).toBeCloseTo(1, 6);
    expect(obs?.value).toBeLessThan(THRESHOLDS.rvolEnter);
  });

  it('declines when there is no volume baseline', () => {
    expect(volumeSpike(ctx({ stats: stats({ medVol20: 0 }) }))).toBeNull();
  });
});

describe('trendFlip', () => {
  it('reports the regime once the averages have separated', () => {
    const obs = trendFlip(ctx({ stats: stats({ sma20: 105, sma50: 100, bars: 200 }) }));
    expect(obs?.direction).toBe('up');
    expect(obs?.discriminator).toBe('above');
  });

  it('uses the regime as the discriminator, so it fires once per crossing', () => {
    const up = trendFlip(ctx({ stats: stats({ sma20: 105, sma50: 100, bars: 200 }) }));
    const down = trendFlip(ctx({ stats: stats({ sma20: 95, sma50: 100, bars: 200 }) }));
    expect(up?.discriminator).toBe('above');
    expect(down?.discriminator).toBe('below');
  });

  it('waits for enough history to have a 50-session average', () => {
    expect(trendFlip(ctx({ stats: stats({ bars: 40 }) }))).toBeNull();
  });
});

describe('volRegime', () => {
  it('detects a name becoming materially riskier', () => {
    const obs = volRegime(ctx({ stats: stats({ sigmaShort: 0.05, sigmaDaily: 0.02, bars: 100 }) }));
    expect(obs?.value).toBeCloseTo(2.5, 6);
    expect(obs?.value).toBeGreaterThan(THRESHOLDS.volRegimeEnter);
  });

  it('stays quiet when short and long volatility agree', () => {
    const obs = volRegime(ctx({ stats: stats({ sigmaShort: 0.021, sigmaDaily: 0.02, bars: 100 }) }));
    expect(obs?.value).toBeLessThan(THRESHOLDS.volRegimeEnter);
  });
});

describe('drawdown', () => {
  it('buckets the drawdown so each level fires once', () => {
    const obs = drawdown(ctx({ quote: quote({ price: 78 }), stats: stats({ peak52w: 100 }) }));
    expect(obs?.evidence.bucket).toBe(20);
    expect(obs?.discriminator).toBe('dd20');
  });

  it('moves to a new episode as the drawdown deepens', () => {
    const shallow = drawdown(ctx({ quote: quote({ price: 88 }), stats: stats({ peak52w: 100 }) }));
    const deep = drawdown(ctx({ quote: quote({ price: 62 }), stats: stats({ peak52w: 100 }) }));
    expect(shallow?.discriminator).toBe('dd10');
    expect(deep?.discriminator).toBe('dd30');
  });

  it('reports nothing near the highs', () => {
    const obs = drawdown(ctx({ quote: quote({ price: 99 }), stats: stats({ peak52w: 100 }) }));
    expect(obs?.value).toBe(0);
  });
});

describe('staleData', () => {
  it('fires once the quote is older than the tolerance', () => {
    const obs = staleData(ctx({ quote: quote({ asOf: NOW - 45 * 60_000 }) }));
    expect(obs?.value).toBeGreaterThan(1);
    expect(obs?.headline).toContain('No fresh price');
  });

  it('stays quiet on a current quote', () => {
    const obs = staleData(ctx({ quote: quote({ asOf: NOW - 1000 }) }));
    expect(obs?.value).toBeLessThan(obs?.exit ?? 1);
  });

  it('works without any statistics at all', () => {
    // Data integrity must be reportable for an instrument we know nothing
    // about - that is exactly when it matters most.
    const obs = staleData(ctx({ stats: null, quote: quote({ asOf: NOW - 60 * 60_000 }) }));
    expect(obs?.value).toBeGreaterThan(1);
  });
});

describe('dataConflict', () => {
  it('surfaces a disagreement rather than hiding it', () => {
    const obs = dataConflict(
      ctx({
        quote: quote({
          conflict: {
            spread: 0.03,
            resolution: 'median',
            quotes: [
              { source: 'a', price: 100, asOf: NOW },
              { source: 'b', price: 103, asOf: NOW },
            ],
          },
        }),
      }),
    );

    expect(obs?.value).toBeGreaterThan(obs?.enter ?? 0);
    expect(obs?.evidence.sources).toContain('a@100.00');
    expect(obs?.headline).toContain('disputed');
  });

  it('is quiet when the sources agree', () => {
    const obs = dataConflict(ctx());
    expect(obs?.value).toBe(0);
  });
});
