# Sigma

**A watchlist that answers "should I care?" instead of "what's the price?"**

```bash
npm install && npm run dev     # → http://localhost:5173
```

**Live market data, no API key, no database to install, no configuration.**
It fetches real prices and a real year of history the moment it starts.

---

## The problem with the obvious watchlist

A conventional watchlist is a table of tickers sorted by percentage change. It
has three flaws, and they compound:

**1. Percentage change is not information.** A 2% move in a utility is a
three-sigma event that ought to interrupt your day. A 5% move in GameStop is a
Tuesday. Ranking by percentage guarantees the same handful of volatile names
dominate forever, while the genuinely surprising moves in quiet names never
surface. You learn to ignore the top of the list.

**2. "Today's change" is the wrong reference point.** You did not last look at
this at 09:30. You looked on Thursday. The number you want is the change since
*your* last visit, and no watchlist tracks that.

**3. It cannot tell the market from the company.** If your holding is down 3%
on a day the whole index is down 3%, nothing happened to that company. A table
of red numbers reports ten separate alarms for one macro event — and stays
silent when a stock falls 1% on a day everything else rose 2%, which is the
one that actually deserves a look.

So this is not a table. It is a **diff against your last visit**, ranked by how
unusual each change is *for that specific instrument*.

---

## Three ideas do the work

### 1. A personal watermark

Every user has a per-symbol checkpoint: the last state of the world they
actually acknowledged, price included. The home screen is `now − checkpoint`.

The checkpoint moves **only when you press the button.** Reading the briefing
does not consume it, and a page refresh cannot destroy it. Glancing at your
phone on the train must not eat the briefing you meant to read at your desk.
And because it is one click, it is undoable — one level deep, including the
very first acknowledgement, where the correct "previous state" is *no
checkpoint at all*.

### 2. Significance, not magnitude

Every move is divided by what that instrument normally does over the same
amount of **market** time:

```
significance = return_since_checkpoint / (σ_daily × √sessions_elapsed)
```

Two details matter more than they look:

- **Market time, not wall-clock time.** A checkpoint set on Friday evening and
  read on Monday morning spans *one* session of risk, not three days of it.
  Using wall-clock time would make every Monday look calm.
- **The horizon is floored.** Without a floor, a 1% move ten seconds after your
  checkpoint divides by almost nothing and reads as forty sigma.

Then the move is split into the part the market explains and the part it does
not:

```
residual = return − β × market_return
```

β comes from an actual regression of the instrument's daily returns on the
benchmark's. The residual is what "something happened to this company" means,
and it is frequently the **opposite sign** to the headline number.

### 3. Episodes, not samples

A stock that is 3σ down and *stays* 3σ down is one event. Poll it every five
seconds for a day and a naive engine produces seventeen thousand alerts about
it. The user mutes the product and it has failed at the only thing it promised.

So each detector drives a hysteresis state machine: a condition **enters** an
episode at one threshold and only **leaves** at a lower one. The dead band
absorbs a value oscillating around a single threshold.

```
 value
   │        ╭──── one episode ────╮
2.0├────────┼─────────────────────┼──── enter
   │      ╭─╯                     ╰─╮
1.0├──────┼─────────────────────────┼── exit
   │  ╭───╯                         ╰────
   └──┴───────────────────────────────────▶ time
      ↑ silent      ONE signal        ↑ closes
```

Three refinements earn their place:

- **Intensifying revises in place.** A move deepening from 2.2σ to 4.1σ updates
  the existing signal rather than adding a second one — but does not touch
  `detected_at`, or an old signal could leapfrog your watermark and reappear as
  new.
- **A changed character starts a new episode.** A 30-day high becoming a
  52-week high is genuinely new information, so the episode key includes a
  discriminator.
- **State is persisted, not remembered.** If it lived in memory, every deploy
  would re-announce every currently-elevated symbol. A restart must be silent.

---

## What counts as meaningful

Ten detectors, each a pure function of a world snapshot. All thresholds live in
[`server/src/config.ts`](server/src/config.ts) so the product's opinion is
auditable in one place rather than scattered as magic numbers.

