// The daily NEAR/USD rate (docs/batch-c-spec.md "Crons": one source, named in the service contract; D93 Q17; D325):
// CoinGecko's daily history, whose price for a date is its snapshot at 00:00 UTC of that date, so day D's rate is
// D's opening price. The 00:30 UTC run fills every day of the last RATE_LOOKBACK_DAYS (today included) that has no
// rate yet, oldest first, one call each from the run's budget; a fetched rate never replaces one (a staff override,
// or an earlier fetch). Older gaps are filled by the audited override (`PUT /api/rates/:day`, `usage.override_rate`).
// Testnet usage is valued at this mainnet price and labelled on the statement.
import type { Budget } from './mail.ts';
import type { LedgerStore } from './ledger.ts';

export const RATE_SOURCE = 'coingecko';
export const RATE_LOOKBACK_DAYS = 10;
export const RATE_TIMEOUT_MS = 8_000;
/** A sanity bound: a NEAR/USD price outside (0, 1 000 000] is refused, never stored. */
export const MAX_USD_MICROS = 1_000_000_000_000n;

/** CoinGecko's history endpoint for a UTC day (its date format is DD-MM-YYYY). */
export function rateUrl(day: string): string {
  const [y, m, d] = day.split('-');
  return `https://api.coingecko.com/api/v3/coins/near/history?date=${d}-${m}-${y}&localization=false`;
}

/** The USD price in a CoinGecko history answer as micro-dollars, or null when absent or implausible. */
export function usdMicrosFromHistory(body: unknown): bigint | null {
  const usd = (body as { market_data?: { current_price?: { usd?: unknown } } } | null)?.market_data?.current_price?.usd;
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) return null;
  const micros = BigInt(Math.round(usd * 1_000_000));
  return micros > 0n && micros <= MAX_USD_MICROS ? micros : null;
}

export type FetchRate = (day: string) => Promise<bigint | null>;

/** The CoinGecko fetch (an optional demo API key in its header; the key is never logged). Never throws. */
export function coingecko(apiKey: string | undefined): FetchRate {
  return async (day) => {
    try {
      const res = await fetch(rateUrl(day), {
        headers: { accept: 'application/json', ...(apiKey ? { 'x-cg-demo-api-key': apiKey } : {}) },
        signal: AbortSignal.timeout(RATE_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      return usdMicrosFromHistory(await res.json());
    } catch {
      return null;
    }
  };
}

const dayOf = (t: number): string => new Date(t).toISOString().slice(0, 10);

export interface RatesSummary {
  missing: number;
  fetched: number;
  failed: number;
}

export async function runRates(d: { store: LedgerStore; fetchRate: FetchRate; budget: Budget; now: number }): Promise<RatesSummary> {
  const today = dayOf(d.now);
  const first = dayOf(d.now - (RATE_LOOKBACK_DAYS - 1) * 86_400_000);
  const have = new Set((await d.store.ratesBetween(first, today)).map((r) => r.day));
  const missing: string[] = [];
  for (let k = RATE_LOOKBACK_DAYS - 1; k >= 0; k--) {
    const day = dayOf(d.now - k * 86_400_000);
    if (!have.has(day)) missing.push(day);
  }
  const sum: RatesSummary = { missing: missing.length, fetched: 0, failed: 0 };
  for (const day of missing) {
    if (!d.budget.take()) break;
    const micros = await d.fetchRate(day);
    if (micros === null) {
      sum.failed++;
      continue;
    }
    try {
      if (await d.store.insertFetchedRate(day, micros, RATE_SOURCE)) sum.fetched++;
    } catch {
      // A month frozen by a statement refuses the insert (rates_frozen): nothing to fetch there.
      sum.failed++;
    }
  }
  return sum;
}
