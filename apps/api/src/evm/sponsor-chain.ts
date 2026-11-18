// EVM JSON-RPC for gas sponsorship (D851): ONE trusted endpoint for every read, and broadcasts that may also go to
// the chain's other configured URLs. The relayer object (evm-relayer.ts) and the sponsorship handlers read the chain
// through this one client.
//
// - The read endpoint is the keyed URL in the secret `EVM_SPONSOR_RPC_<chainId>` when it is set (https only), else the
//   manifest's `rpc`. Reads never fail over and never ask another endpoint: no voting, no cross-checks. A read that
//   gets no usable answer throws `unavailable`, and the caller does nothing it would need that answer for.
// - A broadcast sends the SAME raw transaction to the read endpoint, then to each other configured URL (`rpcFallback`,
//   and `rpc` when the keyed URL is the read one), until one takes it. A broadcast is always safe to repeat: it is
//   the same signed bytes. Its outcome is `accepted` (an endpoint took it, or already had it), `rejected` (every
//   endpoint it reached refused it with a definite pool rejection), `unknown` (some endpoint may hold it) or `unsent`.
// - Every endpoint's `eth_chainId` is checked before anything else is asked of it, kept per isolate for 10 minutes; a
//   failed check is remembered for 30 s. An endpoint that answers for another chain is never read from or sent to.
// - At most `maxRequests` fetches per client (one client per critical section; the free plan allows 50 subrequests
//   an invocation). Each attempt times out; bodies are read as a stream and abandoned past 2 MiB.
//
// SECURITY: a URL can carry a provider's API key, so no URL, response body or node message is ever logged or put in
// an error message. Errors carry a fixed message, the failure kind, and for `rpc_error` the JSON-RPC code, the node's
// message (bounded, for the caller to classify, never logged here) and revert data.
import { keccak_256 } from '@noble/hashes/sha3';
import type { Env } from '../env.ts';
import { log } from '../log.ts';

export type Hex = `0x${string}`;

/** One attempt's limit. */
export const EVM_RPC_TIMEOUT_MS = 8_000;
/** The largest response body read, bytes. */
export const EVM_RPC_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** How long an endpoint's verified chain ID is trusted per isolate. */
export const EVM_RPC_CHAIN_CHECK_TTL_MS = 10 * 60_000;
/** How long a failed chain-ID check keeps an endpoint out (per isolate). */
export const EVM_RPC_CHAIN_CHECK_RETRY_MS = 30_000;
/** Fetches per client unless the caller says otherwise. */
export const EVM_RPC_DEFAULT_MAX_REQUESTS = 45;
const MAX_NODE_MESSAGE_CHARS = 300;
const MAX_ERROR_DATA_CHARS = 2 + 4096;
const MAX_LOGS = 256;

/**
 * Why a read failed: `unavailable` (no usable answer), `wrong_chain` (the endpoint is on another chain),
 * `rpc_error` (the chain's own JSON-RPC error, e.g. a revert), `bad_response` (a result of the wrong shape).
 */
export type EvmRpcFailure = 'unavailable' | 'wrong_chain' | 'rpc_error' | 'bad_response';

export class EvmRpcError extends Error {
  readonly kind: EvmRpcFailure;
  /** `rpc_error` only: the JSON-RPC error code. */
  readonly rpcCode: number | null;
  /** `rpc_error` only: the node's message, at most 300 characters. Not for logs: it can echo inputs. */
  readonly nodeMessage: string | null;
  /** `rpc_error` only: the error's `data` when it is 0x hex (revert data), at most 2 KiB. */
  readonly data: Hex | null;

  constructor(kind: EvmRpcFailure, detail: { rpcCode?: number | null; nodeMessage?: string | null; data?: Hex | null } = {}) {
    super(`EVM RPC ${kind}`);
    this.name = 'EvmRpcError';
    this.kind = kind;
    this.rpcCode = detail.rpcCode ?? null;
    this.nodeMessage = detail.nodeMessage ?? null;
    this.data = detail.data ?? null;
  }
}

