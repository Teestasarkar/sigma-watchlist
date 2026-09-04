/**
 * End-to-end, against the real stack.
 *
 * Everything here runs the actual code paths: a real (in-memory) Postgres, the
 * real repositories, the real detection engine, the real HTTP layer. No mocks
 * and no fakes beyond a deterministic feed and a manual clock - which are the
 * two things that make market behaviour testable at all.
 *
 * These are the tests that would catch a regression in the behaviour the
 * product actually promises, as opposed to in one of its parts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp, type App } from '../src/app.js';
import { buildServer } from '../src/api/server.js';
import { config as baseConfig } from '../src/config.js';
import { ManualClock } from '../src/infra/clock.js';

const SESSION_MS = 60_000;

/**
 * A manual clock, so a test can move three sessions into the future without
 * waiting three minutes - and so every assertion is about the logic rather
 * than about timing luck.
 */
const clock = new ManualClock(Date.now());

/** Strong enough to pass the real strength rules. */
const TEST_PASSWORD = 'quiet-river-lantern-42';

const config = {
  ...baseConfig,
  databaseUrl: '',
  devTools: true,
  ingest: { ...baseConfig.ingest, enabled: false },
  providers: {
    ...baseConfig.providers,
    enabled: ['synthetic'],
    syntheticSessionMs: SESSION_MS,
    historySessions: 260,
  },
} as typeof baseConfig;

let app: App;
let server: FastifyInstance;
let token: string;

/** Typed helper around fastify.inject, so the tests read like HTTP calls. */
async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const res = await server.inject({
    method,
    url,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body === undefined ? {} : { payload: body as object }),
  });
  let parsed: unknown = null;
  try {
    parsed = res.body ? JSON.parse(res.body) : null;
  } catch {
    parsed = res.body;
  }
  return { status: res.statusCode, body: parsed };
}

beforeAll(async () => {
  app = await buildApp({ config, clock, inMemory: true });
  await app.bootstrap();
  server = await buildServer({ app });
  await server.ready();

  const session = await call('POST', '/api/auth/register', {
    handle: 'tester',
    password: TEST_PASSWORD,
  });
  token = session.body.token;

  // Seed a couple of instruments with contrasting volatility, so the
  // significance assertions have something to compare.
  for (const symbol of ['NEE', 'GME', 'AAPL']) {
    await app.ingest.ensureInstrument(symbol, clock.now(), { pollIntervalMs: 5000 });
  }
  const lists = await call('GET', '/api/watchlists');
  const listId = lists.body.watchlists[0].id;
  for (const symbol of ['NEE', 'GME', 'AAPL']) {
    await call('POST', `/api/watchlists/${listId}/items`, { symbol });
  }
}, 120_000);

afterAll(async () => {
  await server?.close();
  await app?.shutdown();
});

/**
 * Poll every watched symbol once, at the current clock time.
 *
 * Advances the clock first. The digest window is half-open - a signal is only
 * "since you looked" if it was detected strictly after the checkpoint - so
 * acknowledging and then detecting at the identical millisecond would hide the
 * signal. Real time always moves between a user's click and the next poll;
 * the manual clock has to be told to.
 */
async function refreshAll(advanceMs = 5_000): Promise<void> {
  clock.advance(advanceMs);
  const benchmark = await app.ingest.benchmarkSnapshot();
  for (const symbol of await app.jobs.watchedSymbols()) {
    await app.ingest.refresh(symbol, clock.now(), benchmark);
  }
}

describe('setup', () => {
  it('seeds a year of history for each instrument', async () => {
    expect(await app.market.countBars('NEE')).toBeGreaterThan(200);
    expect(await app.market.getStats('NEE')).not.toBeNull();
  });

  it('exposes its configuration honestly', async () => {
    const meta = await call('GET', '/api/meta');
    expect(meta.body.marketClock.simulated).toBe(true);
    expect(meta.body.providers).toContain('synthetic');
  });
});

describe('authentication', () => {
  it('rejects an unauthenticated read', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/digest' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a bogus token', async () => {
    const res = await call('GET', '/api/digest', undefined, { authorization: 'Bearer nope' });
    expect(res.status).toBe(401);
  });
});

