/**
 * A deterministic simulated market.
 *
 * Why the app ships with this as its default feed
 * -----------------------------------------------
 * Every free market data API is rate-limited to the point of uselessness for a
 * 30-symbol watchlist polled continuously, and half of them are unofficial
 * endpoints that break without notice. Building the product on one would mean
 * the reviewer's first experience is an empty screen and a 429.
 *
 * More importantly, a simulator makes the *interesting* behaviour reproducible.
 * "Show me what a 4-sigma move looks like" is a config change, not a wait for
 * the right Tuesday. The real providers implement the same interface and are
 * preferred when configured; nothing downstream knows the difference.
 *
 * The generative model
 * --------------------
 * Returns have a three-factor structure, which is what makes the signal engine
 * meaningful rather than decorative:
 *
 *     r = drift + beta*market + sectorBeta*sector + idiosyncratic + jump
 *
 * Because the market factor is real, regressing a symbol on the benchmark
 * recovers its true beta, and the residual genuinely is the company-specific
 * part. "NVDA is up 3% but so is everything" is therefore a claim the engine
 * can actually verify rather than assert.
 *
 * Volatility clusters (a GARCH-flavoured multiplier), jumps arrive at
 * per-symbol rates, and intraday paths are Brownian bridges that terminate
 * exactly on the session's close - so the same function serves history and
 * live quotes without them ever disagreeing.
 *
 * Everything is a pure function of (seed, symbol, session index). No
 * accumulated state, so it survives restarts, answers out of order, and is
 * reproducible in tests.
 */

import type { Bar, RawQuote } from '../domain/types.js';
import type { SimulatedMarketClock } from '../domain/marketClock.js';
import type { Clock } from '../infra/clock.js';
import { systemClock } from '../infra/clock.js';
import { TRADING_DAYS_PER_YEAR } from '../domain/stats.js';
import { normalAt, uniformAt } from './random.js';
import { findEntry, type UniverseEntry } from './universe.js';
import {
  SymbolNotFoundError,
  TransientProviderError,
  type MarketDataProvider,
  type ProviderCapabilities,
} from './types.js';
import type { FaultState } from './faults.js';

/** Independent random streams, so unrelated draws cannot correlate. */
const STREAM = {
  market: 1,
  sector: 2,
  idio: 3,
  jumpDraw: 4,
  jumpSize: 5,
  volShock: 6,
  gapShare: 7,
  wiggle: 8,
  volume: 9,
  failure: 20,
} as const;

const ANNUAL_TO_DAILY = 1 / Math.sqrt(TRADING_DAYS_PER_YEAR);

/** Volatility of the common market factor, in daily terms. */
const MARKET_DAILY_VOL = 0.0085;
/** Volatility of each sector factor, in daily terms. */
const SECTOR_DAILY_VOL = 0.0075;

interface Path {
  /** Log return for each session index, 0-based. */
  returns: number[];
  /** Close price after each session. */
  closes: number[];
  /** Volatility multiplier in force during each session. */
  volMult: number[];
}

export interface SyntheticOptions {
  name?: string;
  seed: number;
  clock: SimulatedMarketClock;
  /**
   * Wall clock. Injected rather than read from `Date.now()` so a test can
   * advance three sessions instantly. Without it the provider keeps answering
   * from real time while everything around it has moved on - untestable, and
   * a latent bug anywhere the app runs on a shifted clock.
   */
  now?: Clock;
  faults: FaultState;
  /**
   * Systematic price offset for this provider instance.
   *
   * Running two instances with different biases is how the demo produces a
   * genuine two-source disagreement for reconciliation to resolve, rather than
   * a hard-coded "pretend there is a conflict" branch.
   */
  bias?: number;
  /** Reported as the quote's provider. Surfaced in the UI. */
  sourceLabel?: string;
}

