// The two things EVM gas sponsorship's handlers (evm/sponsor.ts, D847) talk to, as ports: the relayer Durable Object
// (`EvmRelayer`, apps/api/src/evm-relayer.ts, the simplified fail-stop relayer of D851 built on its own branch:
// EvmRelayerPort is its pinned RPC interface, `send`, `status` and `lookup`, with its error convention) and the chain (SponsorChainPort: the subset of that branch's
// `SponsorChain` client, apps/api/src/evm/sponsor-chain.ts, the handlers use, with the same method names, shapes and
// error fields). The handlers reach them only through `sponsorPorts`, so tests replace both with fakes, and at the merge
// `sponsorPorts.chain` points at `sponsorChainFor` and `minimalSponsorChain` goes, without touching the handlers.
//
// SECURITY: nothing here logs a URL (a keyed RPC URL from the secret EVM_SPONSOR_RPC_<chainId> carries a provider key),
// a key, a signature or an address. RPC failures become SponsorRpcError with a fixed message; the handlers answer them as
// `502 evm_rpc_unavailable` and never echo a node's error text.
import { keccak_256 } from '@noble/hashes/sha3';
import type { ExecuteInput, SignedAuthorization } from '@hana-id/core/evm-sponsor';
import type { Env } from '../env.ts';
import { log } from '../log.ts';
import type { EvmSponsorChainConfig } from './sponsor-config.ts';

export type Hex = `0x${string}`;

// ---- The relayer (the relayer branch's EvmRelayer RPC interface) ----

/**
 * What the handler asks the relayer to send: the user's signed batch (core's Execute input and its signature; the
 * relayer recomputes the digest and calldata, checks the signature and the pinned implementation itself), at the
 * handler's gas and fees.
 */
export interface EvmRelayerSendRequest {
  chainId: number;
  execute: ExecuteInput;
  /** 65 bytes r ‖ s ‖ v. */
  signature: Hex;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** Present only when the account is not delegated yet: the transaction is then type 4. */
  authorization?: SignedAuthorization;
  /** The worst case the handler reserved for this transaction (wei). */
  reservedWei: bigint;
}

export interface EvmRelayerSendResult {
  transactionHash: Hex;
  relayerNonce: number;
  /** The signed transaction. Never logged, stored or returned by the handlers (its hash is checked against it). */
  raw: Hex;
  /** True when the relayer had already sent this digest: no second transaction, that one's latest version. */
  replay: boolean;
  /** executeDigest(execute) as the relayer computed it (must be the handler's). */
  digest: Hex;
}

export interface EvmRelayerStatus {
  address: Hex;
  /** Records not mined yet. */
  unmined: number;
  /** Mined records waiting for confirmed depth. */
  awaitingConfirmation: number;
  /** The oldest unmined record's age in ms, or null. */
  oldestUnminedMs: number | null;
  nextNonce: number | null;
  /** The relayer stopped taking new sends (it waits for staff), or null. */
  halted: null | { reason: string; since: number; nonce?: number };
}

/** Every hash the relayer signed for a digest's nonce (oldest first; fee bumps and a deadline cancel add to it). */
export interface EvmRelayerLookup {
  digest: Hex;
  relayerNonce: number;
  /** The mined version's hash once known, else the latest version's. */
  transactionHash: Hex;
  /** Every version, the batch's and the deadline's self-transfer. */
  hashes: Hex[];
  /**
   * `pending`; `cancelling` (past its deadline, its latest version a self-transfer); `mined` (one of its own versions
   * mined at confirmed depth: `minedHash`, `outcome`, `costWei`); `closed` (resolved by staff: `outcome`
   * `consumed_elsewhere` or `never_sent`). Remembered for at least 7 days after resolution.
   */
  state: 'pending' | 'cancelling' | 'mined' | 'closed';
  minedHash: Hex | null;
  outcome: 'execute' | 'cancel' | 'consumed_elsewhere' | 'never_sent' | null;
  /** The mined version's cost (from its receipt), or null. */
  costWei: bigint | null;
  reservedWei: bigint;
}

/** The relayer Durable Object's RPC methods the handlers call. */
export interface EvmRelayerPort {
  send(req: EvmRelayerSendRequest): Promise<EvmRelayerSendResult>;
  status(): Promise<EvmRelayerStatus>;
  lookup(digest: Hex): Promise<EvmRelayerLookup | null>;
}

