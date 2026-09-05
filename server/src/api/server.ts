/**
 * The HTTP surface.
 *
 * Three cross-cutting concerns are handled once, here, rather than repeated in
 * every handler:
 *
 *  - **Authentication**, as a bearer token resolved to a user.
 *  - **Idempotency**, so a retried POST cannot apply twice. Mobile clients on
 *    flaky connections retry; without this, "add symbol" and "acknowledge"
 *    would double-apply and the watermark would jump two checkpoints.
 *  - **Error translation**, so domain errors (a version conflict, a limit, an
 *    unknown symbol) become the right status code with a stable error code,
 *    and unexpected errors never leak a stack trace to the client.
 */

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';

import type { App } from '../app.js';
import { ApiError, badRequest, unauthorized } from './errors.js';
import { ConcurrencyError, LimitError, NotFoundError } from '../db/userRepo.js';
import { AllProvidersFailedError } from '../providers/registry.js';
import { SymbolNotFoundError } from '../providers/types.js';
import { TokenBucket } from '../infra/resilience.js';
import { createLogger } from '../infra/logger.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerCoreRoutes } from './routes/core.js';
import { registerOpsRoutes } from './routes/ops.js';
import type { User } from '../domain/types.js';

const log = createLogger('http');

/** Must match auth.ts. Sessions live 30 days. */
const SESSION_TTL_MS = 30 * 24 * 3600_000;
/** Slide the expiry once a session is inside its final 15 days. */
const SESSION_SLIDE_AFTER_MS = 15 * 24 * 3600_000;

declare module 'fastify' {
  interface FastifyRequest {
    /** Populated by the auth hook for routes under /api that require a user. */
    currentUser?: User;
  }
}

export interface ServerDeps {
  app: App;
}

/**
 * Routes that need no bearer token.
 *
 * Kept as an explicit allow-list rather than a deny-list, so a new route is
 * private by default. Forgetting to protect a route should be impossible;
 * forgetting to *un*protect one is merely annoying.
 */
