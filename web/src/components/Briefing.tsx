/**
 * The briefing: the answer to "what changed since I last looked?".
 *
 * The screen is built around three claims it has to make credibly:
 *
 *  1. **Here is what matters, ranked.** Not a feed - a short, ordered list
 *     with the reasoning visible, so the ordering can be trusted.
 *  2. **Here is what I looked at and decided did not matter.** Stating the
 *     quiet symbols explicitly is what makes the list feel complete rather
 *     than lossy; without it the user re-scans the whole watchlist anyway.
 *  3. **Here is how much to trust any of this.** Data health sits on the same
 *     screen as the prices, not behind a debug page.
 *
 * The watermark only advances when the user presses the button. Reading is
 * free; acknowledging is a decision, and a reversible one.
 */

import { useState } from 'react';
import type { Digest, ScoredSignal, SignalKind } from '../lib/types.js';
import { ago, kindLabel, kindWhy, signedPct, sigma } from '../lib/format.js';
import { Banner, Chip, SigmaChip, isIntegrityKind } from './primitives.js';
import { HealthStrip } from './HealthStrip.js';
import { sigmaBand } from '../lib/format.js';

interface Props {
  digest: Digest;
  busy: boolean;
  onAcknowledge: () => void;
  onUndo: () => void;
  onDismiss: (signalIds: string[]) => void;
  onOpenSymbol: (symbol: string) => void;
  canUndo: boolean;
}

