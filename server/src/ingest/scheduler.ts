/**
 * The ingestion scheduler.
 *
 * Design in one line: a database-backed due-queue drained by a small,
 * bounded worker pool.
 *
 * Why not a timer per symbol
 * --------------------------
 * The obvious implementation is `setInterval` per watched symbol. It works
 * beautifully for thirty symbols and falls apart for thirty thousand: the
 * timers do not survive a restart, they cannot be shared across processes, and
 * there is no way to apply backpressure when the upstream slows down. A queue
 * table costs one indexed query per tick and fixes all three - `claimDue`
 * leases work with `FOR UPDATE SKIP LOCKED`, so adding a second instance
 * doubles throughput with no coordination and no double-fetching.
 *
 * Attention-weighted polling
 * --------------------------
 * Not all symbols deserve the same freshness. A symbol someone is looking at
 * *right now* is polled aggressively; one that merely sits in a list is polled
 * lazily; one nobody has opened in a while is polled rarely. This is what
 * makes a 500-symbol watchlist affordable - the user only ever sees a handful
 * at a time, and only those need to be seconds-fresh.
 */

import type { IngestRepo, Job, Tier } from '../db/ingestRepo.js';
import type { SignalRepo } from '../db/signalRepo.js';
import type { AuthRepo } from '../db/authRepo.js';
import type { MarketClock } from '../domain/marketClock.js';
import type { IngestService } from '../services/ingest.js';
import type { Clock } from '../infra/clock.js';
import { createLogger } from '../infra/logger.js';

const log = createLogger('scheduler');

export interface SchedulerOptions {
  tickMs: number;
  batchSize: number;
  hotIntervalMs: number;
  warmIntervalMs: number;
  coldIntervalMs: number;
  hotWindowMs: number;
  closedMultiplier: number;
  /** Signals older than this many sessions are pruned. */
  retentionSessions: number;
}

export interface SchedulerStats {
  running: boolean;
  ticks: number;
  refreshed: number;
  failed: number;
  /** Held back by our own rate limiter. Not failures. */
  throttled: number;
  signalsCreated: number;
  lastTickAt: number | null;
  lastTickDurationMs: number | null;
  queueDepth: number;
  tiers: Record<Tier, number>;
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = true;

  private ticks = 0;
  private refreshed = 0;
  private failed = 0;
  private throttled = 0;
  private signalsCreated = 0;
  private lastTickAt: number | null = null;
  private lastTickDurationMs: number | null = null;

  /** Housekeeping runs on a slower cadence than the poll loop. */
  private lastSweepAt = 0;
  private static readonly SWEEP_INTERVAL_MS = 60_000;

