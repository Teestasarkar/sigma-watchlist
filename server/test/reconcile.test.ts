/**
 * Reconciling several providers into one price we are willing to show.
 *
 * The rule under test throughout: never silently pick a winner. A
 * disagreement must survive into the stored quote, lower its confidence, and
 * reach the user.
 */

import { describe, expect, it } from 'vitest';

import {
  classifyFreshness,
  computeConfidence,
  reconcileQuotes,
  type ReconcileOptions,
} from '../src/providers/reconcile.js';
import type { RawQuote } from '../src/domain/types.js';

const NOW = 1_700_000_000_000;

const OPTS: ReconcileOptions = {
  tolerance: 0.005,
  freshMs: 30_000,
  delayedMs: 5 * 60_000,
  staleMs: 30 * 60_000,
  preference: ['primary', 'secondary', 'tertiary'],
};

function raw(source: string, price: number, over: Partial<RawQuote> = {}): RawQuote {
  return {
    symbol: 'TEST',
    price,
    prevClose: 100,
    dayOpen: 100,
    dayHigh: Math.max(price, 101),
    dayLow: Math.min(price, 99),
    volume: 1_000_000,
    asOf: NOW - 1000,
    source,
    halted: false,
    ...over,
  };
}

describe('classifyFreshness', () => {
  it('places a quote on the ladder by age', () => {
    expect(classifyFreshness(NOW - 1000, NOW, OPTS)).toBe('fresh');
    expect(classifyFreshness(NOW - 60_000, NOW, OPTS)).toBe('delayed');
    expect(classifyFreshness(NOW - 10 * 60_000, NOW, OPTS)).toBe('stale');
    expect(classifyFreshness(NOW - 5 * 3600_000, NOW, OPTS)).toBe('stale');
  });

  it('calls a future timestamp unknown rather than fresh', () => {
    // A clock skewed minutes into the future is broken, not current.
    expect(classifyFreshness(NOW + 10 * 60_000, NOW, OPTS)).toBe('unknown');
    // A second or two of skew is normal and must not trip it.
    expect(classifyFreshness(NOW + 2000, NOW, OPTS)).toBe('fresh');
  });
});

describe('computeConfidence', () => {
  const base = { tolerance: 0.005, halted: false, conflictSpread: null };

  it('is full for a fresh, agreed, well-historied quote', () => {
    expect(
      computeConfidence({ ...base, freshness: 'fresh', bars: 260, minBarsForStats: 25 }),
    ).toBe(1);
  });

  it('falls as the quote ages', () => {
    const fresh = computeConfidence({ ...base, freshness: 'fresh' });
    const delayed = computeConfidence({ ...base, freshness: 'delayed' });
    const stale = computeConfidence({ ...base, freshness: 'stale' });
    expect(delayed).toBeLessThan(fresh);
    expect(stale).toBeLessThan(delayed);
  });

  it('penalises disagreement in proportion to how bad it is', () => {
    const slight = computeConfidence({ ...base, freshness: 'fresh', conflictSpread: 0.006 });
    const severe = computeConfidence({ ...base, freshness: 'fresh', conflictSpread: 0.08 });
    expect(slight).toBeLessThan(1);
    expect(severe).toBeLessThan(slight);
  });

  it('compounds independent reasons for doubt', () => {
    // Stale AND disputed AND thin should be obviously untrustworthy, not
    // merely slightly discounted.
    const bad = computeConfidence({
      ...base,
      freshness: 'stale',
      conflictSpread: 0.05,
      bars: 5,
      minBarsForStats: 25,
    });
    expect(bad).toBeLessThan(0.15);
  });

  it('stays within 0..1', () => {
    const c = computeConfidence({
      ...base,
      freshness: 'unknown',
      conflictSpread: 10,
      halted: true,
      bars: 0,
      minBarsForStats: 25,
    });
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThanOrEqual(1);
  });
});

