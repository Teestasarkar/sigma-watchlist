/**
 * Persistence for users, sessions, watchlists and - most importantly - the
 * per-user watermarks that make "what changed since I last looked" answerable.
 */

import type { SymbolMark, User, Watchlist, WatchlistItem } from '../domain/types.js';
import { shortId } from '../infra/ids.js';
import { batchMap, chunk, MAX_BIND_PARAMS } from '../infra/chunk.js';
import { b, n, nOrNull, placeholders, type SqlClient } from './sql.js';

export class ConcurrencyError extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`watchlist was modified elsewhere (expected version ${expected}, found ${actual})`);
    this.name = 'ConcurrencyError';
  }
}

export class LimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LimitError';
  }
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = 'NotFoundError';
  }
}

type Row = Record<string, unknown>;

const mapUser = (r: Row): User => ({
  id: r.id as string,
  handle: r.handle as string,
  createdAt: n(r.created_at),
});

const mapWatchlist = (r: Row): Watchlist => ({
  id: r.id as string,
  userId: r.user_id as string,
  name: r.name as string,
  createdAt: n(r.created_at),
  version: n(r.version),
});

const mapItem = (r: Row): WatchlistItem => ({
  symbol: r.symbol as string,
  addedAt: n(r.added_at),
  pinned: b(r.pinned),
  muted: b(r.muted),
  minSigma: nOrNull(r.min_sigma),
  note: (r.note as string | null) ?? null,
  sortKey: n(r.sort_key),
});

export class UserRepo {
  constructor(private readonly sql: SqlClient) {}

  // ───────────────────────────────────────────────────────── users

  async createUser(handle: string, now: number): Promise<User> {
    const id = shortId('usr');
    await this.sql.query(`INSERT INTO users (id, handle, created_at) VALUES ($1, $2, $3)`, [
      id,
      handle,
      now,
    ]);
    return { id, handle, createdAt: now };
  }

  async findUserByHandle(handle: string): Promise<User | null> {
    const r = await this.sql.one<Row>(`SELECT * FROM users WHERE handle = $1`, [handle]);
    return r ? mapUser(r) : null;
  }

  async getUser(id: string): Promise<User | null> {
    const r = await this.sql.one<Row>(`SELECT * FROM users WHERE id = $1`, [id]);
    return r ? mapUser(r) : null;
  }

  // ───────────────────────────────────────────────────────── sessions

  async createSession(userId: string, now: number): Promise<string> {
    const token = shortId('ses');
    await this.sql.query(
      `INSERT INTO sessions (token, user_id, created_at, last_seen_at) VALUES ($1, $2, $3, $3)`,
      [token, userId, now],
    );
    return token;
  }

  /**
   * Resolve a bearer token to its user.
   *
   * `last_seen_at` is refreshed in the same statement via a CTE so that
   * authentication costs one round trip rather than two - it is on every
   * single request.
   */
  async resolveSession(token: string, now: number): Promise<User | null> {
    const r = await this.sql.one<Row>(
      `WITH touched AS (
         UPDATE sessions SET last_seen_at = $2 WHERE token = $1 RETURNING user_id
       )
       SELECT u.* FROM users u JOIN touched t ON t.user_id = u.id`,
      [token, now],
    );
    return r ? mapUser(r) : null;
  }

  // ───────────────────────────────────────────────────────── watchlists

  async createWatchlist(
    userId: string,
    name: string,
    now: number,
    maxPerUser: number,
  ): Promise<Watchlist> {
    return this.sql.tx(async () => {
      const c = await this.sql.one<Row>(`SELECT COUNT(*) AS c FROM watchlists WHERE user_id = $1`, [
        userId,
      ]);
      if (n(c?.c) >= maxPerUser) throw new LimitError(`watchlist limit reached (${maxPerUser})`);

      const id = shortId('wl');
      await this.sql.query(
        `INSERT INTO watchlists (id, user_id, name, created_at, version) VALUES ($1,$2,$3,$4,1)`,
        [id, userId, name, now],
      );
      return { id, userId, name, createdAt: now, version: 1 };
    });
  }

