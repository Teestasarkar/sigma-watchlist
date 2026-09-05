/**
 * The API client.
 *
 * Small on purpose - no data-fetching library. What this app actually needs is
 * a typed fetch wrapper, a token in localStorage, and honest error objects.
 * The two behaviours worth more than a library are both here: a structured
 * `ApiError` the UI can branch on (a 409 renders differently from a 503), and
 * automatic idempotency keys on mutations so a retry over flaky mobile
 * networks cannot apply twice.
 */

import type {
  AuthPolicy,
  Diagnostics,
  Digest,
  Meta,
  SessionSummary,
  SymbolDetail,
  User,
  WatchRow,
  Watchlist,
} from './types.js';

const BASE = import.meta.env.VITE_API_BASE ?? '';
const TOKEN_KEY = 'sigma.token';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** A conflict carries the current version, so the caller can retry cleanly. */
  get currentVersion(): number | undefined {
    const v = this.details.currentVersion;
    return typeof v === 'number' ? v : undefined;
  }
}

let token: string | null = null;

/** localStorage can throw in private browsing modes; never let that be fatal. */
function readStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function storeToken(value: string | null): void {
  token = value;
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // In-memory only for this session. Degraded, not broken.
  }
}

export function getToken(): string | null {
  if (token === null) token = readStoredToken();
  return token;
}

const newIdempotencyKey = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Set to false for retryable-but-not-idempotent-safe calls. */
  idempotent?: boolean;
  signal?: AbortSignal;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };

  if (opts.body !== undefined) headers['content-type'] = 'application/json';

  const auth = getToken();
  if (auth) headers.authorization = `Bearer ${auth}`;

  // Mutations carry an idempotency key by default. The server stores the first
  // response and replays it, so a retry after a timeout cannot double-apply.
  if (method !== 'GET' && opts.idempotent !== false) {
    headers['idempotency-key'] = newIdempotencyKey();
  }

  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      headers,
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    // Distinguish "the network is gone" from "the server said no", because the
    // UI shows a very different thing for each.
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'network', 'cannot reach the server');
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const body = data as { error?: { code?: string; message?: string } } | null;
    const err = body?.error;
    const { code: _c, message: _m, ...details } = (err ?? {}) as Record<string, unknown>;
    throw new ApiError(
      res.status,
      err?.code ?? 'unknown',
      err?.message ?? `request failed (${res.status})`,
      details,
    );
  }

  return data as T;
}

// ─────────────────────────────────────────────────────────── endpoints

