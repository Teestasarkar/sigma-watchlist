/**
 * Formatting.
 *
 * Two rules run through all of it:
 *
 *  - **null is not zero.** "We don't know" and "nothing changed" are different
 *    answers, and a dash is the honest rendering of the first. Showing 0.00%
 *    for a missing price is the single easiest way to make a market tool lie.
 *  - **Precision follows magnitude.** A $2.34 stock needs cents; a $4,182 one
 *    does not. Fixed decimals everywhere either lose information or invent it.
 */

import type { Freshness, SignalKind } from './types.js';

export const DASH = '—';

export function money(value: number | null | undefined, currency = 'USD'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  const digits = value >= 1000 ? 2 : value >= 1 ? 2 : 4;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

export function pct(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return `${(value * 100).toFixed(digits)}%`;
}

export function signedPct(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  const s = (value * 100).toFixed(digits);
  return `${value > 0 ? '+' : ''}${s}%`;
}

/** Sigma, with its sign - the sign is what says which way the surprise went. */
export function sigma(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(1)}σ`;
}

export function compactNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(
    value,
  );
}

/**
 * Relative time, coarse on purpose.
 *
 * "3 hours ago" is what the user is actually reasoning about; "3h 14m 22s ago"
 * is noise that changes every second and makes the page feel unstable.
 */
export function ago(ts: number | null | undefined, now = Date.now()): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return DASH;
  const ms = now - ts;
  if (ms < 0) return 'just now';
  const s = Math.round(ms / 1000);
  if (s < 45) return 'moments ago';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = ms / 3_600_000;
  if (h < 24) return `${h < 10 ? h.toFixed(1) : Math.round(h)} hours ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return DASH;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(0)}m`;
  return `${(m / 60).toFixed(1)}h`;
}

/** Human labels for signal kinds. The raw enum is not a user-facing string. */
const KIND_LABELS: Record<SignalKind, string> = {
  sigma_move: 'Outsized move',
  idio_move: 'Company-specific move',
  gap: 'Overnight gap',
  range_break: 'Range break',
  volume_spike: 'Volume surge',
  trend_flip: 'Trend change',
  vol_regime: 'Volatility regime',
  drawdown: 'Drawdown',
  stale_data: 'Data gone stale',
  data_conflict: 'Sources disagree',
};

export const kindLabel = (kind: SignalKind): string => KIND_LABELS[kind] ?? kind;

/**
 * One-line explanation of *why this kind of thing matters*.
 *
 * Shown alongside each signal because the whole product rests on the user
 * trusting the ranking, and they cannot trust what they do not understand.
 */
const KIND_WHY: Record<SignalKind, string> = {
  sigma_move: 'Large relative to how much this name normally moves.',
  idio_move: 'The market does not explain this one — something happened here.',
  gap: 'Repriced overnight, so you could not have traded through it.',
  range_break: 'Through a level that has held for a long time.',
  volume_spike: 'Far more shares changing hands than usual for this hour.',
  trend_flip: 'A slow change of direction that is easy to miss day to day.',
  vol_regime: 'This name has become materially riskier than its baseline.',
  drawdown: 'How far it now sits below its own 52-week peak.',
  stale_data: 'We cannot currently price this. Treat the last number with care.',
  data_conflict: 'Our sources disagree on the price by more than tolerance.',
};

export const kindWhy = (kind: SignalKind): string => KIND_WHY[kind] ?? '';

const FRESHNESS_LABELS: Record<Freshness, string> = {
  fresh: 'Live',
  delayed: 'Delayed',
  stale: 'Stale',
  // Not a degradation. There is simply no trading to be behind on.
  closed: 'At the close',
  unknown: 'No data',
};

export const freshnessLabel = (f: Freshness): string => FRESHNESS_LABELS[f];

/**
 * Bucket a sigma into a severity band for colouring.
 *
 * Thresholds match the detectors' enter/exit levels so the visual language and
 * the engine agree: anything the UI paints as "notable" is something the
 * engine would have fired on.
 */
export function sigmaBand(value: number | null | undefined): 'none' | 'low' | 'mid' | 'high' {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'none';
  const a = Math.abs(value);
  if (a >= 3) return 'high';
  if (a >= 2) return 'mid';
  if (a >= 1) return 'low';
  return 'none';
}

export function directionClass(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value === 0) return 'flat';
  return value > 0 ? 'up' : 'down';
}