  async listWatchlists(userId: string): Promise<Watchlist[]> {
    const rows = await this.sql.query<Row>(
      `SELECT * FROM watchlists WHERE user_id = $1 ORDER BY created_at, id`,
      [userId],
    );
    return rows.map(mapWatchlist);
  }

  async getWatchlist(id: string, userId: string): Promise<Watchlist | null> {
    const r = await this.sql.one<Row>(`SELECT * FROM watchlists WHERE id = $1 AND user_id = $2`, [
      id,
      userId,
    ]);
    return r ? mapWatchlist(r) : null;
  }

  async renameWatchlist(
    id: string,
    userId: string,
    name: string,
    expectedVersion: number | null,
  ): Promise<Watchlist> {
    return this.sql.tx(async () => {
      await this.requireOwned(id, userId, expectedVersion);
      await this.sql.query(`UPDATE watchlists SET name = $1 WHERE id = $2`, [name, id]);
      return this.bump(id);
    });
  }

  async deleteWatchlist(id: string, userId: string): Promise<boolean> {
    const rows = await this.sql.query<Row>(
      `DELETE FROM watchlists WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, userId],
    );
    return rows.length > 0;
  }

  /**
   * Verify ownership and, if the caller supplied a version, that nobody else
   * changed the list since they read it.
   *
   * `FOR UPDATE` is what makes the check meaningful rather than decorative:
   * without the row lock, two requests could both read version 4, both pass
   * the check, and both write - which is exactly the lost update the version
   * column exists to prevent. Passing null opts out of the check, which is
   * what a client with no version yet does.
   */
  private async requireOwned(
    id: string,
    userId: string,
    expectedVersion: number | null,
  ): Promise<Watchlist> {
    const r = await this.sql.one<Row>(
      `SELECT * FROM watchlists WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [id, userId],
    );
    if (!r) throw new NotFoundError('watchlist');
    const wl = mapWatchlist(r);
    if (expectedVersion !== null && expectedVersion !== wl.version) {
      throw new ConcurrencyError(expectedVersion, wl.version);
    }
    return wl;
  }

  private async bump(id: string): Promise<Watchlist> {
    const r = await this.sql.one<Row>(
      `UPDATE watchlists SET version = version + 1 WHERE id = $1 RETURNING *`,
      [id],
    );
    if (!r) throw new NotFoundError('watchlist');
    return mapWatchlist(r);
  }

  // ───────────────────────────────────────────────────────── items

  async listItems(watchlistId: string): Promise<WatchlistItem[]> {
    const rows = await this.sql.query<Row>(
      `SELECT symbol, added_at, pinned, muted, min_sigma, note, sort_key
       FROM watchlist_items WHERE watchlist_id = $1
       ORDER BY pinned DESC, sort_key, symbol`,
      [watchlistId],
    );
    return rows.map(mapItem);
  }

  /** Items across every list the user owns, keyed by symbol. */
  async listAllItems(userId: string): Promise<Map<string, WatchlistItem>> {
    const rows = await this.sql.query<Row>(
      `SELECT i.symbol,
              MIN(i.added_at)  AS added_at,
              BOOL_OR(i.pinned) AS pinned,
              -- Muted only if muted everywhere: if the symbol is un-muted in
              -- any list, the user still wants to hear about it.
              BOOL_AND(i.muted) AS muted,
              MIN(i.min_sigma) AS min_sigma,
              MIN(i.note)      AS note,
              MIN(i.sort_key)  AS sort_key
       FROM watchlist_items i
       JOIN watchlists w ON w.id = i.watchlist_id
       WHERE w.user_id = $1
       GROUP BY i.symbol`,
      [userId],
    );
    return new Map(rows.map((r) => [r.symbol as string, mapItem(r)]));
  }

  /** Every symbol the user watches, across all their lists. */
  async listUserSymbols(userId: string): Promise<string[]> {
    const rows = await this.sql.query<Row>(
      `SELECT DISTINCT i.symbol
       FROM watchlist_items i
       JOIN watchlists w ON w.id = i.watchlist_id
       WHERE w.user_id = $1
       ORDER BY i.symbol`,
      [userId],
    );
    return rows.map((r) => r.symbol as string);
  }

