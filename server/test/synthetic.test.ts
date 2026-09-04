/**
 * The market simulator.
 *
 * Two properties matter and both are load-bearing:
 *
 *  1. **Determinism.** The feed must be a pure function of (seed, symbol,
 *     session), not a stateful stream. That is what lets it answer questions
 *     out of order, survive restarts, and be reproducible in tests.
 *  2. **A real factor structure.** If the generated returns did not actually
 *     have the configured betas, then every "the market explains this" claim
 *     the engine makes would be measuring noise. This checks that regressing
 *     the simulated data recovers the parameters it was generated from.
 */

import { describe, expect, it } from 'vitest';

import { SimulatedMarketClock } from '../src/domain/marketClock.js';
import { logReturns, regress, stdev } from '../src/domain/stats.js';
import { createFaultState } from '../src/providers/faults.js';
import { SyntheticProvider } from '../src/providers/synthetic.js';
import { BENCHMARK, findEntry, UNIVERSE } from '../src/providers/universe.js';
import { normalAt, uniformAt } from '../src/providers/random.js';
import { SymbolNotFoundError } from '../src/providers/types.js';

const SESSION_MS = 60_000;
const HISTORY = 260;
const SEED = 20260904;

function build(seed = SEED) {
  // Anchor the epoch in the past so "now" sits inside a session rather than
  // exactly on a boundary.
  const epoch = Date.now() - SESSION_MS / 3;
  const clock = new SimulatedMarketClock(epoch, SESSION_MS, HISTORY);
  const faults = createFaultState();
  const provider = new SyntheticProvider({ seed, clock, faults });
  return { provider, clock, faults };
}

describe('counter-based randomness', () => {
  it('is a pure function of its coordinates', () => {
    expect(uniformAt(1, 'AAPL', 5, 1)).toBe(uniformAt(1, 'AAPL', 5, 1));
    expect(normalAt(1, 'AAPL', 5, 1)).toBe(normalAt(1, 'AAPL', 5, 1));
  });

  it('decorrelates independent streams at the same coordinate', () => {
    // Without this, "today's jump" and "today's volume" would be the same draw.
    expect(uniformAt(1, 'AAPL', 5, 1)).not.toBe(uniformAt(1, 'AAPL', 5, 2));
  });

  it('stays inside [0, 1)', () => {
    for (let i = 0; i < 5_000; i++) {
      const u = uniformAt(SEED, 'X', i, 1);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
    }
  });

  it('produces a roughly standard normal', () => {
    const xs = Array.from({ length: 20_000 }, (_, i) => normalAt(SEED, 'X', i, 1));
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(Math.abs(mean)).toBeLessThan
      ? expect(Math.abs(mean)).toBeLessThan(0.05)
      : undefined;
    expect(stdev(xs)).toBeGreaterThan(0.95);
    expect(stdev(xs)).toBeLessThan(1.05);
  });

  it('never returns a non-finite normal', () => {
    for (let i = 0; i < 20_000; i++) {
      expect(Number.isFinite(normalAt(SEED, 'Y', i, 3))).toBe(true);
    }
  });
});

