/**
 * Desktop notifications.
 *
 * The engine already decides what is worth interrupting someone for, and the
 * episode machine already guarantees it fires once per episode rather than
 * once per poll. Both of those are the hard part; this is the surface.
 *
 * The whole risk here is being annoying. A watchlist that pushes a desktop
 * notification for every price wobble gets its permission revoked within a
 * day, and then cannot tell the user the one thing that mattered. So the
 * defaults are deliberately conservative and every rule below is a rule about
 * *not* notifying.
 *
 *  - **Only real news.** A severity floor, and integrity warnings ("we cannot
 *    price this") always pass because being unable to trust a number is worth
 *    an interruption.
 *  - **Never while they are looking.** If the tab is visible the briefing is
 *    already updating in front of them; a notification would be telling
 *    someone something they can see.
 *  - **Once per episode, ever.** Ids seen are remembered across reloads, so a
 *    refresh cannot re-announce this morning's news.
 *  - **A hard ceiling per hour.** Even correct notifications are bad in a
 *    volume, and a market-wide event would otherwise produce a dozen at once.
 *    Past the cap they collapse into one summary.
 *  - **Off until asked for.** The browser prompt only appears on a click, so
 *    nobody is ambushed by a permission dialog on first load.
 */

import type { Digest, ScoredSignal } from './types.js';

/** One candidate: a signal plus the display name of the symbol it belongs to. */
interface Candidate {
  signal: ScoredSignal;
  name: string;
}

/**
 * Flatten the briefing into candidates, best first.
 *
 * The digest is grouped by symbol so the UI can render it that way; for
 * notifications the grouping is noise. Already-read signals are dropped here
 * rather than filtered later - a signal dismissed on another device is not
 * news on this one.
 */
function candidates(digest: Digest): Candidate[] {
  const out: Candidate[] = [];
  for (const group of digest.groups) {
    for (const signal of group.signals) {
      if (signal.isRead) continue;
      out.push({ signal, name: group.name });
    }
  }
  return out.sort((a, b) => b.signal.score - a.signal.score);
}

const ENABLED_KEY = 'sigma.notify.enabled';
const SEEN_KEY = 'sigma.notify.seen';

/** Below this, it goes in the briefing but does not interrupt anyone. */
const SEVERITY_FLOOR = 0.55;

/** Notifications per rolling hour before they collapse into one summary. */
const MAX_PER_HOUR = 6;

const HOUR_MS = 3_600_000;

/**
 * Kinds that interrupt regardless of severity.
 *
 * "This price cannot be trusted" is not a market opinion, it is a warning that
 * the screen is lying, and someone about to act on a number needs it.
 */
const ALWAYS: ReadonlySet<string> = new Set(['stale_data', 'data_conflict', 'corporate_action']);

/** How many ids to remember. Bounded so localStorage cannot grow forever. */
const SEEN_LIMIT = 400;

export type NotifyPermission = 'unsupported' | 'default' | 'granted' | 'denied';

export function notifyPermission(): NotifyPermission {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission as NotifyPermission;
}

/** localStorage throws in some private modes; never let that be fatal. */
function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // In-memory for this session. Degraded, not broken - the worst case is a
    // repeated notification after a reload.
  }
}

export function notificationsEnabled(): boolean {
  return read<boolean>(ENABLED_KEY, false) && notifyPermission() === 'granted';
}

export function setNotificationsEnabled(on: boolean): void {
  write(ENABLED_KEY, on);
}

/**
 * Ask the browser, but only from a user gesture.
 *
 * Chrome and Firefox both ignore (and Safari rejects) a permission request
 * that is not tied to a click, so this must be called from an event handler.
 */
export async function requestNotificationPermission(): Promise<NotifyPermission> {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission as NotifyPermission;

  try {
    return (await Notification.requestPermission()) as NotifyPermission;
  } catch {
    return 'denied';
  }
}

interface Seen {
  ids: string[];
  /** Timestamps of recent notifications, for the rolling hourly cap. */
  fired: number[];
}

function loadSeen(): Seen {
  const s = read<Partial<Seen>>(SEEN_KEY, {});
  return { ids: Array.isArray(s.ids) ? s.ids : [], fired: Array.isArray(s.fired) ? s.fired : [] };
}

/**
 * Mark the current briefing as seen without notifying about it.
 *
 * Called on first load, and it is the difference between a useful feature and
 * an unusable one. Without it, opening the app after a weekend fires a
 * notification for everything that happened while it was closed - which is
 * both a storm and pointless, because the user is already looking at the list.
 */