  async addItem(
    watchlistId: string,
    userId: string,
    symbol: string,
    now: number,
    expectedVersion: number | null,
    maxSymbols: number,
  ): Promise<{ watchlist: Watchlist; added: boolean }> {
    return this.sql.tx(async () => {
      const wl = await this.requireOwned(watchlistId, userId, expectedVersion);

      const c = await this.sql.one<Row>(
        `SELECT COUNT(*) AS c FROM watchlist_items WHERE watchlist_id = $1`,
        [watchlistId],
      );
      if (n(c?.c) >= maxSymbols) throw new LimitError(`watchlist is full (${maxSymbols} symbols)`);

      const m = await this.sql.one<Row>(
        `SELECT COALESCE(MAX(sort_key), 0) AS m FROM watchlist_items WHERE watchlist_id = $1`,
        [watchlistId],
      );

      // Re-adding an existing symbol is a no-op rather than an error: clients
      // retry and users double-click.
      const inserted = await this.sql.query<Row>(
        `INSERT INTO watchlist_items (watchlist_id, symbol, added_at, sort_key)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (watchlist_id, symbol) DO NOTHING
         RETURNING symbol`,
        [watchlistId, symbol, now, n(m?.m) + 1],
      );

      const added = inserted.length > 0;
      // Only bump the version when something actually changed, so an
      // idempotent re-add does not invalidate other clients for no reason.
      return { watchlist: added ? await this.bump(watchlistId) : wl, added };
    });
  }

  async removeItem(
    watchlistId: string,
    userId: string,
    symbol: string,
    expectedVersion: number | null,
  ): Promise<{ watchlist: Watchlist; removed: boolean }> {
    return this.sql.tx(async () => {
      const wl = await this.requireOwned(watchlistId, userId, expectedVersion);
      const deleted = await this.sql.query<Row>(
        `DELETE FROM watchlist_items WHERE watchlist_id = $1 AND symbol = $2 RETURNING symbol`,
        [watchlistId, symbol],
      );
      const removed = deleted.length > 0;
      return { watchlist: removed ? await this.bump(watchlistId) : wl, removed };
    });
  }

  async updateItem(
    watchlistId: string,
    userId: string,
    symbol: string,
    patch: { pinned?: boolean; muted?: boolean; minSigma?: number | null; note?: string | null },
    expectedVersion: number | null,
  ): Promise<Watchlist> {
    return this.sql.tx(async () => {
      const wl = await this.requireOwned(watchlistId, userId, expectedVersion);

      const sets: string[] = [];
      const params: unknown[] = [];
      const add = (col: string, value: unknown): void => {
        params.push(value);
        sets.push(`${col} = $${params.length}`);
      };

      if (patch.pinned !== undefined) add('pinned', patch.pinned);
      if (patch.muted !== undefined) add('muted', patch.muted);
      if (patch.minSigma !== undefined) add('min_sigma', patch.minSigma);
      if (patch.note !== undefined) add('note', patch.note);
      if (sets.length === 0) return wl;

      params.push(watchlistId, symbol);
      const updated = await this.sql.query<Row>(
        `UPDATE watchlist_items SET ${sets.join(', ')}
         WHERE watchlist_id = $${params.length - 1} AND symbol = $${params.length}
         RETURNING symbol`,
        params,
      );
      if (updated.length === 0) throw new NotFoundError('symbol in watchlist');
      return this.bump(watchlistId);
    });
  }

  async reorder(
    watchlistId: string,
    userId: string,
    order: readonly string[],
    expectedVersion: number | null,
  ): Promise<Watchlist> {
    return this.sql.tx(async () => {
      await this.requireOwned(watchlistId, userId, expectedVersion);
      // One statement using a VALUES list, rather than a query per symbol.
      if (order.length > 0) {
        const tuples = order.map(
          (_, i) => `($${i * 2 + 2}::text, $${i * 2 + 3}::double precision)`,
        );
        const params: unknown[] = [watchlistId];
        order.forEach((symbol, i) => params.push(symbol, i + 1));
        await this.sql.query(
          `UPDATE watchlist_items AS wi
           SET sort_key = v.sort_key
           FROM (VALUES ${tuples.join(', ')}) AS v(symbol, sort_key)
           WHERE wi.watchlist_id = $1 AND wi.symbol = v.symbol`,
          params,
        );
      }
      return this.bump(watchlistId);
    });
  }

