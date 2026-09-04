/**
 * Credentials, login throttling and session lifecycle.
 *
 * Kept separate from UserRepo because these are the queries with security
 * consequences, and it is worth being able to read all of them in one sitting.
 *
 * The throttling state lives in the database rather than in a process-local
 * map. An in-memory counter is defeated by simply waiting for a deploy, or by
 * hitting a different replica - so it protects nothing the moment the service
 * is more than one process.
 */

import type { User } from '../domain/types.js';
import { shortId } from '../infra/ids.js';
import { n, nOrNull, type SqlClient } from './sql.js';

type Row = Record<string, unknown>;

export interface AccountRow {
  id: string;
  handle: string;
  createdAt: number;
  passwordHash: string | null;
  failedLogins: number;
  lockedUntil: number | null;
  passwordChangedAt: number | null;
}

export interface SessionInfo {
  token: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number | null;
  userAgent: string | null;
  ip: string | null;
}

const mapAccount = (r: Row): AccountRow => ({
  id: r.id as string,
  handle: r.handle as string,
  createdAt: n(r.created_at),
  passwordHash: (r.password_hash as string | null) ?? null,
  failedLogins: n(r.failed_logins),
  lockedUntil: nOrNull(r.locked_until),
  passwordChangedAt: nOrNull(r.password_changed_at),
});

export class AuthRepo {
  constructor(private readonly sql: SqlClient) {}

  // ───────────────────────────────────────────────────── accounts

  /**
   * Look up an account for authentication.
   *
   * Handles are compared case-insensitively so `Alice` and `alice` are one
   * account - otherwise two people would each believe they owned the name, and
   * one of them would be quietly locked out of their own watchlist.
   */
  async findAccount(handle: string): Promise<AccountRow | null> {
    const r = await this.sql.one<Row>(`SELECT * FROM users WHERE LOWER(handle) = LOWER($1)`, [
      handle.trim(),
    ]);
    return r ? mapAccount(r) : null;
  }

  async createAccount(handle: string, passwordHash: string, now: number): Promise<User> {
    const id = shortId('usr');
    await this.sql.query(
      `INSERT INTO users (id, handle, created_at, password_hash, failed_logins, password_changed_at)
       VALUES ($1, $2, $3, $4, 0, $3)`,
      [id, handle.trim(), now, passwordHash],
    );
    return { id, handle: handle.trim(), createdAt: now };
  }

  /**
   * Set a new password and revoke every session except, optionally, the one
   * making the change.
   *
   * Revoking on password change is the point of changing it: if someone else
   * has a live token, a new password that leaves their session working has
   * achieved nothing.
   */
  async setPassword(
    userId: string,
    passwordHash: string,
    now: number,
    keepToken?: string,
  ): Promise<number> {
    return this.sql.tx(async () => {
      await this.sql.query(
        `UPDATE users
         SET password_hash = $2, password_changed_at = $3, failed_logins = 0, locked_until = NULL
         WHERE id = $1`,
        [userId, passwordHash, now],
      );

      const revoked = await this.sql.query<Row>(
        keepToken
          ? `DELETE FROM sessions WHERE user_id = $1 AND token <> $2 RETURNING token`
          : `DELETE FROM sessions WHERE user_id = $1 RETURNING token`,
        keepToken ? [userId, keepToken] : [userId],
      );
      return revoked.length;
    });
  }

  // ───────────────────────────────────────────────────── throttling

  /**
   * Record a failed attempt and lock the account once they pile up.
   *
   * The delay grows with the streak rather than jumping straight to a long
   * lockout: a legitimate person who mistypes twice should not be locked out
   * for an hour, while a script trying thousands of guesses hits minutes of
   * dead time almost immediately.
   *
   * Returns the instant the account is locked until, or null if still open.
   */
  async recordFailedLogin(userId: string, now: number): Promise<number | null> {
    const r = await this.sql.one<Row>(
      `UPDATE users SET failed_logins = failed_logins + 1 WHERE id = $1 RETURNING failed_logins`,
      [userId],
    );
    const streak = n(r?.failed_logins);

    // Five free attempts, then a doubling delay capped at fifteen minutes.
    if (streak < 5) return null;

    const seconds = Math.min(15 * 60, 30 * 2 ** (streak - 5));
    const until = now + seconds * 1000;
    await this.sql.query(`UPDATE users SET locked_until = $2 WHERE id = $1`, [userId, until]);
    return until;
  }

