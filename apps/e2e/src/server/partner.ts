// The partner side of the stack: the partner test app (partner/app.ts) on its own origins, and a mocked EVM chain RPC
// it signs against (the SDK fills fees and nonces and broadcasts through the partner's RPC), which the API's
// sponsorship relayer (apps/api evm-relayer.ts) also reads and broadcasts to.
import { readFile } from 'node:fs/promises';
import { type ExecuteInput, executeDigest, recoverAuthorization } from '@hana-id/core/evm-sponsor';
import { decodeFunctionData, keccak256, parseAbi, parseTransaction, recoverTransactionAddress } from 'viem';
import { PARTNER_DIR } from '../build.ts';
import { E2E_SPONSOR_DELEGATE, EVM_CHAIN_ID } from '../stack.ts';
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
const ONE_ETH = '0xde0b6b3a7640000';
type Hex = `0x${string}`;

/** The delegate's `execute`, as core's encodeExecuteCalldata lays it out (contracts/evm-delegate). */
const EXECUTE_ABI = parseAbi(['function execute((address to, uint256 value, bytes data)[] calls, uint256 nonce, uint256 deadline, address relayer, uint256 minGas, bytes signature)']);
/** keccak256("Executed(bytes32,uint256,uint256)"): the delegate's success event. */
const EXECUTED_TOPIC = '0xfe95c3832c12555e6bdb94254f0062f3fef9fb21554e39a02734ac465105930b';
const NONCE_CALL = '0xaffed0e0';
const DESIGNATOR = `0xef0100${E2E_SPONSOR_DELEGATE.slice(2).toLowerCase()}` as Hex;
const OTHER_DESIGNATOR = `0xef0100${'42'.repeat(20)}` as Hex;
const word = (n: bigint): Hex => `0x${n.toString(16).padStart(64, '0')}`;

/**
 * A minimal EVM JSON-RPC: enough for fills, broadcasts and receipts. Broadcast transactions are kept for the tests.
 * Each sender's transaction count is its own (every broadcast from it, mined at once). The sponsorship relayer's
 * transactions (`relayer`) are also run as the delegate would: a type-4 authorization sets the account's code to its
 * delegation designator and uses the account's nonce, an `execute` uses the account's delegate nonce (`nonce()`
 * answers it) and its receipt carries `Executed(digest)` from the account; the relayer's own cancel (a 0-value
 * self-transfer) runs nothing. No gas is metered: every receipt says 21 000 at the base fee.
 */
export class MockEvm {
  /** Raw signed transactions as broadcast by partner pages (not the relayer's), in order. */
  readonly raw: Hex[] = [];
  /** Accounts' code (their EIP-7702 designator): set by a sponsored setup or by a test (setDelegation). */
  private readonly codes = new Map<string, Hex>();
  /** Transaction counts per sender (lowercase). */
  private readonly counts = new Map<string, number>();
  /** The delegate nonce per account (lowercase). */
  private readonly executeNonces = new Map<string, bigint>();
  /** Receipts by hash: the relayer's transactions (with their logs) and the partner pages'. */
  private readonly receipts = new Map<string, { logs: { address: string; topics: string[]; data: string }[]; type: string }>();

  constructor(private readonly relayer: string) {}

  /** An account's code as a test wants it: none, the pinned delegate's designator, or another delegate's. */
  setDelegation(account: string, delegation: 'none' | 'journear' | 'other'): void {
    const a = account.toLowerCase();
    if (delegation === 'none') this.codes.delete(a);
    else this.codes.set(a, delegation === 'journear' ? DESIGNATOR : OTHER_DESIGNATOR);
  }

  private count(address: string): number {
    return this.counts.get(address.toLowerCase()) ?? 0;
  }

