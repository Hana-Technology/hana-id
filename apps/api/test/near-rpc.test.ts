// The API's NEAR RPC failover (near/rpc.ts, D432): which failures move a call to the next endpoint (network, timeout,
// 5xx, 429, no JSON-RPC answer, a node with no synced block) and which answers never do (any JSON-RPC result or
// error); the order (the endpoint that answered last, then by health); a broadcast that fails over never reports a
// definite rejection; NEAR_RPC_FALLBACKS parsing; the log line.
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_RPC_FALLBACKS,
  RPC_DOWN_MS,
  Rpc,
  RpcError,
  RpcHealth,
  invalidNonce,
  isDefiniteRejection,
  isExpired,
  isTransient,
  nearRpc,
  rpcEndpoints,
  rpcHealth,
} from '../src/near/rpc.ts';
import { scopeForClient } from '../src/views.ts';

const A = 'https://rpc-a.test.invalid';
const B = 'https://rpc-b.test.invalid';
const C = 'https://rpc-c.test.invalid';

type Reply = Response | 'network' | 'hang' | ((body: { method: string; params: Record<string, unknown> }) => Response);
const jsonrpc = (payload: Record<string, unknown>, status = 200): Response => Response.json({ jsonrpc: '2.0', id: 'hana-id-api', ...payload }, { status });
const viewResult = (value: unknown): Response => jsonrpc({ result: { result: [...new TextEncoder().encode(JSON.stringify(value))], logs: [], block_height: 1 } });
const handlerError = (cause: string, extra: Record<string, unknown> = {}, status = 200): Response => jsonrpc({ error: { name: 'HANDLER_ERROR', cause: { name: cause }, ...extra } }, status);

/** A fetch stub: each URL answers from its own queue (the last entry repeats); records every call in order. */
function stubRpc(replies: Record<string, Reply[]>): { calls: { url: string; method: string; body: Record<string, unknown> }[] } {
  const calls: { url: string; method: string; body: Record<string, unknown> }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const body = JSON.parse(String(init?.body)) as { method: string; params: Record<string, unknown> };
    calls.push({ url, method: body.method, body });
    const queue = replies[url];
    if (!queue) throw new Error(`Unexpected fetch to ${url}`);
    const reply = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (reply === 'network') throw new TypeError('Network connection lost.');
    if (reply === 'hang') {
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        signal?.addEventListener('abort', () => reject(signal.reason ?? new DOMException('The operation was aborted due to timeout', 'TimeoutError')));
      });
    }
    return typeof reply === 'function' ? reply(body) : reply.clone();
  });
  return { calls };
}

const rpcOf = (urls: string[], health = new RpcHealth()) => new Rpc(urls, { health, viewTimeoutMs: 50, txTimeoutMs: 50 });
const urlsOf = (calls: { url: string }[]) => calls.map((c) => c.url);

afterEach(() => {
  vi.restoreAllMocks();
  rpcHealth.clear();
});

describe('failover: when the next endpoint is asked', () => {
  const failures: [string, Reply][] = [
    ['a network error', 'network'],
    ['a timeout', 'hang'],
    ['HTTP 500 with a JSON-RPC INTERNAL_ERROR', jsonrpc({ error: { name: 'INTERNAL_ERROR', cause: { name: 'INTERNAL_ERROR' } } }, 500)],
    ['HTTP 502 without JSON', new Response('<html>502 Bad Gateway</html>', { status: 502 })],
    ['HTTP 503 without JSON', new Response('unavailable', { status: 503 })],
    ['HTTP 504 without JSON (a proxy timeout)', new Response('gateway timeout', { status: 504 })],
    ['HTTP 429', new Response('Too Many Requests', { status: 429 })],
    ['HTTP 429 with a JSON-RPC error body', jsonrpc({ error: { name: 'RATE_LIMITED', message: 'slow down' } }, 429)],
    ['HTTP 200 that is not JSON (a captive page)', new Response('<html>hello</html>', { status: 200 })],
    ['HTTP 408 without JSON (a proxy timeout)', new Response('timeout', { status: 408 })],
    ['a JSON body with neither result nor error', jsonrpc({})],
    ['a JSON body that is not an object', new Response('[1,2]', { status: 200 })],
    ['a node with no synced block', handlerError('NO_SYNCED_BLOCKS')],
    ['a node not synced yet', handlerError('NOT_SYNCED_YET')],
  ];
  for (const [what, reply] of failures) {
    it(`moves on after ${what}`, async () => {
      const { calls } = stubRpc({ [A]: [reply], [B]: [viewResult('s1')] });
      expect(await rpcOf([A, B]).view('signer.test', 'scope_for_client', {})).toBe('s1');
      expect(urlsOf(calls)).toEqual([A, B]);
      // The same request, unchanged, on the next endpoint.
      expect(calls[1]!.body).toEqual(calls[0]!.body);
    });
  }

  it('tries every endpoint in order and throws the last one’s error when none answers', async () => {
    const { calls } = stubRpc({ [A]: ['network'], [B]: [new Response('x', { status: 503 })], [C]: [new Response('gateway timeout', { status: 504 })] });
    const err = await rpcOf([A, B, C]).view('signer.test', 'get_scope', {}).catch((e: unknown) => e);
    expect(urlsOf(calls)).toEqual([A, B, C]);
    expect(err).toBeInstanceOf(RpcError);
    // The last endpoint's own error, as a single endpoint would report it (a proxy's 504 reads as TIMEOUT).
    expect((err as RpcError).message).toBe('TIMEOUT');
    expect((err as RpcError).httpStatus).toBe(504);
  });
});

