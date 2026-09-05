/**
 * Learning from dismissals.
 *
 * Dismissals were recorded and never read, so a user could tell us the same
 * thing a hundred times and be ignored. The risk in fixing that is worse than
 * the bug: a feed that quietly decides what you care about, based on evidence
 * you cannot see, is a feed you cannot trust to have shown you the one that
 * mattered.
 *
 * So most of this file is about the guardrails rather than the learning: it
 * cannot hide anything, it cannot touch integrity warnings, it needs real
 * evidence before it moves, and it can always be reset.
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_LEARNED_WEIGHT,
  MIN_LEARNED_WEIGHT,
  explainLearnedWeight,
  learnedWeight,
  learnedWeights,
  type KindFeedback,
} from '../src/domain/signals/learning.js';
import type { SignalKind } from '../src/domain/types.js';

function fb(kind: SignalKind, dismissed: number, engaged = 0): KindFeedback {
  return { kind, dismissed, engaged };
}

describe('the shape of the adjustment', () => {
  it('does nothing at all without evidence', () => {
    expect(learnedWeight(undefined)).toBe(1);
    expect(learnedWeight(fb('volume_spike', 0, 0))).toBe(1);
  });

  it('barely moves on the first few dismissals', () => {
    /*
     * The first time someone clears a notification they are usually just
     * clearing a notification. Reacting to that is not learning, it is
     * twitching.
     */
    const w = learnedWeight(fb('volume_spike', 3));
    expect(w).toBeLessThan(1);
    expect(w).toBeGreaterThan(0.95);
  });

  it('moves further as the evidence accumulates', () => {
    const three = learnedWeight(fb('volume_spike', 3));
    const ten = learnedWeight(fb('volume_spike', 10));
    const fifty = learnedWeight(fb('volume_spike', 50));

    expect(ten).toBeLessThan(three);
    expect(fifty).toBeLessThan(ten);
  });

  it('never demotes past the floor, however many dismissals', () => {
    // A signal a user has waved away a thousand times is still shown. It
    // ranks lower; it does not vanish.
    const w = learnedWeight(fb('volume_spike', 100_000));
    expect(w).toBeGreaterThanOrEqual(MIN_LEARNED_WEIGHT);
    expect(w).toBeCloseTo(MIN_LEARNED_WEIGHT, 2);
  });

  it('promotes far less readily than it demotes', () => {
    /*
     * Deliberately asymmetric. Demoting something someone keeps dismissing is
     * low-risk. Promoting a kind because they opened it twice is how a feed
     * eats itself and shows you nothing but the thing you clicked yesterday.
     */
    const down = 1 - learnedWeight(fb('volume_spike', 100));
    const up = learnedWeight(fb('volume_spike', 0, 100)) - 1;

    expect(up).toBeGreaterThan(0);
    expect(up).toBeLessThan(down / 2);
    expect(learnedWeight(fb('volume_spike', 0, 100_000))).toBeLessThanOrEqual(MAX_LEARNED_WEIGHT);
  });

  it('treats an even split as no preference', () => {
    // Someone who opens half and dismisses half has told us nothing except
    // that the kind is sometimes useful, which is the default assumption.
    expect(learnedWeight(fb('volume_spike', 25, 25))).toBeCloseTo(1, 6);
  });

  it('lets engagement undo a demotion', () => {
    // The user changed their mind, or the kind became relevant. Twenty
    // dismissals should not be a life sentence.
    const dismissedOnly = learnedWeight(fb('gap', 20, 0));
    const thenEngaged = learnedWeight(fb('gap', 20, 20));

    expect(dismissedOnly).toBeLessThan(0.9);
    expect(thenEngaged).toBeCloseTo(1, 6);
  });
});

describe('what cannot be learned away', () => {
  it('ignores dismissals of integrity warnings', () => {
    /*
     * "This price cannot be trusted" is not a preference. A user who dismisses
     * stale-data warnings is not asking to be kept in the dark the next time
     * their data is actually broken - and that is precisely the moment the
     * ranking must not have quietly deprioritised the warning.
     */
    for (const kind of ['stale_data', 'data_conflict', 'corporate_action'] as SignalKind[]) {
      expect(learnedWeight(fb(kind, 500))).toBe(1);
    }
  });

  it('still learns the ordinary kinds alongside them', () => {
    // The exemption must be surgical, not a blanket switch-off.
    const weights = learnedWeights([
      fb('stale_data', 100),
      fb('volume_spike', 100),
      fb('trend_flip', 100),
    ]);

    expect(weights.has('stale_data')).toBe(false);
    expect(weights.get('volume_spike')).toBeLessThan(0.7);
    expect(weights.get('trend_flip')).toBeLessThan(0.7);
  });
});

describe('the map handed to the scorer', () => {
  it('omits kinds that would not change anything', () => {
    // Keeping the identity out means a caller iterating the map is only ever
    // looking at kinds that genuinely differ.
    const weights = learnedWeights([fb('gap', 0, 0), fb('volume_spike', 40)]);

    expect(weights.has('gap')).toBe(false);
    expect(weights.has('volume_spike')).toBe(true);
  });

  it('is empty for a brand new user', () => {
    expect(learnedWeights([]).size).toBe(0);
  });
});

describe('saying so out loud', () => {
  it('explains a demotion in the user own terms', () => {
    const note = explainLearnedWeight(learnedWeight(fb('volume_spike', 40)));
    expect(note).toMatch(/usually dismiss/);
  });

  it('explains a promotion', () => {
    const note = explainLearnedWeight(learnedWeight(fb('gap', 0, 40)));
    expect(note).toMatch(/usually open/);
  });

  it('says nothing when there is nothing to say', () => {
    // A ranking that quietly adapts is impossible to argue with. One that
    // states its reason can be corrected by the next click - but only if it
    // stays quiet when it has no reason.
    expect(explainLearnedWeight(1)).toBeNull();
    expect(explainLearnedWeight(learnedWeight(fb('gap', 1, 1)))).toBeNull();
  });
});
