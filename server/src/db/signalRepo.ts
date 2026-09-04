/**
 * Persistence for detected signals and the hysteresis state that
 * de-duplicates them.
 *
 * Two ideas here carry most of the weight:
 *
 *  1. Signals are global. Detection runs once per symbol, not once per
 *     (user, symbol). Ten thousand people watching AAPL share one row.
 *
 *  2. `signal_state` is persisted, not in-memory. In memory, a restart would
 *     forget which episodes were open and re-announce every currently
 *     elevated symbol - turning a deploy into a notification storm.
 */

import type { Signal, SignalKind } from '../domain/types.js';
import { batchList } from '../infra/chunk.js';
import { b, json, n, nOrNull, placeholders, type SqlClient } from './sql.js';

export interface SignalStateRow {
  symbol: string;
  kind: SignalKind;
  inEpisode: boolean;
  episodeKey: string | null;
  enteredAt: number | null;
  peakValue: number | null;
  lastValue: number | null;
  updatedAt: number;
}

type Row = Record<string, unknown>;

const mapSignal = (r: Row): Signal => ({
  id: r.id as string,
  symbol: r.symbol as string,
  kind: r.kind as SignalKind,
  episodeKey: r.episode_key as string,
  direction: r.direction as Signal['direction'],
  severity: n(r.severity),
  detectedAt: n(r.detected_at),
  asOf: n(r.as_of),
  headline: r.headline as string,
  evidence: json<Signal['evidence']>(r.evidence, {}),
  supersededAt: nOrNull(r.superseded_at),
});

const mapState = (r: Row): SignalStateRow => ({
  symbol: r.symbol as string,
  kind: r.kind as SignalKind,
  inEpisode: b(r.in_episode),
  episodeKey: (r.episode_key as string | null) ?? null,
  enteredAt: nOrNull(r.entered_at),
  peakValue: nOrNull(r.peak_value),
  lastValue: nOrNull(r.last_value),
  updatedAt: n(r.updated_at),
});

const COLS = `id, symbol, kind, episode_key, direction, severity,
              detected_at, as_of, headline, evidence, superseded_at`;

export class SignalRepo {
  constructor(private readonly sql: SqlClient) {}

  // ───────────────────────────────────────────────────────── writes

  /**
   * Insert a signal, or do nothing if one already exists for this
   * (symbol, kind, episode).
   *
   * Returns true only on a genuine first insert. Callers use that to decide
   * whether anything actually happened, which is what makes the detection
   * cycle safely re-runnable: a crash mid-cycle, a duplicate tick, or two
   * workers racing all converge on one row and one notification.
   */
  async insertIfAbsent(s: Signal): Promise<boolean> {
    const rows = await this.sql.query<Row>(
      `INSERT INTO signals (${COLS})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,NULL)
       ON CONFLICT (symbol, kind, episode_key) DO NOTHING
       RETURNING id`,
      [
        s.id,
        s.symbol,
        s.kind,
        s.episodeKey,
        s.direction,
        s.severity,
        s.detectedAt,
        s.asOf,
        s.headline,
        JSON.stringify(s.evidence),
      ],
    );
    return rows.length > 0;
  }

  /**
   * Revise an open episode's signal upward.
   *
   * Used when a move *intensifies* within an episode: the reader should see
   * "down 4.1 sigma", not the stale 2.2 sigma from when it opened. We update
   * rather than insert so it stays one item in the briefing.
   *
   * `detected_at` is deliberately left untouched. Bumping it would let an old
   * signal leapfrog a reader's watermark and reappear as though it were new.
   */
  async intensify(
    symbol: string,
    kind: SignalKind,
    episodeKey: string,
    patch: { severity: number; headline: string; evidence: Signal['evidence']; asOf: number },
  ): Promise<boolean> {
    const rows = await this.sql.query<Row>(
      `UPDATE signals
       SET severity = $4, headline = $5, evidence = $6::jsonb, as_of = $7
       WHERE symbol = $1 AND kind = $2 AND episode_key = $3
         -- Only ever revise upward, and never on stale market data.
         AND $4 > severity AND $7 >= as_of
       RETURNING id`,
      [
        symbol,
        kind,
        episodeKey,
        patch.severity,
        patch.headline,
        JSON.stringify(patch.evidence),
        patch.asOf,
      ],
    );
    return rows.length > 0;
  }

  /** Close out an episode's signal when the condition subsides. */
  async supersede(
    symbol: string,
    kind: SignalKind,
    episodeKey: string,
    at: number,
  ): Promise<void> {
    await this.sql.query(
      `UPDATE signals SET superseded_at = $4
       WHERE symbol = $1 AND kind = $2 AND episode_key = $3 AND superseded_at IS NULL`,
      [symbol, kind, episodeKey, at],
    );
  }

  // ───────────────────────────────────────────────────────── reads

  /**
   * The digest query: signals for a set of symbols detected after a cutoff.
   *
   * Served by idx_signals_symbol_time. `limit` is a safety valve - someone
   * returning after three months must not be able to pull tens of thousands
   * of rows into memory just for the ranking to discard them.
   */
  async getSignalsSince(
    symbols: readonly string[],
    since: number,
    limit = 600,
  ): Promise<Signal[]> {
    const rows = await batchList(
      symbols,
      async (batch) =>
        this.sql.query<Row>(
          `SELECT ${COLS} FROM signals
           WHERE symbol IN (${placeholders(batch.length, 3)})
             AND detected_at > $1
           ORDER BY detected_at DESC
           LIMIT $2`,
          [since, limit, ...batch],
        ),
      3,
    );
    return rows.map(mapSignal);
  }

