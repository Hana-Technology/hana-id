import { KeyPair, type KeyPairString } from '@near-js/crypto';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RELAYABLE_METHODS, type RelayerKey, type RelayResult, parseRelayerKeys } from '../src/relayer-key.ts';
import { pickKeyIndex, relay, relayerKeyName } from '../src/relayer-pool.ts';
import { clearViewCaches } from '../src/views.ts';
import { appHeaders, call, chain, seedApp, seedPlan, sessionBody, uid } from './helpers.ts';
import { NearMock } from './near-mock.ts';

afterEach(() => vi.restoreAllMocks());

const keys = parseRelayerKeys(env.RELAYER_KEYS);
const publicKeyOf = (i: number): string => KeyPair.fromString(keys[i] as KeyPairString).getPublicKey().toString();

/** A DO for a fresh name, so each test starts cold (nonce read from RPC). */
function freshKeyStub(): DurableObjectStub<RelayerKey> {
  return env.RELAYER_KEY.get(env.RELAYER_KEY.idFromName(`test-${uid()}`));
}

const revokeCall = (i: number) => ({ method: 'revoke_session', args: { session_public_key: Array(32).fill(i % 256), counter: 1, signature: Array(64).fill(1) } });

function expectConsecutive(nonces: bigint[], from: bigint): void {
  const sorted = [...nonces].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  expect(new Set(sorted.map(String)).size).toBe(nonces.length);
  expect(sorted).toEqual(sorted.map((_, i) => from + BigInt(i)));
}

