// A fake EVM chain behind a global fetch stub, for the EVM relayer object and its RPC client (evm-relayer.ts,
// evm/sponsor-chain.ts, D851). One chain behind several endpoint URLs (by default the read endpoint and the broadcast
// fallback), each of which can be made to fail. Like a node's pool it checks a raw transaction's nonce against the
// sender's mined count, replaces a pending one only with both fees at least 10% higher, answers `already known` for one
// it holds, and counts `pending` as the mined count plus the pool's run of consecutive nonces. Blocks: transactions are
// mined only when a test calls `mine`, into one block followed by empty ones; counts are kept per block, so a block
// number and `safe` (head − `safeDepth`) answer what was mined then. `unmine` is a reorg (back to the pool, or
// dropped); a foreign transaction from the same key is one the test signs itself and `admit`s. The sender is recovered
// from each raw transaction's signature (type 2 and type 4).
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { vi } from 'vitest';

export type Hex = `0x${string}`;

export const PRIMARY_RPC = 'https://evm-primary.test.invalid';
export const FALLBACK_RPC = 'https://evm-fallback.test.invalid';

/** How an endpoint answers: normally, not at all (network error), HTTP 503, rate limited, for another chain, or garbage. */
export type EndpointMode = 'up' | 'down' | 'http503' | 'rate_limited' | 'wrong_chain' | 'garbage';

export interface MockTx {
  hash: Hex;
  raw: Hex;
  type: 2 | 4;
  from: Hex;
  chainId: bigint;
  nonce: number;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gas: bigint;
  to: Hex;
  value: bigint;
  data: Hex;
  authorizations: number;
}

/** What a send hook makes the endpoint do with a transaction that passed the pool's checks. */
export type SendHook = { error: string; keep?: boolean } | 'hang' | 'accept_then_hang' | 'network' | 'accept' | undefined;

