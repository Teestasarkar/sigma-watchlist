/**
 * Deliberate fault injection.
 *
 * Resilience code that has never been exercised is decoration. This module
 * lets the running system be broken on purpose - from the UI - so the circuit
 * breaker, staleness ladder, conflict resolution and backoff can be *seen*
 * working rather than merely described in a README.
 *
 * It is also how the edge cases get tested: the integration tests drive the
 * same knobs.
 */

export interface FaultState {
  /** Probability in [0,1] that a quote request throws a transient error. */
  failureRate: number;
  /** Artificial latency added to every request, in ms. */
  latencyMs: number;
  /** Backdates `asOf` by this much, to exercise the staleness ladder. */
  stalenessMs: number;
  /**
   * Multiplies the price returned by this provider only. Setting it on one of
   * two providers makes them disagree, which is what produces a real
   * `data_conflict` rather than a simulated one.
   */
  priceSkew: number;
  /** Symbols reported as halted. */
  halted: Set<string>;
  /** Symbols the provider claims never to have heard of. */
  unknown: Set<string>;
  /**
   * One-off price shocks, as an additive log return applied from `from`
   * onwards. This is how the demo produces a genuine multi-sigma move on
   * demand without breaking the determinism of everything else.
   */
  shocks: Map<string, { logReturn: number; from: number }>;
}

export function createFaultState(): FaultState {
  return {
    failureRate: 0,
    latencyMs: 0,
    stalenessMs: 0,
    priceSkew: 1,
    halted: new Set(),
    unknown: new Set(),
    shocks: new Map(),
  };
}

export function resetFaults(f: FaultState): void {
  f.failureRate = 0;
  f.latencyMs = 0;
  f.stalenessMs = 0;
  f.priceSkew = 1;
  f.halted.clear();
  f.unknown.clear();
  f.shocks.clear();
}

/** Serialisable view, for the data-health panel. */
export function describeFaults(f: FaultState): Record<string, unknown> {
  return {
    failureRate: f.failureRate,
    latencyMs: f.latencyMs,
    stalenessMs: f.stalenessMs,
    priceSkew: f.priceSkew,
    halted: [...f.halted],
    unknown: [...f.unknown],
    shocks: [...f.shocks.entries()].map(([symbol, s]) => ({
      symbol,
      pct: Math.expm1(s.logReturn),
      from: s.from,
    })),
    active:
      f.failureRate > 0 ||
      f.latencyMs > 0 ||
      f.stalenessMs > 0 ||
      f.priceSkew !== 1 ||
      f.halted.size > 0 ||
      f.unknown.size > 0 ||
      f.shocks.size > 0,
  };
}
