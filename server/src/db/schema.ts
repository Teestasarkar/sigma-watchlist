/**
 * The schema, as one idempotent migration.
 *
 * Postgres dialect, run against PGlite locally and managed Postgres in
 * production. Kept as a string constant rather than a .sql file so the built
 * `dist` needs no asset-copying step - one less way for prod to differ.
 *
 * The four decisions in here that carry the most weight:
 *
 *  1. **Signals are global, not per-user.** Detection runs once per symbol no
 *     matter how many people watch it; personalisation is a read-time
 *     comparison against `user_symbol_marks`. This is the single choice that
 *     lets the system serve many users with large watchlists.
 *
 *  2. **`UNIQUE (symbol, kind, episode_key)` on `signals`.** Detection is
 *     therefore idempotent: a crash mid-cycle, a duplicate tick or two workers
 *     racing all converge on one row and one notification.
 *
 *  3. **`watchlist_items (symbol)` is a reverse index.** The poller asks "which
 *     symbols does anyone care about?" and fetches each exactly once.
 *
 *  4. **`ingest_jobs` is a queue table, not a set of timers.** It survives
 *     restarts, and `FOR UPDATE SKIP LOCKED` lets several workers claim
 *     disjoint batches without coordination.
 */

export const SCHEMA_VERSION = 2;

export const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ─────────────────────────────────────────────────────────── identity

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  handle     TEXT NOT NULL UNIQUE,
  created_at BIGINT NOT NULL
);

