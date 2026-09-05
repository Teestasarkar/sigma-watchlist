/**
 * Formatting.
 *
 * Small functions, but they are the last thing between a number and a person,
 * and the failure mode is a product that lies quietly. The rule under test
 * throughout: **null is not zero.** "We don't know" and "nothing changed" must
 * never render the same way.
 */

import { describe, expect, it } from 'vitest';

import {
  ago,
  compactNumber,
  DASH,
  directionClass,
  duration,
  freshnessLabel,
  kindLabel,
  kindWhy,
  money,
  pct,
  signedPct,
  sigma,
  sigmaBand,
} from '../src/lib/format.js';

describe('null is never rendered as zero', () => {
  it('shows a dash for every absent value', () => {
    for (const absent of [null, undefined]) {
      expect(money(absent)).toBe(DASH);
      expect(pct(absent)).toBe(DASH);
      expect(signedPct(absent)).toBe(DASH);
      expect(sigma(absent)).toBe(DASH);
      expect(compactNumber(absent)).toBe(DASH);
      expect(ago(absent)).toBe(DASH);
      expect(duration(absent)).toBe(DASH);
    }
  });

  it('shows a dash rather than NaN', () => {
    // A NaN reaching the screen as "NaN%" is bad; reaching it as "0.00%" is
    // worse, because it looks like an answer.
    expect(money(Number.NaN)).toBe(DASH);
    expect(pct(Number.NaN)).toBe(DASH);
    expect(sigma(Number.POSITIVE_INFINITY)).toBe(DASH);
  });

  it('still renders a genuine zero', () => {
    expect(pct(0)).toBe('0.00%');
    expect(signedPct(0)).toBe('0.00%');
    expect(sigma(0)).toBe('0.0σ');
  });
});

describe('money', () => {
  it('uses cents for ordinary prices', () => {
    expect(money(320.98)).toBe('$320.98');
    expect(money(1234.5)).toBe('$1,234.50');
  });

  it('gives sub-dollar prices more precision', () => {
    // A penny stock rounded to cents loses most of its information.
    expect(money(0.0421)).toBe('$0.0421');
  });
});

describe('percentages', () => {
  it('signs a positive change but not a negative one twice', () => {
    expect(signedPct(0.0234)).toBe('+2.34%');
    expect(signedPct(-0.0234)).toBe('-2.34%');
  });

  it('honours the requested precision', () => {
    expect(pct(0.12345, 1)).toBe('12.3%');
    expect(pct(0.12345, 3)).toBe('12.345%');
  });
});

describe('sigma', () => {
  it('always carries its sign, because direction is the point', () => {
    expect(sigma(2.5)).toBe('+2.5σ');
    // A true minus sign, not a hyphen - it is a number, not a range.
    expect(sigma(-2.5)).toBe('−2.5σ');
  });

  it('rounds to one decimal, since more implies false precision', () => {
    expect(sigma(3.14159)).toBe('+3.1σ');
  });

  it('bands by magnitude, ignoring direction', () => {
    // A 4-sigma fall is exactly as notable as a 4-sigma rise.
    expect(sigmaBand(0.4)).toBe('none');
    expect(sigmaBand(1.2)).toBe('low');
    expect(sigmaBand(2.4)).toBe('mid');
    expect(sigmaBand(4.1)).toBe('high');
    expect(sigmaBand(-4.1)).toBe('high');
  });

  it('bands an unknown value as none, not as calm', () => {
    expect(sigmaBand(null)).toBe('none');
    expect(sigmaBand(Number.NaN)).toBe('none');
  });
});

describe('relative time', () => {
  const NOW = 1_700_000_000_000;

  it('is deliberately coarse', () => {
    // Precision that changes every second makes a page feel unstable, and
    // nobody is reasoning in seconds.
    expect(ago(NOW - 5_000, NOW)).toBe('moments ago');
    expect(ago(NOW - 300_000, NOW)).toBe('5 min ago');
    expect(ago(NOW - 3 * 3600_000, NOW)).toBe('3.0 hours ago');
    expect(ago(NOW - 26 * 3600_000, NOW)).toBe('yesterday');
    expect(ago(NOW - 5 * 24 * 3600_000, NOW)).toBe('5 days ago');
  });

  it('does not report a future timestamp as a negative age', () => {
    expect(ago(NOW + 60_000, NOW)).toBe('just now');
  });
});

describe('durations', () => {
  it('picks a unit that suits the magnitude', () => {
    expect(duration(450)).toBe('450ms');
    expect(duration(2_500)).toBe('2.5s');
    expect(duration(90_000)).toBe('2m');
    expect(duration(7_200_000)).toBe('2.0h');
  });
});

describe('direction classes', () => {
  it('treats zero and unknown as flat, not as a direction', () => {
    expect(directionClass(0.01)).toBe('up');
    expect(directionClass(-0.01)).toBe('down');
    expect(directionClass(0)).toBe('flat');
    expect(directionClass(null)).toBe('flat');
  });
});

describe('signal vocabulary', () => {
  it('never shows a raw enum to a user', () => {
    expect(kindLabel('idio_move')).toBe('Company-specific move');
    expect(kindLabel('stale_data')).toBe('Data gone stale');
    for (const kind of ['sigma_move', 'gap', 'range_break', 'volume_spike'] as const) {
      expect(kindLabel(kind)).not.toContain('_');
    }
  });

  it('explains why each kind matters, in a sentence', () => {
    // The ranking is only trustworthy if the reader understands it.
    for (const kind of ['idio_move', 'sigma_move', 'stale_data', 'data_conflict'] as const) {
      const why = kindWhy(kind);
      expect(why.length).toBeGreaterThan(20);
      expect(why.endsWith('.')).toBe(true);
    }
  });

  it('describes a closed market as a state, not a fault', () => {
    // "Stale" would be a lie at the weekend.
    expect(freshnessLabel('closed')).toBe('At the close');
    expect(freshnessLabel('stale')).toBe('Stale');
    expect(freshnessLabel('fresh')).toBe('Live');
  });
});
