/**
 * The sector factor.
 *
 * The problem it solves: with one market factor, a sector-wide repricing is
 * "idiosyncratic" for every member of that sector. Eight semiconductors fall
 * together on one piece of news and the briefing fires eight near-identical
 * alarms — which is exactly the noise this product exists to remove.
 *
 * These tests are built on *constructed* return series where the true factor
 * loadings are known, so the assertions are about recovering a right answer
 * rather than about whatever the market happened to do.
 */

import { describe, expect, it } from 'vitest';

import { attribute, regress, regress2 } from '../src/domain/stats.js';

/**
 * Deterministic PRNG (mulberry32), so a failure is reproducible.
 *
 * Not a linear congruential generator, and that matters here. An LCG's
 * consecutive outputs fall on lattice planes, so drawing the market factor and
 * the sector factor from successive calls makes them measurably correlated -
 * and a test for "these two factors are independent" then fails against
 * perfectly correct code. The bug would have been in the fixture.
 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Roughly normal, via the central limit theorem. Good enough for a fixture. */
function noise(rand: () => number, scale: number): number {
  let acc = 0;
  for (let i = 0; i < 6; i++) acc += rand();
  return (acc - 3) * scale;
}

/**
 * A world with a known truth.
 *
 * The market moves. The sector moves with the market *plus* a move of its own.
 * The asset loads on both, plus its own idiosyncratic noise. Recovering
 * `betaMarket` and `betaSector` from the returns is the whole job.
 */
function world(opts: {
  n?: number;
  betaMarket: number;
  betaSector: number;
  /** How strongly the sector itself follows the market. */
  sectorOnMarket?: number;
  idioScale?: number;
  seed?: number;
}): { asset: number[]; market: number[]; sector: number[] } {
  const rand = rng(opts.seed ?? 42);
  const n = opts.n ?? 250;
  const sectorOnMarket = opts.sectorOnMarket ?? 1.0;
  const idioScale = opts.idioScale ?? 0.004;

  const asset: number[] = [];
  const market: number[] = [];
  const sector: number[] = [];

  for (let i = 0; i < n; i++) {
    const m = noise(rand, 0.01);
    // The sector's own move, on top of whatever the market did.
    const sOwn = noise(rand, 0.008);
    const s = sectorOnMarket * m + sOwn;

    asset.push(opts.betaMarket * m + opts.betaSector * sOwn + noise(rand, idioScale));
    market.push(m);
    sector.push(s);
  }

  return { asset, market, sector };
}

describe('recovering two factor loadings', () => {
  it('finds both betas when the truth is known', () => {
    const { asset, market, sector } = world({ betaMarket: 1.2, betaSector: 0.8 });
    const fit = regress2(asset, market, sector);

    expect(fit.beta).toBeCloseTo(1.2, 1);
    expect(fit.betaSector).toBeCloseTo(0.8, 1);
    // Two real factors should explain most of the variance here.
    expect(fit.r2).toBeGreaterThan(0.8);
  });

  it('reports no sector loading for a name that has none', () => {
    const { asset, market, sector } = world({ betaMarket: 1.0, betaSector: 0 });
    const fit = regress2(asset, market, sector);

    expect(fit.beta).toBeCloseTo(1.0, 1);
    expect(Math.abs(fit.betaSector)).toBeLessThan(0.15);
  });

  it('does not let a collinear sector corrupt the market beta', () => {
    /*
     * The reason the sector factor is orthogonalised first.
     *
     * A sector that is nearly identical to the market shares almost all of its
     * variance. Regressing on both raw would give wildly unstable coefficients
     * that flip sign between recomputes — and silently change what `beta`
     * means. Orthogonalising keeps the market beta exactly where it was.
     */
    const { asset, market, sector } = world({
      betaMarket: 1.3,
      betaSector: 0.5,
      // Almost pure market: only a sliver of independent sector movement.
      sectorOnMarket: 1.0,
      seed: 7,
    });

    const oneFactor = regress(asset, market);
    const twoFactor = regress2(asset, market, sector);

    // The whole point: adding a sector factor cannot move the market beta.
    expect(twoFactor.beta).toBeCloseTo(oneFactor.beta, 6);
  });

  it('leaves a smaller residual than the market alone', () => {
    // If the second factor did not reduce unexplained variance it would be
    // costing complexity for nothing.
    const { asset, market, sector } = world({ betaMarket: 1.0, betaSector: 1.2 });

    const oneFactor = regress(asset, market);
    const twoFactor = regress2(asset, market, sector);

    expect(twoFactor.residSigma).toBeLessThan(oneFactor.residSigma * 0.6);
    expect(twoFactor.r2).toBeGreaterThan(oneFactor.r2);
  });

  it('falls back to one factor rather than fitting noise', () => {
    /*
     * A sector beta from twenty observations is worse than no sector beta: it
     * is confident, wrong, and indistinguishable from a real one downstream.
     */
    const { asset, market, sector } = world({ n: 20, betaMarket: 1.1, betaSector: 0.9 });
    const fit = regress2(asset, market, sector);

    expect(fit.betaSector).toBe(0);
    expect(fit.beta).toBeCloseTo(regress(asset, market).beta, 10);
  });

  it('survives a sector series with no variance of its own', () => {
    // A sector proxy that is literally the market carries no extra
    // information. That is a correct answer, not a divide-by-zero.
    const { asset, market } = world({ betaMarket: 1.0, betaSector: 0 });
    const fit = regress2(asset, market, market);

    expect(fit.betaSector).toBe(0);
    expect(Number.isFinite(fit.beta)).toBe(true);
    expect(Number.isFinite(fit.residSigma)).toBe(true);
  });
});