const PUBLIC_PATHS = new Set([
  '/api/health',
  '/api/meta',
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/logout',
  '/api/auth/policy',
]);

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { app } = deps;

  const fastify = Fastify({
    logger: false,
    // Trust the proxy so rate limiting keys on the real client address behind
    // a platform load balancer rather than on the balancer itself.
    trustProxy: true,
    bodyLimit: 256 * 1024,
    // Generate a request id we can echo, for correlating client reports.
    genReqId: () => Math.random().toString(36).slice(2, 10),
  });

  /*
   * Treat an empty body as `{}` for JSON requests.
   *
   * Fastify's default parser rejects a zero-length body with 400 when the
   * content-type says JSON. That is defensible in the abstract and hostile in
   * practice: every HTTP client that sets a default `content-type:
   * application/json` on all POSTs - which is most of them, including the one
   * in this repo's frontend - then breaks on precisely the endpoints that need
   * no body, like `refresh` and `faults/reset`. Accepting an empty body as an
   * empty object costs nothing and removes a whole category of confusing 400s.
   */
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      const text = typeof body === 'string' ? body.trim() : '';
      if (text === '') {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(text));
      } catch (err) {
        // Fastify turns this into a 400 via the error handler.
        done(err as Error, undefined);
      }
    },
  );

  // ── CORS ────────────────────────────────────────────────────────────
  //
  // Hand-rolled rather than a plugin: the policy is four lines and the
  // frontend is either same-origin (production) or a known dev origin.
  const allowedOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  fastify.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (typeof origin === 'string') {
      const allow =
        allowedOrigins.includes('*') ||
        allowedOrigins.includes(origin) ||
        /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
      if (allow) {
        reply.header('Access-Control-Allow-Origin', origin);
        reply.header('Vary', 'Origin');
        reply.header('Access-Control-Allow-Headers', 'content-type, authorization, idempotency-key');
        reply.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
        reply.header('Access-Control-Max-Age', '86400');
      }
    }
    if (req.method === 'OPTIONS') {
      await reply.code(204).send();
    }
  });

  // ── Rate limiting ───────────────────────────────────────────────────
  //
  // Per-caller token buckets, evicted when idle. This protects the database
  // and the upstream providers from one enthusiastic client; it is not a
  // security boundary.
  const buckets = new Map<string, { bucket: TokenBucket; lastSeen: number }>();
  const RATE = app.config.limits.apiRatePerMin;

  fastify.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api')) return;

    const key = (req.headers.authorization ?? req.ip ?? 'anon').slice(0, 128);
    const now = app.clock.now();

    let entry = buckets.get(key);
    if (!entry) {
      entry = { bucket: new TokenBucket(RATE, RATE / 60, app.clock), lastSeen: now };
      buckets.set(key, entry);
    }
    entry.lastSeen = now;

    // Opportunistic eviction, so the map cannot grow without bound.
    if (buckets.size > 5000) {
      for (const [k, v] of buckets) {
        if (now - v.lastSeen > 10 * 60_000) buckets.delete(k);
      }
    }

    if (!entry.bucket.tryTake()) {
      const waitMs = entry.bucket.waitMs();
      reply.header('Retry-After', Math.ceil(waitMs / 1000));
      throw new ApiError('rate_limited', 'too many requests');
    }
  });

  // ── Authentication ──────────────────────────────────────────────────
  fastify.addHook('preHandler', async (req) => {
    if (!req.url.startsWith('/api')) return;
    const path = req.url.split('?')[0] ?? '';
    if (PUBLIC_PATHS.has(path)) return;
    if (path.startsWith('/api/dev/')) return;

    const header = req.headers.authorization;
    const token =
      typeof header === 'string' && header.toLowerCase().startsWith('bearer ')
        ? header.slice(7).trim()
        : null;

    if (!token) throw unauthorized('missing bearer token');

    /*
     * Resolve through AuthRepo, which refuses expired sessions. A token that
     * never expires is a token that leaks - so every session carries a
     * lifetime, and using one slides it forward rather than making people log
     * in again mid-session.
     */
    const now = app.clock.now();
    const user = await app.auth.resolveSession(token, now);
    if (!user) throw unauthorized('Your session has expired. Please sign in again.');

    req.currentUser = { id: user.id, handle: user.handle, createdAt: user.createdAt };

    // Slide the expiry when a session is more than halfway through its life,
    // so an active user is never logged out, without writing on every request.
    if (user.expiresAt !== null && user.expiresAt - now < SESSION_SLIDE_AFTER_MS) {
      void app.auth.slideExpiry(token, now, SESSION_TTL_MS).catch(() => undefined);
    }
  });

  // ── Error translation ───────────────────────────────────────────────
  fastify.setErrorHandler((err, req, reply) => {
    const translated = translate(err);

    if (translated.status >= 500) {
      // Log the real error server-side; return only the sanitised one.
      log.error('request failed', {
        reqId: req.id,
        method: req.method,
        url: req.url,
        err: err instanceof Error ? (err.stack ?? err.message) : String(err),
      });
    } else {
      log.debug('request rejected', {
        reqId: req.id,
        url: req.url,
        code: translated.code,
      });
    }

    void reply
      .code(translated.status)
      .header('x-request-id', String(req.id))
      .send(translated.toBody());
  });

  // ── Routes ──────────────────────────────────────────────────────────
  await registerAuthRoutes(fastify, app);
  await registerCoreRoutes(fastify, app);
  await registerOpsRoutes(fastify, app);

  /*
   * Serving the built frontend from the API process gives production a single
   * origin, which removes CORS from the deployment entirely - and on free
   * hosting, removes a whole second service.
   */
  let serveStatic = false;
  if (app.config.serveWeb) {
    const staticPlugin = await import('@fastify/static');
    const { resolve } = await import('node:path');
    const root = resolve(process.cwd(), process.env.WEB_ROOT ?? '../web/dist');
    /*
     * `wildcard: true` (the default) resolves files per request. The
     * alternative snapshots the directory at boot and registers a route per
     * file, which means any asset written after startup 404s - and because the
     * SPA fallback used to answer those with index.html, the symptom was a
     * blank page and a MIME-type error rather than anything pointing at the
     * cause.
     */
    await fastify.register(staticPlugin.default, { root, wildcard: true });
    serveStatic = true;
  }

  /*
   * Exactly one not-found handler.
   *
   * Fastify permits a single handler per prefix, so this has to cover both
   * cases rather than being registered twice - which is a startup crash that
   * only appears when SERVE_WEB is on, i.e. only in production.
   *
   * An unmatched /api path is always JSON: a client parsing a 404 must not
   * suddenly receive HTML. Anything else falls back to index.html so that
   * client-side routes survive a hard refresh.
   */
  fastify.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?')[0] ?? '';

    /*
     * Only *navigations* fall back to index.html.
     *
     * A blanket fallback is the obvious implementation and it is wrong: a
     * request for a missing `/assets/index-abc123.js` gets index.html back,
     * the browser refuses it with "expected a JavaScript module, got
     * text/html", and the whole app renders blank with no clue in the network
     * tab that anything 404'd. That happens for real whenever a client is
     * holding a cached page that references assets a newer deploy has renamed.
     *
     * So anything that looks like a file, and anything that did not ask for
     * HTML, gets an honest 404.
     */
    const looksLikeAsset = /\.[a-z0-9]+$/i.test(path);
    const wantsHtml = (req.headers.accept ?? '').includes('text/html');

    if (!serveStatic || path.startsWith('/api') || looksLikeAsset || !wantsHtml) {
      void reply.code(404).send({
        error: { code: 'not_found', message: `no route for ${req.method} ${path}` },
      });
      return;
    }

    void reply.sendFile('index.html');
  });

  return fastify;
}

