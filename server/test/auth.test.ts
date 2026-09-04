/**
 * Authentication, end to end against the real stack.
 *
 * Every test here corresponds to an attack the obvious implementation permits.
 * The account-enumeration and lockout cases in particular are the ones that
 * distinguish "there is a login form" from "there is authentication".
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp, type App } from '../src/app.js';
import { buildServer } from '../src/api/server.js';
import { config as baseConfig } from '../src/config.js';
import { ManualClock } from '../src/infra/clock.js';

const clock = new ManualClock(Date.now());

/** Strong enough to pass the real strength rules. */
const GOOD = 'quiet-river-lantern-42';

const config = {
  ...baseConfig,
  databaseUrl: '',
  devTools: true,
  ingest: { ...baseConfig.ingest, enabled: false },
  providers: { ...baseConfig.providers, enabled: ['synthetic'], syntheticSessionMs: 60_000 },
} as typeof baseConfig;

let app: App;
let server: FastifyInstance;

/** Unique per call, so tests never collide on a username. */
let seq = 0;
const uniqueHandle = (prefix: string): string => `${prefix}${Date.now()}${seq++}`;

async function call(
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const res = await server.inject({
    method,
    url,
    headers,
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

const asUser = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

const register = async (handle: string, password = GOOD) =>
  call('POST', '/api/auth/register', { handle, password });

const login = async (handle: string, password: string) =>
  call('POST', '/api/auth/login', { handle, password });

beforeAll(async () => {
  app = await buildApp({ config, clock, inMemory: true });
  await app.bootstrap();
  server = await buildServer({ app });
  await server.ready();
}, 180_000);

afterAll(async () => {
  await server?.close();
  await app?.shutdown();
});

describe('registration', () => {
  it('creates an account and returns a session', async () => {
    const res = await register(uniqueHandle('new'));
    expect(res.status).toBe(201);
    expect(res.body.isNew).toBe(true);
    expect(typeof res.body.token).toBe('string');
    // A token that never expires is a token that leaks.
    expect(res.body.expiresAt).toBeGreaterThan(clock.now());
  });

  it('seeds a starter watchlist, so the first screen is not empty', async () => {
    const res = await register(uniqueHandle('seeded'));
    const rows = await call('GET', '/api/watchlists/all/rows', undefined, asUser(res.body.token));
    expect(rows.body.rows.length).toBeGreaterThan(0);
    // This product needs history before it can say anything at all.
    expect(rows.body.rows.every((r: { stats: { bars: number } | null }) => (r.stats?.bars ?? 0) > 100)).toBe(true);
  });

  it('refuses a username that is not a username', async () => {
    for (const handle of ['drop table users;--', 'a', 'has spaces', 'e@mail.com', '../etc']) {
      const res = await call('POST', '/api/auth/register', { handle, password: GOOD });
      expect(res.status, handle).toBe(400);
    }
  });

  it('refuses a taken username', async () => {
    const handle = uniqueHandle('taken');
    expect((await register(handle)).status).toBe(201);
    expect((await register(handle)).status).toBe(409);
  });

  it('treats usernames case-insensitively', async () => {
    // Otherwise two people each believe they own the name, and one is quietly
    // locked out of their own watchlist.
    const handle = uniqueHandle('MixedCase');
    expect((await register(handle)).status).toBe(201);
    expect((await register(handle.toUpperCase())).status).toBe(409);
    expect((await login(handle.toLowerCase(), GOOD)).status).toBe(200);
  });

  it('refuses the passwords people actually pick', async () => {
    const weak = await call('POST', '/api/auth/register', {
      handle: uniqueHandle('weak'),
      password: 'password',
    });
    expect(weak.status).toBe(400);
    expect(weak.body.error.message).toMatch(/commonly used/i);
  });

  it('refuses a password built from the username', async () => {
    const handle = uniqueHandle('samesame');
    const res = await call('POST', '/api/auth/register', { handle, password: `${handle}xx` });
    expect(res.status).toBe(400);
  });

  it('refuses a password that is too short', async () => {
    const res = await call('POST', '/api/auth/register', {
      handle: uniqueHandle('short'),
      password: 'abc123',
    });
    expect(res.status).toBe(400);
  });
});

describe('login', () => {
  it('accepts the right password', async () => {
    const handle = uniqueHandle('ok');
    const created = await register(handle);
    const res = await login(handle, GOOD);

    expect(res.status).toBe(200);
    expect(res.body.isNew).toBe(false);
    expect(res.body.user.id).toBe(created.body.user.id);
    // A second device is a second token row, not a second account.
    expect(res.body.token).not.toBe(created.body.token);
  });

  it('rejects the wrong password', async () => {
    const handle = uniqueHandle('bad');
    await register(handle);
    expect((await login(handle, 'not-the-password')).status).toBe(401);
  });

  it('answers identically for a wrong password and a missing account', async () => {
    /*
     * The account-enumeration defence.
     *
     * If these differed in status, code or message, anyone could discover
     * which usernames exist simply by reading the error. The server also pays
     * the full hashing cost for a missing account, so the *timing* does not
     * give away what the message refuses to.
     */
    const handle = uniqueHandle('enum');
    await register(handle);

    const wrongPassword = await login(handle, 'definitely-not-it');
    const noSuchAccount = await login(uniqueHandle('ghost'), 'definitely-not-it');

    expect(wrongPassword.status).toBe(noSuchAccount.status);
    expect(wrongPassword.body.error.code).toBe(noSuchAccount.body.error.code);
    expect(wrongPassword.body.error.message).toBe(noSuchAccount.body.error.message);
  });

  it('does not leak whether an account exists through timing', async () => {
    const handle = uniqueHandle('timing');
    await register(handle);

    const time = async (fn: () => Promise<unknown>): Promise<number> => {
      const started = performance.now();
      await fn();
      return performance.now() - started;
    };

    const existing = await time(() => login(handle, 'wrong-password-here'));
    const missing = await time(() => login(uniqueHandle('ghost'), 'wrong-password-here'));

    // Both pay for a hash, so neither should be an order of magnitude faster.
    // Generous bounds - this asserts "same ballpark", not a constant.
    const ratio = Math.max(existing, missing) / Math.max(1, Math.min(existing, missing));
    expect(ratio).toBeLessThan(6);
  });

  it('locks the account after repeated failures', async () => {
    const handle = uniqueHandle('lock');
    await register(handle);

    let last = { status: 0, body: null as any };
    for (let i = 0; i < 7; i++) {
      last = await login(handle, `guess-${i}`);
    }

    expect(last.status).toBe(429);
    expect(last.body.error.code).toBe('rate_limited');
    expect(typeof last.body.error.retryAfterSeconds).toBe('number');
  });

  it('applies the lockout to the correct password too', async () => {
    // Otherwise it is not a lockout, it is a hint.
    const handle = uniqueHandle('lockreal');
    await register(handle);
    for (let i = 0; i < 7; i++) await login(handle, `guess-${i}`);

    expect((await login(handle, GOOD)).status).toBe(429);
  });

  it('clears the failure streak on a successful login', async () => {
    const handle = uniqueHandle('recover');
    await register(handle);

    // Stay under the threshold, then succeed.
    for (let i = 0; i < 3; i++) await login(handle, `guess-${i}`);
    expect((await login(handle, GOOD)).status).toBe(200);

    // The streak is reset, so three more failures must not lock it.
    for (let i = 0; i < 3; i++) await login(handle, `guess-${i}`);
    expect((await login(handle, GOOD)).status).toBe(200);
  });
});

describe('sessions', () => {
  it('sign-out revokes the token server-side', async () => {
    const handle = uniqueHandle('bye');
    const reg = await register(handle);
    const auth = asUser(reg.body.token);

    expect((await call('GET', '/api/me', undefined, auth)).status).toBe(200);
    await call('POST', '/api/auth/logout', {}, auth);
    // Forgetting a token client-side is not signing out.
    expect((await call('GET', '/api/me', undefined, auth)).status).toBe(401);
  });

  it('lists devices, flags the current one, and never returns raw tokens', async () => {
    const handle = uniqueHandle('devices');
    const first = await register(handle);
    await login(handle, GOOD);

    const res = await call('GET', '/api/auth/sessions', undefined, asUser(first.body.token));
    expect(res.body.sessions.length).toBeGreaterThanOrEqual(2);
    expect(res.body.sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1);

    for (const s of res.body.sessions) {
      expect(s).not.toHaveProperty('token');
      expect(String(s.id).length).toBeLessThanOrEqual(6);
    }
  });

  it('signs out everywhere', async () => {
    const handle = uniqueHandle('nuke');
    const a = await register(handle);
    const b = await login(handle, GOOD);

    await call('POST', '/api/auth/logout-all', {}, asUser(a.body.token));

    for (const token of [a.body.token, b.body.token]) {
      expect((await call('GET', '/api/me', undefined, asUser(token))).status).toBe(401);
    }
  });

  it('refuses an expired session', async () => {
    const handle = uniqueHandle('expiry');
    const reg = await register(handle);
    const auth = asUser(reg.body.token);

    expect((await call('GET', '/api/me', undefined, auth)).status).toBe(200);

    // Past the 30-day lifetime.
    clock.advance(31 * 24 * 3600_000);
    expect((await call('GET', '/api/me', undefined, auth)).status).toBe(401);

    clock.advance(-31 * 24 * 3600_000);
  });
});

describe('changing a password', () => {
  it('requires the current password', async () => {
    // A live session is not sufficient authority to change the credential that
    // guards it — a borrowed laptop must not be enough.
    const handle = uniqueHandle('noproof');
    const reg = await register(handle);
    const res = await call(
      'POST',
      '/api/auth/password',
      { currentPassword: 'wrong', newPassword: 'a-fine-new-passphrase' },
      asUser(reg.body.token),
    );
    expect(res.status).toBe(401);
  });

  it('refuses a weak new password', async () => {
    const handle = uniqueHandle('weaknew');
    const reg = await register(handle);
    const res = await call(
      'POST',
      '/api/auth/password',
      { currentPassword: GOOD, newPassword: '12345678' },
      asUser(reg.body.token),
    );
    expect(res.status).toBe(400);
  });

  it('refuses the password already in use', async () => {
    const handle = uniqueHandle('samepw');
    const reg = await register(handle);
    const res = await call(
      'POST',
      '/api/auth/password',
      { currentPassword: GOOD, newPassword: GOOD },
      asUser(reg.body.token),
    );
    expect(res.status).toBe(400);
  });

  it('revokes every other session but keeps the one making the change', async () => {
    const handle = uniqueHandle('rotate');
    const other = await register(handle);
    const current = await login(handle, GOOD);
    const newPassword = 'another-decent-passphrase';

    const changed = await call(
      'POST',
      '/api/auth/password',
      { currentPassword: GOOD, newPassword },
      asUser(current.body.token),
    );

    expect(changed.status).toBe(200);
    expect(changed.body.otherSessionsRevoked).toBeGreaterThan(0);

    // The session that made the change survives...
    expect((await call('GET', '/api/me', undefined, asUser(current.body.token))).status).toBe(200);
    // ...and the others do not, which is the entire point of changing it.
    expect((await call('GET', '/api/me', undefined, asUser(other.body.token))).status).toBe(401);

    expect((await login(handle, GOOD)).status).toBe(401);
    expect((await login(handle, newPassword)).status).toBe(200);
  });
});

describe('nothing secret ever reaches a client', () => {
  it('never serialises a hash or a password', async () => {
    const handle = uniqueHandle('nohash');
    const reg = await register(handle);
    const me = await call('GET', '/api/me', undefined, asUser(reg.body.token));
    const sessions = await call('GET', '/api/auth/sessions', undefined, asUser(reg.body.token));

    const serialised = JSON.stringify([reg.body, me.body, sessions.body]);
    expect(serialised).not.toContain('scrypt');
    expect(serialised).not.toContain('password_hash');
    expect(serialised).not.toContain(GOOD);
  });

  it('publishes the password policy without publishing anything sensitive', async () => {
    const res = await call('GET', '/api/auth/policy');
    expect(res.status).toBe(200);
    expect(res.body.minPasswordLength).toBeGreaterThanOrEqual(8);
    // The demo credentials are published on purpose; a demo account with a
    // secret password is not a demo account.
    expect(res.body.demo.handle).toBe('demo');
  });

  it('lets the demo account in with its published password', async () => {
    const policy = await call('GET', '/api/auth/policy');
    const res = await login(policy.body.demo.handle, policy.body.demo.password);
    expect(res.status).toBe(200);
  });
});
