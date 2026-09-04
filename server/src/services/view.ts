/**
 * The read path: turning stored state into the two things the user actually
 * looks at - the briefing ("what changed since I last checked") and the
 * watchlist table.
 *
 * Performance shape
 * -----------------
 * Everything here is a fixed number of batched queries regardless of how many
 * symbols the user watches. No query runs inside a loop. A 500-symbol
 * watchlist costs the same round trips as a 5-symbol one; only the row count
 * differs. That is deliberate - N+1 in a read path this hot is the difference
 * between a snappy dashboard and a 4-second page load.
 *
 * The watermark rule
 * ------------------
 * Reading never advances the watermark. It would be trivially convenient to
 * mark everything seen as the digest is generated, and it would destroy the
 * product: glancing at your phone on the train would silently consume the
 * briefing you meant to read at your desk. Advancing is an explicit,
 * undoable action - see `acknowledge`.
 */

import type {
  DataHealth,
  Digest,
  Freshness,
  InstrumentStats,
  Quote,
  Signal,
  SymbolMark,
  WatchRow,
  Watchlist,
  WatchlistItem,
} from '../domain/types.js';
import type { MarketClock } from '../domain/marketClock.js';
import { sigmaOfMove } from '../domain/stats.js';
import { rankSignals } from '../domain/signals/scoring.js';
import { classifyFreshness } from '../providers/reconcile.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { InstrumentRow, MarketRepo } from '../db/marketRepo.js';
import type { SignalRepo } from '../db/signalRepo.js';
import type { IngestRepo } from '../db/ingestRepo.js';
import type { UserRepo } from '../db/userRepo.js';

export interface ViewOptions {
  freshness: { freshMs: number; delayedMs: number; staleMs: number };
  digest: {
    maxItems: number;
    maxPerSymbol: number;
    /** Lookback windows in trading sessions - see MarketClock.sessionsAgo. */
    firstVisitLookbackSessions: number;
    maxLookbackSessions: number;
  };
  recencyHalfLifeMs: number;
  minBarsForStats: number;
}

/** Everything the two views share, gathered once. */
interface Snapshot {
  symbols: string[];
  instruments: Map<string, InstrumentRow>;
  quotes: Map<string, Quote>;
  stats: Map<string, InstrumentStats>;
  items: Map<string, WatchlistItem>;
  marks: Map<string, SymbolMark>;
}

export class ViewService {
  constructor(
    private readonly users: UserRepo,
    private readonly market: MarketRepo,
    private readonly signals: SignalRepo,
    private readonly jobs: IngestRepo,
    private readonly registry: ProviderRegistry,
    private readonly clock: MarketClock,
    private readonly opts: ViewOptions,
  ) {}

  /**
   * Load the shared state for a user's symbols in five parallel queries.
   *
   * Parallel rather than sequential because they are independent; on a remote
   * database that is the difference between 5 round trips of latency and 1.
   */
  private async snapshot(userId: string, symbols: string[]): Promise<Snapshot> {
    const [instruments, quotes, stats, items, marks] = await Promise.all([
      this.market.getInstruments(symbols),
      this.market.getQuotes(symbols),
      this.market.getStatsMany(symbols),
      this.users.listAllItems(userId),
      this.users.getMarks(userId, symbols),
    ]);
    return { symbols, instruments, quotes, stats, items, marks };
  }

  // ─────────────────────────────────────────────────────── the briefing

