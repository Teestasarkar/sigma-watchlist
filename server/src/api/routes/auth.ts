/**
 * Authentication routes.
 *
 * The behaviours worth defending, because each one is a real attack that the
 * obvious implementation permits:
 *
 *  - **One error message for every login failure.** "No such user" versus
 *    "wrong password" hands an attacker a free account-enumeration oracle.
 *  - **Constant-ish response time.** A missing account still pays for a hash,
 *    or the *timing* leaks what the message refused to say.
 *  - **Throttling in the database.** A process-local counter is defeated by
 *    waiting for a deploy or hitting another replica.
 *  - **Registration does not reveal that a handle is taken** by a different
 *    route than a wrong password does. Both are "that name is taken" — which
 *    is unavoidable for a chosen display name, and is the reason a real
 *    product would use an email address plus a verification step here.
 *  - **Changing a password revokes other sessions.** Otherwise a change
 *    achieves nothing against someone who already holds a token.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { App } from '../../app.js';
import { ApiError, badRequest, unauthorized } from '../errors.js';
import { requireUser } from '../server.js';
import {
  checkPasswordStrength,
  fakeVerify,
  hashPassword,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  needsRehash,
  verifyPassword,
} from '../../infra/password.js';
import { STARTER_SYMBOLS } from '../../providers/universe.js';
import { createLogger } from '../../infra/logger.js';

const log = createLogger('auth');

/** Session lifetime. Long enough to be convenient, short enough to expire. */
const SESSION_TTL_MS = 30 * 24 * 3600_000;

/**
 * Deliberately identical for every failure mode.
 *
 * The moment this differs between "unknown handle" and "wrong password",
 * anyone can enumerate which accounts exist.
 */
const LOGIN_FAILED = 'That username and password do not match.';

const Handle = z
  .string()
  .trim()
  .min(2, 'Use at least 2 characters.')
  .max(40, 'Keep it under 40 characters.')
  .regex(
    /^[A-Za-z0-9._-]+$/,
    'Letters, numbers, dots, dashes and underscores only.',
  );

const Password = z.string().min(1).max(MAX_PASSWORD_LENGTH + 1);

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const first = result.error.issues[0];
    throw badRequest(first?.message ?? 'invalid request');
  }
  return result.data;
}

const clientMeta = (req: FastifyRequest): { userAgent: string | null; ip: string | null } => ({
  userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
  ip: req.ip ?? null,
});