  // ───────────────────────────────────────────────────────── watermarks

  async getMarks(userId: string, symbols: readonly string[]): Promise<Map<string, SymbolMark>> {
    return batchMap(symbols, async (batch) => {
      const rows = await this.sql.query<Row>(
        `SELECT symbol, seen_at, seen_price, prev_seen_at, prev_seen_price
         FROM user_symbol_marks
         WHERE user_id = $1 AND symbol IN (${placeholders(batch.length, 2)})`,
        [userId, ...batch],
      );
      return new Map(
        rows.map((r) => [
          r.symbol as string,
          {
            symbol: r.symbol as string,
            seenAt: n(r.seen_at),
            seenPrice: nOrNull(r.seen_price),
            prevSeenAt: nOrNull(r.prev_seen_at),
            prevSeenPrice: nOrNull(r.prev_seen_price),
          } satisfies SymbolMark,
        ]),
      );
    });
  }

  /**
   * Advance the watermark for a set of symbols.
   *
   * The previous mark is copied into `prev_*` so the action is undoable. This
   * is deliberately *not* called on page load - only on explicit
   * acknowledgement - because a watermark that moves when you glance at the
   * screen destroys the very thing the product exists to show you.
   *
   * The `WHERE excluded.seen_at >= ...` guard means two devices acknowledging
   * at once settle on the later checkpoint rather than whichever wrote last.
   */
  async advanceMarks(
    userId: string,
    entries: ReadonlyArray<{ symbol: string; price: number | null }>,
    now: number,
  ): Promise<number> {
    if (entries.length === 0) return 0;

    let changed = 0;
    // 4 params per row (user, symbol, seen_at, price) - chunk generously.
    for (const batch of chunk(entries, 400)) {
      const tuples: string[] = [];
      const params: unknown[] = [now];
      batch.forEach((e, i) => {
        const base = i * 3 + 1;
        tuples.push(
          `($${base + 1}::text, $${base + 2}::text, $1::bigint, $${base + 3}::double precision)`,
        );
        params.push(userId, e.symbol, e.price);
      });

      const rows = await this.sql.query<Row>(
        `INSERT INTO user_symbol_marks
           (user_id, symbol, seen_at, seen_price, prev_seen_at, prev_seen_price)
         SELECT v.user_id, v.symbol, v.seen_at, v.seen_price, NULL, NULL
         FROM (VALUES ${tuples.join(', ')}) AS v(user_id, symbol, seen_at, seen_price)
         ON CONFLICT (user_id, symbol) DO UPDATE SET
           prev_seen_at    = user_symbol_marks.seen_at,
           prev_seen_price = user_symbol_marks.seen_price,
           seen_at         = excluded.seen_at,
           seen_price      = excluded.seen_price
         WHERE excluded.seen_at >= user_symbol_marks.seen_at
         RETURNING symbol`,
        params,
      );
      changed += rows.length;
    }
    return changed;
  }

  /**
   * Restore the previous watermark - the undo behind "Catch me up".
   *
   * There are two cases, and getting only the first one right is a bug I hit
   * in testing:
   *
   *  - The symbol had an earlier checkpoint: restore it.
   *  - The symbol had *no* earlier checkpoint, because this was the user's
   *    first ever acknowledgement. Then the correct previous state is "never
   *    checked", which means deleting the row - not leaving the brand-new
   *    checkpoint in place. Handling only the update case made the very first
   *    acknowledgement silently irreversible, which is precisely the moment a
   *    new user is most likely to want it back.
   *
   * One transaction, so a partial undo cannot leave half the watchlist on the
   * new checkpoint and half on the old.
   */
  async undoMarks(userId: string, symbols: readonly string[]): Promise<number> {
    if (symbols.length === 0) return 0;
    return this.sql.tx(async () => {
      let changed = 0;
      for (const batch of chunk(symbols, MAX_BIND_PARAMS - 4)) {
        const list = placeholders(batch.length, 2);
        const params = [userId, ...batch];

        const restored = await this.sql.query<Row>(
          `UPDATE user_symbol_marks
           SET seen_at         = prev_seen_at,
               seen_price      = prev_seen_price,
               prev_seen_at    = NULL,
               prev_seen_price = NULL
           WHERE user_id = $1
             AND prev_seen_at IS NOT NULL
             AND symbol IN (${list})
           RETURNING symbol`,
          params,
        );

        const cleared = await this.sql.query<Row>(
          `DELETE FROM user_symbol_marks
           WHERE user_id = $1
             AND prev_seen_at IS NULL
             AND symbol IN (${list})
           RETURNING symbol`,
          params,
        );

        changed += restored.length + cleared.length;
      }
      return changed;
    });
  }

