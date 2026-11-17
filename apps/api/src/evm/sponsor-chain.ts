// EVM JSON-RPC for gas sponsorship (D837): one chain's endpoints, in order, the keyed URL from the secret
// `EVM_SPONSOR_RPC_<chainId>` when it is set, then the manifest's `rpc`, then its `rpcFallback`. The relayer object
// (evm-relayer.ts) and the sponsorship handlers (evm/sponsor.ts) both read the chain through this one client.
//
// - Every endpoint's `eth_chainId` is checked before anything else is asked of it, and the answer kept per isolate for
//   10 minutes: an endpoint that answers for another chain is never read from and never sent to (its nonce counts
//   would be another chain's). A failed check is remembered for 30 s, so a dead endpoint isn't asked again at once
//   (unless every endpoint failed it: then all are tried).
// - Per client (one per critical section): an endpoint that gave no answer once (network, timeout, HTTP error) is
//   skipped for the rest of the section, and at most `maxRequests` fetches are made (the free plan allows 50
//   subrequests an invocation); past it every call fails as `unavailable` and a broadcast is `unsent`.
// - Response bodies are read as a stream and abandoned past EVM_RPC_MAX_RESPONSE_CHARS bytes.
// - Reads fail over: no answer, an HTTP error, a body that is not a JSON-RPC answer, a malformed result, or a node
//   that says it is busy or rate limited moves to the next endpoint. Any other JSON-RPC error is the chain's answer
//   (an `eth_call` revert, say) and is thrown as `rpc_error`, never retried elsewhere.
// - A broadcast goes to each endpoint in turn with the SAME raw transaction until one accepts it. Its outcome is
//   `accepted` (an endpoint took it, or already had it), `rejected` (every endpoint it reached refused it with a
//   definite pool rejection, so no node holds it), `unknown` (some endpoint may hold it: no answer, a timeout, an
//   answer that is not a rejection) or `unsent` (no endpoint could be asked, so nothing left the Worker).
//
// SECURITY: URLs can carry a provider's API key, so no URL, response body or node message is ever logged or put in an
// error message: errors carry a fixed message, the failure kind, and for `rpc_error` the JSON-RPC code and the node's
// message (bounded, for the caller to classify; never logged by this module).
import { keccak_256 } from '@noble/hashes/sha3';
import type { Env } from '../env.ts';
import { log } from '../log.ts';

export type Hex = `0x${string}`;

/** One attempt's limit: a broadcast can wait this long per endpoint. */
export const EVM_RPC_TIMEOUT_MS = 8_000;
/** The largest response body read, bytes (a receipt with many logs is far smaller). */
export const EVM_RPC_MAX_RESPONSE_CHARS = 2 * 1024 * 1024;
/** How long an endpoint's verified chain ID is trusted per isolate. */
export const EVM_RPC_CHAIN_CHECK_TTL_MS = 10 * 60_000;
/** How long a failed chain-ID check keeps an endpoint out (per isolate). */
export const EVM_RPC_CHAIN_CHECK_RETRY_MS = 30_000;
/** Fetches per client unless the caller says otherwise. */
export const EVM_RPC_DEFAULT_MAX_REQUESTS = 45;
/** At most this many characters of a node's error message are kept (for classification only). */
const MAX_NODE_MESSAGE_CHARS = 300;
/** At most this many characters of revert data are kept on an `rpc_error` (2 KiB of bytes). */
const MAX_ERROR_DATA_CHARS = 2 + 4096;

/**
 * Why a call failed: `unavailable` (no endpoint gave a usable answer), `wrong_chain` (every endpoint that answered
 * eth_chainId is on another chain), `rpc_error` (the chain's own JSON-RPC error, e.g. a revert), `bad_response`
 * (a result of the wrong shape from every endpoint that answered).
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

/** A definite pool rejection of a raw transaction (no node took it). */
export type EvmRejection =
  | 'nonce_too_low'
  | 'nonce_too_high'
  | 'replacement_underpriced'
  | 'underpriced'
  | 'insufficient_funds'
  | 'fee_below_base_fee'
  | 'gas_limit'
  | 'invalid_transaction';

