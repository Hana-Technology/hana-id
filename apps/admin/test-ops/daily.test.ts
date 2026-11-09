// The daily ledger checks on the real migrations as usage_admin (docs/batch-c-spec.md "Tests: Usage ledger"): the
// nonce cross-check (explained by a matching row, explained when idle, `nonce_unexplained` for a nonce with no row),
// the rejection rate (D91: one alert per org per day over 5 % with ≥ 100 relayed attempts; below it nothing), the
// NEAR/USD rate fetch (missing days only, never a replacement) and the alerts' single sends.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestDb } from '../../api/test-usage/db.ts';
import { runAlerts } from '../src/alerts.ts';
import type { LedgerStore } from '../src/ledger.ts';
import { Budget } from '../src/mail.ts';
import { runNonceCheck } from '../src/nonce-check.ts';
import { RATE_LOOKBACK_DAYS, RATE_SOURCE, rateUrl, runRates, usdMicrosFromHistory } from '../src/rates.ts';
import { REJECTION_MIN_RELAYED, overThreshold, runRejectionCheck } from '../src/rejections.ts';
import { ALIAS, DAY, FakeEmail, FakeNear, PK_A, PK_B, RELAYER, insertEvent, ledgerDb } from './fakes.ts';

let db: TestDb;
let store: LedgerStore;
beforeAll(async () => {
  ({ db, store } = await ledgerDb());
});
afterAll(async () => {
  await db.close();
});

const NOW = Date.now();
const env = { ENV_NAME: 'sandbox-test', CONSOLE_ORIGIN: 'https://console.test', SECURITY_ALIAS: ALIAS };
const PK_C = 'ed25519:4kqyRk2KyNBUm2oWT7m8n3fESEFJr3vV3YdBSiHVpDWp';
const check = (near: FakeNear, keys: string[], now: number, budget = new Budget()) => runNonceCheck({ store, near, keys, relayerAccount: RELAYER, budget, now });

describe('the nonce cross-check', () => {
  it('first check: explained by a matching row; a key the ledger never saw is the baseline', async () => {
    await insertEvent(db, { at: NOW - 3600_000, relayed: true, pk: PK_A, nonce: 100n });
    await insertEvent(db, { at: NOW - 3500_000, relayed: true, pk: PK_A, nonce: 105n });
    const near = new FakeNear();
    near.nonces.set(PK_A, 105n);
    near.nonces.set(PK_B, 9_000n);
    expect(await check(near, [PK_A, PK_B], NOW)).toEqual({ checked: 2, unexplained: 0, skipped: 0, rebaselined: 0 });
    expect(near.calls).toEqual([`key:${RELAYER}:${PK_A}`, `key:${RELAYER}:${PK_B}`]);
    const a = await store.lastNonceCheck(PK_A);
    expect(a).toMatchObject({ chainNonce: 105n, explained: true, ledgerRelayedSinceLast: 2 });
    expect(await store.lastNonceCheck(PK_B)).toMatchObject({ chainNonce: 9_000n, explained: true, ledgerRelayedSinceLast: 0 });
  });

  it('explained when idle (N unchanged), even with no row for it', async () => {
    const near = new FakeNear();
    near.nonces.set(PK_B, 9_000n);
    expect(await check(near, [PK_B], NOW + DAY)).toEqual({ checked: 1, unexplained: 0, skipped: 0, rebaselined: 0 });
  });

  it('nonce_unexplained for a nonce with no ledger row (a lost write, or a foreign signer)', async () => {
    const near = new FakeNear();
    near.nonces.set(PK_A, 230n);
    near.nonces.set(PK_B, 9_001n);
    expect(await check(near, [PK_A, PK_B], NOW + 2 * DAY)).toEqual({ checked: 2, unexplained: 2, skipped: 0, rebaselined: 0 });
    // A row for the new nonce explains the next day's check.
    await insertEvent(db, { at: NOW + 2 * DAY + 1000, relayed: true, pk: PK_A, nonce: 231n });
    near.nonces.set(PK_A, 231n);
    expect(await check(near, [PK_A], NOW + 3 * DAY)).toMatchObject({ unexplained: 0 });
    expect((await store.lastNonceCheck(PK_A))!.ledgerRelayedSinceLast).toBe(1);
  });

  it('a re-added key’s nonce (a whole multiple of 10^6, no row) is a new baseline, not an alert; the next day is idle (D456’s note)', async () => {
    const near = new FakeNear();
    const reAdded = 'ed25519:readded';
    near.nonces.set(reAdded, 212_345_000_000n);
    await insertEvent(db, { at: NOW - 1000, relayed: true, pk: reAdded, nonce: 20n });
    expect(await check(near, [reAdded], NOW + 5 * DAY)).toEqual({ checked: 1, unexplained: 0, skipped: 0, rebaselined: 1 });
    expect(await store.lastNonceCheck(reAdded)).toMatchObject({ chainNonce: 212_345_000_000n, explained: true });
    expect(await check(near, [reAdded], NOW + 6 * DAY)).toEqual({ checked: 1, unexplained: 0, skipped: 0, rebaselined: 0 });
  });

  it('a key the account doesn’t have, an unreadable RPC and an empty budget are skipped, not alerted', async () => {
    const near = new FakeNear();
    near.nonces.set(PK_A, new Error('rpc down'));
    expect(await check(near, [PK_A, PK_C], NOW + 4 * DAY)).toEqual({ checked: 0, unexplained: 0, skipped: 2, rebaselined: 0 });
    expect(await check(near, [PK_A], NOW + 4 * DAY, new Budget(0))).toEqual({ checked: 0, unexplained: 0, skipped: 1, rebaselined: 0 });
    expect(near.calls).toHaveLength(2);
  });

  it('emails the unexplained checks to the alias once (a failed send is retried by the next run)', async () => {
    const email = new FakeEmail();
    email.failFor.add(ALIAS);
    expect((await runAlerts(env, store, email, new Budget(), NOW)).nonce).toBe(0);
    email.failFor.clear();
    const s = await runAlerts(env, store, email, new Budget(), NOW);
    expect(s.nonce).toBe(2);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]).toMatchObject({ to: ALIAS });
    expect(email.sent[0]!.subject).toMatch(/Relayer nonce unexplained \(2\)/u);
    expect(email.sent[0]!.text).toContain(PK_A);
    expect((await runAlerts(env, store, email, new Budget(), NOW)).nonce).toBe(0);
    expect(email.sent).toHaveLength(1);
  });
});

