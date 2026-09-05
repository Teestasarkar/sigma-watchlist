/**
 * The live stream, over a real socket.
 *
 * `fastify.inject` cannot test this: the handler hijacks the response and
 * never ends it, which is the entire point of a stream and exactly what an
 * injected request cannot represent. So this suite binds a real port and
 * reads real bytes off the wire.
 *
 * What is worth asserting is the security boundary and the failure handling,
 * not "does a message arrive". `EventSource` cannot send an Authorization
 * header, so the credential travels in a URL - and a URL ends up in proxy
 * logs, browser history and Referer headers. The single-use, short-lived
 * ticket is what makes that acceptable, so most of this file is about the
 * ticket.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp, type App } from '../src/app.js';
import { buildServer } from '../src/api/server.js';
import { config as baseConfig } from '../src/config.js';
import { ManualClock } from '../src/infra/clock.js';

const clock = new ManualClock(Date.now());
const TEST_PASSWORD = 'quiet-river-lantern-42';

const config = {
  ...baseConfig,
  databaseUrl: '',
  devTools: false,
  // Nothing here needs the scheduler, and letting it run would publish events
  // this suite did not ask for.
  ingest: { ...baseConfig.ingest, enabled: false, eventCoalesceMs: 10 },
  replay: { ...baseConfig.replay, enabled: false },
  providers: { ...baseConfig.providers, enabled: ['synthetic'], syntheticSessionMs: 60_000 },
} as typeof baseConfig;

let app: App;
let server: FastifyInstance;
let base: string;
let token: string;

beforeAll(async () => {
  app = await buildApp({ config, clock, inMemory: true });
  await app.bootstrap();
  server = await buildServer({ app });

  // Port 0: let the OS pick, so the suite never collides with a dev server.
  await server.listen({ port: 0, host: '127.0.0.1' });
  const address = server.server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  base = `http://127.0.0.1:${address.port}`;

  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle: 'streamer', password: TEST_PASSWORD }),
  });
  token = ((await res.json()) as { token: string }).token;
}, 120_000);

afterAll(async () => {
  await server?.close();
  await app?.shutdown();
});

async function newTicket(): Promise<string> {
  const res = await fetch(`${base}/api/stream/ticket`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { ticket: string }).ticket;
}

/**
 * An open stream, plus a way to wait for the next frame containing a marker.
 *
 * Reading is greedy and buffered because a frame can arrive split across TCP
 * reads; matching on the accumulated text rather than per-chunk is the
 * difference between a reliable test and an intermittent one.
 */
