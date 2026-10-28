// The partner side of the stack: the partner test app (partner/app.ts) on its own origins, and a mocked EVM chain RPC
// it signs against (the SDK fills fees and nonces and broadcasts through the partner's RPC).
import { readFile } from 'node:fs/promises';
import { keccak256 } from 'viem';
import { PARTNER_DIR } from '../build.ts';
import { EVM_CHAIN_ID } from '../stack.ts';
import { type Handler, json } from './http.ts';

/** COOP values a test may ask the partner page to send (`?coop=`): the partner requirement's cases. */
const COOP_VALUES = new Set(['same-origin', 'same-origin-allow-popups', 'unsafe-none']);

export function partnerHost(): Handler {
  return async (request) => {
    const url = new URL(request.url);
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
      const coop = url.searchParams.get('coop');
      if (coop !== null && COOP_VALUES.has(coop)) headers['cross-origin-opener-policy'] = coop;
      return new Response(await readFile(`${PARTNER_DIR}index.html`), { headers });
    }
    if (url.pathname === '/app.js') {
      return new Response(await readFile(`${PARTNER_DIR}app.js`), { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' } });
    }
    return new Response('Not found', { status: 404 });
  };
}

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
const BASE_FEE = '0x3b9aca00';

/** A minimal EVM JSON-RPC: enough for fills, broadcasts and receipts. Broadcast transactions are kept for the tests. */
export class MockEvm {
  /** Raw signed transactions as broadcast, in order. */
  readonly raw: `0x${string}`[] = [];

  handler(): Handler {
    return async (request) => {
      const url = new URL(request.url);
      if (url.pathname === '/__e2e/txs' && request.method === 'GET' && request.headers.get('origin') === null) return json(200, this.raw);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: CORS });
      const body = (await request.json()) as { id?: unknown; method?: string; params?: unknown[] };
      const ok = (result: unknown) => json(200, { jsonrpc: '2.0', id: body.id ?? null, result }, CORS);
      switch (body.method) {
        case 'eth_chainId':
          return ok(`0x${EVM_CHAIN_ID.toString(16)}`);
        case 'net_version':
          return ok(String(EVM_CHAIN_ID));
        case 'eth_blockNumber':
          return ok('0x1');
        case 'eth_getBlockByNumber':
          return ok({ number: '0x1', hash: `0x${'11'.repeat(32)}`, parentHash: `0x${'00'.repeat(32)}`, timestamp: '0x6553f100', baseFeePerGas: BASE_FEE, gasLimit: '0x1c9c380', gasUsed: '0x0', transactions: [] });
        case 'eth_getTransactionCount':
          return ok(`0x${this.raw.length.toString(16)}`);
        case 'eth_estimateGas':
          return ok('0x5208');
        case 'eth_gasPrice':
          return ok('0x77359400');
        case 'eth_maxPriorityFeePerGas':
          return ok(BASE_FEE);
        case 'eth_getBalance':
          return ok('0xde0b6b3a7640000');
        case 'eth_getCode':
        case 'eth_call':
          return ok('0x');
        case 'eth_sendRawTransaction': {
          const raw = body.params?.[0];
          if (typeof raw !== 'string' || !/^0x[0-9a-f]+$/iu.test(raw)) return json(200, { jsonrpc: '2.0', id: body.id ?? null, error: { code: -32602, message: 'invalid raw transaction' } }, CORS);
          this.raw.push(raw as `0x${string}`);
          return ok(keccak256(raw as `0x${string}`));
        }
        case 'eth_getTransactionReceipt': {
          const hash = body.params?.[0];
          const known = this.raw.some((r) => keccak256(r) === hash);
          return ok(
            known
              ? { transactionHash: hash, blockHash: `0x${'11'.repeat(32)}`, blockNumber: '0x1', transactionIndex: '0x0', status: '0x1', gasUsed: '0x5208', cumulativeGasUsed: '0x5208', effectiveGasPrice: BASE_FEE, logs: [], logsBloom: `0x${'00'.repeat(256)}`, type: '0x2', from: null, to: null, contractAddress: null }
              : null,
          );
        }
        default:
          return json(200, { jsonrpc: '2.0', id: body.id ?? null, error: { code: -32601, message: 'Method not found' } }, CORS);
      }
    };
  }
}
