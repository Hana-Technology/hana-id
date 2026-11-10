// Gas settlement (src/settlement.ts) on the real migrations as usage_admin: docs/batch-c-spec.md "Tests: Usage ledger"
// (settlement against mocked RPC including `unsettled` after 24 h) and the C4 obligation (review L7, D222; D321): a
// relayed event is billed only when its transaction is its own. Tested with a duplicated near_tx, and with a wrong key
// and a wrong nonce.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestDb } from '../../api/test-usage/db.ts';
import { runAlerts } from '../src/alerts.ts';
import type { LedgerStore } from '../src/ledger.ts';
import { Budget, RUN_BUDGET } from '../src/mail.ts';
import { type RelayerPool, SETTLEMENT_RETRY_MS, UNSETTLED_AFTER_MS, mismatchOf, poolMatches, runSettlement } from '../src/settlement.ts';
import { parseTxResult } from '../src/near.ts';
import { ALIAS, FakeEmail, FakeNear, PK_A, PK_B, PK_HOME, POOL_KEYS, RELAYER, SIGNER, insertEvent, ledgerDb, txHash } from './fakes.ts';

let db: TestDb;
let store: LedgerStore;
beforeAll(async () => {
  ({ db, store } = await ledgerDb());
});
afterAll(async () => {
  await db.close();
});

const NOW = Date.now();
const settlementOf = async (rid: string) => (await db.query<{ result: string; gas_burnt: string | null; tokens_burnt: string | null; reason: string | null }>('SELECT result, gas_burnt::text, tokens_burnt::text, reason FROM usage.gas_settlements WHERE request_id = $1', [rid]))[0];
const env = { ENV_NAME: 'sandbox-test', CONSOLE_ORIGIN: 'https://console.test', SECURITY_ALIAS: ALIAS };
const POOLS = new Map<string, RelayerPool>(POOL_KEYS.map((k) => [k.publicKey, k.pool]));
const run = (near: FakeNear, o: { budget?: Budget; now?: number; keys?: ReadonlyMap<string, RelayerPool> } = {}) =>
  runSettlement({ store, near, poolKeys: o.keys ?? POOLS, relayerAccount: RELAYER, signerAccount: SIGNER, budget: o.budget ?? new Budget(), now: o.now ?? NOW });
/** Clears every queued event first so each test sees only its own. */
const clearQueue = async () => {
  for (const e of await store.settlementQueue(10_000, NOW + 10 * UNSETTLED_AFTER_MS, 0)) await store.recordSettlement({ requestId: e.requestId, at: e.at, nearTx: e.nearTx, result: 'unsettled', reason: 'not_final' });
};

describe('settlement at FINAL', () => {
  it('writes the BigInt sums of a transaction signed by the event’s key at its nonce', async () => {
    await clearQueue();
    const e = await insertEvent(db, { at: NOW - 60_000, relayed: true, pk: PK_B, nonce: 193_000_000_000_001n });
    const near = new FakeNear();
    near.finalTx(e.tx!, { pk: PK_B, nonce: 193_000_000_000_001n, gas: 32_670_449_867_484n, tokens: 3_244_726_730_498_400_000_000n });
    expect(await run(near)).toMatchObject({ read: 1, final: 1, refused: 0 });
    expect(await settlementOf(e.rid)).toEqual({ result: 'final', gas_burnt: '32670449867484', tokens_burnt: '3244726730498400000000', reason: null });
    expect(near.calls).toEqual([`tx:${e.tx}:${RELAYER}`]);
    // Settled once: the next run reads nothing.
    expect(await run(near)).toMatchObject({ read: 0, final: 0 });
  });

  it('retries a transaction not final yet an hour later, then writes unsettled (not_final) after 24 h, never estimated', async () => {
    await clearQueue();
    const e = await insertEvent(db, { at: NOW - 60_000, relayed: true });
    const near = new FakeNear();
    expect(await run(near)).toMatchObject({ read: 1, retried: 1 });
    expect(await settlementOf(e.rid)).toBeUndefined();
    // Within the hour it isn't read again.
    expect(await run(near, { now: NOW + 10 * 60_000 })).toMatchObject({ read: 0 });
    expect(await run(near, { now: NOW + SETTLEMENT_RETRY_MS + 1 })).toMatchObject({ read: 1, retried: 1 });
    const [t] = await db.query<{ tries: number; last_error: string }>('SELECT tries, last_error FROM ops.settlement_tries WHERE request_id = $1', [e.rid]);
    expect(t).toEqual({ tries: 2, last_error: 'unknown_transaction' });
    expect(await run(near, { now: e.at + UNSETTLED_AFTER_MS + 2 * SETTLEMENT_RETRY_MS })).toMatchObject({ unsettled: 1 });
    expect(await settlementOf(e.rid)).toEqual({ result: 'unsettled', gas_burnt: null, tokens_burnt: null, reason: 'not_final' });
    expect(await db.query('SELECT 1 FROM ops.settlement_tries WHERE request_id = $1', [e.rid])).toEqual([]);
  });

  it('takes one call of the run’s budget per tx read and stops when it is spent', async () => {
    await clearQueue();
    const near = new FakeNear();
    for (let k = 0; k < 5; k++) {
      const e = await insertEvent(db, { at: NOW - 30_000 + k, relayed: true });
      near.finalTx(e.tx!, { pk: e.pk!, nonce: e.nonce! });
    }
    const budget = new Budget(3);
    expect(await run(near, { budget })).toMatchObject({ read: 3, final: 3 });
    expect(budget.remaining).toBe(0);
    expect(await run(near, { budget: new Budget(RUN_BUDGET) })).toMatchObject({ read: 2, final: 2 });
  });
});

