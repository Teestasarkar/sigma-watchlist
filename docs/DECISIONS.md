# Decisions

What was chosen, what was given up, and the condition under which I would
revisit it. Ordered roughly by how much of the design each one determines.

---

## 1. Detection is global; personalisation happens at read time

**Decision.** Signals are computed once per symbol and stored in one table with
no user column. A user's briefing is those signals filtered against their own
per-symbol watermark at read time.

**The alternative** was per-user evaluation: for each user, for each symbol,
decide what is notable. It is the obvious shape, and it is why watchlist
products get expensive — cost becomes `users × symbols` instead of `symbols`.

**Given up.** Truly per-user *detection thresholds* cannot change what is
detected, only what is shown. A user who wants to hear about 1σ moves when the
global entry threshold is 2σ cannot, because the signal was never created.

**Revisit when** per-user sensitivity becomes a real feature request. The fix
is a two-tier scheme: detect globally at a permissive threshold, filter per
user at a stricter one. The schema already supports it (`min_sigma` per item);
only the global entry threshold would need lowering, at the cost of a larger
signals table.

---

## 2. Significance is measured in the instrument's own volatility

**Decision.** Every move is divided by `σ_daily × √sessions_elapsed`, and split
into market-explained and idiosyncratic components via an OLS regression on the
benchmark.

**The alternative** was ranking by percentage change, which is what almost
every watchlist does. It is simpler, needs no history, and is wrong: it
guarantees the same volatile names occupy the top of the list permanently while
the surprising moves in quiet names never surface.

**Given up.**

- **A history requirement.** A brand-new symbol has no volatility estimate, so
  the product must say "insufficient history" rather than rank it. I consider
  that a feature, but it is a real cost — the first day with a new symbol is
  less useful than a naive tool would be.
- **Fragility to regime change.** A 90-session volatility window is slow to
  notice that a name has become permanently more volatile. The `vol_regime`
  detector exists partly to cover this, but a move can read as 4σ against a
  stale baseline.
- **Beta is unstable** for names with short or illiquid histories. The
  regression falls back to β = 1 when the market has no variance or there are
  too few paired observations — deliberately the conservative direction, since
  it attributes the move to the market rather than crying news.

**Revisit** the volatility estimator if false positives cluster around regime
changes. An EWMA or a proper GARCH fit would adapt faster than a rolling
window; the interface (`computeStats`) would not change.

---

## 3. Hysteresis, not thresholds

**Decision.** Conditions enter an episode at one threshold and leave at a lower
one, with the state persisted in the database.

**The alternative** — fire whenever the value exceeds a threshold — produces
one alert per poll for a condition that persists, and flaps endlessly for a
value oscillating around the threshold. That is the single most common way
alerting products become unusable.

**Given up.** A genuine second event inside one episode is missed. If a stock
is 3σ down, recovers to 1.5σ (still above the 1.0σ exit), then falls to 3σ
again, that is arguably two pieces of news and we report one. The intensify
path partly covers it — the signal is revised upward — but it stays one item in
the briefing.

**Why the state is in Postgres and not in memory:** a restart would otherwise
forget which episodes were open and re-announce every currently-elevated
symbol. Every deploy would become a notification storm. This is the kind of
thing that is obvious in hindsight and expensive to discover in production.

---

## 4. Reading never advances the watermark

**Decision.** `GET /api/digest` has no side effect on the checkpoint. Only an
explicit `POST /api/digest/acknowledge` moves it, and that is undoable.

**The alternative** — mark everything seen as the digest is generated — is one
line shorter and destroys the product. Opening the app on a phone, on a train,
without reading it, would silently consume the briefing you meant to read
properly later.

**Given up.** Users must perform an action to clear the briefing. Some will not
and will accumulate a growing window. Mitigations: the lookback is capped at
14 days, and individual signals can be dismissed without moving the whole
checkpoint.

**A subtlety worth recording.** The window is half-open — a signal counts as
"since you looked" only if `detected_at > checkpoint`. A signal detected in the
same millisecond as an acknowledgement is therefore not shown. Strictly, that
loses information. The alternative (`>=`) risks re-showing a signal that was
just acknowledged, which is the worse failure for trust, and human-driven
actions do not race at millisecond granularity. It is documented rather than
papered over.

