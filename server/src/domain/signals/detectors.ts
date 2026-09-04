/**
 * The detectors: this file *is* the product's opinion about what "meaningful"
 * means.
 *
 * Every detector is a pure function from a snapshot of the world to an
 * `Observation | null`. No I/O, no clock reads, no database - which is why the
 * interesting behaviour (hysteresis, thresholds, edge cases like thin history
 * or a halted instrument) is all unit-testable without standing anything up.
 *
 * The three principles behind the choices here:
 *
 * 1. **Normalise by the instrument's own volatility.** Percentage change is
 *    not information. A 2% move in a utility is a three-sigma event; a 5% move
 *    in a meme stock is Tuesday. Ranking by percentage guarantees the same
 *    handful of volatile names dominate forever while the genuinely surprising
 *    moves in quiet names never surface.
 *
 * 2. **Separate the market from the company.** If a stock is up 3% on a day
 *    the whole index is up 3%, nothing happened to that company. The
 *    market-adjusted (residual) move is what deserves attention, and it is
 *    frequently the *opposite sign* to the headline number.
 *
 * 3. **Say when you don't know.** A detector with insufficient history returns
 *    null rather than guessing. "We can't judge this yet" is displayed
 *    honestly rather than dressed up as "nothing happened".
 */

import type {
  Direction,
  Freshness,
  InstrumentStats,
  Quote,
  SignalKind,
} from '../types.js';
import type { MarketClock } from '../marketClock.js';
import { drawdownFromPeak, horizonSigma, saturate } from '../stats.js';

// ─────────────────────────────────────────────────────────── contract

export interface Thresholds {
  sigmaEnter: number;
  sigmaExit: number;
  idioEnter: number;
  idioExit: number;
  gapEnterAtr: number;
  rvolEnter: number;
  rvolExit: number;
  volRegimeEnter: number;
  volRegimeExit: number;
  rangeBreakBuffer: number;
  drawdownBuckets: readonly number[];
  minBarsForStats: number;
  staleMs: number;
}

export interface DetectorContext {
  symbol: string;
  now: number;
  quote: Quote;
  stats: InstrumentStats | null;
  freshness: Freshness;
  clock: MarketClock;
  /** Benchmark quote and stats, for the market-adjusted detectors. */
  benchmark: { quote: Quote; stats: InstrumentStats } | null;
  thresholds: Thresholds;
}

/**
 * A detector's reading of the current instant.
 *
 * `value` is the scalar the hysteresis machine compares against `enter` and
 * `exit`. Keeping magnitude (`value`) separate from presentation (`severity`,
 * `headline`) is what lets one state machine drive every detector.
 */
export interface Observation {
  kind: SignalKind;
  value: number;
  direction: Direction;
  /** 0..1, comparable across kinds. */
  severity: number;
  headline: string;
  evidence: Record<string, number | string | boolean>;
  enter: number;
  exit: number;
  /**
   * Distinguishes episodes that are qualitatively different even when the
   * condition never lapsed - a break of the 30-day high followed by a break of
   * the 52-week high is two pieces of news, not one continuing one.
   */
  discriminator: string;
}

export type Detector = (ctx: DetectorContext) => Observation | null;

// ─────────────────────────────────────────────────────────── helpers

const pct = (x: number): string => `${(x * 100).toFixed(x >= 0.1 || x <= -0.1 ? 1 : 2)}%`;
const signed = (x: number): string => `${x >= 0 ? '+' : ''}${pct(x)}`;
const sig = (x: number): string => `${Math.abs(x).toFixed(1)}σ`;
const dirOf = (x: number): Direction => (x > 0 ? 'up' : x < 0 ? 'down' : 'neutral');
const word = (x: number): string => (x > 0 ? 'up' : 'down');

/** Do we have enough history to make a statistical claim at all? */
function hasStats(ctx: DetectorContext): ctx is DetectorContext & { stats: InstrumentStats } {
  return (
    ctx.stats !== null &&
    ctx.stats.bars >= ctx.thresholds.minBarsForStats &&
    ctx.stats.sigmaDaily > 1e-9
  );
}

/**
 * How much market time the current session has covered.
 *
 * Floored, because dividing by a near-zero horizon in the first seconds of a
 * session turns any tick into an infinite sigma.
 */
function elapsedSessions(ctx: DetectorContext): number {
  return Math.max(0.15, ctx.clock.sessionProgress(ctx.now));
}

/** Return since the previous session's close. */
function sessionReturn(ctx: DetectorContext): number | null {
  const { price, prevClose } = ctx.quote;
  if (!(prevClose > 0) || !(price > 0)) return null;
  return price / prevClose - 1;
}