| Signal | Fires when | Why it earns a slot |
| --- | --- | --- |
| `idio_move` | market-adjusted move ≥ 2σ of residual vol | The highest-weighted signal. "Something happened *here*." |
| `sigma_move` | move since previous close ≥ 2σ of own vol | Magnitude relative to this name's own noise. |
| `gap` | open vs prior close ≥ 1.5× ATR | Repriced overnight — you could not have traded through it. |
| `range_break` | through the 52-week or 30-day extreme | A level that has held for a long time. |
| `volume_spike` | ≥ 2.5× median volume, **paced by session progress** | Unpaced, this fires on the time of day rather than the market. |
| `trend_flip` | 20/50-session average crossover | Slow, and therefore exactly what a returning user missed. |
| `vol_regime` | 10-session vol ≥ 1.8× the 90-session baseline | "This name has become dangerous." |
| `drawdown` | crossing a 10/20/30/50% bucket below the 52-week peak | Bucketed, so a two-month grind produces three signals, not thousands. |
| `stale_data` | no fresh price beyond the staleness budget, **and the market is open** | **The absence of data is news** — but only when there should have been data. |
| `data_conflict` | providers disagree beyond tolerance | Surfaced, never silently resolved. |

### Two deliberate refusals

**It says when it does not know.** A detector without enough history returns
`null`, not a guess. The UI renders *"insufficient history"* rather than an
invented volatility. `null` and `0` are different answers and the difference is
the product's credibility.

**It suppresses analysis it cannot stand behind.** When a quote goes stale, the
market detectors are silenced — computing "3.4σ move" from an hour-old price is
confident nonsense and the user cannot tell. The *integrity* detectors are
exempt, because reporting the staleness is precisely what should happen.

### Ranking, and a noise budget

Detection asks "did something happen?". Ranking asks the harder question:
*of the things that happened, which does this person need to read?*

```
score = severity × kind_weight × recency_decay × pin_boost × confidence
```

Multiplicative, so a muted symbol or a worthless data source drives the score
toward zero rather than merely subtracting a constant. Then:

- **A hard cap on items.** A briefing that does not fit on a screen is a feed.
  What does not fit is *counted*, not dropped silently.
- **A per-symbol cap.** One dramatic stock must not consume the whole briefing
  and hide the other nine things.
- **Every item shows its reasoning** and expands to the raw numbers. A ranking
  nobody can audit is a ranking nobody should trust.
- **Saying nothing happened is a feature.** The briefing names the symbols it
  checked and deliberately found unremarkable. Without that, the user re-scans
  the whole watchlist anyway and the ranking was pointless.

---

## Architecture

```
                        ┌─────────────────────────────────────┐
   providers            │        detection (global)           │
   ┌──────────┐         │                                     │
   │ synthetic│──┐      │  quote ─▶ 10 detectors ─▶ episode   │
   │ finnhub  │──┼─▶ registry ─▶     (pure)        machine    │
   │ …        │──┘      │                             │       │
   └──────────┘  │      └─────────────────────────────┼───────┘
                 │                                    ▼
        single-flight ─ rate limit ─ breaker    signals table
        ─ retry ─ timeout ─ reconcile        (append-only, unique
                 │                            per symbol+kind+episode)
                 ▼                                    │
          quotes / bars / stats                       │
                 │                                    │
                 └──────────────┬─────────────────────┘
                                ▼
                    read path: signals ⋈ user_symbol_marks
                                ▼
                          ranked briefing
```

**Detection is global; personalisation is a read-time join.** Ten thousand
users watching AAPL share one detection cycle and one signal row. The cost of
the system scales with the number of *instruments people care about*, not with
the number of people. This is the single decision the whole design rests on.

### Separating the market, the sector, and the company

The question a user actually has when a holding drops 4% is not "did it drop"
- they can see that. It is *whose fault is it*. So every move is decomposed
against two factors, and the three parts sum to the total exactly:

```
XOM  −1.53%  =  market −0.01%  +  energy +0.63%  +  this company −2.14%
NVDA +8.74%  =  market +1.24%  +  semis  +0.62%  +  this company +6.88%
```

Those are real numbers from a live run. XOM is the interesting one: energy rose
while XOM fell, so the company-specific part is *larger* than the headline
move - exactly the case a raw percentage hides.

