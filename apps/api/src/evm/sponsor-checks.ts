// EVM gas sponsorship's checks that need no I/O (D847): the strict request bodies, the allowlist and the cheap checks
// of a batch, both signatures, the account's delegation, the delegate's revert data and the success rule. The handlers
// (evm/sponsor.ts) run them in the order docs/api.md "EVM gas sponsorship" lists, cheapest first, every one server side:
// neither the partner page nor the vault is trusted.
import {
  type ExecuteInput,
  type SignedAuthorization,
  delegationDesignator,
  delegationTarget,
  executeDigest,
  recoverAuthorization,
  recoverExecuteSigner,
} from '@hana-id/core/evm-sponsor';
import { type EvmSponsorChainConfig, type EvmSponsorConfig, checksumEvmAddress, sponsoredTarget } from './sponsor-config.ts';
import type { Hex, SponsorLog, SponsorReceipt } from './sponsor-ports.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const onlyKeys = (o: Obj, allowed: readonly string[]): boolean => Object.keys(o).every((k) => allowed.includes(k));

/** Fixed limits (not in the manifest; docs/api.md "EVM gas sponsorship"). The manifest's per-chain numbers are D836's. */
export const EVM_SPONSOR_LIMITS = Object.freeze({
  /** Requests per IP subject per minute to prepare and send together, across every app (the app gate's window). */
  perIpPerMinute: 30,
  /** Status reads per IP subject per minute, across every app: a window of its own (status reads no chain). */
  statusPerIpPerMinute: 60,
  /** Sends per account per minute, counted after the signature, the nonce floor and the replay check. */
  sendsPerAccountPerMinute: 6,
  /**
   * A user's send attempts per UTC day that reach the chain reads, as a multiple of the manifest's `perUserPerDay`:
   * a refusal after the reads (a future nonce, no delegation, a stale authorization, too much gas) costs the user, so
   * one user can't make the sponsor read the chain without bound (D847).
   */
  attemptsPerSend: 3,
  /** Sends per app per minute, counted once the chain checks passed (the day's count and budget are the manifest's). */
  sendsPerAppPerMinute: 120,
  /** Prepares per (account, IP) per minute: one IP can't use up a chosen account's prepares for everyone else. */
  preparesPerAccountIpPerMinute: 10,
  /** Prepares per app and across the env per minute, counted before prepare's chain reads. */
  preparesPerAppPerMinute: 600,
  preparesPerEnvPerMinute: 2000,
  /** Failed sends (simulation reverted, reverted, not executed) per user per UTC day, then 429 too_many_failures. */
  failuresPerUserPerDay: 3,
  /** The day's spend at which `evm_relay_budget_high` is written (once a UTC day per chain). */
  budgetAlertPct: 80,
  /** A relayer transaction pending longer than this writes `evm_relay_stuck` (once an hour per chain). */
  stuckAfterMs: 5 * 60_000,
});

export const U256_MAX = (1n << 256n) - 1n;
export const U64_MAX = (1n << 64n) - 1n;
/** The most calls any batch may hold (the delegate's subject limit) and the most bytes of data per call (core's). */
export const MAX_CALLS = 8;
export const MAX_CALL_DATA_BYTES = 8192;
export const ZERO_ADDRESS: Hex = '0x0000000000000000000000000000000000000000';

/** A checked address: `0x` + 40 hex, all lowercase, all uppercase or exactly EIP-55; returned as EIP-55. */
export function parseAddress(v: unknown): Hex | null {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{40}$/u.test(v)) return null;
  const body = v.slice(2);
  const sum = checksumEvmAddress(v);
  if (body !== body.toLowerCase() && body !== body.toUpperCase() && sum !== v) return null;
  return sum as Hex;
}

/** A decimal string of an integer in 0..max, canonical (no sign, no leading zero, no exponent). */
export function parseUint(v: unknown, max: bigint): bigint | null {
  if (typeof v !== 'string' || !/^(0|[1-9][0-9]{0,77})$/u.test(v)) return null;
  const n = BigInt(v);
  return n <= max ? n : null;
}