describe('RelayerKey Durable Object', () => {
  it('N parallel relays on one key get N distinct consecutive nonces, dispatched in order', async () => {
    const near = new NearMock();
    near.defaultNonce = 500n;
    // Slow, jittery broadcasts: outcomes resolve out of order, nonces must not.
    near.onSendTx = () => new Promise((r) => setTimeout(() => r(undefined), Math.random() * 30));
    near.install();
    const stub = freshKeyStub();
    const N = 25;
    const results = (await Promise.all(Array.from({ length: N }, (_, i) => stub.relay(0, revokeCall(i), `r${i}`)))) as RelayResult[];
    expect(results.every((r) => r.ok)).toBe(true);
    expect(near.sent).toHaveLength(N);
    expectConsecutive(near.sent.map((t) => t.nonce), 501n);
    expect(new Set(results.map((r) => (r.ok ? r.nearTx : ''))).size).toBe(N);
    // One access-key read on cold start, not one per request.
    expect(near.rpcMethods.filter((m) => m === 'query')).toHaveLength(1);
    expect(near.sent.every((t) => t.publicKey === publicKeyOf(0) && t.receiverId === env.SIGNER_ACCOUNT && t.signerId === env.RELAYER_ACCOUNT)).toBe(true);
  });

  it('waits for outcomes outside the critical section (a slow tx does not block the next dispatch)', async () => {
    const near = new NearMock();
    near.install();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let dispatched = 0;
    near.onSendTx = async (tx) => {
      dispatched++;
      if (tx.args.counter === 1 && (tx.args.session_public_key as number[])[0] === 0) await gate;
      return undefined;
    };
    const stub = freshKeyStub();
    const slow = stub.relay(0, revokeCall(0), 'slow');
    // While the first broadcast is still pending, more requests go out.
    const others = await Promise.all([1, 2, 3].map((i) => stub.relay(0, revokeCall(i), `o${i}`)));
    expect(others.every((r) => (r as RelayResult).ok)).toBe(true);
    expect(dispatched).toBe(4);
    release();
    expect(((await slow) as RelayResult).ok).toBe(true);
  });

  it('recovers from InvalidNonce: re-reads the nonce and retries once', async () => {
    const near = new NearMock();
    near.defaultNonce = 10n;
    near.install();
    const stub = freshKeyStub();
    expect(((await stub.relay(0, revokeCall(1))) as RelayResult).ok).toBe(true);
    expect(near.sent.at(-1)!.nonce).toBe(11n);
    // Someone else used the key: the chain is now at 200.
    near.akNonce.set(publicKeyOf(0), 200n);
    const res = (await stub.relay(0, revokeCall(2))) as RelayResult;
    expect(res.ok).toBe(true);
    expect(near.sent.at(-1)!.nonce).toBe(201n);
    // Later requests continue from the recovered nonce.
    expect(((await stub.relay(0, revokeCall(3))) as RelayResult).ok).toBe(true);
    expect(near.sent.at(-1)!.nonce).toBe(202n);
  });

  it('InvalidNonce recovery under concurrency keeps nonces unique', async () => {
    const near = new NearMock();
    near.defaultNonce = 10n;
    near.install();
    const stub = freshKeyStub();
    expect(((await stub.relay(0, revokeCall(1))) as RelayResult).ok).toBe(true);
    near.akNonce.set(publicKeyOf(0), 300n);
    const results = (await Promise.all(Array.from({ length: 8 }, (_, i) => stub.relay(0, revokeCall(i + 10))))) as RelayResult[];
    expect(results.every((r) => r.ok)).toBe(true);
    const nonces = near.sent.slice(1).map((t) => t.nonce);
    expect(new Set(nonces.map(String)).size).toBe(8);
    expect(nonces.every((n) => n > 300n)).toBe(true);
  });

  it('gives up after a second InvalidNonce', async () => {
    const near = new NearMock();
    near.install();
    near.onSendTx = (tx) => ({ error: { name: 'HANDLER_ERROR', cause: { name: 'INVALID_TRANSACTION' }, data: { TxExecutionError: { InvalidTxError: { InvalidNonce: { ak_nonce: 1, tx_nonce: Number(tx.nonce) } } } } } });
    const res = (await freshKeyStub().relay(0, revokeCall(1))) as RelayResult;
    expect(res).toMatchObject({ ok: false, status: 503, code: 'relayer_busy' });
  });

  it('cold start takes the larger of the stored and on-chain nonce', async () => {
    const near = new NearMock();
    near.defaultNonce = 40n;
    near.install();
    const stub = freshKeyStub();
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.kv.put('publicKey', publicKeyOf(0));
      state.storage.kv.put('nonce', '75');
    });
    expect(((await stub.relay(0, revokeCall(1))) as RelayResult).ok).toBe(true);
    expect(near.sent.at(-1)!.nonce).toBe(76n);
    const stored = await runInDurableObject(stub, (_i, state) => state.storage.kv.get<string>('nonce'));
    expect(stored).toBe('76');
  });

  it('ignores a stored nonce that belonged to a different key', async () => {
    const near = new NearMock();
    near.defaultNonce = 40n;
    near.install();
    const stub = freshKeyStub();
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.kv.put('publicKey', 'ed25519:someoneelse');
      state.storage.kv.put('nonce', '9999');
    });
    await stub.relay(0, revokeCall(1));
    expect(near.sent.at(-1)!.nonce).toBe(41n);
  });

  it('polls `tx` when send_tx times out', async () => {
    const near = new NearMock();
    near.sendTxTimesOut = true;
    near.contract.derive_key = () => ({ big_y: 'y', big_c: 'c' });
    near.install();
    const res = (await freshKeyStub().relay(0, { method: 'derive_key', args: {} })) as RelayResult;
    expect(res).toMatchObject({ ok: true, result: { big_y: 'y', big_c: 'c' } });
    expect(near.rpcMethods).toContain('tx');
  });

  it('reports NEAR rejections (not nonce related) as 502', async () => {
    const near = new NearMock();
    near.install();
    near.onSendTx = () => ({ error: { name: 'HANDLER_ERROR', cause: { name: 'INVALID_TRANSACTION' }, data: { TxExecutionError: { InvalidTxError: { NotEnoughBalance: {} } } } } });
    const res = (await freshKeyStub().relay(0, revokeCall(1))) as RelayResult;
    expect(res).toMatchObject({ ok: false, status: 502, code: 'near_rejected' });
  });

  it('a send_tx that fails without a definite rejection is polled, not reported as rejected', async () => {
    // The tx reached the network, then the proxy answered a non-JSON 502 / the connection dropped.
    for (const failure of [502, 520, 'network'] as const) {
      const near = new NearMock();
      near.contract.create_session = () => ({ path: 's1#google#1#0', scope_id: 's1', expires_at_ms: 1, max_uses: 1, used: 0 });
      near.sendTxTransportError = failure;
      near.install();
      const res = (await freshKeyStub().relay(0, { method: 'create_session', args: {} })) as RelayResult;
      expect(res, String(failure)).toMatchObject({ ok: true, result: { scope_id: 's1' } });
      expect(near.rpcMethods).toContain('tx');
      vi.restoreAllMocks();
    }
  });

  it('keeps polling through transient RPC errors until the outcome arrives', async () => {
    const near = new NearMock();
    near.sendTxTimesOut = true;
    near.txPollFailures = 2;
    near.contract.derive_key = () => ({ big_y: 'y', big_c: 'c' });
    near.install();
    const res = (await freshKeyStub().relay(0, { method: 'derive_key', args: {} })) as RelayResult;
    expect(res).toMatchObject({ ok: true, result: { big_y: 'y', big_c: 'c' } });
    expect(near.rpcMethods.filter((m) => m === 'tx')).toHaveLength(3);
  });

  it('resends a tx that was dropped because a later nonce of the key landed first', async () => {
    const near = new NearMock();
    near.defaultNonce = 50n;
    near.install();
    let first = true;
    near.onSendTx = (tx) => {
      if (!first) return undefined;
      first = false;
      // A higher nonce of this key was included first: this tx is gone from the pool (never executed).
      near.akNonce.set(tx.publicKey, tx.nonce + 1n);
      return { error: { name: 'HANDLER_ERROR', cause: { name: 'TIMEOUT_ERROR' }, message: 'Timeout', data: 'TIMEOUT' } };
    };
    const res = (await freshKeyStub().relay(0, revokeCall(1))) as RelayResult;
    expect(res.ok).toBe(true);
    // Executed exactly once, with a nonce above the one that superseded the dropped tx.
    expect(near.sent).toHaveLength(1);
    expect(near.sent[0]!.nonce).toBe(53n);
  });

  it('only relays allowlisted methods', async () => {
    const near = new NearMock();
    near.install();
    for (const method of ['set_issuer_key', 'admin_register_scope', 'set_owner', 'register_scope', 'prune_sessions', 'sign']) {
      const res = (await freshKeyStub().relay(0, { method, args: {} })) as RelayResult;
      expect(res).toMatchObject({ ok: false, code: 'method_not_allowed' });
    }
    expect(near.sent).toHaveLength(0);
    expect([...RELAYABLE_METHODS].sort()).toEqual(['cancel_change', 'create_session', 'derive_key', 'execute_change', 'propose_change', 'remove_client', 'revoke_session']);
  });

  it('fails cleanly for a key index outside RELAYER_KEYS', async () => {
    new NearMock().install();
    const res = (await freshKeyStub().relay(99, revokeCall(1))) as RelayResult;
    expect(res).toMatchObject({ ok: false, status: 503 });
  });
});

