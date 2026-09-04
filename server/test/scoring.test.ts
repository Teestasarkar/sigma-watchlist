/**
 * Ranking and the noise budget.
 *
 * Detection decides what happened; this decides what the user reads. The
 * budget and the per-symbol cap are the difference between a briefing and a
 * feed, so they are asserted rather than assumed.
 */

import { describe, expect, it } from 'vitest';

import { KIND_WEIGHT, rankSignals, recencyFactor, scoreSignal } from '../src/domain/signals/scoring.js';
import type { Signal, SignalKind, WatchlistItem } from '../src/domain/types.js';

const NOW = 1_700_000_000_000;

const OPTS = {
  now: NOW,
  recencyHalfLifeMs: 6 * 3600_000,
  maxItems: 12,
  maxPerSymbol: 2,
};

function signal(over: Partial<Signal> = {}): Signal {
  return {
    id: over.id ?? `sig-${Math.random().toString(36).slice(2)}`,
    symbol: 'AAA',
    kind: 'sigma_move',
    episodeKey: 'e1',
    direction: 'up',
    severity: 0.6,
    detectedAt: NOW - 60_000,
    asOf: NOW - 60_000,
    headline: 'something happened',
    evidence: { sigma: 3 },
    supersededAt: null,
    ...over,
  };
}

function item(over: Partial<WatchlistItem> = {}): WatchlistItem {
  return {
    symbol: 'AAA',
    addedAt: 0,
    pinned: false,
    muted: false,
    minSigma: null,
    note: null,
    sortKey: 0,
    ...over,
  };
}

describe('recency decay', () => {
  it('is 1 for something that just happened', () => {
    expect(recencyFactor(0, 1000)).toBe(1);
  });

  it('halves at the half-life', () => {
    expect(recencyFactor(1000, 1000)).toBeCloseTo(0.5, 10);
    expect(recencyFactor(2000, 1000)).toBeCloseTo(0.25, 10);
  });

  it('decays slow-moving signals more gently', () => {
    // A trend change from yesterday is still relevant; a 3-sigma tick is not.
    const fast = recencyFactor(24 * 3600_000, 6 * 3600_000, 1);
    const slow = recencyFactor(24 * 3600_000, 6 * 3600_000, 6);
    expect(slow).toBeGreaterThan(fast * 5);
  });
});

describe('scoreSignal', () => {
  it('zeroes a muted symbol regardless of severity', () => {
    const result = scoreSignal(signal({ severity: 1 }), item({ muted: true }), 1, OPTS);
    expect(result.score).toBe(0);
    expect(result.suppressed).toBe('muted');
  });

  it('respects a per-symbol significance floor', () => {
    const below = scoreSignal(
      signal({ evidence: { sigma: 2.1 } }),
      item({ minSigma: 3 }),
      1,
      OPTS,
    );
    expect(below.suppressed).toBe('below-threshold');

    const above = scoreSignal(
      signal({ evidence: { sigma: 4 } }),
      item({ minSigma: 3 }),
      1,
      OPTS,
    );
    expect(above.suppressed).toBeNull();
  });

  it('never lets a threshold hide a data-integrity warning', () => {
    // Raising your price threshold must not stop us telling you the price is
    // an hour old. Those signals carry no sigma, so the filter cannot apply.
    const stale = scoreSignal(
      signal({ kind: 'stale_data', evidence: { ageMs: 3600_000 } }),
      item({ minSigma: 5 }),
      1,
      OPTS,
    );
    expect(stale.suppressed).toBeNull();
    expect(stale.score).toBeGreaterThan(0);
  });

  it('discounts market claims made from a low-confidence price', () => {
    const trusted = scoreSignal(signal(), item(), 1, OPTS);
    const doubtful = scoreSignal(signal(), item(), 0.3, OPTS);
    expect(doubtful.score).toBeLessThan(trusted.score);
  });

  it('does not discount integrity signals for low confidence', () => {
    // Discounting "this data is unreliable" for being unreliable is circular.
    const s = signal({ kind: 'data_conflict', evidence: { spread: 0.04 } });
    const trusted = scoreSignal(s, item(), 1, OPTS);
    const doubtful = scoreSignal(s, item(), 0.2, OPTS);
    expect(doubtful.score).toBeCloseTo(trusted.score, 10);
  });

  it('boosts pinned symbols without making them unbeatable', () => {
    const pinned = scoreSignal(signal({ severity: 0.3 }), item({ pinned: true }), 1, OPTS);
    const plain = scoreSignal(signal({ severity: 0.3 }), item(), 1, OPTS);
    const big = scoreSignal(signal({ severity: 1 }), item(), 1, OPTS);

    expect(pinned.score).toBeGreaterThan(plain.score);
    // A pinned minor event should still lose to another symbol's major one.
    expect(pinned.score).toBeLessThan(big.score);
  });

  it('ranks a company-specific move above a market-wide one', () => {
    expect(KIND_WEIGHT.idio_move).toBeGreaterThan(KIND_WEIGHT.sigma_move);
  });

  it('explains itself', () => {
    const result = scoreSignal(signal(), item({ pinned: true }), 1, OPTS);
    expect(result.rationale).toContain('3.0σ');
    expect(result.rationale).toContain('pinned');
  });
});

