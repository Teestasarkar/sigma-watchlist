/**
 * What a user has told us by dismissing things.
 *
 * Dismissals were already being recorded and never read, which is the worst of
 * both worlds: a user could tell us the same thing a hundred times and be
 * ignored. Someone who dismisses every `volume_spike` without ever opening one
 * is not being lazy - they are telling us its weight is wrong *for them*.
 *
 * Four decisions shape this, and each one is a guard against a way that
 * personalisation normally goes wrong.
 *
 * **It adjusts weight, never visibility.** A learned weight multiplies into an
 * existing score; it cannot drive a signal to zero. A system that silently
 * stops showing you things because it inferred you were not interested is a
 * system you cannot trust to have shown you the important one. Muting is a
 * decision the user makes explicitly, and it stays that way.
 *
 * **It needs evidence before it moves.** With three dismissals the multiplier
 * has barely shifted. That is the difference between learning and
 * overreacting: the first time someone clears a notification they are usually
 * just clearing a notification.
 *
 * **It is bounded, and asymmetric.** Down to 0.5, up to 1.15. Demoting
 * something a user keeps waving away is low-risk; promoting a kind because
 * they opened it twice is how a feed eats itself, so the upside is deliberately
 * small.
 *
 * **Integrity signals are exempt.** "This price cannot be trusted" is not a
 * preference. A user who dismisses stale-data warnings is not asking to be
 * kept in the dark the next time their data is broken.
 */

import type { SignalKind } from '../types.js';

/** A running tally per (user, kind). */
export interface KindFeedback {
  kind: SignalKind;
  /** Times a signal of this kind was dismissed individually. */
  dismissed: number;
  /** Times one was opened - the closest thing we have to "this was useful". */
  engaged: number;
}

/**
 * Signals whose weight a user cannot learn away.
 *
 * Both say "you cannot trust what you are looking at", which is exactly the
 * moment personalisation must not intervene.
 */
const NOT_LEARNABLE: ReadonlySet<SignalKind> = new Set<SignalKind>([
  'stale_data',
  'data_conflict',
  'corporate_action',
]);

export const MIN_LEARNED_WEIGHT = 0.5;
export const MAX_LEARNED_WEIGHT = 1.15;

/**
 * How much evidence before the adjustment reaches half its range.
 *
 * Set high on purpose, and a test caught it being too low. The curve it gives:
 *
 *   3 dismissals  -> 0.96   barely a nudge
 *   10            -> 0.88
 *   20            -> 0.80
 *   50            -> 0.69
 *   many          -> 0.50   the floor
 *
 * Three clicks moving the weight 14% - which is what a smaller prior did - is
 * not learning, it is twitching. The first few times someone clears a
 * notification they are usually just clearing a notification, and a ranking
 * that reorganises itself around that will feel erratic long before it feels
 * personalised.
 */
const PRIOR = 30;

/**
 * The multiplier for one kind, given what this user has done with it.
 *
 * The shape is a shrunk dismissal rate. `n / (n + PRIOR)` is the confidence
 * that we have learned anything at all, and it approaches 1 slowly - so the
 * adjustment is proportional to how much the user has actually told us, not
 * to the last thing they did.
 */
export function learnedWeight(feedback: KindFeedback | undefined): number {
  if (!feedback) return 1;
  if (NOT_LEARNABLE.has(feedback.kind)) return 1;

  const dismissed = Math.max(0, feedback.dismissed);
  const engaged = Math.max(0, feedback.engaged);
  const n = dismissed + engaged;
  if (n === 0) return 1;

  // 1 = dismissed everything, 0 = opened everything, 0.5 = no preference.
  const dismissalRate = dismissed / n;
  const confidence = n / (n + PRIOR);

  // Centre on 0.5 so a user who dismisses half and opens half lands on 1.0.
  const signed = (0.5 - dismissalRate) * 2 * confidence;

  const range = signed < 0 ? 1 - MIN_LEARNED_WEIGHT : MAX_LEARNED_WEIGHT - 1;
  return 1 + signed * range;
}

/** Learned multipliers for every kind this user has interacted with. */
export function learnedWeights(
  feedback: readonly KindFeedback[],
): Map<SignalKind, number> {
  const out = new Map<SignalKind, number>();
  for (const f of feedback) {
    const w = learnedWeight(f);
    // Skip the identity so the map stays small and a caller iterating it is
    // only ever looking at kinds that genuinely differ.
    if (Math.abs(w - 1) > 1e-9) out.set(f.kind, w);
  }
  return out;
}

/**
 * A short phrase for the rationale line, or null when there is nothing to say.
 *
 * Shown to the user on purpose. A ranking that quietly adapts is unnerving and
 * impossible to argue with; one that says "you usually dismiss these" is a
 * claim they can check, disagree with, and correct by opening the next one.
 */
export function explainLearnedWeight(weight: number): string | null {
  if (weight < 0.995) return `you usually dismiss these (×${weight.toFixed(2)})`;
  if (weight > 1.005) return `you usually open these (×${weight.toFixed(2)})`;
  return null;
}