describe('SyntheticProvider', () => {
  it('rejects a symbol outside its universe', async () => {
    const { provider } = build();
    await expect(provider.getQuote('NOTREAL')).rejects.toBeInstanceOf(SymbolNotFoundError);
  });

  it('is reproducible across independent instances with the same seed', async () => {
    const epoch = Date.now() - SESSION_MS / 3;
    const clock = new SimulatedMarketClock(epoch, SESSION_MS, HISTORY);

    const a = new SyntheticProvider({ seed: SEED, clock, faults: createFaultState() });
    const b = new SyntheticProvider({ seed: SEED, clock, faults: createFaultState() });

    const [ha, hb] = await Promise.all([a.getHistory('AAPL', 60), b.getHistory('AAPL', 60)]);
    expect(ha.map((x) => x.close)).toEqual(hb.map((x) => x.close));
  });

  it('produces a different market for a different seed', async () => {
    const { provider: a } = build(1);
    const { provider: b } = build(2);
    const [ha, hb] = await Promise.all([a.getHistory('AAPL', 40), b.getHistory('AAPL', 40)]);
    expect(ha.map((x) => x.close)).not.toEqual(hb.map((x) => x.close));
  });

  it('returns only completed sessions from history', async () => {
    // Writing the in-progress session as a bar would bake a partial day into
    // every volatility estimate for the rest of that session.
    const { provider, clock } = build();
    const bars = await provider.getHistory('AAPL', HISTORY);
    const currentSessionStart = clock.sessionStartAt(clock.sessionIndexOf(Date.now()));

    expect(bars.length).toBeGreaterThan(200);
    for (const bar of bars) expect(bar.ts).toBeLessThan(currentSessionStart);
  });

  it('emits bars whose timestamps are already canonical', async () => {
    // The repository re-canonicalises on write; if the provider's timestamps
    // were in a different space that would silently remap every bar.
    const { provider, clock } = build();
    const bars = await provider.getHistory('MSFT', 30);
    for (const bar of bars) {
      expect(clock.sessionCloseOf(bar.ts)).toBe(bar.ts);
    }
  });

  it('produces internally consistent OHLC bars', async () => {
    const { provider } = build();
    for (const symbol of ['AAPL', 'GME', 'KO', 'NVDA']) {
      const bars = await provider.getHistory(symbol, 120);
      for (const b of bars) {
        expect(b.high).toBeGreaterThanOrEqual(b.low);
        expect(b.high).toBeGreaterThanOrEqual(b.close);
        expect(b.high).toBeGreaterThanOrEqual(b.open);
        expect(b.low).toBeLessThanOrEqual(b.close);
        expect(b.low).toBeLessThanOrEqual(b.open);
        expect(b.close).toBeGreaterThan(0);
        expect(b.volume).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('keeps the live quote consistent with the last bar', async () => {
    const { provider } = build();
    const bars = await provider.getHistory('AAPL', 20);
    const quote = await provider.getQuote('AAPL');
    const last = bars[bars.length - 1];

    // The live session begins where the previous one closed.
    expect(quote.prevClose).toBeCloseTo(last!.close, 6);
    expect(quote.dayHigh).toBeGreaterThanOrEqual(quote.price);
    expect(quote.dayLow).toBeLessThanOrEqual(quote.price);
  });

  it('gives each instrument roughly the volatility it was configured with', async () => {
    const { provider } = build();

    for (const symbol of ['KO', 'AAPL', 'NVDA', 'GME']) {
      const entry = findEntry(symbol)!;
      const bars = await provider.getHistory(symbol, 250);
      const realised = stdev(logReturns(bars.map((b) => b.close))) * Math.sqrt(252);

      // Generous bounds: 250 samples of a fat-tailed process with volatility
      // clustering will not land on the target exactly, and should not.
      expect(realised).toBeGreaterThan(entry.annualVol * 0.5);
      expect(realised).toBeLessThan(entry.annualVol * 2.2);
    }
  });

  it('preserves the ordering of volatilities across the universe', async () => {
    // Even if the absolute levels drift, a utility must stay quieter than a
    // meme stock - otherwise the whole significance argument evaporates.
    const { provider } = build();
    const vol = async (symbol: string): Promise<number> => {
      const bars = await provider.getHistory(symbol, 250);
      return stdev(logReturns(bars.map((b) => b.close)));
    };

    const [ko, aapl, gme] = await Promise.all([vol('KO'), vol('AAPL'), vol('GME')]);
    expect(ko).toBeLessThan(aapl);
    expect(aapl).toBeLessThan(gme);
  });

  it('recovers the configured beta when regressed on the benchmark', async () => {
    const { provider } = build();

    const benchBars = await provider.getHistory(BENCHMARK.symbol, 250);
    const benchRets = logReturns(benchBars.map((b) => b.close));

    for (const symbol of ['NVDA', 'KO', 'DUK', 'JPM']) {
      const entry = findEntry(symbol)!;
      const bars = await provider.getHistory(symbol, 250);
      const { beta } = regress(logReturns(bars.map((b) => b.close)), benchRets);

      // The recovered beta should be in the right region and, crucially, in
      // the right *order* relative to the configured value.
      expect(beta).toBeGreaterThan(entry.beta * 0.35);
      expect(beta).toBeLessThan(entry.beta * 2.4);
    }
  });

  it('makes high-beta names measurably more market-sensitive than low-beta ones', async () => {
    const { provider } = build();
    const benchRets = logReturns((await provider.getHistory(BENCHMARK.symbol, 250)).map((b) => b.close));

    const betaOf = async (symbol: string): Promise<number> => {
      const bars = await provider.getHistory(symbol, 250);
      return regress(logReturns(bars.map((b) => b.close)), benchRets).beta;
    };

    const [duk, nvda] = await Promise.all([betaOf('DUK'), betaOf('NVDA')]);
    expect(duk).toBeLessThan(nvda);
  });

  it('resolves metadata for every instrument in its universe', async () => {
    const { provider } = build();
    for (const entry of UNIVERSE) {
      const meta = await provider.resolve(entry.symbol);
      expect(meta.symbol).toBe(entry.symbol);
      expect(meta.name).toBe(entry.name);
      expect(meta.sector).toBe(entry.sector);
    }
  });
});

describe('fault injection', () => {
  it('fails every request at a failure rate of one', async () => {
    const { provider, faults } = build();
    faults.failureRate = 1;
    await expect(provider.getQuote('AAPL')).rejects.toThrow(/injected/);
  });

  it('reports a symbol as unknown on demand', async () => {
    const { provider, faults } = build();
    faults.unknown.add('AAPL');
    await expect(provider.getQuote('AAPL')).rejects.toBeInstanceOf(SymbolNotFoundError);
  });

  it('marks an instrument halted', async () => {
    const { provider, faults } = build();
    faults.halted.add('AAPL');
    expect((await provider.getQuote('AAPL')).halted).toBe(true);
  });

  it('backdates asOf when asked to look stale', async () => {
    const { provider, faults } = build();
    faults.stalenessMs = 60 * 60_000;
    const quote = await provider.getQuote('AAPL');
    expect(Date.now() - quote.asOf).toBeGreaterThan(59 * 60_000);
  });

  it('skews prices without disturbing the underlying path', async () => {
    const { provider, faults } = build();
    const before = await provider.getQuote('AAPL');
    faults.priceSkew = 1.05;
    const after = await provider.getQuote('AAPL');

    // prevClose comes from the completed session and must be untouched.
    expect(after.prevClose).toBeCloseTo(before.prevClose, 6);
    expect(after.price / before.price).toBeCloseTo(1.05, 2);
  });

  it('applies a shock multiplicatively and composes repeats', async () => {
    const { provider, faults } = build();
    const before = await provider.getQuote('NEE');

    faults.shocks.set('NEE', { logReturn: Math.log1p(0.05), from: Date.now() - 1 });
    const once = await provider.getQuote('NEE');
    expect(once.price / before.price).toBeCloseTo(1.05, 2);

    faults.shocks.set('NEE', { logReturn: Math.log1p(0.05) * 2, from: Date.now() - 1 });
    const twice = await provider.getQuote('NEE');
    expect(twice.price / before.price).toBeCloseTo(1.1025, 2);
  });
});