---

## 5. One SQL dialect: Postgres everywhere, embedded locally

**Decision.** [PGlite](https://pglite.dev) (Postgres compiled to WASM) for
local development and tests; managed Postgres in production. One dialect, two
drivers behind a small `SqlClient` interface.

**The alternative I started with, and abandoned,** was SQLite locally and
Postgres in production. It is the conventional choice and I got several hundred
lines in before backing it out. The reason: two dialects means every query is
exercised against a database that is not the one users hit, and the differences
are exactly where the interesting bugs live — `ON CONFLICT` semantics,
`MAX`/`GREATEST`, `jsonb`, transactional DDL, and `FOR UPDATE SKIP LOCKED`,
which the scheduler depends on and SQLite does not have at all.

**Given up.**

- **Startup time.** PGlite boots a WASM Postgres in ~1–2s, versus SQLite's
  effectively zero. Acceptable for a dev server; it is why the test suite uses
  one shared in-memory instance per file rather than per test.
- **A native dependency traded for a 3MB WASM bundle.** On balance a win:
  `better-sqlite3` needs a compiler or a matching prebuilt binary, which is its
  own class of "works on my machine".

**Cost of the migration:** every repository method became `async`, and
transactions had to be threaded somehow. They travel through
`AsyncLocalStorage` rather than an explicit parameter on every signature, which
keeps repository methods composable — a method that wants atomicity can ask for
it without knowing whether its caller already opened a transaction.

**Revisit** if PGlite proves unstable, or if the read path outgrows a single
instance. The `SqlClient` seam means adding a read-replica driver is one file.

---

## 6. The default feed is live, and the simulator stays

**Decision.** Live Yahoo Finance data by default, with a seeded simulator
available behind one environment variable. They are mutually exclusive.

**What changed my mind.** The first version shipped simulator-first, and the
reasoning was sound as far as it went: every free API is rate-limited into
uselessness, so a live feed risked the reviewer's first experience being an
empty screen and a 429. What that reasoning missed is that "the prices are
invented" is the one sentence that makes a reader discount everything else in
the project. Yahoo's chart endpoint turned out to return a live quote *and* a
year of daily bars in one keyless call, which removes the constraint entirely.

**Given up.** An undocumented endpoint. It can change or start refusing traffic
without notice, and there is no support channel. Mitigated rather than
pretended away: conservative rate limiting, a circuit breaker, single-flight
coalescing, a cache that lets one call serve both the quote and the history,
and `PROVIDERS=synthetic` as a one-variable escape hatch.

**Why the simulator survives.** Two things a real exchange cannot do on demand:
be broken, and be verified. The Lab page shocks a price, halts an instrument
and makes two sources disagree - none of which you can ask NYSE for. And
because the simulated returns genuinely carry the configured betas, a test can
assert that regressing them **recovers those betas**, which is what makes "the
market explains this move" a checkable claim rather than an assertion.

**Mutual exclusion is enforced at startup**, and that is not a limitation to
work around. Real AAPL is $320; simulated AAPL is $170. Reconciling them
reports a permanent 47% disagreement, and interleaving their bars produces a
price series with a cliff in the middle that reads as the largest gap in market
history. Whichever kind is listed first wins; the other is dropped with a
warning.

---

## 6a. A closed market is not stale data

**Decision.** Freshness is judged against the *market's* clock, and has a
distinct `closed` state.

**The bug this fixes.** Freshness started as pure wall-clock age: under thirty
seconds fresh, under five minutes delayed, beyond that stale. Correct during
trading hours and completely wrong outside them. On a Saturday every price is
hours old, so the whole watchlist rendered red, the health strip claimed a
degraded feed, and - worst - detection *suppressed all market analysis*,
because the rule "do not analyse a price we do not trust" was being applied to
a price that was perfectly trustworthy.

A Friday closing print read on Saturday is not a fetch we failed. There has
been no trading to miss. It is the current price.

**So:** if the market is shut and the quote is at or after the last completed
session's close, it is `closed` - full confidence, analysis proceeds, and the
UI says "market closed, showing the last closing prices" rather than crying
wolf. A quote that predates the last close *is* genuinely stale, because that
means a whole session was missed, and that is a real failure.

**Given up.** One more state for every consumer to handle, and a grace window
of ninety minutes around the bell that is a judgement call rather than a fact.

---

## 6b. Replaying history so a new instance has something to say

**Decision.** On startup, walk the detectors across stored bars in
chronological order and record the signals they would have produced.

**The problem.** Detection runs on live quotes. A freshly-seeded instance knows
a year of prices and holds no signals whatsoever, so its briefing is empty
until something happens while it happens to be watching. Open it at the weekend
and it has nothing to say about a week that was full of events. That is a
product failure, not merely a demo problem: a user adding a symbol on Saturday
should be able to see that it gapped 8% on Wednesday.

**Why it is a replay and not hindsight.** Statistics are recomputed on a prefix
of the history at each step, so a move in March is judged against the
volatility known in March. Feeding it full-history statistics would make every
historical signal wrong in the direction that flatters us. It also runs through
the same episode state machine in chronological order, so a two-week trend
produces one signal rather than one per bar.

**Given up.** It is expensive - a year of statistics recomputed per replayed
session - so it is capped at a dozen sessions and skips symbols that already
have signals. And a daily bar is not an intraday path: a session that fell 5%
and recovered looks flat, so intraday-shaped signals are not recoverable. Both
limits are stated in the module rather than hidden.

---

## 7. The market clock is an injectable interface

**Decision.** "What is a trading session?" is an interface with two
implementations: real NYSE hours, and a compressed always-open grid for the
simulator.

**Why it is not a detail.** Significance is a ratio, and the denominator is
only meaningful if its time unit matches the volatility estimate's. Two
concrete ways to get this wrong:

- Wall-clock time treats a Friday→Monday absence as three days of risk when it
  is one session. Every Monday morning would look calm.
- Real trading days measured against a simulator whose sessions last 45
  seconds makes every tick a 40σ event.

**A bug this caused, and the fix.** The first version of the simulated clock
mapped session indices onto real calendar dates so charts would show
plausible-looking dates. That created *two coordinate spaces* — a bar's
timestamp and a wall-clock instant meant different things — and canonicalising
a year-old bar walked ~700,000 loop iterations. It hung on startup.

The fix was to require `sessionCloseOf` to be **idempotent**:
`sessionCloseOf(sessionCloseOf(t)) === sessionCloseOf(t)`. Bars are keyed by it
and every write re-canonicalises, so anything else is a latent remapping. The
real calendar clock already satisfied it (16:00 ET is a fixed point); the
simulated one now does too, at the cost of session-index labels on charts
instead of dates. Pretty axes are not worth a second coordinate system.

---

## 8. The ingest queue is a table, not timers

**Decision.** `ingest_jobs` holds `next_run_at` per symbol. A scheduler tick
claims due rows with `FOR UPDATE SKIP LOCKED`, which both selects and leases in
one statement.

**The alternative** — `setInterval` per symbol — is fine for thirty symbols and
fails for thirty thousand: timers do not survive a restart, cannot be shared
across processes, and offer nowhere to apply backpressure.

**What the lease buys.** Two scheduler ticks, or two instances after a
scale-up, cannot claim the same symbol and double-fetch it. `SKIP LOCKED` hands
each worker a *disjoint* batch instead of having them all contend on the
head of the queue. The ingest tier therefore scales horizontally with no
coordination service, no leader election, and no Redis.

**Given up.** Sub-second polling is not practical — the floor is the tick
interval. Irrelevant here; a watchlist does not need tick data. If it did, this
would be the wrong architecture entirely and a streaming subscription would
replace it.

---

## 9. Attention determines freshness

**Decision.** Three poll tiers. Recently *viewed* → 5s. Merely on a list →
20s. Nobody has opened it → 2 min. Market closed multiplies everything by 8.

**Why attention rather than list membership.** A user with 400 symbols on a
dashboard is not looking at 400 symbols. They are looking at the eight on
screen. Polling all 400 aggressively spends the entire upstream budget to keep
392 numbers fresh that nobody will read this hour.

**Given up.** A symbol nobody has opened may be up to two minutes stale when
someone finally opens it. Mitigated by expediting on view — opening a symbol
pulls its next poll forward immediately — so the staleness is bounded by one
request, not by the tier interval.

---

## 10. Real credentials, and scrypt rather than argon2id

**Decision.** Password authentication using `scrypt` from `node:crypto`, at the
OWASP floor of N=65536, r=8, p=1.

**Why not argon2id,** which is the current first recommendation: it needs a
native module. A build step that can fail on a deployment target is its own
class of outage, and this project already made the same trade once when it
dropped `better-sqlite3`. scrypt is memory-hard, in the standard library, and
explicitly acceptable at these parameters.

**What this earned beyond a login form.** Each of the following is an attack
the obvious implementation permits:

- A **per-account salt**, so one cracked hash reveals nothing about another and
  a precomputed table is useless. Cost parameters are stored *inside* the hash
  string, so they can be raised later without invalidating existing passwords -
  and a successful login is the one moment the plaintext is in hand, so that is
  where an under-cost hash is transparently upgraded.
- **Constant-time comparison.** A byte-by-byte early exit leaks how much of a
  guess was correct, which turns cracking into a per-character search.
- **A missing account still pays for a full hash**, and every failure returns
  an identical status, code and message. Otherwise the error text - or simply
  the response time - is a free account-enumeration oracle. Both are asserted,
  including a timing-ratio check.
- **Lockout state in Postgres, not a process-local map**, which a deploy or a
  second replica would defeat. Five free attempts, then a doubling delay to
  fifteen minutes, applied to the correct password too: a lockout that lets the
  right password through is a hint, not a lockout.
- **A concurrency gate on hashing.** Memory-hard means about 64MB per hash;
  without a cap, a handful of simultaneous logins is a trivial
  memory-exhaustion attack on a small instance.
- **Changing a password revokes every other session.** A change that leaves an
  intruder's token working has achieved nothing.

**Given up.** No email, so no password reset and no verification - which also
means "that username is taken" is unavoidably an enumeration signal for a
chosen display name. A real product keys accounts on a verified email; that is
the first thing I would add. No TOTP, no OAuth.

**The demo account's password is published** in the UI and in the API's policy
endpoint. That is deliberate: a demo account with a secret password is not a
demo account.

---

## 13. Two live vendors, because one makes reconciliation dead code

The registry reconciles disagreeing sources: it takes the **median** rather
than the freshest, records the spread, and lets a disagreement lower the
quote's confidence. With a single provider none of that ever executes. The
median is never taken, the spread is always zero, the penalty never fires.

Every second vendor I looked at wanted an API key, which turns "watch two feeds
disagree" into something a reader has to go and arrange before they can see it.
CNBC's public quote service needs none and is genuinely independent of Yahoo:
different vendor, different consolidator, different rounding. So the default is
now `PROVIDERS=yahoo,cnbc` and reconciliation is live on first run.

Two things about it needed care.

**Quotes only; history stays with Yahoo.** Merging two vendors' bar series
means reconciling different split-adjustment conventions and session
boundaries. Getting that subtly wrong corrupts every volatility estimate — the
number this entire product rests on. One coherent history beats two blended
ones, so `capabilities.history` is `false` and the registry skips it.

**The timestamp was a trap.** CNBC reports a session *date* and no time,
anywhere, including its extended-hours block. The obvious shortcut is to stamp
the quote with our own receive time. That would have been invisible and
actively harmful: `reconcileQuotes` takes the newest `asOf` across sources, so
a receive-time stamp wins every comparison and pins freshness to `fresh`
permanently. All weekend — exchange shut, Yahoo correctly reporting Friday's
close — the quote would claim to be seconds old, silently disabling the
`closed` state (§ 6a) and the stale-data detector with it. Instead the date is
mapped to that session's closing bell, clamped to now so a live session cannot
produce a future timestamp. During an open session that does degrade to receive
time; CNBC gives us nothing better, and it is why Yahoo stays preferred.

The endpoint also batches, and a refresh cycle asks for a dozen symbols within
milliseconds, so the provider coalesces them into one request. In a live run
that showed as 33 Yahoo requests against 6 CNBC ones for the same work.

`npx tsx src/scripts/vendorCheck.ts AAPL MSFT NVDA` prints both feeds, the
spread, and the resulting confidence.

---

## 14. Push, but polling never goes away

Polling every 8 seconds was always an awkward fit for a product arguing "you
shouldn't have to keep looking" — it just moves the looking into the browser.
The server now pushes over SSE.

**Server-sent events, not WebSockets.** The traffic is strictly one-way; the
client has nothing to say that an ordinary POST cannot carry. SSE gets
reconnection, backoff and `Last-Event-ID` resume from the browser for free,
over plain HTTP/1.1 that every proxy already understands.

**Events are global and carry no data.** An event says "AAPL moved", never
"your watchlist changed". That is the same split the rest of the system runs on
(§ 1): detection once per symbol, personalisation at read time. So one event
serves every subscriber to that symbol and broadcast cost scales with
*instruments*, not users. A subscriber that hears the news re-reads the
ordinary REST endpoint — one extra round trip, in exchange for a single
serialisation path that cannot drift from the one everyone else uses.

**Bursts are coalesced.** The scheduler refreshes in batches, so a naive bus
emits a dozen events in a millisecond and every client refetches a dozen times
— strictly worse than the polling it replaces. Publishes are merged into one
event per 250ms window.

**Polling never stops.** It drops to a two-minute heartbeat while the stream is
healthy and returns to 8s the moment it is not. The dangerous failure is not a
stream that errors — the browser reports those — it is one that stays open and
silent behind a proxy that decided to buffer it. The heartbeat puts a ceiling
on how long a screen can be wrong. The header says which mode it is in, because
a user deciding whether to act on a number is entitled to know.

**A gap is admitted, not hidden.** If a reconnecting client asks from a
sequence older than the retained buffer, the server sends `resync` and the
client reloads. Quietly sending nothing would leave it displaying stale data
with full confidence — which would be a rich failure for *this* product to
commit.

**The credential is not the session token.** `EventSource` cannot set headers,
so whatever authenticates the stream lands in a URL — and URLs land in proxy
logs, browser history and `Referer`. The session is exchanged over a normal
authenticated POST for a nonce that expires in 30 seconds and works once.

**Shutdown had to be taught to end streams.** `fastify.close()` waits for
in-flight requests, and an SSE response never finishes by design — so one
connected browser turned a graceful restart into a hang. A `preClose` hook ends
open streams with a `bye` frame first, so clients back off deliberately instead
of stampeding a server that is going away. The test suite found this, not
production.

---

## 11. No state-management library on the frontend

**Decision.** `useState`, one `load()` function, a 20-line hash router.

**Reasoning.** The app has one screen's worth of server state and four
mutations. React Query or Redux would add a dependency, a mental model, and a
build-size cost to solve a problem that does not exist at this size. That said,
two behaviours a library would have given for free are implemented explicitly
because they genuinely matter:

- **Polling pauses when the tab is hidden,** and refreshes immediately on
  becoming visible. A background tab hammering the API for hours is rude, and
  the data is worthless the moment the user looks away.
- **A sequence guard on loads,** so a slow response from a previous view cannot
  overwrite a newer one — the same out-of-order problem as the quote guard, one
  layer up.

**Revisit** at the point where more than one component needs to mutate the same
server state, or when optimistic updates need rollback across views.

---

## 12. Things I decided *not* to build

Each of these was considered and consciously dropped, which is different from
not having thought of it.

- **A charting library.** The sparkline is ~120 lines of hand-rolled SVG
  because the one thing it must do — shade the period since *your* checkpoint —
  is exactly what a generic library will not do, and everything else at that
  size is noise.
- **Multi-currency.** Every instrument is USD. The `currency` column exists;
  FX-adjusted returns do not. Doing it properly needs an FX feed and a
  decision about which currency significance is measured in.
- **WebSockets.** There *is* live push now (§ 14), but over server-sent
  events. The traffic is one-way, so a WebSocket would mean hand-rolling
  reconnection, backoff and resume to replace what `EventSource` already does.
- **A CSS framework.** ~900 lines of hand-written CSS with design tokens.
  Tailwind would have been faster to type and would have put the design
  decisions in the markup, where they are harder to keep coherent.