  /**
   * The digest.
   *
   * The window is *per symbol*, because each symbol has its own watermark: a
   * user may have acknowledged AAPL this morning and not looked at NEE for a
   * week. The SQL cutoff is the earliest of those watermarks (one indexed
   * query), then each signal is filtered against its own symbol's watermark in
   * memory. Doing it per symbol in SQL would mean one query per symbol.
   */
  async getDigest(userId: string, now: number): Promise<Digest> {
    const symbols = await this.users.listUserSymbols(userId);

    if (symbols.length === 0) {
      return {
        generatedAt: now,
        window: { from: now, to: now, isFirstVisit: true, clamped: false },
        groups: [],
        suppressedCount: 0,
        quiet: [],
        health: await this.health([], new Map()),
      };
    }

    const snap = await this.snapshot(userId, symbols);

    /*
     * Per-symbol cutoffs, and the earliest of them for the SQL query.
     *
     * Both are computed in *sessions* via the market clock, not in wall-clock
     * milliseconds. Against the compressed simulator clock a "three day"
     * window would otherwise span a third of a trading year, and dividing a
     * move by the square root of that many sessions reports genuine news as
     * noise.
     */
    const firstVisitCutoff = this.clock.sessionsAgo(
      now,
      this.opts.digest.firstVisitLookbackSessions,
    );
    const hardFloor = this.clock.sessionsAgo(now, this.opts.digest.maxLookbackSessions);

    const cutoffs = new Map<string, number>();
    let earliest = now;
    let anyFirstVisit = false;
    let clamped = false;

    for (const symbol of symbols) {
      const mark = snap.marks.get(symbol);
      let cutoff: number;
      if (!mark) {
        cutoff = firstVisitCutoff;
        anyFirstVisit = true;
      } else {
        cutoff = mark.seenAt;
      }
      // A user returning after three months should get a briefing, not a
      // firehose of everything that ever happened.
      if (cutoff < hardFloor) {
        cutoff = hardFloor;
        clamped = true;
      }
      cutoffs.set(symbol, cutoff);
      if (cutoff < earliest) earliest = cutoff;
    }

    const candidates = await this.signals.getSignalsSince(symbols, earliest);
    const relevant = candidates.filter((s) => s.detectedAt > (cutoffs.get(s.symbol) ?? earliest));

    const readIds = await this.users.getReadSignalIds(
      userId,
      relevant.map((s) => s.id),
    );

    const confidence = new Map<string, number>();
    for (const symbol of symbols) {
      confidence.set(symbol, snap.quotes.get(symbol)?.confidence ?? 0.5);
    }

    const names = new Map<string, string>();
    for (const symbol of symbols) {
      names.set(symbol, snap.instruments.get(symbol)?.name ?? symbol);
    }

    const ranked = rankSignals(
      { signals: relevant, items: snap.items, names, readIds, confidence },
      {
        now,
        recencyHalfLifeMs: this.opts.recencyHalfLifeMs,
        maxItems: this.opts.digest.maxItems,
        maxPerSymbol: this.opts.digest.maxPerSymbol,
      },
    );

    /*
     * The quiet list.
     *
     * Saying "these eleven symbols did nothing worth mentioning" confidently
     * is a feature, not filler. It is the difference between a briefing the
     * user can trust as complete and one they have to double-check by
     * scrolling the whole watchlist anyway.
     */
    const surfaced = new Set(ranked.groups.map((g) => g.symbol));
    const quiet = symbols
      .filter((s) => !surfaced.has(s))
      .map((symbol) => {
        const delta = this.sinceSeen(symbol, snap, now);
        return { symbol, changePct: delta.changePct, sigma: delta.sigma };
      })
      // Show the largest quiet movers first: they are the most likely to make
      // the user doubt the briefing, so they earn their place at the top.
      .sort((a, b) => Math.abs(b.sigma ?? 0) - Math.abs(a.sigma ?? 0));

    // Record that these symbols were looked at, which promotes them to the
    // hot polling tier. Fire-and-forget: it must never delay the response.
    void this.jobs.touchActivity(symbols, now).catch(() => undefined);

    return {
      generatedAt: now,
      window: { from: earliest, to: now, isFirstVisit: anyFirstVisit, clamped },
      groups: ranked.groups,
      suppressedCount: ranked.suppressedCount,
      quiet,
      health: await this.health(symbols, snap.quotes, snap.stats),
    };
  }

