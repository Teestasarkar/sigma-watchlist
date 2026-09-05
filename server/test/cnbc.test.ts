/**
 * The second live vendor.
 *
 * Two things here are worth testing and the rest is plumbing:
 *
 *  1. **The timestamp.** CNBC reports a session *date* and no time. Stamping
 *     quotes with our own receive time instead would be invisible in every
 *     screenshot and would silently disable the `closed` freshness state and
 *     the stale-data detector, because reconciliation takes the newest `asOf`
 *     across sources. This is the bug this file exists to prevent.
 *
 *  2. **The batching.** A refresh cycle asks for a dozen symbols at once and
 *     they must leave as one HTTP request, against an undocumented rate limit
 *     where the cost of guessing wrong is being cut off.
 *
 * `fetch` is stubbed throughout: a test that depends on CNBC being reachable
 * is a test that fails on a train.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CnbcProvider } from "../src/providers/cnbc.js";
import {
  SymbolNotFoundError,
  TransientProviderError,
} from "../src/providers/types.js";
import { exchangeClock } from "../src/domain/marketClock.js";
import { ManualClock } from "../src/infra/clock.js";

/** A response in CNBC's actual shape, formatted for a web page as it really is. */
function quote(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    symbol: "AAPL",
    code: 0,
    last: "319.97",
    open: "328.31",
    high: "328.93",
    low: "317.86",
    volume: "35,660,636",
    previous_day_closing: "328.21",
    change_pct: "-2.51%",
    last_time: "2026-09-04",
    curmktstatus: "POST_MKT",
    ...over,
  };
}

function body(...quotes: Array<Record<string, unknown>>): string {
  return JSON.stringify({ FormattedQuoteResult: { FormattedQuote: quotes } });
}

/**
 * Answer with a *fresh* Response every call.
 *
 * A Response body can only be read once, so handing the same object to two
 * requests fails the second — which is exactly what the batching tests do.
 */
function respond(payload: string, status = 200): () => Promise<Response> {
  return async () =>
    new Response(payload, {
      status,
      headers: { "content-type": "application/json" },
    });
}

/** Friday 2026-09-04, 16:00 America/New_York — the session CNBC is reporting. */
const FRI_CLOSE = exchangeClock.sessionCloseOf(Date.UTC(2026, 8, 4, 16));
/** Saturday afternoon: the market is shut and Friday's close is still current. */
const SATURDAY = Date.UTC(2026, 8, 5, 18);

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function provider(now: number): CnbcProvider {
  // A one-millisecond batch window keeps the tests fast without changing the
  // behaviour under test.
  return new CnbcProvider(exchangeClock, new ManualClock(now), {
    batchWindowMs: 1,
  });
}

describe("reading a CNBC quote", () => {
  it("parses prices that are formatted for a human", () => {
    // The whole payload is strings with commas, currency and percent signs in
    // them. Number() returns NaN for every one of these.
    const p = provider(SATURDAY);
    fetchMock.mockImplementation(respond(body(quote())));

    return p.getQuote("AAPL").then((q) => {
      expect(q.price).toBe(319.97);
      expect(q.prevClose).toBe(328.21);
      // "35,660,636" — the comma is the point.
      expect(q.volume).toBe(35_660_636);
      expect(q.source).toBe("cnbc");
    });
  });

  it("never lets a NaN reach a price field", async () => {
    // A provider returning garbage must be rejected, not propagated as a
    // -100% move — which is what an unguarded NaN or 0 becomes downstream.
    const p = provider(SATURDAY);
    fetchMock.mockImplementation(
      respond(
        body(
          quote({ symbol: "BAD1", last: "N/A" }),
          quote({ symbol: "BAD2", last: "0.00" }),
        ),
      ),
    );

    await expect(p.getQuote("BAD1")).rejects.toThrow(SymbolNotFoundError);
    await expect(p.getQuote("BAD2")).rejects.toThrow(SymbolNotFoundError);
  });

  it("treats a non-zero code as an unknown symbol", async () => {
    // CNBC still returns an entry for a symbol it does not know; `code` is the
    // only thing distinguishing it from a real quote.
    const p = provider(SATURDAY);
    fetchMock.mockImplementation(respond(body({ symbol: "ZZZQQ", code: 1 })));

    await expect(p.getQuote("ZZZQQ")).rejects.toThrow(SymbolNotFoundError);
  });

  it("keeps the day range around the price", async () => {
    // An extended-hours print above the regular-session high would otherwise
    // store a price outside its own day range, which the range-break detector
    // reads as a breakout.
    const p = provider(SATURDAY);
    fetchMock.mockImplementation(respond(body(quote({ last: "340.00" }))));

    const q = await p.getQuote("AAPL");
    expect(q.dayHigh).toBeGreaterThanOrEqual(q.price);
    expect(q.dayLow).toBeLessThanOrEqual(q.price);
  });
});

