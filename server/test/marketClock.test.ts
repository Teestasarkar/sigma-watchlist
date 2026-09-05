/**
 * The market clock.
 *
 * Small surface, disproportionate consequences: it supplies the denominator
 * for every significance figure in the product, and the primary key for every
 * bar. Both of the bugs recorded in docs/DECISIONS.md #7 were failures here.
 */

import { describe, expect, it } from 'vitest';

import { exchangeClock, SimulatedMarketClock } from '../src/domain/marketClock.js';
import { isTradingDay, marketPhase, sessionCloseTs } from '../src/domain/calendar.js';
import { config as baseConfig } from '../src/config.js';
import { classifyFreshness } from '../src/providers/reconcile.js';

const DAY = 86_400_000;

/** 2026-09-04 is a Friday. Times below are ET. */
const FRI_MIDDAY_ET = Date.UTC(2026, 8, 4, 16, 0); // 12:00 ET (UTC-4)
const FRI_CLOSE_ET = Date.UTC(2026, 8, 4, 20, 0); // 16:00 ET
const SAT = Date.UTC(2026, 8, 5, 16, 0);
const SUN = Date.UTC(2026, 8, 6, 16, 0);
const MON_OPEN_ET = Date.UTC(2026, 8, 7, 14, 0); // 10:00 ET

describe('the exchange calendar', () => {
  it('knows weekends are not trading days', () => {
    expect(isTradingDay(FRI_MIDDAY_ET)).toBe(true);
    expect(isTradingDay(SAT)).toBe(false);
    expect(isTradingDay(SUN)).toBe(false);
  });

  it('knows fixed holidays', () => {
    expect(isTradingDay(Date.UTC(2026, 6, 4, 16, 0))).toBe(false); // 4 July
    expect(isTradingDay(Date.UTC(2026, 11, 25, 16, 0))).toBe(false); // Christmas
  });

  it('reports the session phase', () => {
    expect(marketPhase(FRI_MIDDAY_ET)).toBe('open');
    expect(marketPhase(Date.UTC(2026, 8, 4, 12, 0))).toBe('pre'); // 08:00 ET
    expect(marketPhase(Date.UTC(2026, 8, 4, 21, 0))).toBe('post'); // 17:00 ET
    expect(marketPhase(SAT)).toBe('closed');
  });
});

describe('canonical session timestamps', () => {
  /**
   * The property that matters most.
   *
   * Bars are keyed by this value and every write re-canonicalises, so if it
   * were not idempotent each write would silently remap the bar to a different
   * session. That is precisely the bug that hung startup.
   */
  it('is idempotent for the exchange clock', () => {
    for (const ts of [FRI_MIDDAY_ET, FRI_CLOSE_ET, MON_OPEN_ET, SAT]) {
      const once = exchangeClock.sessionCloseOf(ts);
      expect(exchangeClock.sessionCloseOf(once)).toBe(once);
      // And a third time, for good measure.
      expect(exchangeClock.sessionCloseOf(exchangeClock.sessionCloseOf(once))).toBe(once);
    }
  });

  it('is idempotent for the simulated clock', () => {
    const clock = new SimulatedMarketClock(1_700_000_000_000, 45_000, 260);
    for (const offset of [0, 1, 22_500, 44_999, 45_000, 10 * 45_000 + 7]) {
      const ts = clock.epoch + offset;
      const once = clock.sessionCloseOf(ts);
      expect(clock.sessionCloseOf(once)).toBe(once);
    }
  });

  it('maps every instant within one session to the same key', () => {
    const clock = new SimulatedMarketClock(1_000_000, 45_000, 10);
    const a = clock.sessionKeyOf(1_000_000);
    const b = clock.sessionKeyOf(1_000_000 + 44_999);
    const c = clock.sessionKeyOf(1_000_000 + 45_000);
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });

  it('produces keys that sort in chronological order', () => {
    // Zero-padded, so lexical and numeric ordering agree.
    const clock = new SimulatedMarketClock(1_000_000, 1_000, 5);
    const keys = [0, 1, 2, 10, 100].map((i) => clock.sessionKeyOf(clock.sessionStartAt(i)));
    expect([...keys].sort()).toEqual(keys);
  });

  it('resolves the exchange session to 16:00 ET regardless of the time of day', () => {
    expect(sessionCloseTs(FRI_MIDDAY_ET)).toBe(FRI_CLOSE_ET);
    expect(sessionCloseTs(FRI_CLOSE_ET)).toBe(FRI_CLOSE_ET);
  });
});