  // ─────────────────────────────────────────────────────── the table

  async getWatchlistRows(userId: string, watchlistId: string | null, now: number): Promise<{
    watchlist: Watchlist | null;
    rows: WatchRow[];
  }> {
    let symbols: string[];
    let watchlist: Watchlist | null = null;
    let itemsForList: Map<string, WatchlistItem> | null = null;

    if (watchlistId) {
      watchlist = await this.users.getWatchlist(watchlistId, userId);
      if (!watchlist) return { watchlist: null, rows: [] };
      const items = await this.users.listItems(watchlistId);
      itemsForList = new Map(items.map((i) => [i.symbol, i]));
      symbols = items.map((i) => i.symbol);
    } else {
      symbols = await this.users.listUserSymbols(userId);
    }

    if (symbols.length === 0) return { watchlist, rows: [] };

    const snap = await this.snapshot(userId, symbols);
    const openCounts = await this.signals.countOpenBySymbol(symbols);

    // One query for the top signal of every symbol rather than one per symbol.
    const topSignals = await this.topSignalPerSymbol(symbols, now);

    const rows: WatchRow[] = symbols.map((symbol) => {
      const instrument = snap.instruments.get(symbol);
      const quote = snap.quotes.get(symbol) ?? null;
      const stats = snap.stats.get(symbol) ?? null;
      const item =
        itemsForList?.get(symbol) ??
        snap.items.get(symbol) ?? {
          symbol,
          addedAt: now,
          pinned: false,
          muted: false,
          minSigma: null,
          note: null,
          sortKey: 0,
        };

      const freshness: Freshness = quote
        ? classifyFreshness(quote.asOf, now, this.opts.freshness)
        : 'unknown';

      const sinceSeen = this.sinceSeen(symbol, snap, now);

      const todayPct =
        quote && quote.prevClose > 0 ? quote.price / quote.prevClose - 1 : null;

      const rvol =
        quote && stats && stats.medVol20 > 0
          ? quote.volume / (stats.medVol20 * Math.max(0.08, this.clock.sessionProgress(now)))
          : null;

      return {
        symbol,
        name: instrument?.name ?? symbol,
        sector: instrument?.sector ?? null,
        item,
        quote,
        freshness,
        stats: stats
          ? {
              sigmaDaily: stats.sigmaDaily,
              atrPct: stats.atrPct,
              beta: stats.beta,
              bars: stats.bars,
            }
          : null,
        sinceSeen,
        today: { changePct: todayPct },
        rvol,
        openSignals: openCounts.get(symbol) ?? 0,
        topSignal: topSignals.get(symbol) ?? null,
      };
    });

    void this.jobs.touchActivity(symbols, now).catch(() => undefined);

    return { watchlist, rows };
  }

  /**
   * The number this product is actually about: the move since *you* last
   * looked, in both percent and sigma.
   *
   * Falls back to the previous close when there is no watermark yet, which is
   * the conventional "today's change" - the right default for a first visit.
   */
  private sinceSeen(
    symbol: string,
    snap: Snapshot,
    now: number,
  ): WatchRow['sinceSeen'] {
    const quote = snap.quotes.get(symbol);
    const mark = snap.marks.get(symbol);
    const stats = snap.stats.get(symbol);

    if (!quote) {
      return { from: null, fromAt: null, changePct: null, sigma: null };
    }

    const from = mark?.seenPrice ?? quote.prevClose;
    const fromAt = mark?.seenAt ?? null;

    if (!(from > 0)) {
      return { from: null, fromAt, changePct: null, sigma: null };
    }

    const changePct = quote.price / from - 1;

    // Horizon in *market* sessions, not wall-clock: a watermark set on Friday
    // evening and read on Monday morning spans one session of risk, not three
    // days of it.
    const horizon = fromAt
      ? this.clock.sessionsBetween(fromAt, now)
      : Math.max(0.15, this.clock.sessionProgress(now));

    const hasEnoughHistory = stats !== undefined && stats.bars >= this.opts.minBarsForStats;
    const sigma = hasEnoughHistory
      ? sigmaOfMove(changePct, stats.sigmaDaily, horizon)
      : null;

    return { from, fromAt, changePct, sigma };
  }