The second factor matters most for what it *stops*. With one market factor, a
sector-wide repricing is idiosyncratic for every member: eight semiconductors
fall on one piece of news and the briefing fires eight near-identical alarms.
Betas are fitted by OLS on a year of daily returns, with the sector factor
orthogonalised against the market first - otherwise the two are collinear, the
coefficients flip sign between recomputes, and the market beta silently stops
meaning what it did.

Real fitted loadings from that run, which are recognisable rather than
arbitrary:

| Symbol | Market β | Sector β | Proxy |
| --- | --- | --- | --- |
| JPM | 0.78 | **1.12** | XLF |
| XOM | −0.55 | **1.05** | XLE |
| KO | −0.26 | **0.90** | XLP |
| NVDA | 1.92 | 0.44 | SMH |

### Learning what you do not care about

Dismissals were recorded and never read, which meant a user could say the same
thing a hundred times and be ignored. They now adjust a per-kind weight in the
ranking - and every property of that is a guard against the way personalisation
usually goes wrong:

- **It demotes, it never hides.** A learned weight multiplies an existing
  score and is floored at 0.5. Only an explicit mute removes something. A feed
  that silently stops showing you things is one you cannot trust to have shown
  you the important one.
- **It needs evidence.** Three dismissals move the weight by 4%. Fifty move it
  by 31%. The first few times someone clears a notification they are usually
  just clearing a notification.
- **It is asymmetric.** Down to 0.5, up to 1.15. Promoting a kind because
  someone opened it twice is how a feed eats itself.
- **Integrity signals are exempt.** "This price cannot be trusted" is not a
  preference, and dismissing one is not a request to be kept in the dark next
  time.
- **It says so, and it can be reset.** The rank line reads *"you usually
  dismiss these (×0.71)"*, and `POST /api/preferences/learned/reset` clears it.

### How it scales

| Dimension | Mechanism |
| --- | --- |
| Many users, same symbols | Signals are global. `watchlist_items(symbol)` is a **reverse index**: the poller works from the union of all watchlists, so a symbol held by 10,000 users costs one request per cycle. |
| Large watchlists | The read path is a fixed number of batched queries — no query inside a loop. 500 symbols costs the same round trips as 5. Statistics are materialised on session close, not recomputed per request. |
| Many symbols | `ingest_jobs` is a queue table, not a timer per symbol. `FOR UPDATE SKIP LOCKED` hands concurrent workers **disjoint** batches, so the ingest tier scales horizontally with no coordination service. |
| Read replicas | Set `DATABASE_READ_URL` and market-data reads route to a replica while every write stays on the primary. The split follows *who writes the row*: quotes, bars and signals are written by ingest and can lag a second; watchlists and checkpoints are written by the user's own request and never leave the primary — so no request ever reads back its own write from a replica. |
| Attention | Three poll tiers. A symbol someone is *looking at* polls every 5s; one merely sitting in a list, every 20s; one nobody has opened, every 2 min. Attention earns freshness — that is what makes a 500-symbol list affordable. |
| Bounded cost | Batch size caps per-tick work; concurrency is bounded inside a batch; market-closed multiplies every interval by 8. |
| Many connected browsers | The live stream broadcasts per **symbol**, not per user, and carries no payload — one event serves every subscriber, and each client re-reads its own personalised view. Broadcast cost scales with instruments, not users. Bursts are coalesced into one event per 250ms. |
| Unbounded growth | Signals and idempotency keys are pruned past the maximum digest lookback. Bind-parameter limits are chunked, so the user with 3,000 symbols does not hit a wall nobody tested. |

### Handling unreliable data

Every one of these exists because it was hit, and each is exercised by a test:

- **Out-of-order responses.** Concurrent fetches can complete in the wrong
  order. `upsertQuote` carries `WHERE as_of <= excluded.as_of`, so an older
  response cannot overwrite a newer one and make the price visibly jump
  backwards. The write reports whether it was accepted; detection skips a
  rejected one.