  /** Runs a broadcast transaction as mined: its sender's count, and for the relayer's, what the delegate does. */
  private async mine(raw: Hex): Promise<void> {
    const hash = keccak256(raw);
    let from: string;
    let tx: ReturnType<typeof parseTransaction>;
    try {
      tx = parseTransaction(raw);
      from = (await recoverTransactionAddress({ serializedTransaction: raw as never })).toLowerCase();
    } catch {
      this.receipts.set(hash, { logs: [], type: '0x2' });
      return;
    }
    this.counts.set(from, this.count(from) + 1);
    const logs: { address: string; topics: string[]; data: string }[] = [];
    if (from === this.relayer.toLowerCase() && tx.to) {
      const account = tx.to.toLowerCase();
      for (const a of (tx as { authorizationList?: { address?: Hex; contractAddress?: Hex; chainId: number; nonce: number; yParity?: number; r: Hex; s: Hex }[] }).authorizationList ?? []) {
        try {
          const authority = recoverAuthorization({ chainId: Number(a.chainId), address: (a.address ?? a.contractAddress)!, nonce: BigInt(a.nonce), yParity: (a.yParity ?? 0) as 0 | 1, r: a.r, s: a.s }).toLowerCase();
          this.codes.set(authority, `0xef0100${(a.address ?? a.contractAddress)!.slice(2).toLowerCase()}` as Hex);
          this.counts.set(authority, this.count(authority) + 1);
        } catch {
          // An authorization the network would skip: nothing changes.
        }
      }
      if (tx.data && tx.data !== '0x') {
        const { args } = decodeFunctionData({ abi: EXECUTE_ABI, data: tx.data });
        const [calls, nonce, deadline, relayer, minGas] = args as unknown as [{ to: Hex; value: bigint; data: Hex }[], bigint, bigint, Hex, bigint, Hex];
        const input: ExecuteInput = { chainId: EVM_CHAIN_ID, account: tx.to, implementation: E2E_SPONSOR_DELEGATE as Hex, calls: calls.map((c) => ({ to: c.to, value: c.value, data: c.data })), nonce, deadline, relayer, minGas };
        const digest = `0x${Buffer.from(executeDigest(input)).toString('hex')}`;
        this.executeNonces.set(account, (this.executeNonces.get(account) ?? 0n) + 1n);
        logs.push({ address: account, topics: [EXECUTED_TOPIC, digest], data: `${word(nonce)}${'00'.repeat(32)}` });
      }
    }
    this.receipts.set(hash, { logs, type: tx.type === 'eip7702' ? '0x4' : '0x2' });
  }

  handler(): Handler {
    return async (request) => {
      const url = new URL(request.url);
      if (url.pathname === '/__e2e/txs' && request.method === 'GET' && request.headers.get('origin') === null) return json(200, this.raw);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: CORS });
      const body = (await request.json()) as { id?: unknown; method?: string; params?: unknown[] };
      const ok = (result: unknown) => json(200, { jsonrpc: '2.0', id: body.id ?? null, result }, CORS);
      const p0 = typeof body.params?.[0] === 'string' ? body.params[0].toLowerCase() : '';
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
          return ok(`0x${this.count(p0).toString(16)}`);
        case 'eth_estimateGas':
          return ok('0x5208');
        case 'eth_gasPrice':
          return ok('0x77359400');
        case 'eth_maxPriorityFeePerGas':
          return ok(BASE_FEE);
        case 'eth_getBalance':
          return ok(ONE_ETH);
        case 'eth_getCode':
          return ok(this.codes.get(p0) ?? '0x');
        case 'eth_call': {
          // The delegate's nonce() on an account; any other call (the sponsorship's simulation) succeeds.
          const c = body.params?.[0] as { to?: string; data?: string } | undefined;
          if (c?.data === NONCE_CALL && typeof c.to === 'string') return ok(word(this.executeNonces.get(c.to.toLowerCase()) ?? 0n));
          return ok('0x');
        }
        case 'eth_sendRawTransaction': {
          const raw = body.params?.[0];
          if (typeof raw !== 'string' || !/^0x[0-9a-f]+$/iu.test(raw)) return json(200, { jsonrpc: '2.0', id: body.id ?? null, error: { code: -32602, message: 'invalid raw transaction' } }, CORS);
          const hash = keccak256(raw as Hex);
          if (this.receipts.has(hash)) return json(200, { jsonrpc: '2.0', id: body.id ?? null, error: { code: -32000, message: 'already known' } }, CORS);
          await this.mine(raw as Hex);
          if (!(await this.fromRelayer(raw as Hex))) this.raw.push(raw as Hex);
          return ok(hash);
        }
        case 'eth_getTransactionReceipt': {
          const hash = typeof body.params?.[0] === 'string' ? body.params[0] : '';
          const r = this.receipts.get(hash);
          return ok(
            r
              ? { transactionHash: hash, blockHash: `0x${'11'.repeat(32)}`, blockNumber: '0x1', transactionIndex: '0x0', status: '0x1', gasUsed: '0x5208', cumulativeGasUsed: '0x5208', effectiveGasPrice: BASE_FEE, logs: r.logs.map((l, i) => ({ ...l, logIndex: `0x${i.toString(16)}`, blockNumber: '0x1', transactionHash: hash, removed: false })), logsBloom: `0x${'00'.repeat(256)}`, type: r.type, from: null, to: null, contractAddress: null }
              : null,
          );
        }
        default:
          return json(200, { jsonrpc: '2.0', id: body.id ?? null, error: { code: -32601, message: 'Method not found' } }, CORS);
      }
    };
  }

  private async fromRelayer(raw: Hex): Promise<boolean> {
    try {
      return (await recoverTransactionAddress({ serializedTransaction: raw as never })).toLowerCase() === this.relayer.toLowerCase();
    } catch {
      return false;
    }
  }
}