/** `0x` + whole bytes of hex (any case), at most `maxBytes`; lowercase. */
export function parseData(v: unknown, maxBytes: number): Hex | null {
  if (typeof v !== 'string' || v.length > 2 + 2 * maxBytes || !/^0x([0-9a-fA-F]{2})*$/u.test(v)) return null;
  return v.toLowerCase() as Hex;
}

const parseHash = (v: unknown): Hex | null => (typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/u.test(v) ? (v.toLowerCase() as Hex) : null);
const parseChainId = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null);

export interface SponsorCall {
  to: Hex;
  value: bigint;
  data: Hex;
}

export interface PrepareRequest {
  chainId: number;
  account: Hex;
  calls: SponsorCall[];
}

export interface SendRequest extends PrepareRequest {
  executeNonce: bigint;
  deadline: bigint;
  relayer: Hex;
  minGas: bigint;
  /** 65 bytes r ‖ s ‖ v, lowercase hex. */
  signature: Hex;
  authorization: SignedAuthorization | null;
}

function parseCalls(v: unknown): SponsorCall[] | null {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_CALLS) return null;
  const out: SponsorCall[] = [];
  for (const c of v as unknown[]) {
    if (!isObj(c) || !onlyKeys(c, ['to', 'value', 'data'])) return null;
    const to = parseAddress(c.to);
    const value = parseUint(c.value, U256_MAX);
    const data = parseData(c.data, MAX_CALL_DATA_BYTES);
    if (!to || value === null || !data) return null;
    out.push({ to, value, data });
  }
  return out;
}

/** POST /v1/evm/sponsor/prepare's body: exactly `{ chainId, account, calls: [{ to, value, data }] }`. */
export function toPrepareRequest(body: unknown): PrepareRequest | null {
  if (!isObj(body) || !onlyKeys(body, ['chainId', 'account', 'calls'])) return null;
  const chainId = parseChainId(body.chainId);
  const account = parseAddress(body.account);
  const calls = parseCalls(body.calls);
  return chainId && account && calls ? { chainId, account, calls } : null;
}

const SEND_KEYS = ['chainId', 'account', 'calls', 'executeNonce', 'deadline', 'relayer', 'minGas', 'signature', 'authorization'];

function parseAuthorization(v: unknown): SignedAuthorization | null {
  if (!isObj(v) || !onlyKeys(v, ['chainId', 'address', 'nonce', 'yParity', 'r', 's'])) return null;
  // chainId 0 parses (to be refused as such, `bad_authorization`), anything else must be a positive safe integer.
  const chainId = v.chainId === 0 ? 0 : parseChainId(v.chainId);
  const address = parseAddress(v.address);
  const nonce = parseUint(v.nonce, U64_MAX - 1n);
  const r = parseHash(v.r);
  const s = parseHash(v.s);
  if (chainId === null || !address || nonce === null || (v.yParity !== 0 && v.yParity !== 1) || !r || !s) return null;
  return { chainId, address, nonce, yParity: v.yParity, r, s };
}

/** POST /v1/evm/sponsor/send's body: the prepare fields and the signed batch's, nothing else. */
export function toSendRequest(body: unknown): SendRequest | null {
  if (!isObj(body) || !onlyKeys(body, SEND_KEYS)) return null;
  const base = toPrepareRequest({ chainId: body.chainId, account: body.account, calls: body.calls });
  const executeNonce = parseUint(body.executeNonce, U64_MAX);
  const deadline = parseUint(body.deadline, U64_MAX);
  const relayer = parseAddress(body.relayer);
  const minGas = parseUint(body.minGas, U64_MAX);
  const signature = typeof body.signature === 'string' && /^0x[0-9a-fA-F]{130}$/u.test(body.signature) ? (body.signature.toLowerCase() as Hex) : null;
  const authorization = body.authorization === undefined ? null : parseAuthorization(body.authorization);
  if (!base || executeNonce === null || deadline === null || !relayer || minGas === null || !signature) return null;
  if (body.authorization !== undefined && authorization === null) return null;
  return { ...base, executeNonce, deadline, relayer, minGas, signature, authorization };
}

