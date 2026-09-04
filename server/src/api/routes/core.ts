/**
 * The routes that make up the product.
 *
 * Validation is done with zod at the boundary, so handlers below receive typed,
 * trusted values and every rejection is a 400 with a specific message rather
 * than a 500 from something downstream tripping over a null.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { App } from '../../app.js';
import { badRequest, notFound } from '../errors.js';
import { requireUser, withIdempotency } from '../server.js';
import { SymbolNotFoundError } from '../../providers/types.js';
import { ALL_SIGNAL_KINDS } from '../../services/detection.js';
import { KIND_WEIGHT } from '../../domain/signals/scoring.js';

const Symbol_ = z
  .string()
  .trim()
  .min(1)
  .max(12)
  // Tickers only. Anything else cannot be a symbol, and rejecting it here
  // keeps junk out of the instruments table and out of provider requests.
  .regex(/^[A-Za-z0-9.\-]+$/, 'not a valid ticker')
  .transform((s) => s.toUpperCase());

const SymbolList = z.array(Symbol_).max(1000);

/** `expectedVersion` is optional: a client with no version opts out of the check. */
const Version = z.number().int().nonnegative().optional();

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path.join('.');
    throw badRequest(
      path ? `${path}: ${first?.message ?? 'invalid'}` : (first?.message ?? 'invalid request'),
    );
  }
  return result.data;
}