export type EvmBroadcast =
  | { kind: 'accepted'; hash: Hex }
  | { kind: 'rejected'; reason: EvmRejection }
  | { kind: 'unknown' }
  | { kind: 'unsent' };

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
  logs: EvmLog[];
}

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
 * The chain's endpoints in order: `EVM_SPONSOR_RPC_<chainId>` (a secret, so a keyed provider URL never sits in the
 * manifest; https only, anything else is ignored), then `rpc`, then `rpcFallback`; each once.
 */
export function sponsorRpcUrls(env: Partial<Record<string, unknown>> | Env, chain: SponsorChainEndpoints): string[] {
  const keyed = (env as Record<string, unknown>)[`EVM_SPONSOR_RPC_${chain.chainId}`];
  const urls: string[] = [];
  if (typeof keyed === 'string' && keyed.length > 0 && keyed.length <= 2048) {
    try {
      if (new URL(keyed).protocol === 'https:') urls.push(keyed);
    } catch {
      // Not a URL: ignored (never logged: it is a secret).
    }
  }
  for (const u of [chain.rpc, chain.rpcFallback]) if (u && !urls.includes(u)) urls.push(u);
  return urls;
}

/** Endpoint URL → the chain ID it answered and when, per isolate (EVM_RPC_CHAIN_CHECK_TTL_MS). */
const verifiedChains = new Map<string, { chainId: number; at: number }>();
/** Endpoint URL → when its chain-ID check last failed (no answer), per isolate (EVM_RPC_CHAIN_CHECK_RETRY_MS). */
const failedChecks = new Map<string, number>();

/** Forgets the per-isolate chain checks (tests). */
export function forgetVerifiedChains(): void {
  verifiedChains.clear();
  failedChecks.clear();
}

/** One endpoint's view of an address's transaction counts (EIP-155 nonces). */
export interface EndpointCounts {
  /** Index into the client's endpoints (never the URL). */
  endpoint: number;
  /** Mined at the latest block. */
  latest: number;
  /** Mined plus the node's executable pool. */
  pending: number;
  /** Mined at a block past reorg risk: `safe` where the chain has it, else `latest` − confirmations. */
  confirmed: number;
}

type Attempt<T> = { ok: true; value: T } | { ok: false; failure: 'unavailable' | 'wrong_chain' | 'bad_response' } | { ok: false; failure: 'rpc_error'; error: EvmRpcError };

/** A JSON-RPC error that says the node is busy, limited or behind: ask the next endpoint. */
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
  if (/invalid sender|invalid chain id|chain id mismatch|rlp|oversized data|tx type not supported|transaction type not supported|invalid transaction|invalid signature|tip higher than fee cap|max priority fee per gas higher/u.test(m)) return 'invalid_transaction';
  return null;
}

/**
 * One chain's JSON-RPC, over its endpoints in order (see the file header). `fetchImpl` is the global fetch unless a
 * test passes its own; `timeoutMs` bounds each attempt.
 */
export class SponsorChain {
  readonly chainId: number;
  private readonly urls: readonly string[];
  private readonly timeoutMs: number;
  private readonly maxRequests: number;
  private id = 0;
  private used = 0;
  /** Endpoints that gave no answer during this client's life (skipped from then on). */
  private readonly down = new Set<number>();

  constructor(chainId: number, urls: readonly string[], opts: { timeoutMs?: number; maxRequests?: number } = {}) {
    if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('chainId must be a positive safe integer');
    if (urls.length === 0) throw new Error('No RPC endpoint');
    this.chainId = chainId;
    this.urls = [...urls];
    this.timeoutMs = opts.timeoutMs ?? EVM_RPC_TIMEOUT_MS;
    this.maxRequests = opts.maxRequests ?? EVM_RPC_DEFAULT_MAX_REQUESTS;
  }