  /**
   * Force watermarks to a specific instant, ignoring the monotonic guard.
   *
   * Separate from `advanceMarks` on purpose. That method must never move a
   * checkpoint backwards - it is what protects a user from losing a briefing
   * when two devices acknowledge at once. This one deliberately does move it
   * backwards, and exists only so the demo can show "what changed while you
   * were away" without anyone having to actually wait. It is reachable solely
   * from the DEV_TOOLS routes.
   */
  async rewindMarks(
    userId: string,
    entries: ReadonlyArray<{ symbol: string; price: number | null }>,
    at: number,
  ): Promise<number> {
    if (entries.length === 0) return 0;

    let changed = 0;
    for (const batch of chunk(entries, 400)) {
      const tuples: string[] = [];
      const params: unknown[] = [at];
      batch.forEach((e, i) => {
        const base = i * 3 + 1;
        tuples.push(
          `($${base + 1}::text, $${base + 2}::text, $1::bigint, $${base + 3}::double precision)`,
        );
        params.push(userId, e.symbol, e.price);
      });

      const rows = await this.sql.query<Row>(
        `INSERT INTO user_symbol_marks
           (user_id, symbol, seen_at, seen_price, prev_seen_at, prev_seen_price)
         SELECT v.user_id, v.symbol, v.seen_at, v.seen_price, NULL, NULL
         FROM (VALUES ${tuples.join(', ')}) AS v(user_id, symbol, seen_at, seen_price)
         ON CONFLICT (user_id, symbol) DO UPDATE SET
           seen_at         = excluded.seen_at,
           seen_price      = excluded.seen_price,
           prev_seen_at    = NULL,
           prev_seen_price = NULL
         RETURNING symbol`,
        params,
      );
      changed += rows.length;
    }
    return changed;
  }

  /** The most recent checkpoint across all symbols - "you last checked at". */
  async lastCheckedAt(userId: string): Promise<number | null> {
    const r = await this.sql.one<Row>(
      `SELECT MAX(seen_at) AS t FROM user_symbol_marks WHERE user_id = $1`,
      [userId],
    );
    return nOrNull(r?.t);
  }

  // ───────────────────────────────────────────────────────── signal reads

  async markSignalsRead(
    userId: string,
    signalIds: readonly string[],
    now: number,
  ): Promise<number> {
    if (signalIds.length === 0) return 0;
    let changed = 0;
    for (const batch of chunk(signalIds, 500)) {
      const tuples = batch.map((_, i) => `($1, $${i + 3}, $2)`);
      const rows = await this.sql.query<Row>(
        `INSERT INTO signal_reads (user_id, signal_id, read_at)
         VALUES ${tuples.join(', ')}
         ON CONFLICT (user_id, signal_id) DO NOTHING
         RETURNING signal_id`,
        [userId, now, ...batch],
      );
      changed += rows.length;
    }
    return changed;
  }

  async getReadSignalIds(userId: string, signalIds: readonly string[]): Promise<Set<string>> {
    const m = await batchMap(
      signalIds,
      async (batch) => {
        const rows = await this.sql.query<Row>(
          `SELECT signal_id FROM signal_reads
           WHERE user_id = $1 AND signal_id IN (${placeholders(batch.length, 2)})`,
          [userId, ...batch],
        );
        return new Map(rows.map((r) => [r.signal_id as string, true]));
      },
      2,
    );
    return new Set(m.keys());
  }
}
