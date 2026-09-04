/**
 * Postgres caps bound parameters per statement at 65535. Any query that builds
 * an `IN ($1, $2, ...)` list from user data therefore has an input size above
 * which it stops working - a bug that only appears for the power user with
 * thousands of symbols, who is exactly the user least likely to appear in
 * anyone's test fixtures.
 *
 * These helpers make the batch reads chunk instead of break.
 */

/** Conservative, so a query with other bound values still has headroom. */
export const MAX_BIND_PARAMS = 2000;

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) throw new Error('chunk size must be positive');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Run a keyed batch read across as many statements as needed, merging the
 * results into one Map. `reserved` accounts for bind slots the query uses for
 * things other than the IN list (a user id, a cutoff timestamp).
 */
export async function batchMap<K, V>(
  keys: readonly K[],
  fetch: (batch: readonly K[]) => Promise<Map<K, V>>,
  reserved = 4,
): Promise<Map<K, V>> {
  if (keys.length === 0) return new Map();
  const size = Math.max(1, MAX_BIND_PARAMS - reserved);
  if (keys.length <= size) return fetch(keys);

  const merged = new Map<K, V>();
  for (const batch of chunk(keys, size)) {
    for (const [k, v] of await fetch(batch)) merged.set(k, v);
  }
  return merged;
}

/** As `batchMap`, for queries returning a flat list. */
export async function batchList<K, V>(
  keys: readonly K[],
  fetch: (batch: readonly K[]) => Promise<V[]>,
  reserved = 4,
): Promise<V[]> {
  if (keys.length === 0) return [];
  const size = Math.max(1, MAX_BIND_PARAMS - reserved);
  if (keys.length <= size) return fetch(keys);

  const out: V[] = [];
  for (const batch of chunk(keys, size)) out.push(...(await fetch(batch)));
  return out;
}
