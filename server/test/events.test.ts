/**
 * The change bus.
 *
 * The interesting behaviour is not "does a message arrive" - it is the three
 * things that keep the stream from being worse than the polling it replaces:
 * coalescing a scheduler batch into one event, admitting when a reconnecting
 * client's gap cannot be reconstructed, and never letting a broken subscriber
 * take the ingest path down with it.
 */

import { describe, expect, it, vi } from 'vitest';

import { MarketEventBus, type MarketEvent } from '../src/services/events.js';
import { ManualClock } from '../src/infra/clock.js';

/** A bus plus a collecting subscriber, which is what every test here wants. */
function harness(opts: { coalesceMs?: number; historySize?: number } = {}): {
  bus: MarketEventBus;
  clock: ManualClock;
  seen: MarketEvent[];
} {
  const clock = new ManualClock(1_700_000_000_000);
  const bus = new MarketEventBus(clock, { coalesceMs: 5, ...opts });
  const seen: MarketEvent[] = [];
  bus.subscribe((e) => seen.push(e));
  return { bus, clock, seen };
}

/** Wait past the coalescing window. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

describe('coalescing a batch', () => {
  it('turns a scheduler batch into one event', async () => {
    /*
     * The headline. The scheduler refreshes symbols in batches, so a naive bus
     * emits a dozen events in the same millisecond and every connected client
     * refetches a dozen times - strictly worse than the polling this replaces.
     */
    const { bus, seen } = harness();

    for (const symbol of ['AAPL', 'MSFT', 'NVDA', 'TSLA']) {
      bus.publish({ symbol, quote: true });
    }
    await settle();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.quotes.sort()).toEqual(['AAPL', 'MSFT', 'NVDA', 'TSLA']);
  });

  it('separates a price change from a new signal', async () => {
    // A caller may want to ignore price noise but never a fresh signal, so the
    // two must stay distinguishable through the merge.
    const { bus, seen } = harness();

    bus.publish({ symbol: 'AAPL', quote: true });
    bus.publish({ symbol: 'TSLA', quote: true, signals: 2 });
    await settle();

    expect(seen[0]?.quotes.sort()).toEqual(['AAPL', 'TSLA']);
    expect(seen[0]?.signals).toEqual(['TSLA']);
  });

  it('does not report a symbol twice within one batch', async () => {
    const { bus, seen } = harness();

    bus.publish({ symbol: 'AAPL', quote: true });
    bus.publish({ symbol: 'AAPL', quote: true });
    await settle();

    expect(seen[0]?.quotes).toEqual(['AAPL']);
  });

  it('stays silent when nothing actually changed', async () => {
    // A refresh that confirms the same price is not news. Publishing it anyway
    // would wake every client on every poll cycle.
    const { bus, seen } = harness();

    bus.publish({ symbol: 'AAPL' });
    bus.publish({ symbol: 'MSFT', signals: 0 });
    await settle();

    expect(seen).toHaveLength(0);
  });

  it('does no work when nobody is listening', async () => {
    // A server whose last tab closed should not be accumulating a buffer.
    const clock = new ManualClock(0);
    const bus = new MarketEventBus(clock, { coalesceMs: 5 });

    bus.publish({ symbol: 'AAPL', quote: true });
    await settle();

    // Nothing was buffered, so nothing is delivered to someone arriving after.
    const late: MarketEvent[] = [];
    bus.subscribe((e) => late.push(e));
    await settle();

    expect(late).toHaveLength(0);
    expect(bus.currentSeq).toBe(0);
  });

  it('numbers events monotonically across batches', async () => {
    const { bus, seen } = harness();

    bus.publish({ symbol: 'AAPL', quote: true });
    await settle();
    bus.publish({ symbol: 'MSFT', quote: true });
    await settle();

    expect(seen.map((e) => e.seq)).toEqual([1, 2]);
  });
});

describe('what a reconnecting client missed', () => {
  it('replays only the events after the one it has', async () => {
    const { bus } = harness();

    for (const symbol of ['A', 'B', 'C']) {
      bus.publish({ symbol, quote: true });
      await settle();
    }

    const missed = bus.since(1);
    expect(missed?.map((e) => e.seq)).toEqual([2, 3]);
  });

  it('returns nothing when the client is already current', async () => {
    const { bus } = harness();
    bus.publish({ symbol: 'A', quote: true });
    await settle();

    expect(bus.since(1)).toEqual([]);
    // Ahead of us — a stale sequence from a previous process, say. Not a gap.
    expect(bus.since(99)).toEqual([]);
  });

  it('admits when the gap is longer than it remembers', async () => {
    /*
     * The important one. A client away longer than the buffer cannot be caught
     * up, and quietly sending nothing would leave it displaying stale data
     * with full confidence — precisely the failure this product exists to
     * prevent. `null` means "resynchronise from scratch".
     */
    const { bus } = harness({ historySize: 3 });

    for (const symbol of ['A', 'B', 'C', 'D', 'E']) {
      bus.publish({ symbol, quote: true });
      await settle();
    }

    // Events 1 and 2 have been evicted, so a client holding 1 is recoverable
    // but one holding 0 is not.
    expect(bus.since(0)).toBeNull();
    expect(bus.since(2)?.map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  it('keeps the buffer bounded', async () => {
    const { bus } = harness({ historySize: 3 });

    for (let i = 0; i < 20; i++) {
      bus.publish({ symbol: `S${i}`, quote: true });
      await settle();
    }

    // Whatever is retained, it is the tail and it is small.
    expect(bus.since(19)?.map((e) => e.seq)).toEqual([20]);
    expect(bus.since(0)).toBeNull();
  });
});

describe('a subscriber cannot break ingest', () => {
  it('still notifies the others when one throws', async () => {
    /*
     * Publishing happens on the ingest hot path. A component that throws while
     * handling an event must not stop the rest being told, and must never
     * propagate back into the refresh that published it.
     */
    const clock = new ManualClock(0);
    const bus = new MarketEventBus(clock, { coalesceMs: 5 });

    const good = vi.fn();
    bus.subscribe(() => {
      throw new Error('subscriber exploded');
    });
    bus.subscribe(good);

    expect(() => bus.publish({ symbol: 'AAPL', quote: true })).not.toThrow();
    await settle();

    expect(good).toHaveBeenCalledTimes(1);
  });

  it('stops delivering after unsubscribe', async () => {
    const clock = new ManualClock(0);
    const bus = new MarketEventBus(clock, { coalesceMs: 5 });
    const seen: MarketEvent[] = [];
    const off = bus.subscribe((e) => seen.push(e));

    bus.publish({ symbol: 'AAPL', quote: true });
    await settle();
    off();
    bus.publish({ symbol: 'MSFT', quote: true });
    await settle();

    expect(seen).toHaveLength(1);
  });

  it('drops a pending batch on stop, rather than firing into a closed server', async () => {
    const { bus, seen } = harness();

    bus.publish({ symbol: 'AAPL', quote: true });
    bus.stop();
    await settle();

    expect(seen).toHaveLength(0);
  });
});
