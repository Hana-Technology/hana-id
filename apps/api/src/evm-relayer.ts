// The EVM relayer for gas sponsorship (D851; replaces D837's self-repairing design). One SQLite-backed Durable Object
// per chain and key, `evm-relayer-<chainId>-0`: it holds the relayer EOA's key (secret EVM_RELAY_KEYS) and its nonces.
// PRINCIPLE: do only what is safe on our own evidence; on anything odd, HALT and wait for staff. Evidence is only this
// object's storage, broadcast answers, and the ONE trusted read endpoint's answers (EVM_SPONSOR_RPC_<chainId>, else the
// manifest's `rpc`) about the relayer's own counts and our own transaction hashes. Nothing in a user's account is.
//
// A RECORD is one nonce: `rec:<nonce>` until final, its batch in `dig:<digest>` (kept 7 days after it is final).
//   new          send(): a verified Execute gets `nextNonce`, is signed, persisted (sync) BEFORE its broadcast.
//   unmined → seen        a receipt of one of ITS OWN versions exists (the trusted endpoint, any block).
//   seen → mined (final)  that receipt's block is at confirmed depth (≤ `safe`, else ≤ head − 12): minedHash, outcome
//                         (`execute`/`cancel`) and cost recorded, the record deleted, its batch kept as `mined`.
//   seen → unmined        the latest count falls to or below its nonce (a reorg): its latest raw is broadcast again.
//   unmined/seen → closed (final)  only staffClose, with a verdict (`consumed_elsewhere`/`never_sent`).
// While unmined at head (nonce ≥ the latest count) each run does ONE of: a new version (signed, persisted, synced,
// then broadcast; ≤ 8 versions, all hashes and raws kept until final), or a rebroadcast of the latest raw.
//   cancel   the batch's deadline passed: a 0-value self-transfer at the same nonce, fees bumped.
//   bump     the latest version was signed ≥ 60 s ago: both fees × 1.125 within the caps (7 versions, the 8th for the
//            cancel). Sends must start with room for two bumps (`maxStartingFees`).
//   (filler) staffFill: a 0-value self-transfer at a gap nonce, a record with no batch.
//
// THE OBJECT: fresh (no `nextNonce`) → running → halted(reason). A fresh object reads the pending count ONCE, at its
// first send, as its first nonce; after that only `nextNonce + 1` per send, or staffAdoptNonce, sets it. NOTHING
// clears a halt by itself: only staffResume, which re-reads the chain and refuses while any condition below holds.
// HALT conditions (checked by every alarm run and by staffResume; at send where noted):
//   nonce_consumed_elsewhere  the confirmed count is past a record's nonce and none of its versions has a receipt.
//   nonce_gap                 the pending count is below the lowest record unmined at head (or `nextNonce` if none),
//                             seen on two runs in a row: a nonce nobody holds blocks every later one.
//   foreign_transactions      the latest or pending count is above `nextNonce`: another sender uses this key.
//   rejected_unsent           a definite pool rejection of a record none of whose versions was ever accepted (at
//                             send: any; later: any but `nonce too low`, which the first rule settles by receipts).
//   stuck_past_deadline       a record unmined at head 30 minutes after its batch's deadline.
//   key_mismatch              records exist and the key's address is not `relayerAddress` or not the records' signer
//                             (also at send). A missing key halts nothing: it only stops signing.
//   storage_inconsistent      a stored invariant broken (records without `nextNonce`, a record at or above it, a
//                             record's batch entry missing or pointing elsewhere; also at send).
// WHILE HALTED: new sends are refused (`relayer_halted`); replays of a known digest still answer; every run still
// finalizes by receipts, rebroadcasts, bumps and cancels (all safe on our own evidence). Nothing is deleted, adopted,
// reassigned or guessed except by a staff tool, and each staff action is recorded (who, when, what, note, outcome).
// STAFF (evm-relayer-staff.ts only; each re-reads the chain and refuses unsafe use):
//   staffClose(n, consumed_elsewhere)  confirmed count > n and every version's receipt read: none. Reservation kept.
//   staffClose(n, never_sent)          no version ever accepted, latest and pending counts ≤ n, deadline passed. Freed.
//   staffFill(n)        no record at n, n < nextNonce, n == the pending count and the latest count ≤ n.
//   staffAdoptNonce(n)  no unmined record, n above every record, latest == pending == n.
//
// Concurrency: every operation that reads or changes nonce state (send, the alarm, the staff tools) runs through one
// FIFO queue (`exclusive`), across its RPC awaits; storage uses the synchronous KV API, each change one
// `transactionSync`. `status`, `lookup` and `staffStatus` read storage only. Bounded: ≤ 45 fetches, ≤ 20 receipt
// reads and ≤ 4 signatures a run; ≤ 8 unmined and ≤ 64 records (`relayer_busy` beyond), ≤ 16 sends waiting; the
// alarm runs while records exist, 15 s after a change, doubling to 5 minutes while nothing changes. Daily backstop: a
// UTC day's worst cases (each send's reservation with its gas at the fee cap) ≤ 2 × `dailyBudgetEth` (`daily_cap`).
// Errors: `Error('evm_relayer:<code>[:<reason>]')` (evmRelayerError). A coded error means THIS call sent nothing; any
// other failure is unknown (keep the reservation; resending the same digest is safe). SECURITY: nothing logs the key, a
// raw transaction, calldata, a signature, an authorization or an RPC URL; the key is parsed per section, then zeroed.
import { DurableObject } from 'cloudflare:workers';
import { type ExecuteInput, type SignedAuthorization, SPONSOR_DELEGATES, type SponsorTx, encodeExecuteCalldata, executeDigest, recoverAuthorization, recoverExecuteSigner, signSponsorTx, sponsorTxHash } from '@hana-id/core/evm-sponsor';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import type { Env } from './env.ts';
import { log } from './log.ts';
import { type EvmBroadcast, type EvmReceipt, EvmRpcError, type Hex, type SponsorChain, receiptCostWei, sponsorChainFor } from './evm/sponsor-chain.ts';
import { type EvmSponsorChainConfig, type EvmSponsorConfig, checksumEvmAddress, parseEvmSponsorConfig, sponsorChain } from './evm/sponsor-config.ts';

