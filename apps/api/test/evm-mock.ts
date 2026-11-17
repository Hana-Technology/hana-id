// A fake EVM chain behind a global fetch stub, for the EVM relayer object and its RPC client (evm-relayer.ts,
// evm/sponsor-chain.ts): two endpoints (a primary and a fallback) of one chain, each of which can be made to fail.
// Like a node's pool, it checks a raw transaction's nonce against the sender's mined count, replaces a pending one only
// with both fees at least 10% higher, answers `already known` for one it holds, and counts `pending` as the mined count
// plus the pool's run of consecutive nonces from there. Transactions are mined only when a test calls `mine`, into a
// block followed by `confirmations` empty ones; counts are kept per block, so `safe` (head − `safeDepth`) and a block
// number answer what was mined then. `unmine` is a reorg (mined transactions back to the pool, or dropped), and
// `staleCounts` an endpoint that answers fixed counts (a node behind, or one that over-reports). The sender is
// recovered from each raw transaction's signature (type 2 and type 4).
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { vi } from 'vitest';

export type Hex = `0x${string}`;

export const PRIMARY_RPC = 'https://evm-primary.test.invalid';
export const FALLBACK_RPC = 'https://evm-fallback.test.invalid';

/** How an endpoint answers: normally, not at all (network error), with an HTTP 503, rate limited, for another chain, or with garbage. */
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
export type SendHook =
  | { error: string; keep?: boolean }
  | 'hang'
  | 'accept_then_hang'
  | 'network'
  | 'accept_then_network'
  | 'accept'
  | undefined;

type Item = Uint8Array | Item[];