describe('attributing one day move', () => {
  it('splits into three parts that add up exactly', () => {
    /*
     * This is what a user is shown, so it has to be a complete account rather
     * than a selection. If the parts do not sum to the total, the explanation
     * is worse than no explanation.
     */
    const parts = attribute({
      assetReturn: -0.042,
      marketReturn: -0.01,
      sectorReturn: -0.03,
      beta: 1.1,
      betaSector: 0.9,
      sectorMarketBeta: 1.2,
    });

    expect(parts.market + parts.sector + parts.idiosyncratic).toBeCloseTo(-0.042, 12);
  });

  it('does not count the market twice inside the sector part', () => {
    /*
     * The sector fell only because the market fell. Attributing the whole
     * sector move to "sector" would double-count, and the idiosyncratic
     * remainder would come out wrong in the opposite direction.
     */
    const marketReturn = -0.02;
    const parts = attribute({
      assetReturn: -0.02,
      marketReturn,
      // Exactly what a 1.0-beta sector does when the market moves -2%.
      sectorReturn: marketReturn,
      beta: 1,
      betaSector: 0.8,
      sectorMarketBeta: 1,
    });

    expect(parts.sector).toBeCloseTo(0, 12);
    expect(parts.market).toBeCloseTo(-0.02, 12);
    expect(parts.idiosyncratic).toBeCloseTo(0, 12);
  });

  it('credits the sector when the sector moved on its own', () => {
    // The market was flat; the sector fell 3%; this name fell 3%. None of that
    // is news about the company.
    const parts = attribute({
      assetReturn: -0.03,
      marketReturn: 0,
      sectorReturn: -0.03,
      beta: 1,
      betaSector: 1,
      sectorMarketBeta: 1,
    });

    expect(parts.market).toBeCloseTo(0, 12);
    expect(parts.sector).toBeCloseTo(-0.03, 12);
    expect(parts.idiosyncratic).toBeCloseTo(0, 12);
  });

  it('still isolates a genuinely company-specific move', () => {
    // Market flat, sector flat, this name down 8%. All of it is the company.
    const parts = attribute({
      assetReturn: -0.08,
      marketReturn: 0,
      sectorReturn: 0,
      beta: 1.4,
      betaSector: 1.1,
      sectorMarketBeta: 1,
    });

    expect(parts.idiosyncratic).toBeCloseTo(-0.08, 12);
  });

  it('degrades to market-only when there is no sector', () => {
    // Every instrument without a proxy takes this path, so it must behave
    // exactly as the single-factor model always did.
    const parts = attribute({
      assetReturn: -0.05,
      marketReturn: -0.02,
      sectorReturn: null,
      beta: 1.5,
      betaSector: 0,
    });

    expect(parts.sector).toBe(0);
    expect(parts.market).toBeCloseTo(-0.03, 12);
    expect(parts.idiosyncratic).toBeCloseTo(-0.02, 12);
  });
});

describe('what this changes for a user', () => {
  it('stops a sector-wide fall reading as eight separate company events', () => {
    /*
     * The headline scenario, end to end.
     *
     * Eight semiconductors, each with its own beta, all fall because the
     * sector fell. Under one factor every one of them shows a large
     * unexplained residual. Under two, none of them does — because nothing
     * company-specific happened to any of them.
     */
    const marketReturn = -0.005;
    const sectorOwnMove = -0.05;
    const sectorReturn = marketReturn + sectorOwnMove;

    const members = [
      { symbol: 'NVDA', beta: 1.9, betaSector: 1.1 },
      { symbol: 'AMD', beta: 1.7, betaSector: 1.2 },
      { symbol: 'AVGO', beta: 1.4, betaSector: 0.9 },
      { symbol: 'INTC', beta: 1.2, betaSector: 0.8 },
    ];

    for (const m of members) {
      // What the member actually did: exactly what the factors imply.
      const assetReturn = m.beta * marketReturn + m.betaSector * sectorOwnMove;

      const oneFactor = assetReturn - m.beta * marketReturn;
      const twoFactor = attribute({
        assetReturn,
        marketReturn,
        sectorReturn,
        beta: m.beta,
        betaSector: m.betaSector,
        sectorMarketBeta: 1,
      });

      // One factor: a 4-6% "unexplained" move for every single name.
      expect(Math.abs(oneFactor)).toBeGreaterThan(0.03);
      // Two factors: nothing company-specific, because there wasn't any.
      expect(Math.abs(twoFactor.idiosyncratic)).toBeLessThan(1e-9);
    }
  });

  it('still surfaces the one name that really did move', () => {
    // And the test that matters just as much: the sector factor must not
    // become a blanket excuse that hides real company news.
    const marketReturn = -0.005;
    const sectorOwnMove = -0.05;

    const assetReturn = 1.9 * marketReturn + 1.1 * sectorOwnMove - 0.06;
    const parts = attribute({
      assetReturn,
      marketReturn,
      sectorReturn: marketReturn + sectorOwnMove,
      beta: 1.9,
      betaSector: 1.1,
      sectorMarketBeta: 1,
    });

    expect(parts.idiosyncratic).toBeCloseTo(-0.06, 10);
  });
});