/**
 * A reading that reports "nothing to see here".
 *
 * Detectors must still report when their condition is *absent*, because that
 * is what closes an open episode. Returning null instead would leave a
 * resolved signal open forever. Typed explicitly so each detector's branches
 * agree on one shape.
 */
function inactive(
  kind: SignalKind,
  headline: string,
  evidence: Record<string, number | string | boolean>,
): Observation {
  return {
    kind,
    value: 0,
    direction: 'neutral',
    severity: 0,
    headline,
    evidence,
    enter: 1,
    exit: 1,
    discriminator: 'none',
  };
}

// ─────────────────────────────────────────────────────────── detectors

/**
 * The primary detector: how large is today's move relative to this
 * instrument's own typical move over the same amount of market time?
 */
export const sigmaMove: Detector = (ctx) => {
  if (!hasStats(ctx)) return null;
  const ret = sessionReturn(ctx);
  if (ret === null) return null;

  const horizon = elapsedSessions(ctx);
  const expected = horizonSigma(ctx.stats.sigmaDaily, horizon);
  if (expected <= 1e-9) return null;

  const z = ret / expected;
  const { sigmaEnter, sigmaExit } = ctx.thresholds;

  return {
    kind: 'sigma_move',
    value: z,
    direction: dirOf(z),
    // Scale so that ~2σ reads as moderate and 6σ approaches the ceiling.
    severity: saturate(z, 4),
    headline: `${ctx.symbol} ${word(z)} ${pct(Math.abs(ret))} — ${sig(z)} for this name`,
    evidence: {
      changePct: ret,
      sigma: z,
      expectedMovePct: expected,
      sigmaDaily: ctx.stats.sigmaDaily,
      sessionsElapsed: horizon,
      price: ctx.quote.price,
      prevClose: ctx.quote.prevClose,
    },
    enter: sigmaEnter,
    exit: sigmaExit,
    // One episode per session per direction: a stock that swings from +3σ to
    // -3σ intraday has genuinely done two separate things.
    discriminator: `${ctx.clock.sessionKeyOf(ctx.now)}|${dirOf(z)}`,
  };
};

/**
 * The move that remains after removing what the market explains.
 *
 * This is the detector that most changes what a user sees. It is what lets the
 * briefing say "the whole market is down, your holding is merely along for the
 * ride" instead of ten separate alarms - and conversely, to flag a 1% move as
 * important because everything else fell 2%.
 */
export const idioMove: Detector = (ctx) => {
  if (!hasStats(ctx)) return null;
  if (!ctx.benchmark) return null;

  const ret = sessionReturn(ctx);
  if (ret === null) return null;

  const bench = ctx.benchmark.quote;
  if (!(bench.prevClose > 0) || !(bench.price > 0)) return null;
  const marketRet = bench.price / bench.prevClose - 1;

  const beta = Number.isFinite(ctx.stats.beta) ? ctx.stats.beta : 1;
  const explained = beta * marketRet;
  const residual = ret - explained;

  const horizon = elapsedSessions(ctx);
  // Residual volatility is the right yardstick here: comparing an
  // idiosyncratic move against *total* volatility would systematically
  // understate it for high-beta names.
  const expected = horizonSigma(ctx.stats.residSigma, horizon);
  if (expected <= 1e-9) return null;

  const z = residual / expected;
  const { idioEnter, idioExit } = ctx.thresholds;

  // Only interesting when the market genuinely fails to explain the move.
  // Without this the detector duplicates sigma_move for every high-beta stock
  // on a big market day.
  const marketExplains = Math.abs(explained) > 1e-9 && Math.abs(residual) < Math.abs(explained) * 0.5;

  const headline = marketExplains
    ? `${ctx.symbol} moved with the market (${signed(ret)} vs ${signed(explained)} explained)`
    : `${ctx.symbol} ${word(z)} ${pct(Math.abs(residual))} beyond the market — ${sig(z)} idiosyncratic`;

  return {
    kind: 'idio_move',
    value: marketExplains ? 0 : z,
    direction: dirOf(z),
    severity: saturate(z, 3.5),
    headline,
    evidence: {
      changePct: ret,
      marketChangePct: marketRet,
      beta,
      explainedPct: explained,
      residualPct: residual,
      sigma: z,
      residSigma: ctx.stats.residSigma,
      marketExplains,
      benchmark: bench.symbol,
    },
    enter: idioEnter,
    exit: idioExit,
    discriminator: `${ctx.clock.sessionKeyOf(ctx.now)}|${dirOf(z)}`,
  };
};

