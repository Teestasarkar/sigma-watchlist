/**
 * Read-replica routing.
 *
 * The dangerous failure here is asymmetric and that shapes every test below. A
 * read wrongly sent to the primary costs a query. A *write* wrongly sent to a
 * replica either errors in production or, worse, silently reads stale data
 * inside a transaction that thinks it can see its own uncommitted rows.
 *
 * So the classifier is tested mostly on statements that *look* like reads and
 * are not.
 */

import { describe, expect, it, vi } from 'vitest';

import { isPureRead, maybeWithReplica, withReadReplica } from '../src/db/replica.js';
import { createPgliteClient, type SqlClient } from '../src/db/sql.js';

/** A client that records where each statement went. */
function spyClient(label: string, seen: string[]): SqlClient {
  const note = (sql: string): void => {
    seen.push(`${label}:${sql.trim().split(/\s+/)[0]?.toLowerCase()}`);
  };
  return {
    driver: 'postgres',
    async query<T>(sql: string): Promise<T[]> {
      note(sql);
      return [] as T[];
    },
    async one<T>(sql: string): Promise<T | null> {
      note(sql);
      return null;
    },
    async write(sql: string): Promise<number> {
      note(sql);
      return 0;
    },
    async exec(sql: string): Promise<void> {
      note(sql);
    },
    async tx<T>(fn: () => Promise<T>): Promise<T> {
      seen.push(`${label}:tx`);
      return fn();
    },
    async close(): Promise<void> {
      seen.push(`${label}:close`);
    },
  };
}

describe('classifying a statement', () => {
  it('routes plain selects', () => {
    expect(isPureRead('SELECT * FROM bars WHERE symbol = $1')).toBe(true);
    expect(isPureRead('  select 1  ')).toBe(true);
    expect(isPureRead('WITH recent AS (SELECT * FROM bars) SELECT * FROM recent')).toBe(true);
  });

  it('refuses anything that writes', () => {
    expect(isPureRead('INSERT INTO bars VALUES ($1)')).toBe(false);
    expect(isPureRead('UPDATE instruments SET status = $1')).toBe(false);
    expect(isPureRead('DELETE FROM signals WHERE id = $1')).toBe(false);
    expect(isPureRead('CREATE TABLE x (a int)')).toBe(false);
  });

  it('refuses a write disguised as a read', () => {
    /*
     * `INSERT ... RETURNING` reads like a read at the call site - the caller
     * does `query<Row>(...)` and gets rows back - and this codebase uses it in
     * several places. Sending one to a replica would drop the write.
     */
    expect(isPureRead('INSERT INTO signals (id) VALUES ($1) RETURNING id')).toBe(false);
    expect(isPureRead('DELETE FROM marks WHERE user_id = $1 RETURNING symbol')).toBe(false);
    expect(
      isPureRead('WITH moved AS (UPDATE jobs SET tier = $1 RETURNING *) SELECT * FROM moved'),
    ).toBe(false);
  });

  it('refuses a select that takes a lock', () => {
    /*
     * The ingest queue's whole design rests on `FOR UPDATE SKIP LOCKED`
     * handing concurrent workers disjoint batches. A replica cannot grant that
     * lock, so two workers would claim the same symbols.
     */
    expect(
      isPureRead('SELECT symbol FROM ingest_jobs WHERE next_run_at <= $1 FOR UPDATE SKIP LOCKED'),
    ).toBe(false);
    expect(isPureRead('SELECT * FROM t FOR SHARE')).toBe(false);
    expect(isPureRead('SELECT * FROM t\n  FOR   UPDATE')).toBe(false);
  });
});

