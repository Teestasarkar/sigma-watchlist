/**
 * Splits and dividends.
 *
 * The one kind of price change that is *not* news, and the one a naive
 * watchlist reports as a catastrophe. A 10-for-1 split takes NVDA from $1,200
 * to $120 overnight; a product that does not know about it announces a 90%
 * crash, computes a volatility estimate poisoned for a year, and tells the
 * user their checkpoint is down 90%.
 *
 * Two separate corrections are needed, and they are easy to conflate:
 *
 *  1. **Statistics** use the provider's adjusted close, which handles both
 *     splits and dividends automatically. That is a column on `bars`, not this
 *     table.
 *  2. **Stored checkpoint prices** are raw prices captured at a moment in
 *     time, and nothing adjusts them retroactively. They have to be rescaled
 *     by hand, exactly once - which is what this table exists to guarantee.
 */

import type { CorporateAction } from '../domain/types.js';
import { n, nOrNull, type SqlClient } from './sql.js';

type Row = Record<string, unknown>;

const mapAction = (r: Row): CorporateAction => ({
  symbol: r.symbol as string,
  ts: n(r.ts),
  kind: r.kind as CorporateAction['kind'],
  numerator: n(r.numerator),
  denominator: n(r.denominator),
  amount: nOrNull(r.amount),
  detectedAt: n(r.detected_at),
});

export class ActionsRepo {
  constructor(private readonly sql: SqlClient) {}

  /**
   * Record actions we have learned about.
   *
   * `DO NOTHING` on conflict is what makes re-fetching history safe: the same
   * split reported on every poll must not be applied to checkpoints again.
   * Returns only the genuinely new ones.
   */
  async record(actions: readonly CorporateAction[]): Promise<CorporateAction[]> {
    if (actions.length === 0) return [];

    const inserted: CorporateAction[] = [];
    for (const a of actions) {
      const rows = await this.sql.query<Row>(
        `INSERT INTO corporate_actions
           (symbol, ts, kind, numerator, denominator, amount, detected_at, applied)
         VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE)
         ON CONFLICT (symbol, ts, kind) DO NOTHING
         RETURNING symbol, ts, kind, numerator, denominator, amount, detected_at`,
        [a.symbol, a.ts, a.kind, a.numerator, a.denominator, a.amount, a.detectedAt],
      );
      if (rows.length > 0) inserted.push(mapAction(rows[0] as Row));
    }
    return inserted;
  }

  /**
   * Splits recorded but not yet applied to stored checkpoints.
   *
   * Dividends are excluded on purpose: they do move the price, but by an
   * amount that is genuine information rather than a change of units. A
   * checkpoint that predates a dividend is still a correct reference point.
   */
  async pendingSplits(symbol?: string): Promise<CorporateAction[]> {
    const rows = symbol
      ? await this.sql.query<Row>(
          `SELECT * FROM corporate_actions
           WHERE NOT applied AND kind = 'split' AND symbol = $1
           ORDER BY ts`,
          [symbol],
        )
      : await this.sql.query<Row>(
          `SELECT * FROM corporate_actions WHERE NOT applied AND kind = 'split' ORDER BY ts`,
        );
    return rows.map(mapAction);
  }

  async markApplied(symbol: string, ts: number, kind: string): Promise<void> {
    await this.sql.query(
      `UPDATE corporate_actions SET applied = TRUE
       WHERE symbol = $1 AND ts = $2 AND kind = $3`,
      [symbol, ts, kind],
    );
  }

  async listBySymbol(symbol: string, limit = 20): Promise<CorporateAction[]> {
    const rows = await this.sql.query<Row>(
      `SELECT * FROM corporate_actions WHERE symbol = $1 ORDER BY ts DESC LIMIT $2`,
      [symbol, limit],
    );
    return rows.map(mapAction);
  }

  /**
   * Rescale every stored checkpoint price for a symbol.
   *
   * A 10-for-1 split multiplies share count by 10 and divides price by 10, so a
   * checkpoint captured before it must be multiplied by
   * `denominator / numerator` to be comparable with prices after it.
   *
   * Only checkpoints *older than the action* are touched. One taken after the
   * split is already in post-split terms, and rescaling it would introduce
   * exactly the error this is here to remove.
   *
   * Returns how many checkpoints were corrected.
   */
  async rescaleMarks(symbol: string, ts: number, factor: number): Promise<number> {
    if (!(factor > 0) || factor === 1) return 0;
    const rows = await this.sql.query<Row>(
      `UPDATE user_symbol_marks
       SET seen_price      = seen_price * $3,
           prev_seen_price = prev_seen_price * $3
       WHERE symbol = $1 AND seen_at < $2 AND seen_price IS NOT NULL
       RETURNING user_id`,
      [symbol, ts, factor],
    );
    return rows.length;
  }
}