-- Bearer tokens. Deliberately simple: this is a watchlist, not a bank, and
-- password ceremony here would add surface area without adding safety.
CREATE TABLE IF NOT EXISTS sessions (
  token        TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- ─────────────────────────────────────────────────────────── market data

CREATE TABLE IF NOT EXISTS instruments (
  symbol        TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  exchange      TEXT,
  currency      TEXT NOT NULL DEFAULT 'USD',
  sector        TEXT,
  -- 'active' | 'delisted' | 'unknown'. A symbol that stops resolving is never
  -- silently dropped: its disappearance is itself something to report.
  status        TEXT NOT NULL DEFAULT 'active',
  is_benchmark  BOOLEAN NOT NULL DEFAULT FALSE,
  first_seen_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_instruments_benchmark
  ON instruments(is_benchmark) WHERE is_benchmark;

-- Daily OHLCV. The (symbol, ts) primary key makes per-symbol history a
-- contiguous index scan, which is the hot path for recomputing statistics.
--
-- "ts" is always the canonical session close from the injected market clock,
-- never a provider-supplied timestamp. The primary key is therefore the
-- session identity: two providers reporting the same day's close seconds apart
-- update one row instead of creating two, which would silently double the
-- sample count behind every volatility estimate in the system.
CREATE TABLE IF NOT EXISTS bars (
  symbol      TEXT   NOT NULL REFERENCES instruments(symbol) ON DELETE CASCADE,
  ts          BIGINT NOT NULL,
  session_key TEXT   NOT NULL,
  open        DOUBLE PRECISION NOT NULL,
  high        DOUBLE PRECISION NOT NULL,
  low         DOUBLE PRECISION NOT NULL,
  close       DOUBLE PRECISION NOT NULL,
  volume      DOUBLE PRECISION NOT NULL,
  source      TEXT   NOT NULL,
  PRIMARY KEY (symbol, ts)
);

-- Exactly one row per symbol. Writes are guarded on as_of so an out-of-order
-- provider response can never rewind the price - see MarketRepo.upsertQuote.
CREATE TABLE IF NOT EXISTS quotes_latest (
  symbol      TEXT PRIMARY KEY REFERENCES instruments(symbol) ON DELETE CASCADE,
  price       DOUBLE PRECISION NOT NULL,
  prev_close  DOUBLE PRECISION NOT NULL,
  day_open    DOUBLE PRECISION NOT NULL,
  day_high    DOUBLE PRECISION NOT NULL,
  day_low     DOUBLE PRECISION NOT NULL,
  volume      DOUBLE PRECISION NOT NULL,
  as_of       BIGINT NOT NULL,
  received_at BIGINT NOT NULL,
  source      TEXT   NOT NULL,
  confidence  DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  halted      BOOLEAN NOT NULL DEFAULT FALSE,
  -- Provider disagreement, recorded rather than resolved away silently.
  conflict    JSONB
);

-- Materialised statistics, recomputed when a session closes rather than per
-- request. A 500-symbol watchlist would otherwise redo a year of arithmetic
-- on every page load.
CREATE TABLE IF NOT EXISTS instrument_stats (
  symbol      TEXT PRIMARY KEY REFERENCES instruments(symbol) ON DELETE CASCADE,
  computed_at BIGINT  NOT NULL,
  bars        INTEGER NOT NULL,
  sigma_daily DOUBLE PRECISION NOT NULL,
  sigma_short DOUBLE PRECISION NOT NULL,
  atr_pct     DOUBLE PRECISION NOT NULL,
  beta        DOUBLE PRECISION NOT NULL,
  resid_sigma DOUBLE PRECISION NOT NULL,
  hi_52w      DOUBLE PRECISION NOT NULL,
  lo_52w      DOUBLE PRECISION NOT NULL,
  hi_30d      DOUBLE PRECISION NOT NULL,
  lo_30d      DOUBLE PRECISION NOT NULL,
  med_vol_20  DOUBLE PRECISION NOT NULL,
  sma_20      DOUBLE PRECISION NOT NULL,
  sma_50      DOUBLE PRECISION NOT NULL,
  peak_52w    DOUBLE PRECISION NOT NULL
);

-- ─────────────────────────────────────────────────────────── watchlists

CREATE TABLE IF NOT EXISTS watchlists (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  -- Optimistic concurrency token. Two devices editing one list will not
  -- silently clobber each other; the loser gets a 409 plus current state.
  version    INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_watchlists_user ON watchlists(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_watchlists_user_name ON watchlists(user_id, name);

CREATE TABLE IF NOT EXISTS watchlist_items (
  watchlist_id TEXT   NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
  symbol       TEXT   NOT NULL REFERENCES instruments(symbol) ON DELETE CASCADE,
  added_at     BIGINT NOT NULL,
  pinned       BOOLEAN NOT NULL DEFAULT FALSE,
  muted        BOOLEAN NOT NULL DEFAULT FALSE,
  -- Per-symbol override: "don't tell me about this one under 3 sigma".
  min_sigma    DOUBLE PRECISION,
  note         TEXT,
  sort_key     DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (watchlist_id, symbol)
);
-- The reverse index. Drives ingest fan-in: one fetch per symbol, not per user.
CREATE INDEX IF NOT EXISTS idx_items_symbol ON watchlist_items(symbol);

-- ─────────────────────────────────────────────────────────── signals

CREATE TABLE IF NOT EXISTS signals (
  id            TEXT   PRIMARY KEY,
  symbol        TEXT   NOT NULL REFERENCES instruments(symbol) ON DELETE CASCADE,
  kind          TEXT   NOT NULL,
  -- Identifies the episode. While a symbol stays past the exit threshold it
  -- remains in one episode, so a stock that is 3 sigma up for two days
  -- produces one signal rather than one per poll.
  episode_key   TEXT   NOT NULL,
  direction     TEXT   NOT NULL,
  severity      DOUBLE PRECISION NOT NULL,
  detected_at   BIGINT NOT NULL,
  as_of         BIGINT NOT NULL,
  headline      TEXT   NOT NULL,
  evidence      JSONB  NOT NULL DEFAULT '{}'::jsonb,
  superseded_at BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_signals_episode
  ON signals(symbol, kind, episode_key);
-- The digest read path: recent signals across a set of symbols.
CREATE INDEX IF NOT EXISTS idx_signals_symbol_time
  ON signals(symbol, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_open
  ON signals(symbol) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_signals_time ON signals(detected_at DESC);

-- Hysteresis state, one row per (symbol, kind). Persisted rather than held in
-- memory: if it were in memory, a restart would forget which episodes were
-- open and re-announce every currently-elevated symbol, turning a deploy into
-- a notification storm.
CREATE TABLE IF NOT EXISTS signal_state (
  symbol      TEXT NOT NULL REFERENCES instruments(symbol) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  in_episode  BOOLEAN NOT NULL DEFAULT FALSE,
  episode_key TEXT,
  entered_at  BIGINT,
  peak_value  DOUBLE PRECISION,
  last_value  DOUBLE PRECISION,
  updated_at  BIGINT NOT NULL,
  PRIMARY KEY (symbol, kind)
);

-- ─────────────────────────────────────────────────────────── user state

-- The watermark: the last state of the world the user actually acknowledged.
-- This is the heart of the product - it gives "what changed" a fixed reference
-- point that a page refresh cannot destroy. "prev_*" provides one level of
-- undo, so advancing it is a safe, reversible action.
CREATE TABLE IF NOT EXISTS user_symbol_marks (
  user_id         TEXT   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol          TEXT   NOT NULL,
  seen_at         BIGINT NOT NULL,
  seen_price      DOUBLE PRECISION,
  prev_seen_at    BIGINT,
  prev_seen_price DOUBLE PRECISION,
  PRIMARY KEY (user_id, symbol)
);

-- Per-signal dismissal, for clearing one item without moving the watermark.
CREATE TABLE IF NOT EXISTS signal_reads (
  user_id   TEXT   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  signal_id TEXT   NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
  read_at   BIGINT NOT NULL,
  PRIMARY KEY (user_id, signal_id)
);

-- ─────────────────────────────────────────────────────────── ingest

CREATE TABLE IF NOT EXISTS ingest_jobs (
  symbol      TEXT   PRIMARY KEY REFERENCES instruments(symbol) ON DELETE CASCADE,
  tier        TEXT   NOT NULL DEFAULT 'warm',
  interval_ms BIGINT NOT NULL,
  next_run_at BIGINT NOT NULL,
  last_run_at BIGINT,
  last_ok_at  BIGINT,
  last_error  TEXT,
  fail_streak INTEGER NOT NULL DEFAULT 0
);
-- The scheduler's only query: claim what is due.
CREATE INDEX IF NOT EXISTS idx_jobs_due ON ingest_jobs(next_run_at);

-- Drives the 'hot' tier: attention, not list membership, earns fast polling.
CREATE TABLE IF NOT EXISTS symbol_activity (
  symbol         TEXT PRIMARY KEY REFERENCES instruments(symbol) ON DELETE CASCADE,
  last_viewed_at BIGINT NOT NULL,
  view_count     BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_activity_viewed ON symbol_activity(last_viewed_at DESC);

-- ─────────────────────────────────────────────────────────── request safety

-- Replay protection for mutating requests: a retried POST returns the original
-- response instead of applying twice.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key          TEXT   PRIMARY KEY,
  user_id      TEXT   NOT NULL,
  method       TEXT   NOT NULL,
  path         TEXT   NOT NULL,
  request_hash TEXT   NOT NULL,
  status       INTEGER NOT NULL,
  response     TEXT   NOT NULL,
  created_at   BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_idem_created ON idempotency_keys(created_at);
`;

/**
 * v2 — real credentials.
 *
 * Additive and idempotent (`ADD COLUMN IF NOT EXISTS`), so it can be applied to
 * a database that already holds data. Existing rows get a NULL
 * `password_hash`, which cannot authenticate - correct, since those accounts
 * never had a password. Bootstrap sets one for the demo account.
 */
export const SCHEMA_V2 = `
-- Credentials. NULL means the account predates passwords and cannot log in.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- Login throttling, stored rather than held in memory so a lockout survives a
-- restart and applies across every instance. An in-memory counter is defeated
-- by waiting for a deploy, or by hitting a different replica.
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_logins INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until BIGINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at BIGINT;

-- Sessions get a real lifetime and enough provenance to be recognisable in a
-- "signed-in devices" list. A token that never expires is a token that leaks.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS expires_at BIGINT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_agent TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ip TEXT;

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
`;

/**
 * Migrations, applied in order.
 *
 * Stepped rather than "run one big idempotent script", because v2 alters
 * existing tables - a single `CREATE TABLE IF NOT EXISTS` file cannot express
 * that. Each step runs once, inside the same transaction that records the new
 * version, so a failure leaves the database on the previous version rather
 * than half-migrated.
 */
export const MIGRATIONS: ReadonlyArray<{ version: number; name: string; sql: string }> = [
  { version: 1, name: 'initial', sql: SCHEMA_V1 },
  { version: 2, name: 'credentials', sql: SCHEMA_V2 },
];
