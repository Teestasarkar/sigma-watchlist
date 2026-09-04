/**
 * The lab: break the running system on purpose and watch it cope.
 *
 * This page exists because resilience claims are unfalsifiable otherwise. A
 * README can assert "handles provider outages gracefully" and nobody can check
 * it. Here you can kill the feed and watch the circuit breaker open, let our
 * prices go stale and watch the product start warning instead of quoting, or
 * shock a utility 2% and watch it outrank a 6% move in a meme stock.
 *
 * It also doubles as the honest demo of the core thesis: the two "shock"
 * buttons apply the same magnitude to instruments with very different
 * volatilities, and the briefing ranks them the way the maths says it should.
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import type { Diagnostics } from '../lib/types.js';
import { duration } from '../lib/format.js';
import { Banner, Chip, Spinner } from './primitives.js';

interface Props {
  onChanged: () => void;
}

export function Lab({ onChanged }: Props): React.JSX.Element {
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => {
    void api
      .diagnostics()
      .then(setDiag)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [load]);

  const run = async (label: string, fn: () => Promise<unknown>, message: string): Promise<void> => {
    setBusy(label);
    setNote(null);
    try {
      await fn();
      setNote(message);
      load();
      onChanged();
    } catch (err) {
      setNote(err instanceof Error ? `Failed: ${err.message}` : 'Failed');
    } finally {
      setBusy(null);
    }
  };

  const faultsActive = diag?.faults?.active === true;

  return (
    <>
      <div className="section-head">
        <h2>Fault injection</h2>
        <div className="spacer" />
        {faultsActive ? <Chip tone="warn">faults active</Chip> : null}
        <button
          className="btn btn-sm"
          disabled={busy !== null}
          onClick={() => void run('reset', () => api.dev.resetFaults(), 'All faults cleared and breakers reset.')}
        >
          Reset everything
        </button>
      </div>

      {note ? <Banner tone="info">{note}</Banner> : null}

      <div className="lab-grid">
        {/* ── the core thesis, demonstrable ────────────────────────── */}
        <div className="panel lab-card">
          <h4>Significance, not percentage</h4>
          <p>
            The same shock applied to instruments with very different volatility. Watch how the
            briefing ranks them: the utility should outrank the meme stock despite moving less.
          </p>
          <div className="lab-row">
            <button
              className="btn btn-sm"
              disabled={busy !== null}
              onClick={() =>
                void run('nee', () => api.dev.shock('NEE', 0.025), 'NEE shocked +2.5% — a large move for a utility.')
              }
            >
              NEE +2.5%
            </button>
            <button
              className="btn btn-sm"
              disabled={busy !== null}
              onClick={() =>
                void run('gme', () => api.dev.shock('GME', 0.06), 'GME shocked +6% — an ordinary day for GME.')
              }
            >
              GME +6%
            </button>
            <button
              className="btn btn-sm"
              disabled={busy !== null}
              onClick={() =>
                void run('unh', () => api.dev.shock('UNH', -0.05), 'UNH shocked −5%.')
              }
            >
              UNH −5%
            </button>
          </div>
        </div>

        {/* ── time travel ─────────────────────────────────────────── */}
        <div className="panel lab-card">
          <h4>Come back later</h4>
          <p>
            Rewinds your checkpoint so the briefing covers a longer window — the same thing that
            happens when you actually walk away and return.
          </p>
          <div className="lab-row">
            {[15, 60, 240].map((m) => (
              <button
                key={m}
                className="btn btn-sm"
                disabled={busy !== null}
                onClick={() =>
                  void run(`rewind${m}`, () => api.dev.rewind(m), `Checkpoint moved back ${m} minutes.`)
                }
              >
                −{m < 60 ? `${m}m` : `${m / 60}h`}
              </button>
            ))}
          </div>
        </div>

        {/* ── unreliable upstream ─────────────────────────────────── */}
        <div className="panel lab-card">
          <h4>Kill the feed</h4>
          <p>
            Makes every provider request fail. After a few failures the circuit breaker opens and we
            stop hammering a dead upstream; the watchlist keeps serving its last known prices, and
            says how old they are.
          </p>
          <div className="lab-row">
            <button
              className="btn btn-sm"
              disabled={busy !== null}
              onClick={() =>
                void run('fail', () => api.dev.faults({ failureRate: 1 }), 'Every provider request now fails.')
              }
            >
              100% failure
            </button>
            <button
              className="btn btn-sm"
              disabled={busy !== null}
              onClick={() =>
                void run('flaky', () => api.dev.faults({ failureRate: 0.4 }), 'Provider is now flaky (40% failure).')
              }
            >
              40% flaky
            </button>
            <button
              className="btn btn-sm"
              disabled={busy !== null}
              onClick={() =>
                void run('slow', () => api.dev.faults({ latencyMs: 3500 }), 'Provider is now slow — watch for timeouts.')
              }
            >
              Add 3.5s latency
            </button>
          </div>
        </div>

        {/* ── stale data ──────────────────────────────────────────── */}
        <div className="panel lab-card">
          <h4>Let the prices go stale</h4>
          <p>
            Ages our stored quotes. The product stops presenting them as live, raises a
            data-integrity signal, and suppresses statistical claims computed from prices it no
            longer trusts.
          </p>
          <div className="lab-row">
            <button
              className="btn btn-sm"
              disabled={busy !== null}
              onClick={() => void run('age10', () => api.dev.age(10), 'Quotes aged by 10 minutes.')}
            >
              Age 10 min
            </button>
            <button
              className="btn btn-sm"
              disabled={busy !== null}
              onClick={() => void run('age45', () => api.dev.age(45), 'Quotes aged by 45 minutes — now beyond the stale threshold.')}
            >
              Age 45 min
            </button>
          </div>
        </div>

        {/* ── halts and delistings ────────────────────────────────── */}
        <div className="panel lab-card">
          <h4>Halts and vanishing symbols</h4>
          <p>
            A halted instrument still has a last price, but it is no longer actionable. A symbol no
            provider recognises is marked rather than silently dropped.
          </p>
          <div className="lab-row">
            <button
              className="btn btn-sm"
              disabled={busy !== null}
              onClick={() => void run('halt', () => api.dev.faults({ halted: ['TSLA'] }), 'TSLA is now halted.')}
            >
              Halt TSLA
            </button>
            <button
              className="btn btn-sm"
              disabled={busy !== null}
              onClick={() =>
                void run('unknown', () => api.dev.faults({ unknown: ['GME'] }), 'GME now unrecognised by the provider.')
              }
            >
              Delist GME
            </button>
          </div>
        </div>

        {/* ── disagreement ────────────────────────────────────────── */}
        <div className="panel lab-card">
          <h4>Make the sources disagree</h4>
          <p>
            Skews one provider&rsquo;s prices. With two sources configured, the disagreement is
            recorded on the quote, lowers its confidence, and is surfaced — never silently resolved.
            Requires <code>PROVIDERS=synthetic,synthetic-alt</code>.
          </p>
          <div className="lab-row">
            <button
              className="btn btn-sm"
              disabled={busy !== null}
              onClick={() =>
                void run('skew', () => api.dev.faults({ priceSkew: 1.03 }), 'One provider now quotes 3% high.')
              }
            >
              Skew prices 3%
            </button>
          </div>
        </div>
      </div>

      {/* ── live diagnostics ─────────────────────────────────────── */}
      <div className="section-head">
        <h2>Live diagnostics</h2>
        <div className="spacer" />
        {diag === null ? <Spinner /> : null}
      </div>

      {diag ? (
        <div className="detail-grid">
          <div className="panel">
            <h3>Providers</h3>
            <div className="provider-grid">
              {diag.providers.providers.map((p) => {
                const name = String(p.name);
                const state = String(p.state ?? 'closed');
                return (
                  <div className="provider" key={name}>
                    <span className="pname">{name}</span>
                    <Chip tone={state === 'closed' ? 'muted' : 'down'}>
                      circuit {state.replace('_', '-')}
                    </Chip>
                    <div className="pstats">
                      <span>ok {String(p.ok ?? 0)}</span>
                      <span>fail {String(p.fail ?? 0)}</span>
                      <span>tokens {String(p.tokensAvailable ?? 0)}</span>
                      <span>skipped {String(p.skippedRequests ?? 0)}</span>
                    </div>
                    {state !== 'closed' ? null : (
                      <button
                        className="btn btn-sm"
                        disabled={busy !== null}
                        onClick={() =>
                          void run('trip', () => api.dev.breaker(name, 'trip'), `Tripped ${name}.`)
                        }
                      >
                        Trip
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            <h3 style={{ marginTop: 20 }}>Scheduler</h3>
            <dl className="kv">
              <dt>Running</dt>
              <dd>{diag.scheduler.running ? 'yes' : 'no'}</dd>
              <dt>Ticks</dt>
              <dd>{diag.scheduler.ticks}</dd>
              <dt>Symbols refreshed</dt>
              <dd>{diag.scheduler.refreshed}</dd>
              <dt>Failures</dt>
              <dd style={{ color: diag.scheduler.failed > 0 ? 'var(--warn)' : undefined }}>
                {diag.scheduler.failed}
              </dd>
              <dt>Signals created</dt>
              <dd>{diag.scheduler.signalsCreated}</dd>
              <dt>Due now</dt>
              <dd>{diag.scheduler.queueDepth}</dd>
              <dt>Last tick</dt>
              <dd>{duration(diag.scheduler.lastTickDurationMs)}</dd>
              <dt>Signals stored</dt>
              <dd>{diag.signals.total}</dd>
              <dt>Poll tiers</dt>
              <dd style={{ fontSize: 12 }}>
                {Object.entries(diag.scheduler.tiers)
                  .map(([k, v]) => `${k} ${v}`)
                  .join(' · ')}
              </dd>
            </dl>
          </div>

          <div className="panel">
            <h3>Poll queue</h3>
            <div style={{ maxHeight: 420, overflowY: 'auto', margin: '-4px -6px' }}>
              <table className="rows" style={{ minWidth: 0 }}>
                <thead>
                  <tr>
                    <th style={{ position: 'static' }}>Symbol</th>
                    <th style={{ position: 'static' }}>Tier</th>
                    <th style={{ position: 'static' }}>Due</th>
                    <th style={{ position: 'static' }}>Fails</th>
                  </tr>
                </thead>
                <tbody>
                  {diag.jobs.map((j) => (
                    <tr key={j.symbol}>
                      <td style={{ fontFamily: 'var(--mono)' }}>{j.symbol}</td>
                      <td style={{ fontSize: 12, color: 'var(--text-3)' }}>{j.tier}</td>
                      <td className="num" style={{ fontSize: 12 }}>
                        {j.dueInMs <= 0 ? 'now' : duration(j.dueInMs)}
                      </td>
                      <td
                        className="num"
                        style={{ fontSize: 12, color: j.failStreak > 0 ? 'var(--down)' : 'var(--text-4)' }}
                        title={j.lastError ?? undefined}
                      >
                        {j.failStreak}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
