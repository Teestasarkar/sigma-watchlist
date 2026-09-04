/**
 * The four primitives that stand between this app and a flaky upstream:
 * a token-bucket rate limiter, a circuit breaker, jittered retry, and
 * single-flight request coalescing.
 *
 * These are deliberately small and dependency-free so their behaviour is
 * obvious and testable. Every one of them exists because a market data
 * provider will, at some point today, be slow, wrong, or gone.
 */

import type { Clock } from './clock.js';
import { systemClock } from './clock.js';

// ─────────────────────────────────────────────────────── rate limiter

/**
 * Token bucket. Providers publish limits like "60 requests/minute"; exceeding
 * them gets you throttled or banned, which is a far worse outcome than being
 * a few seconds late. `tryTake` never blocks - the caller decides whether to
 * skip this cycle or wait.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    readonly capacity: number,
    /** Tokens added per second. */
    readonly refillPerSec: number,
    private readonly clock: Clock = systemClock,
  ) {
    this.tokens = capacity;
    this.lastRefill = clock.now();
  }

  private refill(): void {
    const now = this.clock.now();
    const elapsed = Math.max(0, now - this.lastRefill);
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed / 1000) * this.refillPerSec);
    this.lastRefill = now;
  }

  tryTake(n = 1): boolean {
    this.refill();
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }

  /** Milliseconds until `n` tokens would be available. 0 if available now. */
  waitMs(n = 1): number {
    this.refill();
    if (this.tokens >= n) return 0;
    if (this.refillPerSec <= 0) return Number.POSITIVE_INFINITY;
    return Math.ceil(((n - this.tokens) / this.refillPerSec) * 1000);
  }

  get available(): number {
    this.refill();
    return this.tokens;
  }
}

// ─────────────────────────────────────────────────────── circuit breaker

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerOptions {
  /** Rolling window over which the failure ratio is measured. */
  windowMs: number;
  /** Don't trip on a tiny sample - two failures out of two is not evidence. */
  minSamples: number;
  failureRatio: number;
  /** How long to stay open before probing. */
  openMs: number;
  /** Consecutive successes needed in half-open to fully close. */
  halfOpenProbes: number;
}

/**
 * Standard three-state breaker. The important detail is the half-open state:
 * after the cooldown we let a *limited* number of probes through rather than
 * reopening the floodgates, so a provider that is still broken trips again
 * after one request instead of after a burst.
 */
export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private events: Array<{ at: number; ok: boolean }> = [];
  private openedAt = 0;
  private probesInFlight = 0;
  private probeSuccesses = 0;
  private lastError: string | null = null;
  private lastOkAt: number | null = null;

  constructor(
    readonly name: string,
    private readonly opts: BreakerOptions,
    private readonly clock: Clock = systemClock,
  ) {}

  private prune(): void {
    const cutoff = this.clock.now() - this.opts.windowMs;
    if (this.events.length && (this.events[0] as { at: number }).at < cutoff) {
      this.events = this.events.filter((e) => e.at >= cutoff);
    }
  }

  /** Should the caller attempt the request? */
  canAttempt(): boolean {
    const now = this.clock.now();

    if (this.state === 'open') {
      if (now - this.openedAt >= this.opts.openMs) {
        this.state = 'half_open';
        this.probesInFlight = 0;
        this.probeSuccesses = 0;
      } else {
        return false;
      }
    }

    if (this.state === 'half_open') {
      // Admit at most one probe at a time.
      if (this.probesInFlight >= 1) return false;
      this.probesInFlight++;
      return true;
    }

    return true;
  }

  recordSuccess(): void {
    const now = this.clock.now();
    this.lastOkAt = now;
    this.events.push({ at: now, ok: true });
    this.prune();

    if (this.state === 'half_open') {
      this.probesInFlight = Math.max(0, this.probesInFlight - 1);
      this.probeSuccesses++;
      if (this.probeSuccesses >= this.opts.halfOpenProbes) {
        this.state = 'closed';
        this.events = [];
      }
    }
  }

  recordFailure(err?: unknown): void {
    const now = this.clock.now();
    this.lastError = err instanceof Error ? err.message : err ? String(err) : 'unknown';
    this.events.push({ at: now, ok: false });
    this.prune();

    if (this.state === 'half_open') {
      // A failed probe means it is still broken. Straight back to open.
      this.trip(now);
      return;
    }

    const total = this.events.length;
    if (total < this.opts.minSamples) return;
    const fails = this.events.reduce((a, e) => a + (e.ok ? 0 : 1), 0);
    if (fails / total >= this.opts.failureRatio) this.trip(now);
  }

  private trip(now: number): void {
    this.state = 'open';
    this.openedAt = now;
    this.probesInFlight = 0;
    this.probeSuccesses = 0;
  }

  /** Force the breaker open. Used by the fault-injection demo endpoints. */
  forceOpen(): void {
    this.trip(this.clock.now());
  }

  reset(): void {
    this.state = 'closed';
    this.events = [];
    this.probesInFlight = 0;
    this.probeSuccesses = 0;
    this.lastError = null;
  }

  snapshot(): {
    state: BreakerState;
    ok: number;
    fail: number;
    lastError: string | null;
    lastOkAt: number | null;
    openedAt: number;
  } {
    this.prune();
    return {
      state: this.state,
      ok: this.events.reduce((a, e) => a + (e.ok ? 1 : 0), 0),
      fail: this.events.reduce((a, e) => a + (e.ok ? 0 : 1), 0),
      lastError: this.lastError,
      lastOkAt: this.lastOkAt,
      openedAt: this.openedAt,
    };
  }
}