/**
 * An overnight gap: a repricing the user could not have traded through.
 *
 * Measured in ATR multiples rather than percent, so it is comparable across
 * instruments, and because ATR already encodes each name's typical daily range.
 */
export const gap: Detector = (ctx) => {
  if (!hasStats(ctx)) return null;
  const { dayOpen, prevClose } = ctx.quote;
  if (!(dayOpen > 0) || !(prevClose > 0)) return null;
  if (ctx.stats.atrPct <= 1e-9) return null;

  const gapPct = dayOpen / prevClose - 1;
  const atrMultiple = gapPct / ctx.stats.atrPct;

  return {
    kind: 'gap',
    value: atrMultiple,
    direction: dirOf(gapPct),
    severity: saturate(atrMultiple, 3),
    headline: `${ctx.symbol} gapped ${word(gapPct)} ${pct(Math.abs(gapPct))} at the open`,
    evidence: {
      gapPct,
      atrMultiple,
      atrPct: ctx.stats.atrPct,
      dayOpen,
      prevClose,
    },
    enter: ctx.thresholds.gapEnterAtr,
    // A gap is an event, not a state: it either happened this session or it
    // did not. The exit threshold matches the entry so the episode closes as
    // soon as the session rolls over.
    exit: ctx.thresholds.gapEnterAtr,
    discriminator: `${ctx.clock.sessionKeyOf(ctx.now)}|${dirOf(gapPct)}`,
  };
};

/**
 * A break of a meaningful price level.
 *
 * Checks the 52-week extreme first and falls back to the 30-day one, so the
 * bigger news wins and the discriminator changes when a 30-day break becomes a
 * 52-week break - producing a second, correctly-framed signal.
 */
export const rangeBreak: Detector = (ctx) => {
  if (!hasStats(ctx)) return null;
  const { price } = ctx.quote;
  if (!(price > 0)) return null;

  const s = ctx.stats;
  const buf = ctx.thresholds.rangeBreakBuffer;

  const candidates: Array<{ scope: string; level: number; dir: Direction; sessions: number }> = [];
  if (s.hi52w > 0 && price > s.hi52w * (1 + buf))
    candidates.push({ scope: '52-week high', level: s.hi52w, dir: 'up', sessions: 252 });
  if (s.lo52w > 0 && price < s.lo52w * (1 - buf))
    candidates.push({ scope: '52-week low', level: s.lo52w, dir: 'down', sessions: 252 });
  if (candidates.length === 0) {
    if (s.hi30d > 0 && price > s.hi30d * (1 + buf))
      candidates.push({ scope: '30-day high', level: s.hi30d, dir: 'up', sessions: 30 });
    if (s.lo30d > 0 && price < s.lo30d * (1 - buf))
      candidates.push({ scope: '30-day low', level: s.lo30d, dir: 'down', sessions: 30 });
  }

  if (candidates.length === 0) {
    return inactive(
      'range_break',
      `${ctx.symbol} inside its recent range`,
      { price, hi52w: s.hi52w, lo52w: s.lo52w },
    );
  }

  const best = candidates[0] as (typeof candidates)[number];
  const overshoot = Math.abs(price / best.level - 1);
  // Longer lookbacks are more significant: a 52-week high matters more than a
  // 30-day one even at identical overshoot.
  const weight = best.sessions >= 252 ? 1 : 0.6;

  return {
    kind: 'range_break',
    value: 1 + overshoot / Math.max(buf, 1e-9),
    direction: best.dir,
    severity: Math.min(1, weight * (0.55 + saturate(overshoot, 0.05) * 0.45)),
    headline: `${ctx.symbol} at a new ${best.scope} (${price.toFixed(2)})`,
    evidence: {
      scope: best.scope,
      level: best.level,
      price,
      overshootPct: overshoot,
      lookbackSessions: best.sessions,
    },
    enter: 1.5,
    exit: 1,
    // Changing scope opens a new episode, which is what we want: escalating
    // from a 30-day to a 52-week break is fresh news.
    discriminator: best.scope,
  };
};

/**
 * Unusual trading activity, paced by how much of the session has elapsed.
 *
 * The pacing is essential. Comparing cumulative volume to a full-day median
 * would report every stock as quiet in the morning and every stock as busy at
 * the close - a detector that fires on the time of day rather than on the
 * market.
 */