export function Briefing({
  digest,
  busy,
  onAcknowledge,
  onUndo,
  onDismiss,
  onOpenSymbol,
  canUndo,
}: Props): React.JSX.Element {
  const total = digest.groups.reduce((sum, g) => sum + g.signals.length, 0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (id: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const windowLabel = digest.window.isFirstVisit
    ? 'your first visit'
    : ago(digest.window.from, digest.generatedAt);

  return (
    <>
      <header className="brief-head">
        <div className="brief-eyebrow">
          {digest.window.isFirstVisit ? 'Getting started' : `Since you last checked · ${windowLabel}`}
        </div>

        <h1 className="brief-title">
          {total === 0
            ? 'Nothing meaningful has moved.'
            : total === 1
              ? 'One thing is worth your attention.'
              : `${total} things are worth your attention.`}
        </h1>

        <p className="brief-sub">
          {total === 0
            ? `We checked every symbol on your list and found nothing outside its normal range. That is a finding, not an absence of one.`
            : `Ranked by how unusual each move is for that particular instrument — not by percentage. ${
                digest.suppressedCount > 0
                  ? `${digest.suppressedCount} lower-ranked item${digest.suppressedCount === 1 ? '' : 's'} held back to keep this readable.`
                  : ''
              }`}
        </p>

        <div className="brief-actions">
          <button
            className="btn btn-primary"
            onClick={onAcknowledge}
            disabled={busy}
            title="Move your checkpoint to now. Everything above is marked as read."
          >
            {busy ? 'Working…' : total === 0 ? 'Reset checkpoint to now' : 'Catch me up'}
          </button>

          {canUndo ? (
            <button className="btn" onClick={onUndo} disabled={busy} title="Restore the previous checkpoint">
              Undo
            </button>
          ) : null}

          <span style={{ fontSize: 12, color: 'var(--text-4)', marginLeft: 4 }}>
            Reading this page does not move your checkpoint.
          </span>
        </div>
      </header>

      {digest.window.clamped ? (
        <Banner tone="info">
          You have been away a while. This briefing covers the most recent two weeks rather than
          everything since your last visit.
        </Banner>
      ) : null}

      {total === 0 ? (
        <div className="empty">
          <div className="mark">✓</div>
          <h2>All quiet</h2>
          <p>
            {digest.quiet.length} symbol{digest.quiet.length === 1 ? '' : 's'} checked. Nothing moved
            more than would be expected given each one&rsquo;s own volatility.
          </p>
        </div>
      ) : (
        <div className="groups">
          {digest.groups.map((group) => (
            <article className="group" key={group.symbol}>
              <div className="group-head">
                <button className="ticker-btn" onClick={() => onOpenSymbol(group.symbol)}>
                  {group.symbol}
                </button>
                <span className="group-name">{group.name}</span>
              </div>

              {group.signals.map((s) => (
                <SignalRow
                  key={s.id}
                  signal={s}
                  expanded={expanded.has(s.id)}
                  onToggle={() => toggle(s.id)}
                  onDismiss={() => onDismiss([s.id])}
                />
              ))}
            </article>
          ))}
        </div>
      )}

      {digest.quiet.length > 0 && total > 0 ? (
        <section className="quiet">
          <h3>Everything else</h3>
          <p>
            Checked and found unremarkable — each within its normal range for the period.
          </p>
          <div className="quiet-list">
            {digest.quiet.map((q) => (
              <button
                key={q.symbol}
                className="quiet-item"
                onClick={() => onOpenSymbol(q.symbol)}
                style={{ cursor: 'pointer' }}
              >
                <span className="sym">{q.symbol}</span>
                <span className="num" style={{ color: 'var(--text-3)' }}>
                  {signedPct(q.changePct)}
                </span>
                {q.sigma !== null ? (
                  <span className="num" style={{ color: 'var(--text-4)', fontSize: 11 }}>
                    {sigma(q.sigma)}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <HealthStrip health={digest.health} />
    </>
  );
}

function SignalRow({
  signal,
  expanded,
  onToggle,
  onDismiss,
}: {
  signal: ScoredSignal;
  expanded: boolean;
  onToggle: () => void;
  onDismiss: () => void;
}): React.JSX.Element {
  const integrity = isIntegrityKind(signal.kind);
  const sig = typeof signal.evidence.sigma === 'number' ? signal.evidence.sigma : null;
  const band = integrity ? 'integrity' : sigmaBand(sig ?? signal.severity * 4);

  return (
    <div className={`signal${signal.isRead ? ' is-read' : ''}`}>
      <div className="signal-spine" data-band={band} />

      <div className="signal-body">
        <div className="signal-head">
          <span className="signal-headline">{signal.headline}</span>
          {sig !== null ? <SigmaChip value={sig} /> : null}
          <Chip tone={integrity ? 'info' : 'muted'}>{kindLabel(signal.kind)}</Chip>
          {signal.isRead ? <Chip tone="muted">read</Chip> : null}
        </div>

        <p className="signal-why">{kindWhy(signal.kind)}</p>

        <div className="signal-meta">
          <span>{ago(signal.detectedAt)}</span>
          <span className="k">rank: {signal.rationale}</span>
          <button
            className="btn-ghost btn-sm"
            onClick={onToggle}
            style={{ border: 0, padding: 0, background: 'none', color: 'var(--info)' }}
            aria-expanded={expanded}
          >
            {expanded ? 'hide the numbers' : 'show the numbers'}
          </button>
        </div>

        {expanded ? <Evidence kind={signal.kind} evidence={signal.evidence} /> : null}
      </div>

      <div className="signal-actions">
        {!signal.isRead ? (
          <button className="btn-ghost btn-sm" onClick={onDismiss} title="Dismiss just this item">
            ×
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The evidence table.
 *
 * Every claim the product makes is backed by numbers the user can inspect.
 * A ranking nobody can audit is a ranking nobody should believe, and this is
 * the cheapest possible way to make it auditable.
 */
function Evidence({
  kind,
  evidence,
}: {
  kind: SignalKind;
  evidence: Record<string, number | string | boolean>;
}): React.JSX.Element {
  const rows = Object.entries(evidence).filter(([, v]) => v !== null && v !== undefined);

  return (
    <dl className="kv" style={{ marginTop: 11, fontSize: 12 }}>
      {rows.map(([key, value]) => (
        <div key={key} style={{ display: 'contents' }}>
          <dt>{humanKey(key)}</dt>
          <dd>{formatEvidence(key, value)}</dd>
        </div>
      ))}
      <div style={{ display: 'contents' }}>
        <dt>detector</dt>
        <dd style={{ fontFamily: 'var(--mono)', color: 'var(--text-4)' }}>{kind}</dd>
      </div>
    </dl>
  );
}

function humanKey(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/Pct$/i, ' %')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

function formatEvidence(key: string, value: number | string | boolean): string {
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'string') return value;
  if (!Number.isFinite(value)) return '—';

  // Percent-ish fields are stored as fractions; render them as percentages.
  if (/pct$|Pct$|spread|drawdown/i.test(key)) return `${(value * 100).toFixed(2)}%`;
  if (/sigma/i.test(key)) return value.toFixed(2);
  if (/volume/i.test(key)) return new Intl.NumberFormat('en-US', { notation: 'compact' }).format(value);
  if (/^(asOf|from|detectedAt)$/i.test(key)) return new Date(value).toLocaleString();
  if (/ms$/i.test(key)) return `${Math.round(value / 1000)}s`;
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(Math.abs(value) < 1 ? 4 : 2);
}