/** The relayer object for a chain: one per (chainId, key index), and there is one key (D834). */
export const evmRelayerName = (chainId: number, keyIndex = 0): string => `evm-relayer-${chainId}-${keyIndex}`;

/** The relayer's refusals: thrown as `Error('evm_relayer:<code>[:<reason>]')`; a coded error means nothing was sent. */
export type EvmRelayerErrorCode = 'relayer_unconfigured' | 'relayer_misconfigured' | 'invalid_request' | 'fees_too_high' | 'wrong_chain' | 'deadline_passed' | 'relayer_busy' | 'relayer_halted' | 'daily_cap' | 'rpc_unavailable' | 'rejected' | 'internal';
const RELAYER_CODES: ReadonlySet<string> = new Set(['relayer_unconfigured', 'relayer_misconfigured', 'invalid_request', 'fees_too_high', 'wrong_chain', 'deadline_passed', 'relayer_busy', 'relayer_halted', 'daily_cap', 'rpc_unavailable', 'rejected', 'internal']);

/**
 * A relayer refusal's code and reason, or null for any other failure (an object reset, an unreachable stub): then
 * nothing is known about whether it sent (the relayer branch's `evmRelayerError`, the same rule).
 */
export function relayerRefusal(err: unknown): { code: EvmRelayerErrorCode; reason: string | null } | null {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const m = /^evm_relayer:([a-z_]+)(?::([a-z_]+))?$/u.exec(message);
  if (!m || !RELAYER_CODES.has(m[1]!)) return null;
  return { code: m[1] as EvmRelayerErrorCode, reason: m[2] ?? null };
}

/**
 * The relayer for `chainId`, or null when the Worker has no EVM_RELAYER binding (sponsorship is then unconfigured).
 * Named exactly `evm-relayer-<chainId>-0`, never with a location suffix (placement.ts): the object holds the relayer's
 * nonce sequence, so a second object for the same key would hand out the same nonces.
 */
function relayerFromBinding(env: Env, chainId: number): EvmRelayerPort | null {
  const ns = relayerBinding(env);
  if (!ns) return null;
  return ns.get(ns.idFromName(evmRelayerName(chainId))) as unknown as EvmRelayerPort;
}

/** The `EVM_RELAYER` binding (the relayer branch types it on Env), or undefined. */
export const relayerBinding = (env: Env): DurableObjectNamespace | undefined => (env as unknown as { EVM_RELAYER?: DurableObjectNamespace }).EVM_RELAYER;

/**
 * `oldestUnminedMs` as an age: the relayer reports an age; a value that looks like an epoch timestamp (after 2001) is
 * turned into one anyway, so the stuck check holds either way.
 */
export function pendingAgeMs(v: number | null, now: number): number | null {
  if (v === null || !Number.isFinite(v) || v < 0) return null;
  return v > 1e12 ? Math.max(0, now - v) : v;
}

// ---- The chain (the subset of the relayer branch's SponsorChain the handlers use) ----

export interface SponsorLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
}

export interface SponsorReceipt {
  transactionHash: Hex;
  /** 1 success, 0 reverted. */
  status: 0 | 1;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  /** The OP Stack L1 data fee the transaction paid (null where the chain reports none). */
  l1Fee: bigint | null;
  /**
   * The OP Stack operator fee (Isthmus: gasUsed × operatorFeeScalar ÷ 10^6 + operatorFeeConstant, from the receipt's
   * fields), null where the receipt reports none. Optional: a client that doesn't read it leaves it out.
   */
  operatorFee?: bigint | null;
  /** The block it was mined in (optional: a client that doesn't read it leaves it out). */
  blockNumber?: bigint | null;
  logs: SponsorLog[];
}

export interface SponsorCallRequest {
  from?: Hex;
  to: Hex;
  data: Hex;
  gas?: bigint;
}

/** eth_call's state override: per address, the code to run instead. */
export type SponsorStateOverride = Record<Hex, { code?: Hex }>;

/**
 * The chain reads the handlers make. Every method throws when no endpoint answers usably; `call` throws a revert as an
 * error with `kind: 'rpc_error'` and the revert data in `data` (isRevert tells it from a node failure).
 */