/** A definite pool rejection of a raw transaction (the node did not take it). */
export type EvmRejection = 'nonce_too_low' | 'nonce_too_high' | 'replacement_underpriced' | 'underpriced' | 'insufficient_funds' | 'fee_below_base_fee' | 'gas_limit' | 'oversized' | 'invalid_transaction';
/** Every classified rejection (the relayer gives each its cause: evm-relayer.ts REJECTION_CAUSE). */
export const EVM_REJECTIONS: readonly EvmRejection[] = Object.freeze(['nonce_too_low', 'nonce_too_high', 'replacement_underpriced', 'underpriced', 'insufficient_funds', 'fee_below_base_fee', 'gas_limit', 'oversized', 'invalid_transaction']);

/** `byRead`: the trusted read endpoint's own definite refusal, when it was reached and refused (else null). */
export type EvmBroadcast = { kind: 'accepted'; hash: Hex } | { kind: 'rejected'; reason: EvmRejection; byRead: EvmRejection | null } | { kind: 'unknown' } | { kind: 'unsent' };

export interface EvmLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
}

export interface EvmReceipt {
  transactionHash: Hex;
  /** 1 success, 0 reverted. */
  status: 0 | 1;
  blockNumber: bigint;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  /** OP Stack receipts' `l1Fee` (the L1 data fee, wei), null where the chain reports none. */
  l1Fee: bigint | null;
  /** OP Stack (Isthmus) operator fee: gasUsed × operatorFeeScalar ÷ 10^6 + operatorFeeConstant, null where absent. */
  operatorFee: bigint | null;
  logs: EvmLog[];
}

/** What a mined transaction cost the relayer: gasUsed × effectiveGasPrice + the L1 data fee + the operator fee. */
export const receiptCostWei = (r: EvmReceipt): bigint => r.gasUsed * r.effectiveGasPrice + (r.l1Fee ?? 0n) + (r.operatorFee ?? 0n);

export interface EvmBlock {
  number: bigint;
  timestamp: bigint;
  baseFeePerGas: bigint;
}

/** `eth_call` state override: per address, code and/or balance. */
export type EvmStateOverride = Record<Hex, { code?: Hex; balance?: bigint }>;

export interface EvmCallRequest {
  from?: Hex;
  to: Hex;
  data: Hex;
  gas?: bigint;
  value?: bigint;
}