describe('watchlist management', () => {
  let listId: string;
  let version: number;

  beforeAll(async () => {
    const lists = await call('GET', '/api/watchlists');
    listId = lists.body.watchlists[0].id;
    version = lists.body.watchlists[0].version;
  });

  it('rejects a malformed ticker before it reaches a provider', async () => {
    const res = await call('POST', `/api/watchlists/${listId}/items`, { symbol: 'hello world!' });
    expect(res.status).toBe(400);
  });

  it('reports an unknown symbol distinctly from an outage', async () => {
    const res = await call('POST', `/api/watchlists/${listId}/items`, { symbol: 'ZZZQQ' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('symbol_unknown');
  });

  it('treats re-adding an existing symbol as a no-op', async () => {
    // AMD is deliberately not in the starter set a new account is seeded with,
    // so the first add here is genuinely the first.
    const first = await call('POST', `/api/watchlists/${listId}/items`, { symbol: 'AMD' });
    expect(first.body.added).toBe(true);
    const again = await call('POST', `/api/watchlists/${listId}/items`, { symbol: 'AMD' });
    expect(again.body.added).toBe(false);
    // A no-op must not bump the version and invalidate other clients.
    expect(again.body.watchlist.version).toBe(first.body.watchlist.version);
  });

  it('rejects a write based on a stale version, and says what the current one is', async () => {
    // GOOGL is outside the starter set, so this add really would change the
    // list - which is what makes the version check meaningful rather than
    // short-circuited by an idempotent no-op.
    const res = await call('POST', `/api/watchlists/${listId}/items`, {
      symbol: 'GOOGL',
      expectedVersion: version, // captured before several mutations
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conflict');
    expect(typeof res.body.error.currentVersion).toBe('number');
  });

  it('accepts a write carrying the current version', async () => {
    const lists = await call('GET', '/api/watchlists');
    const current = lists.body.watchlists[0];
    const res = await call('POST', `/api/watchlists/${listId}/items`, {
      symbol: 'GOOGL',
      expectedVersion: current.version,
    });
    expect(res.status).toBe(200);
  });

  it('enforces per-symbol preferences', async () => {
    const lists = await call('GET', '/api/watchlists');
    const res = await call('PATCH', `/api/watchlists/${listId}/items/GME`, {
      muted: true,
      expectedVersion: lists.body.watchlists[0].version,
    });
    expect(res.status).toBe(200);

    const items = (await call('GET', '/api/watchlists')).body.watchlists[0].items;
    expect(items.find((i: { symbol: string }) => i.symbol === 'GME').muted).toBe(true);

    // Restore, so later tests see GME.
    const after = await call('GET', '/api/watchlists');
    await call('PATCH', `/api/watchlists/${listId}/items/GME`, {
      muted: false,
      expectedVersion: after.body.watchlists[0].version,
    });
  });
});

describe('idempotency', () => {
  it('replays the stored response for a repeated key', async () => {
    const key = `idem-${Date.now()}`;
    const first = await call('POST', '/api/digest/acknowledge', {}, { 'idempotency-key': key });
    const second = await server.inject({
      method: 'POST',
      url: '/api/digest/acknowledge',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': key },
      payload: {},
    });

    expect(second.headers['idempotent-replay']).toBe('true');
    expect(JSON.parse(second.body)).toEqual(first.body);
  });

  it('refuses a reused key carrying a different request', async () => {
    // Silently returning the first response would swallow a different intent.
    const key = `idem-mismatch-${Date.now()}`;
    await call('POST', '/api/digest/acknowledge', {}, { 'idempotency-key': key });
    const res = await call(
      'POST',
      '/api/digest/acknowledge',
      { symbols: ['AAPL'] },
      { 'idempotency-key': key },
    );
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('idempotency_mismatch');
  });
});

describe('accounts are isolated', () => {
  /**
   * The sign-in screen exists to make this visible, so it had better be true.
   * Every assertion here is about one account being unable to observe or
   * affect another.
   */
  it('gives a new account its own populated watchlist', async () => {
    const handle = `newbie-${Date.now()}`;
    const res = await call('POST', '/api/auth/register', { handle, password: TEST_PASSWORD });

    expect(res.status).toBe(201);
    expect(res.body.isNew).toBe(true);

    const rows = await server.inject({
      method: 'GET',
      url: '/api/watchlists/all/rows',
      headers: { authorization: `Bearer ${res.body.token}` },
    });
    const parsed = JSON.parse(rows.body);
    // An empty first screen would be followed by "insufficient history".
    expect(parsed.rows.length).toBeGreaterThan(0);
  });

  it('returns an existing account to the same identity', async () => {
    const handle = `returning-${Date.now()}`;
    const first = await call('POST', '/api/auth/register', { handle, password: TEST_PASSWORD });
    const second = await call('POST', '/api/auth/login', { handle, password: TEST_PASSWORD });

    expect(second.status).toBe(200);
    expect(second.body.isNew).toBe(false);
    expect(second.body.user.id).toBe(first.body.user.id);
    // A second device is a second token row, not a second account.
    expect(second.body.token).not.toBe(first.body.token);
  });

  it('keeps watchlists private, and hides their existence', async () => {
    const a = (await call('POST', '/api/auth/register', { handle: `a-${Date.now()}`, password: TEST_PASSWORD })).body;
    const b = (await call('POST', '/api/auth/register', { handle: `b-${Date.now()}`, password: TEST_PASSWORD })).body;

    const aLists = await server.inject({
      method: 'GET',
      url: '/api/watchlists',
      headers: { authorization: `Bearer ${a.token}` },
    });
    const aListId = JSON.parse(aLists.body).watchlists[0].id;

    const read = await server.inject({
      method: 'GET',
      url: `/api/watchlists/${aListId}/rows`,
      headers: { authorization: `Bearer ${b.token}` },
    });
    const write = await server.inject({
      method: 'POST',
      url: `/api/watchlists/${aListId}/items`,
      headers: { authorization: `Bearer ${b.token}` },
      payload: { symbol: 'TSLA' },
    });

    // 404 rather than 403, deliberately: a 403 would confirm the list exists.
    expect(read.statusCode).toBe(404);
    expect(write.statusCode).toBe(404);
  });

  it('moves one account checkpoint without touching another', async () => {
    const a = (await call('POST', '/api/auth/register', { handle: `wm-a-${Date.now()}`, password: TEST_PASSWORD })).body;
    const b = (await call('POST', '/api/auth/register', { handle: `wm-b-${Date.now()}`, password: TEST_PASSWORD })).body;

    const digestFor = async (token: string): Promise<number> => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/digest',
        headers: { authorization: `Bearer ${token}` },
      });
      const d = JSON.parse(res.body);
      return d.groups.reduce((n: number, g: { signals: unknown[] }) => n + g.signals.length, 0);
    };

    await refreshAll();
    const bBefore = await digestFor(b.token);

    await server.inject({
      method: 'POST',
      url: '/api/digest/acknowledge',
      headers: { authorization: `Bearer ${a.token}` },
      payload: {},
    });

    expect(await digestFor(a.token)).toBe(0);
    expect(await digestFor(b.token)).toBe(bBefore);
  });

  it('rejects a handle that is not a handle', async () => {
    const res = await call('POST', '/api/auth/register', { handle: 'drop table users;--', password: TEST_PASSWORD });
    expect(res.status).toBe(400);
  });
});

describe('the watermark', () => {
  it('does not advance merely because the digest was read', async () => {
    app.faults.shocks.set('NEE', { logReturn: Math.log1p(0.04), from: clock.now() });
    await refreshAll();

    const first = await call('GET', '/api/digest');
    const second = await call('GET', '/api/digest');

    const count = (r: typeof first): number =>
      r.body.groups.reduce((n: number, g: { signals: unknown[] }) => n + g.signals.length, 0);

    expect(count(first)).toBeGreaterThan(0);
    expect(count(second)).toBe(count(first));
  });

  it('clears the briefing when acknowledged, and restores it on undo', async () => {
    const before = await call('GET', '/api/digest');
    const beforeCount = before.body.groups.length;
    expect(beforeCount).toBeGreaterThan(0);

    const ack = await call('POST', '/api/digest/acknowledge', {});
    expect(ack.status).toBe(200);
    expect((await call('GET', '/api/digest')).body.groups.length).toBe(0);

    const undo = await call('POST', '/api/digest/undo', {});
    expect(undo.body.restored).toBeGreaterThan(0);
    expect((await call('GET', '/api/digest')).body.groups.length).toBe(beforeCount);
  });

  it('is undoable even on the very first acknowledgement', async () => {
    // The first ack has no previous checkpoint to restore, so undo must remove
    // the mark entirely rather than silently doing nothing.
    const fresh = await call('POST', '/api/auth/register', { handle: `first-${Date.now()}`, password: TEST_PASSWORD });
    const otherToken = fresh.body.token;

    const lists = await server.inject({
      method: 'GET',
      url: '/api/watchlists',
      headers: { authorization: `Bearer ${otherToken}` },
    });
    const listId = JSON.parse(lists.body).watchlists[0].id;

    await server.inject({
      method: 'POST',
      url: `/api/watchlists/${listId}/items`,
      headers: { authorization: `Bearer ${otherToken}` },
      payload: { symbol: 'AAPL' },
    });

    const ack = await server.inject({
      method: 'POST',
      url: '/api/digest/acknowledge',
      headers: { authorization: `Bearer ${otherToken}` },
      payload: {},
    });
    expect(JSON.parse(ack.body).acknowledged).toBeGreaterThan(0);

    const undo = await server.inject({
      method: 'POST',
      url: '/api/digest/undo',
      headers: { authorization: `Bearer ${otherToken}` },
      payload: {},
    });
    expect(JSON.parse(undo.body).restored).toBeGreaterThan(0);
  });

  it('never moves a checkpoint backwards', async () => {
    // Two devices acknowledging at once must settle on the later checkpoint.
    const symbols = await app.users.listUserSymbols((await app.users.findUserByHandle('tester'))!.id);
    const userId = (await app.users.findUserByHandle('tester'))!.id;

    const later = clock.now();
    await app.users.advanceMarks(userId, symbols.map((s) => ({ symbol: s, price: 100 })), later);
    await app.users.advanceMarks(userId, symbols.map((s) => ({ symbol: s, price: 90 })), later - 60_000);

    const marks = await app.users.getMarks(userId, symbols);
    for (const mark of marks.values()) expect(mark.seenAt).toBe(later);
  });
});

describe('significance, not percentage', () => {
  it('ranks a small move in a quiet name above a large one in a wild name', async () => {
    // Reset to a clean checkpoint, then move both.
    await call('POST', '/api/digest/acknowledge', {});
    app.faults.shocks.clear();

    app.faults.shocks.set('NEE', { logReturn: Math.log1p(0.028), from: clock.now() });
    app.faults.shocks.set('GME', { logReturn: Math.log1p(0.05), from: clock.now() });
    await refreshAll();

    const rows = (await call('GET', '/api/watchlists/all/rows')).body.rows as Array<{
      symbol: string;
      today: { changePct: number };
      sinceSeen: { sigma: number | null; changePct: number | null };
      stats: { sigmaDaily: number } | null;
    }>;

    const nee = rows.find((r) => r.symbol === 'NEE')!;
    const gme = rows.find((r) => r.symbol === 'GME')!;

    // The quiet name really is quieter.
    expect(nee.stats!.sigmaDaily).toBeLessThan(gme.stats!.sigmaDaily / 2);

    /*
     * The invariant: one percent of movement buys far more significance in the
     * low-volatility name.
     *
     * Asserted as a ratio rather than by comparing the two raw percentages,
     * because the underlying prices also drift - GME's own session noise is
     * several percent, so which name happens to show the larger headline
     * number on any given run is luck. The ratio is not luck; it is exactly
     * what the product claims.
     */
    const perPct = (r: (typeof rows)[number]): number =>
      Math.abs(r.sinceSeen.sigma!) / Math.abs(r.sinceSeen.changePct! * 100);

    expect(perPct(nee)).toBeGreaterThan(perPct(gme) * 2);
  });
});

describe('detection is idempotent', () => {
  it('re-running a cycle over unchanged input creates nothing new', async () => {
    await refreshAll();
    const before = await app.signals.countAll();

    // A duplicate tick, a crash-and-retry, or a second worker: all the same.
    await refreshAll();
    await refreshAll();

    expect(await app.signals.countAll()).toBe(before);
  });

  it('does not re-announce a condition that is still true', async () => {
    const symbol = 'NEE';
    const before = (await app.signals.listBySymbol(symbol, 50)).length;
    for (let i = 0; i < 5; i++) await refreshAll();
    expect((await app.signals.listBySymbol(symbol, 50)).length).toBe(before);
  });
});

describe('unreliable data', () => {
  it('refuses a quote older than the one already stored', async () => {
    // The out-of-order guard. Without it, two concurrent fetches completing in
    // the wrong order make the displayed price jump backwards.
    await refreshAll();
    app.faults.stalenessMs = 30 * 60_000;
    const result = await app.ingest.refresh('AAPL', clock.now(), await app.ingest.benchmarkSnapshot());
    expect(result.quoteAccepted).toBe(false);
    app.faults.stalenessMs = 0;
  });

  it('surfaces staleness rather than presenting an old price as live', async () => {
    const symbols = await app.jobs.watchedSymbols();
    await app.market.backdateQuotes(symbols, 45 * 60_000);
    await refreshAllDetectionOnly();

    const digest = await call('GET', '/api/digest');
    expect(digest.body.health.stale.length).toBeGreaterThan(0);
    expect(['stale', 'unknown']).toContain(digest.body.health.worstFreshness);

    const kinds = digest.body.groups.flatMap((g: { signals: Array<{ kind: string }> }) =>
      g.signals.map((s) => s.kind),
    );
    expect(kinds).toContain('stale_data');

    await refreshAll(); // restore fresh quotes
  });

  it('marks a vanished symbol rather than deleting it', async () => {
    app.faults.unknown.add('AAPL');
    const result = await app.ingest.refresh('AAPL', clock.now(), null);
    expect(result.notFound).toBe(true);

    const instrument = await app.market.getInstrument('AAPL');
    // The user put it there deliberately; its disappearance is the news.
    expect(instrument).not.toBeNull();
    expect(instrument?.status).toBe('delisted');

    app.faults.unknown.clear();
    await app.ingest.refresh('AAPL', clock.now(), null);
    expect((await app.market.getInstrument('AAPL'))?.status).toBe('active');
  });

  it('opens the circuit breaker when the provider keeps failing', async () => {
    /*
     * Move past the breaker's rolling window first.
     *
     * The window still holds this suite's earlier successful fetches, and the
     * breaker quite correctly refuses to trip while the *recent* failure rate
     * is below its threshold - a couple of blips after a healthy spell are not
     * an outage. The scenario under test is a provider going down after a
     * quiet period, so the quiet period has to have aged out.
     */
    clock.advance(baseConfig.breaker.windowMs + 1_000);

    app.faults.failureRate = 1;
    for (let i = 0; i < 8; i++) {
      const r = await app.ingest.refresh('AAPL', clock.now(), null);
      expect(r.ok).toBe(false);
    }
    expect(app.registry.health()[0]?.breaker).not.toBe('closed');

    app.faults.failureRate = 0;
    app.registry.resetBreakers();
    expect(app.registry.health()[0]?.breaker).toBe('closed');
  });

  it('keeps serving the last known price while the feed is down', async () => {
    app.faults.failureRate = 1;
    const rows = (await call('GET', '/api/watchlists/all/rows')).body.rows;
    // Degraded, not broken: prices are still there, flagged for what they are.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r: { quote: unknown }) => r.quote !== null)).toBe(true);
    app.faults.failureRate = 0;
  });
});

describe('backfill after downtime', () => {
  it('recovers the sessions that closed while the process was asleep', async () => {
    await refreshAll();
    const before = await app.market.countBars('NEE');

    // Simulate three sessions of downtime by jumping the clock.
    clock.advance(3 * SESSION_MS);
    await refreshAll();

    const after = await app.market.countBars('NEE');
    expect(after).toBeGreaterThan(before);
    // The gap is filled, not skipped: statistics stay complete.
    expect(after - before).toBeGreaterThanOrEqual(2);
  });
});

describe('health', () => {
  it('reports readiness including the database', async () => {
    const res = await call('GET', '/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.database.reachable).toBe(true);
  });
});

/**
 * Re-run detection over stored quotes without fetching.
 *
 * Used by the staleness test, which needs the stored quote to stay old - a
 * normal refresh would replace it with a fresh one and undo the setup.
 */
async function refreshAllDetectionOnly(): Promise<void> {
  const benchmark = await app.ingest.benchmarkSnapshot();
  for (const symbol of await app.jobs.watchedSymbols()) {
    const quote = await app.market.getQuote(symbol);
    if (!quote) continue;
    await app.detection.detect({
      symbol,
      quote,
      stats: await app.market.getStats(symbol),
      freshness: app.ingest.freshnessOf(quote, clock.now()),
      benchmark:
        benchmark && benchmark.symbol !== symbol
          ? { quote: benchmark.quote, stats: benchmark.stats }
          : null,
      now: clock.now(),
    });
  }
}
