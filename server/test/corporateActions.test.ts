/**
 * Splits and dividends.
 *
 * The failure this prevents is the most embarrassing one a watchlist can have:
 * NVIDIA splits 10-for-1, the price goes from $1,200 to $120, and the product
 * fires its loudest alert to tell a user their position collapsed 90%. It did
 * not. They own ten times as many shares.
 */

import { describe, expect, it } from 'vitest';

import { adjusted, atrPct, computeStats } from '../src/domain/stats.js';
import type { Bar } from '../src/domain/types.js';

const DAY = 86_400_000;

function bar(i: number, close: number, adjClose: number | null = null): Bar {
  return {
    symbol: 'TEST',
    ts: i * DAY,
    open: close * 0.995,
    high: close * 1.01,
    low: close * 0.99,
    close,
    adjClose,
    volume: 1_000_000,
    source: 'test',
  };
}

/**
 * A series that splits 10-for-1 partway through.
 *
 * Raw closes step from ~1200 to ~120. Adjusted closes follow the provider's
 * convention: history is scaled down so the newest adjusted close equals the
 * newest raw close, and the series is continuous across the split.
 */
function splitSeries(n = 120, splitAt = 80): Bar[] {
  const bars: Bar[] = [];
  for (let i = 0; i < n; i++) {
    // A smooth underlying path in post-split money.
    const trueLevel = 100 + i * 0.25;
    const preSplit = i < splitAt;
    const rawClose = preSplit ? trueLevel * 10 : trueLevel;
    const b = bar(i, rawClose, trueLevel);
    if (preSplit) {
      // Raw high/low are in pre-split money too.
      b.open = rawClose * 0.995;
      b.high = rawClose * 1.01;
      b.low = rawClose * 0.99;
    }
    bars.push(b);
  }
  return bars;
}

describe('the adjusted close is what statistics use', () => {
  it('falls back to the raw close when no adjustment is supplied', () => {
    expect(adjusted(bar(0, 100, null))).toBe(100);
    expect(adjusted(bar(0, 100, 0))).toBe(100);
    expect(adjusted(bar(0, 100, Number.NaN))).toBe(100);
    expect(adjusted(bar(0, 100, 95))).toBe(95);
  });

  it('keeps volatility sane across a split', () => {
    /*
     * The headline test. On raw closes a 10-for-1 split is a -90% daily
     * return, which on its own inflates a year of volatility by an order of
     * magnitude - and every sigma computed against it is then meaningless.
     */
    const bars = splitSeries();
    const adjustedStats = computeStats('TEST', bars, bars, 0);

    // Same series, but with the adjustment thrown away.
    const rawOnly = bars.map((b) => ({ ...b, adjClose: null }));
    const rawStats = computeStats('TEST', rawOnly, rawOnly, 0);

    expect(adjustedStats.sigmaDaily).toBeLessThan(0.02);
    expect(rawStats.sigmaDaily).toBeGreaterThan(0.15);
    // Not a marginal improvement - an order of magnitude.
    expect(rawStats.sigmaDaily / adjustedStats.sigmaDaily).toBeGreaterThan(10);
  });

  it('keeps the 52-week high comparable with today price', () => {
    /*
     * A raw pre-split high of ~$1,200 would sit permanently above a post-split
     * price of ~$130, so the range-break detector could never fire again for
     * that instrument. Silent, permanent, and very hard to notice.
     */
    const bars = splitSeries();
    const stats = computeStats('TEST', bars, bars, 0);
    const latest = adjusted(bars[bars.length - 1] as Bar);

    expect(stats.hi52w).toBeLessThan(latest * 1.1);
    expect(stats.hi52w).toBeGreaterThan(latest * 0.5);

    const rawOnly = bars.map((b) => ({ ...b, adjClose: null }));
    const rawStats = computeStats('TEST', rawOnly, rawOnly, 0);
    // Without adjustment the high is an unreachable ten times the price.
    expect(rawStats.hi52w).toBeGreaterThan(latest * 5);
  });

  it('keeps the drawdown peak honest', () => {
    // Otherwise every post-split instrument reports a permanent 90% drawdown.
    const bars = splitSeries();
    const stats = computeStats('TEST', bars, bars, 0);
    const latest = adjusted(bars[bars.length - 1] as Bar);
    const drawdown = (stats.peak52w - latest) / stats.peak52w;
    expect(drawdown).toBeLessThan(0.1);
  });

  it('keeps the average true range proportionate', () => {
    const bars = splitSeries();

    // A window wide enough to contain the split. The default 14-bar window sits
    // entirely after it, where raw and adjusted prices are identical - so it
    // would compare two numbers that cannot differ.
    const WINDOW = 60;

    expect(atrPct(bars, WINDOW)).toBeLessThan(0.05);

    const rawOnly = bars.map((b) => ({ ...b, adjClose: null }));
    // One split day contributes a true range of ~90% of the price.
    expect(atrPct(rawOnly, WINDOW)).toBeGreaterThan(atrPct(bars, WINDOW) * 5);
  });

  it('leaves an unsplit series untouched', () => {
    // The adjustment must be a no-op when there is nothing to adjust.
    const plain = Array.from({ length: 120 }, (_, i) => bar(i, 100 + i * 0.25, 100 + i * 0.25));
    const withAdj = computeStats('TEST', plain, plain, 0);
    const withoutAdj = computeStats(
      'TEST',
      plain.map((b) => ({ ...b, adjClose: null })),
      plain.map((b) => ({ ...b, adjClose: null })),
      0,
    );

    expect(withAdj.sigmaDaily).toBeCloseTo(withoutAdj.sigmaDaily, 10);
    expect(withAdj.hi52w).toBeCloseTo(withoutAdj.hi52w, 6);
  });

  it('produces a sane beta across a split', () => {
    // The market did not move 90% that day, so an unadjusted asset return
    // would regress to a wildly wrong beta.
    const asset = splitSeries();
    const market = asset.map((b, i) => ({
      ...b,
      symbol: 'MKT',
      close: 400 + i * 0.5,
      adjClose: 400 + i * 0.5,
    }));

    const stats = computeStats('TEST', asset, market, 0);
    expect(Number.isFinite(stats.beta)).toBe(true);
    expect(Math.abs(stats.beta)).toBeLessThan(20);
  });
});

describe('the split price factor', () => {
  it('converts a pre-split checkpoint into post-split money', () => {
    /*
     * A 10-for-1 split: shares multiply by 10, price divides by 10. So a
     * checkpoint captured at $1,200 must become $120 to be comparable, which
     * is a multiplication by denominator/numerator.
     */
    const numerator = 10;
    const denominator = 1;
    const factor = denominator / numerator;

    expect(1200 * factor).toBeCloseTo(120, 10);
  });

  it('handles a reverse split', () => {
    // 1-for-10: shares divide by 10, price multiplies by 10.
    const factor = 10 / 1;
    expect(0.5 * factor).toBeCloseTo(5, 10);
  });

  it('handles a fractional ratio', () => {
    // 3-for-2: price becomes two thirds.
    const factor = 2 / 3;
    expect(150 * factor).toBeCloseTo(100, 10);
  });
});
