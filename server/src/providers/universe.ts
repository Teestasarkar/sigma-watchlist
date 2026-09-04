/**
 * The instrument universe for the simulated feed.
 *
 * The spread of volatilities here is deliberate and is the point of the whole
 * exercise. A watchlist that ranks by percentage change will always put GME
 * and MSTR at the top and never mention NEE, because the meme stock moves 6%
 * on a quiet Tuesday and the utility moves 0.7% on the day it cuts its
 * dividend. Normalising by each instrument's own volatility inverts that: a
 * 2% move in NEE is a genuine 3-sigma event worth reading about, and a 5% move
 * in GME is a Tuesday.
 *
 * Sector membership matters for the same reason. It lets the engine tell "your
 * bank moved because all banks moved" apart from "your bank moved".
 *
 * All prices and statistics produced from this table are SIMULATED. The
 * tickers are real so the demo reads naturally; the data is not, and the API
 * labels every quote with its source so nothing can be mistaken for a real
 * market feed.
 */

export interface UniverseEntry {
  symbol: string;
  name: string;
  sector: string;
  /** Starting price at the beginning of generated history. */
  basePrice: number;
  /** Target annualised volatility. Drives everything about how it behaves. */
  annualVol: number;
  /** Sensitivity to the market factor. */
  beta: number;
  /** Sensitivity to its sector factor. */
  sectorBeta: number;
  /** Annualised drift. */
  drift: number;
  /** Typical daily share volume. */
  baseVolume: number;
  /** Probability per session of a news-driven jump. */
  jumpProb: number;
  /** Typical jump size as a fraction. */
  jumpScale: number;
}

/** The benchmark. Beta is measured against this, so it is (almost) pure factor. */
export const BENCHMARK: UniverseEntry = {
  symbol: 'SPY',
  name: 'S&P 500 Index ETF',
  sector: 'Index',
  basePrice: 505,
  annualVol: 0.14,
  beta: 1,
  sectorBeta: 0,
  drift: 0.07,
  baseVolume: 75_000_000,
  jumpProb: 0.004,
  jumpScale: 0.015,
};