function openStream(url: string): {
  text: () => string;
  waitFor: (marker: string, timeoutMs?: number) => Promise<string>;
  close: () => void;
} {
  const controller = new AbortController();
  let buffer = '';
  let failed: unknown = null;

  const started = fetch(url, { signal: controller.signal }).then(async (res) => {
    if (!res.ok || !res.body) throw new Error(`stream failed: ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
  });
  started.catch((err) => {
    if (!controller.signal.aborted) failed = err;
  });

  return {
    text: () => buffer,
    close: () => controller.abort(),
    async waitFor(marker: string, timeoutMs = 4000): Promise<string> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (failed) throw failed;
        if (buffer.includes(marker)) return buffer;
        await new Promise((r) => setTimeout(r, 15));
      }
      throw new Error(`timed out waiting for ${marker}; got:\n${buffer}`);
    },
  };
}

/** Wait until no stream teardown is still in flight. */
async function settleSubscribers(timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  let stableFor = 0;
  while (Date.now() < deadline) {
    const n = app.events.subscriberCount;
    stableFor = n === last ? stableFor + 1 : 0;
    if (n === 0 || stableFor >= 4) return;
    last = n;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('the stream ticket', () => {
  it('is refused without a session', async () => {
    const res = await fetch(`${base}/api/stream/ticket`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('cannot be reused', async () => {
    /*
     * The property that makes a credential-in-a-URL acceptable. A ticket that
     * leaks into a proxy log or a Referer header has already been spent by the
     * connection that leaked it.
     */
    const ticket = await newTicket();

    const first = openStream(`${base}/api/stream?ticket=${ticket}`);
    await first.waitFor('event: hello');

    const second = await fetch(`${base}/api/stream?ticket=${ticket}`);
    expect(second.status).toBe(401);
    await second.body?.cancel();

    first.close();
  });

  it('is refused when absent or invented', async () => {
    for (const url of [`${base}/api/stream`, `${base}/api/stream?ticket=str_notarealticket`]) {
      const res = await fetch(url);
      expect(res.status).toBe(401);
      await res.body?.cancel();
    }
  });

  it('expires', async () => {
    const ticket = await newTicket();
    // Past the thirty-second lifetime, without waiting thirty seconds.
    clock.advance(31_000);

    const res = await fetch(`${base}/api/stream?ticket=${ticket}`);
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });

  it('does not accept a session token in place of a ticket', async () => {
    // The whole point is that the long-lived credential never appears here.
    const res = await fetch(`${base}/api/stream?ticket=${token}`);
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });
});

describe('an open stream', () => {
  it('announces itself and delivers what the bus publishes', async () => {
    const stream = openStream(`${base}/api/stream?ticket=${await newTicket()}`);

    const hello = await stream.waitFor('event: hello');
    // Tell the browser to back off further than its three-second default, or
    // a restart brings every client back at the same instant.
    expect(hello).toContain('retry: 5000');

    app.events.publish({ symbol: 'AAPL', quote: true, signals: 1 });

    const text = await stream.waitFor('event: market');
    expect(text).toMatch(/id: \d+/);

    const payload = JSON.parse(
      /event: market\ndata: (.+)\n/.exec(text)?.[1] ?? '{}',
    ) as { quotes: string[]; signals: string[] };

    expect(payload.quotes).toContain('AAPL');
    expect(payload.signals).toContain('AAPL');

    stream.close();
  });

  it('coalesces a burst into a single frame', async () => {
    const stream = openStream(`${base}/api/stream?ticket=${await newTicket()}`);
    await stream.waitFor('event: hello');

    for (const symbol of ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'GME']) {
      app.events.publish({ symbol, quote: true });
    }

    const text = await stream.waitFor('event: market');
    // Give any straggler frames a chance to arrive before counting.
    await new Promise((r) => setTimeout(r, 120));

    const frames = stream.text().match(/event: market/g) ?? [];
    expect(frames).toHaveLength(1);
    expect(text).toContain('AAPL');
    expect(stream.text()).toContain('GME');

    stream.close();
  });

  it('sets the headers a proxy needs to not buffer it', async () => {
    // Several PaaS proxies buffer responses by default, which for a stream
    // means the browser receives nothing until it ends. It never ends.
    const controller = new AbortController();
    const res = await fetch(`${base}/api/stream?ticket=${await newTicket()}`, {
      signal: controller.signal,
    });

    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-cache');
    expect(res.headers.get('x-accel-buffering')).toBe('no');

    controller.abort();
  });

  it('resumes from a sequence, and says so when it cannot', async () => {
    /*
     * A client that reconnects after a gap must either be caught up or told to
     * start over. Silently sending nothing is the worst option: it leaves the
     * screen confidently displaying stale data, which is the exact failure
     * this product exists to prevent.
     */
    app.events.publish({ symbol: 'AAPL', quote: true });
    await new Promise((r) => setTimeout(r, 60));
    const seq = app.events.currentSeq;
    expect(seq).toBeGreaterThan(0);

    // Ask from one before the newest: recoverable, so it replays.
    const resumable = openStream(`${base}/api/stream?ticket=${await newTicket()}&since=${seq - 1}`);
    await resumable.waitFor('event: market');
    resumable.close();

    // Ask from a sequence far older than the buffer: not recoverable.
    const stale = openStream(`${base}/api/stream?ticket=${await newTicket()}&since=-500`);
    const text = await stale.waitFor('event: resync');
    expect(text).toContain('gap too large');
    stale.close();
  });

  it('lets the server shut down instead of holding it open', async () => {
    /*
     * The one that would have bitten in production. `fastify.close()` waits
     * for in-flight requests to finish, and an SSE response never finishes by
     * design - so one connected browser turns a graceful restart into a hang.
     * On a platform that redeploys by draining the old instance, that is an
     * outage rather than an inconvenience.
     *
     * Uses a throwaway server so the shared one survives for later tests.
     */
    const solo = await buildApp({ config, clock, inMemory: true });
    await solo.bootstrap();
    const server2 = await buildServer({ app: solo });
    await server2.listen({ port: 0, host: '127.0.0.1' });

    const addr = server2.server.address();
    if (typeof addr === 'string' || addr === null) throw new Error('no port');
    const base2 = `http://127.0.0.1:${addr.port}`;

    const reg = await fetch(`${base2}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: 'shutdown', password: TEST_PASSWORD }),
    });
    const tok = ((await reg.json()) as { token: string }).token;

    const ticketRes = await fetch(`${base2}/api/stream/ticket`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}` },
    });
    const { ticket } = (await ticketRes.json()) as { ticket: string };

    const stream = openStream(`${base2}/api/stream?ticket=${ticket}`);
    await stream.waitFor('event: hello');

    const started = Date.now();
    await server2.close();
    const took = Date.now() - started;

    /*
     * Before the preClose hook this never returned at all - the run died on
     * the 180-second hook timeout. So the bound only has to separate
     * "completes" from "hangs indefinitely"; it is not a benchmark, and a
     * tight one just makes the suite fail on a busy machine instead.
     */
    expect(took).toBeLessThan(30_000);
    // And the client was told why, rather than just seeing the socket vanish.
    // The final chunk can still be in flight when close() returns, so wait for
    // it rather than reading the buffer at whatever instant we got here. The
    // wait is generous on purpose: this asserts the frame *arrives*, and a
    // tight bound would only measure how loaded the machine is.
    await stream.waitFor('event: bye', 20_000);

    stream.close();
    await solo.shutdown();
  }, 30_000);

  it('releases its subscription when the client goes away', async () => {
    // A leak here would accumulate a dead subscriber per reconnect, and every
    // published event would then walk a list of sockets nobody is reading.
    //
    // Wait for the earlier tests' sockets to finish tearing down first, or the
    // baseline is read mid-teardown and the assertion races.
    await settleSubscribers();
    const before = app.events.subscriberCount;

    const stream = openStream(`${base}/api/stream?ticket=${await newTicket()}`);
    await stream.waitFor('event: hello');
    expect(app.events.subscriberCount).toBe(before + 1);

    stream.close();

    const deadline = Date.now() + 3000;
    while (app.events.subscriberCount > before && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(app.events.subscriberCount).toBe(before);
  });
});