describe('sessions between two instants', () => {
  it('treats a weekend as roughly one session of risk, not three days', () => {
    // This is the difference between every Monday looking calm and not.
    const friToMon = exchangeClock.sessionsBetween(FRI_MIDDAY_ET, MON_OPEN_ET);
    expect(friToMon).toBeGreaterThan(0.3);
    expect(friToMon).toBeLessThan(1.5);
  });

  it('counts nothing across a closed market', () => {
    expect(exchangeClock.sessionsBetween(SAT, SUN)).toBe(0);
  });

  it('is zero for a reversed or empty interval', () => {
    expect(exchangeClock.sessionsBetween(MON_OPEN_ET, FRI_MIDDAY_ET)).toBe(0);
    expect(exchangeClock.sessionsBetween(FRI_MIDDAY_ET, FRI_MIDDAY_ET)).toBe(0);
  });

  it('scales linearly on the simulated grid', () => {
    const clock = new SimulatedMarketClock(0, 1_000, 0);
    expect(clock.sessionsBetween(0, 3_000)).toBe(3);
    expect(clock.sessionsBetween(0, 500)).toBe(0.5);
  });
});

describe('sessionsAgo', () => {
  /**
   * Lookback windows are expressed in sessions because that is the only unit
   * that means the same thing to both clocks. Stated in wall-clock time, a
   * sensible three-day window becomes a third of a trading year against the
   * simulator - and every move then divides by sqrt(120) and reads as noise.
   */
  it('skips non-trading days on the exchange clock', () => {
    // One session before Monday morning is the preceding Friday.
    const back = exchangeClock.sessionsAgo(MON_OPEN_ET, 1);
    expect(isTradingDay(back)).toBe(true);
    expect(new Date(back).getUTCDay()).toBe(5); // Friday
  });

  it('walks back the requested number of sessions, not calendar days', () => {
    const back = exchangeClock.sessionsAgo(MON_OPEN_ET, 5);
    const calendarDays = Math.round((MON_OPEN_ET - back) / DAY);
    // Five trading days spans a weekend, so it must be more than five days.
    expect(calendarDays).toBeGreaterThan(5);
    expect(isTradingDay(back)).toBe(true);
  });

  it('is exact on the simulated grid', () => {
    const clock = new SimulatedMarketClock(1_000_000, 45_000, 260);
    expect(clock.sessionsAgo(1_000_000, 3)).toBe(1_000_000 - 3 * 45_000);
    // Fractional sessions are meaningful on a continuous grid.
    expect(clock.sessionsAgo(1_000_000, 0.5)).toBe(1_000_000 - 22_500);
  });

  it('returns the instant itself for zero or negative input', () => {
    const clock = new SimulatedMarketClock(1_000_000, 45_000, 260);
    expect(clock.sessionsAgo(1_000_000, 0)).toBe(1_000_000);
    expect(clock.sessionsAgo(1_000_000, -5)).toBe(1_000_000);
    expect(exchangeClock.sessionsAgo(MON_OPEN_ET, 0)).toBe(MON_OPEN_ET);
  });

  it('terminates on an absurd request rather than spinning', () => {
    // Guarded, so a bad config value cannot hang the read path.
    const back = exchangeClock.sessionsAgo(MON_OPEN_ET, 100_000);
    expect(Number.isFinite(back)).toBe(true);
    expect(back).toBeLessThan(MON_OPEN_ET);
  });
});

