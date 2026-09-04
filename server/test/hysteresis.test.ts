/**
 * The episode state machine.
 *
 * The behaviour under test is the difference between a product people keep and
 * one they mute: a condition that persists must produce one signal, not one
 * per poll.
 */

import { describe, expect, it } from 'vitest';

import { discriminatorOf, makeEpisodeKey, step } from '../src/domain/signals/hysteresis.js';
import type { Observation } from '../src/domain/signals/detectors.js';
import type { SignalStateRow } from '../src/db/signalRepo.js';

function obs(value: number, over: Partial<Observation> = {}): Observation {
  return {
    kind: 'sigma_move',
    value,
    direction: value > 0 ? 'up' : value < 0 ? 'down' : 'neutral',
    severity: Math.min(1, Math.abs(value) / 5),
    headline: `moved ${value}`,
    evidence: { sigma: value },
    enter: 2,
    exit: 1,
    discriminator: 'day1|up',
    ...over,
  };
}

/** Drive a sequence of readings through the machine, as the engine does. */
function run(values: readonly number[], over: Partial<Observation> = {}) {
  let state: SignalStateRow | null = null;
  const actions: string[] = [];
  let t = 1000;

  for (const v of values) {
    const outcome = step(obs(v, over), state, (t += 1000));
    actions.push(outcome.action);
    state = outcome.state ? { ...outcome.state, symbol: 'TEST' } : null;
  }

  return { actions, state };
}

describe('episode lifecycle', () => {
  it('stays silent below the entry threshold', () => {
    const { actions } = run([0.2, 0.9, 1.5, 1.9]);
    expect(actions).toEqual(['idle', 'idle', 'idle', 'idle']);
  });

  it('opens exactly once when the threshold is crossed', () => {
    const { actions } = run([1.0, 2.5, 2.6, 2.4]);
    expect(actions).toEqual(['idle', 'open', 'continue', 'continue']);
    expect(actions.filter((a) => a === 'open')).toHaveLength(1);
  });

  it('does not re-announce a condition that persists', () => {
    // This is the whole point: forty polls of a sustained 3-sigma move must
    // produce exactly one signal.
    const { actions } = run(new Array(40).fill(3) as number[]);
    expect(actions.filter((a) => a === 'open')).toHaveLength(1);
    expect(actions.filter((a) => a === 'intensify')).toHaveLength(0);
  });

  it('closes only after dropping below the exit threshold', () => {
    // The dead band between 2.0 and 1.0 absorbs oscillation.
    const { actions } = run([2.5, 1.8, 1.2, 1.05, 0.9]);
    expect(actions).toEqual(['open', 'continue', 'continue', 'continue', 'close']);
  });

  it('does not flap when a value oscillates around one threshold', () => {
    // Without hysteresis, crossing 2.0 repeatedly would open and close
    // repeatedly. With it, this is one episode.
    const { actions } = run([2.1, 1.9, 2.05, 1.95, 2.2, 1.85]);
    expect(actions.filter((a) => a === 'open')).toHaveLength(1);
    expect(actions.filter((a) => a === 'close')).toHaveLength(0);
  });

  it('can re-open after a genuine close', () => {
    const { actions } = run([2.5, 0.5, 2.8]);
    expect(actions).toEqual(['open', 'close', 'open']);
  });

  it('treats direction symmetrically', () => {
    // The same magnitudes must drive the same transitions whichever way the
    // price moved: a 4-sigma fall is exactly as much news as a 4-sigma rise.
    const magnitudes = [2.5, 3.4, 2.0, 0.5];
    const up = run(magnitudes);
    const down = run(magnitudes.map((v) => -v));

    expect(down.actions).toEqual(up.actions);
    expect(down.actions).toEqual(['open', 'intensify', 'continue', 'close']);
  });
});

describe('intensification', () => {
  it('revises in place when a move gets materially worse', () => {
    const { actions } = run([2.2, 4.5]);
    expect(actions).toEqual(['open', 'intensify']);
  });

  it('ignores noise-level increases', () => {
    // A one-cent tick must not rewrite the headline on every poll.
    const { actions } = run([2.0, 2.05, 2.1, 2.14]);
    expect(actions.filter((a) => a === 'intensify')).toHaveLength(0);
  });

  it('only revises upward, never downward', () => {
    const { actions } = run([4.0, 2.5, 2.2]);
    expect(actions).toEqual(['open', 'continue', 'continue']);
  });

  it('tracks the peak, so a partial retrace does not re-trigger', () => {
    // Down from 5.0 to 3.0 then back to 4.0: still below the peak, so quiet.
    const { actions } = run([5.0, 3.0, 4.0]);
    expect(actions.filter((a) => a === 'intensify')).toHaveLength(0);
  });
});

describe('discriminators', () => {
  it('starts a new episode when the situation changes character', () => {
    let state: SignalStateRow | null = null;

    const first = step(obs(3, { discriminator: '30-day high' }), state, 1000);
    expect(first.action).toBe('open');
    state = { ...(first.state as SignalStateRow), symbol: 'TEST' };

    // Escalating to a 52-week high is fresh news, not a continuation.
    const second = step(obs(3.1, { discriminator: '52-week high' }), state, 2000);
    expect(second.action).toBe('reopen');
    expect(second.closingEpisodeKey).toBe(first.episodeKey);
    expect(second.episodeKey).not.toBe(first.episodeKey);
  });

  it('closes the old episode when the character changes but the level drops', () => {
    let state: SignalStateRow | null = null;
    const first = step(obs(3, { discriminator: 'a' }), state, 1000);
    state = { ...(first.state as SignalStateRow), symbol: 'TEST' };

    const second = step(obs(0.4, { discriminator: 'b' }), state, 2000);
    expect(second.action).toBe('close');
    expect(second.closingEpisodeKey).toBe(first.episodeKey);
  });

  it('round-trips through the episode key', () => {
    const key = makeEpisodeKey('52-week high', 1_700_000_000_000);
    expect(discriminatorOf(key)).toBe('52-week high');
  });

  it('parses a discriminator that itself contains the separator', () => {
    // Keys split on the *last* separator, so a discriminator containing one
    // survives the round trip.
    const key = makeEpisodeKey('a#b#c', 42);
    expect(discriminatorOf(key)).toBe('a#b#c');
  });
});

describe('state persistence', () => {
  it('carries the episode key and peak forward for the next poll', () => {
    const { state } = run([2.5, 3.9]);
    expect(state?.inEpisode).toBe(true);
    expect(state?.peakValue).toBeCloseTo(3.9, 10);
    expect(state?.episodeKey).toBeTruthy();
  });

  it('clears the episode on close, so a restart does not resurrect it', () => {
    const { state } = run([2.5, 0.1]);
    expect(state?.inEpisode).toBe(false);
    expect(state?.episodeKey).toBeNull();
    expect(state?.peakValue).toBeNull();
  });

  it('resuming from persisted state does not re-announce', () => {
    // Simulates a process restart mid-episode: the stored row is reloaded and
    // the next reading must continue, not open.
    const persisted: SignalStateRow = {
      symbol: 'TEST',
      kind: 'sigma_move',
      inEpisode: true,
      episodeKey: makeEpisodeKey('day1|up', 500),
      enteredAt: 500,
      peakValue: 3.4,
      lastValue: 3.4,
      updatedAt: 500,
    };

    expect(step(obs(3.2), persisted, 9999).action).toBe('continue');
  });
});