/** Map any thrown value onto the API's error vocabulary. */
function translate(err: unknown): ApiError {
  if (err instanceof ApiError) return err;

  if (err instanceof ConcurrencyError) {
    return new ApiError(
      'conflict',
      err.message,
      // Hand back the current version so the client can retry immediately
      // rather than having to re-fetch to discover it.
      { expectedVersion: err.expected, currentVersion: err.actual },
    );
  }

  if (err instanceof LimitError) return new ApiError('limit_exceeded', err.message);
  if (err instanceof NotFoundError) return new ApiError('not_found', err.message);
  if (err instanceof SymbolNotFoundError) {
    return new ApiError('symbol_unknown', `no market data available for ${err.symbol}`, {
      symbol: err.symbol,
    });
  }
  if (err instanceof AllProvidersFailedError) {
    return new ApiError('upstream_unavailable', err.message, { symbol: err.symbol });
  }

  // Fastify's own validation and parse errors.
  const maybe = err as { statusCode?: number; code?: string; message?: string };
  if (typeof maybe.statusCode === 'number' && maybe.statusCode < 500) {
    return badRequest(maybe.message ?? 'invalid request');
  }

  return new ApiError('internal', 'internal server error');
}

// ─────────────────────────────────────────────────────────── idempotency

/**
 * Replay protection for a mutating request.
 *
 * Returns the stored response when the same key and body are seen again, and
 * rejects when the same key arrives with a *different* body - which is a
 * client bug that would otherwise silently swallow the second intent.
 *
 * The handler is only run for a genuinely new key, and its response is stored
 * so the retry is answered identically.
 */
export async function withIdempotency<T>(
  app: App,
  req: FastifyRequest,
  reply: FastifyReply,
  handler: () => Promise<T>,
): Promise<T | undefined> {
  const key = req.headers['idempotency-key'];
  const user = req.currentUser;

  if (typeof key !== 'string' || key.trim() === '' || !user) {
    return handler();
  }

  const trimmed = key.trim().slice(0, 200);
  const requestHash = createHash('sha256')
    .update(JSON.stringify({ body: req.body ?? null, url: req.url }))
    .digest('hex')
    .slice(0, 32);

  const existing = await app.jobs.getIdempotent(trimmed, user.id);
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new ApiError(
        'idempotency_mismatch',
        'this Idempotency-Key was already used with a different request body',
      );
    }
    void reply
      .code(existing.status)
      .header('idempotent-replay', 'true')
      .send(JSON.parse(existing.response));
    return undefined;
  }

  const result = await handler();

  await app.jobs.putIdempotent({
    key: trimmed,
    userId: user.id,
    method: req.method,
    path: req.url,
    requestHash,
    status: reply.statusCode ?? 200,
    response: JSON.stringify(result ?? null),
    now: app.clock.now(),
  });

  return result;
}

/** Require an authenticated user, for handlers on protected routes. */
export function requireUser(req: FastifyRequest): User {
  const user = req.currentUser;
  if (!user) throw unauthorized();
  return user;
}
