// The watchdog's own RPC client and transaction sender, against a stubbed JSON-RPC (no real node).
import { KeyPair } from '@near-js/crypto';
import { SignedTransaction } from '@near-js/transactions';
import { baseEncode } from '@near-js/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NearChain, NearWriter, Rpc, RpcError, WATCHDOG_GAS, watchdogPublicKey } from '../src/near.ts';

const PRIMARY = 'https://rpc.test.invalid';
const FALLBACK = 'https://rpc-fallback.test.invalid';
const SIGNER = 'signer.test.near';
const WATCHDOG = 'watchdog.test.near';
const BLOCK = baseEncode(new Uint8Array(32).fill(3));

type Handler = (url: string, method: string, params: Record<string, unknown>) => unknown;

function stubRpc(handler: Handler): { url: string; method: string; params: Record<string, unknown> }[] {
  const calls: { url: string; method: string; params: Record<string, unknown> }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as { method: string; params: Record<string, unknown> };
    calls.push({ url, method: body.method, params: body.params });
    const out = handler(url, body.method, body.params);
    if (out instanceof Response) return out;
    if (out instanceof Error) throw out;
    return Response.json({ jsonrpc: '2.0', id: 'x', ...(out as object) });
  });
  return calls;
}

const viewResult = (value: unknown) => ({ result: { result: [...new TextEncoder().encode(JSON.stringify(value))] } });
const viewArgs = (params: Record<string, unknown>) => JSON.parse(atob(params.args_base64 as string)) as unknown;

afterEach(() => vi.restoreAllMocks());