describe('billing only a transaction of its own (C4 review L7)', () => {
  it('a near_tx duplicated on another relayed event bills neither, and raises one alert per event', async () => {
    await clearQueue();
    const tx = txHash();
    const real = await insertEvent(db, { org: 'org_victim', at: NOW - 50_000, relayed: true, tx, nonce: 5_000_001n });
    const copy = await insertEvent(db, { org: 'org_thief', at: NOW - 40_000, relayed: true, tx, nonce: 5_000_001n });
    const near = new FakeNear();
    near.finalTx(tx, { pk: PK_A, nonce: 5_000_001n });
    expect(await run(near)).toMatchObject({ read: 0, final: 0, refused: 2 });
    expect(near.calls).toEqual([]);
    for (const e of [real, copy]) expect(await settlementOf(e.rid)).toEqual({ result: 'unsettled', gas_burnt: null, tokens_burnt: null, reason: 'duplicate_tx' });
    const alerts = await store.settlementAlerts({ unalertedOnly: true, limit: 10 });
    expect(alerts.map((a) => [a.orgId, a.reason, a.nearTx])).toEqual(
      expect.arrayContaining([
        ['org_victim', 'duplicate_tx', tx],
        ['org_thief', 'duplicate_tx', tx],
      ]),
    );
    expect(alerts.find((a) => a.orgId === 'org_thief')!.detail).toMatchObject({ others: [{ requestId: real.rid, orgId: 'org_victim' }] });
    // Neither is billed in the report either.
    const [r] = await db.query<{ gas: string; unsettled: string }>("SELECT gas, unsettled::text FROM usage.org_report('org_victim', (now() AT TIME ZONE 'UTC')::date - 1, (now() AT TIME ZONE 'UTC')::date, 'month')");
    expect(r).toEqual({ gas: '0', unsettled: '1' });
  });

  it('a duplicate written after the first settled: the copy is refused, and the report stops billing the first too', async () => {
    await clearQueue();
    const tx = txHash();
    const first = await insertEvent(db, { org: 'org_first', at: NOW - 30_000, relayed: true, tx, nonce: 6_000_001n });
    const near = new FakeNear();
    near.finalTx(tx, { pk: PK_A, nonce: 6_000_001n, gas: 4_000_000_000_000n });
    expect(await run(near)).toMatchObject({ final: 1 });
    await insertEvent(db, { org: 'org_late_copy', at: NOW - 20_000, received: NOW, relayed: true, tx, nonce: 6_000_001n });
    expect(await run(near)).toMatchObject({ refused: 1 });
    expect((await settlementOf(first.rid))!.result).toBe('final');
    const [r] = await db.query<{ gas: string; unsettled: string }>("SELECT gas, unsettled::text FROM usage.org_report('org_first', (now() AT TIME ZONE 'UTC')::date - 1, (now() AT TIME ZONE 'UTC')::date, 'month')");
    expect(r).toEqual({ gas: '0', unsettled: '1' });
  });

  it('a transaction signed with another key, or at another nonce, is unsettled (signer_mismatch) with an alert naming the chain’s values', async () => {
    await clearQueue();
    const wrongKey = await insertEvent(db, { org: 'org_k', at: NOW - 30_000, relayed: true, pk: PK_A, nonce: 7_000_001n });
    const wrongNonce = await insertEvent(db, { org: 'org_n', at: NOW - 29_000, relayed: true, pk: PK_A, nonce: 7_000_002n });
    const near = new FakeNear();
    near.finalTx(wrongKey.tx!, { pk: PK_A, publicKey: PK_B, nonce: 7_000_001n });
    near.finalTx(wrongNonce.tx!, { pk: PK_A, nonce: 7_000_099n });
    expect(await run(near)).toMatchObject({ read: 2, final: 0, refused: 2 });
    expect((await settlementOf(wrongKey.rid))!.reason).toBe('signer_mismatch');
    expect((await settlementOf(wrongNonce.rid))!.reason).toBe('signer_mismatch');
    const alerts = await store.settlementAlerts({ unalertedOnly: true, limit: 50 });
    expect(alerts.find((a) => a.requestId === wrongKey.rid)!.detail).toEqual({ expected: { publicKey: PK_A, nonce: '7000001' }, chain: { publicKey: PK_B } });
    expect(alerts.find((a) => a.requestId === wrongNonce.rid)!.detail).toEqual({ expected: { publicKey: PK_A, nonce: '7000002' }, chain: { nonce: '7000099' } });
  });

  it('a relayer key outside the env’s pools is refused without a chain read; another signer or receiver too', async () => {
    await clearQueue();
    const foreign = 'ed25519:7XkTqBqqDX2pD2oDFcHoMBoUnDwDaMrFbTfyobKmsS9a';
    const e = await insertEvent(db, { org: 'org_f', at: NOW - 20_000, relayed: true, pk: foreign });
    const near = new FakeNear();
    expect(await run(near)).toMatchObject({ read: 0, refused: 1 });
    expect(near.calls).toEqual([]);
    expect((await settlementOf(e.rid))!.reason).toBe('signer_mismatch');
    const base = { requestId: 'r', at: 1, orgId: 'o', endpoint: 'login', nearTx: 'h', relayerPk: PK_A, relayerNonce: 1n };
    const d = { relayerAccount: RELAYER, signerAccount: SIGNER };
    expect(mismatchOf(base, { hash: 'h', signerId: RELAYER, publicKey: PK_A, nonce: 1n, receiverId: SIGNER }, d)).toBeNull();
    expect(mismatchOf(base, { hash: 'h', signerId: 'evil.testnet', publicKey: PK_A, nonce: 1n, receiverId: 'other.testnet' }, d)).toEqual({ signerId: 'evil.testnet', receiverId: 'other.testnet' });
    expect(mismatchOf(base, { hash: 'x', signerId: RELAYER, publicKey: PK_A, nonce: 1n, receiverId: SIGNER }, d)).toEqual({ hash: 'x' });
  });

  it('a Hana Home derive is settled like any other: a genuine one is billed from the chain’s figures', async () => {
    await clearQueue();
    const e = await insertEvent(db, { org: 'org_home', endpoint: 'home_login', scope: 'shome', at: NOW - 60_000, relayed: true, pk: PK_HOME, nonce: 8_000_001n });
    const near = new FakeNear();
    near.finalTx(e.tx!, { pk: PK_HOME, nonce: 8_000_001n, gas: 38_500_000_000_000n, tokens: 3_850_000_000_000_000_000_000n });
    expect(await run(near)).toMatchObject({ read: 1, final: 1, refused: 0 });
    expect(await settlementOf(e.rid)).toEqual({ result: 'final', gas_burnt: '38500000000000', tokens_burnt: '3850000000000000000000', reason: null });
    // Billed on its own line: the org's Home row carries exactly this gas.
    const rows = await db.query<{ kind: string; home_logins: string; gas: string }>("SELECT kind, home_logins::text, gas FROM usage.org_report('org_home', (now() AT TIME ZONE 'UTC')::date - 1, (now() AT TIME ZONE 'UTC')::date, 'month')");
    expect(rows).toEqual([{ kind: 'home', home_logins: '1', gas: '38500000000000' }]);
  });

  it('a Home derive whose transaction is another key’s, at another nonce or to another receiver is never billed', async () => {
    await clearQueue();
    const wrongKey = await insertEvent(db, { org: 'org_hk', endpoint: 'home_login', at: NOW - 30_000, relayed: true, pk: PK_HOME, nonce: 8_100_001n });
    const wrongNonce = await insertEvent(db, { org: 'org_hn', endpoint: 'home_login', at: NOW - 29_000, relayed: true, pk: PK_HOME, nonce: 8_100_002n });
    const wrongReceiver = await insertEvent(db, { org: 'org_hr', endpoint: 'home_login', at: NOW - 28_000, relayed: true, pk: PK_HOME, nonce: 8_100_003n });
    const near = new FakeNear();
    near.finalTx(wrongKey.tx!, { pk: PK_HOME, publicKey: PK_A, nonce: 8_100_001n });
    near.finalTx(wrongNonce.tx!, { pk: PK_HOME, nonce: 8_100_777n });
    near.finalTx(wrongReceiver.tx!, { pk: PK_HOME, nonce: 8_100_003n, receiverId: 'other.testnet' });
    expect(await run(near)).toMatchObject({ read: 3, final: 0, refused: 3 });
    for (const e of [wrongKey, wrongNonce, wrongReceiver]) expect(await settlementOf(e.rid)).toEqual({ result: 'unsettled', gas_burnt: null, tokens_burnt: null, reason: 'signer_mismatch' });
    const alerts = await store.settlementAlerts({ unalertedOnly: true, limit: 100 });
    expect(alerts.find((a) => a.requestId === wrongKey.rid)!.detail).toEqual({ expected: { publicKey: PK_HOME, nonce: '8100001' }, chain: { publicKey: PK_A } });
    expect(alerts.find((a) => a.requestId === wrongReceiver.rid)!.detail).toEqual({ expected: { publicKey: PK_HOME, nonce: '8100003' }, chain: { receiverId: 'other.testnet' } });
    const [r] = await db.query<{ gas: string; unsettled: string }>("SELECT gas, unsettled::text FROM usage.org_report('org_hk', (now() AT TIME ZONE 'UTC')::date - 1, (now() AT TIME ZONE 'UTC')::date, 'month')");
    expect(r).toEqual({ gas: '0', unsettled: '1' });
  });

  it('a Home derive must be signed by a Home pool key, and no other event by one: refused without a chain read', async () => {
    await clearQueue();
    // A Home event carrying a session-pool key's real transaction, and a login carrying the Home key's.
    const homeOnSession = await insertEvent(db, { org: 'org_x1', endpoint: 'home_login', at: NOW - 20_000, relayed: true, pk: PK_A, nonce: 8_200_001n });
    const loginOnHome = await insertEvent(db, { org: 'org_x2', endpoint: 'login', at: NOW - 19_000, relayed: true, pk: PK_HOME, nonce: 8_200_002n });
    const near = new FakeNear();
    near.finalTx(homeOnSession.tx!, { pk: PK_A, nonce: 8_200_001n });
    near.finalTx(loginOnHome.tx!, { pk: PK_HOME, nonce: 8_200_002n });
    expect(await run(near)).toMatchObject({ read: 0, final: 0, refused: 2 });
    expect(near.calls).toEqual([]);
    expect((await settlementOf(homeOnSession.rid))!.reason).toBe('signer_mismatch');
    expect((await settlementOf(loginOnHome.rid))!.reason).toBe('signer_mismatch');
    const alerts = await store.settlementAlerts({ unalertedOnly: true, limit: 100 });
    expect(alerts.find((a) => a.requestId === homeOnSession.rid)!.detail).toEqual({ wrongPool: 'session', endpoint: 'home_login', publicKey: PK_A, nonce: '8200001' });
    expect(alerts.find((a) => a.requestId === loginOnHome.rid)!.detail).toEqual({ wrongPool: 'home', endpoint: 'login', publicKey: PK_HOME, nonce: '8200002' });
    // While the Home keys aren't in the pool list (an API from before they were added), a Home event is refused, never billed.
    const early = await insertEvent(db, { org: 'org_x3', endpoint: 'home_login', at: NOW - 18_000, relayed: true, pk: PK_HOME, nonce: 8_200_003n });
    expect(await run(near, { keys: new Map<string, RelayerPool>([[PK_A, 'session'], [PK_B, 'owner']]) })).toMatchObject({ read: 0, refused: 1 });
    expect((await settlementOf(early.rid))!.reason).toBe('signer_mismatch');

    expect(poolMatches('home_login', 'home')).toBe(true);
    expect(poolMatches('home_login', 'session')).toBe(false);
    expect(poolMatches('home_login', 'owner')).toBe(false);
    for (const endpoint of ['login', 'session', 'derive', 'revoke', 'owner_action', 'link']) {
      expect(poolMatches(endpoint, 'home')).toBe(false);
      expect(poolMatches(endpoint, 'session')).toBe(true);
      expect(poolMatches(endpoint, 'owner')).toBe(true);
    }
  });

  it('emails the settlement alerts to the security alias once, then marks them', async () => {
    const email = new FakeEmail();
    const before = (await store.settlementAlerts({ unalertedOnly: true, limit: 100 })).length;
    expect(before).toBeGreaterThan(0);
    const s = await runAlerts(env, store, email, new Budget(), NOW);
    expect(s.settlement).toBe(Math.min(before, 20));
    expect(email.sent.map((m) => m.to)).toEqual([ALIAS]);
    expect(email.sent[0]!.subject).toMatch(/Settlement refused/u);
    expect(email.sent[0]!.text).toContain('another relayed event in the ledger carries the same transaction');
    // A failed send keeps them for the next run.
    const again = await runAlerts(env, store, email, new Budget(), NOW);
    expect(again.settlement).toBe(Math.max(0, before - 20));
  });
});