describe("the timestamp CNBC does not give us", () => {
  it("reports the session close, not the moment we asked", async () => {
    /*
     * The headline test. On Saturday, Friday's closing price is the correct
     * and current price — but it is *Friday's*. Stamping it "now" would make
     * every weekend quote claim to be seconds old.
     */
    const p = provider(SATURDAY);
    fetchMock.mockImplementation(respond(body(quote())));

    const q = await p.getQuote("AAPL");

    expect(q.asOf).toBe(FRI_CLOSE);
    expect(q.asOf).toBeLessThan(SATURDAY);
    // Roughly a day and a half stale in wall-clock terms, and correctly so.
    expect(SATURDAY - q.asOf).toBeGreaterThan(20 * 3600_000);
  });

  it("does not claim a timestamp in the future mid-session", async () => {
    /*
     * During a live session the closing bell has not rung yet. Reporting it
     * would put `asOf` ahead of `now`, which classifies as "unknown" freshness
     * and tanks confidence for a perfectly good price.
     */
    const midSession = Date.UTC(2026, 8, 4, 17, 30); // ~13:30 ET, Friday
    const p = provider(midSession);
    fetchMock.mockImplementation(respond(body(quote())));

    const q = await p.getQuote("AAPL");

    expect(q.asOf).toBeLessThanOrEqual(midSession);
    expect(q.asOf).toBe(midSession);
  });

  it("falls back to now when the date is missing or malformed", async () => {
    const p = provider(SATURDAY);
    fetchMock.mockImplementation(
      respond(body(quote({ last_time: "yesterday" }))),
    );

    const q = await p.getQuote("AAPL");
    expect(q.asOf).toBe(SATURDAY);
  });

  it("is stable across repeated reads of the same session", async () => {
    // The timestamp is a key: two reads of Friday's close must agree, or
    // downstream episode bookkeeping sees a new observation every poll.
    const p = provider(SATURDAY);
    fetchMock.mockImplementation(respond(body(quote())));

    const first = await p.getQuote("AAPL");
    const second = await p.getQuote("AAPL");
    expect(first.asOf).toBe(second.asOf);
  });
});

describe("batching a refresh cycle", () => {
  it("collapses concurrent symbols into one request", async () => {
    const p = provider(SATURDAY);
    fetchMock.mockImplementation(
      respond(
        body(
          quote({ symbol: "AAPL", last: "319.97" }),
          quote({ symbol: "MSFT", last: "499.70" }),
          quote({ symbol: "NVDA", last: "188.20" }),
        ),
      ),
    );

    const [aapl, msft, nvda] = await Promise.all([
      p.getQuote("AAPL"),
      p.getQuote("MSFT"),
      p.getQuote("NVDA"),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    // One request, but each caller gets its own symbol back — the failure mode
    // worth guarding is everyone resolving with the first quote in the list.
    expect(aapl?.symbol).toBe("AAPL");
    expect(msft?.price).toBe(499.7);
    expect(nvda?.price).toBe(188.2);

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(decodeURIComponent(url)).toContain("symbols=AAPL|MSFT|NVDA");
  });

  it("gives every caller the same quote when they ask for the same symbol", async () => {
    const p = provider(SATURDAY);
    fetchMock.mockImplementation(respond(body(quote())));

    const results = await Promise.all([p.getQuote("AAPL"), p.getQuote("aapl")]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results[0]?.price).toBe(results[1]?.price);
  });

  it("fails only the symbols that are actually missing", async () => {
    // A partial response must not fail the whole batch: one bad ticker in a
    // watchlist should not blank out the other nine.
    const p = provider(SATURDAY);
    fetchMock.mockImplementation(respond(body(quote({ symbol: "AAPL" }))));

    const settled = await Promise.allSettled([
      p.getQuote("AAPL"),
      p.getQuote("NOPE"),
    ]);

    expect(settled[0]?.status).toBe("fulfilled");
    expect(settled[1]?.status).toBe("rejected");
  });

  it("fails everyone together when the request itself fails", async () => {
    // They were one request, so they share its fate.
    const p = provider(SATURDAY);
    fetchMock.mockImplementation(respond("nope", 503));

    const settled = await Promise.allSettled([
      p.getQuote("AAPL"),
      p.getQuote("MSFT"),
    ]);

    expect(settled.every((s) => s.status === "rejected")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("failure is classified, not just thrown", () => {
  it("calls a 5xx transient so the registry retries it", async () => {
    const p = provider(SATURDAY);
    fetchMock.mockImplementation(respond("", 502));
    await expect(p.getQuote("AAPL")).rejects.toThrow(TransientProviderError);
  });

  it("calls a 429 transient rather than a bad symbol", async () => {
    const p = provider(SATURDAY);
    fetchMock.mockImplementation(respond("", 429));
    await expect(p.getQuote("AAPL")).rejects.toThrow(TransientProviderError);
  });

  it("survives an HTML error page served with a 200", async () => {
    // Undocumented endpoints do this. `res.json()` throws, and an unguarded
    // throw here is not classified and so is not retried.
    const p = provider(SATURDAY);
    fetchMock.mockImplementation(respond("<html>maintenance</html>"));
    await expect(p.getQuote("AAPL")).rejects.toThrow(TransientProviderError);
  });

  it("rejects immediately on an already-aborted signal", async () => {
    const p = provider(SATURDAY);
    fetchMock.mockImplementation(respond(body(quote())));

    await expect(p.getQuote("AAPL", AbortSignal.abort())).rejects.toBeDefined();
  });

  it("refuses to serve history rather than returning none", async () => {
    /*
     * The registry skips providers declaring `history: false`, so this is
     * unreachable — but an empty history is not an error downstream, it just
     * means "no statistics". A broken guard would switch the signal engine off
     * for every symbol instead of failing loudly here.
     */
    expect(provider(SATURDAY).capabilities.history).toBe(false);
    await expect(provider(SATURDAY).getHistory()).rejects.toThrow(
      /does not serve history/,
    );
  });
});