export async function registerAuthRoutes(fastify: FastifyInstance, app: App): Promise<void> {
  // ─────────────────────────────────────────────────── register

  fastify.post('/api/auth/register', async (req, reply) => {
    const body = parse(
      z.object({ handle: Handle, password: Password }),
      req.body ?? {},
    );
    const now = app.clock.now();

    const strength = checkPasswordStrength(body.password, body.handle);
    if (!strength.ok) throw badRequest(strength.reason);

    const existing = await app.auth.findAccount(body.handle);
    if (existing) {
      // Unavoidable for a chosen display name. A real product would key
      // accounts on a verified email so this leaks nothing.
      throw new ApiError('conflict', 'That username is already taken.');
    }

    const hash = await hashPassword(body.password);
    const user = await app.auth.createAccount(body.handle, hash, now);

    const list = await app.users.createWatchlist(
      user.id,
      'My Watchlist',
      now,
      app.config.limits.maxWatchlistsPerUser,
    );

    /*
     * Seed a starter watchlist.
     *
     * This product needs price history before it can say anything at all, so
     * an empty first screen would be followed immediately by a second one
     * reading "insufficient history". The starter set mixes volatility regimes
     * so the significance ranking has something to prove.
     *
     * Best-effort per symbol: a provider hiccup must not fail a registration
     * that has already created the account.
     */
    for (const symbol of STARTER_SYMBOLS) {
      try {
        await app.ingest.ensureInstrument(symbol, now, {
          pollIntervalMs: app.config.ingest.warmIntervalMs,
        });
        await app.users.addItem(
          list.id,
          user.id,
          symbol,
          now,
          null,
          app.config.limits.maxSymbolsPerWatchlist,
        );
      } catch {
        // Skip it; the rest still work and the user can add it by hand.
      }
    }

    const session = await app.auth.createSession(user.id, now, SESSION_TTL_MS, clientMeta(req));
    log.info('account created', { handle: user.handle });

    void reply.code(201);
    return { token: session.token, expiresAt: session.expiresAt, user, isNew: true };
  });

  // ─────────────────────────────────────────────────── login

  fastify.post('/api/auth/login', async (req) => {
    const body = parse(z.object({ handle: Handle, password: Password }), req.body ?? {});
    const now = app.clock.now();

    const account = await app.auth.findAccount(body.handle);

    if (!account) {
      // Pay the hashing cost anyway, so a missing account is not detectable by
      // how fast we say no.
      await fakeVerify();
      throw unauthorized(LOGIN_FAILED);
    }

    if (account.lockedUntil !== null && account.lockedUntil > now) {
      const seconds = Math.ceil((account.lockedUntil - now) / 1000);
      throw new ApiError(
        'rate_limited',
        `Too many failed attempts. Try again in ${seconds < 60 ? `${seconds} seconds` : `${Math.ceil(seconds / 60)} minutes`}.`,
        { retryAfterSeconds: seconds },
      );
    }

    const ok = await verifyPassword(body.password, account.passwordHash);

    if (!ok) {
      const lockedUntil = await app.auth.recordFailedLogin(account.id, now);
      log.warn('failed login', { handle: account.handle, locked: lockedUntil !== null });
      // Same message and shape as an unknown account.
      throw unauthorized(LOGIN_FAILED);
    }

    await app.auth.clearFailedLogins(account.id);

    /*
     * Transparent rehash.
     *
     * A successful login is the one moment we hold the plaintext, so if the
     * cost parameters have been raised since this password was set, this is
     * where it gets upgraded - without anyone being asked to do anything.
     */
    if (needsRehash(account.passwordHash)) {
      const upgraded = await hashPassword(body.password);
      await app.auth.setPassword(account.id, upgraded, now, undefined);
      log.info('password rehashed at current cost', { handle: account.handle });
    }

    const session = await app.auth.createSession(account.id, now, SESSION_TTL_MS, clientMeta(req));

    return {
      token: session.token,
      expiresAt: session.expiresAt,
      user: { id: account.id, handle: account.handle, createdAt: account.createdAt },
      isNew: false,
    };
  });

  // ─────────────────────────────────────────────────── logout

  fastify.post('/api/auth/logout', async (req) => {
    const token = bearer(req);
    if (!token) return { revoked: 0 };
    const revoked = await app.auth.revokeSession(token);
    return { revoked: revoked ? 1 : 0 };
  });

  /** Sign out everywhere — the thing you want after losing a laptop. */
  fastify.post('/api/auth/logout-all', async (req) => {
    const user = requireUser(req);
    const revoked = await app.auth.revokeAllSessions(user.id);
    log.info('all sessions revoked', { handle: user.handle, count: revoked });
    return { revoked };
  });

  // ─────────────────────────────────────────────────── password change

  fastify.post('/api/auth/password', async (req) => {
    const user = requireUser(req);
    const body = parse(
      z.object({ currentPassword: Password, newPassword: Password }),
      req.body ?? {},
    );
    const now = app.clock.now();

    const account = await app.auth.findAccount(user.handle);
    if (!account) throw unauthorized();

    // Re-authenticate. A live session is not sufficient authority to change
    // the credential that guards it.
    const ok = await verifyPassword(body.currentPassword, account.passwordHash);
    if (!ok) {
      await app.auth.recordFailedLogin(account.id, now);
      throw unauthorized('Your current password is not correct.');
    }

    const strength = checkPasswordStrength(body.newPassword, user.handle);
    if (!strength.ok) throw badRequest(strength.reason);

    if (await verifyPassword(body.newPassword, account.passwordHash)) {
      throw badRequest('That is the password you are already using.');
    }

    const hash = await hashPassword(body.newPassword);
    // Keep this session alive, revoke every other one.
    const revoked = await app.auth.setPassword(account.id, hash, now, bearer(req) ?? undefined);

    log.info('password changed', { handle: user.handle, otherSessionsRevoked: revoked });
    return { changed: true, otherSessionsRevoked: revoked };
  });

  // ─────────────────────────────────────────────────── sessions

  /** Where am I signed in? The current session is flagged. */
  fastify.get('/api/auth/sessions', async (req) => {
    const user = requireUser(req);
    const current = bearer(req);
    const sessions = await app.auth.listSessions(user.id, app.clock.now());

    return {
      sessions: sessions.map((s) => ({
        // Never return the raw token of another session; a fingerprint is
        // enough to identify a row in a list and useless if intercepted.
        id: s.token.slice(-6),
        current: s.token === current,
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
        expiresAt: s.expiresAt,
        userAgent: s.userAgent,
      })),
    };
  });

  /** Password requirements, so the client can validate before submitting. */
  fastify.get('/api/auth/policy', async () => ({
    minPasswordLength: MIN_PASSWORD_LENGTH,
    maxPasswordLength: MAX_PASSWORD_LENGTH,
    handlePattern: '^[A-Za-z0-9._-]{2,40}$',
    sessionTtlMs: SESSION_TTL_MS,
    /**
     * Published on purpose. The demo account's credentials are not a secret -
     * it exists so a reviewer can look around without registering, and
     * pretending otherwise would be security theatre.
     */
    demo: app.config.devTools
      ? { handle: 'demo', password: app.config.demoPassword }
      : null,
  }));
}

function bearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  if (!header.toLowerCase().startsWith('bearer ')) return null;
  const token = header.slice(7).trim();
  return token === '' ? null : token;
}
