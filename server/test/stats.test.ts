/**
 * Statistics.
 *
 * These are checked against hand-computed values rather than golden snapshots.
 * A snapshot test here would happily lock in a wrong number forever, and every
 * claim the product makes about significance is downstream of this file.
 */

import { describe, expect, it } from 'vitest';

import {
  atrPct,
  computeStats,
  drawdownFromPeak,
  horizonSigma,
  logReturns,
  mean,
  median,
  regress,
  saturate,
  sigmaOfMove,
  sma,
  stdev,
} from '../src/domain/stats.js';
import type { Bar } from '../src/domain/types.js';

const bar = (ts: number, o: number, h: number, l: number, c: number, v = 1_000_000): Bar => ({
  symbol: 'TEST',
  ts,
  open: o,
  high: h,
  low: l,
  close: c,
  volume: v,
  source: 'test',
});

describe('descriptive statistics', () => {
  it('computes the mean', () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(mean([])).toBe(0);
  });

  it('computes the sample standard deviation', () => {
    // [2,4,4,4,5,5,7,9] has population sd 2 and sample sd sqrt(32/7).
    expect(stdev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(Math.sqrt(32 / 7), 10);
  });

  it('returns zero standard deviation for degenerate input', () => {
    // Fewer than two points cannot have a spread. Returning 0 rather than NaN
    // matters: NaN would propagate into every sigma downstream.
    expect(stdev([])).toBe(0);
    expect(stdev([5])).toBe(0);
    expect(stdev([3, 3, 3, 3])).toBe(0);
  });

  it('computes the median for odd and even lengths', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  it('does not mutate its input when taking a median', () => {
    const xs = [3, 1, 2];
    median(xs);
    expect(xs).toEqual([3, 1, 2]);
  });

  it('computes log returns and drops non-positive prices', () => {
    const rets = logReturns([100, 110]);
    expect(rets).toHaveLength(1);
    expect(rets[0]).toBeCloseTo(Math.log(1.1), 12);

    // A zero or negative price is bad data; it must not produce -Infinity.
    expect(logReturns([100, 0, 110]).every(Number.isFinite)).toBe(true);
  });

  it('falls back to a shorter window for a short series', () => {
    expect(sma([1, 2, 3], 10)).toBe(2);
  });
});

describe('average true range', () => {
  it('accounts for gaps, not just the intraday range', () => {
    // Day two opens far above day one's close: true range must span the gap.
    const bars = [bar(1, 100, 101, 99, 100), bar(2, 120, 121, 119, 120)];
    // TR = max(121-119, |121-100|, |119-100|) = 21, close = 120.
    expect(atrPct(bars)).toBeCloseTo(21 / 120, 10);
  });

  it('returns zero when there is nothing to measure', () => {
    expect(atrPct([])).toBe(0);
    expect(atrPct([bar(1, 100, 101, 99, 100)])).toBe(0);
  });
});

describe('regression against the market factor', () => {
  it('recovers a known beta exactly for a noiseless series', () => {
    const market = Array.from({ length: 60 }, (_, i) => Math.sin(i) * 0.01);
    const asset = market.map((m) => 1.5 * m + 0.0002);

    const { beta, alpha, residSigma, r2 } = regress(asset, market);
    expect(beta).toBeCloseTo(1.5, 8);
    expect(alpha).toBeCloseTo(0.0002, 8);
    expect(residSigma).toBeCloseTo(0, 8);
    expect(r2).toBeCloseTo(1, 6);
  });

  it('separates the idiosyncratic component from the market one', () => {
    const market = Array.from({ length: 200 }, (_, i) => Math.sin(i * 0.7) * 0.012);
    // Deterministic pseudo-noise, so the assertion is stable.
    const noise = Array.from({ length: 200 }, (_, i) => Math.cos(i * 2.3) * 0.008);
    const asset = market.map((m, i) => 0.8 * m + (noise[i] as number));

    const { beta, residSigma } = regress(asset, market);
    expect(beta).toBeCloseTo(0.8, 1);
    // The residual should carry roughly the noise's own spread.
    expect(residSigma).toBeGreaterThan(0.004);
    expect(residSigma).toBeLessThan(0.009);
  });

  it('falls back to beta 1 when the market has no variance', () => {
    // A constant market explains nothing; assuming beta 1 is the conservative
    // choice, since it attributes the move to the market rather than to news.
    const flat = new Array(40).fill(0.001) as number[];
    const asset = Array.from({ length: 40 }, (_, i) => i * 0.0001);
    expect(regress(asset, flat).beta).toBe(1);
  });

  it('declines to regress on too few observations', () => {
    expect(regress([0.01, 0.02], [0.01, 0.02]).beta).toBe(1);
  });
});

describe('sigma of a move', () => {
  it('scales by the square root of elapsed sessions', () => {
    // Four sessions of risk is twice one session's.
    expect(horizonSigma(0.02, 4)).toBeCloseTo(0.04, 12);
    expect(horizonSigma(0.02, 1)).toBeCloseTo(0.02, 12);
  });

  it('floors the horizon so a fast move is not infinitely significant', () => {
    // Without the floor, a 1% move in one second would be thousands of sigma.
    const tiny = sigmaOfMove(0.01, 0.02, 1e-9);
    expect(tiny).not.toBeNull();
    expect(Math.abs(tiny as number)).toBeLessThan(2);
  });

  it('is the whole point: the same percentage is not the same news', () => {
    const quiet = sigmaOfMove(0.02, 0.007, 1); // a utility
    const wild = sigmaOfMove(0.02, 0.06, 1); // a meme stock

    expect(quiet).not.toBeNull();
    expect(wild).not.toBeNull();
    expect(quiet as number).toBeGreaterThan(2.5);
    expect(wild as number).toBeLessThan(0.5);
  });

  it('returns null rather than a number it cannot justify', () => {
    // "We don't know" and "nothing happened" must stay distinguishable.
    expect(sigmaOfMove(0.02, 0, 1)).toBeNull();
    expect(sigmaOfMove(Number.NaN, 0.02, 1)).toBeNull();
  });
});

describe('helpers', () => {
  it('measures drawdown from a peak and never goes negative', () => {
    expect(drawdownFromPeak(80, 100)).toBeCloseTo(0.2, 10);
    expect(drawdownFromPeak(120, 100)).toBe(0);
    expect(drawdownFromPeak(80, 0)).toBe(0);
  });

  it('saturates magnitudes into a comparable 0..1 band', () => {
    expect(saturate(0, 4)).toBe(0);
    expect(saturate(4, 4)).toBeCloseTo(0.5, 10);
    expect(saturate(1e9, 4)).toBeLessThan(1);
    // Direction must not affect intensity.
    expect(saturate(-3, 4)).toBeCloseTo(saturate(3, 4), 12);
  });
});

describe('computeStats', () => {
  const DAY = 86_400_000;

  /** A deterministic series with a known shape. */
  function series(n: number, start: number, step: (i: number) => number): Bar[] {
    const bars: Bar[] = [];
    let price = start;
    for (let i = 0; i < n; i++) {
      const prev = price;
      price = price * (1 + step(i));
      bars.push(bar(i * DAY, prev, Math.max(prev, price) * 1.005, Math.min(prev, price) * 0.995, price));
    }
    return bars;
  }

  it('summarises a series without producing NaN anywhere', () => {
    const bars = series(120, 100, (i) => Math.sin(i * 0.6) * 0.015);
    const stats = computeStats('TEST', bars, bars, 1_000);

    for (const [key, value] of Object.entries(stats)) {
      if (typeof value === 'number') {
        expect(Number.isFinite(value), `${key} should be finite`).toBe(true);
      }
    }

    expect(stats.bars).toBe(120);
    expect(stats.sigmaDaily).toBeGreaterThan(0);
    expect(stats.hi52w).toBeGreaterThanOrEqual(stats.lo52w);
    // Regressed against itself, beta is 1 by construction.
    expect(stats.beta).toBeCloseTo(1, 6);
  });

  it('aligns asset and market bars by timestamp, not by position', () => {
    // The asset listed late, so a positional zip would pair the wrong days and
    // produce a meaningless beta.
    const market = series(100, 400, (i) => Math.sin(i * 0.4) * 0.01);
    const asset = market.slice(40).map((b) => ({
      ...b,
      symbol: 'LATE',
      close: b.close * 0.25,
      open: b.open * 0.25,
      high: b.high * 0.25,
      low: b.low * 0.25,
    }));

    const stats = computeStats('LATE', asset, market, 1_000);
    // Identical returns, quarter the price: beta must still be ~1.
    expect(stats.beta).toBeCloseTo(1, 4);
  });

  it('survives a single-bar history', () => {
    const stats = computeStats('THIN', [bar(0, 10, 10, 10, 10)], [], 1);
    expect(stats.bars).toBe(1);
    expect(stats.sigmaDaily).toBe(0);
    expect(Number.isFinite(stats.hi52w)).toBe(true);
  });

  it('caps the 52-week window at a year of sessions', () => {
    // A spike 300 sessions ago must not still count as the 52-week high.
    const bars = series(400, 100, () => 0);
    (bars[10] as Bar).high = 9_999;
    const stats = computeStats('TEST', bars, bars, 1);
    expect(stats.hi52w).toBeLessThan(9_999);
  });
});