export interface SponsorChainPort {
  code(address: Hex): Promise<Hex>;
  transactionCount(address: Hex, tag: 'latest' | 'pending'): Promise<number>;
  balance(address: Hex): Promise<bigint>;
  latestBlock(): Promise<{ baseFeePerGas: bigint }>;
  call(req: SponsorCallRequest, opts?: { block?: 'latest' | 'pending'; stateOverride?: SponsorStateOverride }): Promise<Hex>;
  receipt(hash: Hex): Promise<SponsorReceipt | null>;
  /** A block's timestamp (unix seconds), for the billing record. Optional: without it the record has none. */
  blockTimestamp?(blockNumber: bigint): Promise<bigint>;
}

/** The relayer branch's EvmRpcError kinds. */
export type SponsorRpcFailure = 'unavailable' | 'wrong_chain' | 'rpc_error' | 'bad_response';

/** An RPC failure, shaped as the relayer branch's EvmRpcError: a fixed message (no URL, no node text). */
export class SponsorRpcError extends Error {
  readonly kind: SponsorRpcFailure;
  readonly rpcCode: number | null;
  /** Not for logs or answers: it can echo inputs. */
  readonly nodeMessage: string | null;
  /** `rpc_error` only: revert data when 0x hex, at most 2 KiB. */
  readonly data: Hex | null;
  constructor(kind: SponsorRpcFailure, detail: { rpcCode?: number | null; nodeMessage?: string | null; data?: Hex | null } = {}) {
    super(`EVM RPC ${kind}`);
    this.name = 'SponsorRpcError';
    this.kind = kind;
    this.rpcCode = detail.rpcCode ?? null;
    this.nodeMessage = detail.nodeMessage ?? null;
    this.data = detail.data ?? null;
  }
}

/**
 * The revert an `eth_call` failure is, with its data (null when the node gave none, e.g. out of gas), or null when it is
 * a node failure. Reads the fields both clients' errors have (`kind`, `rpcCode`, `nodeMessage`, `data`).
 */
export function revertOf(err: unknown): { revertData: Hex | null } | null {
  if (typeof err !== 'object' || err === null) return null;
  const e = err as { kind?: unknown; rpcCode?: unknown; nodeMessage?: unknown; data?: unknown };
  if (e.kind !== 'rpc_error') return null;
  const message = typeof e.nodeMessage === 'string' ? e.nodeMessage : '';
  if (e.rpcCode !== 3 && !/revert|out of gas|invalid opcode|gas required exceeds|stack underflow|invalid jump/iu.test(message)) return null;
  const data = typeof e.data === 'string' && /^0x([0-9a-fA-F]{2})*$/u.test(e.data) && e.data.length <= 2 + 4096 ? (e.data.toLowerCase() as Hex) : null;
  return { revertData: data };
}

const HEX_QTY = /^0x(0|[1-9a-f][0-9a-f]{0,63})$/u;
const HEX_DATA = /^0x([0-9a-f]{2})*$/u;
const HASH_RE = /^0x[0-9a-f]{64}$/u;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/u;
/** The largest code or return data a read accepts (24 KiB contract limit, and the delegate's bounded revert data). */
const MAX_DATA_CHARS = 2 + 2 * 49_152;
const MAX_LOGS = 64;

const bad = (): never => {
  throw new SponsorRpcError('bad_response');
};
const qty = (v: unknown): bigint => (typeof v === 'string' && HEX_QTY.test(v.toLowerCase()) ? BigInt(v) : bad());
const data = (v: unknown, maxChars = MAX_DATA_CHARS): Hex => (typeof v === 'string' && v.length <= maxChars && HEX_DATA.test(v.toLowerCase()) ? (v.toLowerCase() as Hex) : bad());
const toQty = (n: bigint): Hex => `0x${n.toString(16)}`;