/** What the client needs of a chain's settings (evm/sponsor-config.ts EvmSponsorChainConfig). */
export interface SponsorChainEndpoints {
  chainId: number;
  rpc: string;
  rpcFallback: string | null;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/u;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/u;
const QUANTITY_RE = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/u;
const DATA_RE = /^0x(?:[0-9a-fA-F]{2})*$/u;

/**
 * The chain's endpoints: `read`, the one trusted endpoint (the https URL in `EVM_SPONSOR_RPC_<chainId>` when set,
 * else `rpc`), and `broadcast`, `read` first and then every other configured URL, each once.
 */
export function sponsorRpcEndpoints(env: Partial<Record<string, unknown>> | Env, chain: SponsorChainEndpoints): { read: string; broadcast: string[] } {
  const keyed = (env as Record<string, unknown>)[`EVM_SPONSOR_RPC_${chain.chainId}`];
  let read = chain.rpc;
  if (typeof keyed === 'string' && keyed.length > 0 && keyed.length <= 2048) {
    try {
      if (new URL(keyed).protocol === 'https:') read = keyed;
    } catch {
      // Not a URL: ignored (never logged: it is a secret).
    }
  }
  const broadcast: string[] = [];
  for (const u of [read, chain.rpcFallback, chain.rpc]) if (u && !broadcast.includes(u)) broadcast.push(u);
  return { read, broadcast };
}

/** Endpoint URL → the chain ID it answered and when, per isolate. */
const verifiedChains = new Map<string, { chainId: number; at: number }>();
/** Endpoint URL → when its chain-ID check last failed, per isolate. */
const failedChecks = new Map<string, number>();

/** Forgets the per-isolate chain checks (tests). */
export function forgetVerifiedChains(): void {
  verifiedChains.clear();
  failedChecks.clear();
}

/** A JSON-RPC error that says the node is busy, limited or behind (no answer about the chain). */
function transientRpcError(code: number | null, message: string): boolean {
  if (code !== null && [-32005, -32016, -32603, -32002, -32001, 429].includes(code)) return true;
  return /rate|limit|too many|timeout|timed out|unavailable|busy|try again|header not found|missing trie node|not synced|syncing|capacity|overloaded/iu.test(message);
}

/** The definite pool rejection a node's error message names, or null (then nothing is known about the transaction). */
export function classifyRejection(message: string): EvmRejection | 'already_known' | null {
  const m = message.toLowerCase();
  if (/already known|known transaction|alreadyknown|already imported|already exists in the pool/u.test(m)) return 'already_known';
  if (/nonce too low|noncetoolow|oldnonce|nonce has already been used|invalid nonce.*low/u.test(m)) return 'nonce_too_low';
  if (/nonce too high|noncetoohigh|nonce gap/u.test(m)) return 'nonce_too_high';
  if (/replacement transaction underpriced|replacement fee too low|replacementnotallowed|replacement.*underpriced/u.test(m)) return 'replacement_underpriced';
  if (/insufficient funds|insufficientfunds|insufficient balance/u.test(m)) return 'insufficient_funds';
  if (/less than block base fee|fee cap less than block base fee|feecaptoolow|feecaptoolowtocompete/u.test(m)) return 'fee_below_base_fee';
  if (/transaction underpriced|feetoolow|underpriced/u.test(m)) return 'underpriced';
  if (/intrinsic gas too low|exceeds block gas limit|gas limit reached|gas too low|gaslimit/u.test(m)) return 'gas_limit';
  if (/oversized data|transaction too large|tx too large|exceeds the maximum.*size|tx size/u.test(m)) return 'oversized';
  if (/invalid sender|invalid chain id|chain id mismatch|rlp|tx type not supported|transaction type not supported|invalid transaction|invalid signature|tip higher than fee cap|max priority fee per gas higher/u.test(m)) return 'invalid_transaction';
  return null;
}

type Answer = { kind: 'result'; result: unknown } | { kind: 'error'; code: number | null; message: string; data: Hex | null } | { kind: 'none' };

/** One chain's JSON-RPC (see the file header). `timeoutMs` bounds each attempt. */
export class SponsorChain {
  readonly chainId: number;
  private readonly readUrl: string;
  private readonly broadcastUrls: readonly string[];
  private readonly timeoutMs: number;
  private readonly maxRequests: number;
  private id = 0;
  private used = 0;

  constructor(chainId: number, endpoints: { read: string; broadcast: readonly string[] }, opts: { timeoutMs?: number; maxRequests?: number } = {}) {
    if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('chainId must be a positive safe integer');
    if (!endpoints.read) throw new Error('No RPC endpoint');
    this.chainId = chainId;
    this.readUrl = endpoints.read;
    this.broadcastUrls = endpoints.broadcast.includes(endpoints.read) ? [...endpoints.broadcast] : [endpoints.read, ...endpoints.broadcast];
    this.timeoutMs = opts.timeoutMs ?? EVM_RPC_TIMEOUT_MS;
    this.maxRequests = opts.maxRequests ?? EVM_RPC_DEFAULT_MAX_REQUESTS;
  }

  /** Fetches made so far, and what is left of the budget. */
  get requestsUsed(): number {
    return this.used;
  }

  get remaining(): number {
    return Math.max(0, this.maxRequests - this.used);
  }

  // ---- reads (the trusted endpoint only) ----

  async blockNumber(): Promise<number> {
    return this.read('eth_blockNumber', [], safeNumber);
  }

  /** The `safe` block's number, or null when the endpoint has no `safe` tag (its own error, or a bad answer). */
  async safeBlockNumber(): Promise<number | null> {
    try {
      return await this.read('eth_getBlockByNumber', ['safe', false], (r) => safeNumber(obj(r).number));
    } catch (e) {
      if (e instanceof EvmRpcError && (e.kind === 'rpc_error' || e.kind === 'bad_response')) return null;
      throw e;
    }
  }