/** GET /v1/evm/sponsor/status's query: exactly `chainId`, a positive decimal. */
export function toStatusQuery(url: URL): { chainId: number } | null {
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 1 || keys[0] !== 'chainId') return null;
  const raw = url.searchParams.get('chainId') ?? '';
  if (!/^[1-9][0-9]{0,15}$/u.test(raw)) return null;
  const chainId = Number(raw);
  return Number.isSafeInteger(chainId) ? { chainId } : null;
}

// ---- The batch's cheap checks ----

export type CallRefusal =
  | { code: 'too_many_calls'; maxCalls: number }
  | { code: 'value_not_allowed'; callIndex: number }
  | { code: 'target_not_allowed'; callIndex: number }
  | { code: 'call_not_sponsored'; callIndex: number };

/**
 * Every call must be sponsored for this app on this chain (D835): at most `maxCallsPerBatch` calls, each value 0, never
 * to the zero address, the account itself, the delegate or the relayer (a second line behind the allowlist, which can't
 * name those), and each matching an allowlisted target and selector (or its exact calldata) within its data limit.
 */
export function callRefusal(config: EvmSponsorConfig, chain: Readonly<EvmSponsorChainConfig>, appId: string, account: Hex, calls: readonly SponsorCall[]): CallRefusal | null {
  if (calls.length > chain.maxCallsPerBatch) return { code: 'too_many_calls', maxCalls: chain.maxCallsPerBatch };
  const forbidden = new Set([ZERO_ADDRESS, account.toLowerCase(), chain.delegate.toLowerCase(), config.relayerAddress.toLowerCase()]);
  for (const [i, c] of calls.entries()) {
    if (c.value !== 0n) return { code: 'value_not_allowed', callIndex: i };
    if (forbidden.has(c.to.toLowerCase())) return { code: 'target_not_allowed', callIndex: i };
    if (!sponsoredTarget(config, appId, chain.chainId, c.to, c.data)) return { code: 'call_not_sponsored', callIndex: i };
  }
  return null;
}

/** Whether this app has any sponsored target on the chain. */
export const appSponsoredOn = (config: EvmSponsorConfig, appId: string, chainId: number): boolean =>
  Object.hasOwn(config.apps, appId) && Object.hasOwn(config.apps[appId]!, String(chainId));

/** The deadline must leave at least this long to land, and at most `deadlineMaxS`. */
export const DEADLINE_MIN_AHEAD_S = 30n;

export type BatchRefusal =
  | { code: 'wrong_relayer' }
  | { code: 'min_gas_out_of_range'; minGasFloor: bigint; maxGas: bigint }
  | { code: 'deadline_out_of_range'; serverNow: bigint; deadlineMaxS: number };

/** `relayer` is the config's; minGas within [floor, maxGasPerTx]; now + 30 s ≤ deadline ≤ now + deadlineMaxS. */
export function batchRefusal(config: EvmSponsorConfig, chain: Readonly<EvmSponsorChainConfig>, req: Pick<SendRequest, 'relayer' | 'minGas' | 'deadline'>, nowS: bigint): BatchRefusal | null {
  if (req.relayer.toLowerCase() !== config.relayerAddress.toLowerCase()) return { code: 'wrong_relayer' };
  if (req.minGas < chain.minGas || req.minGas > chain.maxGasPerTx) return { code: 'min_gas_out_of_range', minGasFloor: chain.minGas, maxGas: chain.maxGasPerTx };
  if (req.deadline < nowS + DEADLINE_MIN_AHEAD_S || req.deadline > nowS + BigInt(chain.deadlineMaxS)) return { code: 'deadline_out_of_range', serverNow: nowS, deadlineMaxS: chain.deadlineMaxS };
  return null;
}

/** The batch as core's Execute input: the implementation is always the chain's pinned delegate, never the request's. */
export const executeInput = (chain: Readonly<EvmSponsorChainConfig>, req: SendRequest): ExecuteInput => ({
  chainId: chain.chainId,
  account: req.account,
  implementation: chain.delegate as Hex,
  calls: req.calls.map((c) => ({ to: c.to, value: c.value, data: c.data })),
  nonce: req.executeNonce,
  deadline: req.deadline,
  relayer: req.relayer,
  minGas: req.minGas,
});

