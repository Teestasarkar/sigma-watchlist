/**
 * The change bus: how the server tells a browser that something moved.
 *
 * Until now the frontend polled every few seconds. That is fine and it is also
 * a slightly odd thing for *this* product to do, because the entire thesis is
 * "tell me what changed, don't make me look". Making the user's browser look
 * repeatedly instead of the user is only a partial answer.
 *
 * Three decisions shape this file.
 *
 * **1. Events are global, never personal.** An event says "AAPL's quote moved"
 * or "TSLA gained a signal" - never "your watchlist changed". That mirrors the
 * split the rest of the system already runs on: detection happens once per
 * symbol, personalisation happens at read time against the user's watermark.
 * Keeping the bus impersonal means one event serves every subscriber to that
 * symbol, so broadcast cost scales with *instruments*, not with users. The
 * alternative - computing a personalised payload per connection per tick -
 * would put the most expensive work on the hottest path.
 *
 * **2. Events carry no data, only news.** A subscriber that hears "AAPL moved"
 * re-reads the ordinary REST endpoint. This costs one extra round trip and
 * buys something worth much more: a single serialisation path. If the stream
 * pushed rendered rows, every view-model change would have to be made twice
 * and the two would drift - and the drift would show up as a UI that is subtly
 * wrong only for users who happened to stay connected.
 *
 * **3. Bursts are coalesced.** The scheduler refreshes symbols in batches, so
 * a naive implementation emits a dozen events in the same millisecond and each
 * one makes every client refetch. Publishes are buffered into a short window
 * and merged, which turns a batch into one event and one refetch.
 */

import { createLogger } from '../infra/logger.js';
import type { Clock } from '../infra/clock.js';

const log = createLogger('events');

export interface MarketEvent {
  /** Monotonic, so a reconnecting client can say what it already has. */
  seq: number;
  at: number;
  /** Symbols whose price changed. */
  quotes: string[];
  /** Symbols that gained at least one new signal - the interesting kind. */
  signals: string[];
}

export type Subscriber = (event: MarketEvent) => void;

export interface EventBusOptions {
  /**
   * How long to gather publishes before emitting one merged event.
   *
   * Long enough to absorb a scheduler batch, short enough to stay live. The
   * scheduler processes a batch in well under a second, so this mostly decides
   * whether a batch arrives as one event or as several.
   */
  coalesceMs?: number;
  /**
   * How many past events to retain for reconnect replay.
   *
   * Bounded deliberately. This is a buffer for a dropped connection, not a
   * message log - a client gone longer than this is told to resynchronise
   * from scratch, which is correct and cheaper than remembering forever.
   */
  historySize?: number;
}

export class MarketEventBus {
  private readonly subscribers = new Set<Subscriber>();
  private readonly history: MarketEvent[] = [];

  /** The batch being gathered right now, if any. */
  private pendingQuotes = new Set<string>();
  private pendingSignals = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  private seq = 0;

  private readonly coalesceMs: number;
  private readonly historySize: number;

  constructor(
    private readonly clock: Clock,
    opts: EventBusOptions = {},
  ) {
    this.coalesceMs = opts.coalesceMs ?? 250;
    this.historySize = opts.historySize ?? 128;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /** Sequence number of the newest event, for a client's initial sync. */
  get currentSeq(): number {
    return this.seq;
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  /**
   * Note that a symbol changed. Cheap and non-blocking by design: this is
   * called from the ingest hot path, which must never wait on a slow consumer.
   */
  publish(change: { symbol: string; quote?: boolean; signals?: number }): void {
    // With nobody listening there is nothing to coalesce toward, and buffering
    // would just accumulate garbage on a server whose tab is closed.
    if (this.subscribers.size === 0) return;

    if (change.quote) this.pendingQuotes.add(change.symbol);
    if ((change.signals ?? 0) > 0) this.pendingSignals.add(change.symbol);

    if (this.pendingQuotes.size === 0 && this.pendingSignals.size === 0) return;

    this.flushTimer ??= setTimeout(() => this.flush(), this.coalesceMs);
    // Never hold the process open for a heartbeat's worth of buffering.
    this.flushTimer.unref?.();
  }

  /** Emit the gathered batch as one event. */
  private flush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const quotes = [...this.pendingQuotes];
    const signals = [...this.pendingSignals];
    this.pendingQuotes = new Set();
    this.pendingSignals = new Set();

    if (quotes.length === 0 && signals.length === 0) return;

    const event: MarketEvent = {
      seq: ++this.seq,
      at: this.clock.now(),
      quotes,
      signals,
    };

    this.history.push(event);
    while (this.history.length > this.historySize) this.history.shift();

    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch (err) {
        // One broken subscriber must not stop the others being told, and must
        // not propagate back into ingest.
        log.warn('subscriber threw', { err: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  /**
   * What a reconnecting client missed, or `null` if it cannot be known.
   *
   * `null` means "resynchronise from scratch": either the gap is older than
   * the retained buffer, or the sequence is from a previous process. Saying so
   * explicitly is important - silently sending nothing would leave the client
   * confidently displaying stale data, which is the exact failure this whole
   * product exists to prevent.
   */
  since(seq: number): MarketEvent[] | null {
    if (seq >= this.seq) return [];
    const oldest = this.history[0];
    if (!oldest || seq < oldest.seq - 1) return null;
    return this.history.filter((e) => e.seq > seq);
  }

  /** Release the coalescing timer so a test or shutdown does not hang. */
  stop(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.subscribers.clear();
  }
}