export class SyntheticProvider implements MarketDataProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities = {
    history: true,
    // No real budget, but keep the same shape so the registry treats it
    // identically to a rate-limited vendor.
    requestsPerMinute: 6000,
    delayed: false,
  };

  private readonly seed: number;
  private readonly clock: SimulatedMarketClock;
  private readonly wall: Clock;
  private readonly faults: FaultState;
  private readonly bias: number;
  private readonly sourceLabel: string;

  /**
   * Memoised price paths.
   *
   * Determinism means these could be recomputed every time, but a path is a
   * fold over every prior session (volatility clustering is recursive), so
   * recomputing 260 sessions on every quote would be genuinely wasteful.
   */
  private readonly paths = new Map<string, Path>();

  constructor(opts: SyntheticOptions) {
    this.name = opts.name ?? 'synthetic';
    this.seed = opts.seed;
    this.clock = opts.clock;
    this.wall = opts.now ?? systemClock;
    this.faults = opts.faults;
    this.bias = opts.bias ?? 1;
    this.sourceLabel = opts.sourceLabel ?? this.name;
  }

  // ───────────────────────────────────────────────────── path generation

  private entry(symbol: string): UniverseEntry {
    const e = findEntry(symbol);
    if (!e) throw new SymbolNotFoundError(symbol);
    return e;
  }

  /**
   * Extend (or build) the price path for a symbol out to `upto` inclusive.
   *
   * The loop is a fold rather than a map because the volatility multiplier is
   * autoregressive: today's volatility depends on yesterday's shock. That is
   * what produces volatility *clustering* - calm stretches and turbulent ones
   * - instead of uniform noise, and it is what makes the `vol_regime` detector
   * detect something real.
   */
  private path(symbol: string, upto: number): Path {
    const e = this.entry(symbol);
    let p = this.paths.get(symbol);

    if (!p) {
      p = { returns: [], closes: [], volMult: [] };
      this.paths.set(symbol, p);
    }
    if (p.returns.length > upto) return p;

    const targetDaily = e.annualVol * ANNUAL_TO_DAILY;
    const driftDaily = e.drift / TRADING_DAYS_PER_YEAR;

    // Split the target variance into its factor components, then give the
    // idiosyncratic term whatever is left over. This is what makes the
    // realised beta match the configured beta.
    const systematicVar =
      (e.beta * MARKET_DAILY_VOL) ** 2 + (e.sectorBeta * SECTOR_DAILY_VOL) ** 2;
    const idioVol = Math.sqrt(
      // Floor at 15% of target so a high-beta name still has *some* private
      // news flow; without it, NVDA would move only when the market moves.
      Math.max(targetDaily ** 2 - systematicVar, (0.15 * targetDaily) ** 2),
    );

    for (let i = p.returns.length; i <= upto; i++) {
      const prevMult = i > 0 ? (p.volMult[i - 1] as number) : 1;
      const prevShock = i > 0 ? Math.abs((p.returns[i - 1] as number) / targetDaily) : 1;

      // Mean-reverting volatility with a shock-driven kick, clamped so the
      // simulation cannot run away.
      const mult = Math.min(
        3.2,
        Math.max(
          0.45,
          0.88 * prevMult +
            0.12 * (0.55 + 0.75 * prevShock) +
            0.05 * normalAt(this.seed, `${symbol}|vol`, i, STREAM.volShock),
        ),
      );

      const market = normalAt(this.seed, 'FACTOR|MKT', i, STREAM.market) * MARKET_DAILY_VOL;
      const sector =
        e.sectorBeta === 0
          ? 0
          : normalAt(this.seed, `FACTOR|${e.sector}`, i, STREAM.sector) * SECTOR_DAILY_VOL;
      const idio = normalAt(this.seed, symbol, i, STREAM.idio) * idioVol * mult;

      // Jumps: rare, fat, and asymmetric-capable. These are what produce the
      // gap and idiosyncratic-move signals worth reading.
      let jump = 0;
      if (uniformAt(this.seed, `${symbol}|jd`, i, STREAM.jumpDraw) < e.jumpProb) {
        const z = normalAt(this.seed, `${symbol}|js`, i, STREAM.jumpSize);
        jump = Math.sign(z) * Math.min(0.35, Math.abs(z) * e.jumpScale);
      }

      const r = driftDaily + e.beta * market + e.sectorBeta * sector + idio + jump;
      const prevClose = i > 0 ? (p.closes[i - 1] as number) : e.basePrice;

      p.volMult.push(mult);
      p.returns.push(r);
      // Floor the price: a simulated instrument must never reach zero and
      // start producing -Infinity log returns downstream.
      p.closes.push(Math.max(0.5, prevClose * Math.exp(r)));
    }

    return p;
  }

  /**
   * Close of a completed session.
   *
   * Deliberately *not* shocked. An injected shock is an event happening now;
   * applying it to historical closes would rewrite the past, which both
   * corrupts every volatility estimate derived from those bars and - worse -
   * moves the previous close by the same amount as the current price, so the
   * session return stays flat and no signal fires at all.
   */
  private closeAt(symbol: string, index: number): number {
    if (index < 0) return this.entry(symbol).basePrice;
    const p = this.path(symbol, index);
    return p.closes[index] as number;
  }

  /**
   * Multiplier from any injected shock that has already taken effect.
   *
   * Applied multiplicatively on top of the deterministic path so the injected
   * event moves the price without corrupting the seeded process underneath.
   */
  private shockFactor(symbol: string, at: number): number {
    const s = this.faults.shocks.get(symbol);
    if (!s || at < s.from) return 1;
    return Math.exp(s.logReturn);
  }

  /**
   * How the session's total return is split between the opening gap and the
   * intraday drift. Overnight news arrives as a gap you could not have traded.
   */
  private gapShare(symbol: string, index: number): number {
    return 0.15 + 0.5 * uniformAt(this.seed, `${symbol}|gap`, index, STREAM.gapShare);
  }

  /**
   * Intraday wiggle: a sum of sine harmonics, therefore exactly zero at both
   * f=0 and f=1.
   *
   * That boundary condition is the important part. It means the intraday path
   * starts at the open and *terminates precisely on the session close* from
   * the daily path - so the live quote and the historical bar for the same
   * session can never contradict each other.
   */
  private wiggle(symbol: string, index: number, f: number, scale: number): number {
    let w = 0;
    for (let k = 1; k <= 3; k++) {
      const a = normalAt(this.seed, `${symbol}|w${k}`, index, STREAM.wiggle + k);
      w += (a / k) * Math.sin(k * Math.PI * f);
    }
    return w * scale * 0.45;
  }

  /** Price at an arbitrary instant, mid-session included. */
  private priceAt(symbol: string, ts: number): { price: number; open: number; prevClose: number } {
    const index = this.clock.sessionIndexOf(ts);
    const f = this.clock.phaseOf(ts);

    const p = this.path(symbol, Math.max(index, 0));
    const prevClose = this.closeAt(symbol, index - 1);
    const dayReturn = (p.returns[Math.max(index, 0)] as number) ?? 0;

    const gap = dayReturn * this.gapShare(symbol, index);
    const open = prevClose * Math.exp(gap);

    const scale = Math.abs(dayReturn) + 0.004;
    const logPrice =
      Math.log(open) + (dayReturn - gap) * f + this.wiggle(symbol, index, f, scale);

    // The shock applies to the live price only. The session's open already
    // happened, and the previous close is history.
    return {
      price: Math.max(0.5, Math.exp(logPrice)) * this.shockFactor(symbol, ts),
      open,
      prevClose,
    };
  }

  /**
   * Running session high/low.
   *
   * Sampled rather than derived analytically: the extremes of a Brownian
   * bridge plus harmonics have no closed form, and 24 samples is plenty for a
   * value whose only consumer is an ATR estimate.
   */
  private sessionRange(symbol: string, ts: number): { high: number; low: number } {
    const index = this.clock.sessionIndexOf(ts);
    const f = this.clock.phaseOf(ts);
    const start = this.clock.sessionStartAt(index);

    let high = -Infinity;
    let low = Infinity;
    const SAMPLES = 24;
    for (let k = 0; k <= SAMPLES; k++) {
      const sampleF = (f * k) / SAMPLES;
      const { price } = this.priceAt(symbol, start + sampleF * this.clock.sessionMs);
      if (price > high) high = price;
      if (price < low) low = price;
    }
    return { high, low };
  }

  /** Cumulative volume so far this session; spikes with the size of the move. */
  private volumeAt(symbol: string, ts: number): number {
    const e = this.entry(symbol);
    const index = this.clock.sessionIndexOf(ts);
    const f = Math.max(0.02, this.clock.phaseOf(ts));
    const p = this.path(symbol, Math.max(index, 0));
    const dayReturn = (p.returns[Math.max(index, 0)] as number) ?? 0;
    const targetDaily = e.annualVol * ANNUAL_TO_DAILY;
    const z = targetDaily > 0 ? Math.abs(dayReturn) / targetDaily : 0;

    const noise = 0.65 + 0.7 * uniformAt(this.seed, `${symbol}|v`, index, STREAM.volume);
    return Math.round(e.baseVolume * noise * (1 + 2.4 * z) * f);
  }

  // ───────────────────────────────────────────────────── provider interface

  /**
   * Apply the injected faults that affect *transport* rather than price.
   * Kept in one place so both quote and history behave consistently.
   */
  private async applyTransportFaults(symbol: string, seq: number): Promise<void> {
    if (this.faults.unknown.has(symbol)) throw new SymbolNotFoundError(symbol);

    if (this.faults.latencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.faults.latencyMs));
    }

    if (this.faults.failureRate > 0) {
      const roll = uniformAt(this.seed, `${symbol}|fail`, seq, STREAM.failure);
      if (roll < this.faults.failureRate) {
        throw new TransientProviderError(`${this.name}: injected upstream failure`, 503);
      }
    }
  }

  async getQuote(symbol: string, signal?: AbortSignal): Promise<RawQuote> {
    const sym = symbol.toUpperCase();
    const now = this.wall.now();

    // Seeded on a coarse time bucket so repeated calls within the same instant
    // agree, but the failure pattern still varies over time.
    await this.applyTransportFaults(sym, Math.floor(now / 250));
    signal?.throwIfAborted();

    const { price, open, prevClose } = this.priceAt(sym, now);
    const { high, low } = this.sessionRange(sym, now);
    const skew = this.bias * this.faults.priceSkew;

    return {
      symbol: sym,
      price: price * skew,
      prevClose,
      dayOpen: open * skew,
      dayHigh: Math.max(high * skew, price * skew),
      dayLow: Math.min(low * skew, price * skew),
      volume: this.volumeAt(sym, now),
      // Backdating asOf is how the staleness ladder gets exercised.
      asOf: now - this.faults.stalenessMs,
      source: this.sourceLabel,
      halted: this.faults.halted.has(sym),
    };
  }

  async getHistory(symbol: string, sessions: number, signal?: AbortSignal): Promise<Bar[]> {
    const sym = symbol.toUpperCase();
    const now = this.wall.now();
    await this.applyTransportFaults(sym, Math.floor(now / 250));
    signal?.throwIfAborted();

    const currentIndex = this.clock.sessionIndexOf(now);
    // Only completed sessions. The in-progress one is the live quote's job;
    // writing it as a bar would bake a partial session into the volatility
    // estimate and make every statistic wrong for the rest of the day.
    const lastComplete = currentIndex - 1;
    const first = Math.max(0, lastComplete - sessions + 1);
    if (lastComplete < first) return [];

    this.path(sym, lastComplete);

    const bars: Bar[] = [];
    for (let i = first; i <= lastComplete; i++) {
      const close = this.closeAt(sym, i);
      const prevClose = this.closeAt(sym, i - 1);
      const dayReturn = Math.log(close / prevClose);
      const open = prevClose * Math.exp(dayReturn * this.gapShare(sym, i));

      // Reconstruct a plausible range from the size of the move plus a seeded
      // widening, rather than sampling the intraday path for a year of bars.
      const spread =
        (Math.abs(dayReturn) * 0.7 + 0.006) *
        (0.7 + 0.9 * uniformAt(this.seed, `${sym}|hl`, i, STREAM.wiggle));
      const mid = Math.max(open, close);
      const midLow = Math.min(open, close);

      bars.push({
        symbol: sym,
        // The session's canonical (start) instant, so the repository's
        // re-canonicalisation is a no-op rather than a remapping.
        ts: this.clock.sessionStartAt(i),
        open,
        high: mid * (1 + spread),
        low: midLow * (1 - spread),
        close,
        // The simulator models no corporate actions, so the raw and adjusted
        // series are identical by construction.
        adjClose: close,
        volume: this.volumeAtSession(sym, i),
        source: this.sourceLabel,
      });
    }
    return bars;
  }

  /** Full-session volume for a completed session. */
  private volumeAtSession(symbol: string, index: number): number {
    const e = this.entry(symbol);
    const p = this.path(symbol, index);
    const dayReturn = (p.returns[index] as number) ?? 0;
    const targetDaily = e.annualVol * ANNUAL_TO_DAILY;
    const z = targetDaily > 0 ? Math.abs(dayReturn) / targetDaily : 0;
    const noise = 0.65 + 0.7 * uniformAt(this.seed, `${symbol}|v`, index, STREAM.volume);
    return Math.round(e.baseVolume * noise * (1 + 2.4 * z));
  }

  async resolve(symbol: string): Promise<{
    symbol: string;
    name: string;
    exchange?: string;
    currency?: string;
    sector?: string;
  }> {
    const e = this.entry(symbol.toUpperCase());
    return {
      symbol: e.symbol,
      name: e.name,
      exchange: 'SIMULATED',
      currency: 'USD',
      sector: e.sector,
    };
  }
}