const toHex = (b: Uint8Array): Hex => `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;

/** The batch's digest when its signature recovers to the account, else null (a malformed or high-s one too). */
export function verifiedDigest(input: ExecuteInput, signature: Hex): Hex | null {
  try {
    if (recoverExecuteSigner(input, signature).toLowerCase() !== input.account.toLowerCase()) return null;
    return toHex(executeDigest(input));
  } catch {
    return null;
  }
}

export type AuthorizationRefusal = { code: 'bad_authorization' } | { code: 'authorization_not_pinned' } | { code: 'invalid_authorization_signature' };

/** The authorization is for this chain (never 0), names the pinned delegate and is signed by the account. */
export function authorizationRefusal(chain: Readonly<EvmSponsorChainConfig>, account: Hex, a: SignedAuthorization): AuthorizationRefusal | null {
  if (a.chainId !== chain.chainId) return { code: 'bad_authorization' };
  if (a.address.toLowerCase() !== chain.delegate.toLowerCase()) return { code: 'authorization_not_pinned' };
  try {
    if (recoverAuthorization(a).toLowerCase() !== account.toLowerCase()) return { code: 'invalid_authorization_signature' };
  } catch {
    return { code: 'invalid_authorization_signature' };
  }
  return null;
}

// ---- The account's delegation ----

export type Delegation = 'none' | 'journear' | 'other';

const bytesOf = (h: Hex): Uint8Array => {
  const s = h.slice(2);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
};

/** No code: `none`; exactly `0xef0100 ‖ the pinned delegate`: `journear`; anything else (another delegate, contract code): `other`. */
export function classifyDelegation(code: Hex, delegate: string): Delegation {
  if (code === '0x') return 'none';
  const target = delegationTarget(bytesOf(code));
  return target !== null && target.toLowerCase() === delegate.toLowerCase() ? 'journear' : 'other';
}

/** The delegation designator's code for the pinned delegate (the simulation's state override). */
export const designatorHex = (delegate: string): Hex => toHex(delegationDesignator(delegate as Hex));

// ---- The delegate's answers ----

/** `nonce()`. */
export const NONCE_CALLDATA: Hex = '0xaffed0e0';
/** keccak256("Executed(bytes32,uint256,uint256)"). */
export const EXECUTED_TOPIC: Hex = '0xfe95c3832c12555e6bdb94254f0062f3fef9fb21554e39a02734ac465105930b';
/** `CallFailed(uint256,bytes)`'s selector. */
export const CALL_FAILED_SELECTOR = '0x5c0dee5d';

/** A uint256 return value. */
export function uintReturn(data: Hex): bigint | null {
  return /^0x[0-9a-f]{64}$/u.test(data) ? BigInt(data) : null;
}

/** The most revert data an answer echoes (bytes): the delegate copies at most 1 024 of a call's into CallFailed. */
export const REVERT_DATA_MAX_BYTES = 2048;

/**
 * The revert as an answer may carry it: `revertData` only when it is well-formed hex of at most 2 KiB (else left out,
 * never truncated), and `callIndex` only from a well-formed `CallFailed(index, reason)` whose index names a call of
 * the batch.
 */
export function revertDetails(revertData: Hex | null, callCount: number): { revertData?: Hex; callIndex?: number } {
  if (revertData === null || !/^0x([0-9a-f]{2})*$/u.test(revertData) || revertData.length > 2 + 2 * REVERT_DATA_MAX_BYTES) return {};
  const out: { revertData?: Hex; callIndex?: number } = { revertData };
  if (revertData.startsWith(CALL_FAILED_SELECTOR) && revertData.length >= 2 + 8 + 64 * 3) {
    const index = BigInt(`0x${revertData.slice(10, 74)}`);
    if (index < BigInt(callCount)) out.callIndex = Number(index);
  }
  return out;
}

/** Success (D847): status 1 and an `Executed(digest, …)` log emitted by the account itself. */
export function executedIn(receipt: SponsorReceipt, account: Hex, digest: Hex): boolean {
  return receipt.status === 1 && receipt.logs.some((l: SponsorLog) => l.address.toLowerCase() === account.toLowerCase() && l.topics[0] === EXECUTED_TOPIC && l.topics[1] === digest.toLowerCase());
}