export type { Hex };

/** The guard the staff methods require (re-exported by evm-relayer-staff.ts, for the admin package only). */
export const EVM_RELAYER_STAFF_GUARD = 'hana-id/evm-relayer/staff/v1';
export const evmRelayerName = (chainId: number, keyIndex = 0): string => `evm-relayer-${chainId}-${keyIndex}`;
export const EVM_RELAYER_ALARM_MS = 15_000;
export const EVM_RELAYER_ALARM_MAX_MS = 5 * 60_000;
export const EVM_RELAYER_BUMP_AFTER_MS = 60_000;
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
const DAILY_CAP_FACTOR = 2n;
const MIN_DEADLINE_LEAD_S = 5;
const DEADLINE_SLACK_S = 60;
const MAX_DATA_BYTES = 32 * 1024;
const STAFF_LOG_KEEP = 200;
const PRUNE_PER_RUN = 256;
const DAY_MS = 24 * 60 * 60_000;
const SCHEMA = 1;

export type EvmRelayerHaltReason = 'nonce_consumed_elsewhere' | 'nonce_gap' | 'foreign_transactions' | 'rejected_unsent' | 'stuck_past_deadline' | 'key_mismatch' | 'storage_inconsistent';
export type EvmRelayerHalt = { reason: EvmRelayerHaltReason; since: number; nonce?: number };
export type EvmRelayerOutcome = 'execute' | 'cancel' | 'consumed_elsewhere' | 'never_sent';
export type EvmRelayerVerdict = 'consumed_elsewhere' | 'never_sent';

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
/** `transactionHash`/`raw`: the version seen mined, else the latest. `replay`: this digest was already sent. */
export interface EvmRelayerSent { digest: Hex; transactionHash: Hex; relayerNonce: number; raw: Hex; replay: boolean }
/** `minedHash`, `outcome` (`execute`/`cancel`) and `costWei` only once mined at confirmed depth; `closed` by staff. */
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
export interface EvmRelayerStatus { address: Hex; unmined: number; awaitingConfirmation: number; oldestUnminedMs: number | null; nextNonce: number | null; halted: null | EvmRelayerHalt }
export interface EvmRelayerStaffEntry {
  seq: number;
  at: number;
  who: string;
  action: 'resume' | 'close' | 'fill' | 'adopt_nonce';
  nonce: number | null;
  verdict: EvmRelayerVerdict | null;
  note: string;
  done: boolean;
  refused: string | null;
}
/** Every record as stored (no raw transactions), the day's backstop and the last 50 staff actions. */
export interface EvmRelayerStaffStatus extends EvmRelayerStatus {
  chainId: number | null;
  dayWei: bigint;
  gapSeen: number | null;
  records: (Omit<Rec, 'versions' | 'to' | 'data' | 'authorization'> & { versions: Omit<Version, 'raw'>[] })[];
  staffLog: EvmRelayerStaffEntry[];
}
export interface EvmRelayerStaffResult { done: boolean; refused: string | null; status: EvmRelayerStaffStatus }

