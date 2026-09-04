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
    health.worstFreshness !== 'fresh' ||
    health.conflicted.length > 0 ||
    health.halted.length > 0 ||
    health.providers.some((p) => p.breaker !== 'closed');

  return (
    <div className={`health-strip${degraded ? ' is-degraded' : ''}`}>
      <FreshnessDot state={health.worstFreshness} label />

      {!degraded ? (
        <span>All feeds healthy · prices current</span>
      ) : (
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
      )}

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
