// The EVM relayer for gas sponsorship (D851; replaces D837's self-repairing design). One SQLite-backed Durable Object
// per chain and key, `evm-relayer-<chainId>-0`: it holds the relayer EOA's key (secret EVM_RELAY_KEYS) and its nonces.
// PRINCIPLE: do only what is safe on our own evidence; on anything odd that only WE can cause, HALT and wait for staff.
// Evidence: this object's storage, broadcast answers, and ONE trusted read endpoint (EVM_SPONSOR_RPC_<chainId>, else
// `rpc`) about the relayer's own counts and our own transaction hashes. Nothing in a user's account is evidence.
//
// A RECORD is one nonce (`rec:<nonce>` until final; its batch `dig:<digest>`, hashes only, 7 days after final). A nonce
// is never freed: once signed it ends only by a receipt, or by staffClose when the chain shows it consumed elsewhere.
//   new         send(): a verified Execute (gas ≥ intrinsic + minGas; one unmined batch per account, the account's
//               last checked on demand: `seen`) gets `nextNonce`, is signed, persisted (sync) BEFORE its broadcast.
//   → seen      a receipt of one of ITS OWN versions (the trusted endpoint), its nonce below the latest count.
//   → mined     that receipt's block ≤ confirmed (`safe`, else head − 12) AND the confirmed count past the nonce: final,
//               with minedHash, outcome (`execute`/`cancel`) and cost.
//   seen → unmined  the latest count falls to its nonce (a reorg; the raw goes out again), or the receipt vanished
//               on a complete check (it waits).   → closed  only staffClose(consumed_elsewhere).
// Each run, for each record unmined at head (nonce ≥ latest count), ONE of (a new version is signed, persisted, synced,
// then broadcast; ≤ 8 versions, every hash and raw kept until final), else a rebroadcast of the latest raw:
//   cancel    a 0-value self-transfer at the same nonce when the batch's deadline passed, it was definitely refused
//             and never accepted (at send at once: `broadcast: 'rejected'`, `rejection`), or (no endpoint ever took
//             it, rebroadcast, its nonce in no trusted pool: pending == nonce, on two runs in a row, a later record
//             waiting) so it can't hold every later nonce up; safe: same nonce, ends by whichever receipt; no halt; or
//             by staffCancel. Priced from a FRESH base fee (≥ 2 × base + tip, within the caps); a REQUIRED one impossible
//             (first cancel or reprice, nothing taken): halt `fee_cap_too_low`; a routine bump impossible: rebroadcast.
//   bump      the latest version was signed ≥ 60 s ago: both fees × 1.125 within the caps (7 batch versions, the 8th
//             for the cancel). Sends must start with room for two bumps (`maxStartingFees`).
//   (filler)  staffFill: a 0-value self-transfer at a gap nonce, a record with no batch, priced as a cancel.
// A batch refusal's CAUSE (REJECTION_CAUSE): `request` (size, shape) or `pricing` (its fees, the handler's) only
// cancel; `relayer` (funds, nonce, signing; on a FIRST version replacement_underpriced only when the read endpoint
// said so and its pending count shows something past the nonce: our key used elsewhere) halts. A halt on a refusal
// needs the trusted read endpoint's own refusal; otherwise it is counted for staff (`unconfirmedRefusal`), no halt.
//
// THE OBJECT: fresh (no `nextNonce`) → running → halted(reason). A fresh object reads the pending count ONCE (its first
// send); after that only `nextNonce + 1` per send, or staffAdoptNonce raising it, sets it. NOTHING clears a halt by
// itself: only staffResume, which re-reads the chain and refuses while any condition holds. Conditions, checked by
// every alarm run (also with no records: hourly), at send where noted, and by staffResume; none is user-triggerable:
//   nonce_consumed_elsewhere  the confirmed count is past a nonce, a complete check finds no receipt of its versions.
//   nonce_gap                 the pending count below the lowest record unmined at head (or `nextNonce`), twice running.
//   foreign_transactions      the latest or pending count is above `nextNonce` (another sender with our key).
//   relayer_cannot_send       a relayer-cause refusal of a version (our cancel's: any but its price), none accepted,
//                             or `fee_cap_too_low` (`code`; at send too; later `nonce too low`: receipts decide).
//   stuck_past_deadline       unmined at head 30 minutes after the deadline although its cancel goes out (fees, funds).
//   key_mismatch              records exist, the key isn't `relayerAddress` or their signer (a missing one: no halt).
//   storage_inconsistent      a stored invariant broken (records vs `nextNonce`, a batch entry; also at send).
// WHILE HALTED: new sends `relayer_halted`; replays answer; runs finalize, rebroadcast, bump, cancel. STAFF (recorded:
// who, when, what, note, outcome; evm-relayer-staff.ts only; each re-reads the chain):
//   staffClose(n, consumed_elsewhere)  confirmed count > n, every version's receipt read: none. Reservation kept.
//   staffCancel(n)      a record with no receipt, its nonce not mined at head: a cancel version (old ones kept).
//   staffFill(n)        no record at n, n < nextNonce, n == the pending count and the latest count ≤ n.
//   staffAdoptNonce(n)  no unmined record, n ≥ nextNonce (so above every record), latest == pending == n.
//
// Concurrency: send, the alarm and the staff tools run through one FIFO queue (`exclusive`) across their RPC awaits;
// each storage change is one `transactionSync`. `status`, `lookup`, `staffStatus` read storage only. Bounded: ≤ 45
// fetches, ≤ 20 receipt reads, ≤ 4 signatures a run (logged as `evmOps`); ≤ 8 unmined, ≤ 64 records (`relayer_busy`),
// ≤ 16 waiting; the alarm 15 s after a change (always while a record is unmined and untaken), doubling to 5 minutes,
// hourly with no records. Daily backstop: worst cases (gas at the fee cap) ≤ 2 × `dailyBudgetEth` a UTC day. send
// answers a coded refusal as a value `{ ok: false, refused, reason }` (nothing sent); anything thrown is unknown.
// SECURITY: nothing logs the key, a raw transaction, calldata, a signature, an authorization or an RPC URL; the key is
// parsed per section, zeroed; only its hash keys the address cache.
import { DurableObject } from 'cloudflare:workers';
import { type ExecuteInput, type SignedAuthorization, SPONSOR_DELEGATES, type SponsorTx, encodeExecuteCalldata, executeDigest, recoverAuthorization, recoverExecuteSigner, signSponsorTx, sponsorTxHash } from '@hana-id/core/evm-sponsor';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha256';
import type { Env } from './env.ts';
import { log } from './log.ts';
import { type EvmBroadcast, type EvmReceipt, type EvmRejection, EvmRpcError, type Hex, type SponsorChain, receiptCostWei, sponsorChainFor } from './evm/sponsor-chain.ts';
import { type EvmSponsorChainConfig, type EvmSponsorConfig, checksumEvmAddress, parseEvmSponsorConfig, sponsorChain } from './evm/sponsor-config.ts';

export type { Hex };

/** The guard the staff methods require (re-exported by evm-relayer-staff.ts, for the admin package only). */
export const EVM_RELAYER_STAFF_GUARD = 'hana-id/evm-relayer/staff/v1';
export const evmRelayerName = (chainId: number, keyIndex = 0): string => `evm-relayer-${chainId}-${keyIndex}`;
export const EVM_RELAYER_ALARM_MS = 15_000;
export const EVM_RELAYER_ALARM_MAX_MS = 5 * 60_000;
export const EVM_RELAYER_IDLE_CHECK_MS = 60 * 60_000;
export const EVM_RELAYER_BUMP_AFTER_MS = 60_000;
/** How long the latest base fee read for a send is reused (per instance). */
export const EVM_RELAYER_BASE_FEE_TTL_MS = 5_000;
/** A batch's max fee must be at least the latest base fee × 9/8 (one block's largest rise), and its tip at least 1 wei. */
const MIN_TIP_WEI = 1n;
/** The least tip a cancel or filler offers (0.001 gwei), within the chain's tip cap. */
export const EVM_RELAYER_CANCEL_MIN_TIP_WEI = 1_000_000n;
export const EVM_RELAYER_DEPTH_WITHOUT_SAFE = 12;
export const EVM_RELAYER_MAX_UNMINED = 8;
export const EVM_RELAYER_MAX_RECORDS = 64;
export const EVM_RELAYER_MAX_QUEUE = 16;
export const EVM_RELAYER_MAX_VERSIONS = 8;
export const EVM_RELAYER_MAX_REMEMBERED = 50_000;
export const EVM_RELAYER_REMEMBER_MS = 7 * 24 * 60 * 60_000;
export const EVM_RELAYER_STUCK_AFTER_DEADLINE_MS = 30 * 60_000;
export const EVM_RELAYER_MAX_REQUESTS = 45;
export const EVM_RELAYER_RUN_LIMITS = Object.freeze({ receipts: 20, signatures: 4 });
export const CANCEL_GAS = 21_000n;
/** EIP-7702's per-authorization cost and EIP-7623's calldata floor, as nodes check a transaction's intrinsic gas. */
const AUTHORIZATION_GAS = 25_000n;
const FLOOR_PER_TOKEN = 10n;
/** The largest raw transaction nodes take into their pools (geth: 128 KiB). */
const MAX_RAW_BYTES = 128 * 1024;
const DAILY_CAP_FACTOR = 2n;
const MIN_DEADLINE_LEAD_S = 5;
const DEADLINE_SLACK_S = 60;
const MAX_DATA_BYTES = 32 * 1024;
/** The most calldata a batch's transaction may carry (the handlers refuse a larger batch before anything is counted). */
export const EVM_RELAYER_MAX_DATA_BYTES = MAX_DATA_BYTES;
const STAFF_LOG_KEEP = 200;
const PRUNE_PER_RUN = 256;
const DAY_MS = 24 * 60 * 60_000;
const SCHEMA = 1;

