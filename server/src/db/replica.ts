/**
 * Routing reads to a replica.
 *
 * The claim this makes real: the read path is batched and index-only, so it
 * can move to a replica without touching a query. That was true, and it was
 * also unverifiable - "would work" is not the same as "works", and the gap
 * between them is usually a write hiding inside something that looked like a
 * read.
 *
 * So this is small on purpose. A `SqlClient` that sends reads to one pool and
 * everything else to the primary, plus the two rules that make it safe:
 *
 * **A transaction never splits.** Anything inside `tx()` goes to the
 * primary, all of it. A read on a replica inside a write transaction would see
 * a snapshot from before its own uncommitted writes - the kind of bug that
 * reproduces once a week and never in a test.
 *
 * **Only market data is routed.** Replicas lag, and a user who adds a symbol
 * and is immediately shown a list without it will conclude the app is broken -
 * correctly. Rather than a session-consistency scheme that cannot be enforced
 * over a connection pool, the split follows *who writes the row*:
 *
 *   - Quotes, bars, statistics and signals are written by the ingest tier, on
 *     its own schedule, and are already a snapshot of a market that moved
 *     while the page was rendering. A second of replication lag is
 *     indistinguishable from a second of poll interval. These are also the
 *     heavy queries - a year of bars across a 500-symbol watchlist - so they
 *     are the ones worth moving.
 *   - Watchlists, checkpoints, dismissals and learned weights are written by
 *     the user's own request, and are read back immediately after. These stay
 *     on the primary, always.
 *
 * That split needs no coordination and no staleness bound, because no request
 * ever reads back its own write from the replica.
 *
 * With no replica configured this is not constructed at all, so the default
 * path has exactly one pool and no branch.
 */

import type { SqlClient } from './sql.js';
import { inTransaction } from './sql.js';
import { createLogger } from '../infra/logger.js';

const log = createLogger('replica');

/**
 * A client that reads from `replica` and writes to `primary`.
 *
 * Deliberately implements the same interface rather than introducing a second
 * one, so no repository has to know which it was handed - and so a repository
 * can be moved between them by changing one line in the composition root.
 */
export function withReadReplica(primary: SqlClient, replica: SqlClient): SqlClient {
  return {
    driver: primary.driver,

    async query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]> {
      return route(sql).query<T>(sql, params);
    },

    async one<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T | null> {
      return route(sql).one<T>(sql, params);
    },

    // Writes and DDL are never routed. Even a "write" that turns out to be a
    // no-op must go to the primary, or the next read of it races replication.
    write: (sql, params) => primary.write(sql, params),
    exec: (sql) => primary.exec(sql),
    tx: <T>(fn: () => Promise<T>) => primary.tx(fn),
    close: async () => {
      await Promise.allSettled([primary.close(), replica.close()]);
    },
  };

  function route(sql: string): SqlClient {
    // Inside a transaction, everything goes to the primary - see the header.
    if (inTransaction()) return primary;
    return isPureRead(sql) ? replica : primary;
  }
}

/**
 * Is this statement safe to send to a replica?
 *
 * Conservative by construction: it must start with SELECT and contain no
 * writing keyword anywhere. `INSERT ... RETURNING` reads like a read at the
 * call site and is emphatically not one, and `SELECT ... FOR UPDATE` - which
 * the ingest queue depends on - takes a row lock that a replica cannot grant.
 *
 * A false negative costs a query on the primary. A false positive corrupts
 * data, so the asymmetry decides the design.
 */
export function isPureRead(sql: string): boolean {
  const s = sql.trim().toLowerCase();
  if (!s.startsWith('select') && !s.startsWith('with')) return false;
  // `WITH ... INSERT` is legal SQL and is not a read.
  return !/\b(insert|update|delete|for\s+update|for\s+share|nextval|lock|create|alter|drop|truncate)\b/.test(
    s,
  );
}

/**
 * Build the pair, or return the primary unchanged.
 *
 * Returning the primary rather than a wrapper when there is no replica keeps
 * the default deployment on exactly the code path it had before - no branch
 * per query, nothing to get subtly wrong for the 99% case.
 */
export async function maybeWithReplica(
  primary: SqlClient,
  replicaUrl: string | undefined,
  connect: (url: string) => Promise<SqlClient>,
): Promise<SqlClient> {
  const url = replicaUrl?.trim();
  if (!url) return primary;

  try {
    const replica = await connect(url);
    // Prove it before trusting it. A replica that cannot answer a trivial
    // query should fail here, at startup, rather than on a user's first read.
    await replica.one('SELECT 1 AS ok');
    log.info('read replica connected; reads will be routed to it');
    return withReadReplica(primary, replica);
  } catch (err) {
    /*
     * A replica is an optimisation. Losing it is a capacity problem, not a
     * correctness one, and refusing to boot over it would turn a degraded
     * deployment into an outage.
     */
    log.error('read replica unavailable; serving every read from the primary', {
      err: err instanceof Error ? err.message : String(err),
    });
    return primary;
  }
}
