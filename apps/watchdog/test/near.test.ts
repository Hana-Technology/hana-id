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
  const NOT_FOUND = { result: { error: 'wasm execution failed with error: MethodResolveError(MethodNotFound)' } };
  const views: Record<string, unknown> = {
    get_key_changes: [{ id: 1, provider: 'google', kid: 'k2', op: 'Add', n: 'nn', e: 'AQAB', by: SIGNER, proposed_at_ms: 1, executable_at_ms: 2 }],
    get_config: { paused: false },
    get_governance: { watchdogs: [] },
  };
  const GOOGLE_ISSUER = { provider: 'google', iss_values: [], kids: ['k1'] };
  const EMAIL_ISSUER = { provider: 'email', iss_values: ['https://api.test/v1/email'], kids: ['tp1'] };
  const POLICY = { provider: 'email', signers: [{ id: 'hana', kids: ['tp1'] }], required: 1, overlap_until_ms: null };
  const WINDOW = { window_start_ms: 3_600_000, total: 3, total_cap_reached: false, capped_scopes: [] };
  const STATS = { window_ms: 3_600_000, limits: { per_scope_per_hour: 50, total_per_hour: 500 }, pending_limits: null, links_total: 9, current: WINDOW, previous: null };
  /**
   * hana-signer's views by provider. `v3: false` is today's sandbox-dev contract: no get_self_issued, and
   * get_issuer("email") answers null (no such issuer), as v2's provider-generic view does.
   */
  const contract = (o: { v3?: boolean; email?: boolean; over?: Record<string, unknown> } = {}): Handler => (_u, method, p) => {
    if (method === 'status') return { result: { chain_id: 'testnet' } };
    const name = p.method_name as string;
    const provider = (viewArgs(p) as { provider?: string }).provider;
    if (o.over && name in o.over) return o.over[name] instanceof Error ? o.over[name] : viewResult(o.over[name]);
    if (name === 'get_issuer') return viewResult(provider === 'google' ? GOOGLE_ISSUER : o.email ? EMAIL_ISSUER : null);
    if (name === 'get_issuer_keys') return viewResult(provider === 'google' ? [{ kid: 'k1', n: 'n1', e: 'AQAB' }] : o.email ? [{ kid: 'tp1', n: 'n2', e: 'AQAB' }] : null);
    if (name === 'get_self_issued') return o.v3 === false ? NOT_FOUND : viewResult(o.email ? POLICY : null);
    if (name === 'get_link_stats') return o.v3 === false ? NOT_FOUND : viewResult(STATS);
    return viewResult(views[name]);
  };

  it('reads every view the run needs: Google, the email issuer and its signer policy', async () => {
    const calls = stubRpc(contract({ email: true }));
    const chain = new NearChain(new Rpc([PRIMARY]), SIGNER);
    expect(await chain.chainId()).toBe('testnet');
    const s = await chain.snapshot();
    expect(s.issuer).toEqual(GOOGLE_ISSUER);
    expect(s.issuerKeys).toEqual([{ kid: 'k1', n: 'n1', e: 'AQAB' }]);
    expect(s.keyChanges[0]?.kid).toBe('k2');
    expect(s.email).toEqual({ issuer: EMAIL_ISSUER, issuerKeys: [{ kid: 'tp1', n: 'n2', e: 'AQAB' }], selfIssued: POLICY, hasSelfIssuedView: true });
    const issuerCalls = calls.filter((c) => ['get_issuer', 'get_issuer_keys', 'get_self_issued'].includes(c.params.method_name as string));
    expect(issuerCalls.map((c) => [c.params.method_name, viewArgs(c.params), c.params.finality])).toEqual([
      ['get_issuer', { provider: 'google' }, 'final'],
      ['get_issuer', { provider: 'email' }, 'final'],
      ['get_issuer_keys', { provider: 'google' }, 'final'],
      ['get_self_issued', { provider: 'email' }, 'final'],
      ['get_issuer_keys', { provider: 'email' }, 'final'],
    ]);
    expect(s.owner).toBeNull(); // this get_config names no owner
    expect(s.linkStats).toEqual(STATS);
    expect(calls.find((c) => c.params.method_name === 'get_link_stats')?.params).toMatchObject({ finality: 'final' });
  });

  it('isolates a get_link_stats of another shape, or one that fails: the rest of the snapshot is read (D200)', async () => {
    for (const bad of [{ ...STATS, limits: { per_scope_per_hour: -1, total_per_hour: 500 } }, { ...STATS, current: { ...WINDOW, capped_scopes: 's1' } }, { ...STATS, previous: 'x' }, { ...STATS, pending_limits: { per_scope_per_hour: 1, total_per_hour: 2 } }, 'nope']) {
      vi.restoreAllMocks();
      stubRpc(contract({ email: true, over: { get_link_stats: bad } }));
      const s = await new NearChain(new Rpc([PRIMARY]), SIGNER).snapshot();
      expect(s, JSON.stringify(bad)).toMatchObject({ linkStats: null, linkStatsProblem: 'malformed', issuer: GOOGLE_ISSUER, email: { issuer: EMAIL_ISSUER } });
    }
    vi.restoreAllMocks();
    stubRpc(contract({ email: true, over: { get_link_stats: new TypeError('down') } }));
    expect(await new NearChain(new Rpc([PRIMARY]), SIGNER).snapshot()).toMatchObject({ linkStats: null, linkStatsProblem: 'read_failed', keyChanges: [{ kid: 'k2' }] });
    vi.restoreAllMocks();
    stubRpc(contract({ v3: false }));
    expect(await new NearChain(new Rpc([PRIMARY]), SIGNER).snapshot()).toMatchObject({ linkStats: null, linkStatsProblem: null });
  });

  it('reads a v2 contract (no get_self_issued, no email issuer) as no email issuer, not as an error', async () => {
    const calls = stubRpc(contract({ v3: false }));
    const s = await new NearChain(new Rpc([PRIMARY]), SIGNER).snapshot();
    expect(s.email).toEqual({ issuer: null, issuerKeys: null, selfIssued: null, hasSelfIssuedView: false });
    expect(s.linkStats).toBeNull();
    expect(s.config.unrecorded_wallets).toBeUndefined();
    // No email issuer: get_issuer_keys("email") isn't read.
    expect(calls.filter((c) => c.params.method_name === 'get_issuer_keys').map((c) => viewArgs(c.params))).toEqual([{ provider: 'google' }]);
  });

  it('reads a v3 contract before the email issuer is set up as no email issuer', async () => {
    stubRpc(contract({ v3: true }));
    expect((await new NearChain(new Rpc([PRIMARY]), SIGNER).snapshot()).email).toEqual({ issuer: null, issuerKeys: null, selfIssued: null, hasSelfIssuedView: true });
  });

  it('fails the read when an issuer view answers something unexpected', async () => {
    for (const over of [{ get_self_issued: { provider: 'email', signers: 'hana', required: 1 } }, { get_self_issued: { provider: 'email', signers: [], required: '1' } }, { get_issuer: { provider: 'email' } }, { get_issuer_keys: [{ kid: 1 }] }]) {
      vi.restoreAllMocks();
      stubRpc(contract({ email: true, over }));
      await expect(new NearChain(new Rpc([PRIMARY]), SIGNER).snapshot(), JSON.stringify(over)).rejects.toBeInstanceOf(RpcError);
    }
    vi.restoreAllMocks();
    stubRpc(contract({ email: true, over: { get_self_issued: { error: 'x' } } }));
    await expect(new NearChain(new Rpc([PRIMARY]), SIGNER).snapshot()).rejects.toBeInstanceOf(RpcError);
  });

  it("reads the owner account's code hash and, for a DAO, its get_policy", async () => {
    const DAO = 'council.sputnikv2.testnet';
    const policy = { roles: [{ name: 'council', kind: { Group: ['a', 'b', 'c'] } }], default_vote_policy: { threshold: [1, 2] } };
    const handler = (codeHash: string, daoPolicy: unknown): Handler => (_u, method, p) => {
      if (p.request_type === 'view_account') return { result: { amount: '1', code_hash: codeHash } };
      if (p.method_name === 'get_policy') return daoPolicy === undefined ? { result: { error: 'wasm execution failed with error: MethodResolveError(MethodNotFound)' } } : viewResult(daoPolicy);
      return contract({ over: { get_config: { paused: false, owner: DAO } } })(_u, method, p);
    };
    const calls = stubRpc(handler('DAOcode1111111111111111111111111111111111111', policy));
    const s = await new NearChain(new Rpc([PRIMARY]), SIGNER).snapshot();
    expect(s.owner).toEqual({ account_id: DAO, code_hash: 'DAOcode1111111111111111111111111111111111111', policy });
    expect(calls.find((c) => c.params.request_type === 'view_account')?.params).toMatchObject({ account_id: DAO, finality: 'final' });
    expect(calls.find((c) => c.params.method_name === 'get_policy')?.params).toMatchObject({ account_id: DAO, finality: 'final' });
    // A plain account (no contract): no get_policy call. A contract without get_policy: policy null.
    vi.restoreAllMocks();
    const plain = stubRpc(handler('11111111111111111111111111111111', policy));
    expect((await new NearChain(new Rpc([PRIMARY]), SIGNER).snapshot()).owner).toEqual({ account_id: DAO, code_hash: '11111111111111111111111111111111', policy: null });
    expect(plain.some((c) => c.params.method_name === 'get_policy')).toBe(false);
    vi.restoreAllMocks();
    stubRpc(handler('Other11111111111111111111111111111111111111', undefined));
    expect((await new NearChain(new Rpc([PRIMARY]), SIGNER).snapshot()).owner?.policy).toBeNull();
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
    stubRpc((u, m, p) => (p.method_name === 'get_issuer_keys' ? { result: { error: 'MethodResolveError(MethodNotFound)' } } : contract({ v3: false })(u, m, p)));
    expect((await new NearChain(new Rpc([PRIMARY]), SIGNER).snapshot()).issuerKeys).toBeNull();
  });

  it('fails the read on any other error', async () => {
    stubRpc((u, m, p) => (p.method_name === 'get_governance' ? { error: { name: 'HANDLER_ERROR' } } : contract()(u, m, p)));
    await expect(new NearChain(new Rpc([PRIMARY]), SIGNER).snapshot()).rejects.toBeInstanceOf(RpcError);
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