  /** `eth_getTransactionCount` at `latest`, `pending` or a block number. */
  async transactionCount(address: Hex, at: 'latest' | 'pending' | number): Promise<number> {
    checkAddress(address);
    return this.read('eth_getTransactionCount', [address, typeof at === 'number' ? toQuantity(BigInt(at)) : at], safeNumber);
  }

  async code(address: Hex): Promise<Hex> {
    checkAddress(address);
    return this.read('eth_getCode', [address, 'latest'], dataHex);
  }

  async balance(address: Hex): Promise<bigint> {
    checkAddress(address);
    return this.read('eth_getBalance', [address, 'latest'], quantity);
  }

  async latestBlock(): Promise<EvmBlock> {
    return this.read('eth_getBlockByNumber', ['latest', false], (r) => {
      const b = obj(r);
      return { number: quantity(b.number), timestamp: quantity(b.timestamp), baseFeePerGas: quantity(b.baseFeePerGas) };
    });
  }

  /** `eth_call`; a revert is an `rpc_error` with the revert data in `data`. */
  async call(req: EvmCallRequest, opts: { block?: 'latest' | 'pending' | bigint; stateOverride?: EvmStateOverride } = {}): Promise<Hex> {
    checkAddress(req.to);
    if (req.from !== undefined) checkAddress(req.from);
    if (!DATA_RE.test(req.data)) throw new Error('call data must be 0x hex bytes');
    const tx: Record<string, string> = { to: req.to, data: req.data };
    if (req.from !== undefined) tx.from = req.from;
    if (req.gas !== undefined) tx.gas = toQuantity(req.gas);
    if (req.value !== undefined) tx.value = toQuantity(req.value);
    const params: unknown[] = [tx, typeof opts.block === 'bigint' ? toQuantity(opts.block) : (opts.block ?? 'latest')];
    if (opts.stateOverride) {
      const o: Record<string, Record<string, string>> = {};
      for (const [a, v] of Object.entries(opts.stateOverride)) {
        checkAddress(a as Hex);
        o[a] = { ...(v.code !== undefined ? { code: v.code } : {}), ...(v.balance !== undefined ? { balance: toQuantity(v.balance) } : {}) };
      }
      params.push(o);
    }
    return this.read('eth_call', params, dataHex);
  }

  /** The transaction's receipt, or null while it is not mined (or unknown to the node). */
  async receipt(hash: Hex): Promise<EvmReceipt | null> {
    if (!HASH_RE.test(hash)) throw new Error('hash must be 32 bytes of 0x hex');
    return this.read('eth_getTransactionReceipt', [hash], (r) => (r === null ? null : parseReceipt(r, hash)));
  }

  /** Any read from the trusted endpoint; `parse` turns the result into a value or throws (`bad_response`). */
  async read<T>(method: string, params: unknown[], parse: (result: unknown) => T): Promise<T> {
    const checked = await this.checkChain(this.readUrl);
    if (checked !== 'ok') throw new EvmRpcError(checked);
    const answer = await this.post(this.readUrl, method, params);
    if (answer.kind === 'none') throw new EvmRpcError('unavailable');
    if (answer.kind === 'error') {
      if (transientRpcError(answer.code, answer.message)) throw new EvmRpcError('unavailable');
      throw new EvmRpcError('rpc_error', { rpcCode: answer.code, nodeMessage: answer.message, data: answer.data });
    }
    try {
      return parse(answer.result);
    } catch {
      throw new EvmRpcError('bad_response');
    }
  }

  // ---- broadcast ----

