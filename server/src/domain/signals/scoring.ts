/**
 * Ranking: turning a pile of detected signals into a briefing.
 *
 * Detection asks "did something happen?". Ranking asks the harder question:
 * "of the things that happened, which ones does *this person* need to read,
 * and in what order?" A watchlist that surfaces everything it detects has
 * merely relocated the problem - the user still has to scan.
 *
 * Three constraints shape the output:
 *
 *  - **A noise budget.** The briefing is capped. Something that does not fit
 *    is counted, not shown. A list that does not fit on a screen is not a
 *    briefing, it is a feed.
 *  - **A per-symbol cap.** One stock having a dramatic day must not consume
 *    the whole briefing and hide the other nine things that happened.
 *  - **Explainability.** Every ranked item carries the reason it ranked where
 *    it did. If the user cannot tell why they are being shown something, they
 *    stop trusting the ordering, and then the ordering is worthless.
 */

import type { DigestGroup, ScoredSignal, Signal, SignalKind, WatchlistItem } from '../types.js';
import { explainLearnedWeight } from './learning.js';

/**
 * How much each kind of signal is worth, before severity and recency.
 *
 * These are judgement calls, and they are the product's editorial voice:
 *
 *  - `idio_move` outranks `sigma_move` because "something happened to this
 *    company" is more actionable than "this moved, along with everything".
 *  - `stale_data` and `data_conflict` are deliberately high. Being unable to
 *    trust a price is at least as urgent as the price changing, and burying it
 *    below the market noise is how people end up trading on bad data.
 *  - `trend_flip` and `vol_regime` are low per-event but slow-moving, so they
 *    are exactly the things a returning user missed - the recency decay below
 *    treats them gently.
 */
export const KIND_WEIGHT: Record<SignalKind, number> = {
  idio_move: 1.0,
  // High, because it is the one price change that is *not* news and that a
  // naive watchlist reports as a catastrophe. Telling someone their apparent
  // 90% drop was a 10-for-1 split is urgent.
  corporate_action: 0.9,
  sigma_move: 0.85,
  gap: 0.8,
  data_conflict: 0.75,
  stale_data: 0.7,
  range_break: 0.65,
  drawdown: 0.6,
  volume_spike: 0.5,
  vol_regime: 0.45,
  trend_flip: 0.4,
};

/** Slow-moving signals decay more slowly: they stay relevant for days. */
const DECAY_MULTIPLIER: Partial<Record<SignalKind, number>> = {
  trend_flip: 6,
  vol_regime: 4,
  drawdown: 3,
  range_break: 2,
};

export interface ScoringOptions {
  now: number;
  /**
   * Per-kind multipliers learned from this user's dismissals. Absent means
   * "no evidence either way", which is exactly a multiplier of 1.
   */
  learned?: ReadonlyMap<SignalKind, number>;
  /** Half-life of the recency decay, in ms. */
  recencyHalfLifeMs: number;
  maxItems: number;
  maxPerSymbol: number;
}

export interface ScoringInputs {
  signals: readonly Signal[];
  /** Per-symbol preferences: pinned, muted, custom threshold. */
  items: ReadonlyMap<string, WatchlistItem>;
  /** Instrument display names. */
  names: ReadonlyMap<string, string>;
  /** Signals this user has already dismissed individually. */
  readIds: ReadonlySet<string>;
  /** Confidence of the underlying quote, 0..1, per symbol. */
  confidence: ReadonlyMap<string, number>;
}

/**
 * Exponential decay by age. Returns 1.0 for something that just happened.
 *
 * Half-life rather than a linear ramp because relevance genuinely falls off
 * geometrically: a six-hour-old move is much less than half as interesting as
 * a one-hour-old one.
 */
export function recencyFactor(ageMs: number, halfLifeMs: number, multiplier = 1): number {
  if (ageMs <= 0) return 1;
  const hl = Math.max(1, halfLifeMs * multiplier);
  return Math.pow(0.5, ageMs / hl);
}

/** The sigma magnitude a signal represents, if it has one. */
function sigmaOf(signal: Signal): number | null {
  const v = signal.evidence.sigma;
  return typeof v === 'number' && Number.isFinite(v) ? Math.abs(v) : null;
}

export interface ScoreBreakdown {
  score: number;
  rationale: string;
  suppressed: 'muted' | 'below-threshold' | null;
}

/**
 * Score one signal for one reader.
 *
 * Multiplicative rather than additive, deliberately: a muted symbol or a
 * worthless data source should drive the whole score toward zero rather than
 * merely subtracting a constant that a large severity could overcome.
 */