- **Provider disagreement.** Two sources beyond tolerance produce a recorded
  conflict, a lowered confidence, and a user-visible warning. The accepted
  price is the **median** (robust to one bad feed) rather than the freshest
  (which lets a single broken fast provider win every time).
- **Garbage prices.** A provider returning `0` for a price is discarded rather
  than propagated as a −100% move.
- **A vendor that reports a date but no time.** CNBC does. Stamping those
  quotes with our own receive time would have won every `asOf` comparison and
  pinned freshness to `fresh` permanently — so all weekend, with the exchange
  shut, the quote would have claimed to be seconds old, disabling the `closed`
  state and the stale-data detector with it. The date is mapped to that
  session's closing bell instead, clamped so a live session cannot produce a
  future timestamp.
- **A live stream that dies quietly.** The dangerous failure is not a stream
  that errors — the browser reports those — but one held open and silent by a
  buffering proxy. Polling never stops; it drops to a two-minute heartbeat
  while the stream is healthy, which caps how long a screen can be wrong.
- **A reconnect gap that cannot be reconstructed.** If a client asks to resume
  from a sequence older than the retained buffer, the server says `resync` and
  the client reloads. Silently sending nothing would leave it confidently
  displaying stale data — a rich failure for this product in particular.
- **Staleness as a ladder,** not a boolean: fresh → delayed → stale → unknown,
  each rendered differently. A future timestamp is `unknown`, not fresh —
  that's a broken clock, not a current price.
- **Circuit breaker** per provider, three-state. Half-open admits exactly *one*
  probe, so a still-broken provider trips again after one request rather than
  after a burst. An unknown symbol never counts toward the failure ratio —
  otherwise one user's typo'd tickers would trip the breaker for everybody.
- **Jittered backoff.** When a provider dies, every symbol fails at once and
  would otherwise retry in lockstep forever — a self-inflicted thundering herd
  arriving exactly when the upstream can least cope.
- **Delisting.** A symbol no provider recognises is *marked*, not deleted. The
  user put it there deliberately and its disappearance is the news. It is
  un-marked automatically when it resolves again.
- **Downtime.** On waking, the ingester notices the sessions that closed while
  it was asleep, re-fetches them, and runs detection over the gap. **Downtime
  costs latency, not correctness** — which is what makes a free host that
  sleeps a viable place to run this.
- **Idempotency.** Mutating requests take an `Idempotency-Key`; a retry replays
  the stored response. Reusing a key with a *different* body is rejected rather
  than silently swallowing the second intent.
- **Concurrent edits.** Watchlists carry a version, checked under `FOR UPDATE`
  — without the row lock the check is decorative, since two requests could both
  read v4, both pass, and both write. The loser gets a 409 *with the current
  version* so it can reconcile in one round trip.

---

## Running it

### Locally

```bash
npm install
npm run dev          # API :8787 + web :5173
```