  /** Sends `raw` to each broadcast endpoint in turn until one takes it (see the file header). Never throws. */
  async broadcast(raw: Hex): Promise<EvmBroadcast> {
    if (!DATA_RE.test(raw) || raw.length < 4) return { kind: 'unsent' };
    let reached = false;
    let uncertain = false;
    const rejections: EvmRejection[] = [];
    let byRead: EvmRejection | null = null;
    for (const [i, url] of this.broadcastUrls.entries()) {
      if (this.remaining === 0) break;
      if (i > 0) log({ event: 'evm_rpc_broadcast_next', chainId: this.chainId, rpcEndpoint: i - 1, nextRpcEndpoint: i, code: 'broadcast_fallback' }, 'warn');
      if ((await this.checkChain(url)) !== 'ok' || this.remaining === 0) continue;
      reached = true;
      const answer = await this.post(url, 'eth_sendRawTransaction', [raw]);
      if (answer.kind === 'result') {
        // The hash is always computed here (keccak256 of the raw bytes), whatever the node returned.
        if (typeof answer.result === 'string' && HASH_RE.test(answer.result)) return { kind: 'accepted', hash: rawTxHash(raw) };
        uncertain = true;
      } else if (answer.kind === 'error') {
        const c = classifyRejection(answer.message);
        if (c === 'already_known') return { kind: 'accepted', hash: rawTxHash(raw) };
        if (c === null || transientRpcError(answer.code, answer.message)) uncertain = true;
        else {
          rejections.push(c);
          if (url === this.readUrl) byRead = c;
        }
      } else {
        // No answer (network, timeout, an HTTP error): it may have been forwarded.
        uncertain = true;
      }
    }
    if (!reached) return { kind: 'unsent' };
    if (uncertain || rejections.length === 0) return { kind: 'unknown' };
    return { kind: 'rejected', reason: rejections.includes('nonce_too_low') ? 'nonce_too_low' : rejections[0]!, byRead };
  }

  // ---- transport ----

  /** `ok` once the endpoint answered this chain's ID (cached per isolate); else why it can't be used now. */
  private async checkChain(url: string): Promise<'ok' | 'unavailable' | 'wrong_chain'> {
    const now = Date.now();
    const known = verifiedChains.get(url);
    if (known !== undefined && now - known.at < EVM_RPC_CHAIN_CHECK_TTL_MS) return known.chainId === this.chainId ? 'ok' : 'wrong_chain';
    const failed = failedChecks.get(url);
    if (failed !== undefined && now - failed < EVM_RPC_CHAIN_CHECK_RETRY_MS) return 'unavailable';
    const answer = await this.post(url, 'eth_chainId', []);
    let id: bigint | null = null;
    if (answer.kind === 'result') {
      try {
        id = quantity(answer.result);
      } catch {
        id = null;
      }
    }
    if (id === null) {
      failedChecks.set(url, now);
      return 'unavailable';
    }
    failedChecks.delete(url);
    const n = id <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(id) : -1;
    verifiedChains.set(url, { chainId: n, at: now });
    if (n !== this.chainId) {
      log({ event: 'evm_rpc_wrong_chain', chainId: this.chainId, rpcEndpoint: this.broadcastUrls.indexOf(url), code: 'wrong_chain' }, 'error');
      return 'wrong_chain';
    }
    return 'ok';
  }

  private async post(url: string, method: string, params: unknown[]): Promise<Answer> {
    if (this.used >= this.maxRequests) return { kind: 'none' };
    this.used++;
    const id = ++this.id;
    let text: string | null;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => undefined);
        return { kind: 'none' };
      }
      text = await readLimited(res, EVM_RPC_MAX_RESPONSE_BYTES);
    } catch {
      return { kind: 'none' };
    }
    if (text === null) return { kind: 'none' };
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { kind: 'none' };
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return { kind: 'none' };
    const b = body as { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: unknown };
    if (b.jsonrpc !== '2.0' || b.id !== id) return { kind: 'none' };
    if (b.error !== undefined && b.error !== null) {
      if (typeof b.error !== 'object') return { kind: 'none' };
      const e = b.error as { code?: unknown; message?: unknown; data?: unknown };
      const code = typeof e.code === 'number' && Number.isSafeInteger(e.code) ? e.code : null;
      const message = typeof e.message === 'string' ? e.message.slice(0, MAX_NODE_MESSAGE_CHARS) : '';
      const data = typeof e.data === 'string' && DATA_RE.test(e.data) && e.data.length <= MAX_ERROR_DATA_CHARS ? (e.data.toLowerCase() as Hex) : null;
      return { kind: 'error', code, message, data };
    }
    if (!('result' in b)) return { kind: 'none' };
    return { kind: 'result', result: b.result };
  }
}

