/**
 * The live connection.
 *
 * Polling every few seconds was always a slightly awkward fit for a product
 * whose whole argument is "you shouldn't have to keep looking". This closes
 * that gap: the server says when something moved, and the app refetches then.
 *
 * Three things make this safe to actually rely on.
 *
 * **Polling never goes away.** It slows down to a background heartbeat while
 * the stream is healthy and speeds back up the moment it is not. A stream is
 * an optimisation; a corporate proxy that eats `text/event-stream` is a
 * Tuesday. The user must never be able to tell which one they are on except by
 * how quickly the numbers move.
 *
 * **A gap is reported, not hidden.** If the server cannot prove what we missed
 * while disconnected, it says `resync` and we reload everything. Quietly
 * carrying on is how a screen ends up confidently displaying yesterday.
 *
 * **The credential is not the session token.** `EventSource` cannot set
 * headers, so whatever authenticates the stream ends up in a URL - and URLs
 * end up in proxy logs and browser history. We exchange the session for a
 * single-use ticket that expires in thirty seconds.
 */

import { api } from './api.js';

export interface MarketEvent {
  seq: number;
  at: number;
  /** Symbols whose price changed. */
  quotes: string[];
  /** Symbols that gained a new signal. */
  signals: string[];
}

export type StreamStatus = 'connecting' | 'live' | 'offline';

export interface StreamHandlers {
  /** Something moved. The payload says what, so the caller can ignore it. */
  onEvent: (event: MarketEvent) => void;
  /** We cannot know what was missed; reload from scratch. */
  onResync: () => void;
  onStatus: (status: StreamStatus) => void;
}

/**
 * Reconnect backoff.
 *
 * `EventSource` retries on its own, but only for transport failures - it gives
 * up permanently on an HTTP error, which is exactly what an expired ticket
 * produces. So we own the retry loop and the backoff, with jitter, because a
 * server restart otherwise brings every client back at the same instant.
 */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

export function connectStream(handlers: StreamHandlers): () => void {
  let source: EventSource | null = null;
  let retry = 0;
  let timer: number | undefined;
  let closed = false;
  /** The last sequence we actually processed, so a reconnect can resume. */
  let lastSeq: number | null = null;

  const clearTimer = (): void => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
  };

  const scheduleReconnect = (): void => {
    if (closed) return;
    const base = BACKOFF_MS[Math.min(retry, BACKOFF_MS.length - 1)] ?? 30_000;
    // Full jitter. Without it, every client that dropped together returns
    // together, and the reconnect storm finishes what the outage started.
    const delay = Math.random() * base;
    retry++;
    clearTimer();
    timer = window.setTimeout(() => void open(), delay);
  };

  const open = async (): Promise<void> => {
    if (closed) return;
    handlers.onStatus(retry === 0 ? 'connecting' : 'offline');

    let ticket: string;
    try {
      ticket = (await api.streamTicket()).ticket;
    } catch {
      // Usually an expired session, occasionally the server being down. Either
      // way the poll loop is still running, so this degrades rather than fails.
      scheduleReconnect();
      return;
    }
    if (closed) return;

    const params = new URLSearchParams({ ticket });
    if (lastSeq !== null) params.set('since', String(lastSeq));

    const es = new EventSource(api.streamUrl(params));
    source = es;

    es.addEventListener('open', () => {
      retry = 0;
      handlers.onStatus('live');
    });

    es.addEventListener('hello', (ev) => {
      const data = parse<{ seq: number }>(ev);
      if (data) lastSeq = data.seq;
      handlers.onStatus('live');
    });

    es.addEventListener('market', (ev) => {
      const data = parse<MarketEvent>(ev);
      if (!data) return;
      lastSeq = data.seq;
      handlers.onStatus('live');
      handlers.onEvent(data);
    });

    es.addEventListener('resync', (ev) => {
      const data = parse<{ seq: number }>(ev);
      if (data) lastSeq = data.seq;
      handlers.onResync();
    });

    es.addEventListener('bye', () => {
      /*
       * A deliberate goodbye, not a failure - the server is redeploying.
       *
       * Treating it as an error would send every connected client back
       * immediately, at the one moment the server is least able to answer.
       * Skipping ahead in the backoff spreads the return out instead.
       */
      es.close();
      if (source === es) source = null;
      handlers.onStatus('offline');
      retry = Math.max(retry, 2);
      scheduleReconnect();
    });

    es.addEventListener('error', () => {
      /*
       * EventSource reports every failure as an untyped `error`, so we cannot
       * tell a dropped socket from a rejected ticket. Close and rebuild with a
       * fresh ticket either way: the reconnect is cheap and the ambiguity is
       * not worth guessing about.
       */
      es.close();
      if (source === es) source = null;
      handlers.onStatus('offline');
      scheduleReconnect();
    });
  };

  void open();

  return () => {
    closed = true;
    clearTimer();
    source?.close();
    source = null;
    handlers.onStatus('offline');
  };
}

function parse<T>(ev: Event): T | null {
  const data = (ev as MessageEvent<string>).data;
  if (typeof data !== 'string') return null;
  try {
    return JSON.parse(data) as T;
  } catch {
    // A truncated frame from a proxy that chunked badly. Skip it; the next
    // event or the poll loop will catch us up.
    return null;
  }
}