describe('reconcileQuotes', () => {
  it('returns null when there is nothing usable', () => {
    expect(reconcileQuotes([], NOW, OPTS)).toBeNull();
  });

  it('discards a zero or negative price rather than showing -100%', () => {
    // A provider bug returning 0 must not become a catastrophic-looking move.
    const q = reconcileQuotes([raw('primary', 0), raw('secondary', 100)], NOW, OPTS);
    expect(q?.price).toBe(100);
    expect(q?.source).toBe('secondary');
  });

  it('rejects a quote whose previous close is unusable', () => {
    expect(reconcileQuotes([raw('primary', 100, { prevClose: 0 })], NOW, OPTS)).toBeNull();
  });

  it('uses the single source when only one answers', () => {
    const q = reconcileQuotes([raw('secondary', 101)], NOW, OPTS);
    expect(q?.price).toBe(101);
    expect(q?.conflict).toBeNull();
    expect(q?.source).toBe('secondary');
  });

  it('prefers the more trusted source when they agree', () => {
    const q = reconcileQuotes([raw('secondary', 100.1), raw('primary', 100.2)], NOW, OPTS);
    expect(q?.price).toBe(100.2);
    expect(q?.conflict).toBeNull();
  });

  it('records a conflict and takes the median when they disagree', () => {
    const q = reconcileQuotes(
      [raw('primary', 100), raw('secondary', 103), raw('tertiary', 100.5)],
      NOW,
      OPTS,
    );

    expect(q?.conflict).not.toBeNull();
    expect(q?.conflict?.resolution).toBe('median');
    // The median is robust to one bad feed; the freshest is not.
    expect(q?.price).toBe(100.5);
    expect(q?.conflict?.quotes).toHaveLength(3);
    expect(q?.confidence).toBeLessThan(1);
  });

  it('does not let one broken fast feed win on freshness alone', () => {
    const q = reconcileQuotes(
      [
        raw('primary', 100, { asOf: NOW - 5000 }),
        raw('secondary', 100.2, { asOf: NOW - 5000 }),
        raw('tertiary', 180, { asOf: NOW - 10 }), // wrong, but newest
      ],
      NOW,
      OPTS,
    );
    expect(q?.price).toBe(100.2);
  });

  it('takes the newest asOf even when the price came from elsewhere', () => {
    const q = reconcileQuotes(
      [raw('primary', 100, { asOf: NOW - 60_000 }), raw('secondary', 100.1, { asOf: NOW - 500 })],
      NOW,
      OPTS,
    );
    // Our knowledge is as recent as the newest source, whichever price we took.
    expect(q?.asOf).toBe(NOW - 500);
  });

  it('flags halted if any venue reports a halt', () => {
    const q = reconcileQuotes(
      [raw('primary', 100), raw('secondary', 100.1, { halted: true })],
      NOW,
      OPTS,
    );
    expect(q?.halted).toBe(true);
  });

  it('keeps the accepted price inside the reported day range', () => {
    // A median outside the leader's high/low would make the stored quote claim
    // a price outside its own range, which the range detector would read as a
    // breakout.
    const q = reconcileQuotes(
      [
        raw('primary', 100, { dayHigh: 100.5, dayLow: 99.5 }),
        raw('secondary', 108, { dayHigh: 108.5, dayLow: 99.5 }),
      ],
      NOW,
      OPTS,
    );

    expect(q).not.toBeNull();
    expect(q!.price).toBeLessThanOrEqual(q!.dayHigh);
    expect(q!.price).toBeGreaterThanOrEqual(q!.dayLow);
  });

  it('names every contributing source', () => {
    const q = reconcileQuotes([raw('primary', 100), raw('secondary', 100.1)], NOW, OPTS);
    expect(q?.source).toBe('primary+secondary');
  });

  it('treats a spread just inside tolerance as agreement', () => {
    // 0.4% apart with a 0.5% tolerance: same price for our purposes.
    const q = reconcileQuotes([raw('primary', 100), raw('secondary', 100.4)], NOW, OPTS);
    expect(q?.conflict).toBeNull();
  });
});