export const volumeSpike: Detector = (ctx) => {
  if (!hasStats(ctx)) return null;
  const s = ctx.stats;
  if (s.medVol20 <= 0) return null;

  const progress = Math.max(0.08, ctx.clock.sessionProgress(ctx.now));
  const expected = s.medVol20 * progress;
  if (expected <= 0) return null;

  const rvol = ctx.quote.volume / expected;
  if (!Number.isFinite(rvol)) return null;

  const ret = sessionReturn(ctx) ?? 0;

  return {
    kind: 'volume_spike',
    value: rvol,
    // Volume has no sign; the price direction is the useful colour.
    direction: dirOf(ret),
    severity: saturate(rvol - 1, 4),
    headline: `${ctx.symbol} trading ${rvol.toFixed(1)}× normal volume`,
    evidence: {
      rvol,
      volume: ctx.quote.volume,
      expectedByNow: expected,
      medianDailyVolume: s.medVol20,
      sessionProgress: progress,
      changePct: ret,
    },
    enter: ctx.thresholds.rvolEnter,
    exit: ctx.thresholds.rvolExit,
    discriminator: ctx.clock.sessionKeyOf(ctx.now),
  };
};

/**
 * A change in medium-term trend, via the 20/50 moving-average relationship.
 *
 * Slow signals like this are exactly what a returning user misses: nobody
 * notices a crossover happening, but it reframes everything else about the
 * position.
 */
export const trendFlip: Detector = (ctx) => {
  if (!hasStats(ctx)) return null;
  const s = ctx.stats;
  if (s.sma20 <= 0 || s.sma50 <= 0) return null;
  // Needs enough history for a 50-session average to mean anything.
  if (s.bars < 55) return null;

  const spread = s.sma20 / s.sma50 - 1;
  const above = spread > 0;

  // Require the crossover to be established rather than a hair's breadth, so
  // an average oscillating around its own crossing does not fire repeatedly.
  const margin = Math.max(0.004, s.sigmaDaily * 0.5);
  const strength = Math.abs(spread) / margin;

  return {
    kind: 'trend_flip',
    value: strength,
    direction: above ? 'up' : 'down',
    severity: Math.min(0.7, 0.3 + saturate(spread, 0.04) * 0.4),
    headline: above
      ? `${ctx.symbol} 20-session average crossed above its 50-session average`
      : `${ctx.symbol} 20-session average crossed below its 50-session average`,
    evidence: {
      sma20: s.sma20,
      sma50: s.sma50,
      spreadPct: spread,
      regime: above ? 'uptrend' : 'downtrend',
    },
    enter: 1,
    exit: 0.5,
    // The regime itself is the discriminator: one signal per crossing, and a
    // new one only when it crosses back.
    discriminator: above ? 'above' : 'below',
  };
};

/** "This name has become dangerous": short-window volatility vs its baseline. */
export const volRegime: Detector = (ctx) => {
  if (!hasStats(ctx)) return null;
  const s = ctx.stats;
  if (s.sigmaDaily <= 1e-9 || s.sigmaShort <= 0) return null;
  if (s.bars < 40) return null;

  const ratio = s.sigmaShort / s.sigmaDaily;

  return {
    kind: 'vol_regime',
    value: ratio,
    direction: 'neutral',
    severity: Math.min(0.85, saturate(ratio - 1, 1.5)),
    headline: `${ctx.symbol} is ${ratio.toFixed(1)}× more volatile than its baseline`,
    evidence: {
      shortSigma: s.sigmaShort,
      baselineSigma: s.sigmaDaily,
      ratio,
      annualisedShort: s.sigmaShort * Math.sqrt(252),
    },
    enter: ctx.thresholds.volRegimeEnter,
    exit: ctx.thresholds.volRegimeExit,
    discriminator: 'elevated',
  };
};

/**
 * Drawdown from the trailing peak, bucketed.
 *
 * Bucketing is what makes this bearable: a stock grinding down 30% over two
 * months should produce three notifications at 10/20/30%, not one per poll for
 * two months. The bucket is the episode discriminator, so each level fires
 * exactly once and re-arms only if the drawdown recovers and deepens again.
 */
export const drawdown: Detector = (ctx) => {
  if (!hasStats(ctx)) return null;
  const s = ctx.stats;
  if (s.peak52w <= 0) return null;

  const dd = drawdownFromPeak(ctx.quote.price, s.peak52w);
  const buckets = [...ctx.thresholds.drawdownBuckets].sort((a, b) => a - b);

  let reached: number | null = null;
  for (const bucket of buckets) if (dd * 100 >= bucket) reached = bucket;

  if (reached === null) {
    return inactive('drawdown', `${ctx.symbol} near its highs`, {
      drawdownPct: dd,
      peak: s.peak52w,
    });
  }

  return {
    kind: 'drawdown',
    value: 1 + reached / 100,
    direction: 'down',
    severity: Math.min(1, 0.3 + reached / 100),
    headline: `${ctx.symbol} is ${(dd * 100).toFixed(0)}% below its 52-week peak`,
    evidence: {
      drawdownPct: dd,
      bucket: reached,
      peak: s.peak52w,
      price: ctx.quote.price,
    },
    enter: 1.05,
    exit: 1.0,
    discriminator: `dd${reached}`,
  };
};