  async clearFailedLogins(userId: string): Promise<void> {
    await this.sql.query(
      `UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1`,
      [userId],
    );
  }

  // ───────────────────────────────────────────────────── sessions

  async createSession(
    userId: string,
    now: number,
    ttlMs: number,
    meta: { userAgent?: string | null; ip?: string | null } = {},
  ): Promise<{ token: string; expiresAt: number }> {
    const token = shortId('ses');
    const expiresAt = now + ttlMs;
    await this.sql.query(
      `INSERT INTO sessions (token, user_id, created_at, last_seen_at, expires_at, user_agent, ip)
       VALUES ($1, $2, $3, $3, $4, $5, $6)`,
      [
        token,
        userId,
        now,
        expiresAt,
        (meta.userAgent ?? null)?.slice(0, 200) ?? null,
        meta.ip ?? null,
      ],
    );
    return { token, expiresAt };
  }

  /**
   * Resolve a bearer token, refusing anything expired.
   *
   * `expires_at IS NULL OR expires_at > $2` keeps pre-v2 sessions working
   * rather than logging everyone out on deploy; new sessions always carry an
   * expiry. `last_seen_at` is refreshed in the same statement so that
   * authenticating - which happens on every single request - costs one round
   * trip rather than two.
   */
  async resolveSession(
    token: string,
    now: number,
  ): Promise<(User & { expiresAt: number | null }) | null> {
    const r = await this.sql.one<Row>(
      `WITH touched AS (
         UPDATE sessions SET last_seen_at = $2
         WHERE token = $1 AND (expires_at IS NULL OR expires_at > $2)
         RETURNING user_id, expires_at
       )
       SELECT u.id, u.handle, u.created_at, t.expires_at
       FROM users u JOIN touched t ON t.user_id = u.id`,
      [token, now],
    );
    if (!r) return null;
    return {
      id: r.id as string,
      handle: r.handle as string,
      createdAt: n(r.created_at),
      expiresAt: nOrNull(r.expires_at),
    };
  }

  /** Extend a session that is being actively used. */
  async slideExpiry(token: string, now: number, ttlMs: number): Promise<void> {
    await this.sql.query(
      `UPDATE sessions SET expires_at = $3 WHERE token = $1 AND expires_at IS NOT NULL AND expires_at > $2`,
      [token, now, now + ttlMs],
    );
  }

  async revokeSession(token: string): Promise<boolean> {
    const rows = await this.sql.query<Row>(
      `DELETE FROM sessions WHERE token = $1 RETURNING token`,
      [token],
    );
    return rows.length > 0;
  }

  async revokeAllSessions(userId: string, exceptToken?: string): Promise<number> {
    const rows = await this.sql.query<Row>(
      exceptToken
        ? `DELETE FROM sessions WHERE user_id = $1 AND token <> $2 RETURNING token`
        : `DELETE FROM sessions WHERE user_id = $1 RETURNING token`,
      exceptToken ? [userId, exceptToken] : [userId],
    );
    return rows.length;
  }

  /** Signed-in devices, for a "where am I logged in?" list. */
  async listSessions(userId: string, now: number): Promise<SessionInfo[]> {
    const rows = await this.sql.query<Row>(
      `SELECT token, created_at, last_seen_at, expires_at, user_agent, ip
       FROM sessions
       WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > $2)
       ORDER BY last_seen_at DESC`,
      [userId, now],
    );
    return rows.map((r) => ({
      token: r.token as string,
      createdAt: n(r.created_at),
      lastSeenAt: n(r.last_seen_at),
      expiresAt: nOrNull(r.expires_at),
      userAgent: (r.user_agent as string | null) ?? null,
      ip: (r.ip as string | null) ?? null,
    }));
  }

  /**
   * Delete expired sessions.
   *
   * Housekeeping, not security - an expired session is already refused by
   * `resolveSession`. This just stops the table growing forever.
   */
  async pruneExpiredSessions(now: number): Promise<number> {
    const rows = await this.sql.query<Row>(
      `DELETE FROM sessions WHERE expires_at IS NOT NULL AND expires_at <= $1 RETURNING token`,
      [now],
    );
    return rows.length;
  }
}
