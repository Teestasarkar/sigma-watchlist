/**
 * Pure statistics over price history. No I/O, no clock - everything here is
 * deterministic and unit-tested, because the whole notion of "meaningful"
 * rests on these numbers being right.
 */

import type { Bar, InstrumentStats } from './types.js';

export const TRADING_DAYS_PER_YEAR = 252;

/** Guard against divide-by-zero producing Infinity sigmas on flat instruments. */
const EPS = 1e-9;

/**
 * The close to do arithmetic on.
 *
 * Always the adjusted one where the provider supplies it. A 4-for-1 split
 * is a -75% raw return: it would inflate the volatility estimate for a full
 * year, and every sigma computed against that estimate would be wrong. The
 * raw close is for showing to people, not for statistics.
 */
export function adjusted(bar: Bar): number {
  const a = bar.adjClose;
  return typeof a === 'number' && Number.isFinite(a) && a > 0 ? a : bar.close;
}

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample standard deviation (n-1). Returns 0 for fewer than 2 points. */
export function stdev(xs: readonly number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  let acc = 0;
  for (const x of xs) {
    const d = x - m;
    acc += d * d;
  }
  return Math.sqrt(acc / (n - 1));
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Log returns from a close series. Length is closes.length - 1. */
export function logReturns(closes: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1] as number;
    const cur = closes[i] as number;
    if (prev > EPS && cur > EPS) out.push(Math.log(cur / prev));
  }
  return out;
}

/** Simple moving average of the last n values. Falls back to a shorter window. */
export function sma(xs: readonly number[], n: number): number {
  if (xs.length === 0) return 0;
  const slice = xs.slice(-Math.min(n, xs.length));
  return mean(slice);
}

/**
 * Wilder's Average True Range, returned as a fraction of the latest close so it
 * is comparable across a $5 stock and a $500 one.
 */
export function atrPct(bars: readonly Bar[], n = 14): number {
  if (bars.length < 2) return 0;
  // Scale each bar's range by its own adjustment factor, so a split does
  // not register as a single enormous true range.
  const scale = (b: Bar): number => (b.close > EPS ? adjusted(b) / b.close : 1);
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i] as Bar;
    const p = bars[i - 1] as Bar;
    const sb = scale(b);
    const high = b.high * sb;
    const low = b.low * sb;
    const prevClose = adjusted(p);
    trs.push(
      Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)),
    );
  }
  const window = trs.slice(-Math.min(n, trs.length));
  const last = adjusted(bars[bars.length - 1] as Bar);
  if (last <= EPS) return 0;
  return mean(window) / last;
}

/**
 * Two-factor regression: market, then sector.
 *
 * One market factor answers "did everything move?". It cannot answer "did
 * every *bank* move?", and that is the question a user actually has when their
 * bank stock drops 4%. Without a sector factor, a sector-wide repricing shows
 * up as idiosyncratic for every single member - so the briefing fires eight
 * near-identical alarms about one event, which is precisely the noise this
 * product exists to remove.
 *
 * **The sector factor is orthogonalised against the market first.** Sector
 * returns are strongly correlated with market returns - XLF and SPY share most
 * of their variance - and regressing on two collinear factors gives unstable,
 * wildly-signed coefficients that flip between recomputes. Regressing sector
 * on market and keeping only the *residual* removes that: what is left is the
 * part of the sector's move the market does not already explain.
 *
 * This has a second benefit worth stating. Because the residual factor is by
 * construction uncorrelated with the market, the market beta comes out
 * identical to the single-factor one. Adding sector cannot silently change the
 * market attribution, so `beta` stays comparable to what it meant before, and
 * the three parts sum exactly to the total return.
 */
