/**
 * "When is a trading session?" as an injectable interface.
 *
 * This exists because the real exchange and the simulator genuinely disagree
 * about it, and hard-coding either answer breaks something:
 *
 *  - A real exchange has sessions 09:30-16:00 ET on weekdays. Volatility must
 *    be scaled by *market* time, not wall-clock time, or a Friday-to-Monday
 *    move looks like three days of risk when it is one session's worth.
 *
 *  - The simulator has to produce visible price action at 3am on a Sunday,
 *    because that is when someone will run this. It compresses a session into
 *    a configurable slice of real time and is always open.
 *
 * Everything downstream - bar keying, staleness, sigma denominators - asks the
 * clock rather than assuming, so the same detectors work against both.
 */

import {
  etParts,
  isMarketOpen,
  isTradingDay,
  marketPhase,
  sessionCloseTs,
  sessionFractionElapsed,
  sessionKey,
  tradingDaysBetween,
  type MarketPhase,
} from './calendar.js';

export type { MarketPhase };

export interface MarketClock {
  /** Canonical timestamp identifying the session containing `ts`. */
  sessionCloseOf(ts: number): number;
  /** Stable human-readable key for that session. */
  sessionKeyOf(ts: number): string;
  isOpen(ts: number): boolean;
  phaseAt(ts: number): MarketPhase;
  /**
   * Sessions of market risk between two instants - the correct denominator
   * for "how unusual is this move".
   */
  sessionsBetween(from: number, to: number): number;
  /** Length of one session in real milliseconds, for scheduling decisions. */
  sessionLengthMs(): number;
  /**
   * Progress through the current session, 0..1.
   *
   * Needed to make volume comparable: two million shares by 10am is a very
   * different fact from two million shares by 4pm, so relative volume has to
   * be paced by how much of the session has actually elapsed.
   */
  sessionProgress(ts: number): number;
  /**
   * Canonical timestamp of the most recent session that has actually finished.
   *
   * Used to decide whether history needs backfilling. Deriving it by
   * subtracting a session length from `now` is subtly wrong during trading
   * hours - it lands earlier the same day and canonicalises to *today's*
   * close, a session that has not happened yet - so each clock computes it
   * explicitly.
   */
  lastCompletedSessionAt(ts: number): number;
  readonly name: string;
}

/** The real US equity market. */
export const exchangeClock: MarketClock = {
  name: 'us-equities',
  sessionCloseOf: sessionCloseTs,
  sessionKeyOf: sessionKey,
  isOpen: isMarketOpen,
  phaseAt: marketPhase,
  sessionsBetween: tradingDaysBetween,
  sessionLengthMs: () => 6.5 * 3600_000,
  sessionProgress: (ts) => {
    const phase = marketPhase(ts);
    if (phase === 'pre') return 0;
    // After the close, the session is complete - volume should be compared
    // against a full day, not extrapolated.
    if (phase === 'post' || phase === 'closed') return 1;
    return sessionFractionElapsed(ts);
  },
  lastCompletedSessionAt: (ts) => {
    const phase = marketPhase(ts);
    // Today's session is complete only once we are past the closing bell.
    if (phase === 'post' || (phase === 'closed' && isTradingDay(ts) && etParts(ts).minutes >= 16 * 60)) {
      return sessionCloseTs(ts);
    }
    // Otherwise walk back to the previous trading day.
    let t = ts - 86_400_000;
    for (let i = 0; i < 10 && !isTradingDay(t); i++) t -= 86_400_000;
    return sessionCloseTs(t);
  },
};

/**
 * A compressed, always-open market for the simulated feed.
 *
 * Sessions are `sessionMs` of real time long, counted from `epoch`. Session
 * indices live in exactly one coordinate space - wall-clock time - and the
 * canonical timestamp for a session is the wall-clock instant it began.
 *
 * That last detail is load-bearing. `sessionCloseOf` must be **idempotent**:
 * feeding it a timestamp it already produced has to return that timestamp
 * unchanged, because bars are keyed by it and every write re-canonicalises.
 * An earlier version of this class mapped session indices onto real calendar
 * dates so charts would show plausible-looking dates - which meant a bar's
 * timestamp and a wall-clock instant were in different spaces, and
 * canonicalising a year-old bar walked hundreds of thousands of days looking
 * for a weekday. Nice-looking date axes are not worth a second coordinate
 * system; the UI labels simulated sessions by index instead.
 */
export class SimulatedMarketClock implements MarketClock {
  readonly name = 'simulated';

  constructor(
    /** Wall-clock instant at which simulated session `historySessions` begins. */
    readonly epoch: number,
    /** Real milliseconds per simulated session. */
    readonly sessionMs: number,
    /** How many sessions of history precede `epoch`. */
    readonly historySessions: number,
  ) {
    if (!Number.isFinite(epoch)) throw new Error('epoch must be finite');
    if (!(sessionMs > 0)) throw new Error('sessionMs must be positive');
    if (!(historySessions >= 0)) throw new Error('historySessions must be non-negative');
  }

  /** Session index for a wall-clock instant. Session 0 is the oldest history. */
  sessionIndexOf(ts: number): number {
    return this.historySessions + Math.floor((ts - this.epoch) / this.sessionMs);
  }

  /** Wall-clock instant at which a session index began. Inverse of the above. */
  sessionStartAt(index: number): number {
    return this.epoch + (index - this.historySessions) * this.sessionMs;
  }

  /** Progress through the session containing `ts`, 0..1. */
  phaseOf(ts: number): number {
    const start = this.sessionStartAt(this.sessionIndexOf(ts));
    return Math.min(1, Math.max(0, (ts - start) / this.sessionMs));
  }

  /**
   * The canonical instant identifying a session - its start.
   *
   * Idempotent by construction, since `sessionIndexOf(sessionStartAt(i)) === i`.
   */
  sessionCloseOf(ts: number): number {
    return this.sessionStartAt(this.sessionIndexOf(ts));
  }

  /** Zero-padded so lexical and numeric ordering agree. */
  sessionKeyOf(ts: number): string {
    const index = this.sessionIndexOf(ts);
    const sign = index < 0 ? '-' : '';
    return `S${sign}${String(Math.abs(index)).padStart(7, '0')}`;
  }

  /** The last session that has finished, as a canonical timestamp. */
  lastCompletedSessionAt(ts: number): number {
    return this.sessionStartAt(this.sessionIndexOf(ts) - 1);
  }

  /** The simulator never closes; that is the point of it. */
  isOpen(): boolean {
    return true;
  }

  phaseAt(): MarketPhase {
    return 'open';
  }

  sessionsBetween(from: number, to: number): number {
    if (to <= from) return 0;
    return (to - from) / this.sessionMs;
  }

  sessionLengthMs(): number {
    return this.sessionMs;
  }

  sessionProgress(ts: number): number {
    return this.phaseOf(ts);
  }
}
