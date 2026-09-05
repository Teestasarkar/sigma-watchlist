/**
 * The data-health strip.
 *
 * This sits on the same screen as the prices on purpose: "we cannot currently
 * price three of your holdings" is something a user needs at the moment they
 * are reading a number, not on a status page they will never open.
 *
 * The property worth protecting is that **it always says something in words**.
 * A coloured dot is not an explanation, and the state it renders most often
 * during trading hours is the one where a wrong reading is most expensive.
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { HealthStrip } from '../src/components/HealthStrip.js';
import type { DataHealth, Freshness } from '../src/lib/types.js';

function health(over: Partial<DataHealth> = {}): DataHealth {
  return {
    worstFreshness: 'fresh',
    stale: [],
    conflicted: [],
    halted: [],
    thinHistory: [],
    providers: [
      { provider: 'yahoo', breaker: 'closed', ok: 40, fail: 0, p95Ms: 500, lastError: null, lastOkAt: 1 },
      { provider: 'cnbc', breaker: 'closed', ok: 10, fail: 0, p95Ms: 900, lastError: null, lastOkAt: 1 },
    ],
    ...over,
  };
}

describe('it always explains itself in words', () => {
  const cases: Array<[Freshness, RegExp]> = [
    ['fresh', /prices current/i],
    ['closed', /market closed/i],
    ['delayed', /few minutes behind/i],
    ['stale', /could not be refreshed/i],
    ['unknown', /no usable price/i],
  ];

  for (const [state, expected] of cases) {
    it(`says what "${state}" means`, () => {
      render(<HealthStrip health={health({ worstFreshness: state })} />);
      expect(screen.getByText(expected)).toBeTruthy();
    });
  }

  it('leaves no state showing a bare dot', () => {
    /*
     * The regression this exists for. `delayed` used to render the label
     * "Delayed" and nothing else - during market hours, next to a price
     * someone might be about to act on.
     */
    for (const [state] of cases) {
      const { container, unmount } = render(
        <HealthStrip health={health({ worstFreshness: state })} />,
      );
      const strip = container.querySelector('.health-strip');
      // Longer than any dot label on its own, so a bare dot cannot pass.
      expect((strip?.textContent ?? '').length).toBeGreaterThan(30);
      unmount();
    }
  });
});

describe('what counts as degraded', () => {
  it('does not treat a closed market as a fault', () => {
    // There is no trading to be behind on. Flagging it would cry wolf every
    // evening and every weekend, and train people to ignore the strip.
    const { container } = render(<HealthStrip health={health({ worstFreshness: 'closed' })} />);
    expect(container.querySelector('.health-strip.is-degraded')).toBeNull();
  });

  it('does treat a broken feed as one', () => {
    const { container } = render(
      <HealthStrip health={health({ worstFreshness: 'stale', stale: ['AAPL', 'MSFT'] })} />,
    );
    expect(container.querySelector('.health-strip.is-degraded')).toBeTruthy();
    expect(screen.getByText(/AAPL/)).toBeTruthy();
  });

  it('flags disagreeing vendors even when the price looks fresh', () => {
    // Two sources disagreeing is not a staleness problem, and it must not be
    // hidden by everything else being on time.
    const { container } = render(
      <HealthStrip health={health({ worstFreshness: 'fresh', conflicted: ['TSLA'] })} />,
    );
    expect(container.querySelector('.health-strip.is-degraded')).toBeTruthy();
    expect(screen.getByText(/disputed price/i)).toBeTruthy();
  });

  it('flags an open circuit breaker', () => {
    const { container } = render(
      <HealthStrip
        health={health({
          providers: [
            { provider: 'yahoo', breaker: 'open', ok: 3, fail: 9, p95Ms: null, lastError: 'timeout', lastOkAt: null },
          ],
        })}
      />,
    );
    expect(container.querySelector('.health-strip.is-degraded')).toBeTruthy();
    expect(screen.getByText(/circuit open/i)).toBeTruthy();
  });
});

describe('the provider counters', () => {
  it('are shown in every state, healthy or not', () => {
    // The counters are how someone checks whether "healthy" is actually true.
    for (const state of ['fresh', 'closed', 'stale'] as Freshness[]) {
      const { unmount } = render(<HealthStrip health={health({ worstFreshness: state })} />);
      expect(screen.getByText(/yahoo 40\/40 · cnbc 10\/10/)).toBeTruthy();
      unmount();
    }
  });

  it('names instruments whose statistics are withheld', () => {
    // Thin history means the sigma would be a guess, so none is shown - and
    // saying so is better than a number nobody should trust.
    render(<HealthStrip health={health({ thinHistory: ['IPO1', 'IPO2'] })} />);
    expect(screen.getByText(/statistics withheld/i)).toBeTruthy();
  });
});