export function regress2(
  assetReturns: readonly number[],
  marketReturns: readonly number[],
  sectorReturns: readonly number[],
): {
  beta: number;
  betaSector: number;
  alpha: number;
  residSigma: number;
  r2: number;
  n: number;
} {
  const n = Math.min(assetReturns.length, marketReturns.length, sectorReturns.length);

  // Not enough overlap to identify two factors. Fall back rather than fit
  // noise: a sector beta from twenty observations is worse than none.
  if (n < 30) {
    const one = regress(assetReturns, marketReturns);
    return { ...one, betaSector: 0 };
  }

  const y = assetReturns.slice(-n);
  const m = marketReturns.slice(-n);
  const s = sectorReturns.slice(-n);

  // Step 1: the part of the sector move the market does not explain.
  const sOnM = regress(s, m);
  const mMean = mean(m);
  const sOrth: number[] = [];
  for (let i = 0; i < n; i++) {
    sOrth.push((s[i] as number) - (sOnM.alpha + sOnM.beta * (m[i] as number)));
  }

  // `stdev` is sample (n-1); squaring it is the matching variance.
  const sVar = stdev(sOrth) ** 2;
  // A sector that is indistinguishable from the market carries no extra
  // information - which is the correct answer for, say, a mega-cap tech name
  // in a tech-dominated index, not a failure.
  if (sVar <= EPS) {
    const one = regress(y, m);
    return { ...one, betaSector: 0 };
  }

  // Step 2: both slopes, independently, because the regressors are orthogonal.
  const beta = regress(y, m).beta;
  const betaSector = regress(y, sOrth).beta;

  const yMean = mean(y);
  const sOrthMean = mean(sOrth);
  const alpha = yMean - beta * mMean - betaSector * sOrthMean;

  const residuals: number[] = [];
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const fitted = alpha + beta * (m[i] as number) + betaSector * (sOrth[i] as number);
    residuals.push((y[i] as number) - fitted);
    const dt = (y[i] as number) - yMean;
    ssTot += dt * dt;
  }
  const ssRes = residuals.reduce((a, r) => a + r * r, 0);

  return {
    beta,
    betaSector,
    alpha,
    residSigma: stdev(residuals),
    r2: ssTot > EPS ? Math.max(0, 1 - ssRes / ssTot) : 0,
    n,
  };
}

/**
 * Split one day's return into market, sector and idiosyncratic parts.
 *
 * The three add up to the total exactly, which is what makes it safe to show a
 * user: "you are down 4.2%, of which 1.1% was the market, 2.6% was every other
 * semiconductor, and 0.5% was you" is a complete account, not a selection.
 *
 * The sector input is the *raw* sector return; it is orthogonalised here with
 * the same market beta used for the fit, so attribution matches the model.
 */
export function attribute(args: {
  assetReturn: number;
  marketReturn: number;
  sectorReturn: number | null;
  beta: number;
  betaSector: number;
  /** The sector proxy's own market beta, so the sector part excludes the market part. */
  sectorMarketBeta?: number;
}): { market: number; sector: number; idiosyncratic: number } {
  const beta = Number.isFinite(args.beta) ? args.beta : 1;
  const market = beta * args.marketReturn;

  let sector = 0;
  if (args.sectorReturn !== null && Number.isFinite(args.betaSector)) {
    const s0 = Number.isFinite(args.sectorMarketBeta ?? Number.NaN)
      ? (args.sectorMarketBeta as number)
      : 1;
    // The sector's own move, less the part of it the market already accounts
    // for - otherwise the market's contribution is counted twice.
    sector = args.betaSector * (args.sectorReturn - s0 * args.marketReturn);
  }

  return {
    market,
    sector,
    // By subtraction, so the parts always sum to the total even when a factor
    // is missing. A decomposition that does not add up is worse than none.
    idiosyncratic: args.assetReturn - market - sector,
  };
}

/**
 * OLS slope of asset returns on market returns, plus the residual standard
 * deviation. Beta lets us separate "the whole market moved" from "something
 * happened to this company" - the single most important distinction when
 * deciding whether a move deserves attention.
 */