  /** How many endpoints the client asks, in order (for logs and tests; never the URLs). */
  get endpointCount(): number {
    return this.urls.length;
  }

  /** Fetches made so far, and whether the budget is used up. */
  get requestsUsed(): number {
    return this.used;
  }

  get exhausted(): boolean {
    return this.used >= this.maxRequests;
  }

  /**
   * The address's counts from EVERY endpoint that answers all of them (latest, pending, and the confirmed count: at
   * the `safe` block when `safeTag`, falling back to, and otherwise at, the latest block number − `confirmations`). For
   * the caller to cross-check: never throws, an empty list when none answered.
   */
  async countsEach(address: Hex, opts: { confirmations: number; safeTag: boolean }): Promise<EndpointCounts[]> {
    checkAddress(address);
    const out: EndpointCounts[] = [];
    const count = (r: unknown): number => {
      const n = quantity(r);
      if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('count too large');
      return Number(n);
    };
    for (const i of this.order()) {
      const latest = await this.attempt(i, 'eth_getTransactionCount', [address, 'latest'], count);
      if (!latest.ok) continue;
      const pending = await this.attempt(i, 'eth_getTransactionCount', [address, 'pending'], count);
      if (!pending.ok) continue;
      let confirmed: Attempt<number> | null = null;
      if (opts.safeTag) {
        confirmed = await this.attempt(i, 'eth_getTransactionCount', [address, 'safe'], count);
        if (!confirmed.ok && confirmed.failure !== 'rpc_error') continue;
        if (!confirmed.ok) confirmed = null;
      }
      if (!confirmed) {
        const head = await this.attempt(i, 'eth_blockNumber', [], quantity);
        if (!head.ok) continue;
        const at = head.value > BigInt(opts.confirmations) ? head.value - BigInt(opts.confirmations) : 0n;
        confirmed = await this.attempt(i, 'eth_getTransactionCount', [address, toQuantity(at)], count);
        if (!confirmed.ok) continue;
      }
      out.push({ endpoint: i, latest: latest.value, pending: pending.value, confirmed: confirmed.value });
    }
    return out;
  }

  /** Endpoint indexes to try, in order: those not down for this client. */
  private order(): number[] {
    return this.urls.map((_, i) => i).filter((i) => !this.down.has(i));
  }

  // ---- reads ----

