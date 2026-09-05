/**
 * Ask every configured live vendor the same question and print what they said.
 *
 * Cross-vendor reconciliation is easy to write and hard to believe. This makes
 * it observable: run it and see two independent feeds, their spread, which
 * resolution rule fired, and what confidence the disagreement bought.
 *
 *   npx tsx src/scripts/vendorCheck.ts AAPL MSFT NVDA
 */

import { exchangeClock } from '../domain/marketClock.js';
import { systemClock } from '../infra/clock.js';
import { reconcileQuotes } from '../providers/reconcile.js';
import { YahooProvider } from '../providers/yahoo.js';
import { CnbcProvider } from '../providers/cnbc.js';
import type { MarketDataProvider } from '../providers/types.js';
import type { RawQuote } from '../domain/types.js';

const symbols = process.argv.slice(2).map((s) => s.toUpperCase());
if (symbols.length === 0) symbols.push('AAPL', 'MSFT', 'NVDA', 'TSLA');

const providers: MarketDataProvider[] = [
  new YahooProvider(exchangeClock, systemClock),
  new CnbcProvider(exchangeClock, systemClock),
];

const now = systemClock.now();
const marketOpen = exchangeClock.isOpen(now);
const lastClose = exchangeClock.lastCompletedSessionAt(now);

console.log(`market ${marketOpen ? 'OPEN' : 'CLOSED'}  ·  last session close ${iso(lastClose)}\n`);

for (const symbol of symbols) {
  const raws: RawQuote[] = [];

  await Promise.all(
    providers.map(async (p) => {
      try {
        raws.push(await p.getQuote(symbol));
      } catch (err) {
        console.log(`  ${pad(p.name)} FAILED  ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );

  console.log(symbol);
  for (const r of [...raws].sort((a, b) => a.source.localeCompare(b.source))) {
    console.log(`  ${pad(r.source)} ${r.price.toFixed(2).padStart(9)}   asOf ${iso(r.asOf)}`);
  }

  const quote = reconcileQuotes(raws, now, {
    tolerance: 0.005,
    freshMs: 120_000,
    delayedMs: 900_000,
    staleMs: 3_600_000,
    preference: providers.map((p) => p.name),
    marketOpen,
    lastSessionCloseAt: lastClose,
  });

  if (!quote) {
    console.log('  → no usable quote\n');
    continue;
  }

  const spread = quote.conflict ? `${(quote.conflict.spread * 100).toFixed(3)}%` : 'within tolerance';
  console.log(
    `  → ${quote.price.toFixed(2)} via ${quote.source}` +
      `  ·  spread ${spread}` +
      `  ·  ${quote.freshness ?? classify(quote.confidence)}` +
      `  ·  confidence ${quote.confidence.toFixed(3)}\n`,
  );
}

function pad(s: string): string {
  return s.padEnd(6);
}

function iso(ts: number): string {
  return new Date(ts).toISOString().replace('.000Z', 'Z');
}

function classify(c: number): string {
  return c >= 0.95 ? 'clean' : c >= 0.7 ? 'discounted' : 'doubtful';
}
