/**
 * The running tally of what each user does with each kind of signal.
 *
 * A tally rather than an aggregate over history, deliberately. The history
 * already exists in `signal_reads`; what the scorer needs on every briefing
 * read is one cheap indexed lookup, not a group-by over a table that grows
 * without bound. Counting forward costs one small write per dismissal and
 * turns the read into a primary-key scan.
 */

import type { SignalKind } from '../domain/types.js';
import type { KindFeedback } from '../domain/signals/learning.js';
import { placeholders, type SqlClient } from './sql.js';

type Row = Record<string, unknown>;

export class FeedbackRepo {
  constructor(private readonly sql: SqlClient) {}

  /** Everything we have learned about one user. Small: one row per kind. */
  async forUser(userId: string): Promise<KindFeedback[]> {
    const rows = await this.sql.query<Row>(
      `SELECT kind, dismissed, engaged FROM user_kind_weights WHERE user_id = $1`,
      [userId],
    );
    return rows.map((r) => ({
      kind: r.kind as SignalKind,
      dismissed: Number(r.dismissed ?? 0),
      engaged: Number(r.engaged ?? 0),
    }));
  }

  /**
   * Record dismissals, one increment per kind.
   *
   * Takes counts rather than a list so a user clearing thirty signals at once
   * is one statement per kind rather than thirty.
   */
  async recordDismissals(
    userId: string,
    byKind: ReadonlyMap<SignalKind, number>,
    now: number,
  ): Promise<void> {
    for (const [kind, count] of byKind) {
      if (count <= 0) continue;
      await this.sql.query(
        `INSERT INTO user_kind_weights (user_id, kind, dismissed, engaged, updated_at)
         VALUES ($1, $2, $3, 0, $4)
         ON CONFLICT (user_id, kind) DO UPDATE SET
           dismissed  = user_kind_weights.dismissed + excluded.dismissed,
           updated_at = excluded.updated_at`,
        [userId, kind, count, now],
      );
    }
  }

  /**
   * Record that a user opened a symbol carrying signals of these kinds.
   *
   * The counterweight to dismissals, and it is what stops the model concluding
   * "this kind is noise" when the truth is "this kind is rare". Opening the
   * detail view is the closest observable thing to "that was worth telling me".
   */
  async recordEngagement(
    userId: string,
    kinds: readonly SignalKind[],
    now: number,
  ): Promise<void> {
    const distinct = [...new Set(kinds)];
    for (const kind of distinct) {
      await this.sql.query(
        `INSERT INTO user_kind_weights (user_id, kind, dismissed, engaged, updated_at)
         VALUES ($1, $2, 0, 1, $3)
         ON CONFLICT (user_id, kind) DO UPDATE SET
           engaged    = user_kind_weights.engaged + 1,
           updated_at = excluded.updated_at`,
        [userId, kind, now],
      );
    }
  }

  /**
   * Forget everything learned for a user.
   *
   * Not administrative tidiness - it is the escape hatch. Inferred preferences
   * a user cannot inspect and reset are a trap, so the UI exposes this.
   */
  async reset(userId: string): Promise<number> {
    const rows = await this.sql.query<Row>(
      `DELETE FROM user_kind_weights WHERE user_id = $1 RETURNING kind`,
      [userId],
    );
    return rows.length;
  }

  /** Kinds for a set of signal ids, so a dismissal can be counted by kind. */
  async kindsOf(signalIds: readonly string[]): Promise<Map<string, SignalKind>> {
    if (signalIds.length === 0) return new Map();
    const rows = await this.sql.query<Row>(
      `SELECT id, kind FROM signals WHERE id IN (${placeholders(signalIds.length)})`,
      signalIds as string[],
    );
    return new Map(rows.map((r) => [r.id as string, r.kind as SignalKind]));
  }
}