/** `rejected` is reserved by the interface and never thrown: a definite rejection halts, and the record is answered. */
export type EvmRelayerErrorCode = 'relayer_unconfigured' | 'relayer_misconfigured' | 'invalid_request' | 'fees_too_high' | 'wrong_chain' | 'deadline_passed' | 'relayer_busy' | 'relayer_halted' | 'daily_cap' | 'rpc_unavailable' | 'rejected' | 'internal';
const CODES: ReadonlySet<string> = new Set(['relayer_unconfigured', 'relayer_misconfigured', 'invalid_request', 'fees_too_high', 'wrong_chain', 'deadline_passed', 'relayer_busy', 'relayer_halted', 'daily_cap', 'rpc_unavailable', 'rejected', 'internal']);
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
const addressOfKey = (d: Uint8Array): Hex => checksumEvmAddress(toHex(keccak_256(secp256k1.getPublicKey(d, false).subarray(1)).subarray(-20))) as Hex;

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
const minBig = (a: bigint, b: bigint): bigint => (a < b ? a : b);
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
  if (data.length > 2 + 2 * MAX_DATA_BYTES) refuse('invalid_request');
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
}
interface StoredAuthorization { chainId: number; address: Hex; nonce: string; yParity: 0 | 1; r: Hex; s: Hex }
interface Version { hash: Hex; raw: Hex; kind: 'execute' | 'cancel'; maxFeePerGas: string; maxPriorityFeePerGas: string }
interface Rec {
  nonce: number;
  /** null for a staff filler. */
  digest: Hex | null;
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
  /** A definite rejection while never accepted, or null. */
  rejected: string | null;
  /** A receipt of one of its versions, not yet at confirmed depth. */
  seen: { hash: Hex; block: number } | null;
}
interface Dig {
  nonce: number;
  state: 'pending' | 'mined' | 'closed';
  reservedWei: string;
  /** Once final: the hash answered (the mined one, else the latest) and its raw, every version, the outcome. */
  hash?: Hex;
  raw?: Hex;
  hashes?: Hex[];
  minedHash?: Hex | null;
  outcome?: EvmRelayerOutcome;
  costWei?: string | null;
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

interface Ctx {
  chain: Readonly<EvmSponsorChainConfig>;
  /** The key, only when valid and the config's `relayerAddress`. */
  key: Uint8Array | null;
  keyAddress: Hex | null;
  /** A key is set but its address is not `relayerAddress`. */
  keyWrong: boolean;
}
type Counts = { head: number; confirmedBlock: number; latest: number; confirmed: number; pending: number };
type Condition = { reason: EvmRelayerHaltReason; nonce?: number };
/** `incomplete`: a record past the confirmed count could not be fully checked this run (budget or a failed read). */
type RunResult = { conditions: Condition[]; changed: boolean; incomplete: boolean; gap: number | null };

export class EvmRelayer extends DurableObject<Env> {
  #queue: Promise<unknown> = Promise.resolve();
  #waiting = 0;