export type EvmRelayerHaltReason = 'nonce_consumed_elsewhere' | 'nonce_gap' | 'foreign_transactions' | 'relayer_cannot_send' | 'stuck_past_deadline' | 'key_mismatch' | 'storage_inconsistent';
/** `code`: for `relayer_cannot_send`, the pool's refusal (an EvmRejection, e.g. `insufficient_funds`). */
export type EvmRelayerHalt = { reason: EvmRelayerHaltReason; since: number; nonce?: number; code?: string };
/** Who a definite refusal of a batch is down to: its size or shape (the user's input), its pricing (the handler's), or the relayer (funds, nonce, signing). */
export type EvmRejectionCause = 'request' | 'pricing' | 'relayer';
/**
 * The cause of each classified refusal of a BATCH version: its own size or shape (`request`), its fees, which the
 * handler set from the base fee (`pricing`), or the relayer (fail-stop: anything not attributable to the batch). A
 * refusal of a version the relayer prices itself (a cancel or filler) is always the relayer's.
 */
export const REJECTION_CAUSE: Readonly<Record<EvmRejection, EvmRejectionCause>> = Object.freeze({
  gas_limit: 'request',
  oversized: 'request',
  authority_reserved: 'request',
  underpriced: 'pricing',
  fee_below_base_fee: 'pricing',
  replacement_underpriced: 'pricing',
  nonce_too_low: 'relayer',
  nonce_too_high: 'relayer',
  insufficient_funds: 'relayer',
  invalid_transaction: 'relayer',
  sender_restricted: 'relayer',
});
const causeOf = (code: string): EvmRejectionCause => (Object.hasOwn(REJECTION_CAUSE, code) ? REJECTION_CAUSE[code as EvmRejection] : 'relayer');
export type EvmRelayerOutcome = 'execute' | 'cancel' | 'consumed_elsewhere';
/** What the batch's broadcast came to: taken by an endpoint, definitely refused (its cancel then took the nonce), or not known. */
export type EvmRelayerBroadcast = 'accepted' | 'rejected' | 'unknown';

/** What the handlers send: core's Execute input, the user's 65-byte signature, an authorization for type 4. */
export interface EvmRelayerSendRequest {
  chainId: number;
  execute: ExecuteInput;
  signature: Hex;
  authorization?: SignedAuthorization;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** The handler's worst-case reservation (at least gas × maxFeePerGas). */
  reservedWei: bigint;
}
/**
 * `transactionHash`/`raw`: the version seen mined, else the latest (`raw` null once the batch is final). `rejection`
 * (with `broadcast: 'rejected'`): why no endpoint took the batch, and whose doing it was (don't charge the user a
 * failure for `cause: 'relayer'`); null otherwise.
 */
export interface EvmRelayerSent { digest: Hex; transactionHash: Hex; relayerNonce: number; raw: Hex | null; replay: boolean; broadcast: EvmRelayerBroadcast; rejection: null | { cause: EvmRejectionCause; code: string } }
/** `minedHash`, `outcome` and `costWei` only once mined at confirmed depth; `closed` only by staff. */
export interface EvmRelayerLookup {
  digest: Hex;
  relayerNonce: number;
  transactionHash: Hex;
  hashes: Hex[];
  state: 'pending' | 'cancelling' | 'mined' | 'closed';
  minedHash: Hex | null;
  outcome: EvmRelayerOutcome | null;
  costWei: bigint | null;
  reservedWei: bigint;
}
/** `oldestUnacceptedMs`: the age of the oldest record no endpoint has taken any version of (for an alert), or null. */
export interface EvmRelayerStatus { address: Hex; unmined: number; awaitingConfirmation: number; oldestUnminedMs: number | null; oldestUnacceptedMs: number | null; nextNonce: number | null; halted: null | EvmRelayerHalt }
/** `send`'s answer: the transaction (`ok: true`), or a coded refusal (`ok: false`: nothing was sent) as a value. */
export type EvmRelayerSendAnswer = ({ ok: true } & EvmRelayerSent) | { ok: false; refused: EvmRelayerErrorCode; reason: string | null };
export interface EvmRelayerStaffEntry {
  seq: number;
  at: number;
  who: string;
  action: 'resume' | 'close' | 'cancel' | 'fill' | 'adopt_nonce';
  nonce: number | null;
  verdict: 'consumed_elsewhere' | null;
  note: string;
  done: boolean;
  refused: string | null;
}
/** Every record as stored (no raw transactions), the day's backstop and the last 50 staff actions. */
export interface EvmRelayerStaffStatus extends EvmRelayerStatus {
  chainId: number | null;
  dayWei: bigint;
  gapSeen: number | null;
  unconfirmedRefusal: null | { count: number; lastAt: number; nonce: number; code: string };
  records: (Omit<Rec, 'versions' | 'to' | 'data' | 'authorization'> & { versions: Omit<Version, 'raw'>[] })[];
  staffLog: EvmRelayerStaffEntry[];
}
export interface EvmRelayerStaffResult { done: boolean; refused: string | null; status: EvmRelayerStaffStatus }

/** `rejected` is reserved by the interface and never thrown: a refused batch is answered with `broadcast: 'rejected'`. */
export type EvmRelayerErrorCode = 'relayer_unconfigured' | 'relayer_misconfigured' | 'invalid_request' | 'fees_too_high' | 'fees_too_low' | 'wrong_chain' | 'deadline_passed' | 'relayer_busy' | 'relayer_halted' | 'daily_cap' | 'rpc_unavailable' | 'rejected' | 'internal';
const CODES: ReadonlySet<string> = new Set(['relayer_unconfigured', 'relayer_misconfigured', 'invalid_request', 'fees_too_high', 'fees_too_low', 'wrong_chain', 'deadline_passed', 'relayer_busy', 'relayer_halted', 'daily_cap', 'rpc_unavailable', 'rejected', 'internal']);
const refuse = (code: EvmRelayerErrorCode, reason?: string): never => {
  throw new Error(`evm_relayer:${code}${reason ? `:${reason}` : ''}`);
};

/** The code (and reason) of an error this object threw, or null for any other failure (unknown whether it sent). */
export function evmRelayerError(err: unknown): { code: EvmRelayerErrorCode; reason: string | null } | null {
  const m = /^evm_relayer:([a-z_]+)(?::([a-z_]+))?$/u.exec(err instanceof Error ? err.message : typeof err === 'string' ? err : '');
  return m && CODES.has(m[1]!) ? { code: m[1] as EvmRelayerErrorCode, reason: m[2] ?? null } : null;
}

// ---- the key, fees, the in-object check ----

/** EVM_RELAY_KEYS: a JSON array of exactly one `0x` + 64 lowercase hex key. Its bytes (zero them after use), or null. */
export function parseEvmRelayKey(raw: string | undefined): Uint8Array | null {
  let v: unknown;
  try {
    v = typeof raw === 'string' && raw.length <= 200 ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
  if (!Array.isArray(v) || v.length !== 1 || typeof v[0] !== 'string' || !/^0x[0-9a-f]{64}$/u.test(v[0])) return null;
  const d = fromHex(v[0] as Hex);
  if (secp256k1.utils.isValidPrivateKey(d)) return d;
  d.fill(0);
  return null;
}

/** sha256(key) → its address, per isolate: deriving the public key is the costliest step of a cold section. */
const ADDRESSES = new Map<string, Hex>();
function addressOfKey(d: Uint8Array, onDerive?: () => void): Hex {
  const id = toHex(sha256(d));
  let a = ADDRESSES.get(id);
  if (!a) {
    onDerive?.();
    a = checksumEvmAddress(toHex(keccak_256(secp256k1.getPublicKey(d, false).subarray(1)).subarray(-20))) as Hex;
    if (ADDRESSES.size >= 4) ADDRESSES.clear();
    ADDRESSES.set(id, a);
  }
  return a;
}

/** The address of EVM_RELAY_KEYS' key, or null when it is missing or malformed. */
export function evmRelayKeyAddress(raw: string | undefined): Hex | null {
  const d = parseEvmRelayKey(raw);
  if (!d) return null;
  try {
    return addressOfKey(d);
  } finally {
    d.fill(0);
  }
}

export type FeeCaps = { maxFeePerGasWei: bigint; maxPriorityFeePerGasWei: bigint };
type Fees = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
/** The pool's fee floor the object refuses below (`fees_too_low`): a tip under 1 wei, or a max fee under 9/8 of the base fee. */
export const feesTooLow = (f: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }, baseFee: bigint): boolean => f.maxPriorityFeePerGas < MIN_TIP_WEI || f.maxFeePerGas < ceilDiv(baseFee * 9n, 8n);
const minBig = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const maxBig = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const bump = (x: bigint): bigint => ceilDiv(x * 9n, 8n);
const nodeMinimum = (x: bigint): bigint => ceilDiv(x * 11n, 10n);

