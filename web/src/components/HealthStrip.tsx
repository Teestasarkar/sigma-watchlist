/**
 * Data health, shown on the same screen as the prices.
 *
 * Most dashboards bury this. That is a mistake: "we cannot currently price
 * three of your holdings" is information a user needs at the exact moment
 * they are reading prices, not on a status page they will never open. When
 * everything is fine it stays quiet and small; when it is not, it says so
 * plainly and names the symbols.
 */

import type { DataHealth } from '../lib/types.js';
import { Chip, FreshnessDot } from './primitives.js';

export function HealthStrip({ health }: { health: DataHealth }): React.JSX.Element {
  const degraded =
    // 'closed' is not degraded - the market being shut is not a fault.
    (health.worstFreshness !== 'fresh' && health.worstFreshness !== 'closed') ||
    health.conflicted.length > 0 ||
    health.halted.length > 0 ||
    health.providers.some((p) => p.breaker !== 'closed');

  return (
    <div className={`health-strip${degraded ? ' is-degraded' : ''}`}>
      <FreshnessDot state={health.worstFreshness} label />

      {/*
        * Always say something in words.
        *
        * The dot alone is not an explanation. A state like `delayed` used to
        * render a bare "Delayed" with no sentence beside it - during market
        * hours, which is precisely when someone is deciding whether to act on
        * the number next to it. Naming the state costs one line and removes
        * the guessing.
        */}
      <span>{summarise(health.worstFreshness)}</span>

      {degraded ? (
        <>
          {health.stale.length > 0 ? (
            <Chip tone="warn" title={health.stale.join(', ')}>
              {health.stale.length} stale: {health.stale.slice(0, 4).join(' ')}
              {health.stale.length > 4 ? ' …' : ''}
            </Chip>
          ) : null}

          {health.conflicted.length > 0 ? (
            <Chip tone="warn" title={health.conflicted.join(', ')}>
              {health.conflicted.length} disputed price
              {health.conflicted.length === 1 ? '' : 's'}
            </Chip>
          ) : null}

          {health.halted.length > 0 ? (
            <Chip tone="down" title={health.halted.join(', ')}>
              halted: {health.halted.join(' ')}
            </Chip>
          ) : null}

          {health.providers
            .filter((p) => p.breaker !== 'closed')
            .map((p) => (
              <Chip key={p.provider} tone="down" title={p.lastError ?? undefined}>
                {p.provider}: circuit {p.breaker.replace('_', '-')}
              </Chip>
            ))}
        </>
      ) : null}

      {health.thinHistory.length > 0 ? (
        <Chip tone="muted" title={health.thinHistory.join(', ')}>
          {health.thinHistory.length} with thin history — statistics withheld
        </Chip>
      ) : null}

      <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-4)' }}>
        {health.providers.map((p) => `${p.provider} ${p.ok}/${p.ok + p.fail}`).join(' · ')}
      </span>
    </div>
  );
}

/**
 * One plain sentence per data state.
 *
 * Deliberately not alarming for `closed`: the market being shut is not a
 * fault, and a closing price during a closed market is the current price, not
 * a stale one. Everything else says what is wrong in the user's terms rather
 * than in the engine's.
 */
function summarise(freshness: DataHealth['worstFreshness']): string {
  switch (freshness) {
    case 'fresh':
      return 'All feeds healthy · prices current';
    case 'closed':
      return 'Market closed · showing the last closing prices';
    case 'delayed':
      return 'Prices are a few minutes behind';
    case 'stale':
      return 'Some prices could not be refreshed';
    default:
      return 'No usable price for some instruments';
  }
}
