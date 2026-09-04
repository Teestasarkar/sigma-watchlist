/**
 * A minimal US equity market calendar.
 *
 * This matters more than it looks. Without it the app commits two classic
 * sins: it polls a closed market every five seconds, and it tells you nothing
 * happened over the weekend as though that were information. Knowing the
 * market is shut lets us say "unchanged since Friday's close" honestly, and
 * lets the scheduler back off by an order of magnitude overnight.
 *
 * Times are handled in US/Eastern via Intl rather than a tz dependency.
 */

const OPEN_MINUTES = 9 * 60 + 30; // 09:30 ET
const CLOSE_MINUTES = 16 * 60; // 16:00 ET

/** Fixed-date US market holidays that need no Easter arithmetic. */
const FIXED_HOLIDAYS = new Set([
  '01-01', // New Year's Day
  '06-19', // Juneteenth
  '07-04', // Independence Day
  '12-25', // Christmas
]);

interface EtParts {
  year: number;
  month: number;
  day: number;
  weekday: number; // 0 = Sunday
  minutes: number; // minutes since ET midnight
}

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  weekday: 'short',
});

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export function etParts(ts: number): EtParts {
  const parts = fmt.formatToParts(new Date(ts));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '0';
  let hour = Number(get('hour'));
  // Intl with hour12:false can emit 24 for midnight in some runtimes.
  if (hour === 24) hour = 0;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    weekday: WEEKDAYS[get('weekday')] ?? 0,
    minutes: hour * 60 + Number(get('minute')),
  };
}

const pad = (n: number): string => String(n).padStart(2, '0');

export function isTradingDay(ts: number): boolean {
  const p = etParts(ts);
  if (p.weekday === 0 || p.weekday === 6) return false;
  return !FIXED_HOLIDAYS.has(`${pad(p.month)}-${pad(p.day)}`);
}

export type MarketPhase = 'pre' | 'open' | 'post' | 'closed';

export function marketPhase(ts: number): MarketPhase {
  if (!isTradingDay(ts)) return 'closed';
  const { minutes } = etParts(ts);
  if (minutes < 4 * 60) return 'closed';
  if (minutes < OPEN_MINUTES) return 'pre';
  if (minutes < CLOSE_MINUTES) return 'open';
  if (minutes < 20 * 60) return 'post';
  return 'closed';
}

export function isMarketOpen(ts: number): boolean {
  return marketPhase(ts) === 'open';
}

/** ET calendar date key, e.g. "2026-09-04". The natural identity for a bar. */
export function sessionKey(ts: number): string {
  const p = etParts(ts);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/**
 * The canonical timestamp for the trading session containing `ts`: 16:00 ET on
 * that ET calendar date.
 *
 * Daily bars are keyed by this rather than by whatever timestamp a provider
 * happened to send. Two providers reporting the same session's close a few
 * seconds apart would otherwise create two bars for one day, which silently
 * doubles the sample count and corrupts every volatility estimate downstream.
 *
 * The UTC offset is derived at `ts` itself. On a DST-transition date that is
 * only wrong if `ts` falls in the small hours before the switch; bars are
 * written at or after the close, so this does not arise in practice.
 */
export function sessionCloseTs(ts: number): number {
  const p = etParts(ts);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, Math.floor(p.minutes / 60), p.minutes % 60);
  // etParts() resolves only to the minute, so `wallAsUtc - ts` carries up to a
  // minute of noise. Zone offsets are whole minutes, so rounding recovers the
  // exact value - without this the returned close would drift by seconds and
  // stop being a stable key.
  const offset = Math.round((wallAsUtc - ts) / 60_000) * 60_000;
  const closeWallAsUtc = Date.UTC(p.year, p.month - 1, p.day, 16, 0, 0, 0);
  return closeWallAsUtc - offset;
}

const DAY_MS = 86_400_000;
const SESSION_MINUTES = CLOSE_MINUTES - OPEN_MINUTES; // 390

/**
 * How many *trading sessions* of risk elapsed between two instants.
 *
 * This is the correct denominator for "is this move unusual". Wall-clock time
 * badly overstates risk across a weekend (a Friday-to-Monday gap is one
 * session of risk, not three days of it) and understates it during a busy
 * hour. We measure by counting open-market minutes and dividing by the length
 * of a session.
 */
export function tradingDaysBetween(from: number, to: number): number {
  if (to <= from) return 0;
  const spanMs = to - from;

  // Beyond a month, the 5/7 weekday ratio is accurate enough and far cheaper
  // than walking the interval.
  if (spanMs > 30 * DAY_MS) return (spanMs / DAY_MS) * (5 / 7);

  const STEP_MS = 5 * 60_000;
  let openMinutes = 0;
  for (let t = from; t < to; t += STEP_MS) {
    const step = Math.min(STEP_MS, to - t);
    if (marketPhase(t) === 'open') openMinutes += step / 60_000;
  }
  return openMinutes / SESSION_MINUTES;
}

/**
 * Fraction of the regular session elapsed at `ts`, clamped to 0..1.
 * Only meaningful during regular trading hours; callers handle other phases.
 */
export function sessionFractionElapsed(ts: number): number {
  const { minutes } = etParts(ts);
  const elapsed = minutes - OPEN_MINUTES;
  if (elapsed <= 0) return 0;
  if (elapsed >= SESSION_MINUTES) return 1;
  return elapsed / SESSION_MINUTES;
}