`npm install` is the only setup step. Local development runs **embedded
Postgres** ([PGlite](https://pglite.dev), Postgres compiled to WASM), so there
is a real database with real Postgres semantics and nothing to install.

```bash
npm test             # 297 tests (268 server, 29 web)
npm run typecheck    # both workspaces
npm run seed         # warm every instrument + a few ingest cycles
npm run reset        # drop everything and reseed
```

### The Lab

Open **Lab** in the running app. It breaks the system on purpose:

| Button | What you should see |
| --- | --- |
| `NEE +2.5%` vs `GME +6%` | The utility outranks the meme stock despite moving less than half as far. |
| `Come back later −60m` | Rewinds your checkpoint. The briefing widens to cover the window. |
| `100% failure` | The breaker opens after a few failures. Prices keep serving, labelled with their age. |
| `Age 45 min` | Staleness warnings replace statistical claims. |
| `Halt TSLA` / `Delist GME` | Halted and vanished instruments, handled distinctly. |
| `Skew prices 3%` | With two providers, a recorded conflict and lowered confidence. |

Resilience you cannot demonstrate is decoration. This is how you check.

### Choosing a feed

```bash
npm run dev                          # two live sources, no API key (the default)
PROVIDERS=yahoo npm run dev          # one live source
PROVIDERS=synthetic npm run dev      # the deterministic simulator
PROVIDERS=yahoo,finnhub npm run dev  # a third, if you have a Finnhub key
```

**The default is two live vendors, and neither needs an API key.** That is
deliberate: with a single provider, reconciliation is dead code — the median is
never taken, the spread is always zero, the confidence penalty never fires. Two
independent vendors quoting the same instrument makes it a demonstrated
behaviour instead: a recorded conflict when they disagree beyond tolerance, a
median rather than the freshest, and a lowered confidence the UI shows.

See it for yourself, without starting the app:

```bash
cd server && npx tsx src/scripts/vendorCheck.ts AAPL MSFT NVDA TSLA
```

```
market CLOSED  ·  last session close 2026-09-04T20:01:00Z

AAPL
  cnbc      319.97   asOf 2026-09-04T20:00:00Z
  yahoo     319.97   asOf 2026-09-04T20:00:01Z
  → 319.97 via cnbc+yahoo  ·  spread within tolerance  ·  closed  ·  confidence 1.000
```

CNBC serves quotes only. Merging two vendors' bar series means reconciling
different split-adjustment conventions, and getting that subtly wrong would
corrupt every volatility estimate — the number this whole product rests on.

### In production

One service, single origin — the API serves the built frontend, which removes
CORS from the deployment entirely.

```bash
DATABASE_URL=postgres://…  SERVE_WEB=1  npm run build && npm start
```

Setting `DATABASE_URL` switches from embedded to managed Postgres. **Same SQL
either way** — one dialect, so every query is tested against the database users
actually hit. See [`docs/DECISIONS.md`](docs/DECISIONS.md) for why that
mattered enough to give up SQLite's convenience.

---

## The market data is real

The default feed is **live Yahoo Finance data** — real prices, real daily
history, real volumes — and it needs no API key and no signup.

That took some finding. Alpha Vantage allows 25 requests a *day*; Finnhub's
free tier dropped daily candles; Stooq now sits behind a JavaScript
proof-of-work challenge. For a product that needs a year of history per symbol
before it can say anything at all, none of those work. Yahoo's chart endpoint
returns a live quote *and* a year of daily bars in one call.

The catch, stated plainly: **it is an undocumented endpoint.** It can change or
start refusing traffic without notice. That is not a reason to avoid it — it is
the reason every provider in this project sits behind a circuit breaker, a rate
limiter, single-flight coalescing and a fallback. The architecture assumes the
upstream is unreliable, because this one is.

Three things about that API that cost real debugging, all now handled:

- **`chartPreviousClose` is not yesterday's close.** It is the close *before the
  requested range began*, so at `range=1y` it is a year old. Using it would
  report AAPL as **+33.9% every single day**. The correct previous close is the
  prior bar, and the derivation is cross-checked against Yahoo's own reported
  change percentage.
- **The OHLCV arrays contain `null`s.** Halted sessions come back as nulls
  inside otherwise-valid arrays; a naive `.map()` produces NaN prices that
  poison every statistic downstream.
- **One call answers both questions.** Quote and history share a payload, so
  caching them separately doubles the request count for no benefit. Keying the
  cache by symbol rather than by (symbol, range) halved it.

### Two things a live feed forced the design to get right

**A closed market is not stale data.** A Friday closing price read on Saturday
is not a fetch we failed — it *is* the current price. Freshness is therefore
measured against the *market's* clock, not the wall clock, and has its own
`closed` state that neither cries wolf nor suppresses the analysis. Getting
this wrong means a product that spends every weekend claiming to be broken.

**History has to be replayed, or a new instance has nothing to say.** Detection
runs on live quotes, so a freshly-seeded instance knows a year of prices and
holds *no signals at all* — open it on a Saturday and the briefing is empty
even though the week was eventful. So on startup the detectors are walked
across the stored bars in chronological order, through the same episode state
machine, with statistics computed as-of each session rather than from the full
history. Real market history becomes a real signal timeline. It is idempotent,
so restarting does not duplicate it.

### The simulator is still there

```bash
PROVIDERS=synthetic npm run dev
```

A seeded three-factor market — `r = drift + β·market + β_sector·sector +
idiosyncratic + jump`, with volatility clustering and Brownian-bridge intraday
paths — running on a compressed clock where a session lasts 45 seconds.

It earns its place for two reasons. It makes the failure modes *demonstrable*:
the Lab page can shock a price, halt an instrument or make two sources disagree
on demand, none of which you can ask a real exchange to do. And because the
generated returns really do have the configured betas, a test can assert that
regressing the simulated data **recovers them** — which is what makes "the
market explains this move" a claim the engine can verify rather than assert.

Live and simulated feeds are mutually exclusive, enforced at startup. Mixing
them would reconcile a real $320 against a simulated $170 and report a
permanent 47% disagreement.

## API

Bearer token; `POST /api/session` issues one.

| Route | Purpose |
| --- | --- |
| `GET /api/digest` | The briefing. Side-effect free with respect to the watermark. |
| `POST /api/digest/acknowledge` | Advance the checkpoint. Idempotent. |
| `POST /api/digest/undo` | Restore the previous checkpoint. |
| `POST /api/signals/read` | Dismiss individual signals without moving the checkpoint. |
| `GET /api/watchlists/:id/rows` | The table. `all` spans every list. |
| `POST/PATCH/DELETE /api/watchlists/:id/items…` | Manage symbols, pins, mutes, per-symbol thresholds. |
| `GET /api/symbols/:symbol` | Full detail: history, statistics, signal timeline, plumbing. |
| `GET /api/health` | Readiness — 200 only when the database actually answers. |
| `GET /api/ops/diagnostics` | Scheduler, breakers, poll queue, active faults. |
| `POST /api/dev/*` | Fault injection. Gated behind `DEV_TOOLS`. |

Errors carry a stable machine-readable `code` alongside the human message.
Clients branch on the code; parsing prose to decide whether to retry breaks on
a copy edit.

---

## Layout

```
server/src/
  domain/          pure logic — no I/O, no clock reads
    stats.ts         volatility, ATR, OLS regression
    calendar.ts      NYSE hours and holidays
    marketClock.ts   "what is a session?" as an injectable interface
    signals/
      detectors.ts   ← the product's opinion about "meaningful"
      hysteresis.ts  ← the episode state machine
      scoring.ts     ← ranking and the noise budget
  providers/       upstream feeds behind one interface + reconciliation
  db/              schema, migrations, repositories (all SQL lives here)
  services/        detection, ingestion, read models
  ingest/          the queue-driven scheduler
  api/             HTTP, auth, idempotency, error translation
web/src/           React, no state-management library
docs/DECISIONS.md  what was chosen, what was given up, and when to revisit
```

`domain/` takes no dependencies on anything below it. That is what lets the
interesting logic be tested without standing anything up — and it is why the
test suite runs in 15 seconds with no mocking framework.

---

## Honest limits

What this does not do, and why.

- **Notifications only reach an open tab.** Desktop notifications fire from the
  live stream, which means the browser has to be running. True background push
  needs a service worker and VAPID keys; the decision logic - severity floor,
  once per episode, silent while you are looking, a ceiling per hour - is
  already here and would carry over unchanged.
- **The sector factor is a traded proxy, not a real risk model.** Nine sector
  ETFs, one factor each. A production risk model would use size, value,
  momentum and quality alongside them. Two factors capture most of what a user
  actually asks ("is this the market, my sector, or my company?") and stay
  explainable, which a nine-factor model would not.
- **Learned weights are per-kind, not per-symbol.** Dismissing every
  `volume_spike` teaches the ranking about volume spikes in general, not about
  volume spikes *in GME*. Per-symbol would need far more data per user before
  it said anything.
- **Every instrument is USD.** The `currency` column exists; FX-adjusted
  returns do not. Doing it properly needs an FX feed and a decision about
  which currency significance is measured in.
- **History comes from one vendor.** Quotes are reconciled across two; bars are
  Yahoo's alone, because merging two vendors' split-adjustment conventions
  would corrupt every volatility estimate. Two coherent quote sources and one
  coherent history is the right trade at this size.
- **The demo runs on a free instance that sleeps.** First load after an idle
  period takes ~30s to wake, and it wakes with a gap in its history. Backfill
  handles the gap correctly - that path is tested - but the wait is real.