export function scoreSignal(
  signal: Signal,
  item: WatchlistItem | undefined,
  confidence: number,
  opts: ScoringOptions,
): ScoreBreakdown {
  if (item?.muted) {
    return { score: 0, rationale: 'symbol is muted', suppressed: 'muted' };
  }

  // A per-symbol sigma floor: "only tell me about this one if it is big".
  // Applies only to signals that *have* a sigma - it would be wrong to hide a
  // stale-data warning because the user raised their price threshold.
  const sigma = sigmaOf(signal);
  if (item?.minSigma != null && sigma !== null && sigma < item.minSigma) {
    return {
      score: 0,
      rationale: `below your ${item.minSigma}σ threshold for ${signal.symbol}`,
      suppressed: 'below-threshold',
    };
  }

  const baseWeight = KIND_WEIGHT[signal.kind] ?? 0.5;

  /*
   * What this user has told us about this kind.
   *
   * Bounded, and it multiplies - it cannot suppress. A learned preference
   * demotes; only an explicit mute hides. See domain/signals/learning.ts.
   */
  const learned = opts.learned?.get(signal.kind) ?? 1;
  const weight = baseWeight * learned;
  const age = Math.max(0, opts.now - signal.detectedAt);
  const decay = recencyFactor(age, opts.recencyHalfLifeMs, DECAY_MULTIPLIER[signal.kind] ?? 1);

  // Pinned symbols get a genuine boost, not a sort key hack, so a pinned
  // symbol's minor news can still lose to another symbol's major news.
  const pinBoost = item?.pinned ? 1.4 : 1;

  // Low-confidence *market* signals are discounted, because a sigma computed
  // from a disputed price is itself disputed. Integrity signals are exempt:
  // discounting "this data is unreliable" for being unreliable is circular.
  const isIntegrity = signal.kind === 'stale_data' || signal.kind === 'data_conflict';
  const confidenceFactor = isIntegrity ? 1 : 0.35 + 0.65 * clamp01(confidence);

  const score = signal.severity * weight * decay * pinBoost * confidenceFactor;

  const parts: string[] = [];
  if (sigma !== null) parts.push(`${sigma.toFixed(1)}σ`);
  parts.push(`${describeKind(signal.kind)} weight ${baseWeight.toFixed(2)}`);
  // Say so out loud. A ranking that quietly adapts is impossible to argue
  // with; one that states its reason can be corrected by the next click.
  const learnedNote = explainLearnedWeight(learned);
  if (learnedNote) parts.push(learnedNote);
  if (decay < 0.9) parts.push(`${humanAge(age)} old`);
  if (item?.pinned) parts.push('pinned');
  if (!isIntegrity && confidence < 0.9) parts.push(`confidence ${(confidence * 100).toFixed(0)}%`);

  return { score, rationale: parts.join(' · '), suppressed: null };
}

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}

function humanAge(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = m / 60;
  if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0)}h`;
  return `${(h / 24).toFixed(0)}d`;
}

function describeKind(kind: SignalKind): string {
  return kind.replace(/_/g, ' ');
}

export interface RankResult {
  groups: DigestGroup[];
  /** Scored above zero but lost to the noise budget or the per-symbol cap. */
  suppressedCount: number;
  /** Scored zero because the user muted or filtered them. */
  filteredCount: number;
}

/**
 * Rank and group signals into the briefing.
 *
 * Grouping by symbol before applying the budget is what stops one dramatic
 * stock from crowding out everything else: the cap is applied *within* a
 * symbol first, then across symbols.
 */
export function rankSignals(inputs: ScoringInputs, opts: ScoringOptions): RankResult {
  const bySymbol = new Map<string, ScoredSignal[]>();
  let filteredCount = 0;

  for (const signal of inputs.signals) {
    const item = inputs.items.get(signal.symbol);
    const confidence = inputs.confidence.get(signal.symbol) ?? 1;
    const { score, rationale, suppressed } = scoreSignal(signal, item, confidence, opts);

    if (suppressed !== null || score <= 0) {
      filteredCount++;
      continue;
    }

    const scored: ScoredSignal = {
      ...signal,
      score,
      rationale,
      isRead: inputs.readIds.has(signal.id),
    };

    const list = bySymbol.get(signal.symbol);
    if (list) list.push(scored);
    else bySymbol.set(signal.symbol, [scored]);
  }

  let suppressedCount = 0;
  const groups: DigestGroup[] = [];

  for (const [symbol, signals] of bySymbol) {
    signals.sort(bySignalScore);

    // Read signals sink below unread ones of similar importance: having
    // already seen something makes it less urgent, but not irrelevant - it may
    // still be the most important thing about that symbol.
    const kept = signals.slice(0, opts.maxPerSymbol);
    suppressedCount += signals.length - kept.length;

    groups.push({
      symbol,
      name: inputs.names.get(symbol) ?? symbol,
      signals: kept,
      topScore: kept.length > 0 ? (kept[0] as ScoredSignal).score : 0,
    });
  }

  groups.sort((a, b) => b.topScore - a.topScore || a.symbol.localeCompare(b.symbol));

  // Apply the overall budget by counting signals, not groups: ten symbols with
  // one signal each is a reasonable briefing; five with two each is the same
  // amount of reading.
  const budgeted: DigestGroup[] = [];
  let used = 0;
  for (const group of groups) {
    if (used >= opts.maxItems) {
      suppressedCount += group.signals.length;
      continue;
    }
    const room = opts.maxItems - used;
    if (group.signals.length > room) {
      suppressedCount += group.signals.length - room;
      budgeted.push({ ...group, signals: group.signals.slice(0, room) });
      used += room;
    } else {
      budgeted.push(group);
      used += group.signals.length;
    }
  }

  return { groups: budgeted, suppressedCount, filteredCount };
}

function bySignalScore(a: ScoredSignal, b: ScoredSignal): number {
  // Unread first among comparable scores, then by score, then newest.
  if (a.isRead !== b.isRead) return a.isRead ? 1 : -1;
  if (b.score !== a.score) return b.score - a.score;
  return b.detectedAt - a.detectedAt;
}
