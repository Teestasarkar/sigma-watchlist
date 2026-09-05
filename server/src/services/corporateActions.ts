/**
 * Applying splits and dividends.
 *
 * The scenario this exists for: NVIDIA splits 10-for-1 overnight. The price
 * goes from $1,200 to $120. A watchlist that does not know reports a 90%
 * collapse, fires its loudest possible alert, and tells a user their position
 * has been destroyed. It has not; they own ten times as many shares.
 *
 * Two corrections are needed and they are easy to conflate:
 *
 *  1. **Statistics** are fixed by using the provider's adjusted close, which
 *     rescales the whole history. That happens in `computeStats`, not here.
 *  2. **Stored checkpoint prices** are raw prices captured at a moment in
 *     time. Nothing adjusts them retroactively, so they must be rescaled by
 *     hand - exactly once, which is what the `applied` flag guarantees.
 *
 * And then the user is *told*. Silently correcting someone's numbers is only
 * marginally better than silently getting them wrong: they will notice the
 * price halved and want to know why.
 */

import type { CorporateAction, Signal } from '../domain/types.js';
import type { MarketRepo } from '../db/marketRepo.js';
import type { ActionsRepo } from '../db/actionsRepo.js';
import type { SignalRepo } from '../db/signalRepo.js';
import { ProviderRegistry } from '../providers/registry.js';
import { contentId } from '../infra/ids.js';
import { createLogger } from '../infra/logger.js';

const log = createLogger('actions');

export interface ActionOutcome {
  symbol: string;
  recorded: number;
  splitsApplied: number;
  checkpointsRescaled: number;
}

export class CorporateActionService {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly market: MarketRepo,
    private readonly actions: ActionsRepo,
    private readonly signals: SignalRepo,
    private readonly historySessions: number,
  ) {}

  /**
   * Fetch, record and apply anything new for one symbol.
   *
   * Safe to call on every backfill: recording is idempotent on
   * (symbol, ts, kind), and the rescale runs only for splits still flagged
   * unapplied. Applying a 10-for-1 twice would divide by a hundred, so "once"
   * is enforced by the database rather than by remembering.
   */
  async sync(symbol: string, now: number): Promise<ActionOutcome> {
    const outcome: ActionOutcome = {
      symbol,
      recorded: 0,
      splitsApplied: 0,
      checkpointsRescaled: 0,
    };

    let fetched: CorporateAction[] = [];
    try {
      fetched = await this.registry.getCorporateActions(symbol, this.historySessions);
    } catch (err) {
      // Not knowing about a split is bad; failing the whole refresh because we
      // could not ask is worse. The next cycle tries again.
      log.warn('could not fetch corporate actions', {
        symbol,
        err: err instanceof Error ? err.message : String(err),
      });
      return outcome;
    }

    if (fetched.length === 0) return outcome;

    const recorded = await this.actions.record(fetched);
    outcome.recorded = recorded.length;

    for (const split of await this.actions.pendingSplits(symbol)) {
      /*
       * A 10-for-1 split multiplies share count by 10 and divides price by 10,
       * so a checkpoint captured beforehand must be multiplied by
       * denominator/numerator to be comparable with prices after it.
       */
      const factor = split.denominator / split.numerator;
      if (!Number.isFinite(factor) || factor <= 0 || factor === 1) {
        await this.actions.markApplied(split.symbol, split.ts, split.kind);
        continue;
      }

      const rescaled = await this.actions.rescaleMarks(split.symbol, split.ts, factor);
      await this.actions.markApplied(split.symbol, split.ts, split.kind);

      outcome.splitsApplied++;
      outcome.checkpointsRescaled += rescaled;

      await this.announce(split, rescaled, now);

      log.info('applied split', {
        symbol: split.symbol,
        ratio: `${split.numerator}:${split.denominator}`,
        checkpointsRescaled: rescaled,
      });
    }

    return outcome;
  }

  /**
   * Record the split as a signal, so it appears in the briefing.
   *
   * Stamped at the split's own session rather than at `now`, so it sits in the
   * timeline where it happened - and so a user who has already acknowledged
   * past it is not shown it again.
   */
  private async announce(
    split: CorporateAction,
    rescaled: number,
    now: number,
  ): Promise<void> {
    const ratio = `${trim(split.numerator)}-for-${trim(split.denominator)}`;
    const episodeKey = `split:${split.ts}`;

    const signal: Signal = {
      id: contentId(split.symbol, 'corporate_action', episodeKey),
      symbol: split.symbol,
      kind: 'corporate_action',
      episodeKey,
      direction: 'neutral',
      // Deliberately high. This is the one price change that is not news, and
      // a user seeing an unexplained 90% drop needs the explanation urgently.
      severity: 0.8,
      detectedAt: Math.min(split.ts, now),
      asOf: split.ts,
      headline:
        `${split.symbol} split ${ratio}. The price change is mechanical, not a loss` +
        (rescaled > 0 ? ' — your checkpoint has been adjusted.' : '.'),
      evidence: {
        ratio,
        numerator: split.numerator,
        denominator: split.denominator,
        priceFactor: split.denominator / split.numerator,
        effective: split.ts,
        checkpointsRescaled: rescaled,
        note: 'Statistics use split-adjusted prices; this affects stored checkpoints only.',
      },
      supersededAt: null,
    };

    await this.signals.insertIfAbsent(signal);
  }

  /** Recent actions for a symbol, for the detail view. */
  async listFor(symbol: string, limit = 10): Promise<CorporateAction[]> {
    return this.actions.listBySymbol(symbol, limit);
  }

  /**
   * Backfill adjusted closes for bars stored before adjustment existed.
   *
   * Without this, statistics for an instrument seeded by an older build keep
   * using raw closes and silently disagree with everything seeded since.
   */
  async needsAdjustment(symbol: string): Promise<boolean> {
    const bars = await this.market.getBars(symbol, 5);
    return bars.length > 0 && bars.every((b) => b.adjClose === null);
  }
}

/** 10 rather than 10.0, but 1.5 stays 1.5. */
function trim(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '');
}
