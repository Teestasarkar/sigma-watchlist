/**
 * Application shell: routing, data loading, and the mutations.
 *
 * No state-management library. The app has one screen's worth of server state
 * and a hash route; `useState` plus a reload function is genuinely the right
 * size, and anything more would be architecture for its own sake.
 *
 * Two behaviours here are deliberate and worth reading:
 *
 *  - **Polling pauses when the tab is hidden.** A background tab hammering the
 *    API for hours is rude to the server and to the user's battery, and the
 *    data is worthless the moment they look away.
 *  - **Mutations carry the watchlist version.** A 409 is caught, the fresh
 *    state is loaded, and the user is told - rather than the two devices
 *    silently overwriting each other.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, getToken } from './lib/api.js';
import { connectStream, type StreamStatus } from './lib/stream.js';
import {
  notifyFromDigest,
  notificationsEnabled,
  notifyPermission,
  primeSeen,
  requestNotificationPermission,
  setNotificationsEnabled,
  type NotifyPermission,
} from './lib/notify.js';
import type { Digest, Meta, User, WatchRow, Watchlist } from './lib/types.js';
import { Briefing } from './components/Briefing.js';
import { WatchTable } from './components/WatchTable.js';
import { SymbolDetail } from './components/SymbolDetail.js';
import { Lab } from './components/Lab.js';
import { AddSymbol } from './components/AddSymbol.js';
import { Banner, Spinner } from './components/primitives.js';
import { SignIn } from './components/SignIn.js';

type View = { name: 'briefing' } | { name: 'list' } | { name: 'lab' } | { name: 'symbol'; symbol: string };

/** A three-line hash router. Deep links to a symbol survive a refresh. */
function parseHash(): View {
  const raw = window.location.hash.replace(/^#\/?/, '');
  if (raw.startsWith('symbol/')) {
    const symbol = raw.slice('symbol/'.length).toUpperCase();
    if (symbol) return { name: 'symbol', symbol };
  }
  if (raw === 'list') return { name: 'list' };
  if (raw === 'lab') return { name: 'lab' };
  return { name: 'briefing' };
}

/**
 * Poll cadence.
 *
 * `POLL_MS` is the fallback: the stream is down, or the browser never managed
 * to open it. `IDLE_POLL_MS` is the safety net that keeps running *underneath*
 * a healthy stream - because a stream that dies quietly, without an error the
 * browser reports, is the one failure mode that would leave a user staring at
 * a frozen screen believing it was live.
 */
const POLL_MS = 8000;
const IDLE_POLL_MS = 120_000;

export default function App(): React.JSX.Element {
  const [view, setView] = useState<View>(parseHash);
  const [user, setUser] = useState<User | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [digest, setDigest] = useState<Digest | null>(null);
  const [rows, setRows] = useState<WatchRow[]>([]);
  const [watchlist, setWatchlist] = useState<Watchlist | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [busySymbols, setBusySymbols] = useState<Set<string>>(new Set());
  const [canUndo, setCanUndo] = useState(false);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>('connecting');
  const [notifyOn, setNotifyOn] = useState(() => notificationsEnabled());
  const [notifyPerm, setNotifyPerm] = useState<NotifyPermission>(() => notifyPermission());

  // Guards against a slow response from a previous view overwriting a newer one.
  const loadSeq = useRef(0);
  /*
   * `load` in a ref, so the stream subscription does not tear down and
   * reconnect every time the callback identity changes. Reconnecting on every
   * render would defeat the point and hammer the ticket endpoint.
   */
  const loadRef = useRef<() => Promise<void>>(async () => undefined);
  /** False until the first briefing has been absorbed silently. */
  const primedRef = useRef(false);
  /*
   * The symbols this user actually watches.
   *
   * The server broadcasts per *symbol*, not per user - detection runs once and
   * personalisation happens at read time, and the stream mirrors that split so
   * one event serves every subscriber. The filtering therefore happens here.
   * Without it, a busy instrument nobody in this browser cares about would
   * trigger a refetch on every tick.
   */
  const watchedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const onHash = (): void => setView(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const navigate = useCallback((next: View) => {
    const hash =
      next.name === 'briefing' ? '#/' : next.name === 'symbol' ? `#/symbol/${next.symbol}` : `#/${next.name}`;
    if (window.location.hash !== hash) window.location.hash = hash;
    else setView(next);
  }, []);

  /** Load everything the shell needs. Safe to call repeatedly. */
  const load = useCallback(async (): Promise<void> => {
    const seq = ++loadSeq.current;
    try {
      const [d, w] = await Promise.all([api.digest(), api.rows('all')]);
      // A newer load started while this one was in flight; discard it.
      if (seq !== loadSeq.current) return;

      /*
       * Notify about what is new since the last load - but never about the
       * first one.
       *
       * Opening the app after a weekend would otherwise fire a notification
       * for everything that happened while it was closed: a storm, and a
       * pointless one, because the user is looking straight at the list.
       */
      if (primedRef.current) {
        notifyFromDigest(d, { onClick: (symbol) => navigate({ name: 'symbol', symbol }) });
      } else {
        primeSeen(d);
        primedRef.current = true;
      }

      setDigest(d);
      setRows(w.rows);
      setError(null);
    } catch (err) {
      if (seq !== loadSeq.current) return;
      if (err instanceof ApiError && err.status === 401) {
        // The session went away underneath us. Return to sign-in rather than
        // quietly adopting a different identity, which would be worse: the
        // user would be looking at someone else's checkpoint.
        api.forgetToken();
        setUser(null);
        setDigest(null);
        setRows([]);
        return;
      }
      setError(err instanceof Error ? err.message : 'could not load your watchlist');
    }
  }, []);

  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    watchedRef.current = new Set(rows.map((r) => r.symbol));
  }, [rows]);

  /**
   * Load everything that belongs to the signed-in user.
   *
   * Separate from boot so signing in mid-session runs exactly the same path,
   * rather than a second, subtly-different one.
   */
  const loadForUser = useCallback(async (): Promise<void> => {
    const lists = await api.watchlists();
    setWatchlist(lists.watchlists[0] ?? null);
    await load();
  }, [load]);

  /*
   * Boot.
   *
   * Deliberately does NOT sign anyone in. A stored token is resolved and
   * trusted; an absent or rejected one shows the sign-in screen. Silently
   * signing every visitor in as `demo` - which is what this used to do - hid
   * the fact that the app is multi-tenant at all.
   */
  useEffect(() => {
    void (async () => {
      try {
        setMeta(await api.meta());

        if (getToken()) {
          const me = await api.me().catch(() => null);
          if (me) {
            setUser(me.user);
            await loadForUser();
          } else {
            // The token is stale or revoked. Drop it and ask who they are.
            api.forgetToken();
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'could not reach the server');
      } finally {
        setBooting(false);
      }
    })();
  }, [loadForUser]);

  /**
   * The live stream.
   *
   * Opened once per signed-in session and deliberately *not* torn down when
   * the tab is hidden - the connection is idle-cheap, and holding it means
   * returning to the tab shows current data instead of a spinner. Polling is
   * what pauses on hide, because polling is what costs something.
   */
  useEffect(() => {
    if (booting || !user) return;

    const disconnect = connectStream({
      onStatus: setStreamStatus,

      onEvent: (event) => {
        const watched = watchedRef.current;
        // A new signal is worth interrupting for even on a symbol whose price
        // did not move; a price change on something we do not hold is not.
        const relevant =
          event.signals.some((sym) => watched.has(sym)) ||
          event.quotes.some((sym) => watched.has(sym));
        if (relevant) void loadRef.current();
      },

      // The server could not prove what we missed. Reload rather than carry
      // on: showing stale numbers confidently is the failure this app exists
      // to prevent, and it would be especially rich to commit it ourselves.
      onResync: () => void loadRef.current(),
    });

    return disconnect;
  }, [booting, user]);

  /**
   * Poll, but only while the tab is visible.
   *
   * The listener also fires an immediate refresh on becoming visible, so
   * returning to the tab shows current data rather than whatever was on screen
   * when the user left.
   */
  useEffect(() => {
    if (booting) return;

    let timer: number | undefined;

    /*
     * Back right off while the stream is healthy, but never stop.
     *
     * The dangerous failure is not a stream that errors - the browser tells us
     * about those. It is one that stays open and silent behind a proxy that
     * decided to buffer us. A two-minute heartbeat costs almost nothing and
     * puts a ceiling on how long a screen can be wrong.
     */
    const intervalMs = streamStatus === 'live' ? IDLE_POLL_MS : POLL_MS;

    const tick = (): void => {
      if (document.visibilityState === 'visible') void load();
    };

    const start = (): void => {
      stop();
      timer = window.setInterval(tick, intervalMs);
    };
    const stop = (): void => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
    };

    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        void load();
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [booting, load, streamStatus]);

  /**
   * Turn notifications on or off.
   *
   * The permission prompt must come from a click - browsers ignore a request
   * that is not tied to a user gesture - which is why this is a handler rather
   * than something that runs on load.
   */
  const toggleNotifications = async (): Promise<void> => {
    if (notifyOn) {
      setNotificationsEnabled(false);
      setNotifyOn(false);
      flash('Notifications off. The briefing still collects everything.');
      return;
    }

    const perm = await requestNotificationPermission();
    setNotifyPerm(perm);

    if (perm !== 'granted') {
      flash(
        perm === 'denied'
          ? 'Your browser is blocking notifications for this site. Re-allow them in its site settings.'
          : 'Notifications are not available in this browser.',
      );
      return;
    }

    setNotificationsEnabled(true);
    setNotifyOn(true);
    // Say what it will and will not do, so nobody is surprised either way.
    flash('Notifications on. Only high-severity changes, and never while this tab is open.');
  };

  const flash = (message: string): void => {
    setNotice(message);
    window.setTimeout(() => setNotice(null), 4500);
  };

  // ── mutations ────────────────────────────────────────────────────

  const acknowledge = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await api.acknowledge();
      setCanUndo(true);
      flash(`Checkpoint moved. ${res.acknowledged} symbol${res.acknowledged === 1 ? '' : 's'} marked as seen.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not update your checkpoint');
    } finally {
      setBusy(false);
    }
  };

  const undo = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await api.undoAcknowledge();
      setCanUndo(false);
      flash(res.restored > 0 ? 'Previous checkpoint restored.' : 'Nothing to undo.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not undo');
    } finally {
      setBusy(false);
    }
  };

  const dismiss = async (signalIds: string[]): Promise<void> => {
    // Optimistic: mark read locally, then reconcile with the server.
    setDigest((prev) =>
      prev
        ? {
            ...prev,
            groups: prev.groups.map((g) => ({
              ...g,
              signals: g.signals.map((s) => (signalIds.includes(s.id) ? { ...s, isRead: true } : s)),
            })),
          }
        : prev,
    );
    try {
      await api.markRead(signalIds);
    } catch {
      // Roll back by reloading; a failed dismiss must not leave a lie on screen.
      await load();
    }
  };

  const withSymbolBusy = async (symbol: string, fn: () => Promise<void>): Promise<void> => {
    setBusySymbols((prev) => new Set(prev).add(symbol));
    try {
      await fn();
    } finally {
      setBusySymbols((prev) => {
        const next = new Set(prev);
        next.delete(symbol);
        return next;
      });
    }
  };

  /**
   * Run a watchlist mutation, handling the version conflict properly.
   *
   * On a 409 we reload and tell the user rather than retrying blind - a blind
   * retry would apply their change on top of someone else's without either of
   * them knowing, which is the exact failure the version column prevents.
   */
  const mutateList = async (fn: (version: number) => Promise<Watchlist>): Promise<void> => {
    if (!watchlist) return;
    try {
      const updated = await fn(watchlist.version);
      setWatchlist(updated);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const lists = await api.watchlists();
        setWatchlist(lists.watchlists[0] ?? null);
        await load();
        flash('That list changed somewhere else, so your view was refreshed. Try again.');
        return;
      }
      setError(err instanceof Error ? err.message : 'that change did not go through');
    }
  };

  const addSymbol = async (symbol: string): Promise<void> => {
    if (!watchlist) return;
    const res = await api.addSymbol(watchlist.id, symbol, watchlist.version);
    setWatchlist(res.watchlist);
    await load();
    flash(res.added ? `${symbol} added, with a year of history seeded.` : `${symbol} was already on the list.`);
  };

  const removeSymbol = (symbol: string): void =>
    void withSymbolBusy(symbol, () =>
      mutateList(async (version) => {
        const res = await api.removeSymbol(watchlist!.id, symbol, version);
        return res.watchlist;
      }),
    );

  const setPrefs = (
    symbol: string,
    patch: { pinned?: boolean; muted?: boolean; minSigma?: number | null },
  ): void =>
    void withSymbolBusy(symbol, () =>
      mutateList((version) => api.updateItem(watchlist!.id, symbol, patch, version)),
    );

  // ── derived ──────────────────────────────────────────────────────

  const unread = useMemo(
    () => digest?.groups.reduce((n, g) => n + g.signals.filter((s) => !s.isRead).length, 0) ?? 0,
    [digest],
  );

  const currentItem = useMemo(() => {
    if (view.name !== 'symbol') return null;
    return rows.find((r) => r.symbol === view.symbol)?.item ?? null;
  }, [view, rows]);

  // ── render ───────────────────────────────────────────────────────

  const handleSignedIn = (signedIn: User, isNew: boolean): void => {
    setUser(signedIn);
    setError(null);
    // Deliberately does not claim a checkpoint exists: a returning account that
    // has never pressed "Catch me up" has none, and saying otherwise
    // contradicts the briefing directly below it.
    flash(
      isNew
        ? `Welcome, ${signedIn.handle}. A starter watchlist is ready, with a year of history already seeded — so the numbers mean something from the first screen.`
        : `Welcome back, ${signedIn.handle}.`,
    );
    void loadForUser();
  };

  const signOut = (): void => {
    // Revoke server-side too, then clear locally regardless of the outcome.
    void api.signOut();
    setUser(null);
    setDigest(null);
    setRows([]);
    setWatchlist(null);
    setCanUndo(false);
    navigate({ name: 'briefing' });
  };

  if (booting) {
    return (
      <div className="app">
        <Header
          view={view}
          navigate={navigate}
          unread={0}
          meta={null}
          user={null}
          stream={streamStatus}
          notifications={{
            on: notifyOn,
            permission: notifyPerm,
            toggle: () => void toggleNotifications(),
          }}
          onSignOut={signOut}
        />
        <main className="shell" style={{ paddingTop: 60, display: 'flex', justifyContent: 'center' }}>
          <Spinner />
        </main>
      </div>
    );
  }

  // The auth gate. No token, no data - and no silently borrowed identity.
  if (!user) {
    return (
      <div className="app">
        <SignIn onSignedIn={handleSignedIn} />
      </div>
    );
  }

  return (
    <div className="app">
      <Header
        view={view}
        navigate={navigate}
        unread={unread}
        meta={meta}
        user={user}
        stream={streamStatus}
        notifications={{
          on: notifyOn,
          permission: notifyPerm,
          toggle: () => void toggleNotifications(),
        }}
        onSignOut={signOut}
      />

      <main className="shell">
        {error ? (
          <div style={{ paddingTop: 18 }}>
            <Banner tone="error">
              {error}
              <button className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={() => void load()}>
                Retry
              </button>
            </Banner>
          </div>
        ) : null}

        {notice ? (
          <div style={{ paddingTop: error ? 0 : 18 }}>
            <Banner tone="info">{notice}</Banner>
          </div>
        ) : null}

        {view.name === 'briefing' && digest ? (
          <Briefing
            digest={digest}
            busy={busy}
            canUndo={canUndo}
            onAcknowledge={() => void acknowledge()}
            onUndo={() => void undo()}
            onDismiss={(ids) => void dismiss(ids)}
            onOpenSymbol={(symbol) => navigate({ name: 'symbol', symbol })}
          />
        ) : null}

        {view.name === 'list' ? (
          <>
            <div className="section-head">
              <h2>{watchlist?.name ?? 'Watchlist'}</h2>
              <span style={{ fontSize: 12, color: 'var(--text-4)' }}>
                {rows.length} symbol{rows.length === 1 ? '' : 's'}
              </span>
              <div className="spacer" />
              <AddSymbol onAdd={addSymbol} disabled={!watchlist} />
            </div>

            <WatchTable
              rows={rows}
              busySymbols={busySymbols}
              onOpenSymbol={(symbol) => navigate({ name: 'symbol', symbol })}
              onTogglePin={(symbol, pinned) => setPrefs(symbol, { pinned })}
              onToggleMute={(symbol, muted) => setPrefs(symbol, { muted })}
              onRemove={removeSymbol}
            />

            <p className="footnote">
              Sorted by significance by default — the size of each move relative to that
              instrument&rsquo;s own volatility, not by percentage. Click any column heading to
              re-sort. Rows with too little history show{' '}
              <code>insufficient history</code> rather than an invented number.
            </p>
          </>
        ) : null}

        {view.name === 'symbol' ? (
          <SymbolDetail
            symbol={view.symbol}
            onBack={() => navigate({ name: 'list' })}
            onUpdatePrefs={setPrefs}
            muted={currentItem?.muted ?? false}
            minSigma={currentItem?.minSigma ?? null}
          />
        ) : null}

        {view.name === 'lab' ? <Lab onChanged={() => void load()} /> : null}

        {meta?.marketClock.simulated ? (
          <p className="footnote">
            <strong>Simulated market data.</strong> Prices come from a seeded factor model, not a
            live exchange — real tickers, invented numbers. One simulated session lasts{' '}
            <code>{Math.round(meta.marketClock.sessionMs / 1000)}s</code> of real time, and every
            volatility horizon is scaled by the same constant so the significance figures stay
            honest. Set <code>PROVIDERS=finnhub</code> with an API key to run against a live feed —
            nothing else changes.
          </p>
        ) : null}
      </main>
    </div>
  );
}

function Header({
  view,
  navigate,
  unread,
  meta,
  user,
  stream,
  notifications,
  onSignOut,
}: {
  view: View;
  navigate: (v: View) => void;
  unread: number;
  meta: Meta | null;
  user: User | null;
  stream: StreamStatus;
  notifications: {
    on: boolean;
    permission: NotifyPermission;
    toggle: () => void;
  };
  onSignOut: () => void;
}): React.JSX.Element {
  return (
    <header className="header">
      <div className="header-inner">
        <div className="brand">
          <span className="glyph">σ</span>
          <span>Sigma</span>
          <span className="tag">what actually changed</span>
        </div>

        <nav className="nav" aria-label="Main">
          <button
            aria-current={view.name === 'briefing'}
            onClick={() => navigate({ name: 'briefing' })}
          >
            Briefing
            {unread > 0 ? <span className="badge">{unread}</span> : null}
          </button>
          <button
            aria-current={view.name === 'list' || view.name === 'symbol'}
            onClick={() => navigate({ name: 'list' })}
          >
            Watchlist
          </button>
          {meta?.devTools ? (
            <button aria-current={view.name === 'lab'} onClick={() => navigate({ name: 'lab' })}>
              Lab
            </button>
          ) : null}
        </nav>

        {user ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <LiveDot status={stream} />
            <BellToggle on={notifications.on} permission={notifications.permission} onToggle={notifications.toggle} />
            <span
              className="num"
              style={{ fontSize: 12, color: 'var(--text-3)' }}
              title="Watchlists, checkpoints and thresholds all belong to this account"
            >
              {user.handle}
            </span>
            <button
              className="btn-ghost btn-sm"
              onClick={onSignOut}
              title="Sign out and switch account"
            >
              Sign out
            </button>
          </div>
        ) : null}
      </div>
    </header>
  );
}

/**
 * Whether the page is being pushed to, or is falling back to polling.
 *
 * Worth showing, and worth showing honestly. A user deciding whether to act on
 * a number is entitled to know if the screen is live or refreshing every two
 * minutes - and if the stream is down, saying so is much better than a page
 * that looks live and is not. Deliberately tiny: it is reassurance, not news.
 */
function LiveDot({ status }: { status: StreamStatus }): React.JSX.Element {
  const label =
    status === 'live'
      ? 'Live · updates are pushed as they happen'
      : status === 'connecting'
        ? 'Connecting to the live feed…'
        : 'Live feed unavailable · falling back to polling every 8s';

  return (
    <span className={`live-dot is-${status}`} title={label} aria-label={label} role="status">
      <i aria-hidden="true" />
      <span className="live-dot-text">{status === 'live' ? 'Live' : status === 'connecting' ? '…' : 'Polling'}</span>
    </span>
  );
}

/**
 * The notification switch.
 *
 * A single icon button rather than a settings page, because there is exactly
 * one decision to make. The title carries the honest description of what it
 * does - a severity floor, silent while the tab is open - so nobody has to
 * turn it on to find out whether it will be annoying.
 */
function BellToggle({
  on,
  permission,
  onToggle,
}: {
  on: boolean;
  permission: NotifyPermission;
  onToggle: () => void;
}): React.JSX.Element | null {
  // Nothing to offer, so offer nothing. A dead control is worse than none.
  if (permission === 'unsupported') return null;

  const blocked = permission === 'denied';
  const label = blocked
    ? 'Your browser is blocking notifications for this site'
    : on
      ? 'Notifications on · only significant changes, and never while this tab is open'
      : 'Notify me when something significant changes';

  return (
    <button
      type="button"
      className={`bell${on ? ' is-on' : ''}${blocked ? ' is-blocked' : ''}`}
      onClick={onToggle}
      title={label}
      aria-label={label}
      aria-pressed={on}
    >
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
        <path
          d="M8 1.6a3.6 3.6 0 0 0-3.6 3.6v2.3L3.2 10.2h9.6l-1.2-2.7V5.2A3.6 3.6 0 0 0 8 1.6Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
        <path d="M6.4 12a1.6 1.6 0 0 0 3.2 0" fill="none" stroke="currentColor" strokeWidth="1.3" />
        {blocked ? <path d="M2 14 14 2" stroke="currentColor" strokeWidth="1.3" /> : null}
      </svg>
    </button>
  );
}
