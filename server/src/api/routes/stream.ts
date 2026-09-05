/**
 * Server-sent events: the server tells the browser when something moved.
 *
 * SSE rather than WebSockets, and that is a considered choice rather than the
 * lazy one. The traffic here is strictly one-way - the client has nothing to
 * say that an ordinary POST cannot carry - and SSE gets reconnection,
 * backoff and `Last-Event-ID` resume from the browser for free, over plain
 * HTTP/1.1 that every proxy and free-tier host already understands. A
 * WebSocket would mean shipping a protocol, a heartbeat and a reconnect
 * strategy to reimplement what EventSource already does, in exchange for a
 * direction of travel this product does not use.
 *
 * The events themselves are deliberately contentless - see services/events.ts
 * for why "something changed" beats "here is the change".
 */

import type { FastifyInstance } from 'fastify';

import type { App } from '../../app.js';
import type { MarketEvent } from '../../services/events.js';
import { unauthorized } from '../errors.js';
import { requireUser } from '../server.js';
import { createLogger } from '../../infra/logger.js';
import { shortId } from '../../infra/ids.js';

const log = createLogger('stream');

/**
 * A stream ticket is short-lived and single-use.
 *
 * `EventSource` cannot set an Authorization header - a genuine limitation of
 * the API, not an oversight - so the credential has to travel in the URL. Put
 * the session token there and it lands in proxy logs, in the browser's own
 * history, and in the Referer of anything the page later loads: a long-lived
 * credential leaked into three places that outlive the request.
 *
 * So the session token is exchanged, over a normal authenticated POST, for a
 * nonce that is useless thirty seconds later and useless twice. Worst case, a
 * leaked URL buys an attacker a connection to a feed of ticker symbols that
 * has already expired.
 */
const TICKET_TTL_MS = 30_000;

interface Ticket {
  userId: string;
  expiresAt: number;
}

/** Total concurrent streams, so one client cannot exhaust the process. */
const MAX_CONNECTIONS = 200;
/** Per user, so one *account* cannot either - a tab in every window still counts. */
const MAX_PER_USER = 6;

/**
 * Heartbeat interval.
 *
 * Load balancers reap idle connections, and a free-tier host is not generous
 * about it. A comment line costs three bytes and keeps the connection - and,
 * more importantly, keeps the browser from silently reconnecting in a loop.
 */
const HEARTBEAT_MS = 25_000;