export const api = {
  /** Password requirements and, in demo mode, the demo credentials. */
  authPolicy: () => request<AuthPolicy>('/api/auth/policy'),

  async login(handle: string, password: string): Promise<{ user: User; isNew: boolean }> {
    const res = await request<{ token: string; user: User; isNew: boolean }>('/api/auth/login', {
      method: 'POST',
      body: { handle, password },
      idempotent: false,
    });
    storeToken(res.token);
    return { user: res.user, isNew: res.isNew };
  },

  async register(handle: string, password: string): Promise<{ user: User; isNew: boolean }> {
    const res = await request<{ token: string; user: User; isNew: boolean }>('/api/auth/register', {
      method: 'POST',
      body: { handle, password },
      idempotent: false,
    });
    storeToken(res.token);
    return { user: res.user, isNew: res.isNew };
  },

  /**
   * Sign out.
   *
   * Revokes the token server-side as well as forgetting it locally - dropping
   * it from localStorage alone would leave a valid session alive until it
   * expired, which is not what anyone means by "sign out".
   */
  async signOut(): Promise<void> {
    try {
      await request('/api/auth/logout', { method: 'POST', body: {}, idempotent: false });
    } catch {
      // Best effort. Even if the call fails, forget the token locally.
    }
    storeToken(null);
  },

  /** Forget the token without calling the server. For an already-dead session. */
  forgetToken(): void {
    storeToken(null);
  },

  signOutEverywhere: () =>
    request<{ revoked: number }>('/api/auth/logout-all', {
      method: 'POST',
      body: {},
      idempotent: false,
    }),

  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ changed: boolean; otherSessionsRevoked: number }>('/api/auth/password', {
      method: 'POST',
      body: { currentPassword, newPassword },
      idempotent: false,
    }),

  sessions: () => request<{ sessions: SessionSummary[] }>('/api/auth/sessions'),

  me: () =>
    request<{ user: User; watchlists: Watchlist[]; lastCheckedAt: number | null }>('/api/me'),

  meta: () => request<Meta>('/api/meta'),

  digest: (signal?: AbortSignal) =>
    request<Digest>('/api/digest', signal ? { signal } : {}),

  /** Advancing the watermark. Explicit, and undoable. */
  acknowledge: (symbols?: string[]) =>
    request<{ acknowledged: number; symbols: string[] }>('/api/digest/acknowledge', {
      method: 'POST',
      body: symbols ? { symbols } : {},
    }),

  undoAcknowledge: (symbols?: string[]) =>
    request<{ restored: number }>('/api/digest/undo', {
      method: 'POST',
      body: symbols ? { symbols } : {},
      idempotent: false,
    }),

  markRead: (signalIds: string[]) =>
    request<{ marked: number; ignored: number }>('/api/signals/read', {
      method: 'POST',
      body: { signalIds },
    }),

  watchlists: () => request<{ watchlists: Watchlist[] }>('/api/watchlists'),

  rows: (watchlistId: string, signal?: AbortSignal) =>
    request<{ watchlist: Watchlist | null; rows: WatchRow[] }>(
      `/api/watchlists/${watchlistId}/rows`,
      signal ? { signal } : {},
    ),

  addSymbol: (watchlistId: string, symbol: string, expectedVersion?: number) =>
    request<{ watchlist: Watchlist; added: boolean }>(`/api/watchlists/${watchlistId}/items`, {
      method: 'POST',
      body: expectedVersion === undefined ? { symbol } : { symbol, expectedVersion },
    }),

  removeSymbol: (watchlistId: string, symbol: string, expectedVersion?: number) =>
    request<{ watchlist: Watchlist; removed: boolean }>(
      `/api/watchlists/${watchlistId}/items/${symbol}` +
        (expectedVersion === undefined ? '' : `?expectedVersion=${expectedVersion}`),
      { method: 'DELETE', idempotent: false },
    ),

  updateItem: (
    watchlistId: string,
    symbol: string,
    patch: { pinned?: boolean; muted?: boolean; minSigma?: number | null; note?: string | null },
    expectedVersion?: number,
  ) =>
    request<Watchlist>(`/api/watchlists/${watchlistId}/items/${symbol}`, {
      method: 'PATCH',
      body: expectedVersion === undefined ? patch : { ...patch, expectedVersion },
      idempotent: false,
    }),

  search: (q: string, signal?: AbortSignal) =>
    request<{ results: Array<{ symbol: string; name: string; sector: string | null }> }>(
      `/api/symbols/search?q=${encodeURIComponent(q)}`,
      signal ? { signal } : {},
    ),

  symbol: (symbol: string, signal?: AbortSignal) =>
    request<SymbolDetail>(`/api/symbols/${symbol}`, signal ? { signal } : {}),

  refreshSymbol: (symbol: string) =>
    request<{ symbol: string; ok: boolean; signalsCreated: number }>(
      `/api/symbols/${symbol}/refresh`,
      { method: 'POST', idempotent: false },
    ),

  diagnostics: () => request<Diagnostics>('/api/ops/diagnostics'),

  // ── the live stream ────────────────────────────────────

  /**
   * Trade the session token for a nonce that is safe to put in a URL.
   *
   * `EventSource` cannot send an Authorization header, so the credential has
   * to travel in the query string - where it lands in proxy logs and browser
   * history. The ticket expires in thirty seconds and works once.
   */
  streamTicket: () =>
    request<{ ticket: string; expiresInMs: number }>('/api/stream/ticket', {
      method: 'POST',
      idempotent: false,
    }),

  /** Absolute, because EventSource does not inherit the client's base path. */
  streamUrl: (params: URLSearchParams): string => `${BASE}/api/stream?${params.toString()}`,

  // ── the demo controls ──────────────────────────────────────────────
  dev: {
    faults: (patch: Record<string, unknown>) =>
      request<Record<string, unknown>>('/api/dev/faults', {
        method: 'POST',
        body: patch,
        idempotent: false,
      }),
    resetFaults: () =>
      request<Record<string, unknown>>('/api/dev/faults/reset', {
        method: 'POST',
        body: {},
        idempotent: false,
      }),
    shock: (symbol: string, pct: number) =>
      request<Record<string, unknown>>('/api/dev/shock', {
        method: 'POST',
        body: { symbol, pct },
        idempotent: false,
      }),
    age: (minutes: number) =>
      request<{ aged: number; signalsCreated: number }>('/api/dev/age', {
        method: 'POST',
        body: { minutes },
        idempotent: false,
      }),
    breaker: (provider: string, action: 'trip' | 'reset') =>
      request<Record<string, unknown>>('/api/dev/breaker', {
        method: 'POST',
        body: { provider, action },
        idempotent: false,
      }),
    tick: () =>
      request<{ processed: number }>('/api/dev/tick', {
        method: 'POST',
        body: {},
        idempotent: false,
      }),
    /** Rewind the checkpoint by N *trading sessions*, not minutes. */
    rewind: (sessions: number) =>
      request<{ rewoundTo: number; sessions: number; symbols: number }>('/api/dev/rewind', {
        method: 'POST',
        body: { sessions, handle: 'demo' },
        idempotent: false,
      }),
  },
};