  constructor(
    private readonly jobs: IngestRepo,
    private readonly signals: SignalRepo,
    private readonly auth: AuthRepo,
    private readonly ingest: IngestService,
    private readonly marketClock: MarketClock,
    private readonly clock: Clock,
    private readonly opts: SchedulerOptions,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    // unref so a lingering timer cannot keep the process alive during shutdown.
    this.timer = setInterval(() => void this.safeTick(), this.opts.tickMs);
    this.timer.unref?.();
    log.info('scheduler started', { tickMs: this.opts.tickMs, batch: this.opts.batchSize });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Let an in-flight tick finish so we do not abandon leased jobs.
    const deadline = this.clock.now() + 5000;
    while (this.ticking && this.clock.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    log.info('scheduler stopped', { ticks: this.ticks, refreshed: this.refreshed });
  }

  private async safeTick(): Promise<void> {
    // Overlap guard. A slow upstream must not let ticks pile up on each other
    // and multiply the load on something already struggling.
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    const started = this.clock.now();
    try {
      await this.tick(started);
    } catch (err) {
      log.error('tick failed', { err: err instanceof Error ? err.message : String(err) });
    } finally {
      this.ticking = false;
      this.ticks++;
      this.lastTickAt = started;
      this.lastTickDurationMs = this.clock.now() - started;
    }
  }

  /** One pass. Exposed so tests can drive the loop deterministically. */
  async tick(now = this.clock.now()): Promise<number> {
    if (now - this.lastSweepAt >= Scheduler.SWEEP_INTERVAL_MS) {
      this.lastSweepAt = now;
      await this.sweep(now);
    }

    // The lease must outlast a slow batch, or another worker would re-claim
    // symbols we are still fetching.
    const leaseMs = Math.max(this.opts.tickMs * 4, 15_000);
    const due = await this.jobs.claimDue(now, this.opts.batchSize, leaseMs);
    if (due.length === 0) return 0;

    const benchmark = await this.ingest.benchmarkSnapshot();

    // Bounded concurrency. Unbounded Promise.all over a large claim would
    // open as many upstream sockets as the batch size and defeat the rate
    // limiter's purpose.
    const CONCURRENCY = 6;
    let cursor = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, due.length) }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= due.length) return;
        await this.runJob(due[index] as Job, now, benchmark);
      }
    });

    await Promise.all(workers);
    return due.length;
  }

  private async runJob(
    job: Job,
    now: number,
    benchmark: Awaited<ReturnType<IngestService['benchmarkSnapshot']>>,
  ): Promise<void> {
    try {
      const result = await this.ingest.refresh(job.symbol, now, benchmark);

      if (result.ok) {
        this.refreshed++;
        this.signalsCreated += result.signalsCreated;
        await this.jobs.completeOk(job.symbol, now + this.intervalFor(job, now), now);
        return;
      }

      /*
       * Throttled by our own limiter: come back shortly.
       *
       * Crucially this is NOT counted as a failure. Treating it as one meant
       * our own budget running out inflated the failure streak, which drove
       * `backoffFor` into exponential delays and degraded polling for minutes
       * against a provider that was perfectly healthy.
       */
      if (result.throttled) {
        this.throttled++;
        const wait = Math.max(250, Math.min(result.retryAfterMs ?? 1000, 10_000));
        await this.jobs.completeOk(job.symbol, now + wait, job.lastOkAt ?? now);
        return;
      }

      this.failed++;

      if (result.notFound) {
        // Nothing upstream to poll. Back off hard rather than hammering a
        // symbol that has been delisted; the user has been told via the
        // instrument's status.
        await this.jobs.completeFail(
          job.symbol,
          now + this.opts.coldIntervalMs * 10,
          result.error ?? 'not found',
        );
        return;
      }

      await this.jobs.completeFail(job.symbol, now + this.backoffFor(job), result.error ?? 'failed');
    } catch (err) {
      this.failed++;
      const message = err instanceof Error ? err.message : String(err);
      log.error('refresh threw', { symbol: job.symbol, err: message });
      await this.jobs.completeFail(job.symbol, now + this.backoffFor(job), message);
    }
  }

  /**
   * Exponential backoff with jitter after a failure.
   *
   * The jitter is not decoration. When a provider goes down, every symbol
   * fails at the same moment and would otherwise retry in lockstep forever -
   * a self-inflicted thundering herd that arrives precisely when the upstream
   * is least able to cope.
   */
  private backoffFor(job: Job): number {
    const base = Math.min(job.intervalMs * 2 ** Math.min(job.failStreak, 6), 10 * 60_000);
    return Math.round(base * (0.5 + Math.random()));
  }

  /** Poll interval for a job, respecting market hours. */
  private intervalFor(job: Job, now: number): number {
    const closed = !this.marketClock.isOpen(now);
    const multiplier = closed ? this.opts.closedMultiplier : 1;
    return job.intervalMs * multiplier;
  }

  // ─────────────────────────────────────────────────── housekeeping

  /**
   * Periodic maintenance: re-tier by attention, enqueue newly-watched symbols,
   * drop orphans, and prune the signal log.
   *
   * Doing this on a slow cadence rather than per tick keeps the hot loop to a
   * single indexed query.
   */
  private async sweep(now: number): Promise<void> {
    try {
      await this.enqueueMissing(now);
      await this.retier(now);
      await this.dropOrphans();

      const pruned = await this.signals.pruneBefore(
        this.marketClock.sessionsAgo(now, this.opts.retentionSessions),
      );
      const idem = await this.jobs.pruneIdempotent(now - 24 * 3600_000);
      // Expired sessions are already refused at the auth hook; this only stops
      // the table growing without bound.
      const sessions = await this.auth.pruneExpiredSessions(now);
      if (pruned > 0 || idem > 0 || sessions > 0) {
        log.debug('pruned', { signals: pruned, idempotency: idem, sessions });
      }
    } catch (err) {
      log.error('sweep failed', { err: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Any symbol someone watches but nothing polls yet. */
  private async enqueueMissing(now: number): Promise<void> {
    const watched = await this.jobs.watchedSymbols();
    if (watched.length === 0) return;
    await this.jobs.ensureJobs(watched, this.opts.warmIntervalMs, now);
  }

  /**
   * Recompute tiers from attention.
   *
   * Hot means a human opened it recently. Warm means at least one person keeps
   * it on a list. Cold means it is only still here because something else
   * references it.
   */
  private async retier(now: number): Promise<void> {
    const inputs = await this.jobs.priorityInputs();
    if (inputs.size === 0) return;

    const updates: Array<{ symbol: string; tier: Tier; intervalMs: number }> = [];

    for (const [symbol, p] of inputs) {
      const viewedRecently =
        p.lastViewedAt !== null && now - p.lastViewedAt <= this.opts.hotWindowMs;

      let tier: Tier;
      if (viewedRecently) tier = 'hot';
      else if (p.watchers > 0) tier = 'warm';
      else tier = 'cold';

      const intervalMs =
        tier === 'hot'
          ? this.opts.hotIntervalMs
          : tier === 'warm'
            ? this.opts.warmIntervalMs
            : this.opts.coldIntervalMs;

      updates.push({ symbol, tier, intervalMs });
    }

    await this.jobs.setTiers(updates);
  }

  /** Stop polling what nobody watches. */
  private async dropOrphans(): Promise<void> {
    const orphans = await this.jobs.orphanedJobSymbols();
    if (orphans.length === 0) return;
    const removed = await this.jobs.deleteJobs(orphans);
    if (removed > 0) log.info('dropped orphaned jobs', { count: removed });
  }

  // ─────────────────────────────────────────────────── introspection

  async stats(): Promise<SchedulerStats> {
    const jobs = await this.jobs.listJobs();
    const now = this.clock.now();
    const tiers: Record<Tier, number> = { hot: 0, warm: 0, cold: 0 };
    let queueDepth = 0;

    for (const j of jobs) {
      tiers[j.tier] = (tiers[j.tier] ?? 0) + 1;
      if (j.nextRunAt <= now) queueDepth++;
    }

    return {
      running: !this.stopped,
      ticks: this.ticks,
      refreshed: this.refreshed,
      failed: this.failed,
      throttled: this.throttled,
      signalsCreated: this.signalsCreated,
      lastTickAt: this.lastTickAt,
      lastTickDurationMs: this.lastTickDurationMs,
      queueDepth,
      tiers,
    };
  }

  /** Bring a set of symbols to the front of the queue. */
  async expedite(symbols: readonly string[], at: number): Promise<void> {
    await Promise.all(symbols.map((s) => this.jobs.expedite(s, at)));
  }
}