export function regress(
  assetReturns: readonly number[],
  marketReturns: readonly number[],
): { beta: number; alpha: number; residSigma: number; r2: number; n: number } {
  const n = Math.min(assetReturns.length, marketReturns.length);
  if (n < 10) return { beta: 1, alpha: 0, residSigma: stdev(assetReturns), r2: 0, n };

  const y = assetReturns.slice(-n);
  const x = marketReturns.slice(-n);
  const mx = mean(x);
  const my = mean(y);

  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    const dx = (x[i] as number) - mx;
    sxy += dx * ((y[i] as number) - my);
    sxx += dx * dx;
  }

  // A market with no variance carries no information; fall back to beta 1.
  if (sxx <= EPS) return { beta: 1, alpha: 0, residSigma: stdev(y), r2: 0, n };

  const beta = sxy / sxx;
  const alpha = my - beta * mx;

  const residuals: number[] = [];
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const fitted = alpha + beta * (x[i] as number);
    residuals.push((y[i] as number) - fitted);
    const dt = (y[i] as number) - my;
    ssTot += dt * dt;
  }
  const ssRes = residuals.reduce((a, r) => a + r * r, 0);

  return {
    beta,
    alpha,
    residSigma: stdev(residuals),
    r2: ssTot > EPS ? Math.max(0, 1 - ssRes / ssTot) : 0,
    n,
  };
}

/**
 * Minimum horizon, in sessions, that we will divide by.
 *
 * A 4% move in ten minutes should be judged against roughly a session of
 * noise, not against ten minutes of it - otherwise every intraday tick reads
 * as a 40-sigma event. Floor at a quarter session.
 */
export const MIN_HORIZON_DAYS = 0.25;

/** Scale a daily sigma to a horizon measured in trading sessions (root-time). */
export function horizonSigma(sigmaDaily: number, tradingDays: number): number {
  return sigmaDaily * Math.sqrt(Math.max(tradingDays, MIN_HORIZON_DAYS));
}

/**
 * How many standard deviations is this move, given how much market time
 * elapsed? `tradingDays` comes from the market calendar, not wall-clock, so an
 * absence over a weekend is not treated as three days of risk.
 *
 * Returns null when we lack the vol estimate to answer honestly. Returning
 * null rather than 0 is deliberate: "we don't know" and "nothing happened" are
 * different answers and the UI renders them differently.
 */
export function sigmaOfMove(
  changeFraction: number,
  sigmaDaily: number,
  tradingDays: number,
): number | null {
  if (!Number.isFinite(changeFraction)) return null;
  if (sigmaDaily <= EPS) return null;
  const denom = horizonSigma(sigmaDaily, tradingDays);
  if (denom <= EPS) return null;
  return changeFraction / denom;
}

/** Drawdown from a running peak, as a positive fraction. */
export function drawdownFromPeak(price: number, peak: number): number {
  if (peak <= EPS) return 0;
  return Math.max(0, (peak - price) / peak);
}