export function primeSeen(digest: Digest): void {
  const seen = loadSeen();
  const ids = new Set(seen.ids);
  for (const group of digest.groups) for (const sig of group.signals) ids.add(sig.id);
  write(SEEN_KEY, { ids: [...ids].slice(-SEEN_LIMIT), fired: seen.fired });
}

export function clearSeen(): void {
  write(SEEN_KEY, { ids: [], fired: [] });
}

function worthInterrupting(c: Candidate): boolean {
  if (ALWAYS.has(c.signal.kind)) return true;
  return c.signal.severity >= SEVERITY_FLOOR;
}

export interface NotifyResult {
  shown: number;
  suppressed: number;
  reason: 'disabled' | 'tab-visible' | 'nothing-new' | 'shown' | null;
}

/**
 * Notify about anything new in this briefing that deserves it.
 *
 * Returns what it did, so the caller can show it in the settings panel rather
 * than leaving the user to guess whether the feature works.
 */
export function notifyFromDigest(
  digest: Digest,
  opts: { onClick?: (symbol: string) => void } = {},
): NotifyResult {
  if (!notificationsEnabled()) return { shown: 0, suppressed: 0, reason: 'disabled' };

  const items = candidates(digest);
  const seen = loadSeen();
  const seenIds = new Set(seen.ids);

  const fresh = items.filter((i) => !seenIds.has(i.signal.id) && worthInterrupting(i));

  // Record everything as seen even when we do not notify, so turning the tab
  // away and back does not release a backlog.
  const markAll = (): void => {
    for (const group of digest.groups) for (const sig of group.signals) seenIds.add(sig.id);
  };

  if (fresh.length === 0) {
    markAll();
    write(SEEN_KEY, { ids: [...seenIds].slice(-SEEN_LIMIT), fired: seen.fired });
    return { shown: 0, suppressed: 0, reason: 'nothing-new' };
  }

  /*
   * Not while they are watching.
   *
   * The briefing in front of them has already updated. Interrupting someone to
   * tell them something they can see is the fastest way to have notifications
   * switched off - so these are marked seen and silently skipped.
   */
  if (document.visibilityState === 'visible') {
    markAll();
    write(SEEN_KEY, { ids: [...seenIds].slice(-SEEN_LIMIT), fired: seen.fired });
    return { shown: 0, suppressed: fresh.length, reason: 'tab-visible' };
  }

  const now = Date.now();
  const recent = seen.fired.filter((t) => now - t < HOUR_MS);
  const budget = Math.max(0, MAX_PER_HOUR - recent.length);

  let shown = 0;

  if (budget === 0) {
    // Over the cap. Say nothing rather than adding to a pile the user is
    // already ignoring; the briefing badge still carries the count.
  } else if (fresh.length > budget) {
    /*
     * A market-wide event: many symbols at once.
     *
     * One summary is strictly better than six notifications the user has to
     * dismiss individually, and it is also more accurate - "seven things
     * changed" is the actual news, not any one of them.
     */
    const top = fresh[0] as Candidate;
    const rest = fresh.length - 1;
    show(
      `${fresh.length} things changed`,
      `${top.signal.headline}\nand ${rest} other${rest === 1 ? '' : 's'}.`,
      'sigma-summary',
      () => opts.onClick?.(top.signal.symbol),
    );
    shown = 1;
    recent.push(now);
  } else {
    for (const item of fresh.slice(0, budget)) {
      show(
        `${item.signal.symbol} · ${item.name}`,
        item.signal.headline,
        // Tagged per symbol so a second notification for the same instrument
        // replaces the first rather than stacking.
        `sigma-${item.signal.symbol}`,
        () => opts.onClick?.(item.signal.symbol),
      );
      shown++;
      recent.push(now);
    }
  }

  markAll();
  write(SEEN_KEY, { ids: [...seenIds].slice(-SEEN_LIMIT), fired: recent.slice(-32) });

  return { shown, suppressed: fresh.length - shown, reason: 'shown' };
}

function show(title: string, body: string, tag: string, onClick: () => void): void {
  try {
    const n = new Notification(title, {
      body,
      tag,
      // Never make a sound or steal focus. This is a watchlist, not an alarm.
      silent: true,
      requireInteraction: false,
    });
    n.onclick = () => {
      window.focus();
      onClick();
      n.close();
    };
  } catch {
    // Some browsers throw when constructing a Notification outside a service
    // worker (notably mobile Chrome). Nothing to do; the briefing still shows
    // it, which is the fallback the whole feature degrades to.
  }
}