export async function registerCoreRoutes(fastify: FastifyInstance, app: App): Promise<void> {
  // ─────────────────────────────────────────────────── session

  /**
   * Sign in as the demo user, or create a named account.
   *
   * Deliberately not a password flow. Auth is not what this exercise is
   * about, and a fake login screen would add ceremony without adding safety -
   * so it is an explicit, honest shortcut rather than a half-built one.
   */
  fastify.post('/api/session', async (req) => {
    const body = parse(
      z.object({ handle: z.string().trim().min(1).max(40).default('demo') }),
      req.body ?? {},
    );
    const now = app.clock.now();

    let user = await app.users.findUserByHandle(body.handle);
    if (!user) {
      user = await app.users.createUser(body.handle, now);
      await app.users.createWatchlist(
        user.id,
        'My Watchlist',
        now,
        app.config.limits.maxWatchlistsPerUser,
      );
    }

    const token = await app.users.createSession(user.id, now);
    return { token, user };
  });

  fastify.get('/api/me', async (req) => {
    const user = requireUser(req);
    const [watchlists, lastCheckedAt] = await Promise.all([
      app.users.listWatchlists(user.id),
      app.users.lastCheckedAt(user.id),
    ]);
    return { user, watchlists, lastCheckedAt };
  });

  /** Static metadata the UI needs to render labels and filters. */
  fastify.get('/api/meta', async () => ({
    signalKinds: ALL_SIGNAL_KINDS.map((kind) => ({ kind, weight: KIND_WEIGHT[kind] })),
    thresholds: {
      sigmaEnter: app.config.signals.sigmaEnter,
      sigmaExit: app.config.signals.sigmaExit,
      idioEnter: app.config.signals.idioEnter,
      rvolEnter: app.config.signals.rvolEnter,
    },
    digest: {
      maxItems: app.config.digest.maxItems,
      maxPerSymbol: app.config.digest.maxPerSymbol,
    },
    marketClock: {
      name: app.marketClock.name,
      sessionMs: app.marketClock.sessionLengthMs(),
      simulated: app.marketClock.name === 'simulated',
    },
    providers: app.registry.providerNames,
    devTools: app.config.devTools,
  }));

  // ─────────────────────────────────────────────────── the briefing

  /**
   * The main screen: what changed since you last acknowledged.
   *
   * A GET, and deliberately side-effect-free with respect to the watermark.
   * See ViewService.getDigest.
   */
  fastify.get('/api/digest', async (req) => {
    const user = requireUser(req);
    return app.view.getDigest(user.id, app.clock.now());
  });

  /**
   * Advance the watermark: "I have read this."
   *
   * Idempotent by key, because a retry that advanced the checkpoint twice
   * would skip a briefing the user never saw.
   */
  fastify.post('/api/digest/acknowledge', async (req, reply) => {
    const user = requireUser(req);
    const body = parse(
      z.object({ symbols: SymbolList.optional() }),
      req.body ?? {},
    );

    return withIdempotency(app, req, reply, async () => {
      const result = await app.view.acknowledge(
        user.id,
        body.symbols ?? null,
        app.clock.now(),
      );
      return { ...result, undoable: true };
    });
  });

  /** Restore the previous checkpoint, which makes acknowledging safe to click. */
  fastify.post('/api/digest/undo', async (req) => {
    const user = requireUser(req);
    const body = parse(z.object({ symbols: SymbolList.optional() }), req.body ?? {});
    return app.view.undoAcknowledge(user.id, body.symbols ?? null);
  });

  /** Dismiss individual signals without moving the whole watermark. */
  fastify.post('/api/signals/read', async (req) => {
    const user = requireUser(req);
    const body = parse(
      z.object({ signalIds: z.array(z.string().min(1).max(64)).min(1).max(200) }),
      req.body ?? {},
    );

    // Filter to ids that exist, so a stale client cannot write rows that
    // reference deleted signals and quietly accumulate junk.
    const existing = await app.signals.existingIds(body.signalIds);
    const valid = body.signalIds.filter((id) => existing.has(id));
    const marked = await app.users.markSignalsRead(user.id, valid, app.clock.now());
    return { marked, ignored: body.signalIds.length - valid.length };
  });

  // ─────────────────────────────────────────────────── watchlists

  fastify.get('/api/watchlists', async (req) => {
    const user = requireUser(req);
    const lists = await app.users.listWatchlists(user.id);
    const withItems = await Promise.all(
      lists.map(async (list) => ({
        ...list,
        items: await app.users.listItems(list.id),
      })),
    );
    return { watchlists: withItems };
  });

  fastify.post('/api/watchlists', async (req, reply) => {
    const user = requireUser(req);
    const body = parse(z.object({ name: z.string().trim().min(1).max(60) }), req.body ?? {});
    return withIdempotency(app, req, reply, async () =>
      app.users.createWatchlist(
        user.id,
        body.name,
        app.clock.now(),
        app.config.limits.maxWatchlistsPerUser,
      ),
    );
  });

  fastify.patch('/api/watchlists/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(z.object({ id: z.string().min(1) }), req.params);
    const body = parse(
      z.object({ name: z.string().trim().min(1).max(60), expectedVersion: Version }),
      req.body ?? {},
    );
    return app.users.renameWatchlist(id, user.id, body.name, body.expectedVersion ?? null);
  });

  fastify.delete('/api/watchlists/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(z.object({ id: z.string().min(1) }), req.params);
    const deleted = await app.users.deleteWatchlist(id, user.id);
    if (!deleted) throw notFound('watchlist');
    return { deleted: true };
  });

  /**
   * The watchlist table. `id` may be omitted to see every symbol the user
   * watches across all their lists.
   */
  fastify.get('/api/watchlists/:id/rows', async (req) => {
    const user = requireUser(req);
    const { id } = parse(z.object({ id: z.string().min(1) }), req.params);
    const result = await app.view.getWatchlistRows(
      user.id,
      id === 'all' ? null : id,
      app.clock.now(),
    );
    if (id !== 'all' && !result.watchlist) throw notFound('watchlist');
    return result;
  });

  // ─────────────────────────────────────────────────── items

  /**
   * Add a symbol.
   *
   * Seeding history happens *before* the item is inserted. If it were the
   * other way round, the row would appear in the user's list with no
   * statistics behind it, and the first thing they would see is a symbol the
   * product refuses to say anything about.
   */
  fastify.post('/api/watchlists/:id/items', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(z.object({ id: z.string().min(1) }), req.params);
    const body = parse(
      z.object({ symbol: Symbol_, expectedVersion: Version }),
      req.body ?? {},
    );

    return withIdempotency(app, req, reply, async () => {
      const now = app.clock.now();

      try {
        await app.ingest.ensureInstrument(body.symbol, now, {
          pollIntervalMs: app.config.ingest.hotIntervalMs,
        });
      } catch (err) {
        if (err instanceof SymbolNotFoundError) throw err;
        // A provider hiccup should not block adding a symbol we already know
        // about; the scheduler will fill in the data shortly.
        const known = await app.market.getInstrument(body.symbol);
        if (!known) throw err;
      }

      const result = await app.users.addItem(
        id,
        user.id,
        body.symbol,
        now,
        body.expectedVersion ?? null,
        app.config.limits.maxSymbolsPerWatchlist,
      );

      // Poll it immediately rather than waiting for its turn in the queue.
      await app.jobs.expedite(body.symbol, now);

      return result;
    });
  });

  fastify.delete('/api/watchlists/:id/items/:symbol', async (req) => {
    const user = requireUser(req);
    const { id, symbol } = parse(
      z.object({ id: z.string().min(1), symbol: Symbol_ }),
      req.params,
    );
    const version = parse(
      z.object({ expectedVersion: z.coerce.number().int().nonnegative().optional() }),
      req.query ?? {},
    );
    const result = await app.users.removeItem(
      id,
      user.id,
      symbol,
      version.expectedVersion ?? null,
    );
    if (!result.removed) throw notFound(`${symbol} in watchlist`);
    return result;
  });

  /** Per-symbol preferences: pin, mute, and a personal significance floor. */
  fastify.patch('/api/watchlists/:id/items/:symbol', async (req) => {
    const user = requireUser(req);
    const { id, symbol } = parse(
      z.object({ id: z.string().min(1), symbol: Symbol_ }),
      req.params,
    );
    const body = parse(
      z.object({
        pinned: z.boolean().optional(),
        muted: z.boolean().optional(),
        minSigma: z.number().min(0).max(20).nullable().optional(),
        note: z.string().max(500).nullable().optional(),
        expectedVersion: Version,
      }),
      req.body ?? {},
    );

    const { expectedVersion, ...patch } = body;
    return app.users.updateItem(id, user.id, symbol, patch, expectedVersion ?? null);
  });

  fastify.post('/api/watchlists/:id/reorder', async (req) => {
    const user = requireUser(req);
    const { id } = parse(z.object({ id: z.string().min(1) }), req.params);
    const body = parse(
      z.object({ order: SymbolList.min(1), expectedVersion: Version }),
      req.body ?? {},
    );
    return app.users.reorder(id, user.id, body.order, body.expectedVersion ?? null);
  });

  // ─────────────────────────────────────────────────── symbols

  fastify.get('/api/symbols/search', async (req) => {
    const q = parse(
      z.object({ q: z.string().trim().min(1).max(40), limit: z.coerce.number().int().min(1).max(50).default(12) }),
      req.query ?? {},
    );
    const results = await app.market.searchInstruments(q.q, q.limit);
    return { results };
  });

  /** Everything about one symbol, for the detail view. */
  fastify.get('/api/symbols/:symbol', async (req) => {
    const user = requireUser(req);
    const { symbol } = parse(z.object({ symbol: Symbol_ }), req.params);
    const now = app.clock.now();

    const instrument = await app.market.getInstrument(symbol);
    if (!instrument) throw notFound(symbol);

    const [quote, stats, bars, signals, marks] = await Promise.all([
      app.market.getQuote(symbol),
      app.market.getStats(symbol),
      app.market.getBars(symbol, 180),
      app.signals.listBySymbol(symbol, 40),
      app.users.getMarks(user.id, [symbol]),
    ]);

    // Opening a symbol is the strongest possible signal of attention, so
    // promote it and pull its next poll forward.
    await app.jobs.touchActivity([symbol], now);
    await app.jobs.expedite(symbol, now);

    return {
      instrument,
      quote,
      freshness: quote ? app.ingest.freshnessOf(quote, now) : 'unknown',
      stats,
      bars,
      signals,
      mark: marks.get(symbol) ?? null,
      job: await app.jobs.getJob(symbol),
    };
  });

  /** Force an immediate refresh of one symbol - the manual "check now". */
  fastify.post('/api/symbols/:symbol/refresh', async (req) => {
    requireUser(req);
    const { symbol } = parse(z.object({ symbol: Symbol_ }), req.params);
    const now = app.clock.now();
    const benchmark = await app.ingest.benchmarkSnapshot();
    const result = await app.ingest.refresh(symbol, now, benchmark);
    return result;
  });
}