const hex = (b: Uint8Array): Hex => `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;
const fromHex = (h: string): Uint8Array => {
  const out = new Uint8Array((h.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(2 + 2 * i, 4 + 2 * i), 16);
  return out;
};
const utf8 = (t: string): Uint8Array => new TextEncoder().encode(t);
const NONCE_SELECTOR = `0x${Array.from(keccak_256(utf8('nonce()')).subarray(0, 4), (x) => x.toString(16).padStart(2, '0')).join('')}`;
const EXECUTED = `0x${Array.from(keccak_256(utf8('Executed(bytes32,uint256,uint256)')), (x) => x.toString(16).padStart(2, '0')).join('')}`;
const big = (b: Uint8Array): bigint => (b.length === 0 ? 0n : BigInt(hex(b)));

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
  let start: number;
  let len: number;
  if (p < 0xf8) {
    start = pos + 1;
    len = p - 0xc0;
  } else {
    const ll = p - 0xf7;
    len = Number(big(b.subarray(pos + 1, pos + 1 + ll)));
    start = pos + 1 + ll;
  }
  const items: Item[] = [];
  let at = start;
  while (at < start + len) {
    const d = decode(b, at);
    items.push(d.item);
    at = d.end;
  }
  return { item: items, end: start + len };
}

/** Item encodings of a list's elements (for rebuilding the unsigned payload). */
function elementSpans(b: Uint8Array): Uint8Array[] {
  const p = b[0]!;
  const start = p < 0xf8 ? 1 : 1 + (p - 0xf7);
  const spans: Uint8Array[] = [];
  let at = start;
  while (at < b.length) {
    const d = decode(b, at);
    spans.push(b.subarray(at, d.end));
    at = d.end;
  }
  return spans;
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

export function addressOf(publicKeyUncompressed: Uint8Array): Hex {
  return hex(keccak_256(publicKeyUncompressed.subarray(1)).subarray(-20));
}

/** Decodes a signed type-2 or type-4 transaction and recovers its sender. */
export function decodeRawTx(raw: Hex): MockTx {
  const b = fromHex(raw);
  const type = b[0];
  if (type !== 2 && type !== 4) throw new Error('unsupported tx type');
  const body = b.subarray(1);
  const fields = decode(body, 0).item as Item[];
  const spans = elementSpans(body);
  const n = fields.length;
  if ((type === 2 && n !== 12) || (type === 4 && n !== 13)) throw new Error('bad field count');
  const unsignedBody = concat(...spans.slice(0, n - 3));
  const signingHash = keccak_256(concat(Uint8Array.of(type), listHeader(unsignedBody.length), unsignedBody));
  const yParity = Number(big(fields[n - 3] as Uint8Array));
  const r = big(fields[n - 2] as Uint8Array);
  const s = big(fields[n - 1] as Uint8Array);
  const pub = new secp256k1.Signature(r, s).addRecoveryBit(yParity).recoverPublicKey(signingHash).toRawBytes(false);
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

const hang = (signal: AbortSignal | null | undefined): Promise<never> =>
  new Promise((_, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')));
  });

export class EvmMock {
  readonly chainId: number;
  readonly urls: string[];
  /** Per endpoint (index into `urls`). */
  readonly modes: EndpointMode[];
  /** An endpoint that answers fixed counts (a node behind the chain, or one that over-reports), by index. */
  readonly staleCounts = new Map<number, { latest: number; pending: number; confirmed?: number }>();
  /** The head block's number; `safe` is `safeDepth` below it. */
  blockNumber = 100;
  safeDepth = 2;
  /** Whether endpoints answer the `safe` tag (else an error, as some nodes do). */
  supportsSafe = true;
  /** A large response (bytes of padding) for the next eth_getTransactionCount on endpoint 0, then cleared. */
  hugeResponse = 0;
  /** Mined counts per block (a snapshot at each block that changed them). */
  private readonly history: { number: number; counts: Map<string, number> }[] = [];
  /** Mined count per sender (lowercase address). */
  readonly minedCount = new Map<string, number>();
  /** Pending pool per sender: nonce → transaction. */
  readonly pool = new Map<string, Map<number, MockTx>>();
  readonly minedTxs: MockTx[] = [];
  /** Every eth_sendRawTransaction that reached an endpoint's pool logic, in order. */
  readonly broadcasts: { endpoint: number; tx: MockTx; outcome: string }[] = [];
  /** Every call, in arrival order. */
  readonly calls: { endpoint: number; method: string }[] = [];
  /** Optional hook for a send that passed the pool's checks. */
  onSend?: (tx: MockTx, endpoint: number) => SendHook | Promise<SendHook>;
  /** Called (and awaited) when a read of `method` arrives, before it is answered (to hold or crash mid-read). */
  onRead?: (method: string, endpoint: number) => Promise<void> | void;
  /** Per endpoint, how many blocks its head is behind the chain's (a lagging node: counts and receipts as of its head). */
  readonly lag: number[] = [];
  /** Per endpoint, how many blocks it claims beyond the chain's head (a node that inflates its head). */
  readonly headBoost: number[] = [];
  /** Accounts' delegate nonce() (their Execute nonce), and the Executed logs mined. */
  readonly accountNonces = new Map<string, bigint>();
  readonly executedLogs: { address: string; topics: string[]; transactionHash: string; blockNumber: number }[] = [];
  /** Transactions that, when mined, run an Execute: the account's nonce moves on and an Executed(digest) log appears. */
  private readonly executions = new Map<string, { account: string; digest: string }>();
  /** Receipts answer null (a node that hasn't indexed them yet). */
  hideReceipts = false;
  /** The next N receipt reads fail (no answer). */
  receiptFailures = 0;
  /** Answers for eth_getTransactionCount that throw a network error, for the next N calls on every endpoint. */
  countFailures = 0;
  private readonly receipts = new Map<string, { tx: MockTx; block: number }>();

  constructor(opts: { chainId?: number; urls?: string[] } = {}) {
    this.chainId = opts.chainId ?? 31337;
    this.urls = opts.urls ?? [PRIMARY_RPC, FALLBACK_RPC];
    this.modes = this.urls.map(() => 'up');
  }

  install(): this {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const endpoint = this.urls.findIndex((u) => url === u || url === `${u}/`);
      if (endpoint < 0) throw new Error(`Unexpected fetch to ${url}`);
      const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
      this.calls.push({ endpoint, method: body.method });
      const mode = this.modes[endpoint]!;
      if (mode === 'down') throw new TypeError('Network connection lost.');
      if (mode === 'http503') return new Response('<html>503</html>', { status: 503 });
      if (mode === 'garbage') return new Response('{"jsonrpc":"2.0","id":0,"result":"0x1"}', { status: 200 });
      const reply = (r: { result: unknown } | { error: { code: number; message: string } }) => Response.json({ jsonrpc: '2.0', id: body.id, ...r });
      if (mode === 'rate_limited') return reply({ error: { code: -32005, message: 'limit exceeded' } });
      if (body.method === 'eth_chainId') return reply({ result: `0x${(mode === 'wrong_chain' ? this.chainId + 1 : this.chainId).toString(16)}` });
      if (body.method === 'eth_sendRawTransaction') return this.sendRaw(endpoint, body.params[0] as Hex, init?.signal, reply);
      await this.onRead?.(body.method, endpoint);
      const head = this.blockNumber - (this.lag[endpoint] ?? 0) + (this.headBoost[endpoint] ?? 0);
      if (body.method === 'eth_blockNumber') return reply({ result: `0x${head.toString(16)}` });
      if (body.method === 'eth_getTransactionCount') {
        if (this.countFailures > 0) {
          this.countFailures--;
          throw new TypeError('Network connection lost.');
        }
        const [address, tag] = body.params as [string, string];
        if (tag === 'safe' && !this.supportsSafe) return reply({ error: { code: -32602, message: 'invalid block tag' } });
        const stale = this.staleCounts.get(endpoint);
        let n: number;
        const lagging = (this.lag[endpoint] ?? 0) > 0;
        if (stale) n = tag === 'latest' ? stale.latest : tag === 'pending' ? stale.pending : (stale.confirmed ?? stale.latest);
        else if (tag === 'latest') n = lagging ? this.countAt(address, head) : this.mined(address);
        // A lagging node's pool view is its head's: what it has mined, nothing pending beyond.
        else if (tag === 'pending') n = lagging ? this.countAt(address, head) : this.pendingCount(address);
        else if (tag === 'safe') n = this.countAt(address, head - this.safeDepth);
        else {
          const at = Number(BigInt(tag));
          if (at > head) return reply({ error: { code: -32000, message: 'header not found' } });
          n = this.countAt(address, at);
        }
        if (endpoint === 0 && this.hugeResponse > 0) {
          const pad = 'x'.repeat(this.hugeResponse);
          this.hugeResponse = 0;
          return new Response(`{"jsonrpc":"2.0","id":${body.id},"result":"0x${n.toString(16)}","pad":"${pad}"}`, { status: 200 });
        }
        return reply({ result: `0x${n.toString(16)}` });
      }
      if (body.method === 'eth_getTransactionReceipt') {
        if (this.receiptFailures > 0) {
          this.receiptFailures--;
          throw new TypeError('Network connection lost.');
        }
        const found = this.hideReceipts ? undefined : this.receipts.get((body.params[0] as string).toLowerCase());
        const got = found && found.block <= head ? found : undefined;
        if (!got) return reply({ result: null });
        return reply({
          result: { transactionHash: got.tx.hash, status: '0x1', blockNumber: `0x${got.block.toString(16)}`, gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00', logs: [] },
        });
      }
      if (body.method === 'eth_getBlockByNumber') {
        const tag = body.params[0] as string;
        if (tag === 'safe' && !this.supportsSafe) return reply({ error: { code: -32602, message: 'invalid block tag' } });
        const n = tag === 'safe' ? head - this.safeDepth : tag === 'latest' ? head : Number(BigInt(tag));
        return reply({ result: { number: `0x${n.toString(16)}`, timestamp: '0x6553f100', baseFeePerGas: '0x1' } });
      }
      if (body.method === 'eth_call') {
        // Only the delegate's nonce() on an account: its Execute nonce (as of now: tests set it with executes()).
        const [call] = body.params as [{ to: string; data: string }];
        if (call.data !== NONCE_SELECTOR) return reply({ error: { code: 3, message: 'execution reverted' } });
        return reply({ result: `0x${(this.accountNonces.get(call.to.toLowerCase()) ?? 0n).toString(16).padStart(64, '0')}` });
      }
      if (body.method === 'eth_getLogs') {
        const [q] = body.params as [{ address: string; topics: (string | null)[]; fromBlock: string; toBlock: string }];
        const from = Number(BigInt(q.fromBlock));
        const to = Math.min(Number(BigInt(q.toBlock)), head);
        const logs = this.executedLogs.filter((l) => l.address === q.address.toLowerCase() && l.blockNumber >= from && l.blockNumber <= to && q.topics.every((t, i) => t === null || l.topics[i] === t.toLowerCase()));
        return reply({ result: logs.map((l) => ({ address: l.address, topics: l.topics, data: '0x', transactionHash: l.transactionHash, blockNumber: `0x${l.blockNumber.toString(16)}` })) });
      }
      return reply({ error: { code: -32601, message: 'method not found' } });
    });
    return this;
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

  /** Starts a sender at mined count `n`, long confirmed (as a funded relayer that sent before). */
  setMined(address: string, n: number): void {
    this.minedCount.set(address.toLowerCase(), n);
    this.history.unshift({ number: 0, counts: new Map([[address.toLowerCase(), n]]) });
  }

  /** Mining `hash` runs the batch `digest` on `account` (its nonce moves on, an Executed log appears). */
  executes(hash: string, account: string, digest: string): void {
    this.executions.set(hash.toLowerCase(), { account: account.toLowerCase(), digest });
  }

  /** Adds `n` empty blocks. */
  addBlocks(n: number): void {
    this.blockNumber += n;
  }

  private snapshot(): void {
    this.history.push({ number: this.blockNumber, counts: new Map(this.minedCount) });
  }

  pendingCount(address: string): number {
    const a = address.toLowerCase();
    const pool = this.pool.get(a);
    let n = this.mined(a);
    while (pool?.has(n)) n++;
    return n;
  }

  /** The pool's transaction for a sender's nonce. */
  pooled(address: string, nonce: number): MockTx | undefined {
    return this.pool.get(address.toLowerCase())?.get(nonce);
  }

  /** Every pooled transaction of a sender, by nonce. */
  pooledAll(address: string): MockTx[] {
    return [...(this.pool.get(address.toLowerCase())?.values() ?? [])].sort((x, y) => x.nonce - y.nonce);
  }

  /**
   * Mines a sender's pool from its mined count, in nonce order (at most `max`), into one new block, then
   * `confirmations` empty blocks (5 by default: past the relayer's 3). Returns what was mined.
   */
  mine(address: string, max = Number.POSITIVE_INFINITY, opts: { confirmations?: number } = {}): MockTx[] {
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
      const ex = this.executions.get(tx.hash);
      if (ex) {
        this.accountNonces.set(ex.account, (this.accountNonces.get(ex.account) ?? 0n) + 1n);
        this.executedLogs.push({ address: ex.account, topics: [EXECUTED, ex.digest.toLowerCase()], transactionHash: tx.hash, blockNumber: this.blockNumber });
      }
      out.push(tx);
      n++;
    }
    this.minedCount.set(a, n);
    this.snapshot();
    this.addBlocks(opts.confirmations ?? 5);
    return out;
  }

  /**
   * A reorg: the sender's last `count` mined transactions are un-mined (back into the pool, or gone with `drop`), and
   * every block since the first of them counts them no more. Only for unconfirmed blocks, as on a real chain.
   */
  unmine(address: string, count: number, opts: { drop?: boolean } = {}): MockTx[] {
    const a = address.toLowerCase();
    const mine = this.minedTxs.filter((t) => t.from === a);
    const gone = mine.slice(-count);
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

  /** Another sender's transactions took nonces up to `upTo` and were mined (the key was used elsewhere), confirmed. */
  foreignMine(address: string, upTo: number): void {
    const a = address.toLowerCase();
    const pool = this.pool.get(a);
    for (let n = this.mined(a); n < upTo; n++) pool?.delete(n);
    this.blockNumber++;
    this.minedCount.set(a, upTo);
    this.snapshot();
    this.addBlocks(5);
  }

  /** Drops a pooled transaction (evicted). */
  drop(address: string, nonce: number): void {
    this.pool.get(address.toLowerCase())?.delete(nonce);
  }

  /** Puts a transaction in the pool without any checks (a foreign one, or a node that lies). */
  admit(tx: MockTx): void {
    const a = tx.from.toLowerCase();
    const pool = this.pool.get(a) ?? new Map<number, MockTx>();
    this.pool.set(a, pool);
    pool.set(tx.nonce, tx);
  }

  private async sendRaw(endpoint: number, raw: Hex, signal: AbortSignal | null | undefined, reply: (r: { result: unknown } | { error: { code: number; message: string } }) => Response): Promise<Response> {
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
    const a = tx.from.toLowerCase();
    if (tx.nonce < this.mined(a)) {
      note('nonce_too_low');
      return reply({ error: { code: -32000, message: 'nonce too low' } });
    }
    const existing = this.pooled(a, tx.nonce);
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
    if (hook === 'accept_then_network') {
      note('accepted_then_network');
      throw new TypeError('Network connection lost.');
    }
    note(existing ? 'replaced' : 'accepted');
    return reply({ result: tx.hash });
  }
}