  /** Recent history for one symbol, for the detail-view timeline. */
  async listBySymbol(symbol: string, limit = 40): Promise<Signal[]> {
    const rows = await this.sql.query<Row>(
      `SELECT ${COLS} FROM signals WHERE symbol = $1 ORDER BY detected_at DESC LIMIT $2`,
      [symbol, limit],
    );
    return rows.map(mapSignal);
  }

  /** How many episodes are currently open per symbol, for the list badges. */
  async countOpenBySymbol(symbols: readonly string[]): Promise<Map<string, number>> {
    const rows = await batchList(
      symbols,
      async (batch) =>
        this.sql.query<Row>(
          `SELECT symbol, COUNT(*) AS c FROM signals
           WHERE symbol IN (${placeholders(batch.length)}) AND superseded_at IS NULL
           GROUP BY symbol`,
          batch as string[],
        ),
      1,
    );
    return new Map(rows.map((r) => [r.symbol as string, n(r.c)]));
  }

  async getById(id: string): Promise<Signal | null> {
    const r = await this.sql.one<Row>(`SELECT ${COLS} FROM signals WHERE id = $1`, [id]);
    return r ? mapSignal(r) : null;
  }

  /** Ids that exist, for validating a bulk "mark read" request. */
  async existingIds(ids: readonly string[]): Promise<Set<string>> {
    const rows = await batchList(
      ids,
      async (batch) =>
        this.sql.query<Row>(
          `SELECT id FROM signals WHERE id IN (${placeholders(batch.length)})`,
          batch as string[],
        ),
      1,
    );
    return new Set(rows.map((r) => r.id as string));
  }

  // ───────────────────────────────────────────────────────── hysteresis state

  async getState(symbol: string, kind: SignalKind): Promise<SignalStateRow | null> {
    const r = await this.sql.one<Row>(
      `SELECT * FROM signal_state WHERE symbol = $1 AND kind = $2`,
      [symbol, kind],
    );
    return r ? mapState(r) : null;
  }

  /** All hysteresis rows for a symbol, so a detection cycle reads them once. */
  async getStates(symbol: string): Promise<Map<SignalKind, SignalStateRow>> {
    const rows = await this.sql.query<Row>(`SELECT * FROM signal_state WHERE symbol = $1`, [
      symbol,
    ]);
    return new Map(rows.map((r) => [r.kind as SignalKind, mapState(r)]));
  }

  async putState(s: SignalStateRow): Promise<void> {
    await this.sql.query(
      `INSERT INTO signal_state
         (symbol, kind, in_episode, episode_key, entered_at, peak_value, last_value, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (symbol, kind) DO UPDATE SET
         in_episode  = excluded.in_episode,
         episode_key = excluded.episode_key,
         entered_at  = excluded.entered_at,
         peak_value  = excluded.peak_value,
         last_value  = excluded.last_value,
         updated_at  = excluded.updated_at`,
      [
        s.symbol,
        s.kind,
        s.inEpisode,
        s.episodeKey,
        s.enteredAt,
        s.peakValue,
        s.lastValue,
        s.updatedAt,
      ],
    );
  }

  /** Write several state rows in one statement - a cycle updates many kinds. */
  async putStates(states: readonly SignalStateRow[]): Promise<void> {
    if (states.length === 0) return;
    const N = 8;
    const tuples: string[] = [];
    const params: unknown[] = [];
    states.forEach((s, i) => {
      const base = i * N;
      tuples.push(
        `($${base + 1}::text, $${base + 2}::text, $${base + 3}::boolean, $${base + 4}::text,` +
          ` $${base + 5}::bigint, $${base + 6}::double precision,` +
          ` $${base + 7}::double precision, $${base + 8}::bigint)`,
      );
      params.push(
        s.symbol,
        s.kind,
        s.inEpisode,
        s.episodeKey,
        s.enteredAt,
        s.peakValue,
        s.lastValue,
        s.updatedAt,
      );
    });

    await this.sql.query(
      `INSERT INTO signal_state
         (symbol, kind, in_episode, episode_key, entered_at, peak_value, last_value, updated_at)
       VALUES ${tuples.join(', ')}
       ON CONFLICT (symbol, kind) DO UPDATE SET
         in_episode  = excluded.in_episode,
         episode_key = excluded.episode_key,
         entered_at  = excluded.entered_at,
         peak_value  = excluded.peak_value,
         last_value  = excluded.last_value,
         updated_at  = excluded.updated_at`,
      params,
    );
  }

  // ───────────────────────────────────────────────────────── retention

  /**
   * Signals are an append-only log, so they need a retention policy or the
   * table grows without bound. Anything older than the maximum digest lookback
   * can never be shown again, so it can go.
   */
  async pruneBefore(cutoff: number): Promise<number> {
    const rows = await this.sql.query<Row>(
      `DELETE FROM signals WHERE detected_at < $1 AND superseded_at IS NOT NULL RETURNING id`,
      [cutoff],
    );
    return rows.length;
  }

  async countAll(): Promise<number> {
    const r = await this.sql.one<Row>(`SELECT COUNT(*) AS c FROM signals`);
    return n(r?.c);
  }
}