/** A receipt as JSON-RPC returns it, checked field by field; null stays null (not mined yet). */
export function parseReceipt(v: unknown): SponsorReceipt | null {
  if (v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) return bad();
  const r = v as Record<string, unknown>;
  const hash = typeof r.transactionHash === 'string' ? r.transactionHash.toLowerCase() : '';
  if (!HASH_RE.test(hash)) bad();
  const status = qty(r.status);
  if (status !== 0n && status !== 1n) bad();
  if (!Array.isArray(r.logs) || r.logs.length > MAX_LOGS) bad();
  const logs = (r.logs as unknown[]).map((l: unknown): SponsorLog => {
    if (typeof l !== 'object' || l === null) return bad();
    const e = l as Record<string, unknown>;
    const address = typeof e.address === 'string' ? e.address.toLowerCase() : '';
    if (!ADDRESS_RE.test(address) || !Array.isArray(e.topics) || e.topics.length > 4) bad();
    const topics = (e.topics as unknown[]).map((t: unknown) => {
      const s = typeof t === 'string' ? t.toLowerCase() : '';
      return HASH_RE.test(s) ? (s as Hex) : bad();
    });
    return { address: address as Hex, topics, data: data(e.data) };
  });
  return {
    transactionHash: hash as Hex,
    status: Number(status) as 0 | 1,
    gasUsed: qty(r.gasUsed),
    effectiveGasPrice: qty(r.effectiveGasPrice),
    l1Fee: r.l1Fee === undefined || r.l1Fee === null ? null : qty(r.l1Fee),
    blockNumber: r.blockNumber === undefined || r.blockNumber === null ? null : qty(r.blockNumber),
    operatorFee: r.operatorFeeScalar === undefined || r.operatorFeeScalar === null ? null : (r.gasUsed !== undefined ? (qty(r.gasUsed) * qty(r.operatorFeeScalar)) / 1_000_000n : 0n) + (r.operatorFeeConstant === undefined || r.operatorFeeConstant === null ? 0n : qty(r.operatorFeeConstant)),
    logs,
  };
}

/** Per-endpoint timeout of a read. Mutable for the tests. */
export const sponsorRpcTiming = { timeoutMs: 5_000 };

/** Endpoints whose `eth_chainId` this isolate has checked: a wrong chain is never asked a read. */
const checkedChain = new Map<string, number>();

/** Forgets the isolate's chain ID checks (tests). */
export function forgetSponsorChainChecks(): void {
  checkedChain.clear();
}

/** The RPC endpoints of a chain, in order: the keyed secret `EVM_SPONSOR_RPC_<chainId>` (https only), `rpc`, `rpcFallback`. */
export function sponsorRpcUrls(env: Env, chain: Pick<EvmSponsorChainConfig, 'chainId' | 'rpc' | 'rpcFallback'>): string[] {
  const keyed = (env as unknown as Record<string, unknown>)[`EVM_SPONSOR_RPC_${chain.chainId}`];
  const urls: string[] = [];
  if (typeof keyed === 'string' && keyed.length > 0 && keyed.length <= 2048) {
    try {
      if (new URL(keyed).protocol === 'https:') urls.push(keyed);
    } catch {
      // Not a URL: ignored, never logged (it is a secret).
    }
  }
  for (const u of [chain.rpc, chain.rpcFallback]) if (u && !urls.includes(u)) urls.push(u);
  return urls;
}

interface RpcReply {
  result?: unknown;
  error?: { code?: unknown; message?: unknown; data?: unknown };
}

async function post(url: string, method: string, params: unknown[]): Promise<RpcReply> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(sponsorRpcTiming.timeoutMs),
  });
  if (!res.ok) throw new SponsorRpcError('unavailable');
  const text = await res.text();
  if (text.length > 512 * 1024) throw new SponsorRpcError('bad_response');
  const body = JSON.parse(text) as unknown;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new SponsorRpcError('bad_response');
  return body as RpcReply;
}

/** A JSON-RPC error as a SponsorRpcError (`rpc_error`), the node's message kept only for classification. */
function rpcError(e: NonNullable<RpcReply['error']>): SponsorRpcError {
  const raw = typeof e.data === 'string' ? e.data : typeof (e.data as { data?: unknown } | undefined)?.data === 'string' ? (e.data as { data: string }).data : null;
  return new SponsorRpcError('rpc_error', {
    rpcCode: typeof e.code === 'number' ? e.code : null,
    nodeMessage: typeof e.message === 'string' ? e.message.slice(0, 300) : null,
    data: raw !== null && raw.length <= 2 + 4096 && /^0x([0-9a-fA-F]{2})*$/u.test(raw) ? (raw.toLowerCase() as Hex) : null,
  });
}

/**
 * A minimal JSON-RPC client for one chain, with the relayer branch's SponsorChain method names (that branch brings the
 * full one): reads go to each endpoint in turn until one answers, an endpoint is used only after its `eth_chainId`
 * matched once in this isolate, and a JSON-RPC error (a revert among them) is an answer, thrown as `rpc_error`, never a
 * failover.
 */