  /**
   * Highest-severity open signal per symbol, in one query.
   *
   * Uses the digest's own lookback so the badge on a row agrees with what the
   * briefing would show for that symbol.
   */
  private async topSignalPerSymbol(
    symbols: readonly string[],
    now: number,
  ): Promise<Map<string, Signal>> {
    const since = this.clock.sessionsAgo(now, this.opts.digest.maxLookbackSessions);
    const all = await this.signals.getSignalsSince(symbols, since);
    const best = new Map<string, Signal>();
    for (const s of all) {
      const current = best.get(s.symbol);
      if (!current || s.severity > current.severity) best.set(s.symbol, s);
    }
    return best;
  }

  // ─────────────────────────────────────────────────────── data health

  /**
   * An honest account of how much to trust what is on screen.
   *
   * Surfaced as a first-class part of the response rather than hidden behind a
   * debug page, because "we cannot currently price three of your holdings" is
   * something the user needs at the same moment they are reading prices.
   */
  async health(
    symbols: readonly string[],
    quotes: ReadonlyMap<string, Quote>,
    stats?: ReadonlyMap<string, InstrumentStats>,
  ): Promise<DataHealth> {
    const now = Date.now();
    const order: Freshness[] = ['fresh', 'delayed', 'stale', 'unknown'];
    let worst: Freshness = 'fresh';

    const stale: string[] = [];
    const conflicted: string[] = [];
    const halted: string[] = [];
    const thinHistory: string[] = [];

    for (const symbol of symbols) {
      const quote = quotes.get(symbol);
      const freshness: Freshness = quote
        ? classifyFreshness(quote.asOf, now, this.opts.freshness)
        : 'unknown';

      if (order.indexOf(freshness) > order.indexOf(worst)) worst = freshness;
      if (freshness === 'stale' || freshness === 'unknown') stale.push(symbol);
      if (quote?.conflict) conflicted.push(symbol);
      if (quote?.halted) halted.push(symbol);

      const s = stats?.get(symbol);
      if (!s || s.bars < this.opts.minBarsForStats) thinHistory.push(symbol);
    }

    return {
      worstFreshness: symbols.length === 0 ? 'fresh' : worst,
      stale,
      conflicted,
      halted,
      thinHistory,
      providers: this.registry.health(),
    };
  }

  // ─────────────────────────────────────────────────────── watermarks

  /**
   * Advance the watermark: "I have read this; measure from here."
   *
   * Records the price *as displayed*, not merely the timestamp, so the next
   * visit can say "up 2.1% since you last looked" with a real reference point
   * rather than re-deriving one from a bar close.
   */
  async acknowledge(
    userId: string,
    symbols: readonly string[] | null,
    now: number,
  ): Promise<{ acknowledged: number; symbols: string[] }> {
    const target = symbols?.length
      ? [...symbols]
      : await this.users.listUserSymbols(userId);
    if (target.length === 0) return { acknowledged: 0, symbols: [] };

    const quotes = await this.market.getQuotes(target);
    const entries = target.map((symbol) => ({
      symbol,
      price: quotes.get(symbol)?.price ?? null,
    }));

    const acknowledged = await this.users.advanceMarks(userId, entries, now);
    return { acknowledged, symbols: target };
  }

  /** Undo the last acknowledgement, restoring the previous checkpoint. */
  async undoAcknowledge(
    userId: string,
    symbols: readonly string[] | null,
  ): Promise<{ restored: number }> {
    const target = symbols?.length
      ? [...symbols]
      : await this.users.listUserSymbols(userId);
    const restored = await this.users.undoMarks(userId, target);
    return { restored };
  }
}
