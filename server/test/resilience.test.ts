/**
 * The resilience primitives.
 *
 * Every one of these is driven by a manual clock, so the tests assert on the
 * actual state machine rather than on timing luck. A circuit breaker test that
 * needs a real 15-second wait is a test nobody runs.
 */

import { describe, expect, it, vi } from 'vitest';

import { ManualClock } from '../src/infra/clock.js';
import {
  CircuitBreaker,
  LatencyWindow,
  SingleFlight,
  TimeoutError,
  TokenBucket,
  retry,
  withTimeout,
} from '../src/infra/resilience.js';

const BREAKER_OPTS = {
  windowMs: 30_000,
  minSamples: 5,
  failureRatio: 0.5,
  openMs: 15_000,
  halfOpenProbes: 2,
};

describe('TokenBucket', () => {
  it('starts full and empties as tokens are taken', () => {
    const clock = new ManualClock(0);
    const bucket = new TokenBucket(3, 1, clock);

    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);
  });

  it('refills continuously rather than in per-minute steps', () => {
    // Step refills let a burst at the top of the minute starve the rest of it.
    const clock = new ManualClock(0);
    const bucket = new TokenBucket(10, 2, clock); // 2 per second

    for (let i = 0; i < 10; i++) bucket.tryTake();
    expect(bucket.tryTake()).toBe(false);

    clock.advance(500); // half a second -> one token
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);
  });

  it('never exceeds capacity however long it idles', () => {
    const clock = new ManualClock(0);
    const bucket = new TokenBucket(5, 100, clock);
    clock.advance(60 * 60_000);
    expect(bucket.available).toBe(5);
  });

  it('reports how long the caller must wait', () => {
    const clock = new ManualClock(0);
    const bucket = new TokenBucket(1, 1, clock);

    expect(bucket.waitMs()).toBe(0);
    bucket.tryTake();
    expect(bucket.waitMs()).toBeGreaterThan(900);
    expect(bucket.waitMs()).toBeLessThanOrEqual(1000);
  });

  it('reports an unreachable wait when it can never refill', () => {
    const bucket = new TokenBucket(1, 0, new ManualClock(0));
    bucket.tryTake();
    expect(bucket.waitMs()).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('CircuitBreaker', () => {
  it('stays closed while the failure rate is below the threshold', () => {
    const clock = new ManualClock(0);
    const cb = new CircuitBreaker('p', BREAKER_OPTS, clock);

    for (let i = 0; i < 10; i++) {
      cb.canAttempt();
      if (i % 4 === 0) cb.recordFailure(new Error('x'));
      else cb.recordSuccess();
    }

    expect(cb.snapshot().state).toBe('closed');
    expect(cb.canAttempt()).toBe(true);
  });

  it('does not trip on a tiny sample', () => {
    // Two failures out of two is not evidence a provider is unhealthy.
    const cb = new CircuitBreaker('p', BREAKER_OPTS, new ManualClock(0));
    cb.recordFailure(new Error('x'));
    cb.recordFailure(new Error('x'));
    expect(cb.snapshot().state).toBe('closed');
  });

  it('opens once the failure ratio is met with enough samples', () => {
    const cb = new CircuitBreaker('p', BREAKER_OPTS, new ManualClock(0));
    for (let i = 0; i < 5; i++) cb.recordFailure(new Error('down'));

    expect(cb.snapshot().state).toBe('open');
    expect(cb.canAttempt()).toBe(false);
  });

  it('admits exactly one probe after the cooldown', () => {
    const clock = new ManualClock(0);
    const cb = new CircuitBreaker('p', BREAKER_OPTS, clock);
    for (let i = 0; i < 5; i++) cb.recordFailure(new Error('down'));

    expect(cb.canAttempt()).toBe(false);
    clock.advance(BREAKER_OPTS.openMs);

    // First call transitions to half-open and takes the single probe slot.
    expect(cb.canAttempt()).toBe(true);
    // A second concurrent caller must be turned away, or a still-broken
    // provider gets a burst instead of one request.
    expect(cb.canAttempt()).toBe(false);
  });

  it('re-opens immediately when the probe fails', () => {
    const clock = new ManualClock(0);
    const cb = new CircuitBreaker('p', BREAKER_OPTS, clock);
    for (let i = 0; i < 5; i++) cb.recordFailure(new Error('down'));

    clock.advance(BREAKER_OPTS.openMs);
    cb.canAttempt();
    cb.recordFailure(new Error('still down'));

    expect(cb.snapshot().state).toBe('open');
    expect(cb.canAttempt()).toBe(false);
  });

  it('closes only after the required number of successful probes', () => {
    const clock = new ManualClock(0);
    const cb = new CircuitBreaker('p', BREAKER_OPTS, clock);
    for (let i = 0; i < 5; i++) cb.recordFailure(new Error('down'));

    clock.advance(BREAKER_OPTS.openMs);

    cb.canAttempt();
    cb.recordSuccess();
    expect(cb.snapshot().state).toBe('half_open');

    cb.canAttempt();
    cb.recordSuccess();
    expect(cb.snapshot().state).toBe('closed');
  });

  it('forgets failures that age out of the window', () => {
    const clock = new ManualClock(0);
    const cb = new CircuitBreaker('p', BREAKER_OPTS, clock);

    cb.recordFailure(new Error('x'));
    cb.recordFailure(new Error('x'));
    clock.advance(BREAKER_OPTS.windowMs + 1);

    expect(cb.snapshot().fail).toBe(0);
  });

  it('can be tripped and reset by hand', () => {
    const cb = new CircuitBreaker('p', BREAKER_OPTS, new ManualClock(0));
    cb.forceOpen();
    expect(cb.snapshot().state).toBe('open');
    cb.reset();
    expect(cb.snapshot().state).toBe('closed');
  });
});

describe('retry', () => {
  const noSleep = async (): Promise<void> => undefined;

  it('returns the first success without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await retry(fn, { attempts: 3, baseMs: 1, maxMs: 2, sleep: noSleep });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries transient failures up to the attempt limit', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue('ok');

    const result = await retry(fn, { attempts: 3, baseMs: 1, maxMs: 2, sleep: noSleep });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('gives up after the last attempt and rethrows', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always'));
    await expect(
      retry(fn, { attempts: 2, baseMs: 1, maxMs: 2, sleep: noSleep }),
    ).rejects.toThrow('always');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry what the caller says is permanent', async () => {
    // Retrying a 401 or an unknown symbol just burns the rate-limit budget.
    const fn = vi.fn().mockRejectedValue(new Error('unauthorised'));
    await expect(
      retry(fn, {
        attempts: 5,
        baseMs: 1,
        maxMs: 2,
        sleep: noSleep,
        isRetryable: () => false,
      }),
    ).rejects.toThrow('unauthorised');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('applies full jitter so retries do not synchronise', async () => {
    // Full jitter means the delay is uniform over [0, cap] - the point is that
    // a hundred symbols failing together do not all retry at the same instant.
    const delays: number[] = [];
    const fn = vi.fn().mockRejectedValue(new Error('x'));

    await retry(fn, {
      attempts: 4,
      baseMs: 100,
      maxMs: 10_000,
      sleep: noSleep,
      random: () => 1, // the maximum of the jitter range
      onRetry: (_a, delay) => delays.push(delay),
    }).catch(() => undefined);

    // Caps double per attempt: 100, 200, 400.
    expect(delays).toEqual([100, 200, 400]);

    const zeroDelays: number[] = [];
    await retry(fn, {
      attempts: 3,
      baseMs: 100,
      maxMs: 10_000,
      sleep: noSleep,
      random: () => 0, // the minimum
      onRetry: (_a, delay) => zeroDelays.push(delay),
    }).catch(() => undefined);

    expect(zeroDelays).toEqual([0, 0]);
  });
});

describe('withTimeout', () => {
  it('resolves when the work finishes in time', async () => {
    await expect(withTimeout(1000, async () => 'done')).resolves.toBe('done');
  });

  it('rejects with a TimeoutError and aborts the signal', async () => {
    let aborted = false;
    await expect(
      withTimeout(20, (signal) => {
        signal.addEventListener('abort', () => {
          aborted = true;
        });
        return new Promise((resolve) => setTimeout(resolve, 500));
      }),
    ).rejects.toBeInstanceOf(TimeoutError);

    expect(aborted).toBe(true);
  });
});

describe('SingleFlight', () => {
  it('collapses concurrent calls for the same key into one', async () => {
    const flight = new SingleFlight<number>();
    let calls = 0;

    const work = async (): Promise<number> => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return 42;
    };

    const results = await Promise.all([
      flight.run('k', work),
      flight.run('k', work),
      flight.run('k', work),
    ]);

    expect(results).toEqual([42, 42, 42]);
    expect(calls).toBe(1);
  });

  it('keeps different keys independent', async () => {
    const flight = new SingleFlight<string>();
    let calls = 0;
    const work = async (v: string): Promise<string> => {
      calls++;
      return v;
    };

    await Promise.all([flight.run('a', () => work('a')), flight.run('b', () => work('b'))]);
    expect(calls).toBe(2);
  });

  it('does not poison a key after a rejection', async () => {
    // If the failed promise stayed in the map, the symbol would be permanently
    // unfetchable - a cache of one error, forever.
    const flight = new SingleFlight<string>();

    await expect(flight.run('k', () => Promise.reject(new Error('nope')))).rejects.toThrow('nope');
    expect(flight.size).toBe(0);
    await expect(flight.run('k', () => Promise.resolve('recovered'))).resolves.toBe('recovered');
  });
});

describe('LatencyWindow', () => {
  it('reports percentiles and stays bounded', () => {
    const w = new LatencyWindow(4);
    expect(w.percentile(95)).toBeNull();

    for (const ms of [10, 20, 30, 40, 50, 60]) w.record(ms);
    // Only the last four are retained.
    expect(w.percentile(0)).toBe(30);
    expect(w.percentile(99)).toBe(60);
  });
});