type Item = Uint8Array | Item[];
const hex = (b: Uint8Array): Hex => `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;
const fromHex = (h: string): Uint8Array => {
  const out = new Uint8Array((h.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(2 + 2 * i, 4 + 2 * i), 16);
  return out;
};
const big = (b: Uint8Array): bigint => (b.length === 0 ? 0n : BigInt(hex(b)));
const q = (n: number | bigint): string => `0x${n.toString(16)}`;

/** Decodes one RLP item at `pos`: its value and where its encoding ends. */
function decode(b: Uint8Array, pos: number): { item: Item; end: number } {
  const p = b[pos]!;
  if (p < 0x80) return { item: b.subarray(pos, pos + 1), end: pos + 1 };
  if (p < 0xb8) return { item: b.subarray(pos + 1, pos + 1 + p - 0x80), end: pos + 1 + p - 0x80 };
  if (p < 0xc0) {
    const ll = p - 0xb7;
    const len = Number(big(b.subarray(pos + 1, pos + 1 + ll)));
    return { item: b.subarray(pos + 1 + ll, pos + 1 + ll + len), end: pos + 1 + ll + len };
  }
  const ll = p < 0xf8 ? 0 : p - 0xf7;
  const len = p < 0xf8 ? p - 0xc0 : Number(big(b.subarray(pos + 1, pos + 1 + ll)));
  const start = pos + 1 + ll;
  const items: Item[] = [];
  for (let at = start; at < start + len; ) {
    const d = decode(b, at);
    items.push(d.item);
    at = d.end;
  }
  return { item: items, end: start + len };
}

function listHeader(len: number): Uint8Array {
  if (len < 56) return Uint8Array.of(0xc0 + len);
  const l: number[] = [];
  for (let n = len; n > 0; n = Math.floor(n / 256)) l.unshift(n % 256);
  return Uint8Array.of(0xf7 + l.length, ...l);
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

export const addressOf = (publicKeyUncompressed: Uint8Array): Hex => hex(keccak_256(publicKeyUncompressed.subarray(1)).subarray(-20));

/** Decodes a signed type-2 or type-4 transaction and recovers its sender. */
export function decodeRawTx(raw: Hex): MockTx {
  const b = fromHex(raw);
  const type = b[0];
  if (type !== 2 && type !== 4) throw new Error('unsupported tx type');
  const body = b.subarray(1);
  const fields = decode(body, 0).item as Item[];
  const n = fields.length;
  if ((type === 2 && n !== 12) || (type === 4 && n !== 13)) throw new Error('bad field count');
  // The unsigned payload: the list's first n − 3 elements, re-wrapped.
  const p = body[0]!;
  let at = p < 0xf8 ? 1 : 1 + (p - 0xf7);
  const start = at;
  for (let i = 0; i < n - 3; i++) at = decode(body, at).end;
  const unsignedBody = body.subarray(start, at);
  const signingHash = keccak_256(concat(Uint8Array.of(type), listHeader(unsignedBody.length), unsignedBody));
  const pub = new secp256k1.Signature(big(fields[n - 2] as Uint8Array), big(fields[n - 1] as Uint8Array)).addRecoveryBit(Number(big(fields[n - 3] as Uint8Array))).recoverPublicKey(signingHash).toRawBytes(false);
  return {
    hash: hex(keccak_256(b)),
    raw: raw.toLowerCase() as Hex,
    type,
    from: addressOf(pub),
    chainId: big(fields[0] as Uint8Array),
    nonce: Number(big(fields[1] as Uint8Array)),
    maxPriorityFeePerGas: big(fields[2] as Uint8Array),
    maxFeePerGas: big(fields[3] as Uint8Array),
    gas: big(fields[4] as Uint8Array),
    to: hex(fields[5] as Uint8Array),
    value: big(fields[6] as Uint8Array),
    data: hex(fields[7] as Uint8Array),
    authorizations: type === 4 ? (fields[9] as Item[]).length : 0,
  };
}

const hang = (signal: AbortSignal | null | undefined): Promise<never> => new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted'))));

type Reply = (r: { result: unknown } | { error: { code: number; message: string; data?: string } }) => Response;

export class EvmMock {
  readonly chainId: number;
  readonly urls: string[];
  /** Per endpoint (index into `urls`). */
  readonly modes: EndpointMode[];
  /** The head block's number; `safe` is `safeDepth` below it. */
  blockNumber = 100;
  safeDepth = 2;
  /** Whether endpoints answer the `safe` tag (else an error, as some nodes do). */
  supportsSafe = true;
  /** Every block's base fee (wei). */
  baseFee = 1n;
  /** A body this many bytes long for the next eth_getTransactionCount, then cleared. */
  hugeResponse = 0;
  /** Extra receipt fields (OP Stack: l1Fee, operatorFeeScalar, operatorFeeConstant), as hex strings. */
  receiptExtras: Record<string, string> = {};
  /** The next N receipt reads fail (no answer). */
  receiptFailures = 0;
  /** Receipts answer null (a node that hasn't indexed them yet). */
  hideReceipts = false;
  /** Mined counts per block (a snapshot at each block that changed them). */
  private readonly history: { number: number; counts: Map<string, number> }[] = [];
  readonly minedCount = new Map<string, number>();
  /** Pending pool per sender: nonce → transaction. */
  readonly pool = new Map<string, Map<number, MockTx>>();
  readonly minedTxs: MockTx[] = [];
  /** Every eth_sendRawTransaction that reached an endpoint's pool logic, in order. */
  readonly broadcasts: { endpoint: number; tx: MockTx; outcome: string }[] = [];
  /** Every call, in arrival order. */
  readonly calls: { endpoint: number; method: string }[] = [];
  onSend?: (tx: MockTx, endpoint: number) => SendHook | Promise<SendHook>;
  /** Awaited when a read arrives, before it is answered (to hold or crash mid-read). */
  onRead?: (method: string, endpoint: number) => Promise<void> | void;
  /**
   * Answers a read before the mock's own (the sponsorship handlers' account reads: eth_getCode, eth_call), or undefined
   * for the mock's answer.
   */
  answer?: (method: string, params: unknown[]) => { result: unknown } | { error: { code: number; message: string; data?: string } } | undefined;
  /** eth_getBalance per address (lowercase), 1 ETH otherwise (D890's automatic restart reads the relayer's). */
  readonly balances = new Map<string, bigint>();
  /** eth_getCode per address (lowercase); an address not here has no code (`0x`). */
  readonly codes = new Map<string, string>();
  /** Answers a read at one endpoint (by index) before everything else, or undefined (D890: a second endpoint that disagrees). */
  answerAt?: (endpoint: number, method: string, params: unknown[]) => { result: unknown } | undefined;
  /** A mined transaction's receipt logs (the delegate's Executed event), none by default. */
  receiptLogs?: (tx: MockTx) => { address: string; topics: string[]; data: string }[];
  private readonly receipts = new Map<string, { tx: MockTx; block: number }>();

  constructor(opts: { chainId?: number; urls?: string[] } = {}) {
    this.chainId = opts.chainId ?? 31337;
    this.urls = opts.urls ?? [PRIMARY_RPC, FALLBACK_RPC];
    this.modes = this.urls.map(() => 'up');
  }

  /** Stubs fetch; a URL that is none of this chain's goes to a fetch stub installed before (e.g. the NEAR mock), if any. */
  install(): this {
    const before = vi.isMockFunction(globalThis.fetch) ? (globalThis.fetch as unknown as { getMockImplementation(): ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) | undefined }).getMockImplementation() : undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const endpoint = this.urls.findIndex((u) => url === u || url === `${u}/`);
      if (endpoint < 0 && before) return before(input, init);
      if (endpoint < 0) throw new Error('Unexpected fetch');
      const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
      this.calls.push({ endpoint, method: body.method });
      const mode = this.modes[endpoint]!;
      if (mode === 'down') throw new TypeError('Network connection lost.');
      if (mode === 'http503') return new Response('<html>503</html>', { status: 503 });
      if (mode === 'garbage') return new Response('{"jsonrpc":"2.0","id":0,"result":"0x1"}', { status: 200 });
      const reply: Reply = (r) => Response.json({ jsonrpc: '2.0', id: body.id, ...r });
      if (mode === 'rate_limited') return reply({ error: { code: -32005, message: 'limit exceeded' } });
      if (body.method === 'eth_chainId') return reply({ result: q(mode === 'wrong_chain' ? this.chainId + 1 : this.chainId) });
      if (body.method === 'eth_sendRawTransaction') return this.sendRaw(endpoint, body.params[0] as Hex, init?.signal, reply);
      await this.onRead?.(body.method, endpoint);
      const at = this.answerAt?.(endpoint, body.method, body.params);
      if (at) return reply(at);
      return this.read(body.method, body.params, reply);
    });
    return this;
  }

  private read(method: string, params: unknown[], reply: Reply): Response {
    const head = this.blockNumber;
    const own = this.answer?.(method, params);
    if (own) return reply(own as Parameters<Reply>[0]);
    if (method === 'eth_blockNumber') return reply({ result: q(head) });
    if (method === 'eth_getTransactionCount') {
      const [address, tag] = params as [string, string];
      const n = tag === 'pending' ? this.pendingCount(address) : tag === 'latest' ? this.mined(address) : this.countAt(address, Number(BigInt(tag)));
      if (tag !== 'pending' && tag !== 'latest' && Number(BigInt(tag)) > head) return reply({ error: { code: -32000, message: 'header not found' } });
      if (this.hugeResponse > 0) {
        const pad = 'x'.repeat(this.hugeResponse);
        this.hugeResponse = 0;
        return new Response(`{"jsonrpc":"2.0","id":0,"result":"${q(n)}","pad":"${pad}"}`, { status: 200 });
      }
      return reply({ result: q(n) });
    }
    if (method === 'eth_getTransactionReceipt') {
      if (this.receiptFailures > 0) {
        this.receiptFailures--;
        throw new TypeError('Network connection lost.');
      }
      const got = this.hideReceipts ? undefined : this.receipts.get((params[0] as string).toLowerCase());
      if (!got || got.block > head) return reply({ result: null });
      return reply({ result: { transactionHash: got.tx.hash, status: '0x1', blockNumber: q(got.block), gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00', logs: this.receiptLogs?.(got.tx) ?? [], ...this.receiptExtras } });
    }
    if (method === 'eth_getBlockByNumber') {
      const tag = params[0] as string;
      if (tag === 'safe' && !this.supportsSafe) return reply({ error: { code: -32602, message: 'invalid block tag' } });
      const n = tag === 'safe' ? head - this.safeDepth : tag === 'latest' ? head : Number(BigInt(tag));
      return reply({ result: { number: q(n), timestamp: '0x6553f100', baseFeePerGas: q(this.baseFee) } });
    }
    const who = typeof params[0] === 'string' ? params[0].toLowerCase() : '';
    if (method === 'eth_getCode' && this.codes.has(who)) return reply({ result: this.codes.get(who) });
    // An address with no entry and no `answer`: an account with no code (the relayer's own, read every run).
    if (method === 'eth_getCode') return reply({ result: '0x' });
    if (method === 'eth_getCode' || method === 'eth_call') return reply({ error: { code: 3, message: 'execution reverted', data: '0x08c379a0' } });
    if (method === 'eth_getBalance') return reply({ result: q(this.balances.get(who) ?? 10n ** 18n) });
    return reply({ error: { code: -32601, message: 'method not found' } });
  }

  mined(address: string): number {
    return this.minedCount.get(address.toLowerCase()) ?? 0;
  }

  /** The sender's mined count as of block `n`. */
  countAt(address: string, n: number): number {
    const a = address.toLowerCase();
    let out = 0;
    for (const h of this.history) if (h.number <= n) out = h.counts.get(a) ?? 0;
    return out;
  }

  /** Starts a sender at mined count `n`, long confirmed (a funded relayer that sent before). */
  setMined(address: string, n: number): void {
    this.minedCount.set(address.toLowerCase(), n);
    this.history.unshift({ number: 0, counts: new Map([[address.toLowerCase(), n]]) });
  }

  addBlocks(n: number): void {
    this.blockNumber += n;
  }

  pendingCount(address: string): number {
    const pool = this.pool.get(address.toLowerCase());
    let n = this.mined(address);
    while (pool?.has(n)) n++;
    return n;
  }

  pooled(address: string, nonce: number): MockTx | undefined {
    return this.pool.get(address.toLowerCase())?.get(nonce);
  }

  pooledAll(address: string): MockTx[] {
    return [...(this.pool.get(address.toLowerCase())?.values() ?? [])].sort((x, y) => x.nonce - y.nonce);
  }

  /** The receipt block of a mined hash, or undefined. */
  receiptBlock(hash: string): number | undefined {
    return this.receipts.get(hash.toLowerCase())?.block;
  }

  /**
   * Mines a sender's pool from its mined count, in nonce order (at most `max`), into one new block, then `after` empty
   * blocks (5 by default: past `safe`'s 2, not past the 12 used without `safe`). Returns what was mined.
   */
  mine(address: string, max = Number.POSITIVE_INFINITY, opts: { after?: number } = {}): MockTx[] {
    const a = address.toLowerCase();
    const pool = this.pool.get(a) ?? new Map<number, MockTx>();
    const out: MockTx[] = [];
    let n = this.mined(a);
    this.blockNumber++;
    while (pool.has(n) && out.length < max) {
      const tx = pool.get(n)!;
      pool.delete(n);
      this.minedTxs.push(tx);
      this.receipts.set(tx.hash, { tx, block: this.blockNumber });
      out.push(tx);
      n++;
    }
    this.minedCount.set(a, n);
    this.history.push({ number: this.blockNumber, counts: new Map(this.minedCount) });
    this.addBlocks(opts.after ?? 5);
    return out;
  }

  /** A reorg: the sender's last `count` mined transactions un-mined (back into the pool, or gone with `drop`). */
  unmine(address: string, count: number, opts: { drop?: boolean } = {}): MockTx[] {
    const a = address.toLowerCase();
    const gone = this.minedTxs.filter((t) => t.from === a).slice(-count);
    const fromBlock = Math.min(...gone.map((t) => this.receipts.get(t.hash)!.block));
    for (const t of gone) {
      this.minedTxs.splice(this.minedTxs.indexOf(t), 1);
      this.receipts.delete(t.hash);
      if (!opts.drop) this.admit(t);
    }
    const left = this.mined(a) - gone.length;
    this.minedCount.set(a, left);
    for (const h of this.history) if (h.number >= fromBlock) h.counts.set(a, Math.min(h.counts.get(a) ?? 0, left));
    return gone;
  }

  drop(address: string, nonce: number): void {
    this.pool.get(address.toLowerCase())?.delete(nonce);
  }

  /** Puts a transaction in the pool without any checks (a foreign one from the same key, or a node that lies). */
  admit(tx: MockTx): void {
    const a = tx.from.toLowerCase();
    const pool = this.pool.get(a) ?? new Map<number, MockTx>();
    this.pool.set(a, pool);
    pool.set(tx.nonce, tx);
  }

  private async sendRaw(endpoint: number, raw: Hex, signal: AbortSignal | null | undefined, reply: Reply): Promise<Response> {
    let tx: MockTx;
    try {
      tx = decodeRawTx(raw);
    } catch {
      return reply({ error: { code: -32000, message: 'rlp: invalid transaction' } });
    }
    const note = (outcome: string) => this.broadcasts.push({ endpoint, tx, outcome });
    if (tx.chainId !== BigInt(this.chainId)) {
      note('wrong_chain');
      return reply({ error: { code: -32000, message: 'invalid chain id for signer' } });
    }
    if (tx.nonce < this.mined(tx.from)) {
      note('nonce_too_low');
      return reply({ error: { code: -32000, message: 'nonce too low' } });
    }
    const existing = this.pooled(tx.from, tx.nonce);
    if (existing?.hash === tx.hash) {
      note('already_known');
      return reply({ error: { code: -32000, message: 'already known' } });
    }
    if (existing && (tx.maxFeePerGas * 10n < existing.maxFeePerGas * 11n || tx.maxPriorityFeePerGas * 10n < existing.maxPriorityFeePerGas * 11n)) {
      note('replacement_underpriced');
      return reply({ error: { code: -32000, message: 'replacement transaction underpriced' } });
    }
    const hook = await this.onSend?.(tx, endpoint);
    if (hook && typeof hook === 'object') {
      if (hook.keep) this.admit(tx);
      note(`error:${hook.error}`);
      return reply({ error: { code: -32000, message: hook.error } });
    }
    if (hook === 'network') {
      note('network');
      throw new TypeError('Network connection lost.');
    }
    if (hook === 'hang') {
      note('hang');
      return hang(signal);
    }
    this.admit(tx);
    if (hook === 'accept_then_hang') {
      note('accepted_then_hang');
      return hang(signal);
    }
    note(existing ? 'replaced' : 'accepted');
    return reply({ result: tx.hash });
  }
}
