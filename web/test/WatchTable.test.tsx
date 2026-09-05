/**
 * The watchlist table.
 *
 * The test that matters here is the product's central claim rendered as UI:
 * a 20% fall in a volatile name must sort *below* a 4% move in a quiet one.
 * If this ordering ever regresses, the product is a normal watchlist again.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { WatchTable } from '../src/components/WatchTable.js';
import type { WatchRow } from '../src/lib/types.js';

function row(over: Partial<WatchRow> & { symbol: string }): WatchRow {
  return {
    name: `${over.symbol} Inc.`,
    sector: 'Technology',
    item: {
      symbol: over.symbol,
      addedAt: 0,
      pinned: false,
      muted: false,
      minSigma: null,
      note: null,
      sortKey: 0,
    },
    quote: {
      symbol: over.symbol,
      price: 100,
      prevClose: 100,
      dayOpen: 100,
      dayHigh: 101,
      dayLow: 99,
      volume: 1_000_000,
      asOf: Date.now(),
      receivedAt: Date.now(),
      source: 'test',
      confidence: 1,
      halted: false,
      conflict: null,
    },
    freshness: 'fresh',
    stats: { sigmaDaily: 0.02, atrPct: 0.02, beta: 1, bars: 260 },
    sinceSeen: { from: 100, fromAt: Date.now() - 3600_000, changePct: 0, sigma: 0 },
    today: { changePct: 0 },
    rvol: 1,
    openSignals: 0,
    topSignal: null,
    ...over,
  } as WatchRow;
}

const noop = (): void => undefined;

const defaults = {
  onOpenSymbol: noop,
  onTogglePin: noop,
  onToggleMute: noop,
  onRemove: noop,
  busySymbols: new Set<string>(),
};

/**
 * Tickers in row order.
 *
 * Read from the ticker *button* rather than the whole cell: the cell also
 * carries the company name, so its textContent is "AAPLApple Inc.".
 */
function symbolOrder(): string[] {
  const body = screen.getAllByRole('rowgroup')[1] as HTMLElement;
  return within(body)
    .getAllByRole('row')
    .map((r) => {
      const cell = within(r).getAllByRole('cell')[0] as HTMLElement;
      return within(cell).getByRole('button').textContent ?? '';
    });
}

describe('ranking', () => {
  const meme = row({
    symbol: 'GME',
    // A huge percentage move that is entirely ordinary for this name.
    sinceSeen: { from: 24, fromAt: Date.now() - 3600_000, changePct: -0.1985, sigma: -1.59 },
    today: { changePct: -0.1985 },
    stats: { sigmaDaily: 0.0716, atrPct: 0.08, beta: 0.9, bars: 260 },
  });

  const utility = row({
    symbol: 'NEE',
    // A small move that is genuinely unusual for this name.
    sinceSeen: { from: 80, fromAt: Date.now() - 3600_000, changePct: 0.0411, sigma: 2.9 },
    today: { changePct: 0.0411 },
    stats: { sigmaDaily: 0.0145, atrPct: 0.015, beta: 0.5, bars: 260 },
  });

  it('sorts by significance, not by percentage', () => {
    render(<WatchTable rows={[meme, utility]} {...defaults} />);
    // The whole thesis: 4% in a quiet name outranks 20% in a wild one.
    expect(symbolOrder()).toEqual(['NEE', 'GME']);
  });

  it('can be re-sorted by raw percentage, which inverts the order', async () => {
    const user = userEvent.setup();
    render(<WatchTable rows={[meme, utility]} {...defaults} />);
    expect(symbolOrder()).toEqual(['NEE', 'GME']);

    // Sorting by the headline number puts the meme stock back on top, which is
    // exactly the behaviour the default sort exists to avoid.
    await user.click(screen.getByText('Since you looked'));
    expect(symbolOrder()).toEqual(['GME', 'NEE']);
  });

  it('floats pinned symbols regardless of significance', () => {
    const pinned = {
      ...meme,
      item: { ...meme.item, pinned: true },
    };
    render(<WatchTable rows={[pinned, utility]} {...defaults} />);
    expect(symbolOrder()[0]).toBe('GME');
  });

  it('sorts rows with no significance last, not as if they were calm', () => {
    // "We cannot judge this" must not be rendered as "nothing happened".
    const unknown = row({
      symbol: 'NEW',
      stats: null,
      sinceSeen: { from: null, fromAt: null, changePct: null, sigma: null },
    });
    const quiet = row({
      symbol: 'CALM',
      sinceSeen: { from: 100, fromAt: Date.now(), changePct: 0.001, sigma: 0.05 },
    });

    render(<WatchTable rows={[unknown, quiet]} {...defaults} />);
    expect(symbolOrder()).toEqual(['CALM', 'NEW']);
  });
});

describe('honesty in the cells', () => {
  it('says so when there is not enough history to judge', () => {
    render(
      <WatchTable
        rows={[
          row({
            symbol: 'NEW',
            stats: null,
            sinceSeen: { from: null, fromAt: null, changePct: null, sigma: null },
          }),
        ]}
        {...defaults}
      />,
    );
    expect(screen.getAllByText(/insufficient history/i).length).toBeGreaterThan(0);
  });

  it('labels the reference point for the since-you-looked column', () => {
    render(<WatchTable rows={[row({ symbol: 'AAPL' })]} {...defaults} />);
    expect(screen.getByText(/from \$100\.00/)).toBeTruthy();
  });

  it('marks the since-column as a placeholder when there is no checkpoint', () => {
    // Without a checkpoint this column falls back to the previous close, which
    // makes it identical to "Today". Saying so stops it reading as a second,
    // independent measurement.
    render(
      <WatchTable
        rows={[
          row({
            symbol: 'AAPL',
            sinceSeen: { from: 100, fromAt: null, changePct: 0.01, sigma: 0.5 },
          }),
        ]}
        {...defaults}
      />,
    );
    expect(screen.getByText(/no checkpoint yet/i)).toBeTruthy();
  });

  it('renders an empty list as guidance rather than a blank table', () => {
    render(<WatchTable rows={[]} {...defaults} />);
    expect(screen.getByText(/nothing on this list yet/i)).toBeTruthy();
  });
});

describe('per-symbol controls', () => {
  it('pins and mutes through their callbacks', async () => {
    const onTogglePin = vi.fn();
    const onToggleMute = vi.fn();
    const user = userEvent.setup();

    render(
      <WatchTable
        rows={[row({ symbol: 'AAPL' })]}
        {...defaults}
        onTogglePin={onTogglePin}
        onToggleMute={onToggleMute}
      />,
    );

    await user.click(screen.getByTitle(/pin to the top/i));
    expect(onTogglePin).toHaveBeenCalledWith('AAPL', true);

    await user.click(screen.getByTitle(/mute/i));
    expect(onToggleMute).toHaveBeenCalledWith('AAPL', true);
  });

  it('disables controls for a row with a request in flight', () => {
    render(
      <WatchTable
        rows={[row({ symbol: 'AAPL' })]}
        {...defaults}
        busySymbols={new Set(['AAPL'])}
      />,
    );
    expect((screen.getByTitle(/pin to the top/i) as HTMLButtonElement).disabled).toBe(true);
  });

  it('dims a muted row rather than hiding it', () => {
    // Muted means "stop telling me", not "forget I own this".
    const muted = row({ symbol: 'AAPL' });
    muted.item.muted = true;
    render(<WatchTable rows={[muted]} {...defaults} />);
    expect(screen.getByText('AAPL')).toBeTruthy();
  });
});