/** Both fees × 1.125 within the caps, or null when that is no valid replacement (nodes need +10% on both). */
export function bumpedFees(prev: Fees, caps: FeeCaps): Fees | null {
  const tip = minBig(bump(prev.maxPriorityFeePerGas), caps.maxPriorityFeePerGasWei);
  const fee = minBig(bump(prev.maxFeePerGas), caps.maxFeePerGasWei);
  if (tip > fee || tip < nodeMinimum(prev.maxPriorityFeePerGas) || fee < nodeMinimum(prev.maxFeePerGas) || (tip === prev.maxPriorityFeePerGas && fee === prev.maxFeePerGas)) return null;
  return { maxFeePerGas: fee, maxPriorityFeePerGas: tip };
}
/** Whether two bumps of both fees stay within the caps (a bump and the deadline's cancel). */
export const hasFeeHeadroom = (f: Fees, caps: FeeCaps): boolean => bump(bump(f.maxFeePerGas)) <= caps.maxFeePerGasWei && bump(bump(f.maxPriorityFeePerGas)) <= caps.maxPriorityFeePerGasWei;
/** The highest fees a send may start with (hasFeeHeadroom's edge). */
export function maxStartingFees(caps: FeeCaps): Fees {
  const highest = (cap: bigint): bigint => {
    let x = (cap * 64n) / 81n;
    while (x > 0n && bump(bump(x)) > cap) x--;
    return x;
  };
  return { maxFeePerGas: highest(caps.maxFeePerGasWei), maxPriorityFeePerGas: highest(caps.maxPriorityFeePerGasWei) };
}

/**
 * A cancel's or filler's fees, priced from a fresh base fee: tip max(1.125 × the previous tip, 0.001 gwei), max fee
 * max(1.125 × the previous, 2 × base fee + tip), both within the caps. Null when the caps leave no valid one: below
 * base fee × 9/8, or (replacing `prev`) under nodes' +10%.
 */
export function cancelFees(prev: Fees | null, baseFee: bigint, caps: FeeCaps): Fees | null {
  const tip = minBig(maxBig(prev ? bump(prev.maxPriorityFeePerGas) : 0n, EVM_RELAYER_CANCEL_MIN_TIP_WEI), caps.maxPriorityFeePerGasWei);
  const fee = minBig(maxBig(prev ? bump(prev.maxFeePerGas) : 0n, 2n * baseFee + tip), caps.maxFeePerGasWei);
  if (tip > fee || fee < ceilDiv(baseFee * 9n, 8n)) return null;
  if (prev && (tip < nodeMinimum(prev.maxPriorityFeePerGas) || fee < nodeMinimum(prev.maxFeePerGas))) return null;
  return { maxFeePerGas: fee, maxPriorityFeePerGas: tip };
}

/**
 * A transaction's intrinsic gas as nodes check it before taking it: 21 000, calldata at 4 gas a token (a zero byte one
 * token, any other four), at least EIP-7623's floor of 10 a token, and 25 000 per EIP-7702 authorization (no access
 * list is ever sent).
 */
