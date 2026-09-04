/**
 * The watchlist table.
 *
 * The column order is the argument. "Since you looked" comes before "Today",
 * and the sigma sits next to it in a colour ramp, because the product's claim
 * is that *your* reference point and *this instrument's* normal range are what
 * make a number meaningful. A conventional table leads with today's percentage
 * and buries everything else; this one inverts that, and keeps today's change
 * only because people expect to see it.
 */

import { useMemo, useState } from 'react';
import type { WatchRow } from '../lib/types.js';
import { ago, directionClass, money, signedPct } from '../lib/format.js';
import { FreshnessDot, SigmaChip } from './primitives.js';

type SortKey = 'significance' | 'symbol' | 'sinceSeen' | 'today';

interface Props {
  rows: WatchRow[];
  onOpenSymbol: (symbol: string) => void;
  onTogglePin: (symbol: string, pinned: boolean) => void;
  onToggleMute: (symbol: string, muted: boolean) => void;
  onRemove: (symbol: string) => void;
  busySymbols: ReadonlySet<string>;
}

export function WatchTable({
  rows,
  onOpenSymbol,
  onTogglePin,
  onToggleMute,
  onRemove,
  busySymbols,
}: Props): React.JSX.Element {
  const [sort, setSort] = useState<SortKey>('significance');

  const sorted = useMemo(() => {
    const copy = [...rows];
    const abs = (v: number | null): number => (v === null || !Number.isFinite(v) ? -1 : Math.abs(v));

    copy.sort((a, b) => {
      // Pinned always float, whatever the sort. That is what pinning means.
      if (a.item.pinned !== b.item.pinned) return a.item.pinned ? -1 : 1;

      switch (sort) {
        case 'symbol':
          return a.symbol.localeCompare(b.symbol);
        case 'sinceSeen':
          return abs(b.sinceSeen.changePct) - abs(a.sinceSeen.changePct);
        case 'today':
          return abs(b.today.changePct) - abs(a.today.changePct);
        case 'significance':
        default: {
          // Rank by |sigma|. Rows with no sigma (thin history) sort last
          // rather than being treated as zero - "unknown" is not "calm".
          const d = abs(b.sinceSeen.sigma) - abs(a.sinceSeen.sigma);
          return d !== 0 ? d : a.symbol.localeCompare(b.symbol);
        }
      }
    });
    return copy;
  }, [rows, sort]);

  if (rows.length === 0) {
    return (
      <div className="empty">
        <h2>Nothing on this list yet</h2>
        <p>Add a symbol above. History and statistics are seeded immediately, so the first signal is trustworthy.</p>
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table className="rows">
        <thead>
          <tr>
            <Th onClick={() => setSort('symbol')} active={sort === 'symbol'} align="left">
              Symbol
            </Th>
            <th>Price</th>
            <Th onClick={() => setSort('sinceSeen')} active={sort === 'sinceSeen'} primary>
              Since you looked
            </Th>
            <Th onClick={() => setSort('significance')} active={sort === 'significance'} primary>
              Significance
            </Th>
            <Th onClick={() => setSort('today')} active={sort === 'today'}>
              Today
            </Th>
            <th>Rel. volume</th>
            <th>Data</th>
            <th />
          </tr>
        </thead>

        <tbody>
          {sorted.map((row) => (
            <Row
              key={row.symbol}
              row={row}
              busy={busySymbols.has(row.symbol)}
              onOpenSymbol={onOpenSymbol}
              onTogglePin={onTogglePin}
              onToggleMute={onToggleMute}
              onRemove={onRemove}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({
  children,
  onClick,
  active,
  primary,
  align,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  active?: boolean;
  primary?: boolean;
  align?: 'left';
}): React.JSX.Element {
  return (
    <th
      className={primary ? 'primary' : undefined}
      style={{ textAlign: align, cursor: onClick ? 'pointer' : undefined }}
      onClick={onClick}
      aria-sort={active ? 'descending' : undefined}
    >
      {children}
      {active ? <span aria-hidden="true"> ↓</span> : null}
    </th>
  );
}

function Row({
  row,
  busy,
  onOpenSymbol,
  onTogglePin,
  onToggleMute,
  onRemove,
}: {
  row: WatchRow;
  busy: boolean;
  onOpenSymbol: (symbol: string) => void;
  onTogglePin: (symbol: string, pinned: boolean) => void;
  onToggleMute: (symbol: string, muted: boolean) => void;
  onRemove: (symbol: string) => void;
}): React.JSX.Element {
  const since = row.sinceSeen;

  return (
    <tr data-muted={row.item.muted}>
      <td>
        <div className="cell-sym">
          {row.item.pinned ? <span className="pin" title="Pinned">★</span> : null}
          <div className="meta">
            <button className="ticker-btn" onClick={() => onOpenSymbol(row.symbol)}>
              {row.symbol}
            </button>
            <span className="name">{row.name}</span>
          </div>
        </div>
      </td>

      <td className="num">{money(row.quote?.price ?? null)}</td>

      {/* The primary column: the delta against the user's own checkpoint. */}
      <td>
        <div className={`num val val-strong ${directionClass(since.changePct)}`}>
          {signedPct(since.changePct)}
        </div>
        {since.fromAt ? (
          <div className="val-weak" style={{ fontSize: 11 }}>
            from {money(since.from)} · {ago(since.fromAt)}
          </div>
        ) : (
          <div className="val-weak" style={{ fontSize: 11 }}>
            vs previous close
          </div>
        )}
      </td>

      <td>
        {since.sigma === null ? (
          <span
            className="val-weak"
            title="Not enough price history yet to say whether this is unusual"
          >
            insufficient history
          </span>
        ) : (
          <SigmaChip value={since.sigma} />
        )}
      </td>

      <td className={`num val ${directionClass(row.today.changePct)}`}>
        {signedPct(row.today.changePct)}
      </td>

      <td className="num val-weak" title="Volume so far, against the median for this point in the session">
        {row.rvol === null ? '—' : `${row.rvol.toFixed(1)}×`}
      </td>

      <td>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, justifyContent: 'flex-end' }}>
          <FreshnessDot state={row.freshness} asOf={row.quote?.asOf ?? null} />
          {row.quote?.conflict ? (
            <span title={`Sources differ by ${(row.quote.conflict.spread * 100).toFixed(2)}%`}>
              ⚠
            </span>
          ) : null}
          {row.openSignals > 0 ? (
            <span
              className="num"
              style={{ fontSize: 11, color: 'var(--text-4)' }}
              title={`${row.openSignals} open signal${row.openSignals === 1 ? '' : 's'}`}
            >
              {row.openSignals}
            </span>
          ) : null}
        </div>
      </td>

      <td>
        <div style={{ display: 'flex', gap: 2, justifyContent: 'flex-end' }}>
          <button
            className="btn-ghost btn-sm"
            disabled={busy}
            onClick={() => onTogglePin(row.symbol, !row.item.pinned)}
            title={row.item.pinned ? 'Unpin' : 'Pin to the top'}
          >
            {row.item.pinned ? '★' : '☆'}
          </button>
          <button
            className="btn-ghost btn-sm"
            disabled={busy}
            onClick={() => onToggleMute(row.symbol, !row.item.muted)}
            title={row.item.muted ? 'Unmute' : 'Mute: keep it listed, stop it reaching the briefing'}
          >
            {row.item.muted ? '🔇' : '🔔'}
          </button>
          <button
            className="btn-ghost btn-sm"
            disabled={busy}
            onClick={() => onRemove(row.symbol)}
            title="Remove from this list"
          >
            ×
          </button>
        </div>
      </td>
    </tr>
  );
}