  /** Checks the Execute, then signs, persists and broadcasts its transaction (or answers the one already sent). */
  async send(req: EvmRelayerSendRequest): Promise<EvmRelayerSent> {
    if (typeof req !== 'object' || req === null || !Number.isSafeInteger(req.chainId) || req.chainId <= 0 || typeof req.execute !== 'object' || req.execute === null) refuse('invalid_request');
    if (this.#waiting >= EVM_RELAYER_MAX_QUEUE) refuse('relayer_busy');
    this.#waiting++;
    let started = false;
    return this.#exclusive(async () => {
      started = true;
      this.#waiting--;
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
    return {
      address: meta?.address ?? evmRelayKeyAddress(this.env.EVM_RELAY_KEYS) ?? refuse('relayer_misconfigured'),
      unmined: unmined.length,
      awaitingConfirmation: records.length - unmined.length,
      oldestUnminedMs: oldest === null ? null : Math.max(0, Date.now() - oldest),
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

  async staffClose(guard: string, who: string, nonce: number, verdict: EvmRelayerVerdict, note: string): Promise<EvmRelayerStaffResult> {
    if (verdict !== 'consumed_elsewhere' && verdict !== 'never_sent') refuse('invalid_request');
    return this.#staffAct(guard, who, note, { action: 'close', nonce, verdict }, async (meta, c) => {
      const r = this.#rec(nonce);
      if (!r) return 'no_record';
      const rpc = this.#client(c);
      const n = await this.#counts(rpc, meta.address);
      if (verdict === 'consumed_elsewhere') {
        if (n.confirmed <= nonce) return 'nonce_not_consumed_at_confirmed_depth';
        const found = await this.#findReceipt(rpc, r, { left: EVM_RELAYER_MAX_VERSIONS });
        if (found.found) return 'receipt_found';
        if (!found.complete) return 'incomplete_check';
      } else {
        if (r.accepted) return 'accepted_before';
        if (n.latest > nonce || n.pending > nonce) return 'nonce_in_use';
        if (Date.now() <= r.deadline * 1000) return 'deadline_not_passed';
      }
      const last = latestOf(r);
      this.#resolve(r, { state: 'closed', hash: last.hash, raw: last.raw, minedHash: null, outcome: verdict, costWei: null }, verdict === 'never_sent' ? BigInt(r.worstWei) : 0n);
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
      const fees = maxStartingFees(c.chain);
      const worst = CANCEL_GAS * c.chain.maxFeePerGasWei;
      const r: Rec = { nonce, digest: null, deadline: Math.floor(now / 1000), reservedWei: '0', day: Math.floor(now / DAY_MS), worstWei: worst.toString(), ...t, gas: t.gas.toString(), sentAt: now, signedAt: now, versions: [version(signSponsorTx(c.key!, buildTx(c.chain.chainId, nonce, t, fees)), 'cancel', fees)], accepted: false, rejected: null, seen: null };
      await this.#persist(r, worst);
      this.#afterBroadcast(r, await rpc.broadcast(r.versions[0]!.raw), false);
      return null;
    });
  }

  async staffAdoptNonce(guard: string, who: string, nonce: number, note: string): Promise<EvmRelayerStaffResult> {
    return this.#staffAct(guard, who, note, { action: 'adopt_nonce', nonce, verdict: null }, async (meta, c) => {
      const records = this.#records();
      if (records.some((r) => r.seen === null)) return 'unmined_records';
      if (records.some((r) => r.nonce >= nonce)) return 'not_above_records';
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
    if (records.filter((r) => r.seen === null).length >= EVM_RELAYER_MAX_UNMINED || records.length >= EVM_RELAYER_MAX_RECORDS || (meta?.remembered ?? 0) >= EVM_RELAYER_MAX_REMEMBERED) refuse('relayer_busy');
    const day = Math.floor(now / DAY_MS);
    // The most any version can cost: the reservation with its gas at the fee cap (bumps and the cancel stay below).
    const worst = v.reservedWei + v.gas * (c.chain.maxFeePerGasWei - v.fees.maxFeePerGas);
    if ((meta && meta.day === day ? BigInt(meta.dayWei) : 0n) + worst > c.chain.dailyBudgetWei * DAILY_CAP_FACTOR) {
      log({ event: 'evm_relay_daily_cap', chainId: c.chain.chainId, code: 'daily_cap' }, 'error');
      refuse('daily_cap');
    }
    const rpc = this.#client(c);
    if (!meta || meta.nextNonce === null) {
      // A fresh nonce life: the trusted endpoint's pending count, read once. Nothing is stored if it fails.
      const pending = await rpc.transactionCount(c.keyAddress!, 'pending').catch(() => refuse('rpc_unavailable'));
      const fresh: Meta = { v: SCHEMA, chainId: c.chain.chainId, address: c.keyAddress!, nextNonce: null, halted: null, gapSeen: null, day, dayWei: '0', alarmMs: EVM_RELAYER_ALARM_MS, remembered: 0, staffSeq: 0 };
      this.#putMeta((meta = { ...(meta ?? fresh), nextNonce: pending }));
    }
    const nonce = meta.nextNonce!;
    let raw: Hex;
    try {
      raw = signSponsorTx(c.key!, buildTx(c.chain.chainId, nonce, v, v.fees));
    } catch {
      return refuse('invalid_request');
    }
    const r: Rec = { nonce, digest, deadline: v.deadline, reservedWei: v.reservedWei.toString(), day, worstWei: worst.toString(), to: v.to, data: v.data, gas: v.gas.toString(), authorization: v.authorization, sentAt: now, signedAt: now, versions: [version(raw, 'execute', v.fees)], accepted: false, rejected: null, seen: null };
    await this.#persist(r, worst);
    const hash = r.versions[0]!.hash;
    const sent = await rpc.broadcast(raw);
    log({ event: 'evm_relay_sent', chainId: c.chain.chainId, nonce: String(nonce), evmTx: hash, code: sent.kind === 'rejected' ? sent.reason : sent.kind }, sent.kind === 'accepted' ? 'info' : 'warn');
    if (this.#afterBroadcast(r, sent, true)) this.#halt({ reason: 'rejected_unsent', nonce }, Date.now());
    // Answered whatever the broadcast said: the record exists and every run broadcasts it again.
    return { digest, transactionHash: hash, relayerNonce: nonce, raw, replay: false };
  }

  #replay(digest: Hex, dig: Dig): EvmRelayerSent {
    if (dig.state !== 'pending') return { digest, transactionHash: dig.hash!, relayerNonce: dig.nonce, raw: dig.raw!, replay: true };
    const r = this.#rec(dig.nonce);
    if (!r || r.digest !== digest) {
      this.#halt({ reason: 'storage_inconsistent', nonce: dig.nonce }, Date.now());
      return refuse('internal');
    }
    const v = r.versions.find((x) => x.hash === r.seen?.hash) ?? latestOf(r);
    return { digest, transactionHash: v.hash, relayerNonce: r.nonce, raw: v.raw, replay: true };
  }

  /**
   * Stores a new record (with its batch entry, `nextNonce` + 1 and the day's worst case for a send) in one
   * transaction, sets the alarm and waits for storage to confirm it: only then may its raw leave.
   */
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

  /** The alarm set and storage confirmed: from here a broadcast can't outrun what it depends on. */
  async #persisted(now: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > now + EVM_RELAYER_ALARM_MS) await this.ctx.storage.setAlarm(now + EVM_RELAYER_ALARM_MS);
    await this.ctx.storage.sync();
  }