describe('rankSignals', () => {
  const names = new Map([['AAA', 'Alpha']]);

  function rank(signals: Signal[], over: Partial<typeof OPTS> = {}) {
    const items = new Map<string, WatchlistItem>();
    for (const s of signals) if (!items.has(s.symbol)) items.set(s.symbol, item({ symbol: s.symbol }));

    const confidence = new Map<string, number>();
    for (const s of signals) confidence.set(s.symbol, 1);

    return rankSignals(
      { signals, items, names, readIds: new Set(), confidence },
      { ...OPTS, ...over },
    );
  }

  it('groups by symbol and orders by the strongest signal', () => {
    const result = rank([
      signal({ id: 'a', symbol: 'AAA', severity: 0.3 }),
      signal({ id: 'b', symbol: 'BBB', severity: 0.9 }),
    ]);

    expect(result.groups[0]?.symbol).toBe('BBB');
    expect(result.groups[1]?.symbol).toBe('AAA');
  });

  it('caps how much of the briefing one symbol can occupy', () => {
    // One dramatic stock must not hide the other nine things that happened.
    const many = Array.from({ length: 6 }, (_, i) =>
      signal({ id: `s${i}`, symbol: 'AAA', kind: (['sigma_move', 'gap', 'volume_spike', 'drawdown', 'trend_flip', 'vol_regime'] as SignalKind[])[i] as SignalKind }),
    );

    const result = rank(many, { maxPerSymbol: 2 });
    expect(result.groups[0]?.signals).toHaveLength(2);
    expect(result.suppressedCount).toBe(4);
  });

  it('enforces the overall noise budget by signal count', () => {
    const signals = Array.from({ length: 20 }, (_, i) =>
      signal({ id: `s${i}`, symbol: `SYM${i}`, severity: 0.5 + i / 100 }),
    );

    const result = rank(signals, { maxItems: 5 });
    const shown = result.groups.reduce((n, g) => n + g.signals.length, 0);
    expect(shown).toBe(5);
    expect(result.suppressedCount).toBe(15);
  });

  it('counts filtered signals separately from budgeted ones', () => {
    const items = new Map([['AAA', item({ muted: true })]]);
    const result = rankSignals(
      {
        signals: [signal({ symbol: 'AAA' })],
        items,
        names,
        readIds: new Set(),
        confidence: new Map([['AAA', 1]]),
      },
      OPTS,
    );

    expect(result.groups).toHaveLength(0);
    expect(result.filteredCount).toBe(1);
    // Muted is a user preference, not the budget running out.
    expect(result.suppressedCount).toBe(0);
  });

  it('sinks already-read signals below unread ones', () => {
    const readIds = new Set(['read']);
    const result = rankSignals(
      {
        signals: [
          signal({ id: 'read', symbol: 'AAA', severity: 0.9 }),
          signal({ id: 'unread', symbol: 'AAA', kind: 'gap', severity: 0.5 }),
        ],
        items: new Map([['AAA', item()]]),
        names,
        readIds,
        confidence: new Map([['AAA', 1]]),
      },
      OPTS,
    );

    expect(result.groups[0]?.signals[0]?.id).toBe('unread');
    expect(result.groups[0]?.signals[1]?.isRead).toBe(true);
  });

  it('returns an empty briefing rather than throwing on no input', () => {
    const result = rank([]);
    expect(result.groups).toEqual([]);
    expect(result.suppressedCount).toBe(0);
  });
});