export const UNIVERSE: UniverseEntry[] = [
  // ── Mega-cap technology: moderate vol, high beta ─────────────────────
  { symbol: 'AAPL',  name: 'Apple Inc.',                sector: 'Technology', basePrice: 224,  annualVol: 0.25, beta: 1.10, sectorBeta: 0.55, drift: 0.11,  baseVolume: 55_000_000, jumpProb: 0.014, jumpScale: 0.030 },
  { symbol: 'MSFT',  name: 'Microsoft Corp.',           sector: 'Technology', basePrice: 428,  annualVol: 0.23, beta: 1.05, sectorBeta: 0.50, drift: 0.13,  baseVolume: 22_000_000, jumpProb: 0.012, jumpScale: 0.028 },
  { symbol: 'GOOGL', name: 'Alphabet Inc. Class A',     sector: 'Technology', basePrice: 168,  annualVol: 0.28, beta: 1.08, sectorBeta: 0.52, drift: 0.10,  baseVolume: 26_000_000, jumpProb: 0.015, jumpScale: 0.034 },
  { symbol: 'AMZN',  name: 'Amazon.com Inc.',           sector: 'Consumer',   basePrice: 186,  annualVol: 0.30, beta: 1.20, sectorBeta: 0.40, drift: 0.12,  baseVolume: 41_000_000, jumpProb: 0.016, jumpScale: 0.036 },
  { symbol: 'META',  name: 'Meta Platforms Inc.',       sector: 'Technology', basePrice: 512,  annualVol: 0.36, beta: 1.25, sectorBeta: 0.48, drift: 0.14,  baseVolume: 15_000_000, jumpProb: 0.020, jumpScale: 0.048 },

  // ── Semiconductors: high vol, very high beta, tight sector coupling ──
  { symbol: 'NVDA',  name: 'NVIDIA Corp.',              sector: 'Semis',      basePrice: 118,  annualVol: 0.52, beta: 1.75, sectorBeta: 0.70, drift: 0.28,  baseVolume: 290_000_000, jumpProb: 0.026, jumpScale: 0.062 },
  { symbol: 'AMD',   name: 'Advanced Micro Devices',    sector: 'Semis',      basePrice: 148,  annualVol: 0.48, beta: 1.70, sectorBeta: 0.75, drift: 0.09,  baseVolume: 52_000_000, jumpProb: 0.024, jumpScale: 0.058 },
  { symbol: 'AVGO',  name: 'Broadcom Inc.',             sector: 'Semis',      basePrice: 168,  annualVol: 0.38, beta: 1.40, sectorBeta: 0.68, drift: 0.18,  baseVolume: 24_000_000, jumpProb: 0.018, jumpScale: 0.044 },
  { symbol: 'INTC',  name: 'Intel Corp.',               sector: 'Semis',      basePrice: 22,   annualVol: 0.45, beta: 1.25, sectorBeta: 0.60, drift: -0.12, baseVolume: 88_000_000, jumpProb: 0.022, jumpScale: 0.055 },

  // ── High-volatility names: percentage change tells you nothing here ──
  { symbol: 'TSLA',  name: 'Tesla Inc.',                sector: 'Consumer',   basePrice: 248,  annualVol: 0.58, beta: 1.60, sectorBeta: 0.30, drift: 0.06,  baseVolume: 98_000_000, jumpProb: 0.030, jumpScale: 0.070 },
  { symbol: 'COIN',  name: 'Coinbase Global Inc.',      sector: 'Crypto',     basePrice: 208,  annualVol: 0.85, beta: 2.10, sectorBeta: 0.85, drift: 0.10,  baseVolume: 12_000_000, jumpProb: 0.038, jumpScale: 0.095 },
  { symbol: 'MSTR',  name: 'MicroStrategy Inc.',        sector: 'Crypto',     basePrice: 142,  annualVol: 1.05, beta: 2.40, sectorBeta: 0.95, drift: 0.15,  baseVolume: 18_000_000, jumpProb: 0.042, jumpScale: 0.110 },
  { symbol: 'GME',   name: 'GameStop Corp.',            sector: 'Consumer',   basePrice: 23,   annualVol: 0.95, beta: 0.90, sectorBeta: 0.15, drift: -0.05, baseVolume: 9_000_000,  jumpProb: 0.045, jumpScale: 0.120 },

  // ── Financials ───────────────────────────────────────────────────────
  { symbol: 'JPM',   name: 'JPMorgan Chase & Co.',      sector: 'Financials', basePrice: 212,  annualVol: 0.22, beta: 1.05, sectorBeta: 0.72, drift: 0.10,  baseVolume: 9_500_000,  jumpProb: 0.010, jumpScale: 0.026 },
  { symbol: 'GS',    name: 'Goldman Sachs Group',       sector: 'Financials', basePrice: 498,  annualVol: 0.26, beta: 1.20, sectorBeta: 0.78, drift: 0.11,  baseVolume: 2_400_000,  jumpProb: 0.012, jumpScale: 0.030 },
  { symbol: 'BAC',   name: 'Bank of America Corp.',     sector: 'Financials', basePrice: 40,   annualVol: 0.25, beta: 1.15, sectorBeta: 0.80, drift: 0.07,  baseVolume: 38_000_000, jumpProb: 0.011, jumpScale: 0.028 },

  // ── Energy ───────────────────────────────────────────────────────────
  { symbol: 'XOM',   name: 'Exxon Mobil Corp.',         sector: 'Energy',     basePrice: 118,  annualVol: 0.24, beta: 0.72, sectorBeta: 0.85, drift: 0.06,  baseVolume: 17_000_000, jumpProb: 0.010, jumpScale: 0.026 },
  { symbol: 'CVX',   name: 'Chevron Corp.',             sector: 'Energy',     basePrice: 152,  annualVol: 0.23, beta: 0.75, sectorBeta: 0.86, drift: 0.05,  baseVolume: 8_600_000,  jumpProb: 0.010, jumpScale: 0.025 },

  // ── Healthcare ───────────────────────────────────────────────────────
  { symbol: 'JNJ',   name: 'Johnson & Johnson',         sector: 'Healthcare', basePrice: 158,  annualVol: 0.16, beta: 0.58, sectorBeta: 0.62, drift: 0.05,  baseVolume: 7_100_000,  jumpProb: 0.008, jumpScale: 0.024 },
  { symbol: 'UNH',   name: 'UnitedHealth Group',        sector: 'Healthcare', basePrice: 552,  annualVol: 0.24, beta: 0.68, sectorBeta: 0.58, drift: 0.08,  baseVolume: 3_300_000,  jumpProb: 0.014, jumpScale: 0.042 },
  { symbol: 'PFE',   name: 'Pfizer Inc.',               sector: 'Healthcare', basePrice: 28,   annualVol: 0.26, beta: 0.62, sectorBeta: 0.66, drift: -0.04, baseVolume: 34_000_000, jumpProb: 0.014, jumpScale: 0.036 },

  // ── Consumer staples: the quiet ones ─────────────────────────────────
  { symbol: 'KO',    name: 'Coca-Cola Co.',             sector: 'Staples',    basePrice: 70,   annualVol: 0.14, beta: 0.52, sectorBeta: 0.70, drift: 0.05,  baseVolume: 14_000_000, jumpProb: 0.006, jumpScale: 0.020 },
  { symbol: 'PG',    name: 'Procter & Gamble Co.',      sector: 'Staples',    basePrice: 172,  annualVol: 0.13, beta: 0.48, sectorBeta: 0.72, drift: 0.05,  baseVolume: 6_800_000,  jumpProb: 0.006, jumpScale: 0.019 },
  { symbol: 'WMT',   name: 'Walmart Inc.',              sector: 'Staples',    basePrice: 78,   annualVol: 0.18, beta: 0.60, sectorBeta: 0.55, drift: 0.11,  baseVolume: 17_000_000, jumpProb: 0.009, jumpScale: 0.028 },
  { symbol: 'MCD',   name: "McDonald's Corp.",          sector: 'Consumer',   basePrice: 292,  annualVol: 0.16, beta: 0.62, sectorBeta: 0.45, drift: 0.07,  baseVolume: 3_100_000,  jumpProb: 0.008, jumpScale: 0.022 },

  // ── Utilities: lowest vol in the universe. 2% here is a real event. ──
  { symbol: 'NEE',   name: 'NextEra Energy Inc.',       sector: 'Utilities',  basePrice: 78,   annualVol: 0.20, beta: 0.55, sectorBeta: 0.80, drift: 0.04,  baseVolume: 11_000_000, jumpProb: 0.008, jumpScale: 0.026 },
  { symbol: 'DUK',   name: 'Duke Energy Corp.',         sector: 'Utilities',  basePrice: 112,  annualVol: 0.15, beta: 0.42, sectorBeta: 0.84, drift: 0.03,  baseVolume: 3_400_000,  jumpProb: 0.006, jumpScale: 0.020 },
  { symbol: 'SO',    name: 'Southern Co.',              sector: 'Utilities',  basePrice: 88,   annualVol: 0.14, beta: 0.40, sectorBeta: 0.85, drift: 0.03,  baseVolume: 4_200_000,  jumpProb: 0.006, jumpScale: 0.018 },
];

export const ALL_ENTRIES: UniverseEntry[] = [BENCHMARK, ...UNIVERSE];

const BY_SYMBOL = new Map(ALL_ENTRIES.map((e) => [e.symbol, e]));

export function findEntry(symbol: string): UniverseEntry | undefined {
  return BY_SYMBOL.get(symbol.toUpperCase());
}

/** The default watchlist: a deliberately mixed-volatility starter set. */
export const STARTER_SYMBOLS = [
  'NVDA',
  'AAPL',
  'MSFT',
  'TSLA',
  'JPM',
  'XOM',
  'KO',
  'NEE',
  'GME',
  'UNH',
];

export const SECTORS = [...new Set(ALL_ENTRIES.map((e) => e.sector))];
