// One NEAR RPC read with the optional rpcFallback (src/near-call.ts; docs/batch-b-spec.md Q9): the fallback only when
// the primary fails, each answer whole from one endpoint, the next read back at the primary.
import { identityKeyHex } from '@hana-id/core';
import { describe, expect, it } from 'vitest';
import { nearReader } from '../src/auth/near-rpc.ts';
import { isPendingTxError, nearCall, nearEndpoints } from '../src/near-call.ts';
import { confirmPath } from '../src/path-check.ts';
import { NearView } from '../src/vault/near.ts';

const PRIMARY = 'https://rpc.primary.test';
const FALLBACK = 'https://rpc.fallback.test';
const ENDS = { rpc: PRIMARY, rpcFallback: FALLBACK };

type Behaviour = 'ok' | 'down' | 'http500' | 'hang' | 'rpcError' | 'notObject' | 'unknownTx';

/** A fetch whose endpoints behave as told; every answer names the endpoint that gave it. */
function fakeFetch(b: Record<string, Behaviour>) {
  const calls: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const how = b[url] ?? 'ok';
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    const view = (v: unknown) => json({ jsonrpc: '2.0', id: 'x', result: { result: Array.from(new TextEncoder().encode(JSON.stringify(v))) } });
    switch (how) {
      case 'down':
        throw new TypeError('Failed to fetch');
      case 'http500':
        return json({}, 500);
      case 'hang':
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
      case 'rpcError':
        return json({ jsonrpc: '2.0', id: 'x', error: { name: 'INTERNAL_ERROR', cause: { name: 'INTERNAL_ERROR' } } });
      case 'notObject':
        return json([1, 2]);
      case 'unknownTx':
        return json({ jsonrpc: '2.0', id: 'x', error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_TRANSACTION' } } });
      case 'ok': {
        const body = JSON.parse(String(init?.body)) as { method: string };
        if (body.method === 'EXPERIMENTAL_tx_status') return json({ jsonrpc: '2.0', id: 'x', result: { status: { SuccessValue: btoa(JSON.stringify({ from: url })) } } });
        return view({ from: url });
      }
    }
  }) as typeof fetch;
  return { fetchFn, calls };
}