// ─────────────────────────────────────────────────────── retry

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Bound how long an operation may take, and cancel it when it overruns.
 *
 * The deadline is a genuine race, not merely an abort. Aborting the signal and
 * then awaiting `fn` assumes `fn` honours the signal - and a provider that
 * quietly ignores it would hang forever, which is exactly the failure a
 * timeout exists to prevent. Racing releases the caller on schedule whatever
 * the callee does; the abort is the cooperative half, so a well-behaved callee
 * also stops working rather than finishing into the void.
 */
export async function withTimeout<T>(
  ms: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort(new TimeoutError(ms));
      reject(new TimeoutError(ms));
    }, ms);
  });

  // Start eagerly, so a synchronous throw inside `fn` becomes a rejection.
  const work = (async () => fn(ac.signal))();

  // When the deadline wins, `work` may still reject later with an abort error
  // that nobody is awaiting. Swallow it so it cannot surface as an unhandled
  // rejection and take the process down.
  void work.catch(() => undefined);

  try {
    return await Promise.race([work, deadline]);
  } catch (err) {
    // Normalise: a callee that rejects *because* we aborted it should report
    // the timeout, not an opaque AbortError.
    if (ac.signal.aborted && !(err instanceof TimeoutError)) throw new TimeoutError(ms);
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface RetryOptions {
  attempts: number;
  baseMs: number;
  maxMs: number;
  /** Only retry errors the caller considers transient. */
  isRetryable?: (err: unknown) => boolean;
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Exponential backoff with **full jitter**. Full jitter (uniform over
 * [0, cap]) rather than equal jitter, because the failure mode we care about
 * is a hundred symbols all retrying the same dead provider in lockstep.
 */
export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  const rand = opts.random ?? Math.random;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable = opts.isRetryable ? opts.isRetryable(err) : true;
      if (!retryable || attempt === opts.attempts) break;
      const cap = Math.min(opts.maxMs, opts.baseMs * 2 ** (attempt - 1));
      const delay = Math.round(rand() * cap);
      opts.onRetry?.(attempt, delay, err);
      await sleep(delay);
    }
  }
  throw lastErr;
}

// ─────────────────────────────────────────────────────── single flight

/**
 * Collapses concurrent identical requests into one.
 *
 * Without this, a user refreshing a 40-symbol watchlist while the scheduler is
 * mid-poll issues 80 upstream calls for 40 distinct facts. With it, the second
 * caller simply awaits the first one's promise.
 */
export class SingleFlight<T> {
  private inflight = new Map<string, Promise<T>>();

  run(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const p = (async () => {
      try {
        return await fn();
      } finally {
        // Delete in a finally so a rejection cannot poison the key forever.
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, p);
    return p;
  }

  get size(): number {
    return this.inflight.size;
  }
}

// ─────────────────────────────────────────────────────── latency tracking

/** Fixed-size ring buffer of latencies, for p95 without unbounded memory. */
export class LatencyWindow {
  private buf: number[] = [];
  constructor(private readonly capacity = 128) {}

  record(ms: number): void {
    this.buf.push(ms);
    if (this.buf.length > this.capacity) this.buf.shift();
  }

  percentile(p: number): number | null {
    if (this.buf.length === 0) return null;
    const sorted = [...this.buf].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx] as number;
  }
}
