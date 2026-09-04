/**
 * The episode state machine.
 *
 * This is the single most important piece of the product's *behaviour*, as
 * opposed to its analysis. Without it, a stock that is 3 sigma down and stays
 * there generates one alert per poll - which is to say, several hundred alerts
 * about one event. The user then turns notifications off and the product has
 * failed at the only thing it promised.
 *
 * The mechanism is hysteresis borrowed from control systems: a condition
 * *enters* an episode at one threshold and only *leaves* it at a lower one.
 * The dead band between them absorbs the noise of a value oscillating around a
 * single threshold, which would otherwise open and close episodes on every
 * tick.
 *
 *      value
 *        │        ╭──── in episode ────╮
 *   2.0  ├────────┼────────────────────┼──── enter
 *        │      ╭─╯                    ╰─╮
 *   1.0  ├──────┼────────────────────────┼── exit
 *        │  ╭───╯                        ╰────
 *        └──┴──────────────────────────────────▶ time
 *           ↑ nothing            one signal    ↑ episode closes
 *
 * Three further rules earn their place:
 *
 *  - **Intensification updates in place.** A move deepening from 2.2σ to 4.1σ
 *    revises the existing signal rather than adding a second one, so the
 *    briefing shows the current truth without growing.
 *  - **A changed discriminator starts a new episode**, even mid-episode. A
 *    30-day high becoming a 52-week high is genuinely new information.
 *  - **State is data, not memory.** It is persisted, so a restart does not
 *    re-announce every currently-open episode.
 */

import type { SignalStateRow } from '../../db/signalRepo.js';
import type { Observation } from './detectors.js';

export type EpisodeAction = 'open' | 'intensify' | 'continue' | 'close' | 'reopen' | 'idle';

export interface EpisodeOutcome {
  action: EpisodeAction;
  /** The episode this outcome refers to. Null only for 'idle'. */
  episodeKey: string | null;
  /** The episode being closed, when an action both closes and opens. */
  closingEpisodeKey: string | null;
  /** State to persist. Null means "no state needed; delete or skip". */
  state: SignalStateRow | null;
}

const SEP = '#';

/** Episode keys are `<discriminator>#<openedAt>` - unique, and parseable. */
export function makeEpisodeKey(discriminator: string, openedAt: number): string {
  return `${discriminator}${SEP}${openedAt}`;
}

export function discriminatorOf(episodeKey: string): string {
  const i = episodeKey.lastIndexOf(SEP);
  return i === -1 ? episodeKey : episodeKey.slice(0, i);
}

/**
 * Materially larger, not merely different.
 *
 * Floating-point jitter and a price ticking one cent would otherwise count as
 * intensification and rewrite the signal on every single poll. Requiring a
 * 15% relative increase means the headline only changes when the story does.
 */
function isMaterialIncrease(current: number, peak: number): boolean {
  if (peak <= 0) return current > 0;
  return current > peak * 1.15;
}

/**
 * Advance the state machine by one observation.
 *
 * Pure: takes the prior state and a reading, returns what should happen. All
 * persistence and signal writing is the caller's job, which is what makes the
 * whole behaviour testable by calling this in a loop.
 */
export function step(
  observation: Observation,
  prior: SignalStateRow | null,
  now: number,
): EpisodeOutcome {
  const magnitude = Math.abs(observation.value);
  const inEpisode = prior?.inEpisode === true && prior.episodeKey !== null;

  const base = {
    symbol: '',
    kind: observation.kind,
    updatedAt: now,
    lastValue: observation.value,
  };

  if (!inEpisode) {
    if (magnitude < observation.enter) {
      // Below threshold and not in an episode: nothing to say. Still record
      // the reading so the next step has continuity.
      return {
        action: 'idle',
        episodeKey: null,
        closingEpisodeKey: null,
        state: {
          ...base,
          symbol: prior?.symbol ?? '',
          inEpisode: false,
          episodeKey: null,
          enteredAt: null,
          peakValue: null,
        },
      };
    }

    const episodeKey = makeEpisodeKey(observation.discriminator, now);
    return {
      action: 'open',
      episodeKey,
      closingEpisodeKey: null,
      state: {
        ...base,
        symbol: prior?.symbol ?? '',
        inEpisode: true,
        episodeKey,
        enteredAt: now,
        peakValue: magnitude,
      },
    };
  }

  // ── Currently inside an episode ──────────────────────────────────────
  const currentKey = prior.episodeKey as string;
  const peak = prior.peakValue ?? 0;

  // The situation changed character (e.g. a 30-day break became a 52-week
  // break). Close the old episode and open a new one, so the user gets the
  // new framing rather than a silently-mutated old signal.
  if (discriminatorOf(currentKey) !== observation.discriminator) {
    if (magnitude >= observation.enter) {
      const episodeKey = makeEpisodeKey(observation.discriminator, now);
      return {
        action: 'reopen',
        episodeKey,
        closingEpisodeKey: currentKey,
        state: {
          ...base,
          symbol: prior.symbol,
          inEpisode: true,
          episodeKey,
          enteredAt: now,
          peakValue: magnitude,
        },
      };
    }
    return {
      action: 'close',
      episodeKey: currentKey,
      closingEpisodeKey: currentKey,
      state: {
        ...base,
        symbol: prior.symbol,
        inEpisode: false,
        episodeKey: null,
        enteredAt: null,
        peakValue: null,
      },
    };
  }

  // Dropped below the exit threshold: the episode is over.
  if (magnitude < observation.exit) {
    return {
      action: 'close',
      episodeKey: currentKey,
      closingEpisodeKey: currentKey,
      state: {
        ...base,
        symbol: prior.symbol,
        inEpisode: false,
        episodeKey: null,
        enteredAt: null,
        peakValue: null,
      },
    };
  }

  // Still going, and materially worse than before: revise in place.
  if (isMaterialIncrease(magnitude, peak)) {
    return {
      action: 'intensify',
      episodeKey: currentKey,
      closingEpisodeKey: null,
      state: {
        ...base,
        symbol: prior.symbol,
        inEpisode: true,
        episodeKey: currentKey,
        enteredAt: prior.enteredAt,
        peakValue: magnitude,
      },
    };
  }

  // In the dead band: the condition persists but there is nothing new to say.
  return {
    action: 'continue',
    episodeKey: currentKey,
    closingEpisodeKey: null,
    state: {
      ...base,
      symbol: prior.symbol,
      inEpisode: true,
      episodeKey: currentKey,
      enteredAt: prior.enteredAt,
      peakValue: Math.max(peak, magnitude),
    },
  };
}