describe('nearCall', () => {
  it('lists the fallback after the primary, once, and only when it is another URL', () => {
    expect(nearEndpoints(ENDS)).toEqual([PRIMARY, FALLBACK]);
    expect(nearEndpoints({ rpc: PRIMARY })).toEqual([PRIMARY]);
    expect(nearEndpoints({ rpc: PRIMARY, rpcFallback: PRIMARY })).toEqual([PRIMARY]);
  });

  it('a working primary answers alone', async () => {
    const f = fakeFetch({});
    const view = new NearView(ENDS, 'signer.testnet', 'relayer.testnet', f.fetchFn);
    expect(await view.view('get_scope', { scope_id: 's1' })).toEqual({ from: PRIMARY });
    expect(f.calls).toEqual([PRIMARY]);
  });

  it.each(['down', 'http500', 'rpcError', 'notObject'] as const)('a primary that fails (%s) moves the same read to the fallback', async (how) => {
    const f = fakeFetch({ [PRIMARY]: how });
    const view = new NearView(ENDS, 'signer.testnet', 'relayer.testnet', f.fetchFn);
    expect(await view.view('get_scope', { scope_id: 's1' })).toEqual({ from: FALLBACK });
    expect(f.calls).toEqual([PRIMARY, FALLBACK]);
    // The next read starts at the primary again.
    await view.view('get_scope', { scope_id: 's1' }).catch(() => undefined);
    expect(f.calls[2]).toBe(PRIMARY);
  });

  it('a primary that does not answer within the timeout moves to the fallback', async () => {
    const f = fakeFetch({ [PRIMARY]: 'hang' });
    const view = new NearView(ENDS, 'signer.testnet', 'relayer.testnet', f.fetchFn, 30);
    expect(await view.view('get_scope', { scope_id: 's1' })).toEqual({ from: FALLBACK });
  });

  it('throws when every endpoint fails, and without a fallback when the primary fails', async () => {
    const both = fakeFetch({ [PRIMARY]: 'down', [FALLBACK]: 'http500' });
    await expect(nearCall(ENDS, both.fetchFn, 'query', {}, { id: 'x', usable: () => true })).rejects.toThrow();
    const only = fakeFetch({ [PRIMARY]: 'down' });
    await expect(new NearView({ rpc: PRIMARY }, 's', 'r', only.fetchFn).getScope('s1')).rejects.toThrow();
    expect(only.calls).toEqual([PRIMARY]);
  });

  it('tx status: "not known yet" is the primary’s answer (pending, no fallback); another error asks the fallback', async () => {
    expect(isPendingTxError({ name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_TRANSACTION' } })).toBe(true);
    expect(isPendingTxError({ name: 'HANDLER_ERROR', cause: { name: 'TIMEOUT_ERROR' } })).toBe(true);
    expect(isPendingTxError({ name: 'INTERNAL_ERROR' })).toBe(false);
    const unknown = fakeFetch({ [PRIMARY]: 'unknownTx' });
    expect(await new NearView(ENDS, 's', 'r', unknown.fetchFn).txOutcome('tx1')).toEqual({ kind: 'pending' });
    expect(unknown.calls).toEqual([PRIMARY]);
    const broken = fakeFetch({ [PRIMARY]: 'rpcError' });
    expect(await new NearView(ENDS, 's', 'r', broken.fetchFn).txOutcome('tx1')).toEqual({ kind: 'success', value: { from: FALLBACK } });
  });

  it('the export window’s reader uses the same rule', async () => {
    const f = fakeFetch({ [PRIMARY]: 'down' });
    const reader = nearReader(ENDS, f.fetchFn);
    await expect(reader.getSession('signer.testnet', new Uint8Array(32))).rejects.toThrow(/malformed session/u);
    // The fallback answered (with a value that isn't a session); the primary was asked first.
    expect(f.calls).toEqual([PRIMARY, FALLBACK]);
    const plain = fakeFetch({});
    await nearReader(PRIMARY, plain.fetchFn).getSession('signer.testnet', new Uint8Array(32)).catch(() => undefined);
    expect(plain.calls).toEqual([PRIMARY]);
  });
});

describe('independent reads (D263): each provider alone, never one through the other', () => {
  it('the vault and the export window read the primary and the fallback separately; without a fallback there are none', async () => {
    const vault = fakeFetch({});
    const pair = new NearView(ENDS, 'signer.testnet', 'relayer.testnet', vault.fetchFn).independent()!;
    expect(await pair.primary('get_identity', {})).toEqual({ from: PRIMARY });
    expect(await pair.second('get_identity', {})).toEqual({ from: FALLBACK });
    expect(vault.calls).toEqual([PRIMARY, FALLBACK]);
    const auth = fakeFetch({});
    const reader = nearReader(ENDS, auth.fetchFn).independent('signer.testnet')!;
    expect(await reader.second('get_identity', {})).toEqual({ from: FALLBACK });
    expect(new NearView({ rpc: PRIMARY }, 'signer.testnet', 'relayer.testnet', vault.fetchFn).independent()).toBeNull();
    expect(nearReader(PRIMARY, auth.fetchFn).independent('signer.testnet')).toBeNull();
  });

  it('a failing provider fails its own read: the other is never asked in its place', async () => {
    for (const how of ['down', 'http500', 'rpcError'] as const) {
      const f = fakeFetch({ [FALLBACK]: how });
      const pair = new NearView(ENDS, 'signer.testnet', 'relayer.testnet', f.fetchFn).independent()!;
      await expect(pair.second('get_identity', {})).rejects.toThrow();
      expect(f.calls).toEqual([FALLBACK]);
    }
  });

  it('the login’s signal ends a hanging read at once (no waiting out the timeout after the login ended)', async () => {
    const f = fakeFetch({ [PRIMARY]: 'hang', [FALLBACK]: 'hang' });
    const login = new AbortController();
    const pair = new NearView(ENDS, 'signer.testnet', 'relayer.testnet', f.fetchFn, 60_000).independent(login.signal)!;
    const reads = [pair.primary('get_identity', {}), pair.second('get_identity', {})].map((p) => p.then(() => 'answered', () => 'ended'));
    login.abort();
    expect(await Promise.all(reads)).toEqual(['ended', 'ended']);
  });
});

describe('D263 confirmation over the real readers: the two providers are read at the same time', () => {
  const E_SUB = `e1.${'Q'.repeat(43)}`;
  const G = { provider: 'google', sub: '110248495921238986420' };
  const viaView = { key: identityKeyHex('s1', G.provider, G.sub), status: 'member' as const, opened: false, root: { provider: 'email', sub: E_SUB }, effectiveAtMs: 1, accountEpoch: 1 };

  /** Providers that answer get_identity truly for a Google member of an email wallet after `delay[url]` ms, logged. */
  function slowChain(delay: Record<string, number>) {
    const log: { url: string; start: number; end: number }[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const start = performance.now();
      await new Promise((r) => setTimeout(r, delay[url] ?? 0));
      const params = (JSON.parse(String(init?.body)) as { params: { args_base64: string } }).params;
      const a = JSON.parse(atob(params.args_base64)) as { scope_id: string; provider: string; sub: string };
      const key = identityKeyHex(a.scope_id, a.provider, a.sub);
      const v = a.provider === 'google' ? { key, status: 'member', opened: false, root: { provider: 'email', sub: E_SUB }, effective_at_ms: 1, account_epoch: 1 } : { key, status: 'own', opened: true, account_epoch: 1 };
      log.push({ url, start, end: performance.now() });
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'x', result: { result: Array.from(new TextEncoder().encode(JSON.stringify(v))) } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    return { log, fetchFn };
  }

  for (const who of ['the export window (auth/near-rpc.ts)', 'the vault (vault/near.ts)'] as const) {
    it(`${who}: the slow second provider's reads overlap the primary's, in one round`, async () => {
      const chain = slowChain({ [PRIMARY]: 40, [FALLBACK]: 200 });
      const views = who.startsWith('the export') ? nearReader(ENDS, chain.fetchFn).independent('signer.testnet') : new NearView(ENDS, 'signer.testnet', 'relayer.testnet', chain.fetchFn).independent();
      const started = performance.now();
      await confirmPath({ scopeId: 's1', via: G, viaView, path: { provider: 'email', sub: E_SUB }, views });
      const elapsed = performance.now() - started;
      expect(chain.log.filter((l) => l.url === PRIMARY)).toHaveLength(2);
      expect(chain.log.filter((l) => l.url === FALLBACK)).toHaveLength(2);
      // Every request started before the first one answered: the primary's and the second provider's overlap.
      const firstEnd = Math.min(...chain.log.map((l) => l.end));
      for (const l of chain.log) expect(l.start).toBeLessThan(firstEnd);
      // One round of the slow provider (200 ms), not two, nor the primary's added on top.
      expect(elapsed).toBeLessThan(200 + 150);
    });
  }
});