describe('routing', () => {
  it('sends reads to the replica and writes to the primary', async () => {
    const seen: string[] = [];
    const db = withReadReplica(spyClient('primary', seen), spyClient('replica', seen));

    await db.query('SELECT * FROM bars');
    await db.one('SELECT 1');
    await db.write('UPDATE instruments SET status = $1');
    await db.exec('CREATE TABLE x (a int)');

    expect(seen).toEqual(['replica:select', 'replica:select', 'primary:update', 'primary:create']);
  });

  it('keeps a read on the primary when it is not really a read', async () => {
    const seen: string[] = [];
    const db = withReadReplica(spyClient('primary', seen), spyClient('replica', seen));

    await db.query('INSERT INTO signals (id) VALUES ($1) RETURNING id');
    await db.query('SELECT * FROM ingest_jobs FOR UPDATE SKIP LOCKED');

    expect(seen).toEqual(['primary:insert', 'primary:select']);
  });

  it('never splits a transaction', async () => {
    /*
     * The subtle one. A read routed to a replica from inside a write
     * transaction sees a snapshot from before its own uncommitted writes - a
     * bug that reproduces once a week and never in a test.
     *
     * This uses a *real* primary rather than a spy, deliberately. The guard
     * reads AsyncLocalStorage that only the real `tx` implementation sets, so
     * a fake would report exactly the pass this test exists to distrust.
     */
    const seen: string[] = [];
    const primary = await createPgliteClient();
    await primary.exec('CREATE TABLE t (id int, v int)');

    const db = withReadReplica(primary, spyClient('replica', seen));

    // Outside a transaction, a read does go to the replica.
    await db.query('SELECT * FROM t');
    expect(seen).toEqual(['replica:select']);

    await db.tx(async () => {
      await db.query('SELECT * FROM t');
      await db.write('INSERT INTO t (id, v) VALUES (1, 1)');
      // The read that matters: it must see the row just written.
      const rows = await db.query<{ v: number }>('SELECT v FROM t WHERE id = 1');
      expect(rows).toHaveLength(1);
    });

    // Nothing inside the transaction touched the replica.
    expect(seen).toEqual(['replica:select']);

    await primary.close();
  });

  it('closes both pools', async () => {
    const seen: string[] = [];
    const db = withReadReplica(spyClient('primary', seen), spyClient('replica', seen));

    await db.close();
    expect(seen).toContain('primary:close');
    expect(seen).toContain('replica:close');
  });
});

describe('deciding whether to use one at all', () => {
  it('returns the primary unchanged when none is configured', async () => {
    const seen: string[] = [];
    const primary = spyClient('primary', seen);
    const connect = vi.fn();

    // Identity, not a wrapper: the default deployment keeps exactly the code
    // path it had before, with no per-query branch.
    expect(await maybeWithReplica(primary, undefined, connect)).toBe(primary);
    expect(await maybeWithReplica(primary, '   ', connect)).toBe(primary);
    expect(connect).not.toHaveBeenCalled();
  });

  it('proves the replica answers before trusting it', async () => {
    const seen: string[] = [];
    const primary = spyClient('primary', seen);
    const replica = spyClient('replica', seen);

    const db = await maybeWithReplica(primary, 'postgres://replica', async () => replica);

    expect(db).not.toBe(primary);
    // The health check ran against the replica, at startup.
    expect(seen).toContain('replica:select');
  });

  it('falls back to the primary rather than refusing to start', async () => {
    /*
     * A replica is capacity, not correctness. Failing to boot over one would
     * turn a degraded deployment into an outage.
     */
    const seen: string[] = [];
    const primary = spyClient('primary', seen);

    const db = await maybeWithReplica(primary, 'postgres://unreachable', async () => {
      throw new Error('ECONNREFUSED');
    });

    expect(db).toBe(primary);
  });

  it('falls back when the replica connects but cannot answer', async () => {
    const seen: string[] = [];
    const primary = spyClient('primary', seen);
    const broken: SqlClient = {
      ...spyClient('replica', seen),
      one: async () => {
        throw new Error('relation does not exist');
      },
    };

    expect(await maybeWithReplica(primary, 'postgres://half-migrated', async () => broken)).toBe(
      primary,
    );
  });
});