describe('the rejection-rate check (D91)', () => {
  const yesterday = NOW - DAY;
  it('raises one alert per org and day over 5 % with at least 100 relayed attempts; below either, nothing', async () => {
    const seed = async (org: string, relayed: number, rejected: number) => {
      for (let k = 0; k < relayed; k++) await insertEvent(db, { org, at: yesterday, relayed: true, ...(k < rejected ? { outcome: 'rejected' as const, code: 'contract_rejected' } : {}) });
    };
    await seed('org_bad', 100, 6);
    await seed('org_edge', 100, 5);
    await seed('org_small', 20, 10);
    expect(overThreshold(REJECTION_MIN_RELAYED, 6)).toBe(true);
    expect(overThreshold(REJECTION_MIN_RELAYED, 5)).toBe(false);
    expect(overThreshold(REJECTION_MIN_RELAYED - 1, 50)).toBe(false);
    const r = await runRejectionCheck({ store, now: NOW });
    expect(r).toMatchObject({ day: new Date(yesterday).toISOString().slice(0, 10), alerts: 1 });
    expect((await store.rejectionAlerts({ unalertedOnly: true, limit: 10 })).map((a) => [a.orgId, a.relayed, a.rejected])).toEqual([['org_bad', 100, 6]]);
    // A second run the same day adds nothing.
    expect((await runRejectionCheck({ store, now: NOW })).alerts).toBe(0);
    const email = new FakeEmail();
    expect((await runAlerts(env, store, email, new Budget(), NOW)).rejection).toBe(1);
    expect(email.sent.map((m) => [m.to, m.subject])).toEqual([[ALIAS, '[Hana ID sandbox-test] Rejection rate over 5% (1)']]);
    expect((await runAlerts(env, store, email, new Budget(), NOW)).rejection).toBe(0);
  });
});

describe('the NEAR/USD rate', () => {
  it('parses CoinGecko’s history answer (USD at 00:00 UTC of the date) and refuses implausible values', () => {
    expect(rateUrl('2026-11-04')).toBe('https://api.coingecko.com/api/v3/coins/near/history?date=04-11-2026&localization=false');
    expect(usdMicrosFromHistory({ market_data: { current_price: { usd: 2.345678 } } })).toBe(2_345_678n);
    expect(usdMicrosFromHistory({ market_data: { current_price: { usd: 0.0000004 } } })).toBeNull();
    for (const bad of [{}, { market_data: {} }, { market_data: { current_price: { usd: -1 } } }, { market_data: { current_price: { usd: '2.5' } } }, { market_data: { current_price: { usd: 2e7 } } }, null]) {
      expect(usdMicrosFromHistory(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('fills the missing days of the last 10, oldest first, one call each; never replaces a rate', async () => {
    const day = (k: number) => new Date(NOW - k * DAY).toISOString().slice(0, 10);
    await store.insertFetchedRate(day(3), 1_000_000n, RATE_SOURCE);
    await store.overrideRate(day(2), 1_500_000n, 'staff@hana.example', 'Set by hand for the test');
    const asked: string[] = [];
    const fetchRate = async (d: string) => {
      asked.push(d);
      return d === day(5) ? null : 2_000_000n;
    };
    const s = await runRates({ store, fetchRate, budget: new Budget(), now: NOW });
    expect(s).toEqual({ missing: RATE_LOOKBACK_DAYS - 2, fetched: RATE_LOOKBACK_DAYS - 3, failed: 1 });
    expect(asked).toEqual(Array.from({ length: RATE_LOOKBACK_DAYS }, (_, i) => day(RATE_LOOKBACK_DAYS - 1 - i)).filter((d) => d !== day(3) && d !== day(2)));
    const rates = await store.ratesBetween(day(9), day(0));
    expect(rates.find((r) => r.day === day(2))).toMatchObject({ usdMicros: 1_500_000n, source: 'manual', enteredBy: 'staff@hana.example' });
    expect(rates.find((r) => r.day === day(3))).toMatchObject({ usdMicros: 1_000_000n, source: RATE_SOURCE });
    // The next run asks only for the day that failed; a small budget stops it.
    asked.length = 0;
    expect(await runRates({ store, fetchRate: async () => 2_000_000n, budget: new Budget(), now: NOW })).toEqual({ missing: 1, fetched: 1, failed: 0 });
    expect(await runRates({ store, fetchRate, budget: new Budget(0), now: NOW + DAY })).toMatchObject({ missing: 1, fetched: 0 });
  });
});

describe('partitions', () => {
  it('ensure_partitions as the admin is a no-op when the API keeps them; at least 2 future partitions exist', async () => {
    expect(await store.ensurePartitions(12)).toBe(0);
    expect(await store.partitionsAhead()).toBeGreaterThanOrEqual(12);
  });
});
