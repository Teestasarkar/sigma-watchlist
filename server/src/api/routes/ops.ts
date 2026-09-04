/**
 * Operational routes: health, diagnostics, and deliberate fault injection.
 *
 * The fault-injection endpoints are the part worth defending. Resilience
 * machinery that has never been exercised is decoration, and a README claiming
 * "handles provider outages gracefully" is unverifiable. These let anyone
 * break the running system on purpose and watch the breaker trip, the
 * staleness ladder engage, prices become disputed, and recovery happen - in
 * about fifteen seconds, from the UI.
 *
 * They are gated behind DEV_TOOLS and are, by design, unauthenticated in that
 * mode so the demo panel needs no token plumbing. In a real deployment they
 * would sit behind an operator role; DEV_TOOLS=0 removes them entirely.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { App } from '../../app.js';
import { ApiError, badRequest } from '../errors.js';
import { describeFaults, resetFaults } from '../../providers/faults.js';

export async function registerOpsRoutes(fastify: FastifyInstance, app: App): Promise<void> {
  const startedAt = app.clock.now();

  /**
   * Liveness and readiness in one.
   *
   * Returns 200 only when the database actually answers. A health check that
   * reports healthy while the database is unreachable is worse than none: it
   * keeps a broken instance in the load balancer.
   *
   * This is also the endpoint the keep-warm cron hits on free hosting, which
   * is why it is cheap - one trivial query.
   */
  fastify.get('/api/health', async (_req, reply) => {
    const now = app.clock.now();
    let database = false;
    try {
      await app.sql.query('SELECT 1');
      database = true;
    } catch {
      database = false;
    }

    const scheduler = await app.scheduler.stats().catch(() => null);
    const healthy = database;

    void reply.code(healthy ? 200 : 503);
    return {
      status: healthy ? 'ok' : 'degraded',
      uptimeMs: now - startedAt,
      database: { driver: app.sql.driver, reachable: database },
      marketClock: { name: app.marketClock.name, open: app.marketClock.isOpen(now) },
      scheduler: scheduler
        ? {
            running: scheduler.running,
            ticks: scheduler.ticks,
            refreshed: scheduler.refreshed,
            failed: scheduler.failed,
            queueDepth: scheduler.queueDepth,
          }
        : null,
      providers: app.registry.health(),
    };
  });

  /** Deeper diagnostics for the data-health panel. */
  fastify.get('/api/ops/diagnostics', async () => {
    const [scheduler, signalCount, jobs] = await Promise.all([
      app.scheduler.stats(),
      app.signals.countAll(),
      app.jobs.listJobs(),
    ]);

    const now = app.clock.now();

    return {
      scheduler,
      signals: { total: signalCount },
      providers: app.registry.diagnostics(),
      faults: describeFaults(app.faults),
      jobs: jobs.slice(0, 60).map((j) => ({
        symbol: j.symbol,
        tier: j.tier,
        intervalMs: j.intervalMs,
        dueInMs: j.nextRunAt - now,
        failStreak: j.failStreak,
        lastError: j.lastError,
        lastOkAgoMs: j.lastOkAt === null ? null : now - j.lastOkAt,
      })),
    };
  });

  if (!app.config.devTools) return;

  // ─────────────────────────────────────────────────── fault injection

  const guard = (): void => {
    if (!app.config.devTools) throw new ApiError('not_found', 'dev tools are disabled');
  };

  /**
   * Set one or more fault knobs.
   *
   * Everything is optional and additive, so the panel can flip a single
   * dimension without disturbing the rest.
   */
  fastify.post('/api/dev/faults', async (req) => {
    guard();
    const body = z
      .object({
        failureRate: z.number().min(0).max(1).optional(),
        latencyMs: z.number().min(0).max(30_000).optional(),
        stalenessMs: z.number().min(0).max(24 * 3600_000).optional(),
        priceSkew: z.number().min(0.5).max(2).optional(),
        halted: z.array(z.string().max(12)).max(50).optional(),
        unknown: z.array(z.string().max(12)).max(50).optional(),
      })
      .safeParse(req.body ?? {});

    if (!body.success) throw badRequest(body.error.issues[0]?.message ?? 'invalid faults');
    const f = body.data;

    if (f.failureRate !== undefined) app.faults.failureRate = f.failureRate;
    if (f.latencyMs !== undefined) app.faults.latencyMs = f.latencyMs;
    if (f.stalenessMs !== undefined) app.faults.stalenessMs = f.stalenessMs;
    if (f.priceSkew !== undefined) app.faults.priceSkew = f.priceSkew;
    if (f.halted) {
      app.faults.halted.clear();
      for (const s of f.halted) app.faults.halted.add(s.toUpperCase());
    }
    if (f.unknown) {
      app.faults.unknown.clear();
      for (const s of f.unknown) app.faults.unknown.add(s.toUpperCase());
    }

    return describeFaults(app.faults);
  });

  fastify.post('/api/dev/faults/reset', async () => {
    guard();
    resetFaults(app.faults);
    app.registry.resetBreakers();
    return describeFaults(app.faults);
  });

  /**
   * Inject a price shock.
   *
   * Applied as an additive log return on top of the deterministic price path,
   * so the seeded process underneath stays intact - the shock moves the price
   * without corrupting the volatility history that gives the resulting sigma
   * its meaning.
   */
  fastify.post('/api/dev/shock', async (req) => {
    guard();
    const body = z
      .object({
        symbol: z.string().trim().min(1).max(12).transform((s) => s.toUpperCase()),
        pct: z.number().min(-0.9).max(5),
      })
      .safeParse(req.body ?? {});
    if (!body.success) throw badRequest(body.error.issues[0]?.message ?? 'invalid shock');

    const { symbol, pct } = body.data;
    const now = app.clock.now();

    if (pct === 0) {
      app.faults.shocks.delete(symbol);
    } else {
      // Compose with any existing shock rather than replacing it, so two
      // successive +5% shocks total +10.25% as they should.
      const existing = app.faults.shocks.get(symbol);
      const logReturn = Math.log1p(pct) + (existing?.logReturn ?? 0);
      app.faults.shocks.set(symbol, { logReturn, from: now });
    }

    // Refresh immediately so the effect is visible without waiting for the
    // symbol's turn in the poll queue.
    const benchmark = await app.ingest.benchmarkSnapshot();
    const result = await app.ingest.refresh(symbol, now, benchmark);

    return { symbol, pct, refresh: result, faults: describeFaults(app.faults) };
  });

  /**
   * Age our stored quotes, to exercise the staleness ladder without waiting.
   *
   * Distinct from the provider-level `stalenessMs` fault on purpose. That one
   * makes the *upstream* report old data, which `upsertQuote` correctly
   * refuses to store; this one makes our own knowledge old, which is what a
   * feed going quiet actually looks like.
   */
  fastify.post('/api/dev/age', async (req) => {
    guard();
    const body = z
      .object({
        minutes: z.number().min(1).max(60 * 48).default(45),
        symbols: z.array(z.string().max(12)).max(200).optional(),
      })
      .safeParse(req.body ?? {});
    if (!body.success) throw badRequest('invalid age request');

    const symbols =
      body.data.symbols?.map((s) => s.toUpperCase()) ?? (await app.jobs.watchedSymbols());
    const aged = await app.market.backdateQuotes(symbols, body.data.minutes * 60_000);

    // Re-run detection so the staleness signals appear immediately.
    const benchmark = await app.ingest.benchmarkSnapshot();
    let signals = 0;
    for (const symbol of symbols) {
      const quote = await app.market.getQuote(symbol);
      if (!quote) continue;
      const stats = await app.market.getStats(symbol);
      const detected = await app.detection.detect({
        symbol,
        quote,
        stats,
        freshness: app.ingest.freshnessOf(quote, app.clock.now()),
        benchmark:
          benchmark && benchmark.symbol !== symbol
            ? { quote: benchmark.quote, stats: benchmark.stats }
            : null,
        now: app.clock.now(),
      });
      signals += detected.created.length;
    }

    return { aged, minutes: body.data.minutes, signalsCreated: signals };
  });

  /** Trip a provider's circuit breaker by hand. */
  fastify.post('/api/dev/breaker', async (req) => {
    guard();
    const body = z
      .object({
        provider: z.string().min(1).max(40),
        action: z.enum(['trip', 'reset']).default('trip'),
      })
      .safeParse(req.body ?? {});
    if (!body.success) throw badRequest('invalid breaker request');

    if (body.data.action === 'reset') {
      app.registry.resetBreakers();
      return { reset: true, providers: app.registry.health() };
    }

    const tripped = app.registry.tripBreaker(body.data.provider);
    if (!tripped) throw badRequest(`unknown provider: ${body.data.provider}`);
    return { tripped: body.data.provider, providers: app.registry.health() };
  });

  /**
   * Run one scheduler tick synchronously.
   *
   * Lets the demo (and the tests) advance ingestion deterministically instead
   * of waiting on wall-clock timers.
   */
  fastify.post('/api/dev/tick', async () => {
    guard();
    const processed = await app.scheduler.tick(app.clock.now());
    return { processed, stats: await app.scheduler.stats() };
  });

  /**
   * Rewind a user's watermark, to demonstrate "what changed while I was away"
   * without actually waiting.
   */
  fastify.post('/api/dev/rewind', async (req) => {
    guard();
    const body = z
      .object({
        handle: z.string().default('demo'),
        minutes: z.number().min(1).max(60 * 24 * 30).default(30),
      })
      .safeParse(req.body ?? {});
    if (!body.success) throw badRequest('invalid rewind request');

    const user = await app.users.findUserByHandle(body.data.handle);
    if (!user) throw badRequest(`no such user: ${body.data.handle}`);

    const symbols = await app.users.listUserSymbols(user.id);
    const at = app.clock.now() - body.data.minutes * 60_000;
    const quotes = await app.market.getQuotes(symbols);

    // rewindMarks, not advanceMarks: the latter refuses to move a checkpoint
    // backwards, which is exactly the invariant we need to bypass here.
    const moved = await app.users.rewindMarks(
      user.id,
      symbols.map((symbol) => ({ symbol, price: quotes.get(symbol)?.price ?? null })),
      at,
    );

    return { rewoundTo: at, symbols: symbols.length, moved };
  });
}