describe('the last completed session', () => {
  it('is the previous trading day during market hours', () => {
    // Today's close has not happened yet, so mid-session it must look back.
    const last = exchangeClock.lastCompletedSessionAt(FRI_MIDDAY_ET);
    expect(last).toBeLessThan(FRI_MIDDAY_ET);
    expect(isTradingDay(last)).toBe(true);
  });

  it('is today once the closing bell has passed', () => {
    const afterClose = Date.UTC(2026, 8, 4, 21, 30); // 17:30 ET
    expect(exchangeClock.lastCompletedSessionAt(afterClose)).toBe(FRI_CLOSE_ET);
  });

  it('is the preceding session index on the simulated grid', () => {
    const clock = new SimulatedMarketClock(1_000_000, 45_000, 260);
    const now = clock.sessionStartAt(300) + 10_000;
    expect(clock.lastCompletedSessionAt(now)).toBe(clock.sessionStartAt(299));
  });
});

describe('session progress', () => {
  it('runs 0 to 1 across the simulated session', () => {
    const clock = new SimulatedMarketClock(0, 1_000, 0);
    expect(clock.sessionProgress(0)).toBeCloseTo(0, 6);
    expect(clock.sessionProgress(500)).toBeCloseTo(0.5, 6);
    expect(clock.sessionProgress(999)).toBeCloseTo(0.999, 3);
  });

  it('is 0 before the exchange opens and 1 after it closes', () => {
    // Volume must be compared against a full day after the close, not
    // extrapolated from a partial one.
    expect(exchangeClock.sessionProgress(Date.UTC(2026, 8, 4, 12, 0))).toBe(0);
    expect(exchangeClock.sessionProgress(Date.UTC(2026, 8, 4, 21, 0))).toBe(1);
    expect(exchangeClock.sessionProgress(SAT)).toBe(1);
  });

  it('is about half way through the middle of the exchange session', () => {
    // 12:45 ET is the midpoint of 09:30-16:00.
    const midpoint = Date.UTC(2026, 8, 4, 16, 45);
    expect(exchangeClock.sessionProgress(midpoint)).toBeCloseTo(0.5, 2);
  });
});

describe('simulated clock construction', () => {
  it('rejects a nonsensical session length', () => {
    expect(() => new SimulatedMarketClock(0, 0, 10)).toThrow();
    expect(() => new SimulatedMarketClock(0, -1, 10)).toThrow();
  });

  it('inverts its own index mapping exactly', () => {
    const clock = new SimulatedMarketClock(1_700_000_000_000, 45_000, 260);
    for (const i of [0, 1, 259, 260, 1_000]) {
      expect(clock.sessionIndexOf(clock.sessionStartAt(i))).toBe(i);
    }
  });
});

/**
 * Freshness thresholds must be reachable.
 *
 * A "fresh" window narrower than the poll interval is not a strict standard,
 * it is an unreachable one: every perfectly healthy price is labelled Delayed
 * for the back half of each cycle, the health strip flickers between Live and
 * Delayed, and the product ends up crying wolf about itself - which is the
 * exact failure it exists to prevent. This pins the relationship so raising
 * one without the other fails here rather than in front of a user.
 */
describe('the freshness ladder is reachable at the configured poll rate', () => {
  it('calls a price fresh when it is one poll old', () => {
    const { freshness, ingest } = baseConfig;

    // The hot and warm tiers are what a watched symbol actually gets.
    expect(freshness.freshMs).toBeGreaterThan(ingest.warmIntervalMs);
    expect(freshness.freshMs).toBeGreaterThan(ingest.hotIntervalMs);

    // A quote taken one warm cycle ago, plus a little jitter, is as current as
    // this system can be - so it must classify as fresh, not delayed.
    const now = Date.now();
    const oneCycleOld = now - (ingest.warmIntervalMs + 5_000);
    expect(classifyFreshness(oneCycleOld, now, freshness)).toBe('fresh');
  });

  it('still keeps the ladder ordered', () => {
    const { freshness } = baseConfig;
    expect(freshness.freshMs).toBeLessThan(freshness.delayedMs);
    expect(freshness.delayedMs).toBeLessThan(freshness.staleMs);
  });

  it('does eventually say delayed', () => {
    // The threshold must be generous, not absent.
    const { freshness } = baseConfig;
    const now = Date.now();
    expect(classifyFreshness(now - (freshness.freshMs + 1_000), now, freshness)).toBe('delayed');
  });
});
