/**
 * Deterministic pseudo-random price paths.
 *
 * The synthetic market feed needs a price function that is:
 *
 *   - continuous in time, so an intraday quote and the day's closing bar are
 *     samples of one path rather than two unrelated random numbers;
 *   - multi-scale, so it has both minute-to-minute chop and month-long trends
 *     (a single-scale random walk looks obviously fake and, worse, produces
 *     volatility statistics that no real detector would ever see);
 *   - stateless and O(1), so any point in the path can be evaluated directly
 *     without replaying history;
 *   - reproducible, so the same seed gives the same market on every run and
 *     a failing test can be re-run.
 *
 * Fractional Brownian motion built from interpolated value noise satisfies all
 * four. It is not a claim about how markets really behave - it is a fixture
 * that is realistic enough to exercise the detectors honestly.
 */

/** 32-bit integer mix (SplitMix-style finaliser). Returns [0, 1). */
function hashToUnit(x: number, seed: number): number {
  let h = (x | 0) ^ (seed | 0);
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  h = h ^ (h >>> 15);
  return (h >>> 0) / 4294967296;
}

/** Hash of two integers, for per-(symbol, session) draws. */
export function hash2(a: number, b: number, seed: number): number {
  return hashToUnit(Math.imul(a | 0, 0x27d4eb2d) ^ (b | 0), seed);
}

/** Stable 32-bit hash of a string, so symbols can seed their own paths. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Standard normal via Box-Muller, from two uniform hashes. */
export function gauss(a: number, b: number, seed: number): number {
  // Guard the log against exactly zero.
  const u1 = Math.max(1e-9, hash2(a, b, seed));
  const u2 = hash2(a, b, seed ^ 0x5bf03635);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Hermite smoothstep - C1 continuous, which keeps the path free of kinks. */
const smoothstep = (t: number): number => t * t * (3 - 2 * t);

/** Value noise in [-1, 1], continuous in `u`. */
function valueNoise(u: number, seed: number): number {
  const i = Math.floor(u);
  const f = u - i;
  const a = hashToUnit(i, seed) * 2 - 1;
  const b = hashToUnit(i + 1, seed) * 2 - 1;
  return a + (b - a) * smoothstep(f);
}

/**
 * Octave periods in sessions. Spanning a single session up to roughly a year
 * is what gives the path both intraday texture and multi-month regimes -
 * and therefore gives `sigmaShort / sigmaDaily` a reason to ever differ,
 * which is the whole basis of volatility-regime detection.
 */
const PERIODS = [0.15, 0.4, 1, 2.6, 6.8, 17.7, 46, 121, 317] as const;

/** Brownian scaling: amplitude grows with the square root of the period. */
const AMPS = PERIODS.map((p) => Math.sqrt(p));

/**
 * Fractional Brownian value at `u`, measured in sessions.
 *
 * Unnormalised: the caller scales by CALIBRATION so that one session of
 * elapsed `u` has unit standard deviation.
 */
export function fbmRaw(u: number, seed: number): number {
  let acc = 0;
  for (let i = 0; i < PERIODS.length; i++) {
    acc += (AMPS[i] as number) * valueNoise(u / (PERIODS[i] as number), seed + i * 7919);
  }
  return acc;
}

/**
 * Scale factor making one session of `fbmRaw` drift have unit variance.
 *
 * Derived by measurement rather than algebra: the closed form for the variance
 * of a sum of interpolated-noise octaves is unpleasant and easy to get subtly
 * wrong, whereas sampling it is exact enough and self-correcting if the octave
 * table above is ever retuned. Computed once, at module load.
 */
export const CALIBRATION: number = (() => {
  const SAMPLES = 4000;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < SAMPLES; i++) {
    // Spread sample points irrationally so they do not align with any octave.
    const u = i * 0.6180339887;
    const d = fbmRaw(u + 1, 12345) - fbmRaw(u, 12345);
    sum += d;
    sumSq += d * d;
  }
  const mean = sum / SAMPLES;
  const variance = sumSq / SAMPLES - mean * mean;
  const sd = Math.sqrt(Math.max(variance, 1e-12));
  return 1 / sd;
})();

/** Normalised path: one unit of `u` is one session of unit-variance drift. */
export function fbm(u: number, seed: number): number {
  return fbmRaw(u, seed) * CALIBRATION;
}