describe('failover: a JSON-RPC answer is final, an error answer included', () => {
  const answers: [string, Response][] = [
    ['a contract view error (MethodNotFound)', handlerError('CONTRACT_EXECUTION_ERROR', { data: 'MethodNotFound get_x' })],
    ['an unknown account', handlerError('UNKNOWN_ACCOUNT')],
    ['an unknown block', handlerError('UNKNOWN_BLOCK')],
    ['a garbage-collected block', handlerError('GARBAGE_COLLECTED_BLOCK')],
    ['a request validation error (HTTP 400)', jsonrpc({ error: { name: 'REQUEST_VALIDATION_ERROR', cause: { name: 'PARSE_ERROR' } } }, 400)],
    ['a node TIMEOUT_ERROR answer (HTTP 408)', handlerError('TIMEOUT_ERROR', { data: 'TIMEOUT' }, 408)],
    ['UNKNOWN_TRANSACTION', handlerError('UNKNOWN_TRANSACTION')],
  ];
  for (const [what, reply] of answers) {
    it(`does not ask another endpoint after ${what}`, async () => {
      const { calls } = stubRpc({ [A]: [reply], [B]: [viewResult('other answer')] });
      await expect(rpcOf([A, B]).view('signer.test', 'get_scope', {})).rejects.toBeInstanceOf(RpcError);
      expect(urlsOf(calls)).toEqual([A]);
    });
  }

  it('returns a result from the first endpoint without asking the others', async () => {
    const { calls } = stubRpc({ [A]: [viewResult(null)], [B]: [viewResult('s9')] });
    expect(await rpcOf([A, B]).view('signer.test', 'scope_for_client', {})).toBeNull();
    expect(urlsOf(calls)).toEqual([A]);
  });

  it('a transaction that the node reports as failed is final too', async () => {
    const failure = { status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: no' } } } } }, transaction: { hash: 'h' } };
    const { calls } = stubRpc({ [A]: [jsonrpc({ result: failure })], [B]: [jsonrpc({ result: { status: { SuccessValue: '' } } })] });
    expect(await rpcOf([A, B]).txStatus('h', 'relayer.test')).toEqual(failure);
    expect(urlsOf(calls)).toEqual([A]);
  });
});

describe('failover: order and health', () => {
  it('stays on the endpoint that answered last within one Rpc', async () => {
    const { calls } = stubRpc({ [A]: ['network', viewResult('a')], [B]: [viewResult('b')] });
    const rpc = rpcOf([A, B]);
    expect(await rpc.view('signer.test', 'v', {})).toBe('b');
    // A would answer now, but this Rpc's later calls (a tx's polls, its nonce check) stay on B.
    expect(await rpc.view('signer.test', 'v', {})).toBe('b');
    await rpc.txStatus('h', 'relayer.test');
    expect(urlsOf(calls)).toEqual([A, B, B, B]);
  });

  it('a new Rpc asks a recently failed endpoint after the others, and first again after RPC_DOWN_MS', async () => {
    let now = 1_000_000;
    const health = new RpcHealth(() => now);
    const { calls } = stubRpc({ [A]: ['network', viewResult('a')], [B]: [viewResult('b')] });
    expect(await rpcOf([A, B], health).view('signer.test', 'v', {})).toBe('b');
    expect(await rpcOf([A, B], health).view('signer.test', 'v', {})).toBe('b');
    expect(urlsOf(calls)).toEqual([A, B, B]);
    now += RPC_DOWN_MS + 1;
    expect(await rpcOf([A, B], health).view('signer.test', 'v', {})).toBe('a');
    expect(urlsOf(calls)).toEqual([A, B, B, A]);
  });

  it('when every endpoint is marked down they are asked in the configured order, and a success clears the mark', async () => {
    const health = new RpcHealth();
    health.failed(A);
    health.failed(B);
    expect(health.order([A, B])).toEqual([0, 1]);
    const { calls } = stubRpc({ [A]: [viewResult('a')], [B]: [viewResult('b')] });
    expect(await rpcOf([A, B], health).view('signer.test', 'v', {})).toBe('a');
    expect(urlsOf(calls)).toEqual([A]);
    // A is up again, B still down: listed B first, A now comes first.
    expect(health.order([B, A])).toEqual([1, 0]);
  });

  it('logs each failover with the endpoints’ indexes and the reason, never a URL', async () => {
    stubRpc({ [A]: [new Response('x', { status: 503 })], [B]: ['hang'], [C]: [viewResult(1)] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await rpcOf([A, B, C]).view('signer.test', 'v', {});
    const lines = warn.mock.calls.map(([l]) => JSON.parse(String(l)) as Record<string, unknown>);
    expect(lines).toEqual([
      expect.objectContaining({ level: 'warn', event: 'near_rpc_failover', method: 'query', code: 'http_5xx', rpcEndpoint: 0, nextRpcEndpoint: 1 }),
      expect.objectContaining({ level: 'warn', event: 'near_rpc_failover', method: 'query', code: 'timeout', rpcEndpoint: 1, nextRpcEndpoint: 2 }),
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/rpc-[abc]\.test/u);
  });

  it('with one endpoint nothing changes: no failover, no log, its own error', async () => {
    const { calls } = stubRpc({ [A]: ['network'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(rpcOf([A]).view('signer.test', 'v', {})).rejects.toThrow(/NEAR RPC unreachable/u);
    expect(urlsOf(calls)).toEqual([A]);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('failover: transactions', () => {
  const tx = new Uint8Array([1, 2, 3]);
  const invalidNonceAnswer = handlerError('INVALID_TRANSACTION', { data: { TxExecutionError: { InvalidTxError: { InvalidNonce: { ak_nonce: 7, tx_nonce: 7 } } } } });
  const expiredAnswer = handlerError('INVALID_TRANSACTION', { data: { TxExecutionError: { InvalidTxError: 'Expired' } } });

  it('a broadcast that fails over sends the same signed bytes to the next endpoint', async () => {
    const outcome = { status: { SuccessValue: '' }, transaction: { hash: 'h' }, final_execution_status: 'EXECUTED_OPTIMISTIC' };
    const { calls } = stubRpc({ [A]: ['network'], [B]: [jsonrpc({ result: outcome })] });
    // A result after a failover is the same transaction's outcome: returned.
    expect(await rpcOf([A, B]).sendTx(tx, 'EXECUTED_OPTIMISTIC')).toEqual(outcome);
    expect(calls.map((c) => [c.url, c.method])).toEqual([[A, 'send_tx'], [B, 'send_tx']]);
    expect(calls[1]!.body).toEqual(calls[0]!.body);
  });

  for (const [what, answer] of [
    ['InvalidNonce (the first broadcast may have landed)', invalidNonceAnswer],
    ['Expired', expiredAnswer],
    ['a TIMEOUT_ERROR', handlerError('TIMEOUT_ERROR', { data: 'TIMEOUT' }, 408)],
  ] as const) {
    it(`after a failover, ${what} is an unknown outcome to poll, never a definite rejection`, async () => {
      stubRpc({ [A]: [new Response('<html>502</html>', { status: 502 })], [B]: [answer] });
      const err = await rpcOf([A, B]).sendTx(tx, 'EXECUTED_OPTIMISTIC').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).rpc).toBeNull();
      expect(isDefiniteRejection(err)).toBe(false);
      expect(invalidNonce(err)).toBeNull();
      expect(isExpired(err)).toBe(false);
      expect(isTransient(err)).toBe(true);
    });
  }

  it('without a failover the node’s rejection stays definite (InvalidNonce, Expired), as with one endpoint', async () => {
    stubRpc({ [A]: [invalidNonceAnswer, expiredAnswer], [B]: [viewResult('never asked')] });
    const rpc = rpcOf([A, B]);
    const nonce = await rpc.sendTx(tx, 'EXECUTED_OPTIMISTIC').catch((e: unknown) => e);
    expect(invalidNonce(nonce)).toEqual({ akNonce: 7n });
    expect(isDefiniteRejection(nonce)).toBe(true);
    const expired = await rpc.sendTx(tx, 'EXECUTED_OPTIMISTIC').catch((e: unknown) => e);
    expect(isExpired(expired)).toBe(true);
  });

  it('a broadcast that every endpoint failed is an unknown outcome too', async () => {
    stubRpc({ [A]: ['network'], [B]: ['hang'] });
    const err = await rpcOf([A, B]).sendTx(tx, 'EXECUTED_OPTIMISTIC').catch((e: unknown) => e);
    expect(isDefiniteRejection(err)).toBe(false);
    expect(isTransient(err)).toBe(true);
  });

  it('status polls fail over like reads; UNKNOWN_TRANSACTION is an answer (the caller polls again)', async () => {
    const { calls } = stubRpc({ [A]: [new Response('x', { status: 503 })], [B]: [handlerError('UNKNOWN_TRANSACTION')] });
    const err = await rpcOf([A, B]).txStatus('h', 'relayer.test').catch((e: unknown) => e);
    expect(urlsOf(calls)).toEqual([A, B]);
    expect(isTransient(err)).toBe(true);
  });

  it('gives every call a per-endpoint timeout: reads VIEW_TIMEOUT_MS, send_tx and tx TX_TIMEOUT_MS', async () => {
    const signals: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      signals.push(init?.signal);
      return viewResult(null);
    });
    const rpc = new Rpc([A]);
    await rpc.view('signer.test', 'v', {});
    await rpc.viewAccessKey('relayer.test', 'ed25519:x').catch(() => null);
    await rpc.viewAccessKeyList('relayer.test').catch(() => null);
    await rpc.latestBlockHash().catch(() => null);
    await rpc.sendTx(tx, 'EXECUTED').catch(() => null);
    await rpc.txStatus('h', 'relayer.test').catch(() => null);
    expect(signals).toHaveLength(6);
    for (const s of signals) expect(s).toBeInstanceOf(AbortSignal);
  });
});

describe('the endpoint list (NEAR_RPC_FALLBACKS)', () => {
  it('is NEAR_RPC, then the fallbacks in order', () => {
    expect(rpcEndpoints({ NEAR_RPC: A })).toEqual([A]);
    expect(rpcEndpoints({ NEAR_RPC: A, NEAR_RPC_FALLBACKS: JSON.stringify([B, C]) })).toEqual([A, B, C]);
  });

  it('drops repeats, non-strings and non-http(s) entries, and keeps at most MAX_RPC_FALLBACKS', () => {
    expect(rpcEndpoints({ NEAR_RPC: A, NEAR_RPC_FALLBACKS: JSON.stringify([A, B, B, 7, 'wss://x.test', 'not a url', C]) })).toEqual([A, B, C]);
    const many = Array.from({ length: 6 }, (_, i) => `https://rpc-${i}.test.invalid`);
    expect(rpcEndpoints({ NEAR_RPC: A, NEAR_RPC_FALLBACKS: JSON.stringify(many) })).toEqual([A, ...many.slice(0, MAX_RPC_FALLBACKS)]);
  });

  it('a value that is not a JSON array means no fallback', () => {
    for (const bad of ['', B, '{"a":1}', '"x"', 'null']) expect(rpcEndpoints({ NEAR_RPC: A, NEAR_RPC_FALLBACKS: bad })).toEqual([A]);
  });

  it('the API’s views use it: a 503 from NEAR_RPC is answered by the fallback', async () => {
    const { calls } = stubRpc({ [env.NEAR_RPC]: [new Response('x', { status: 503 })], [B]: [viewResult('s-fallback')] });
    const aud = `aud-${crypto.randomUUID()}`;
    expect(await scopeForClient({ ...env, NEAR_RPC_FALLBACKS: JSON.stringify([B]) }, 'google', aud)).toBe('s-fallback');
    expect(urlsOf(calls)).toEqual([env.NEAR_RPC, B]);
  });

  it('nearRpc builds an Rpc over that list (scripts/test/rpc-endpoints.test.ts checks every Rpc in src is made by it)', () => {
    expect(nearRpc({ NEAR_RPC: A })).toBeInstanceOf(Rpc);
  });
});