/** The client for a configured chain (sponsorRpcEndpoints). */
export function sponsorChainFor(env: Env, chain: SponsorChainEndpoints, opts: { timeoutMs?: number; maxRequests?: number } = {}): SponsorChain {
  return new SponsorChain(chain.chainId, sponsorRpcEndpoints(env, chain), opts);
}

// ---- parsing ----

/** The body as text, or null once it passes `max` bytes (the rest is never read). */
async function readLimited(res: Response, max: number): Promise<string | null> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** keccak256 of a raw transaction's bytes: its hash. */
export function rawTxHash(raw: Hex): Hex {
  const bytes = new Uint8Array((raw.length - 2) / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(raw.slice(2 + 2 * i, 4 + 2 * i), 16);
  return `0x${Array.from(keccak_256(bytes), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function checkAddress(a: string): void {
  if (typeof a !== 'string' || !ADDRESS_RE.test(a)) throw new Error('address must be 20 bytes of 0x hex');
}

function obj(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('not an object');
  return v as Record<string, unknown>;
}

/** A JSON-RPC quantity (0x hex, no leading zeros, ≤ 256 bits). */
export function quantity(v: unknown): bigint {
  if (typeof v !== 'string' || !QUANTITY_RE.test(v)) throw new Error('not a quantity');
  return BigInt(v);
}

function safeNumber(v: unknown): number {
  const n = quantity(v);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('number too large');
  return Number(n);
}

export const toQuantity = (n: bigint): Hex => {
  if (typeof n !== 'bigint' || n < 0n) throw new Error('quantity must be a non-negative bigint');
  return `0x${n.toString(16)}`;
};

function dataHex(v: unknown): Hex {
  if (typeof v !== 'string' || !DATA_RE.test(v)) throw new Error('not data');
  return v.toLowerCase() as Hex;
}

const optionalQuantity = (v: unknown): bigint | null => (v === undefined || v === null ? null : quantity(v));

function parseReceipt(v: unknown, hash: Hex): EvmReceipt {
  const r = obj(v);
  if (typeof r.transactionHash !== 'string' || r.transactionHash.toLowerCase() !== hash.toLowerCase()) throw new Error('receipt of another transaction');
  const status = quantity(r.status);
  if (status !== 0n && status !== 1n) throw new Error('bad status');
  const logs = r.logs;
  if (!Array.isArray(logs) || logs.length > MAX_LOGS) throw new Error('bad logs');
  const gasUsed = quantity(r.gasUsed);
  const scalar = optionalQuantity(r.operatorFeeScalar);
  const constant = optionalQuantity(r.operatorFeeConstant);
  return {
    transactionHash: hash.toLowerCase() as Hex,
    status: status === 1n ? 1 : 0,
    blockNumber: quantity(r.blockNumber),
    gasUsed,
    effectiveGasPrice: quantity(r.effectiveGasPrice),
    l1Fee: optionalQuantity(r.l1Fee),
    operatorFee: scalar === null && constant === null ? null : (gasUsed * (scalar ?? 0n)) / 1_000_000n + (constant ?? 0n),
    logs: logs.map((l) => {
      const x = obj(l);
      if (typeof x.address !== 'string' || !ADDRESS_RE.test(x.address)) throw new Error('bad log address');
      const topics = x.topics;
      if (!Array.isArray(topics) || topics.length > 4 || !topics.every((t) => typeof t === 'string' && HASH_RE.test(t))) throw new Error('bad topics');
      return { address: x.address.toLowerCase() as Hex, topics: (topics as string[]).map((t) => t.toLowerCase() as Hex), data: dataHex(x.data) };
    }),
  };
}