  /** `eth_getTransactionCount` at `latest` (mined), `pending` (mined and the node's executable pool) or `safe`. */
  async transactionCount(address: Hex, tag: 'latest' | 'pending' | 'safe'): Promise<number> {
    checkAddress(address);
    return this.read('eth_getTransactionCount', [address, tag], (r) => {
      const n = quantity(r);
      if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('count too large');
      return Number(n);
    });
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
  async call(req: EvmCallRequest, opts: { block?: 'latest' | 'pending'; stateOverride?: EvmStateOverride } = {}): Promise<Hex> {
    checkAddress(req.to);
    if (req.from !== undefined) checkAddress(req.from);
    if (!DATA_RE.test(req.data)) throw new Error('call data must be 0x hex bytes');
    const tx: Record<string, string> = { to: req.to, data: req.data };
    if (req.from !== undefined) tx.from = req.from;
    if (req.gas !== undefined) tx.gas = toQuantity(req.gas);
    if (req.value !== undefined) tx.value = toQuantity(req.value);
    const params: unknown[] = [tx, opts.block ?? 'latest'];
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

  /** Any read, with failover; `parse` turns the result into a value or throws (then the next endpoint is asked). */
  async read<T>(method: string, params: unknown[], parse: (result: unknown) => T): Promise<T> {
    let wrongChain = 0;
    let badResponse = 0;
    const order = this.order();
    for (const [k, i] of order.entries()) {
      const attempt = await this.attempt(i, method, params, parse);
      if (attempt.ok) return attempt.value;
      if (attempt.failure === 'rpc_error') throw attempt.error;
      if (attempt.failure === 'wrong_chain') wrongChain++;
      if (attempt.failure === 'bad_response') badResponse++;
      if (k + 1 < order.length) log({ event: 'evm_rpc_failover', chainId: this.chainId, method, rpcEndpoint: i, nextRpcEndpoint: order[k + 1]!, code: attempt.failure }, 'warn');
    }
    if (order.length > 0 && wrongChain === order.length) throw new EvmRpcError('wrong_chain');
    if (badResponse > 0 && badResponse + wrongChain === order.length) throw new EvmRpcError('bad_response');
    throw new EvmRpcError('unavailable');
  }

  // ---- broadcast ----

  /** Sends `raw` to each endpoint in turn until one takes it (see the file header). Never throws. */
  async broadcast(raw: Hex): Promise<EvmBroadcast> {
    if (!DATA_RE.test(raw) || raw.length < 4) return { kind: 'unsent' };
    let reached = false;
    let uncertain = false;
    const rejections: EvmRejection[] = [];
    for (const i of this.order()) {
      if (this.exhausted) break;
      const checked = await this.checkChain(i);
      if (checked !== 'ok') {
        if (i + 1 < this.urls.length) log({ event: 'evm_rpc_failover', chainId: this.chainId, method: 'eth_sendRawTransaction', rpcEndpoint: i, nextRpcEndpoint: i + 1, code: checked }, 'warn');
        continue;
      }
      if (this.exhausted) break;
      reached = true;
      const answer = await this.post(i, 'eth_sendRawTransaction', [raw]);
      if (answer.kind === 'result') {
        // The hash is always computed here (keccak256 of the raw bytes), whatever the node returned.
        if (typeof answer.result === 'string' && HASH_RE.test(answer.result)) return { kind: 'accepted', hash: rawTxHash(raw) };
        // An answer that is no hash: the node may still hold the transaction.
        uncertain = true;
      } else if (answer.kind === 'error') {
        const c = classifyRejection(answer.message);
        if (c === 'already_known') return { kind: 'accepted', hash: rawTxHash(raw) };
        if (c === null || transientRpcError(answer.code, answer.message)) uncertain = true;
        else rejections.push(c);
      } else {
        // No answer (network, timeout, an HTTP error, no JSON-RPC body): it may have been forwarded.
        uncertain = true;
      }
      if (i + 1 < this.urls.length) log({ event: 'evm_rpc_failover', chainId: this.chainId, method: 'eth_sendRawTransaction', rpcEndpoint: i, nextRpcEndpoint: i + 1, code: answer.kind === 'error' ? 'rejected' : 'unavailable' }, 'warn');
    }
    if (!reached) return { kind: 'unsent' };
    if (uncertain || rejections.length === 0) return { kind: 'unknown' };
    return { kind: 'rejected', reason: rejections.includes('nonce_too_low') ? 'nonce_too_low' : rejections[0]! };
  }

  // ---- transport ----

  private async attempt<T>(i: number, method: string, params: unknown[], parse: (result: unknown) => T): Promise<Attempt<T>> {
    if (this.down.has(i)) return { ok: false, failure: 'unavailable' };
    const checked = await this.checkChain(i);
    if (checked !== 'ok') return { ok: false, failure: checked };
    const answer = await this.post(i, method, params);
    if (answer.kind === 'none') return { ok: false, failure: 'unavailable' };
    if (answer.kind === 'error') {
      if (transientRpcError(answer.code, answer.message)) return { ok: false, failure: 'unavailable' };
      return { ok: false, failure: 'rpc_error', error: new EvmRpcError('rpc_error', { rpcCode: answer.code, nodeMessage: answer.message, data: answer.data }) };
    }
    try {
      return { ok: true, value: parse(answer.result) };
    } catch {
      return { ok: false, failure: 'bad_response' };
    }
  }

  /** `ok` once the endpoint answered this chain's ID (cached per isolate); else why it can't be used now. */
  private async checkChain(i: number): Promise<'ok' | 'unavailable' | 'wrong_chain'> {
    const url = this.urls[i]!;
    const now = Date.now();
    const known = verifiedChains.get(url);
    if (known !== undefined && now - known.at < EVM_RPC_CHAIN_CHECK_TTL_MS) return known.chainId === this.chainId ? 'ok' : 'wrong_chain';
    const failed = failedChecks.get(url);
    // A recent failure keeps it out, unless every endpoint of this client failed recently (then all are tried).
    if (failed !== undefined && now - failed < EVM_RPC_CHAIN_CHECK_RETRY_MS && this.urls.some((u) => !(now - (failedChecks.get(u) ?? -Infinity) < EVM_RPC_CHAIN_CHECK_RETRY_MS))) return 'unavailable';
    const answer = await this.post(i, 'eth_chainId', []);
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
      log({ event: 'evm_rpc_wrong_chain', chainId: this.chainId, rpcEndpoint: i, code: 'wrong_chain' }, 'error');
      return 'wrong_chain';
    }
    return 'ok';
  }

  private async post(i: number, method: string, params: unknown[]): Promise<{ kind: 'result'; result: unknown } | { kind: 'error'; code: number | null; message: string; data: Hex | null } | { kind: 'none' }> {
    if (this.used >= this.maxRequests) return { kind: 'none' };
    this.used++;
    const url = this.urls[i]!;
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
        this.down.add(i);
        return { kind: 'none' };
      }
      text = await readLimited(res, EVM_RPC_MAX_RESPONSE_CHARS);
    } catch {
      // No answer (network, timeout): skipped for the rest of this client.
      this.down.add(i);
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

/** The client for a configured chain: its endpoints from `sponsorRpcUrls`. */
export function sponsorChainFor(env: Env, chain: SponsorChainEndpoints, opts: { timeoutMs?: number; maxRequests?: number } = {}): SponsorChain {
  return new SponsorChain(chain.chainId, sponsorRpcUrls(env, chain), opts);
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

export const toQuantity = (n: bigint): Hex => {
  if (typeof n !== 'bigint' || n < 0n) throw new Error('quantity must be a non-negative bigint');
  return `0x${n.toString(16)}`;
};

function dataHex(v: unknown): Hex {
  if (typeof v !== 'string' || !DATA_RE.test(v)) throw new Error('not data');
  return v.toLowerCase() as Hex;
}

const MAX_LOGS = 256;

function parseReceipt(v: unknown, hash: Hex): EvmReceipt {
  const r = obj(v);
  if (typeof r.transactionHash !== 'string' || r.transactionHash.toLowerCase() !== hash.toLowerCase()) throw new Error('receipt of another transaction');
  const status = quantity(r.status);
  if (status !== 0n && status !== 1n) throw new Error('bad status');
  const logs = r.logs;
  if (!Array.isArray(logs) || logs.length > MAX_LOGS) throw new Error('bad logs');
  return {
    transactionHash: hash.toLowerCase() as Hex,
    status: status === 1n ? 1 : 0,
    blockNumber: quantity(r.blockNumber),
    gasUsed: quantity(r.gasUsed),
    effectiveGasPrice: quantity(r.effectiveGasPrice),
    l1Fee: r.l1Fee === undefined || r.l1Fee === null ? null : quantity(r.l1Fee),
    logs: logs.map((l) => {
      const x = obj(l);
      if (typeof x.address !== 'string' || !ADDRESS_RE.test(x.address)) throw new Error('bad log address');
      const topics = x.topics;
      if (!Array.isArray(topics) || topics.length > 4 || !topics.every((t) => typeof t === 'string' && HASH_RE.test(t))) throw new Error('bad topics');
      return { address: x.address.toLowerCase() as Hex, topics: (topics as string[]).map((t) => t.toLowerCase() as Hex), data: dataHex(x.data) };
    }),
  };
}