export async function registerStreamRoutes(fastify: FastifyInstance, app: App): Promise<void> {
  const tickets = new Map<string, Ticket>();
  const connectionsByUser = new Map<string, number>();
  let connections = 0;

  /*
   * Every open stream, so shutdown can end them.
   *
   * Without this the process cannot exit. `fastify.close()` waits for in-flight
   * requests to finish, and an SSE response never finishes by design - so a
   * single connected browser turns a graceful restart into a hang until
   * something kills it. On a platform that redeploys by starting the new
   * instance and waiting for the old one, that is an outage.
   *
   * `preClose` rather than `onClose`: onClose runs *after* the server has
   * finished draining connections, which is precisely the step that would
   * never complete.
   */
  const openStreams = new Set<() => void>();

  fastify.addHook('preClose', async () => {
    for (const end of [...openStreams]) end();
    openStreams.clear();
  });

  const sweepTickets = (now: number): void => {
    for (const [key, t] of tickets) if (t.expiresAt <= now) tickets.delete(key);
  };

  /** Exchange a session for a nonce that can safely appear in a URL. */
  fastify.post('/api/stream/ticket', async (req) => {
    const user = requireUser(req);
    const now = app.clock.now();
    sweepTickets(now);

    const ticket = shortId('str');
    tickets.set(ticket, { userId: user.id, expiresAt: now + TICKET_TTL_MS });

    return { ticket, expiresInMs: TICKET_TTL_MS };
  });

  fastify.get('/api/stream', async (req, reply) => {
    const query = req.query as { ticket?: string; since?: string };
    const now = app.clock.now();
    sweepTickets(now);

    const ticket = typeof query.ticket === 'string' ? query.ticket : '';
    const held = tickets.get(ticket);
    // Single use: burn it on sight, so a replayed URL is already spent.
    tickets.delete(ticket);

    if (!held || held.expiresAt <= now) throw unauthorized('stream ticket expired');

    if (connections >= MAX_CONNECTIONS) {
      // 503 rather than 429: this is our capacity, not their behaviour, and
      // EventSource will retry on its own.
      return reply.code(503).send({ error: 'stream_at_capacity' });
    }

    const perUser = connectionsByUser.get(held.userId) ?? 0;
    if (perUser >= MAX_PER_USER) {
      return reply.code(503).send({ error: 'too_many_streams' });
    }

    connections++;
    connectionsByUser.set(held.userId, perUser + 1);

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Nginx and several PaaS proxies buffer responses by default, which for
      // a stream means the browser receives nothing until it ends. It never
      // ends. This header is the difference between working and hanging.
      'X-Accel-Buffering': 'no',
    });

    let open = true;

    const write = (chunk: string): void => {
      if (!open) return;
      try {
        reply.raw.write(chunk);
      } catch {
        // The socket went away between our check and the write. Not an error
        // worth logging; the close handler will clean up.
        open = false;
      }
    };

    const send = (event: string, data: unknown, id?: number): void => {
      write(
        (id === undefined ? '' : `id: ${id}\n`) +
          `event: ${event}\n` +
          `data: ${JSON.stringify(data)}\n\n`,
      );
    };

    /*
     * Tell the browser how long to wait before reconnecting.
     *
     * Its default is three seconds, which across a restart means every
     * connected client returns simultaneously - a thundering herd of exactly
     * the size that just lost its server.
     */
    write('retry: 5000\n\n');

    /*
     * Resume, or admit that we cannot.
     *
     * `Last-Event-ID` is set by the browser automatically on reconnect; the
     * `since` parameter is for a first connection that already knows a
     * sequence. If the gap is longer than the retained buffer, `since()`
     * returns null and we say so, because a client that silently misses events
     * displays stale data with full confidence - the precise failure this
     * product exists to prevent.
     */
    const lastEventId = req.headers['last-event-id'];
    const resumeFrom = Number(
      typeof lastEventId === 'string' ? lastEventId : (query.since ?? Number.NaN),
    );

    if (Number.isFinite(resumeFrom)) {
      const missed = app.events.since(resumeFrom);
      if (missed === null) {
        send('resync', { reason: 'gap too large', seq: app.events.currentSeq });
      } else {
        for (const e of missed) send('market', e, e.seq);
      }
    } else {
      // A fresh connection gets the current sequence, so its first reconnect
      // can ask for exactly what it missed.
      send('hello', { seq: app.events.currentSeq, heartbeatMs: HEARTBEAT_MS });
    }

    const unsubscribe = app.events.subscribe((event: MarketEvent) => {
      send('market', event, event.seq);
    });

    const heartbeat = setInterval(() => {
      // A comment line: ignored by EventSource, but it keeps proxies honest
      // and surfaces a dead socket to us via the write error.
      write(': hb\n\n');
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    const cleanup = (): void => {
      if (!open) return;
      open = false;
      clearInterval(heartbeat);
      unsubscribe();
      openStreams.delete(endStream);
      connections--;
      const left = (connectionsByUser.get(held.userId) ?? 1) - 1;
      if (left <= 0) connectionsByUser.delete(held.userId);
      else connectionsByUser.set(held.userId, left);
      log.debug('stream closed', { connections });
    };

    /*
     * Say goodbye before hanging up.
     *
     * A socket that simply drops looks to the browser like a network failure,
     * and it reconnects on the retry interval - into a server that is going
     * away. `bye` lets the client back off deliberately instead.
     */
    const endStream = (): void => {
      if (open) send('bye', { reason: 'server shutting down' });
      cleanup();
      try {
        reply.raw.end();
      } catch {
        // Already gone. Nothing to do and nothing worth reporting.
      }
    };

    openStreams.add(endStream);

    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);

    log.debug('stream opened', { connections, subscribers: app.events.subscriberCount });

    // Never resolves. Fastify must not send a body or end the response, so the
    // handler is told the reply has been taken over.
    return reply.hijack();
  });
}

/** Exposed for the ops endpoint, so stream load is visible alongside the rest. */
export function streamStats(app: App): { subscribers: number; seq: number } {
  return { subscribers: app.events.subscriberCount, seq: app.events.currentSeq };
}

/** Re-exported so the route file owns its own knobs. */
export { MAX_CONNECTIONS, MAX_PER_USER, HEARTBEAT_MS, TICKET_TTL_MS };