  /** Notes a broadcast's answer; true when it makes the record rejected_unsent (see the header). */
  #afterBroadcast(r: Rec, sent: EvmBroadcast, atSend: boolean): boolean {
    const cur = this.#rec(r.nonce);
    if (!cur) return false;
    if (sent.kind === 'accepted') {
      if (!cur.accepted || cur.rejected) this.#putRec({ ...cur, accepted: true, rejected: null });
      return false;
    }
    if (sent.kind !== 'rejected' || cur.accepted || (!atSend && sent.reason === 'nonce_too_low')) return false;
    if (cur.rejected !== sent.reason) this.#putRec({ ...cur, rejected: sent.reason });
    return true;
  }

  // ---- the alarm ----

  async #tick(): Promise<void> {
    const now = Date.now();
    const meta = this.#meta();
    if (!meta) return this.ctx.storage.deleteAlarm();
    this.#prune(now);
    if (this.#records().length === 0) return this.#schedule(now, false);
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
      if (r.seen && r.seen.block > n.confirmedBlock) continue;
      const found = await this.#findReceipt(rpc, r, budget);
      if (found.found) {
        const { version: v, receipt } = found.found;
        const cost = receiptCostWei(receipt);
        if (receipt.blockNumber <= BigInt(n.confirmedBlock)) {
          this.#resolve(r, { state: 'mined', hash: v.hash, raw: v.raw, minedHash: v.hash, outcome: v.kind, costWei: cost.toString() }, BigInt(r.worstWei) - cost);
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
      const next = signatures < EVM_RELAYER_RUN_LIMITS.signatures && this.#canSign(c, meta) ? this.#nextVersion(c, r, now) : null;
      if (next) {
        signatures++;
        this.#putRec(next);
        await this.#persisted(now);
        out.changed = true;
      }
      const v = latestOf(next ?? r);
      const sent = await rpc.broadcast(v.raw);
      out.changed ||= sent.kind === 'accepted' && !r.accepted;
      if (sent.kind !== 'accepted' || next) log({ event: next ? `evm_relay_${v.kind === 'cancel' ? 'cancel_sent' : 'bumped'}` : 'evm_relay_rebroadcast', chainId: c.chain.chainId, nonce: String(r.nonce), evmTx: v.hash, code: sent.kind === 'rejected' ? sent.reason : sent.kind }, 'warn');
      this.#afterBroadcast(r, sent, false);
    }
    for (const r of this.#records()) if (r.nonce >= n.latest && r.rejected && !r.accepted) out.conditions.push({ reason: 'rejected_unsent', nonce: r.nonce });
    return out;
  }

  /** The record with a new version due now (a cancel past the deadline, else a bump after 60 s), or null. */
  #nextVersion(c: Ctx, r: Rec, now: number): Rec | null {
    const last = latestOf(r);
    // The batch's deadline passed: switch to the self-transfer at once. Otherwise bump the latest kind after 60 s.
    const toCancel = last.kind === 'execute' && r.digest !== null && now > r.deadline * 1000;
    const kind = toCancel ? 'cancel' : last.kind;
    if (r.versions.length >= (kind === 'cancel' ? EVM_RELAYER_MAX_VERSIONS : EVM_RELAYER_MAX_VERSIONS - 1)) return null;
    if (!toCancel && now - r.signedAt < EVM_RELAYER_BUMP_AFTER_MS) return null;
    const fees = bumpedFees(feesOf(last), c.chain);
    if (!fees) return null;
    const t: Payload = toCancel ? selfTransfer(this.#meta()!.address) : { to: r.to, data: r.data, gas: BigInt(r.gas), authorization: r.authorization };
    const v = version(signSponsorTx(c.key!, buildTx(c.chain.chainId, r.nonce, t, fees)), kind, fees);
    return { ...r, to: t.to, data: t.data, gas: t.gas.toString(), authorization: t.authorization, signedAt: now, versions: [...r.versions, v] };
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

  /** A record made final (mined, or closed by staff): deleted, its batch kept 7 days, `giveBack` off the backstop. */
  #resolve(r: Rec, d: Required<Pick<Dig, 'state' | 'hash' | 'raw' | 'minedHash' | 'outcome' | 'costWei'>>, giveBack: bigint): void {
    const kv = this.ctx.storage.kv;
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      kv.delete(recKey(r.nonce));
      if (r.digest) {
        kv.put(digKey(r.digest), { nonce: r.nonce, reservedWei: r.reservedWei, ...d, hashes: r.versions.map((x) => x.hash), resolvedAt: now } satisfies Dig);
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
    const keyAddress = key ? addressOfKey(key) : null;
    if (key && keyAddress === config.relayerAddress) return { chain, key, keyAddress, keyWrong: false };
    key?.fill(0);
    log({ event: 'evm_relayer_key_mismatch', chainId, code: key ? 'address_mismatch' : 'key_missing_or_malformed' }, 'error');
    return { chain, key: null, keyAddress: null, keyWrong: key !== null };
  }

  #canSign = (c: Ctx, meta: Meta): boolean => c.key !== null && c.keyAddress === meta.address;
  #client = (c: Ctx): SponsorChain => sponsorChainFor(this.env, c.chain, { maxRequests: EVM_RELAYER_MAX_REQUESTS });

  /** The trusted endpoint's counts for the relayer: at the head, at confirmed depth, and pending. */
  async #counts(rpc: SponsorChain, address: Hex): Promise<Counts> {
    const head = await rpc.blockNumber();
    const safe = await rpc.safeBlockNumber();
    const confirmedBlock = Math.max(0, Math.min(head, safe ?? head - EVM_RELAYER_DEPTH_WITHOUT_SAFE));
    return { head, confirmedBlock, latest: await rpc.transactionCount(address, head), confirmed: await rpc.transactionCount(address, confirmedBlock), pending: await rpc.transactionCount(address, 'pending') };
  }

  /** Whether a stored invariant is broken. */
  #inconsistency(meta: Meta, records: Rec[]): boolean {
    return records.some((r) => {
      if (meta.nextNonce === null || r.nonce >= meta.nextNonce || !Array.isArray(r.versions) || r.versions.length < 1 || r.versions.length > EVM_RELAYER_MAX_VERSIONS) return true;
      const d = r.digest === null ? null : this.ctx.storage.kv.get<Dig>(digKey(r.digest));
      return d !== null && (!d || d.state !== 'pending' || d.nonce !== r.nonce);
    });
  }

  #halt(h: Condition, now: number): void {
    const m = this.#meta();
    if (!m || m.halted) return;
    this.#putMeta({ ...m, halted: { reason: h.reason, since: now, ...(h.nonce !== undefined ? { nonce: h.nonce } : {}) } });
    log({ event: 'evm_relayer_halted', chainId: m.chainId, code: h.reason, ...(h.nonce !== undefined ? { nonce: String(h.nonce) } : {}) }, 'error');
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

  /** While records exist: 15 s after a change, else double up to 5 minutes. Else the next forget time, or none. */
  async #schedule(now: number, changed: boolean): Promise<void> {
    if (this.#records().length > 0) {
      const m = this.#meta()!;
      const every = changed ? EVM_RELAYER_ALARM_MS : Math.min(m.alarmMs * 2, EVM_RELAYER_ALARM_MAX_MS);
      if (m.alarmMs !== every) this.#putMeta({ ...m, alarmMs: every });
      return this.ctx.storage.setAlarm(now + every);
    }
    const next = Array.from(this.ctx.storage.kv.list<number>({ prefix: 'fgt:', limit: 1 }), ([k]) => k)[0];
    return next ? this.ctx.storage.setAlarm(Math.max(now + 1_000, Number(next.slice(4, 20)) + 1)) : this.ctx.storage.deleteAlarm();
  }

