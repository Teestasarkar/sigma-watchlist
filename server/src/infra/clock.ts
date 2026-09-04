/**
 * An injectable clock. Every module takes time from here rather than calling
 * Date.now() directly, which is what makes the signal engine testable: a test
 * can advance three days in a microsecond and assert on hysteresis behaviour.
 */

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** Deterministic clock for tests and for the synthetic market feed. */
export class ManualClock implements Clock {
  constructor(private t: number) {}
  now(): number {
    return this.t;
  }
  set(t: number): void {
    this.t = t;
  }
  advance(ms: number): number {
    this.t += ms;
    return this.t;
  }
}