describe('the tx answer at FINAL', () => {
  const answer = (over: Record<string, unknown> = {}) => ({
    result: {
      final_execution_status: 'FINAL',
      status: { SuccessValue: '' },
      transaction: { hash: 'h', signer_id: RELAYER, public_key: PK_A, nonce: 193000000000001, receiver_id: SIGNER },
      transaction_outcome: { outcome: { gas_burnt: 2_428_158_088_232, tokens_burnt: '242815808823200000000' } },
      receipts_outcome: [{ outcome: { gas_burnt: 21_872_349_118_391, tokens_burnt: '2187234911839100000000' } }, { outcome: { gas_burnt: 0, tokens_burnt: '0' } }],
      ...over,
    },
  });
  it('parses signer, key, nonce, receiver and the BigInt sums over every receipt', () => {
    expect(parseTxResult(answer())).toEqual({ kind: 'final', tx: { hash: 'h', signerId: RELAYER, publicKey: PK_A, nonce: 193000000000001n, receiverId: SIGNER, gas: { gasBurnt: 24_300_507_206_623n, tokensBurnt: 2_430_050_720_662_300_000_000n } } });
  });
  it('is not final unless the RPC says FINAL; errors and malformed answers are not final; bad amounts give no gas', () => {
    expect(parseTxResult(answer({ final_execution_status: 'EXECUTED_OPTIMISTIC' }))).toEqual({ kind: 'not_final', why: 'pending' });
    expect(parseTxResult({ error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_TRANSACTION' } } })).toEqual({ kind: 'not_final', why: 'unknown_transaction' });
    expect(parseTxResult({ result: { final_execution_status: 'FINAL', transaction: { hash: 'h' } } })).toEqual({ kind: 'not_final', why: 'malformed' });
    expect(parseTxResult(answer({ transaction: { hash: 'h', signer_id: RELAYER, public_key: PK_A, nonce: 2 ** 60, receiver_id: SIGNER } }))).toEqual({ kind: 'not_final', why: 'malformed' });
    const bad = parseTxResult(answer({ receipts_outcome: [{ outcome: { gas_burnt: -1, tokens_burnt: '0' } }] }));
    expect(bad.kind === 'final' && bad.tx.gas).toBeNull();
  });
});
