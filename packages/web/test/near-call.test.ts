// One NEAR RPC read with the optional rpcFallback (src/near-call.ts; docs/batch-b-spec.md Q9): the fallback only when
// the primary fails, each answer whole from one endpoint, the next read back at the primary.
import { describe, expect, it } from 'vitest';
import { nearReader } from '../src/auth/near-rpc.ts';
import { isPendingTxError, nearCall, nearEndpoints } from '../src/near-call.ts';
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