  // ---- staff plumbing ----

  /** Checks the caller's input, runs `fn` in the queue (null: done, else why refused) and records the action. */
  async #staffAct(guard: string, who: string, note: string, what: Pick<EvmRelayerStaffEntry, 'action' | 'nonce' | 'verdict'>, fn: (meta: Meta, c: Ctx) => Promise<string | null>): Promise<EvmRelayerStaffResult> {
    const text = (s: unknown, max: number): boolean => typeof s === 'string' && s.trim().length > 0 && s.length <= max && !/[\u0000-\u001f\u007f]/u.test(s);
    if (guard !== EVM_RELAYER_STAFF_GUARD || !text(who, 128) || !text(note, 500) || (what.nonce !== null && (!Number.isSafeInteger(what.nonce) || what.nonce < 0))) refuse('invalid_request');
    return this.#exclusive(async () => {
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
    const s = await this.status().catch(() => ({ address: '0x' as Hex, unmined: 0, awaitingConfirmation: 0, oldestUnminedMs: null, nextNonce: null, halted: null }));
    const records = this.#records().map(({ versions, to: _t, data: _d, authorization: _a, ...r }) => ({ ...r, versions: versions.map(({ raw: _r, ...v }) => v) }));
    const staffLog = Array.from(this.ctx.storage.kv.list<EvmRelayerStaffEntry>({ prefix: 'staff:', reverse: true, limit: 50 }), ([, v]) => v);
    return { ...s, chainId: meta?.chainId ?? null, dayWei: BigInt(meta?.dayWei ?? '0'), gapSeen: meta?.gapSeen ?? null, records, staffLog };
  }
}