describe('relayer pool', () => {
  it('answers 503 when no relayer keys are configured', async () => {
    const near = new NearMock();
    near.install();
    for (const RELAYER_KEYS of ['[]', '', 'not json', '[1]']) {
      expect(await relay({ ...env, RELAYER_KEYS }, revokeCall(1), 'r')).toMatchObject({ ok: false, status: 503, code: 'relayer_unconfigured' });
    }
    expect(near.rpcMethods).toHaveLength(0);
  });

  it('round-robins across keys', () => {
    const picks = Array.from({ length: 6 }, () => pickKeyIndex(3));
    expect(new Set(picks).size).toBe(3);
    for (let i = 1; i < picks.length; i++) expect(picks[i]).toBe((picks[i - 1]! + 1) % 3);
    expect(relayerKeyName(1)).toBe('relayer-key-1');
  });

  it('N parallel HTTP requests: every key’s nonces are distinct and consecutive', async () => {
    clearViewCaches();
    const plan = `p${uid()}`;
    await seedPlan(plan, 1000, 1000, 1000);
    const app = await seedApp({ plan });
    const aud = `${uid()}.apps.googleusercontent.com`;
    const near = chain({ [aud]: app.scope });
    near.onSendTx = () => new Promise((r) => setTimeout(() => r(undefined), Math.random() * 20));
    const before = new Map(keys.map((_, i) => [publicKeyOf(i), near.nonceOf(publicKeyOf(i))]));
    const N = 20;
    const responses = await Promise.all(Array.from({ length: N }, () => call('/v1/sessions', { headers: appHeaders(app), body: sessionBody(aud) })));
    expect(responses.map((r) => r.status)).toEqual(Array(N).fill(200));
    expect(near.sent).toHaveLength(N);
    const byKey = new Map<string, bigint[]>();
    for (const t of near.sent) byKey.set(t.publicKey, [...(byKey.get(t.publicKey) ?? []), t.nonce]);
    expect(byKey.size).toBe(keys.length);
    for (const [pk, nonces] of byKey) {
      // The pool DOs may have relayed in earlier tests; within this burst each key's nonces are consecutive.
      const min = nonces.reduce((a, b) => (b < a ? b : a));
      expect(min).toBeGreaterThan(before.get(pk)!);
      expectConsecutive(nonces, min);
    }
  });
});
