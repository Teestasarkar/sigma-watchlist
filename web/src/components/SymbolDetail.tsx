/**
 * One symbol, in full.
 *
 * This is where the product shows its work. The chart shades the period since
 * the user's checkpoint, the statistics panel exposes the exact numbers the
 * detectors used, and the timeline shows every episode - including the ones
 * that have since resolved, greyed out. If a user ever wonders "why did it
 * tell me that?", the answer is on this page.
 */

import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import type { SymbolDetail as Detail } from '../lib/types.js';
import {
  ago,
  compactNumber,
  directionClass,
  duration,
  kindLabel,
  money,
  pct,
  signedPct,
  sigma as fmtSigma,
} from '../lib/format.js';
import { Banner, Chip, FreshnessDot, SigmaChip, Spinner, isIntegrityKind } from './primitives.js';
import { Sparkline } from './Sparkline.js';

interface Props {
  symbol: string;
  onBack: () => void;
  /** Set a per-symbol significance floor, or mute it entirely. */
  onUpdatePrefs: (symbol: string, patch: { muted?: boolean; minSigma?: number | null }) => void;
  muted: boolean;
  minSigma: number | null;
}

export function SymbolDetail({
  symbol,
  onBack,
  onUpdatePrefs,
  muted,
  minSigma,
}: Props): React.JSX.Element {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setDetail(null);
    setError(null);

    void api
      .symbol(symbol, controller.signal)
      .then(setDetail)
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'could not load this symbol');
      });

    // Poll while the page is open. The server promotes viewed symbols to the
    // hot tier, so this is the one place where a few seconds of latency
    // actually matters to the user.
    const timer = setInterval(() => {
      void api.symbol(symbol).then(setDetail).catch(() => undefined);
    }, 6000);

    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [symbol]);

  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    try {
      await api.refreshSymbol(symbol);
      setDetail(await api.symbol(symbol));
    } catch {
      // The polling loop will recover; a failed manual refresh is not worth
      // an error state that the user then has to dismiss.
    } finally {
      setRefreshing(false);
    }
  };

  if (error) {
    return (
      <>
        <div className="section-head">
          <button className="btn btn-sm" onClick={onBack}>
            ← Back
          </button>
        </div>
        <Banner tone="error">{error}</Banner>
      </>
    );
  }

  if (!detail) {
    return (
      <div className="section-head">
        <button className="btn btn-sm" onClick={onBack}>
          ← Back
        </button>
        <Spinner />
      </div>
    );
  }

  const { instrument, quote, stats, bars, signals, mark, job } = detail;
  const todayPct = quote && quote.prevClose > 0 ? quote.price / quote.prevClose - 1 : null;
  const sincePct =
    quote && mark?.seenPrice && mark.seenPrice > 0 ? quote.price / mark.seenPrice - 1 : null;

  return (
    <>
      <div className="section-head">
        <button className="btn btn-sm" onClick={onBack}>
          ← Back
        </button>
        <h2 style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <span className="ticker" style={{ fontSize: 22 }}>
            {instrument.symbol}
          </span>
          <span style={{ fontSize: 14, fontWeight: 400, color: 'var(--text-3)' }}>
            {instrument.name}
          </span>
        </h2>

        <div className="spacer" />

        {instrument.status === 'delisted' ? <Chip tone="down">no longer quoted</Chip> : null}
        {quote?.halted ? <Chip tone="down">halted</Chip> : null}
        <FreshnessDot state={detail.freshness} label asOf={quote?.asOf ?? null} />
        <button className="btn btn-sm" onClick={() => void refresh()} disabled={refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh now'}
        </button>
      </div>

      {instrument.status === 'delisted' ? (
        <Banner tone="warn">
          No provider recognises this symbol any more. It has been kept on your list rather than
          removed silently — its disappearance is itself worth knowing about.
        </Banner>
      ) : null}

      {quote?.conflict ? (
        <Banner tone="warn">
          Sources disagree on this price by {pct(quote.conflict.spread)} —{' '}
          {quote.conflict.quotes.map((q) => `${q.source} at ${money(q.price)}`).join(', ')}. We are
          showing the {quote.conflict.resolution === 'median' ? 'median' : 'preferred source’s'}{' '}
          value and have lowered our confidence to {pct(quote.confidence, 0)}.
        </Banner>
      ) : null}

      <div className="detail-grid">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* ── price + chart ─────────────────────────────────────── */}
          <div className="panel">
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 22, flexWrap: 'wrap' }}>
              <div>
                <div className="num" style={{ fontSize: 30, fontWeight: 620, letterSpacing: '-0.02em' }}>
                  {money(quote?.price ?? null, instrument.currency)}
                </div>
                <div style={{ display: 'flex', gap: 10, marginTop: 4, alignItems: 'center' }}>
                  <span className={`num val ${directionClass(todayPct)}`}>{signedPct(todayPct)}</span>
                  <span style={{ fontSize: 12, color: 'var(--text-4)' }}>today</span>
                </div>
              </div>

              {mark ? (
                <div>
                  <div className={`num val val-strong ${directionClass(sincePct)}`} style={{ fontSize: 20 }}>
                    {signedPct(sincePct)}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-4)', marginTop: 4 }}>
                    since you looked · {ago(mark.seenAt)}
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: 12, color: 'var(--text-4)' }}>
                  No checkpoint yet — showing change from the previous close.
                </div>
              )}

              <div style={{ marginLeft: 'auto' }}>
                <Sparkline
                  bars={bars}
                  livePrice={quote?.price ?? null}
                  sinceTs={mark?.seenAt ?? null}
                  width={320}
                  height={76}
                />
                <div style={{ fontSize: 11, color: 'var(--text-4)', textAlign: 'right', marginTop: 3 }}>
                  {bars.length} sessions
                  {mark ? ' · shaded from your last checkpoint' : ''}
                </div>
              </div>
            </div>
          </div>

          {/* ── timeline ──────────────────────────────────────────── */}
          <div className="panel">
            <h3>Signal history</h3>
            {signals.length === 0 ? (
              <p style={{ margin: 0, color: 'var(--text-3)', fontSize: 13 }}>
                Nothing has crossed a threshold for this symbol yet.
              </p>
            ) : (
              <div className="timeline">
                {signals.map((s) => {
                  const sig = typeof s.evidence.sigma === 'number' ? s.evidence.sigma : null;
                  return (
                    <div className="tl-item" key={s.id} data-superseded={s.supersededAt !== null}>
                      <div className="tl-when">{ago(s.detectedAt)}</div>
                      <div className="tl-body">
                        <div className="tl-head">{s.headline}</div>
                        <div className="signal-meta" style={{ marginTop: 5 }}>
                          <Chip tone={isIntegrityKind(s.kind) ? 'info' : 'muted'}>
                            {kindLabel(s.kind)}
                          </Chip>
                          {sig !== null ? <SigmaChip value={sig} /> : null}
                          {s.supersededAt !== null ? (
                            <span>resolved {ago(s.supersededAt)}</span>
                          ) : (
                            <span style={{ color: 'var(--text-3)' }}>still active</span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* ── side: statistics, preferences, plumbing ───────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="panel">
            <h3>What we know about it</h3>
            {stats ? (
              <dl className="kv">
                <dt>Sessions of history</dt>
                <dd>{stats.bars}</dd>

                <dt title="Standard deviation of daily returns over the last 90 sessions">
                  Daily volatility
                </dt>
                <dd>{pct(stats.sigmaDaily)}</dd>

                <dt title="Annualised, for comparison with quoted vol">Annualised</dt>
                <dd>{pct(stats.sigmaDaily * Math.sqrt(252), 1)}</dd>

                <dt title="Recent 10-session volatility versus the 90-session baseline">
                  Recent vs baseline
                </dt>
                <dd>
                  {stats.sigmaDaily > 0
                    ? `${(stats.sigmaShort / stats.sigmaDaily).toFixed(2)}×`
                    : '—'}
                </dd>

                <dt title="Sensitivity to the benchmark, from a regression on daily returns">
                  Beta
                </dt>
                <dd>{stats.beta.toFixed(2)}</dd>

                <dt title="Volatility of the part of the return the market does not explain">
                  Idiosyncratic vol
                </dt>
                <dd>{pct(stats.residSigma)}</dd>

                <dt>Average true range</dt>
                <dd>{pct(stats.atrPct)}</dd>

                <dt>52-week range</dt>
                <dd>
                  {money(stats.lo52w)} – {money(stats.hi52w)}
                </dd>

                <dt>Below 52-week peak</dt>
                <dd>
                  {stats.peak52w > 0 && quote
                    ? pct(Math.max(0, (stats.peak52w - quote.price) / stats.peak52w), 1)
                    : '—'}
                </dd>

                <dt>Median daily volume</dt>
                <dd>{compactNumber(stats.medVol20)}</dd>

                <dt>Computed</dt>
                <dd>{ago(stats.computedAt)}</dd>
              </dl>
            ) : (
              <p style={{ margin: 0, color: 'var(--text-3)', fontSize: 13 }}>
                Not enough history yet. We will not quote a volatility we cannot stand behind.
              </p>
            )}
          </div>

          <div className="panel">
            <h3>Your preferences</h3>
            <div className="field">
              <label>
                <input
                  type="checkbox"
                  checked={muted}
                  onChange={(e) => onUpdatePrefs(symbol, { muted: e.target.checked })}
                  style={{ marginRight: 8 }}
                />
                Mute — keep it listed, stop it reaching the briefing
              </label>
            </div>

            <div className="field" style={{ marginTop: 14 }}>
              <label htmlFor="minsigma">
                Only tell me about moves above{' '}
                <strong className="num">
                  {minSigma === null ? 'default' : fmtSigma(minSigma).replace('+', '')}
                </strong>
              </label>
              <input
                id="minsigma"
                type="range"
                min={0}
                max={6}
                step={0.5}
                value={minSigma ?? 0}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  onUpdatePrefs(symbol, { minSigma: v === 0 ? null : v });
                }}
              />
              <span style={{ fontSize: 11, color: 'var(--text-4)' }}>
                Applies only to signals that carry a significance figure. Data-integrity warnings
                always come through.
              </span>
            </div>
          </div>

          <div className="panel">
            <h3>Plumbing</h3>
            <dl className="kv">
              <dt>Source</dt>
              <dd style={{ fontSize: 12 }}>{quote?.source ?? '—'}</dd>

              <dt>Confidence</dt>
              <dd>{quote ? pct(quote.confidence, 0) : '—'}</dd>

              <dt>Quote age</dt>
              <dd>{quote ? duration(Date.now() - quote.asOf) : '—'}</dd>

              <dt>Poll tier</dt>
              <dd style={{ fontSize: 12 }}>{job?.tier ?? '—'}</dd>

              <dt>Poll interval</dt>
              <dd>{job ? duration(job.intervalMs) : '—'}</dd>

              {job && job.failStreak > 0 ? (
                <>
                  <dt style={{ color: 'var(--down)' }}>Consecutive failures</dt>
                  <dd style={{ color: 'var(--down)' }}>{job.failStreak}</dd>
                </>
              ) : null}
            </dl>
            {job?.lastError ? (
              <p style={{ marginTop: 10, fontSize: 11.5, color: 'var(--down)' }}>{job.lastError}</p>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}