/** Squash an unbounded magnitude into 0..1 for cross-kind comparability. */
export function saturate(value: number, scale: number): number {
  if (!Number.isFinite(value) || scale <= EPS) return 0;
  const x = Math.abs(value) / scale;
  return x / (1 + x);
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Recompute the full statistics bundle for a symbol.
 *
 * marketBars are the benchmark's bars, aligned by timestamp. The result is
 * stored, not recomputed per request - a 500-symbol watchlist would otherwise
 * redo all of this work on every page load.
 */
export function computeStats(
  symbol: string,
  bars: readonly Bar[],
  marketBars: readonly Bar[],
  now: number,
  /**
   * The sector proxy's bars, when the instrument has one. Optional so every
   * existing caller keeps working and gets exactly the old single-factor
   * behaviour.
   */
  sector?: { symbol: string; bars: readonly Bar[] } | null,
): InstrumentStats {
  const closes = bars.map(adjusted);
  const rets = logReturns(closes);
  const last = closes[closes.length - 1] ?? 0;

  // Align asset and market returns on timestamp so a symbol that listed
  // mid-history, or that has missing sessions, does not get a nonsense beta.
  const marketByTs = new Map(marketBars.map((b) => [b.ts, adjusted(b)]));
  const pairedAsset: number[] = [];
  const pairedMarket: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const cur = bars[i] as Bar;
    const prev = bars[i - 1] as Bar;
    const mCur = marketByTs.get(cur.ts);
    const mPrev = marketByTs.get(prev.ts);
    if (mCur === undefined || mPrev === undefined) continue;
    if (adjusted(prev) <= EPS || mPrev <= EPS) continue;
    pairedAsset.push(Math.log(adjusted(cur) / adjusted(prev)));
    pairedMarket.push(Math.log(mCur / mPrev));
  }

  /*
   * The sector series, aligned on the same sessions.
   *
   * Built alongside the market pairs rather than separately, so all three
   * series describe exactly the same days. Pairing them independently would
   * quietly regress a 250-day asset series against a 248-day sector one and
   * mis-attribute every mismatched day.
   */
  const sectorByTs =
    sector && sector.symbol !== symbol ? new Map(sector.bars.map((b) => [b.ts, adjusted(b)])) : null;

  const pairedSector: number[] = [];
  let sectorAligned = sectorByTs !== null;
  if (sectorByTs) {
    for (let i = 1; i < bars.length; i++) {
      const cur = bars[i] as Bar;
      const prev = bars[i - 1] as Bar;
      const mCur = marketByTs.get(cur.ts);
      const mPrev = marketByTs.get(prev.ts);
      if (mCur === undefined || mPrev === undefined) continue;
      if (adjusted(prev) <= EPS || mPrev <= EPS) continue;

      const sCur = sectorByTs.get(cur.ts);
      const sPrev = sectorByTs.get(prev.ts);
      // One missing sector day would shift every later observation by one, so
      // a gap disqualifies the factor rather than silently misaligning it.
      if (sCur === undefined || sPrev === undefined || sPrev <= EPS) {
        sectorAligned = false;
        break;
      }
      pairedSector.push(Math.log(sCur / sPrev));
    }
  }

  const useSector = sectorAligned && pairedSector.length === pairedAsset.length;

  const fit = useSector
    ? regress2(pairedAsset, pairedMarket, pairedSector)
    : { ...regress(pairedAsset, pairedMarket), betaSector: 0 };

  const { beta, residSigma } = fit;

  // Only claim a sector loading when one was actually fitted. `regress2` falls
  // back to the single-factor result on thin history, and reporting 0 there
  // would look like a measured absence of exposure rather than an absence of
  // measurement.
  const fittedSector = useSector && fit.betaSector !== 0;
  const sectorOnMarket = fittedSector ? regress(pairedSector, pairedMarket).beta : null;

  const win = <T,>(arr: readonly T[], n: number): T[] => arr.slice(-Math.min(n, arr.length));
  const y = win(bars, TRADING_DAYS_PER_YEAR);
  const m30 = win(bars, 30);
  const sigma90 = stdev(win(rets, 90));

  /*
   * Ranges come from the adjusted series too.
   *
   * A 52-week high in pre-split money is not a level today's price can be
   * compared against - NVDA's raw high of $1,250 would sit permanently
   * above a post-split $130 and the range-break detector would never fire
   * again. High and low are scaled by the same factor as the close.
   */
  const scale = (b: Bar): number => (b.close > EPS ? adjusted(b) / b.close : 1);
  const highs52 = y.map((b) => b.high * scale(b));
  const lows52 = y.map((b) => b.low * scale(b));
  const closes52 = y.map(adjusted);

  return {
    symbol,
    computedAt: now,
    bars: bars.length,
    sigmaDaily: sigma90,
    sigmaShort: stdev(win(rets, 10)),
    atrPct: atrPct(bars, 14),
    beta,
    betaSector: fittedSector ? fit.betaSector : null,
    sectorSymbol: fittedSector && sector ? sector.symbol : null,
    sectorMarketBeta: sectorOnMarket,
    // If the regression is degenerate, fall back to total vol so that
    // idiosyncratic signals stay conservative rather than over-firing.
    residSigma: residSigma > EPS ? residSigma : sigma90,
    hi52w: highs52.length ? Math.max(...highs52) : last,
    lo52w: lows52.length ? Math.min(...lows52) : last,
    hi30d: m30.length ? Math.max(...m30.map((b) => b.high * scale(b))) : last,
    lo30d: m30.length ? Math.min(...m30.map((b) => b.low * scale(b))) : last,
    medVol20: median(win(bars, 20).map((b) => b.volume)),
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
    peak52w: closes52.length ? Math.max(...closes52) : last,
  };
}