describe('Rpc', () => {
  it('falls back to the second RPC when the first is unreachable or answers 5xx', async () => {
    const calls = stubRpc((url) => (url === PRIMARY ? new TypeError('down') : { result: { chain_id: 'testnet' } }));
    expect(await new Rpc([PRIMARY, FALLBACK]).call('status', [])).toEqual({ chain_id: 'testnet' });
    expect(calls.map((c) => c.url)).toEqual([PRIMARY, FALLBACK]);
    vi.restoreAllMocks();
    stubRpc((url) => (url === PRIMARY ? new Response('bad gateway', { status: 502 }) : { result: { chain_id: 'testnet' } }));
    expect(await new Rpc([PRIMARY, FALLBACK]).call('status', [])).toEqual({ chain_id: 'testnet' });
  });

  it("doesn't fall back on a node's own error answer", async () => {
    const calls = stubRpc(() => ({ error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT' } } }));
    await expect(new Rpc([PRIMARY, FALLBACK]).call('query', {})).rejects.toBeInstanceOf(RpcError);
    expect(calls).toHaveLength(1);
  });

  it('reads views at final finality and decodes their JSON; a contract error is final', async () => {
    const calls = stubRpc((_u, _m, p) => (p.method_name === 'get_config' ? viewResult({ paused: false }) : { result: { error: 'wasm execution failed with error: MethodResolveError(MethodNotFound)' } }));
    const rpc = new Rpc([PRIMARY, FALLBACK]);
    expect(await rpc.view(SIGNER, 'get_config', {})).toEqual({ paused: false });
    expect(calls[0]?.params).toMatchObject({ request_type: 'call_function', finality: 'final', account_id: SIGNER, method_name: 'get_config' });
    await expect(rpc.view(SIGNER, 'nope', {})).rejects.toThrow(/MethodNotFound/u);
    expect(calls.filter((c) => c.params.method_name === 'nope')).toHaveLength(1);
  });
});

describe('NearChain', () => {
  const views: Record<string, unknown> = {
    get_key_changes: [{ id: 1, provider: 'google', kid: 'k2', op: 'Add', n: 'nn', e: 'AQAB', by: SIGNER, proposed_at_ms: 1, executable_at_ms: 2 }],
    get_issuer: { provider: 'google', iss_values: [], kids: ['k1'] },
    get_issuer_keys: [{ kid: 'k1', n: 'n1', e: 'AQAB' }],
    get_config: { paused: false },
    get_governance: { watchdogs: [] },
  };

  it('reads every view the run needs, for the watched provider', async () => {
    const calls = stubRpc((_u, method, p) => (method === 'status' ? { result: { chain_id: 'testnet' } } : viewResult(views[p.method_name as string])));
    const chain = new NearChain(new Rpc([PRIMARY]), SIGNER);
    expect(await chain.chainId()).toBe('testnet');
    const s = await chain.snapshot('google');
    expect(s.issuerKeys).toEqual([{ kid: 'k1', n: 'n1', e: 'AQAB' }]);
    expect(s.keyChanges[0]?.kid).toBe('k2');
    const issuerCalls = calls.filter((c) => ['get_issuer', 'get_issuer_keys'].includes(c.params.method_name as string));
    expect(issuerCalls.map((c) => viewArgs(c.params))).toEqual([{ provider: 'google' }, { provider: 'google' }]);
    expect(s.owner).toBeNull(); // this get_config names no owner
  });

  it("reads the owner account's code hash and, for a DAO, its get_policy", async () => {
    const DAO = 'council.sputnikv2.testnet';
    const policy = { roles: [{ name: 'council', kind: { Group: ['a', 'b', 'c'] } }], default_vote_policy: { threshold: [1, 2] } };
    const handler = (codeHash: string, daoPolicy: unknown): Handler => (_u, method, p) => {
      if (p.request_type === 'view_account') return { result: { amount: '1', code_hash: codeHash } };
      if (p.method_name === 'get_policy') return daoPolicy === undefined ? { result: { error: 'wasm execution failed with error: MethodResolveError(MethodNotFound)' } } : viewResult(daoPolicy);
      return viewResult({ ...views, get_config: { paused: false, owner: DAO } }[p.method_name as string]);
    };
    const calls = stubRpc(handler('DAOcode1111111111111111111111111111111111111', policy));
    const s = await new NearChain(new Rpc([PRIMARY]), SIGNER).snapshot('google');
    expect(s.owner).toEqual({ account_id: DAO, code_hash: 'DAOcode1111111111111111111111111111111111111', policy });
    expect(calls.find((c) => c.params.request_type === 'view_account')?.params).toMatchObject({ account_id: DAO, finality: 'final' });
    expect(calls.find((c) => c.params.method_name === 'get_policy')?.params).toMatchObject({ account_id: DAO, finality: 'final' });
    // A plain account (no contract): no get_policy call. A contract without get_policy: policy null.
    vi.restoreAllMocks();
    const plain = stubRpc(handler('11111111111111111111111111111111', policy));
    expect((await new NearChain(new Rpc([PRIMARY]), SIGNER).snapshot('google')).owner).toEqual({ account_id: DAO, code_hash: '11111111111111111111111111111111', policy: null });
    expect(plain.some((c) => c.params.method_name === 'get_policy')).toBe(false);
    vi.restoreAllMocks();
    stubRpc(handler('Other11111111111111111111111111111111111111', undefined));
    expect((await new NearChain(new Rpc([PRIMARY]), SIGNER).snapshot('google')).owner?.policy).toBeNull();
  });

  it("reads the relayer's balance and access keys at final finality, read-only", async () => {
    const RELAYER = 'relayer.test.near';
    const keys = [
      { public_key: 'ed25519:full', access_key: { nonce: 1, permission: 'FullAccess' } },
      { public_key: 'ed25519:s1', access_key: { nonce: 9, permission: { FunctionCall: { allowance: '1500000000000000000000000', receiver_id: SIGNER, method_names: ['create_session', 'derive_key'] } } } },
    ];
    const calls = stubRpc((_u, _m, p) =>
      p.request_type === 'view_account' ? { result: { amount: '3000000000000000000000000', locked: '0', storage_usage: 500, code_hash: '11111111111111111111111111111111' } } : { result: { keys } },
    );
    const f = await new NearChain(new Rpc([PRIMARY]), SIGNER).relayerFunds(RELAYER);
    expect(f).toMatchObject({ account: RELAYER, exists: true, available: (3n * 10n ** 24n - 500n * 10n ** 19n).toString(), keys: [{ public_key: 'ed25519:s1', pool: 'session', allowance: '1500000000000000000000000' }] });
    expect(calls.map((c) => [c.method, c.params.request_type, c.params.finality, c.params.account_id])).toEqual([
      ['query', 'view_account', 'final', RELAYER],
      ['query', 'view_access_key_list', 'final', RELAYER],
    ]);
  });

  it('reads a relayer account that does not exist as empty; any other failure throws', async () => {
    stubRpc(() => ({ error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT' } } }));
    expect(await new NearChain(new Rpc([PRIMARY]), SIGNER).relayerFunds('gone.test.near')).toMatchObject({ exists: false, available: '0', keys: [] });
    vi.restoreAllMocks();
    stubRpc(() => new TypeError('down'));
    await expect(new NearChain(new Rpc([PRIMARY]), SIGNER).relayerFunds('relayer.test.near')).rejects.toBeInstanceOf(RpcError);
    vi.restoreAllMocks();
    stubRpc((_u, _m, p) => (p.request_type === 'view_account' ? { result: { amount: '1', storage_usage: 0 } } : { result: { nope: true } }));
    await expect(new NearChain(new Rpc([PRIMARY]), SIGNER).relayerFunds('relayer.test.near')).rejects.toThrow(/view_access_key_list/u);
  });

  it('treats a contract without get_issuer_keys as no key material', async () => {
    stubRpc((_u, _m, p) => (p.method_name === 'get_issuer_keys' ? { result: { error: 'MethodResolveError(MethodNotFound)' } } : viewResult(views[p.method_name as string])));
    expect((await new NearChain(new Rpc([PRIMARY]), SIGNER).snapshot('google')).issuerKeys).toBeNull();
  });

  it('fails the read on any other error', async () => {
    stubRpc((_u, _m, p) => (p.method_name === 'get_governance' ? { error: { name: 'HANDLER_ERROR' } } : viewResult(views[p.method_name as string])));
    await expect(new NearChain(new Rpc([PRIMARY]), SIGNER).snapshot('google')).rejects.toBeInstanceOf(RpcError);
  });
});

describe('NearWriter', () => {
  const key = KeyPair.fromRandom('ed25519');
  const secret = key.toString();
  const ok = { result: { status: { SuccessValue: '' }, receipts_outcome: [{ outcome: { status: { SuccessValue: '' } } }] } };

  function decode(params: Record<string, unknown>) {
    const signed = SignedTransaction.decode(Uint8Array.from(atob(params.signed_tx_base64 as string), (c) => c.charCodeAt(0)));
    const t = signed.transaction;
    const fc = t.actions[0]!.functionCall!;
    return { signerId: t.signerId, receiverId: t.receiverId, nonce: BigInt(t.nonce), method: fc.methodName, args: JSON.parse(new TextDecoder().decode(new Uint8Array(fc.args))) as unknown, gas: BigInt(fc.gas), deposit: BigInt(fc.deposit), actions: t.actions.length };
  }

  it('signs one function call from the watchdog account to the signer, with no deposit', async () => {
    const calls = stubRpc((_u, method) => (method === 'query' ? { result: { nonce: 41, block_hash: BLOCK } } : ok));
    const res = await new NearWriter(new Rpc([PRIMARY]), WATCHDOG, SIGNER, secret).call('cancel_issuer_key_change', { id: 7 });
    expect(res.ok).toBe(true);
    const sent = calls.find((c) => c.method === 'send_tx')!;
    expect(decode(sent.params)).toEqual({ signerId: WATCHDOG, receiverId: SIGNER, nonce: 42n, method: 'cancel_issuer_key_change', args: { id: 7 }, gas: WATCHDOG_GAS, deposit: 0n, actions: 1 });
    expect(calls[0]?.params).toMatchObject({ request_type: 'view_access_key', account_id: WATCHDOG, public_key: key.getPublicKey().toString() });
    expect(res.ok && res.txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/u);
  });

  it('reports a failed receipt (e.g. the DeleteKey promise) with the panic text', async () => {
    stubRpc((_u, method) =>
      method === 'query'
        ? { result: { nonce: 1, block_hash: BLOCK } }
        : { result: { status: { SuccessValue: '' }, receipts_outcome: [{ outcome: { status: { SuccessValue: '' } } }, { outcome: { status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: Not an updater key' } } } } } } }] } },
    );
    const res = await new NearWriter(new Rpc([PRIMARY]), WATCHDOG, SIGNER, secret).call('delete_updater_key', { public_key: 'ed25519:x' });
    expect(res).toMatchObject({ ok: false, error: 'Smart contract panicked: Not an updater key' });
  });

  it('retries once with a fresh nonce on InvalidNonce', async () => {
    let sends = 0;
    const calls = stubRpc((_u, method) => {
      if (method === 'query') return { result: { nonce: sends === 0 ? 1 : 9, block_hash: BLOCK } };
      sends++;
      return sends === 1 ? { error: { name: 'HANDLER_ERROR', data: { TxExecutionError: { InvalidTxError: { InvalidNonce: { ak_nonce: 9 } } } } } } : ok;
    });
    const res = await new NearWriter(new Rpc([PRIMARY]), WATCHDOG, SIGNER, secret).call('pause', {});
    expect(res.ok).toBe(true);
    expect(decode(calls.filter((c) => c.method === 'send_tx')[1]!.params).nonce).toBe(10n);
  });

  it('polls the outcome when send_tx times out', async () => {
    const calls = stubRpc((_u, method) => (method === 'query' ? { result: { nonce: 1, block_hash: BLOCK } } : method === 'send_tx' ? { error: { name: 'HANDLER_ERROR', cause: { name: 'TIMEOUT_ERROR' } } } : ok));
    const res = await new NearWriter(new Rpc([PRIMARY]), WATCHDOG, SIGNER, secret).call('pause', {});
    expect(res.ok).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(['query', 'send_tx', 'tx']);
  });

  it('refuses a malformed key and any method outside the watchdog permission', async () => {
    expect(() => new NearWriter(new Rpc([PRIMARY]), WATCHDOG, SIGNER, 'not-a-key')).toThrow();
    expect(watchdogPublicKey('not-a-key')).toBeNull();
    expect(watchdogPublicKey(secret)).toBe(key.getPublicKey().toString());
    const calls = stubRpc(() => ok);
    const res = await new NearWriter(new Rpc([PRIMARY]), WATCHDOG, SIGNER, secret).call('set_issuer_key' as never, {});
    expect(res.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});
