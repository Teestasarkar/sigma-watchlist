/** Small presentational pieces shared across the views. */

import type { ReactNode } from 'react';
import type { Freshness, SignalKind } from '../lib/types.js';
import { freshnessLabel, sigma as fmtSigma, sigmaBand } from '../lib/format.js';

export function Chip({
  children,
  tone,
  band,
  title,
}: {
  children: ReactNode;
  tone?: 'up' | 'down' | 'warn' | 'info' | 'muted';
  band?: 'none' | 'low' | 'mid' | 'high';
  title?: string;
}): React.JSX.Element {
  return (
    <span className="chip" data-tone={tone} data-band={band} title={title}>
      {children}
    </span>
  );
}

/**
 * The sigma badge.
 *
 * The most important number on screen, so it gets its own component and its
 * own colour ramp - independent of up/down, because a 4-sigma fall and a
 * 4-sigma rise are equally worth reading.
 */
export function SigmaChip({ value }: { value: number | null }): React.JSX.Element | null {
  if (value === null || !Number.isFinite(value)) return null;
  const band = sigmaBand(value);
  return (
    <Chip
      band={band}
      title={`${Math.abs(value).toFixed(2)} standard deviations, measured against this instrument's own volatility over the elapsed period`}
    >
      {fmtSigma(value)}
    </Chip>
  );
}

/**
 * Freshness indicator.
 *
 * Always rendered, never hidden when healthy. A status light that only appears
 * when something is wrong teaches people not to look for it.
 */
export function FreshnessDot({
  state,
  label = false,
  asOf,
}: {
  state: Freshness;
  label?: boolean;
  asOf?: number | null;
}): React.JSX.Element {
  const title =
    state === 'fresh'
      ? 'Priced within the last few seconds'
      : state === 'delayed'
        ? 'Last update is a few minutes old'
        : state === 'stale'
          ? 'We have not been able to price this recently'
          : 'No usable price for this instrument';
  return (
    <span
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
      title={asOf ? `${title} (as of ${new Date(asOf).toLocaleTimeString()})` : title}
    >
      <span className="dot" data-state={state} />
      {label ? <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{freshnessLabel(state)}</span> : null}
      <span className="sr-only">{freshnessLabel(state)}</span>
    </span>
  );
}

const INTEGRITY: ReadonlySet<SignalKind> = new Set<SignalKind>(['stale_data', 'data_conflict']);

export const isIntegrityKind = (kind: SignalKind): boolean => INTEGRITY.has(kind);

export function Spinner(): React.JSX.Element {
  return <span className="spinner" role="status" aria-label="Loading" />;
}

export function Banner({
  tone,
  children,
}: {
  tone: 'warn' | 'error' | 'info';
  children: ReactNode;
}): React.JSX.Element {
  return (
    <div className="banner" data-tone={tone} role={tone === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}