export function intrinsicGas(data: Uint8Array, authorizations: number): bigint {
  let tokens = 0n;
  for (const b of data) tokens += b === 0 ? 1n : 4n;
  return maxBig(21_000n + 4n * tokens + AUTHORIZATION_GAS * BigInt(authorizations), 21_000n + FLOOR_PER_TOKEN * tokens);
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const ZERO = /^0x0{40}$/u;
const U256_MAX = (1n << 256n) - 1n;
const isBig = (v: unknown, min: bigint, max: bigint): v is bigint => typeof v === 'bigint' && v >= min && v <= max;
const same = (a: unknown, b: unknown): boolean => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
function fromHex(h: Hex): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array((h.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(2 + 2 * i, 4 + 2 * i), 16);
  return out;
}
const toHex = (b: Uint8Array): Hex => `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;

/** executeDigest as `0x` hex, or `invalid_request`. */
export function digestOf(execute: ExecuteInput): Hex {
  try {
    return toHex(executeDigest(execute));
  } catch {
    return refuse('invalid_request');
  }
}

type Payload = { to: Hex; data: Hex; gas: bigint; authorization: StoredAuthorization | null };
export interface VerifyContext { chain: Readonly<EvmSponsorChainConfig>; /** This relayer's address (the key's). */ relayer: Hex; pinned: Readonly<Record<number, { readonly address: string; readonly placeholder: boolean }>>; nowMs: number }

/**
 * The request checked against the chain's settings, and the transaction built from it (the handlers checked it first;
 * this object trusts no caller). Throws `relayer_unconfigured` (no deployed pinned delegate), `invalid_request`,
 * `fees_too_high` or `deadline_passed`.
 */
export function verifySend(req: EvmRelayerSendRequest, ctx: VerifyContext): Payload & { digest: Hex; fees: Fees; deadline: number; reservedWei: bigint } {
  const c = ctx.chain;
  const e = req.execute;
  const pinned = (Object.hasOwn(ctx.pinned, c.chainId) ? ctx.pinned[c.chainId] : undefined) ?? refuse('relayer_unconfigured');
  if (pinned.placeholder || !same(pinned.address, c.delegate)) refuse('relayer_unconfigured');
  const { gas, maxFeePerGas, maxPriorityFeePerGas, reservedWei, authorization: a, signature } = req;
  if (req.chainId !== c.chainId || e.chainId !== c.chainId || !same(e.implementation, pinned.address) || !same(e.relayer, ctx.relayer)) refuse('invalid_request');
  const account = e.account;
  if (typeof account !== 'string' || !ADDRESS.test(account) || ZERO.test(account) || same(account, ctx.relayer) || same(account, c.delegate)) refuse('invalid_request');
  const calls: unknown[] = Array.isArray(e.calls) ? e.calls : [];
  if (calls.length < 1 || calls.length > c.maxCallsPerBatch) refuse('invalid_request');
  for (const call of calls as { to?: unknown; value?: unknown }[]) {
    if (typeof call !== 'object' || call === null || call.value !== 0n || typeof call.to !== 'string' || ZERO.test(call.to)) refuse('invalid_request');
    if (same(call.to, account) || same(call.to, c.delegate) || same(call.to, ctx.relayer)) refuse('invalid_request');
  }
  if (!isBig(gas, CANCEL_GAS, c.maxGasPerTx) || !isBig(e.minGas, c.minGas, gas)) refuse('invalid_request');
  if (!isBig(maxFeePerGas, 1n, c.maxFeePerGasWei) || !isBig(maxPriorityFeePerGas, 0n, minBig(maxFeePerGas, c.maxPriorityFeePerGasWei))) refuse('invalid_request');
  if (!hasFeeHeadroom({ maxFeePerGas, maxPriorityFeePerGas }, c)) refuse('fees_too_high');
  if (!isBig(reservedWei, gas * maxFeePerGas, U256_MAX) || typeof e.deadline !== 'bigint' || typeof e.nonce !== 'bigint') refuse('invalid_request');
  const nowS = BigInt(Math.floor(ctx.nowMs / 1000));
  if (e.deadline <= nowS + BigInt(MIN_DEADLINE_LEAD_S)) refuse('deadline_passed');
  if (e.deadline > nowS + BigInt(c.deadlineMaxS + DEADLINE_SLACK_S) || typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/u.test(signature)) refuse('invalid_request');
  let data: Hex;
  let auth: StoredAuthorization | null = null;
  try {
    if (!same(recoverExecuteSigner(e, signature), account)) refuse('invalid_request');
    data = encodeExecuteCalldata(e, signature).toLowerCase() as Hex;
    if (a !== undefined) {
      if (typeof a !== 'object' || a === null || a.chainId !== c.chainId || !same(a.address, pinned.address) || typeof a.nonce !== 'bigint') refuse('invalid_request');
      if (!same(recoverAuthorization(a), account)) refuse('invalid_request');
      auth = { chainId: a.chainId, address: a.address, nonce: a.nonce.toString(), yParity: a.yParity, r: a.r, s: a.s };
    }
  } catch {
    return refuse('invalid_request');
  }
  // The pool's own static checks, so no node refuses a batch for a reason the user's input chose.
  if (data.length > 2 + 2 * MAX_DATA_BYTES || gas < intrinsicGas(fromHex(data), auth ? 1 : 0) + e.minGas) refuse('invalid_request');
  return { digest: digestOf(e), to: account.toLowerCase() as Hex, data, gas, authorization: auth, fees: { maxFeePerGas, maxPriorityFeePerGas }, deadline: Number(e.deadline), reservedWei };
}

function buildTx(chainId: number, nonce: number, t: Payload, fees: Fees): SponsorTx {
  const base = { chainId: BigInt(chainId), nonce: BigInt(nonce), ...fees, gas: t.gas, to: fromHex(t.to), value: 0n, data: fromHex(t.data), accessList: [] };
  const a = t.authorization;
  return a ? { type: 'eip7702', ...base, authorizationList: [{ chainId: a.chainId, address: a.address, nonce: BigInt(a.nonce), yParity: a.yParity, r: a.r, s: a.s }] } : { type: 'eip1559', ...base };
}

// ---- storage ----

interface Meta {
  v: number;
  chainId: number;
  /** The address every record was signed by (EIP-55). */
  address: Hex;
  nextNonce: number | null;
  halted: EvmRelayerHalt | null;
  gapSeen: number | null;
  /** The UTC day (ms ÷ 1 day) and its worst-case wei (decimal), for the backstop. */
  day: number;
  dayWei: string;
  alarmMs: number;
  remembered: number;
  staffSeq: number;
  /** Refusals that would halt but the trusted endpoint did not confirm (no halt), for staff: how many, the last. */
  unconfirmedRefusal?: { count: number; lastAt: number; nonce: number; code: string };
}
interface StoredAuthorization { chainId: number; address: Hex; nonce: string; yParity: 0 | 1; r: Hex; s: Hex }
interface Version { hash: Hex; raw: Hex; kind: 'execute' | 'cancel'; maxFeePerGas: string; maxPriorityFeePerGas: string }
interface Rec {
  nonce: number;
  /** null for a staff filler. */
  digest: Hex | null;
  /** The batch's account (lowercase): one unmined batch per account. null for a filler. */
  account: Hex | null;
  /** The batch's deadline (unix s); a filler's signing time. */
  deadline: number;
  reservedWei: string;
  /** The UTC day it was counted in and what it counted (wei, decimal). */
  day: number;
  worstWei: string;
  to: Hex;
  data: Hex;
  gas: string;
  authorization: StoredAuthorization | null;
  sentAt: number;
  signedAt: number;
  versions: Version[];
  /** An endpoint accepted one of its versions. */
  accepted: boolean;
  /** A definite refusal of a batch version while none was accepted (its cancel follows), or null. */
  batchRejected: string | null;
  /** The cause of `batchRejected` (replacement_underpriced on a first version is the relayer's, else REJECTION_CAUSE). */
  batchCause?: EvmRejectionCause | null;
  /** A refusal only our side causes (relayer-caused, or of our own cancel or filler) while none was accepted, or null. */
  cannotSend: string | null;
  /** Our own cancel or filler was refused over its price: reprice it on the next run (no halt). */
  priceRefused?: boolean;
  /** Consecutive runs that found this batch untaken after a rebroadcast with its nonce in no trusted pool. */
  unpooledRuns?: number;
  /** A receipt of one of its versions, not yet final. */
  seen: { hash: Hex; block: number } | null;
}
interface Dig {
  nonce: number;
  state: 'pending' | 'mined' | 'closed';
  reservedWei: string;
  /** Once final (hashes only): the hash answered (the mined one, else the latest), every version, the outcome. */
  hash?: Hex;
  hashes?: Hex[];
  minedHash?: Hex | null;
  outcome?: EvmRelayerOutcome;
  costWei?: string | null;
  batchRejected?: string;
  batchCause?: EvmRejectionCause;
  resolvedAt?: number;
}
const pad = (n: number): string => String(n).padStart(16, '0');
const recKey = (nonce: number): string => `rec:${pad(nonce)}`;
const digKey = (d: string): string => `dig:${d.toLowerCase()}`;
const forgetKey = (at: number, d: string): string => `fgt:${pad(at)}:${d.toLowerCase()}`;
const staffKey = (seq: number): string => `staff:${pad(seq)}`;
const latestOf = (r: Rec): Version => r.versions[r.versions.length - 1]!;
const feesOf = (v: Version): Fees => ({ maxFeePerGas: BigInt(v.maxFeePerGas), maxPriorityFeePerGas: BigInt(v.maxPriorityFeePerGas) });
const selfTransfer = (address: Hex): Payload => ({ to: address.toLowerCase() as Hex, data: '0x', gas: CANCEL_GAS, authorization: null });
const version = (raw: Hex, kind: Version['kind'], f: Fees): Version => ({ hash: sponsorTxHash(raw), raw, kind, maxFeePerGas: f.maxFeePerGas.toString(), maxPriorityFeePerGas: f.maxPriorityFeePerGas.toString() });
const broadcastOf = (r: Pick<Rec, 'batchRejected' | 'accepted'>): EvmRelayerBroadcast => (r.batchRejected !== null ? 'rejected' : r.accepted ? 'accepted' : 'unknown');
const rejectionOf = (code: string | null | undefined, cause?: EvmRejectionCause | null): EvmRelayerSent['rejection'] => (code ? { cause: cause ?? causeOf(code), code } : null);

interface Ctx {
  chain: Readonly<EvmSponsorChainConfig>;
  /** The key, only when valid and the config's `relayerAddress`. */
  key: Uint8Array | null;
  keyAddress: Hex | null;
  /** A key is set but its address is not `relayerAddress`. */
  keyWrong: boolean;
}
type Counts = { head: number; baseFee: bigint; confirmedBlock: number; latest: number; confirmed: number; pending: number };
type Condition = { reason: EvmRelayerHaltReason; nonce?: number; code?: string };
/** `incomplete`: a record past the confirmed count could not be fully checked this run (budget or a failed read). */
type RunResult = { conditions: Condition[]; changed: boolean; incomplete: boolean; gap: number | null };
/** What a section did that costs CPU: logged as `evmOps` (cold-isolate CPU on the free plan is measured at deploy). */
type Ops = { signatures: number; recoveries: number; fetches: number; keyDerivations: number };

export class EvmRelayer extends DurableObject<Env> {
  #queue: Promise<unknown> = Promise.resolve();
  #waiting = 0;
  #ops: Ops = { signatures: 0, recoveries: 0, fetches: 0, keyDerivations: 0 };
  #baseFee: { wei: bigint; at: number } | null = null;

  /**
   * Checks the Execute, then signs, persists and broadcasts its transaction (or answers the one already sent). A coded
   * refusal comes back as a value: thrown across Workers RPC it would be reported as an uncaught rejection in the
   * object even when the caller handles it. Anything else thrown is unknown (keep the reservation; resend is safe).
   */
  async send(req: EvmRelayerSendRequest): Promise<EvmRelayerSendAnswer> {
    try {
      return { ok: true, ...(await this.#send(req)) };
    } catch (e) {
      const c = evmRelayerError(e);
      if (c) return { ok: false, refused: c.code, reason: c.reason };
      throw e;
    }
  }

  async #send(req: EvmRelayerSendRequest): Promise<EvmRelayerSent> {
    if (typeof req !== 'object' || req === null || !Number.isSafeInteger(req.chainId) || req.chainId <= 0 || typeof req.execute !== 'object' || req.execute === null) refuse('invalid_request');
    if (this.#waiting >= EVM_RELAYER_MAX_QUEUE) refuse('relayer_busy');
    this.#waiting++;
    let started = false;
    return this.#exclusive(async () => {
      started = true;
      this.#waiting--;
      this.#ops = { signatures: 0, recoveries: 0, fetches: 0, keyDerivations: 0 };
      const meta = this.#meta();
      if (meta && meta.chainId !== req.chainId) refuse('wrong_chain');
      const c = this.#context(req.chainId);
      try {
        return await this.#sendLocked(req, c, meta);
      } finally {
        c.key?.fill(0);
      }
    }).finally(() => {
      if (!started) this.#waiting--;
    });
  }

  /** Where the relayer stands (storage only). */
  async status(): Promise<EvmRelayerStatus> {
    const meta = this.#meta();
    const records = this.#records();
    const unmined = records.filter((r) => r.seen === null);
    const oldest = unmined.length ? Math.min(...unmined.map((r) => r.sentAt)) : null;
    const unaccepted = unmined.filter((r) => !r.accepted);
    const oldestUnaccepted = unaccepted.length ? Math.min(...unaccepted.map((r) => r.sentAt)) : null;
    return {
      address: meta?.address ?? evmRelayKeyAddress(this.env.EVM_RELAY_KEYS) ?? refuse('relayer_misconfigured'),
      unmined: unmined.length,
      awaitingConfirmation: records.length - unmined.length,
      oldestUnminedMs: oldest === null ? null : Math.max(0, Date.now() - oldest),
      oldestUnacceptedMs: oldestUnaccepted === null ? null : Math.max(0, Date.now() - oldestUnaccepted),
      nextNonce: meta?.nextNonce ?? null,
      halted: meta?.halted ?? null,
    };
  }

  /** Every hash signed for a digest and where it stands, or null when not (or no longer) remembered. */
  async lookup(digest: Hex): Promise<EvmRelayerLookup | null> {
    if (typeof digest !== 'string' || !/^0x[0-9a-fA-F]{64}$/u.test(digest)) refuse('invalid_request');
    const d = digest.toLowerCase() as Hex;
    const dig = this.ctx.storage.kv.get<Dig>(digKey(d));
    const r = dig?.state === 'pending' ? this.#rec(dig.nonce) : undefined;
    if (!dig || (dig.state === 'pending' && !r)) return null;
    const base = { digest: d, relayerNonce: dig.nonce, reservedWei: BigInt(dig.reservedWei) };
    if (r) return { ...base, transactionHash: r.seen?.hash ?? latestOf(r).hash, hashes: r.versions.map((v) => v.hash), state: latestOf(r).kind === 'cancel' ? 'cancelling' : 'pending', minedHash: null, outcome: null, costWei: null };
    return { ...base, transactionHash: dig.hash!, hashes: [...dig.hashes!], state: dig.state as 'mined' | 'closed', minedHash: dig.minedHash ?? null, outcome: dig.outcome ?? null, costWei: dig.costWei ? BigInt(dig.costWei) : null };
  }

  override async alarm(): Promise<void> {
    try {
      await this.#exclusive(() => this.#tick());
    } catch {
      log({ event: 'evm_relayer_alarm_failed', code: 'internal' }, 'error');
      await this.ctx.storage.setAlarm(Date.now() + EVM_RELAYER_ALARM_MS);
    }
  }

  // ---- staff (reached only through evm-relayer-staff.ts) ----

  async staffStatus(guard: string): Promise<EvmRelayerStaffStatus> {
    if (guard !== EVM_RELAYER_STAFF_GUARD) refuse('invalid_request');
    return this.#staffView();
  }

  async staffResume(guard: string, who: string, note: string): Promise<EvmRelayerStaffResult> {
    return this.#staffAct(guard, who, note, { action: 'resume', nonce: null, verdict: null }, async (meta, c) => {
      if (!meta.halted) return 'not_halted';
      // A new key with nothing in flight starts a new nonce life (read at the next send).
      if (this.#records().length === 0 && c.keyAddress && c.keyAddress !== meta.address) this.#putMeta({ ...meta, address: c.keyAddress, nextNonce: null });
      const out = await this.#run(c, Date.now());
      if (out.conditions.length > 0) return out.conditions[0]!.reason;
      if (out.incomplete) return 'incomplete_check';
      this.#putMeta({ ...this.#meta()!, halted: null, gapSeen: null });
      return null;
    });
  }

  async staffClose(guard: string, who: string, nonce: number, verdict: 'consumed_elsewhere', note: string): Promise<EvmRelayerStaffResult> {
    if (verdict !== 'consumed_elsewhere') refuse('invalid_request');
    return this.#staffAct(guard, who, note, { action: 'close', nonce, verdict }, async (meta, c) => {
      const r = this.#rec(nonce);
      if (!r) return 'no_record';
      const rpc = this.#client(c);
      const n = await this.#counts(rpc, meta.address);
      if (n.confirmed <= nonce) return 'nonce_not_consumed_at_confirmed_depth';
      const found = await this.#findReceipt(rpc, r, { left: EVM_RELAYER_MAX_VERSIONS });
      if (found.found) return 'receipt_found';
      if (!found.complete) return 'incomplete_check';
      this.#resolve(r, { state: 'closed', hash: latestOf(r).hash, minedHash: null, outcome: 'consumed_elsewhere', costWei: null }, 0n);
      return null;
    });
  }

  async staffCancel(guard: string, who: string, nonce: number, note: string): Promise<EvmRelayerStaffResult> {
    return this.#staffAct(guard, who, note, { action: 'cancel', nonce, verdict: null }, async (meta, c) => {
      const r = this.#rec(nonce);
      if (!r) return 'no_record';
      if (!this.#canSign(c, meta)) return 'key_mismatch';
      const rpc = this.#client(c);
      const n = await this.#counts(rpc, meta.address);
      if (n.latest > nonce) return 'nonce_mined';
      const found = await this.#findReceipt(rpc, r, { left: EVM_RELAYER_MAX_VERSIONS });
      if (found.found) return 'receipt_found';
      if (!found.complete) return 'incomplete_check';
      const next = this.#nextVersion(c, r, Date.now(), n.baseFee, true);
      if (next === 'fee_cap_too_low') return next;
      if (!next) return 'no_valid_replacement';
      await this.#store(next);
      this.#afterBroadcast(next, await rpc.broadcast(latestOf(next).raw), false);
      return null;
    });
  }

  async staffFill(guard: string, who: string, nonce: number, note: string): Promise<EvmRelayerStaffResult> {
    return this.#staffAct(guard, who, note, { action: 'fill', nonce, verdict: null }, async (meta, c) => {
      if (!this.#canSign(c, meta)) return 'key_mismatch';
      if (meta.nextNonce === null || nonce >= meta.nextNonce) return 'not_below_next_nonce';
      if (this.#rec(nonce)) return 'record_exists';
      const rpc = this.#client(c);
      const n = await this.#counts(rpc, meta.address);
      if (n.pending !== nonce || n.latest > nonce) return 'not_the_chains_next_nonce';
      const now = Date.now();
      const t = selfTransfer(meta.address);
      const fees = cancelFees(null, n.baseFee, c.chain);
      if (!fees) return 'fee_cap_too_low';
      const worst = CANCEL_GAS * c.chain.maxFeePerGasWei;
      const r: Rec = { nonce, digest: null, account: null, deadline: Math.floor(now / 1000), reservedWei: '0', day: Math.floor(now / DAY_MS), worstWei: worst.toString(), ...t, gas: t.gas.toString(), sentAt: now, signedAt: now, versions: [version(this.#sign(c, nonce, t, fees), 'cancel', fees)], accepted: false, batchRejected: null, cannotSend: null, seen: null };
      await this.#persist(r, worst);
      this.#afterBroadcast(r, await rpc.broadcast(r.versions[0]!.raw), false);
      return null;
    });
  }

  async staffAdoptNonce(guard: string, who: string, nonce: number, note: string): Promise<EvmRelayerStaffResult> {
    return this.#staffAct(guard, who, note, { action: 'adopt_nonce', nonce, verdict: null }, async (meta, c) => {
      const records = this.#records();
      if (meta.nextNonce !== null && nonce < meta.nextNonce) return 'below_next_nonce';
      // Every record is below nextNonce, so n ≥ nextNonce is above them all.
      if (records.some((r) => r.seen === null)) return 'unmined_records';
      const n = await this.#counts(this.#client(c), meta.address);
      if (n.latest !== nonce || n.pending !== nonce) return 'chain_count_differs';
      this.#putMeta({ ...this.#meta()!, nextNonce: nonce, gapSeen: null });
      return null;
    });
  }

  // ---- send ----

  async #sendLocked(req: EvmRelayerSendRequest, c: Ctx, meta: Meta | undefined): Promise<EvmRelayerSent> {
    const digest = digestOf(req.execute);
    const known = this.ctx.storage.kv.get<Dig>(digKey(digest));
    if (known) return this.#replay(digest, known);
    if (meta?.halted) refuse('relayer_halted');
    if (!c.key) refuse('relayer_misconfigured');
    const now = Date.now();
    const v = verifySend(req, { chain: c.chain, relayer: c.keyAddress!, pinned: SPONSOR_DELEGATES, nowMs: now });
    this.#ops.recoveries += v.authorization ? 2 : 1;
    const records = this.#records();
    if (meta && meta.address !== c.keyAddress) {
      if (records.length > 0) {
        this.#halt({ reason: 'key_mismatch' }, now);
        refuse('relayer_halted');
      }
      // A new key with nothing in flight: a new nonce life (read below).
      this.#putMeta((meta = { ...meta, address: c.keyAddress!, nextNonce: null }));
    }
    if (meta && this.#inconsistency(meta, records)) {
      this.#halt({ reason: 'storage_inconsistent' }, now);
      refuse('relayer_halted');
    }
    // The delegate's batch nonce is sequential: a second batch of an account while one is unmined can only stall. One
    // on-demand check of that record (the evidence a run's `seen` uses) lets an action right after a mined one through.
    const rpc = this.#client(c);
    const prev = records.find((r) => r.seen === null && r.account === v.to);
    if (prev) {
      const seen = await this.#seenNow(rpc, prev);
      if (!seen) refuse('relayer_busy', 'account');
      this.#putRec({ ...prev, seen });
      records.splice(records.indexOf(prev), 1, { ...prev, seen });
    }
    if (records.filter((r) => r.seen === null).length >= EVM_RELAYER_MAX_UNMINED || records.length >= EVM_RELAYER_MAX_RECORDS || (meta?.remembered ?? 0) >= EVM_RELAYER_MAX_REMEMBERED) refuse('relayer_busy');
    const day = Math.floor(now / DAY_MS);
    // The most any version can cost: the reservation with its gas at the fee cap (bumps and the cancel stay below).
    const worst = v.reservedWei + v.gas * (c.chain.maxFeePerGasWei - v.fees.maxFeePerGas);
    if ((meta && meta.day === day ? BigInt(meta.dayWei) : 0n) + worst > c.chain.dailyBudgetWei * DAILY_CAP_FACTOR) {
      log({ event: 'evm_relay_daily_cap', chainId: c.chain.chainId, code: 'daily_cap' }, 'error');
      refuse('daily_cap');
    }
    // The pool's fee floor, checked here so a batch priced too low is refused with nothing sent (not stored, cancelled).
    if (!this.#baseFee || now - this.#baseFee.at >= EVM_RELAYER_BASE_FEE_TTL_MS) {
      const block = await rpc.latestBlock().catch(() => refuse('rpc_unavailable'));
      this.#baseFee = { wei: block.baseFeePerGas, at: now };
    }
    if (feesTooLow(v.fees, this.#baseFee.wei)) refuse('fees_too_low');
    if (!meta || meta.nextNonce === null) {
      // A fresh nonce life: the trusted endpoint's pending count, read once. Nothing is stored if it fails.
      const pending = await rpc.transactionCount(c.keyAddress!, 'pending').catch(() => refuse('rpc_unavailable'));
      const fresh: Meta = { v: SCHEMA, chainId: c.chain.chainId, address: c.keyAddress!, nextNonce: null, halted: null, gapSeen: null, day, dayWei: '0', alarmMs: EVM_RELAYER_ALARM_MS, remembered: 0, staffSeq: 0 };
      this.#putMeta((meta = { ...(meta ?? fresh), nextNonce: pending }));
    }
    const nonce = meta.nextNonce!;
    const raw = this.#sign(c, nonce, v, v.fees);
    if (raw.length > 2 + 2 * MAX_RAW_BYTES) refuse('invalid_request');
    let r: Rec = { nonce, digest, account: v.to, deadline: v.deadline, reservedWei: v.reservedWei.toString(), day, worstWei: worst.toString(), to: v.to, data: v.data, gas: v.gas.toString(), authorization: v.authorization, sentAt: now, signedAt: now, versions: [version(raw, 'execute', v.fees)], accepted: false, batchRejected: null, cannotSend: null, seen: null };
    await this.#persist(r, worst);
    const hash = r.versions[0]!.hash;
    const sent = await rpc.broadcast(raw);
    r = this.#afterBroadcast(r, sent, true, await this.#heldElsewhere(rpc, sent, nonce, c.keyAddress!));
    if (r.batchRejected !== null) {
      // No node took the batch: its nonce goes to our own cancel, at once. A refusal the relayer caused also halts it
      // (whatever the cancel does), as does our cancel refused; one of the batch's size, shape or pricing does not.
      let code = r.cannotSend;
      // A fresh base fee for our own cancel (the cached one may be what the batch just lost to).
      const fresh = await rpc.latestBlock().then((b) => b.baseFeePerGas, () => this.#baseFee!.wei);
      const next = this.#nextVersion(c, r, now, fresh, true);
      if (next === 'fee_cap_too_low') code ??= next;
      else if (next) {
        await this.#store(next);
        code ??= this.#afterBroadcast(next, await rpc.broadcast(latestOf(next).raw), true).cannotSend;
      }
      if (code) this.#halt({ reason: 'relayer_cannot_send', nonce, code }, Date.now());
    }
    this.#ops.fetches = rpc.requestsUsed;
    log({ event: 'evm_relay_sent', chainId: c.chain.chainId, nonce: String(nonce), evmTx: hash, code: sent.kind === 'rejected' ? sent.reason : sent.kind, evmOps: this.#ops }, sent.kind === 'accepted' ? 'info' : 'warn');
    // Answered whatever the broadcast said: the record exists and every run broadcasts it (or its cancel) again.
    return { digest, transactionHash: hash, relayerNonce: nonce, raw, replay: false, broadcast: broadcastOf(r), rejection: rejectionOf(r.batchRejected, r.batchCause) };
  }

  #replay(digest: Hex, dig: Dig): EvmRelayerSent {
    if (dig.state !== 'pending') return { digest, transactionHash: dig.hash!, relayerNonce: dig.nonce, raw: null, replay: true, broadcast: dig.batchRejected ? 'rejected' : dig.outcome === 'consumed_elsewhere' ? 'unknown' : 'accepted', rejection: rejectionOf(dig.batchRejected, dig.batchCause) };
    const r = this.#rec(dig.nonce);
    if (!r || r.digest !== digest) {
      this.#halt({ reason: 'storage_inconsistent', nonce: dig.nonce }, Date.now());
      return refuse('internal');
    }
    const v = r.versions.find((x) => x.hash === r.seen?.hash) ?? latestOf(r);
    return { digest, transactionHash: v.hash, relayerNonce: r.nonce, raw: v.raw, replay: true, broadcast: broadcastOf(r), rejection: rejectionOf(r.batchRejected, r.batchCause) };
  }

  #sign(c: Ctx, nonce: number, t: Payload, fees: Fees): Hex {
    this.#ops.signatures++;
    try {
      return signSponsorTx(c.key!, buildTx(c.chain.chainId, nonce, t, fees));
    } catch {
      return refuse('invalid_request');
    }
  }

  /** Stores a new record (its batch entry, `nextNonce` + 1, the day's worst case) in one transaction, then confirms it. */
  async #persist(r: Rec, worst: bigint): Promise<void> {
    const kv = this.ctx.storage.kv;
    this.ctx.storage.transactionSync(() => {
      const m = this.#meta()!;
      kv.put(recKey(r.nonce), r);
      if (r.digest) kv.put(digKey(r.digest), { nonce: r.nonce, state: 'pending', reservedWei: r.reservedWei } satisfies Dig);
      const dayWei = (m.day === r.day ? BigInt(m.dayWei) : 0n) + worst;
      this.#putMeta({ ...m, ...(r.digest ? { nextNonce: r.nonce + 1, remembered: m.remembered + 1 } : {}), day: r.day, dayWei: dayWei.toString(), alarmMs: EVM_RELAYER_ALARM_MS });
    });
    await this.#persisted(Date.now());
  }

  /** Stores a record's new version and confirms it: only then may its raw leave. */
  async #store(r: Rec): Promise<void> {
    this.#putRec(r);
    await this.#persisted(Date.now());
  }

  /** The alarm set and storage confirmed: from here a broadcast can't outrun what it depends on. */
  async #persisted(now: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > now + EVM_RELAYER_ALARM_MS) await this.ctx.storage.setAlarm(now + EVM_RELAYER_ALARM_MS);
    await this.ctx.storage.sync();
  }

  /**
   * Notes a broadcast's answer on the stored record and returns it: accepted, or (none ever accepted) a definite
   * refusal: of a batch version (`batchRejected`; also `cannotSend` when the relayer caused it), or of our own cancel or
   * filler (`cannotSend`). `nonce too low` counts only at send (later, receipts decide).
   */
  #afterBroadcast(r: Rec, sent: EvmBroadcast, atSend: boolean, heldElsewhere = false): Rec {
    const cur = this.#rec(r.nonce) ?? r;
    let next = cur;
    if (sent.kind === 'accepted') next = { ...cur, accepted: true, cannotSend: null, priceRefused: false };
    else if (sent.kind === 'rejected' && !cur.accepted && (atSend || sent.reason !== 'nonce_too_low')) {
      // A halt needs our own evidence: the trusted read endpoint itself refused (`byRead`). Otherwise: noted, no halt.
      const trusted = sent.byRead !== null;
      if (latestOf(cur).kind === 'execute') {
        // Nothing of ours holds a first version's nonce: a replacement refusal there is another sender with our key,
        // but only when the trusted endpoint shows it (heldElsewhere); else it is pricing.
        const first = sent.reason === 'replacement_underpriced' && cur.versions.length === 1;
        const cause = first ? (heldElsewhere ? 'relayer' : 'pricing') : causeOf(sent.reason);
        const halts = cause === 'relayer' && trusted;
        if ((first && !heldElsewhere) || (cause === 'relayer' && !trusted)) this.#noteUnconfirmed(cur.nonce, sent.reason);
        next = { ...cur, batchRejected: sent.reason, batchCause: cause, ...(halts ? { cannotSend: sent.reason } : {}) };
      } else if (causeOf(sent.reason) === 'pricing' || !trusted) {
        if (!trusted && causeOf(sent.reason) !== 'pricing') this.#noteUnconfirmed(cur.nonce, sent.reason);
        next = { ...cur, priceRefused: true };
      } else next = { ...cur, cannotSend: sent.reason };
    }
    if (next !== cur && this.#rec(r.nonce)) this.#putRec(next);
    return next;
  }

  // ---- the alarm ----

  async #tick(): Promise<void> {
    const now = Date.now();
    const meta = this.#meta();
    if (!meta) return this.ctx.storage.deleteAlarm();
    this.#ops = { signatures: 0, recoveries: 0, fetches: 0, keyDerivations: 0 };
    this.#prune(now);
    let c: Ctx;
    try {
      c = this.#context(meta.chainId);
    } catch {
      log({ event: 'evm_relayer_alarm_refused', chainId: meta.chainId, code: 'relayer_unconfigured' }, 'error');
      return this.#schedule(now, false);
    }
    try {
      const out = await this.#run(c, now).catch((e: unknown) => {
        if (!(e instanceof EvmRpcError)) throw e;
        log({ event: 'evm_relay_rpc_unavailable', chainId: meta.chainId, code: 'rpc_unavailable' }, 'warn');
        return null;
      });
      if (!out) return this.#schedule(now, false);
      const m = this.#meta()!;
      // nonce_gap halts only when the same gap was seen on the previous run too.
      const first = out.conditions.find((x) => x.reason !== 'nonce_gap' || m.gapSeen === x.nonce);
      if (first) this.#halt(first, now);
      for (const x of out.conditions) log({ event: 'evm_relayer_condition', chainId: meta.chainId, code: x.reason, ...(x.nonce !== undefined ? { nonce: String(x.nonce) } : {}) }, 'warn');
      if (this.#meta()!.gapSeen !== out.gap) this.#putMeta({ ...this.#meta()!, gapSeen: out.gap });
      log({ event: 'evm_relayer_run', chainId: meta.chainId, evmOps: this.#ops });
      await this.#schedule(now, out.changed);
    } finally {
      c.key?.fill(0);
    }
  }

  /**
   * One pass (see the header): the counts; each record's receipts (finalize, note or un-note `seen`); a new version
   * or a rebroadcast for each record unmined at head; the halt conditions found. Throws EvmRpcError when the counts
   * can't be read (nothing changed then).
   */
  async #run(c: Ctx, now: number): Promise<RunResult> {
    const meta = this.#meta()!;
    const out: RunResult = { conditions: [], changed: false, incomplete: false, gap: null };
    const records = this.#records();
    if (records.length > 0 && (c.keyWrong || (c.keyAddress !== null && c.keyAddress !== meta.address))) out.conditions.push({ reason: 'key_mismatch' });
    if (this.#inconsistency(meta, records)) out.conditions.push({ reason: 'storage_inconsistent' });
    const rpc = this.#client(c);
    const n = await this.#counts(rpc, meta.address);
    if (meta.nextNonce !== null && Math.max(n.latest, n.pending) > meta.nextNonce) out.conditions.push({ reason: 'foreign_transactions', nonce: meta.nextNonce });

    const budget = { left: EVM_RELAYER_RUN_LIMITS.receipts };
    const unmined: Rec[] = [];
    for (const r of records) {
      if (r.nonce >= n.latest) {
        if (r.seen) log({ event: 'evm_relay_reorg', chainId: c.chain.chainId, nonce: String(r.nonce), code: 'unmined' }, 'warn');
        if (r.seen) this.#putRec({ ...r, seen: null });
        out.changed ||= r.seen !== null;
        unmined.push({ ...r, seen: null });
        continue;
      }
      // Mined at head: by one of our versions, or (none found at confirmed depth) by something else.
      if (r.seen && (r.seen.block > n.confirmedBlock || r.nonce >= n.confirmed)) continue;
      const found = await this.#findReceipt(rpc, r, budget);
      if (found.found) {
        const { version: v, receipt } = found.found;
        const cost = receiptCostWei(receipt);
        // Final only with both: the receipt at confirmed depth AND the confirmed count past the nonce.
        if (receipt.blockNumber <= BigInt(n.confirmedBlock) && r.nonce < n.confirmed) {
          this.#resolve(r, { state: 'mined', hash: v.hash, minedHash: v.hash, outcome: v.kind, costWei: cost.toString() }, BigInt(r.worstWei) - cost);
          log({ event: 'evm_relay_mined', chainId: c.chain.chainId, nonce: String(r.nonce), evmTx: v.hash, code: v.kind });
        } else this.#putRec({ ...r, seen: { hash: v.hash, block: Number(receipt.blockNumber) } });
        out.changed = true;
      } else if (found.complete && r.seen) {
        this.#putRec({ ...r, seen: null });
        out.changed = true;
      }
      if (!found.found && r.nonce < n.confirmed) {
        if (found.complete) out.conditions.push({ reason: 'nonce_consumed_elsewhere', nonce: r.nonce });
        else out.incomplete = true;
      }
    }

    const lowest = unmined[0]?.nonce ?? meta.nextNonce;
    if (lowest !== null && n.pending < lowest) out.conditions.push({ reason: 'nonce_gap', nonce: (out.gap = n.pending) });

    let signatures = 0;
    for (const r of unmined) {
      if (now > r.deadline * 1000 + EVM_RELAYER_STUCK_AFTER_DEADLINE_MS) out.conditions.push({ reason: 'stuck_past_deadline', nonce: r.nonce });
      if (rpc.remaining < 1) continue;
      const due = signatures < EVM_RELAYER_RUN_LIMITS.signatures && this.#canSign(c, meta) ? this.#nextVersion(c, r, now, n.baseFee) : null;
      if (due === 'fee_cap_too_low') out.conditions.push({ reason: 'relayer_cannot_send', nonce: r.nonce, code: due });
      const next = due === 'fee_cap_too_low' ? null : due;
      if (next) {
        signatures++;
        await this.#store(next);
        out.changed = true;
      }
      const v = latestOf(next ?? r);
      const sent = await rpc.broadcast(v.raw);
      if (sent.kind !== 'accepted' || next) log({ event: next ? `evm_relay_${v.kind === 'cancel' ? 'cancel_sent' : 'bumped'}` : 'evm_relay_rebroadcast', chainId: c.chain.chainId, nonce: String(r.nonce), evmTx: v.hash, code: sent.kind === 'rejected' ? sent.reason : sent.kind }, 'warn');
      const after = this.#afterBroadcast(next ?? r, sent, false, sent.kind === 'rejected' && sent.byRead === 'replacement_underpriced' && n.pending > r.nonce);
      // A batch just refused (its cancel is due) or newly accepted: run again soon.
      out.changed ||= (after.accepted && !r.accepted) || (after.batchRejected !== null && r.batchRejected === null) || (after.priceRefused === true && !r.priceRefused);
      if (after.cannotSend !== null && sent.kind === 'rejected') out.conditions.push({ reason: 'relayer_cannot_send', nonce: r.nonce, code: after.cannotSend });
      // A batch no endpoint ever took, broadcast again without being taken, whose nonce the trusted pool doesn't hold
      // (pending == its nonce), on TWO runs in a row (a pool-less endpoint's pending count never moves, so once is not
      // evidence), with a later record waiting behind it: its cancel takes the nonce now. Nothing behind: the deadline.
      const unpooled = !after.accepted && after.digest !== null && latestOf(after).kind === 'execute' && sent.kind !== 'accepted' && n.pending === r.nonce;
      const runs = unpooled ? (r.unpooledRuns ?? 0) + 1 : 0;
      if (runs !== (after.unpooledRuns ?? 0)) this.#putRec({ ...after, unpooledRuns: runs });
      const blocking = meta.nextNonce !== null && r.nonce < meta.nextNonce - 1;
      if (unpooled && runs >= 2 && blocking && signatures < EVM_RELAYER_RUN_LIMITS.signatures && this.#canSign(c, meta)) {
        const cancel = this.#nextVersion(c, this.#rec(r.nonce) ?? after, now, n.baseFee, true);
        if (cancel === 'fee_cap_too_low') out.conditions.push({ reason: 'relayer_cannot_send', nonce: r.nonce, code: cancel });
        else if (cancel) {
          signatures++;
          await this.#store(cancel);
          log({ event: 'evm_relay_cancel_sent', chainId: c.chain.chainId, nonce: String(r.nonce), evmTx: latestOf(cancel).hash, code: 'unaccepted_not_pooled' }, 'warn');
          this.#afterBroadcast(cancel, await rpc.broadcast(latestOf(cancel).raw), false);
          out.changed = true;
        }
      }
    }
    // Still refused for a reason of ours, and nothing accepted since: the cause persists (staffResume refuses).
    for (const r of this.#records()) if (r.nonce >= n.latest && r.cannotSend !== null && !r.accepted && !out.conditions.some((x) => x.reason === 'relayer_cannot_send' && x.nonce === r.nonce)) out.conditions.push({ reason: 'relayer_cannot_send', nonce: r.nonce, code: r.cannotSend });
    this.#ops.fetches = rpc.requestsUsed;
    return out;
  }

  /**
   * The record with a new version due now, or null: a cancel once the batch's deadline passed or the batch was
   * refused with none accepted (or `cancel`: staffCancel and send's at-once cancel), a cancel repriced after a price
   * refusal, else a bump after 60 s. A cancel is priced from `baseFee` (cancelFees); `fee_cap_too_low` when the caps
   * allow no valid one.
   */
  #nextVersion(c: Ctx, r: Rec, now: number, baseFee: bigint, cancel = false): Rec | 'fee_cap_too_low' | null {
    const last = latestOf(r);
    const toCancel = last.kind === 'execute' && r.digest !== null && (cancel || now > r.deadline * 1000 || (r.batchRejected !== null && !r.accepted));
    const kind = toCancel || last.kind === 'cancel' ? 'cancel' : 'execute';
    const reprice = last.kind === 'cancel' && r.priceRefused === true && !r.accepted;
    if (r.versions.length >= (kind === 'cancel' ? EVM_RELAYER_MAX_VERSIONS : EVM_RELAYER_MAX_VERSIONS - 1)) return null;
    if (!toCancel && !cancel && !reprice && now - r.signedAt < EVM_RELAYER_BUMP_AFTER_MS) return null;
    const fees = kind === 'cancel' ? cancelFees(feesOf(last), baseFee, c.chain) : bumpedFees(feesOf(last), c.chain);
    // Only a version that is REQUIRED (a staff cancel, or a first cancel or a reprice of a record nothing has taken)
    // and impossible is `fee_cap_too_low`; a routine bump the caps stop is no new version: the latest goes out again.
    if (!fees) return kind === 'cancel' && (cancel || ((toCancel || reprice) && !r.accepted)) ? 'fee_cap_too_low' : null;
    const t: Payload = kind === 'cancel' ? selfTransfer(this.#meta()!.address) : { to: r.to, data: r.data, gas: BigInt(r.gas), authorization: r.authorization };
    return { ...r, to: t.to, data: t.data, gas: t.gas.toString(), authorization: t.authorization, signedAt: now, priceRefused: false, versions: [...r.versions, version(this.#sign(c, r.nonce, t, fees), kind, fees)] };
  }

  /**
   * A record's `seen` now, on the run's own evidence (a receipt of one of its versions, the latest count past its
   * nonce), or null when not shown, or when a read fails. At most 1 + its versions' count fetches.
   */
  async #seenNow(rpc: SponsorChain, r: Rec): Promise<Rec['seen']> {
    const latest = await rpc.transactionCount(this.#meta()!.address, 'latest').catch(() => null);
    if (latest === null || latest <= r.nonce) return null;
    const found = await this.#findReceipt(rpc, r, { left: EVM_RELAYER_MAX_VERSIONS });
    return found.found ? { hash: found.found.version.hash, block: Number(found.found.receipt.blockNumber) } : null;
  }

  /** Receipts of the record's versions (the one seen mined, then newest first) until one is found. */
  async #findReceipt(rpc: SponsorChain, r: Rec, budget: { left: number }): Promise<{ found: { version: Version; receipt: EvmReceipt } | null; complete: boolean }> {
    const order = [...r.versions].reverse().sort((a, b) => Number(b.hash === r.seen?.hash) - Number(a.hash === r.seen?.hash));
    for (const v of order) {
      if (budget.left <= 0) return { found: null, complete: false };
      budget.left--;
      const receipt = await rpc.receipt(v.hash).catch(() => undefined);
      if (receipt === undefined) {
        budget.left = 0;
        return { found: null, complete: false };
      }
      if (receipt) return { found: { version: v, receipt }, complete: true };
    }
    return { found: null, complete: true };
  }

  /** A record made final (mined, or closed by staff): deleted, its batch kept 7 days (hashes only), `giveBack` off the backstop. */
  #resolve(r: Rec, d: Required<Pick<Dig, 'state' | 'hash' | 'minedHash' | 'outcome' | 'costWei'>>, giveBack: bigint): void {
    const kv = this.ctx.storage.kv;
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      kv.delete(recKey(r.nonce));
      if (r.digest) {
        kv.put(digKey(r.digest), { nonce: r.nonce, reservedWei: r.reservedWei, ...d, hashes: r.versions.map((x) => x.hash), ...(r.batchRejected !== null ? { batchRejected: r.batchRejected, ...(r.batchCause ? { batchCause: r.batchCause } : {}) } : {}), resolvedAt: now } satisfies Dig);
        kv.put(forgetKey(now + EVM_RELAYER_REMEMBER_MS, r.digest), 1);
      }
      const m = this.#meta()!;
      if (giveBack > 0n && m.day === r.day) this.#putMeta({ ...m, dayWei: (BigInt(m.dayWei) > giveBack ? BigInt(m.dayWei) - giveBack : 0n).toString() });
    });
    if (d.state === 'closed') log({ event: 'evm_relay_closed', nonce: String(r.nonce), code: d.outcome }, 'warn');
  }

  // ---- shared steps ----

  /** Runs `fn` after every earlier one has finished: never two at once, across their awaits. */
  #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  #context(chainId: number): Ctx {
    const setting = parseEvmSponsorConfig(this.env.EVM_SPONSOR, { network: this.env.NETWORK, envName: this.env.ENV_NAME, pinnedDelegates: SPONSOR_DELEGATES });
    if (setting.status !== 'configured') refuse('relayer_unconfigured');
    const config = (setting as { config: EvmSponsorConfig }).config;
    const chain = sponsorChain(config, chainId) ?? refuse('relayer_unconfigured');
    const key = parseEvmRelayKey(this.env.EVM_RELAY_KEYS);
    const keyAddress = key ? addressOfKey(key, () => this.#ops.keyDerivations++) : null;
    if (key && keyAddress === config.relayerAddress) return { chain, key, keyAddress, keyWrong: false };
    key?.fill(0);
    log({ event: 'evm_relayer_key_mismatch', chainId, code: key ? 'address_mismatch' : 'key_missing_or_malformed' }, 'error');
    return { chain, key: null, keyAddress: null, keyWrong: key !== null };
  }

  #canSign = (c: Ctx, meta: Meta): boolean => c.key !== null && c.keyAddress === meta.address;
  #client = (c: Ctx): SponsorChain => sponsorChainFor(this.env, c.chain, { maxRequests: EVM_RELAYER_MAX_REQUESTS });

  /** The trusted endpoint's counts for the relayer: at the head, at confirmed depth, and pending. */
  async #counts(rpc: SponsorChain, address: Hex): Promise<Counts> {
    const block = await rpc.latestBlock();
    const head = Number(block.number);
    const safe = await rpc.safeBlockNumber();
    const confirmedBlock = Math.max(0, Math.min(head, safe ?? head - EVM_RELAYER_DEPTH_WITHOUT_SAFE));
    return { head, baseFee: block.baseFeePerGas, confirmedBlock, latest: await rpc.transactionCount(address, head), confirmed: await rpc.transactionCount(address, confirmedBlock), pending: await rpc.transactionCount(address, 'pending') };
  }

  /** Whether a stored invariant is broken. */
  #inconsistency(meta: Meta, records: Rec[]): boolean {
    return records.some((r) => {
      if (meta.nextNonce === null || r.nonce >= meta.nextNonce || !Array.isArray(r.versions) || r.versions.length < 1 || r.versions.length > EVM_RELAYER_MAX_VERSIONS) return true;
      const d = r.digest === null ? null : this.ctx.storage.kv.get<Dig>(digKey(r.digest));
      return d !== null && (!d || d.state !== 'pending' || d.nonce !== r.nonce);
    });
  }

  /**
   * Whether a first version's `replacement_underpriced` is confirmed on our own evidence: the trusted read endpoint
   * itself refused it so, and its pending count shows a transaction of this key at or past the nonce. Any doubt
   * (the fallback alone, the read failing, nothing there) is false.
   */
  async #heldElsewhere(rpc: SponsorChain, sent: EvmBroadcast, nonce: number, address: Hex): Promise<boolean> {
    if (sent.kind !== 'rejected' || sent.byRead !== 'replacement_underpriced') return false;
    const pending = await rpc.transactionCount(address, 'pending').catch(() => null);
    return pending !== null && pending > nonce;
  }

  /** A refusal that would halt, not confirmed by the trusted endpoint: counted for staff and logged, nothing more. */
  #noteUnconfirmed(nonce: number, code: string): void {
    const m = this.#meta();
    if (!m) return;
    this.#putMeta({ ...m, unconfirmedRefusal: { count: (m.unconfirmedRefusal?.count ?? 0) + 1, lastAt: Date.now(), nonce, code } });
    log({ event: 'evm_relay_refusal_unconfirmed', chainId: m.chainId, nonce: String(nonce), code }, 'warn');
  }

  #halt(h: Condition, now: number): void {
    const m = this.#meta();
    if (!m || m.halted) return;
    this.#putMeta({ ...m, halted: { reason: h.reason, since: now, ...(h.nonce !== undefined ? { nonce: h.nonce } : {}), ...(h.code !== undefined ? { code: h.code } : {}) } });
    log({ event: 'evm_relayer_halted', chainId: m.chainId, code: h.code ? `${h.reason}:${h.code}` : h.reason, ...(h.nonce !== undefined ? { nonce: String(h.nonce) } : {}) }, 'error');
  }

  #meta(): Meta | undefined {
    const m = this.ctx.storage.kv.get<Meta>('meta');
    return m === undefined || m.v === SCHEMA ? m : refuse('internal');
  }

  #putMeta = (m: Meta): void => this.ctx.storage.kv.put('meta', m);
  #rec = (nonce: number): Rec | undefined => this.ctx.storage.kv.get<Rec>(recKey(nonce));
  #putRec = (r: Rec): void => this.ctx.storage.kv.put(recKey(r.nonce), r);
  #records = (): Rec[] => Array.from(this.ctx.storage.kv.list<Rec>({ prefix: 'rec:' }), ([, v]) => v);

  /** Forgets batches 7 days after they were final (at most PRUNE_PER_RUN a run). */
  #prune(now: number): void {
    const kv = this.ctx.storage.kv;
    const due = Array.from(kv.list<number>({ prefix: 'fgt:', end: `fgt:${pad(now)};`, limit: PRUNE_PER_RUN }), ([k]) => k);
    if (due.length === 0) return;
    this.ctx.storage.transactionSync(() => {
      let forgotten = 0;
      for (const k of due) {
        const d = k.slice(k.lastIndexOf(':') + 1);
        kv.delete(k);
        if (kv.get<Dig>(digKey(d))?.state === 'pending') continue;
        forgotten += kv.delete(digKey(d)) ? 1 : 0;
      }
      const m = this.#meta()!;
      this.#putMeta({ ...m, remembered: Math.max(0, m.remembered - forgotten) });
    });
  }

  /** While records exist: 15 s after a change, else double up to 5 minutes. Else hourly (or the next forget time if sooner). */
  async #schedule(now: number, changed: boolean): Promise<void> {
    const m = this.#meta()!;
    const records = this.#records();
    if (records.length > 0) {
      // Never backed off while a record is unmined and no endpoint has taken it (it may be holding every later one up).
      const urgent = records.some((r) => r.seen === null && !r.accepted);
      const every = changed || urgent ? EVM_RELAYER_ALARM_MS : Math.min(m.alarmMs * 2, EVM_RELAYER_ALARM_MAX_MS);
      if (m.alarmMs !== every) this.#putMeta({ ...m, alarmMs: every });
      return this.ctx.storage.setAlarm(now + every);
    }
    const next = Array.from(this.ctx.storage.kv.list<number>({ prefix: 'fgt:', limit: 1 }), ([k]) => Number(k.slice(4, 20)) + 1)[0];
    const at = Math.min(next ?? Number.POSITIVE_INFINITY, m.nextNonce !== null ? now + EVM_RELAYER_IDLE_CHECK_MS : Number.POSITIVE_INFINITY);
    return Number.isFinite(at) ? this.ctx.storage.setAlarm(Math.max(now + 1_000, at)) : this.ctx.storage.deleteAlarm();
  }

  // ---- staff plumbing ----

  /** Checks the caller's input, runs `fn` in the queue (null: done, else why refused) and records the action. */
  async #staffAct(guard: string, who: string, note: string, what: Pick<EvmRelayerStaffEntry, 'action' | 'nonce' | 'verdict'>, fn: (meta: Meta, c: Ctx) => Promise<string | null>): Promise<EvmRelayerStaffResult> {
    const text = (s: unknown, max: number): boolean => typeof s === 'string' && s.trim().length > 0 && s.length <= max && !/[\u0000-\u001f\u007f]/u.test(s);
    if (guard !== EVM_RELAYER_STAFF_GUARD || !text(who, 128) || !text(note, 500) || (what.nonce !== null && (!Number.isSafeInteger(what.nonce) || what.nonce < 0))) refuse('invalid_request');
    return this.#exclusive(async () => {
      this.#ops = { signatures: 0, recoveries: 0, fetches: 0, keyDerivations: 0 };
      const meta = this.#meta();
      let refused: string | null = 'no_state';
      let c: Ctx | null = null;
      try {
        if (meta) refused = await fn(meta, (c = this.#context(meta.chainId)));
      } catch (e) {
        refused = evmRelayerError(e)?.code ?? (e instanceof EvmRpcError ? 'rpc_unavailable' : 'internal');
      } finally {
        c?.key?.fill(0);
      }
      const m = this.#meta();
      if (m) {
        const seq = m.staffSeq + 1;
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.kv.put(staffKey(seq), { seq, at: Date.now(), who, ...what, note, done: refused === null, refused } satisfies EvmRelayerStaffEntry);
          if (seq > STAFF_LOG_KEEP) this.ctx.storage.kv.delete(staffKey(seq - STAFF_LOG_KEEP));
          this.#putMeta({ ...this.#meta()!, staffSeq: seq });
        });
        await this.#schedule(Date.now(), true);
      }
      log({ event: 'evm_relayer_staff', code: `${what.action}_${refused === null ? 'done' : 'refused'}`, ...(what.nonce !== null ? { nonce: String(what.nonce) } : {}) }, 'warn');
      return { done: refused === null, refused, status: await this.#staffView() };
    });
  }

  async #staffView(): Promise<EvmRelayerStaffStatus> {
    const meta = this.#meta();
    const s = await this.status().catch(() => ({ address: '0x' as Hex, unmined: 0, awaitingConfirmation: 0, oldestUnminedMs: null, oldestUnacceptedMs: null, nextNonce: null, halted: null }));
    const records = this.#records().map(({ versions, to: _t, data: _d, authorization: _a, ...r }) => ({ ...r, versions: versions.map(({ raw: _r, ...v }) => v) }));
    const staffLog = Array.from(this.ctx.storage.kv.list<EvmRelayerStaffEntry>({ prefix: 'staff:', reverse: true, limit: 50 }), ([, v]) => v);
    return { ...s, chainId: meta?.chainId ?? null, dayWei: BigInt(meta?.dayWei ?? '0'), gapSeen: meta?.gapSeen ?? null, unconfirmedRefusal: meta?.unconfirmedRefusal ?? null, records, staffLog };
  }
}
