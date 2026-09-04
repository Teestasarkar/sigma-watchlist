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

## 6. The default feed is a simulator

**Decision.** A seeded, deterministic, factor-model market simulator is the
default provider. Real providers implement the same interface and are preferred
when configured.

**The alternative** — ship against a free live API — fails immediately. Free
tiers give 25 requests/day (Alpha Vantage) or 60/minute (Finnhub, no history
on the free plan), against a 30-symbol watchlist polled continuously. The
reviewer's first experience would be an empty screen and a 429.

**Given up.** The prices are not real. This is stated in the UI, in every
quote's `source` field, and here. Using real tickers with invented numbers is a
defensible demo convention *only* if it is unmissable, so it is labelled in
three places.

**What was gained beyond "it runs".**

- The interesting behaviour is reproducible. A 4σ move is a button.
- Failure modes are *demonstrable*. The Lab page can kill the feed, age the
  data, halt an instrument, or make two sources disagree — so the resilience
  code is exercised rather than asserted.
- The factor structure makes the analysis testable. Because the generated
  returns really do have the configured betas, a test can assert that
  regressing the simulated data **recovers them**. If the simulator were noise,
  every "the market explains this" claim would be measuring nothing.

**A bug this decision exposed:** the simulator originally read `Date.now()`
directly rather than its injected clock, so it kept answering from real time
while a test advanced the world around it. Harmless in production, fatal to
testability — and exactly the kind of thing that hides until you try to test a
three-day outage.

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

## 10. Auth is a bearer token with no password

**Decision.** `POST /api/session` with a handle returns a token. No password,
no email verification, no refresh flow.

**Reasoning.** Authentication is not what this exercise is about, and a
half-built login (password hashing but no reset, no rate limiting on attempts,
no session revocation) is *worse* than an obvious shortcut: it invites the
reader to assume a security property that is not there. This is honest about
being a demo.

**What is real** because it affects the design: sessions are rows, so
revocation is a `DELETE`; tokens are opaque and random; the token is the rate-
limit key. Adding real credentials touches one table and one route.

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

- **WebSockets.** The read path polls every 8s while visible. Push would be
  genuinely better for a trading tool and is the wrong first optimisation for a
  product whose whole thesis is that you check it *periodically*, not
  continuously. It would also not survive a free host that sleeps.
- **A charting library.** The sparkline is ~120 lines of hand-rolled SVG
  because the one thing it must do — shade the period since *your* checkpoint —
  is exactly what a generic library will not do, and everything else at that
  size is noise.
- **Multi-currency.** Every instrument is USD. The `currency` column exists;
  FX-adjusted returns do not. Doing it properly needs an FX feed and a
  decision about which currency significance is measured in.
- **Corporate actions.** A 2-for-1 split currently reads as a −50% move. Real
  deployment needs an adjustment feed. This is the most serious remaining
  correctness gap and I would fix it before showing this to anyone with money
  at stake.
- **A CSS framework.** ~900 lines of hand-written CSS with design tokens.
  Tailwind would have been faster to type and would have put the design
  decisions in the markup, where they are harder to keep coherent.