/**
 * The data itself is news.
 *
 * A watchlist that quietly shows a two-hour-old price as though it were live
 * is worse than one that shows nothing: the user makes decisions on it. When
 * we lose a feed we say so, at the same prominence as a price move, because
 * for someone holding a position it is equally actionable.
 */
export const staleData: Detector = (ctx) => {
  const age = ctx.now - ctx.quote.asOf;
  const limit = ctx.thresholds.staleMs;
  if (limit <= 0) return null;

  const ratio = age / limit;
  const minutes = Math.max(0, Math.round(age / 60_000));

  return {
    kind: 'stale_data',
    value: ratio,
    direction: 'neutral',
    severity: Math.min(0.9, 0.4 + saturate(ratio - 1, 3) * 0.5),
    headline:
      minutes >= 60
        ? `No fresh price for ${ctx.symbol} in ${(minutes / 60).toFixed(1)} hours`
        : `No fresh price for ${ctx.symbol} in ${minutes} minutes`,
    evidence: {
      ageMs: age,
      asOf: ctx.quote.asOf,
      source: ctx.quote.source,
      freshness: ctx.freshness,
      confidence: ctx.quote.confidence,
    },
    enter: 1,
    exit: 0.6,
    discriminator: 'stale',
  };
};

/** Sources disagree. Surfaced rather than resolved away silently. */
export const dataConflict: Detector = (ctx) => {
  const c = ctx.quote.conflict;
  if (!c) {
    return inactive('data_conflict', `${ctx.symbol} sources agree`, { spread: 0 });
  }

  const worst = c.quotes.reduce(
    (acc, q) => ({ min: Math.min(acc.min, q.price), max: Math.max(acc.max, q.price) }),
    { min: Infinity, max: -Infinity },
  );

  return {
    kind: 'data_conflict',
    value: 1 + c.spread * 100,
    direction: 'neutral',
    severity: Math.min(0.8, 0.35 + saturate(c.spread, 0.02) * 0.45),
    headline: `${ctx.symbol} price disputed: sources differ by ${pct(c.spread)}`,
    evidence: {
      spread: c.spread,
      resolution: c.resolution,
      sources: c.quotes.map((q) => `${q.source}@${q.price.toFixed(2)}`).join(' vs '),
      low: worst.min,
      high: worst.max,
      accepted: ctx.quote.price,
    },
    enter: 1.01,
    exit: 1.0,
    discriminator: 'conflict',
  };
};

/**
 * Registration order matters only for tie-breaking in the digest; the engine
 * runs all of them.
 */
export const DETECTORS: readonly Detector[] = [
  sigmaMove,
  idioMove,
  gap,
  rangeBreak,
  volumeSpike,
  trendFlip,
  volRegime,
  drawdown,
  staleData,
  dataConflict,
];

/**
 * Detectors that describe the *data pipeline* rather than the market.
 *
 * These stay active even when the quote is stale - indeed especially then -
 * whereas market detectors are suppressed on stale data, because computing a
 * sigma from a price that may be hours old produces confident nonsense.
 */
export const INTEGRITY_KINDS: ReadonlySet<SignalKind> = new Set<SignalKind>([
  'stale_data',
  'data_conflict',
]);

/**
 * Kinds that describe a *standing condition* rather than something that just
 * happened.
 *
 * The distinction matters on a cold start. "AAPL is 29% below its 52-week
 * peak" and "GME is in a downtrend" are true of a stock that has been sitting
 * quietly that way for months - they are context, not news. But the first time
 * we ever observe a symbol, every one of these conditions is newly *observed*,
 * so a naive engine announces all of them at once and the user's first
 * briefing is twenty items of ancient history.
 *
 * The engine therefore opens the first episode of these kinds silently: the
 * state is recorded so hysteresis works, but no signal is emitted until the
 * condition actually *transitions*. Event-like kinds (a gap, a sigma move, a
 * volume spike) are exempt, because for those the first observation genuinely
 * is the event.
 */
export const STATE_KINDS: ReadonlySet<SignalKind> = new Set<SignalKind>([
  'trend_flip',
  'vol_regime',
  'drawdown',
  'range_break',
]);