export function minimalSponsorChain(env: Env, chain: Pick<EvmSponsorChainConfig, 'chainId' | 'rpc' | 'rpcFallback'>): SponsorChainPort {
  const urls = sponsorRpcUrls(env, chain);
  async function checked(url: string, index: number): Promise<void> {
    const key = `${chain.chainId}\u0000${url}`;
    if (checkedChain.get(key) === chain.chainId) return;
    const reply = await post(url, 'eth_chainId', []);
    if (reply.error || qty(reply.result) !== BigInt(chain.chainId)) {
      log({ event: 'evm_rpc_wrong_chain', code: 'evm_rpc_unavailable', rpcEndpoint: index }, 'error');
      throw new SponsorRpcError('wrong_chain');
    }
    checkedChain.set(key, chain.chainId);
  }
  async function read<T>(method: string, params: unknown[], parse: (result: unknown) => T): Promise<T> {
    for (const [i, url] of urls.entries()) {
      let reply: RpcReply;
      try {
        await checked(url, i);
        reply = await post(url, method, params);
      } catch {
        if (i + 1 < urls.length) log({ event: 'evm_rpc_failover', code: 'evm_rpc_unavailable', rpcEndpoint: i, nextRpcEndpoint: i + 1 }, 'warn');
        continue;
      }
      if (reply.error) throw rpcError(reply.error);
      try {
        return parse(reply.result);
      } catch {
        if (i + 1 < urls.length) log({ event: 'evm_rpc_failover', code: 'evm_rpc_unavailable', rpcEndpoint: i, nextRpcEndpoint: i + 1 }, 'warn');
      }
    }
    throw new SponsorRpcError('unavailable');
  }
  return {
    code: (address) => read('eth_getCode', [address, 'latest'], (v) => data(v)),
    transactionCount: (address, tag) =>
      read('eth_getTransactionCount', [address, tag], (v) => {
        const n = qty(v);
        return n > BigInt(Number.MAX_SAFE_INTEGER) ? bad() : Number(n);
      }),
    balance: (address) => read('eth_getBalance', [address, 'latest'], qty),
    latestBlock: () =>
      read('eth_getBlockByNumber', ['latest', false], (v) => {
        if (typeof v !== 'object' || v === null) return bad();
        return { baseFeePerGas: qty((v as Record<string, unknown>).baseFeePerGas) };
      }),
    call: (req, opts = {}) => {
      const tx: Record<string, string> = { to: req.to, data: req.data };
      if (req.from !== undefined) tx.from = req.from;
      if (req.gas !== undefined) tx.gas = toQty(req.gas);
      const params: unknown[] = [tx, opts.block ?? 'latest'];
      if (opts.stateOverride) params.push(Object.fromEntries(Object.entries(opts.stateOverride).map(([a, o]) => [a, o.code !== undefined ? { code: o.code } : {}])));
      return read('eth_call', params, (v) => data(v));
    },
    receipt: (hash) => read('eth_getTransactionReceipt', [hash], parseReceipt),
    blockTimestamp: (n) =>
      read('eth_getBlockByNumber', [toQty(n), false], (v) => {
        if (typeof v !== 'object' || v === null) return bad();
        return qty((v as Record<string, unknown>).timestamp);
      }),
  };
}

// ---- The seam ----

/**
 * How the handlers reach the relayer and the chain. Tests replace these (and put them back); nothing else does. At the
 * relayer branch's merge `chain` becomes its `sponsorChainFor`.
 */
export const sponsorPorts: {
  relayer: (env: Env, chainId: number) => EvmRelayerPort | null;
  chain: (env: Env, chain: Readonly<EvmSponsorChainConfig>) => SponsorChainPort;
} = { relayer: relayerFromBinding, chain: minimalSponsorChain };

export const DEFAULT_SPONSOR_PORTS = Object.freeze({ relayer: relayerFromBinding, chain: minimalSponsorChain });

/** keccak256 of bytes given as `0x` hex, as `0x` hex (a signed transaction's hash). */
export function keccakHex(hex: Hex): Hex {
  const s = hex.slice(2);
  const bytes = new Uint8Array(s.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return `0x${Array.from(keccak_256(bytes), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
