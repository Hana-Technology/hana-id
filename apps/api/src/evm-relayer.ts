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
// itself but ONE case (D890, below): staffResume, which re-reads the chain and refuses while any condition holds. Conditions, checked by
// every alarm run (also with no records: hourly), at send where noted, and by staffResume; none is user-triggerable:
//   nonce_consumed_elsewhere  the confirmed count is past a nonce, a complete check finds no receipt of its versions.
//   nonce_gap                 the pending count below the lowest record unmined at head (or `nextNonce`), twice running.
//   foreign_transactions      the latest or pending count is above `nextNonce` (another sender with our key).
//   relayer_cannot_send       a relayer-cause refusal of a version (our cancel's: any but its price), none accepted,
//                             or `fee_cap_too_low` (`code`; at send too; later `nonce too low`: receipts decide).
//   stuck_past_deadline       unmined at head 30 minutes after the deadline although its cancel goes out (fees, funds).
//   key_mismatch              records exist, the key isn't `relayerAddress` or their signer (a missing one: no halt).
//   storage_inconsistent      a stored invariant broken (records vs `nextNonce`, a batch entry; also at send).
//   relayer_has_code          code at the relayer's own address (D890 review; at the first send and AdoptNonce too).
// WHILE HALTED: new sends `relayer_halted`; replays answer; runs finalize, rebroadcast, bump, cancel. STAFF (recorded:
// who, when, what, note, outcome; evm-relayer-staff.ts only; each re-reads the chain; given what the staffer saw, the
// halt's start and the last staff action's number, it refuses `version_conflict` inside the queue when they changed):
//   staffClose(n, consumed_elsewhere)  confirmed count > n, every version's receipt read: none. Reservation kept.
//   staffCancel(n)      a record with no receipt, its nonce not mined at head: a cancel version (old ones kept).
//   staffFill(n)        no record at n, n < nextNonce, n == the pending count and the latest count ≤ n.
//   staffAdoptNonce(n)  no unmined record, n ≥ nextNonce (so above every record), latest == pending == n.
//   staffResume         only with `keyConfirmed` once the pause is marked `leakSeen` (a leak-type reason or condition
//                       seen during it, or a staff Close/Fill/AdoptNonce done during it): `key_confirmation_required`.
// THE ONE AUTOMATIC RESTART (D890, the Tech Lead's decision; amended after its security review): a pause for money
// (`relayer_cannot_send` · `insufficient_funds`) ends by itself on an alarm run (never on a request) only when ALL
// hold: the chain's `autoRestart` is on (default off); the only reason is money and no other condition was seen
// during the pause (`otherSeen`); not `leakSeen`; fewer than 3 automatic restarts this UTC day; the pause began 30
// minutes or more after the last one and is 60 s old; the run's own verdict is staffResume's (no condition, complete);
// every slot below the latest count had its own receipt seen and the TRUSTED endpoint itself took each waiting record
// on this run; the key loaded; fresh trusted reads: counts within our records, balance ≥ `lowBalanceEth` + every
// waiting record's gas at the gas price limit + one more action's worst cost (all × 2 on an OP Stack chain), no code at
// the relayer's address; the ONE other configured endpoint of ANOTHER provider agrees (the same latest count, or one
// a block apart over our own slots only: `counts_moving`, wait a run; pending ≤ nextNonce, the balance, no code; none
// configured, unreadable or different: no restart). Recorded as a staff action (who `relayer (automatic)`, the evidence
// in its note) and raised by the cron (`evm_relay_auto_resumed`). Paused for money, and for 10 minutes after an
// automatic restart, the alarm runs every 15 s (paused: for its first 10 minutes) to 60 s.
// CODE AT THE RELAYER'S ADDRESS (D890 review) is a leak-type halt (`relayer_has_code`) wherever it is seen: each run
// reads it (one fetch), and so do the first send's nonce read and staffAdoptNonce (refused).
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
import { isLeakHalt } from '@hana-id/console-core';
import { log } from './log.ts';
import { type EvmBroadcast, type EvmReceipt, type EvmRejection, EvmRpcError, type Hex, SponsorChain, receiptCostWei, sponsorChainFor, sponsorSecondEndpoint } from './evm/sponsor-chain.ts';
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
/** D890: automatic restarts after a refill a UTC day, at most. */
export const EVM_RELAYER_AUTO_RESTARTS_PER_DAY = 3;
/** D890: a money pause restarts by itself only once it is this old (several runs looked at the chain during it). */
export const EVM_RELAYER_AUTO_MIN_PAUSE_MS = 60_000;
/** D890: a money pause that began within this of the last automatic restart waits for a person (it ran out again fast). */
export const EVM_RELAYER_AUTO_RAN_OUT_AGAIN_MS = 30 * 60_000;
/** D890 (D882's question): while paused for money, 15 s for this long, then every EVM_RELAYER_MONEY_CHECK_MS. */
export const EVM_RELAYER_MONEY_FAST_MS = 10 * 60_000;
export const EVM_RELAYER_MONEY_CHECK_MS = 60_000;
/** Who an automatic restart is recorded as, in the staff log. */
export const EVM_RELAYER_AUTO_WHO = 'relayer (automatic)';
/** The fetches an automatic restart's own reads may need: 4 on the trusted endpoint, 5 on the other (its chain check included). */
const AUTO_FETCHES = 9;
/** Subrequests an invocation may make on the free plan: the run's and the restart's reads together stay under it. */
const PLATFORM_FETCHES = 50;
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

export type EvmRelayerHaltReason = 'nonce_consumed_elsewhere' | 'nonce_gap' | 'foreign_transactions' | 'relayer_cannot_send' | 'stuck_past_deadline' | 'key_mismatch' | 'storage_inconsistent' | 'relayer_has_code';
/**
 * `code`: for `relayer_cannot_send`, the pool's refusal (an EvmRejection, e.g. `insufficient_funds`). `leakSeen` (D843):
 * during this pause something was seen that means the key may be used by someone else (the pause's own reason, or a
 * later condition: console-core `isLeakHalt`), or staff closed, filled or set a slot; Resume then needs `keyConfirmed`.
 * `otherSeen` (D890 review): on a pause for money, the first condition other than money (and a gap seen once) seen during
 * it (`key_mismatch`, `stuck_past_deadline`, another refusal code, …): the automatic restart then waits for a person.
 */
export type EvmRelayerHalt = { reason: EvmRelayerHaltReason; since: number; nonce?: number; code?: string; leakSeen?: true; otherSeen?: string };
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
  /** Every version's own max fee per gas, as signed (what a receipt's gas price can't exceed); empty for a batch resolved before it was kept. */
  versionFees?: { hash: Hex; maxFeePerGas: bigint }[];
}
/** `oldestUnacceptedMs`: the age of the oldest record no endpoint has taken any version of (for an alert), or null. */
export interface EvmRelayerStatus {
  address: Hex;
  unmined: number;
  awaitingConfirmation: number;
  oldestUnminedMs: number | null;
  oldestUnacceptedMs: number | null;
  nextNonce: number | null;
  halted: null | EvmRelayerHalt;
  /** D890: when it restarted by itself after a refill, newest first (the last few): the cron raises each as an event. */
  autoRestartedAt?: number[];
}
/** A money pause is a pause whose reason is `relayer_cannot_send` with `insufficient_funds` (D890). */
export const isMoneyHalt = (h: { reason: string; code?: string | null } | null | undefined): boolean => h?.reason === 'relayer_cannot_send' && h.code === 'insufficient_funds';
/**
 * What staff are shown about the automatic restart (D890): today's count and the limit, the recent times, and while
 * paused, `blocked` (what in storage rules a restart by itself out, or null), the amounts (wei, decimal) a restart by
 * itself and a Resume need with what is waiting now, and this pause's latest check (what held it back, the balance seen).
 */
export interface EvmRelayerAutoRestart {
  limit: number;
  today: number;
  recent: number[];
  pause: null | {
    blocked: EvmRelayerAutoBlock | null;
    restartWei: string;
    resumeWei: string;
    /** The first other condition seen during this pause (`otherSeen`), or null. */
    otherSeen: string | null;
    /** `streak`: how many runs in a row found the same thing holding it back (2 or more: it persists). */
    check: null | { at: number; blocked: EvmRelayerAutoBlock | EvmRelayerHaltReason | 'incomplete_check' | null; balanceWei: string | null; streak: number };
  };
}
/**
 * Why a money pause doesn't restart by itself. In storage (a person is needed): `not_money` (another reason), `leak_seen`,
 * `other_seen` (another condition seen during the pause), `daily_limit`, `ran_out_again` (it began within 30 minutes of
 * the last automatic restart), `unconfigured`, `switched_off` (the chain's `autoRestart` is not on),
 * `no_second_endpoint` (none of another provider), `no_key`. On a check (it may restart on a later run; `streak` says
 * whether it persists): `pause_too_new`, a verdict reason (staffResume's), `unexplained_slot` (a slot counted as used
 * without its own receipt seen), `waiting_not_taken` (the trusted endpoint didn't take a waiting one on this run),
 * `busy` (the run used its fetches), `balance_unreadable` (a fresh read failed), `code_at_relayer` (marks the pause
 * `leakSeen`), `balance_short`, `counts_moving` (the two endpoints a block apart over our own slots),
 * `second_endpoint_unavailable`, `second_endpoint_disagrees`.
 */
export type EvmRelayerAutoBlock = 'not_money' | 'leak_seen' | 'other_seen' | 'daily_limit' | 'ran_out_again' | 'switched_off' | 'no_second_endpoint' | 'no_key' | 'unconfigured' | 'pause_too_new' | 'unexplained_slot' | 'waiting_not_taken' | 'busy' | 'balance_short' | 'balance_unreadable' | 'code_at_relayer' | 'counts_moving' | 'second_endpoint_unavailable' | 'second_endpoint_disagrees';
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
  /** D890: the relayer restarted itself after a refill (who is EVM_RELAYER_AUTO_WHO; the note holds what it saw). */
  auto?: true;
}
/** Every record as stored (no raw transactions), the day's backstop and the last 50 staff actions. */
export interface EvmRelayerStaffStatus extends EvmRelayerStatus {
  /** D890: the automatic restart after a refill. */
  autoRestart: EvmRelayerAutoRestart;
  chainId: number | null;
  /** The UTC day (ms ÷ 1 day) `dayWei` counts; null before the first send. An earlier day's `dayWei` isn't today's spend. */
  day: number | null;
  dayWei: bigint;
  gapSeen: number | null;
  unconfirmedRefusal: null | { count: number; lastAt: number; nonce: number; code: string };
  records: (Omit<Rec, 'versions' | 'to' | 'data' | 'authorization'> & { versions: Omit<Version, 'raw'>[] })[];
  staffLog: EvmRelayerStaffEntry[];
}
export interface EvmRelayerStaffResult { done: boolean; refused: string | null; status: EvmRelayerStaffStatus }
/** What the staffer's page showed (D843): the halt's start (null: running) and the newest staff action's number (0: none). */
export interface EvmRelayerStaffExpect { haltSince: number | null; lastStaffSeq: number }

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
  /**
   * D890: the automatic restarts: the UTC day `count` counts, the recent times (newest first, at most 5), and the latest
   * check during a money pause (`since`: that pause's start, so an older pause's check is never shown as this one's).
   */
  auto?: { day: number; count: number; recent: number[]; check: null | { at: number; since: number; blocked: string | null; balanceWei: string | null; streak?: number } };
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
  /** Each version's max fee per gas (decimal), in `hashes`' order. */
  fees?: string[];
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
type RunResult = { conditions: Condition[]; changed: boolean; incomplete: boolean; gap: number | null; counts: Counts | null; trustedTook: Set<number> };
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
      autoRestartedAt: [...(meta?.auto?.recent ?? [])],
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
    if (r) return { ...base, transactionHash: r.seen?.hash ?? latestOf(r).hash, hashes: r.versions.map((v) => v.hash), state: latestOf(r).kind === 'cancel' ? 'cancelling' : 'pending', minedHash: null, outcome: null, costWei: null, versionFees: r.versions.map((v) => ({ hash: v.hash, maxFeePerGas: BigInt(v.maxFeePerGas) })) };
    const fees = Array.isArray(dig.fees) && dig.fees.length === dig.hashes!.length ? dig.fees : null;
    return { ...base, transactionHash: dig.hash!, hashes: [...dig.hashes!], state: dig.state as 'mined' | 'closed', minedHash: dig.minedHash ?? null, outcome: dig.outcome ?? null, costWei: dig.costWei ? BigInt(dig.costWei) : null, versionFees: fees ? dig.hashes!.map((hash, i) => ({ hash, maxFeePerGas: BigInt(fees[i]!) })) : [] };
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

  async staffResume(guard: string, who: string, note: string, expect?: EvmRelayerStaffExpect, keyConfirmed?: boolean): Promise<EvmRelayerStaffResult> {
    if (keyConfirmed !== undefined && typeof keyConfirmed !== 'boolean') refuse('invalid_request');
    return this.#staffAct(guard, who, note, expect, { action: 'resume', nonce: null, verdict: null }, async (meta, c) => {
      if (!meta.halted) return 'not_halted';
      if (meta.halted.leakSeen && keyConfirmed !== true) return 'key_confirmation_required';
      // A new key with nothing in flight starts a new nonce life (read at the next send).
      if (this.#records().length === 0 && c.keyAddress && c.keyAddress !== meta.address) this.#putMeta({ ...meta, address: c.keyAddress, nextNonce: null });
      const out = await this.#run(c, Date.now());
      this.#markLeak(out.conditions.filter((x) => x.reason !== 'nonce_gap' || meta.gapSeen === x.nonce));
      this.#markOther(out.conditions, meta.gapSeen === out.gap ? null : out.gap);
      const verdict = this.#resumeVerdict(out);
      if (verdict) return verdict;
      this.#endHalt();
      return null;
    });
  }

  /**
   * staffResume's verdict on a fresh run, also the automatic restart's (D890): the first condition found (any, a gap
   * seen once included), else `incomplete_check` when a record past the confirmed count couldn't be fully checked, else
   * null (nothing found: the halt may end).
   */
  #resumeVerdict(out: RunResult): EvmRelayerHaltReason | 'incomplete_check' | null {
    if (out.conditions.length > 0) return out.conditions[0]!.reason;
    if (out.incomplete) return 'incomplete_check';
    return null;
  }

  /** Ends the halt (staffResume, or the automatic restart once its verdict and its own checks pass). */
  #endHalt(): void {
    this.#putMeta({ ...this.#meta()!, halted: null, gapSeen: null });
  }

  async staffClose(guard: string, who: string, nonce: number, verdict: 'consumed_elsewhere', note: string, expect?: EvmRelayerStaffExpect): Promise<EvmRelayerStaffResult> {
    if (verdict !== 'consumed_elsewhere') refuse('invalid_request');
    return this.#staffAct(guard, who, note, expect, { action: 'close', nonce, verdict }, async (meta, c) => {
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

  async staffCancel(guard: string, who: string, nonce: number, note: string, expect?: EvmRelayerStaffExpect): Promise<EvmRelayerStaffResult> {
    return this.#staffAct(guard, who, note, expect, { action: 'cancel', nonce, verdict: null }, async (meta, c) => {
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

  async staffFill(guard: string, who: string, nonce: number, note: string, expect?: EvmRelayerStaffExpect): Promise<EvmRelayerStaffResult> {
    return this.#staffAct(guard, who, note, expect, { action: 'fill', nonce, verdict: null }, async (meta, c) => {
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

  async staffAdoptNonce(guard: string, who: string, nonce: number, note: string, expect?: EvmRelayerStaffExpect): Promise<EvmRelayerStaffResult> {
    return this.#staffAct(guard, who, note, expect, { action: 'adopt_nonce', nonce, verdict: null }, async (meta, c) => {
      const records = this.#records();
      if (meta.nextNonce !== null && nonce < meta.nextNonce) return 'below_next_nonce';
      // Every record is below nextNonce, so n ≥ nextNonce is above them all.
      if (records.some((r) => r.seen === null)) return 'unmined_records';
      const rpc = this.#client(c);
      const n = await this.#counts(rpc, meta.address);
      if (n.latest !== nonce || n.pending !== nonce) return 'chain_count_differs';
      // D890 review: never re-baseline over code at the relayer's address (it moves money with no slot used).
      if ((await rpc.code(meta.address)) !== '0x') {
        this.#halt({ reason: 'relayer_has_code' }, Date.now());
        return 'relayer_has_code';
      }
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
      // D890 review: code at the relayer's own address (an EIP-7702 delegation signed with its key, planted before this
      // count is read) would let anyone move its money with no slot used. Unreadable: nothing is stored or sent.
      const code = await rpc.code(c.keyAddress!).catch(() => refuse('rpc_unavailable'));
      const fresh: Meta = { v: SCHEMA, chainId: c.chain.chainId, address: c.keyAddress!, nextNonce: null, halted: null, gapSeen: null, day, dayWei: '0', alarmMs: EVM_RELAYER_ALARM_MS, remembered: 0, staffSeq: 0 };
      if (code !== '0x') {
        this.#putMeta({ ...(meta ?? fresh), address: c.keyAddress!, nextNonce: null });
        this.#halt({ reason: 'relayer_has_code' }, now);
        await this.#persisted(Date.now());
        refuse('relayer_halted');
      }
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
        // Sent at once whatever the batch's refusal was (D851 item 2); its own refusal counts only when the batch's didn't.
        const sentCancel = this.#afterBroadcast(next, await rpc.broadcast(latestOf(next).raw), true);
        code ??= sentCancel.cannotSend;
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
      const counted = out.conditions.filter((x) => x.reason !== 'nonce_gap' || m.gapSeen === x.nonce);
      if (counted[0]) this.#halt(counted[0], now);
      this.#markLeak(counted);
      // A gap seen once is no condition yet; one seen twice is counted (and a leak).
      this.#markOther(out.conditions, m.gapSeen === out.gap ? null : out.gap);
      for (const x of out.conditions) log({ event: 'evm_relayer_condition', chainId: meta.chainId, code: x.reason, ...(x.nonce !== undefined ? { nonce: String(x.nonce) } : {}) }, 'warn');
      if (this.#meta()!.gapSeen !== out.gap) this.#putMeta({ ...this.#meta()!, gapSeen: out.gap });
      // D890: a pause for money may end by itself, on this run's own result (the fresh run staffResume would make).
      const restarted = isMoneyHalt(this.#meta()!.halted) ? await this.#autoRestart(c, now, out) : false;
      log({ event: 'evm_relayer_run', chainId: meta.chainId, evmOps: this.#ops });
      await this.#schedule(now, out.changed || restarted);
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
    const out: RunResult = { conditions: [], changed: false, incomplete: false, gap: null, counts: null, trustedTook: new Set() };
    const records = this.#records();
    if (records.length > 0 && (c.keyWrong || (c.keyAddress !== null && c.keyAddress !== meta.address))) out.conditions.push({ reason: 'key_mismatch' });
    if (this.#inconsistency(meta, records)) out.conditions.push({ reason: 'storage_inconsistent' });
    const rpc = this.#client(c);
    const n = (out.counts = await this.#counts(rpc, meta.address));
    if (meta.nextNonce !== null && Math.max(n.latest, n.pending) > meta.nextNonce) out.conditions.push({ reason: 'foreign_transactions', nonce: meta.nextNonce });
    // D890 review: one read of the relayer's own code a run (a leaked key's one channel no count shows); unreadable:
    // the run is incomplete (staffResume and the automatic restart wait), nothing halts.
    const code = await rpc.code(meta.address).catch(() => null);
    if (code === null) out.incomplete = true;
    else if (code !== '0x') out.conditions.push({ reason: 'relayer_has_code' });

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
        // Never above what this version could have been charged: its own max fee per gas (a receipt can misreport).
        const cost = receiptCostWei({ ...receipt, effectiveGasPrice: receipt.effectiveGasPrice > BigInt(v.maxFeePerGas) ? BigInt(v.maxFeePerGas) : receipt.effectiveGasPrice });
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
      // The trusted endpoint itself took (or already had) its latest version on this run (D890 review: the automatic
      // restart needs this; `accepted` alone is sticky and any endpoint's).
      if (sent.kind === 'accepted' && sent.byRead === true) out.trustedTook.add(r.nonce);
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
        kv.put(digKey(r.digest), { nonce: r.nonce, reservedWei: r.reservedWei, ...d, hashes: r.versions.map((x) => x.hash), fees: r.versions.map((x) => x.maxFeePerGas), ...(r.batchRejected !== null ? { batchRejected: r.batchRejected, ...(r.batchCause ? { batchCause: r.batchCause } : {}) } : {}), resolvedAt: now } satisfies Dig);
        kv.put(forgetKey(now + EVM_RELAYER_REMEMBER_MS, r.digest), 1);
      }
      const m = this.#meta()!;
      if (giveBack > 0n && m.day === r.day) this.#putMeta({ ...m, dayWei: (BigInt(m.dayWei) > giveBack ? BigInt(m.dayWei) - giveBack : 0n).toString() });
    });
    if (d.state === 'closed') log({ event: 'evm_relay_closed', nonce: String(r.nonce), code: d.outcome }, 'warn');
  }

  // ---- the automatic restart after a refill (D890) ----

  /**
   * The one automatic end of a halt (see the header). Called only by an alarm run, while the pause is for money, with
   * that run's own result: the fresh run staffResume makes, judged by the same `#resumeVerdict`, then this restart's own
   * checks, cheapest first (a chain read only once everything in storage allows it). Each check is kept as this
   * pause's latest (for staff); a restart ends the halt as staffResume does and is recorded as a staff action with
   * what it saw. Returns whether it restarted. Never throws for a failed read (it waits for the next run).
   */
  async #autoRestart(c: Ctx, now: number, out: RunResult): Promise<boolean> {
    const meta = this.#meta()!;
    const h = meta.halted!;
    const records = this.#records();
    const need = this.#restartWei(c.chain, records);
    const seen = await this.#autoCheck(c, meta, records, need, now, out);
    this.#ops.fetches += seen.fetches;
    const { blocked } = seen;
    if (blocked === 'code_at_relayer') this.#markLeak([], 'code_at_relayer');
    const today = Math.floor(now / DAY_MS);
    const a = this.#meta()!.auto ?? { day: today, count: 0, recent: [], check: null };
    // How many runs in a row of this pause found the same thing holding it back (a persistent one is named to staff).
    const streak = a.check && a.check.since === h.since && a.check.blocked === blocked ? (a.check.streak ?? 1) + 1 : 1;
    const check = { at: now, since: h.since, blocked, balanceWei: seen.balanceWei === null ? null : seen.balanceWei.toString(), streak };
    if (blocked !== null || !seen.second || !seen.trusted || !out.counts) {
      this.#putMeta({ ...this.#meta()!, auto: { ...a, check } });
      // Logged when what holds it back changes, and once more (as an error where it matters) when it persists.
      const loud = blocked === 'code_at_relayer' || (streak >= 2 && (blocked === 'second_endpoint_disagrees' || blocked === 'second_endpoint_unavailable'));
      if (streak <= 2) log({ event: 'evm_relayer_auto_restart_waiting', chainId: c.chain.chainId, code: blocked ?? 'internal', ...(streak === 2 ? { count: 2 } : {}) }, loud ? 'error' : 'info');
      return false;
    }
    const n = out.counts;
    const s = seen.second;
    const t = seen.trusted;
    const note = `Restarted by itself after a refill (D890). Trusted endpoint: balance ${seen.balanceWei} wei (at least ${need} needed), count ${t.latest} (pending ${t.pending}, next slot ${meta.nextNonce ?? 'none'}) after block ${n.head}, no code at the wallet. Second endpoint: count ${s.latest} (pending ${s.pending}), balance ${s.balance} wei, no code.`;
    this.ctx.storage.transactionSync(() => {
      this.#endHalt();
      this.#putMeta({ ...this.#meta()!, auto: { day: today, count: (a.day === today ? a.count : 0) + 1, recent: [now, ...a.recent].slice(0, 5), check } });
      this.#putStaffEntry({ at: now, who: EVM_RELAYER_AUTO_WHO, action: 'resume', nonce: null, verdict: null, note, done: true, refused: null, auto: true });
    });
    log({ event: 'evm_relayer_auto_restarted', chainId: c.chain.chainId, code: 'insufficient_funds' }, 'warn');
    return true;
  }

  /** The automatic restart's checks in order (see #autoRestart): what holds it back (null: nothing), and what it read. */
  async #autoCheck(
    c: Ctx,
    meta: Meta,
    records: Rec[],
    need: bigint,
    now: number,
    out: RunResult,
  ): Promise<{ blocked: EvmRelayerAutoBlock | EvmRelayerHaltReason | 'incomplete_check' | null; balanceWei: bigint | null; second: { latest: number; pending: number; balance: bigint } | null; trusted?: { latest: number; pending: number }; fetches: number }> {
    const h = meta.halted!;
    const none = { balanceWei: null, second: null, fetches: 0 };
    const stored = this.#autoBlocked(meta, c.chain, this.#canSign(c, meta), now);
    if (stored) return { blocked: stored, ...none };
    if (now - h.since < EVM_RELAYER_AUTO_MIN_PAUSE_MS) return { blocked: 'pause_too_new', ...none };
    const verdict = this.#resumeVerdict(out);
    if (verdict) return { blocked: verdict, ...none };
    const n = out.counts;
    if (!n) return { blocked: 'incomplete_check', ...none };
    // The counts explained by our own records alone: every slot the network counts as used had its own receipt seen
    // (`seen`, from this run or an earlier one), and the TRUSTED endpoint itself took (or already had) each one still
    // waiting on this run (none refused, none held off by something else at its slot in that pool).
    if (records.some((r) => r.nonce < n.latest && r.seen === null)) return { blocked: 'unexplained_slot', ...none };
    if (records.some((r) => r.nonce >= n.latest && (!out.trustedTook.has(r.nonce) || r.cannotSend !== null || r.priceRefused === true))) return { blocked: 'waiting_not_taken', ...none };
    if (this.#ops.fetches > PLATFORM_FETCHES - AUTO_FETCHES) return { blocked: 'busy', ...none };
    // Fresh reads of the trusted endpoint now (the run's counts were read before its broadcasts): the counts still
    // explained by our own records, the balance, and no code at the relayer's own address (read on the run too).
    const trusted = sponsorChainFor(this.env, c.chain, { maxRequests: 4 });
    const used = (o?: SponsorChain): number => trusted.requestsUsed + (o?.requestsUsed ?? 0);
    let now2: { latest: number; pending: number; balance: bigint; code: Hex };
    try {
      now2 = { latest: await trusted.transactionCount(meta.address, 'latest'), pending: await trusted.transactionCount(meta.address, 'pending'), balance: await trusted.balance(meta.address), code: await trusted.code(meta.address) };
    } catch {
      return { blocked: 'balance_unreadable', ...none, fetches: used() };
    }
    const { balance: balanceWei } = now2;
    if (now2.code !== '0x') return { blocked: 'code_at_relayer', balanceWei, second: null, fetches: used() };
    // A slot used since the run's read without its own receipt seen yet, or counts past our next slot: the next run decides.
    const next = meta.nextNonce ?? 0;
    if (now2.latest < n.latest || now2.latest > next || now2.pending > next || now2.pending < now2.latest || records.some((r) => r.nonce < now2.latest && r.seen === null)) return { blocked: 'unexplained_slot', balanceWei, second: null, fetches: used() };
    if (balanceWei < need) return { blocked: 'balance_short', balanceWei, second: null, fetches: used() };
    // The one other endpoint (another provider): it can only hold this back (never evidence for a halt or a mark).
    const url = sponsorSecondEndpoint(this.env, c.chain)!;
    const other = new SponsorChain(c.chain.chainId, { read: url, broadcast: [url] }, { maxRequests: 5 });
    try {
      const latest = await other.transactionCount(meta.address, 'latest');
      const pending = await other.transactionCount(meta.address, 'pending');
      const balance = await other.balance(meta.address);
      const code2 = await other.code(meta.address);
      const second = { latest, pending, balance };
      const t = { latest: now2.latest, pending: now2.pending };
      if (code2 !== '0x' || balance < need || pending > next || pending < latest) return { blocked: 'second_endpoint_disagrees', balanceWei, second, trusted: t, fetches: used(other) };
      // One block apart (Base: 2 s) the two counts can differ by our own transactions landing between the reads: a
      // difference made only of slots our own records hold (each still waiting or with its own receipt) waits a run
      // (`counts_moving`, no restart); any other difference is a disagreement.
      if (latest !== now2.latest) {
        const lo = Math.min(latest, now2.latest);
        const hi = Math.max(latest, now2.latest);
        const ours = new Set(records.map((r) => r.nonce));
        let explained = hi <= next;
        for (let k = lo; explained && k < hi; k++) explained = ours.has(k);
        return { blocked: explained ? 'counts_moving' : 'second_endpoint_disagrees', balanceWei, second, trusted: t, fetches: used(other) };
      }
      return { blocked: null, balanceWei, second, trusted: t, fetches: used(other) };
    } catch {
      return { blocked: 'second_endpoint_unavailable', balanceWei, second: null, fetches: used(other) };
    }
  }

  /**
   * What in storage rules an automatic restart out (a person is needed), or null: another reason than money, a leak
   * sign or another condition seen during the pause, today's limit used, a pause that began within 30 minutes of the
   * last automatic restart, no settings, the restart switched off in the settings (`autoRestart`), no second endpoint of
   * another provider to check with, the key not loaded (or not the records' signer).
   */
  #autoBlocked(meta: Meta, chain: Readonly<EvmSponsorChainConfig> | null, keyOk: boolean, now: number): EvmRelayerAutoBlock | null {
    const h = meta.halted;
    if (!h || !isMoneyHalt(h)) return 'not_money';
    if (h.leakSeen) return 'leak_seen';
    if (h.otherSeen) return 'other_seen';
    const a = meta.auto;
    if (a && a.day === Math.floor(now / DAY_MS) && a.count >= EVM_RELAYER_AUTO_RESTARTS_PER_DAY) return 'daily_limit';
    const last = a?.recent[0];
    if (last !== undefined && h.since - last < EVM_RELAYER_AUTO_RAN_OUT_AGAIN_MS) return 'ran_out_again';
    if (!chain) return 'unconfigured';
    if (!chain.autoRestart) return 'switched_off';
    if (sponsorSecondEndpoint(this.env, chain) === null) return 'no_second_endpoint';
    if (!keyOk) return 'no_key';
    return null;
  }

  /**
   * What an automatic restart needs in the wallet: the low-balance mark, plus every waiting record's gas at the gas
   * price limit, plus one more action's worst cost (so it doesn't run out again at the next action), each × 2 on an OP
   * Stack chain (its L1 fee).
   */
  #restartWei(chain: Readonly<EvmSponsorChainConfig>, records: Rec[]): bigint {
    const f = chain.opStack ? 2n : 1n;
    return records.filter((r) => r.seen === null).reduce((sum, r) => sum + BigInt(r.gas) * chain.maxFeePerGasWei * f, chain.lowBalanceWei + chain.maxGasPerTx * chain.maxFeePerGasWei * f);
  }

  /** What Resume needs in the wallet: every waiting record's gas at its own latest max fee (what a node checks before taking it), × 2 on an OP Stack chain. */
  #resumeWei(chain: Readonly<EvmSponsorChainConfig>, records: Rec[]): bigint {
    const f = chain.opStack ? 2n : 1n;
    return records.filter((r) => r.seen === null).reduce((sum, r) => sum + BigInt(r.gas) * BigInt(latestOf(r).maxFeePerGas) * f, 0n);
  }

  /** The chain's settings, or null when the env's block is refused or lacks the chain (no throw, no log: for views). */
  #chainSettings(chainId: number | undefined): Readonly<EvmSponsorChainConfig> | null {
    if (chainId === undefined) return null;
    const setting = parseEvmSponsorConfig(this.env.EVM_SPONSOR, { network: this.env.NETWORK, envName: this.env.ENV_NAME, pinnedDelegates: SPONSOR_DELEGATES });
    return setting.status === 'configured' ? (sponsorChain((setting as { config: EvmSponsorConfig }).config, chainId) ?? null) : null;
  }

  /** The automatic restart as staff see it (storage and the settings only). */
  #autoView(meta: Meta | undefined, now: number): EvmRelayerAutoRestart {
    const a = meta?.auto;
    const today = Math.floor(now / DAY_MS);
    const base = { limit: EVM_RELAYER_AUTO_RESTARTS_PER_DAY, today: a && a.day === today ? a.count : 0, recent: [...(a?.recent ?? [])] };
    if (!meta?.halted) return { ...base, pause: null };
    const chain = this.#chainSettings(meta.chainId);
    const key = evmRelayKeyAddress(this.env.EVM_RELAY_KEYS);
    const records = this.#records();
    const check = a?.check && a.check.since === meta.halted.since ? { at: a.check.at, blocked: a.check.blocked as EvmRelayerAutoBlock | null, balanceWei: a.check.balanceWei, streak: a.check.streak ?? 1 } : null;
    return {
      ...base,
      pause: {
        blocked: this.#autoBlocked(meta, chain, key !== null && key === meta.address, now),
        restartWei: chain ? this.#restartWei(chain, records).toString() : '0',
        resumeWei: chain ? this.#resumeWei(chain, records).toString() : '0',
        otherSeen: meta.halted.otherSeen ?? null,
        check,
      },
    };
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
    if (!m) return;
    if (m.halted) {
      this.#markLeak([h]);
      return this.#markOther([h]);
    }
    this.#putMeta({ ...m, halted: { reason: h.reason, since: now, ...(h.nonce !== undefined ? { nonce: h.nonce } : {}), ...(h.code !== undefined ? { code: h.code } : {}), ...(isLeakHalt(h) ? { leakSeen: true as const } : {}) } });
    log({ event: 'evm_relayer_halted', chainId: m.chainId, code: h.code ? `${h.reason}:${h.code}` : h.reason, ...(h.nonce !== undefined ? { nonce: String(h.nonce) } : {}) }, 'error');
  }

  /**
   * Marks the current pause `leakSeen` (D843) when any of `conds` means the key may be someone else's (console-core
   * `isLeakHalt`), or `by` a staff Close, Fill or AdoptNonce done during it, or (D890) code found at the relayer's own
   * address by the automatic restart's check. Running, or already marked: nothing.
   */
  #markLeak(conds: readonly Condition[], by: 'staff_tool' | 'code_at_relayer' | null = null): void {
    const m = this.#meta();
    if (!m?.halted || m.halted.leakSeen || !(by || conds.some((x) => isLeakHalt(x)))) return;
    this.#putMeta({ ...m, halted: { ...m.halted, leakSeen: true } });
    log({ event: 'evm_relayer_leak_seen', chainId: m.chainId, code: by ?? conds.find((x) => isLeakHalt(x))!.reason }, 'error');
  }

  /**
   * D890 review: marks a pause for money `otherSeen` with the first condition seen during it that is neither money
   * (`relayer_cannot_send` · `insufficient_funds`) nor a gap seen once (`firstGap`): the automatic restart then waits
   * for a person, whatever clears later. Not a pause for money, or already marked: nothing.
   */
  #markOther(conds: readonly Condition[], firstGap: number | null = null): void {
    const m = this.#meta();
    if (!m?.halted || m.halted.otherSeen || !isMoneyHalt(m.halted)) return;
    const other = conds.find((x) => !isMoneyHalt(x) && !(x.reason === 'nonce_gap' && x.nonce === firstGap));
    if (!other) return;
    this.#putMeta({ ...m, halted: { ...m.halted, otherSeen: other.code ? `${other.reason}:${other.code}` : other.reason } });
    log({ event: 'evm_relayer_other_seen', chainId: m.chainId, code: other.reason }, 'warn');
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

  /** Paused for money: see below. While records exist: 15 s after a change, else double up to 5 minutes. Else hourly (or the next forget time if sooner). */
  async #schedule(now: number, changed: boolean): Promise<void> {
    const m = this.#meta()!;
    // Paused for money (D890, D882's question): every 15 s for the pause's first 10 minutes, then every 60 s, records or
    // not, so a refill is noticed within about a minute (the automatic restart) at a quarter of the calls.
    if (isMoneyHalt(m.halted)) {
      const every = changed || now - m.halted!.since < EVM_RELAYER_MONEY_FAST_MS ? EVM_RELAYER_ALARM_MS : EVM_RELAYER_MONEY_CHECK_MS;
      if (m.alarmMs !== every) this.#putMeta({ ...m, alarmMs: every });
      return this.ctx.storage.setAlarm(now + every);
    }
    const records = this.#records();
    // Watched closely for 10 minutes after an automatic restart (D890 review): a thief's transaction just after the
    // restart's reads is seen within a minute, records or not (never the hourly check).
    const lastAuto = m.auto?.recent[0];
    const watching = lastAuto !== undefined && now - lastAuto >= 0 && now - lastAuto < EVM_RELAYER_MONEY_FAST_MS;
    if (records.length > 0) {
      // Never backed off while a record is unmined and no endpoint has taken it (it may be holding every later one up).
      const urgent = records.some((r) => r.seen === null && !r.accepted);
      const every = changed || urgent ? EVM_RELAYER_ALARM_MS : Math.min(m.alarmMs * 2, watching ? EVM_RELAYER_MONEY_CHECK_MS : EVM_RELAYER_ALARM_MAX_MS);
      if (m.alarmMs !== every) this.#putMeta({ ...m, alarmMs: every });
      return this.ctx.storage.setAlarm(now + every);
    }
    if (watching) return this.ctx.storage.setAlarm(now + (changed ? EVM_RELAYER_ALARM_MS : EVM_RELAYER_MONEY_CHECK_MS));
    const next = Array.from(this.ctx.storage.kv.list<number>({ prefix: 'fgt:', limit: 1 }), ([k]) => Number(k.slice(4, 20)) + 1)[0];
    const at = Math.min(next ?? Number.POSITIVE_INFINITY, m.nextNonce !== null ? now + EVM_RELAYER_IDLE_CHECK_MS : Number.POSITIVE_INFINITY);
    return Number.isFinite(at) ? this.ctx.storage.setAlarm(Math.max(now + 1_000, at)) : this.ctx.storage.deleteAlarm();
  }

  // ---- staff plumbing ----

  /**
   * Checks the caller's input, runs `fn` in the queue (null: done, else why refused) and records the action. With
   * `expect` (D843: what the staffer's page showed), the halt's start and the newest staff action's number must still
   * be those inside the queue, else `version_conflict` and `fn` doesn't run: two staffers, or a double submit, never act
   * on a state one of them didn't see.
   */
  async #staffAct(guard: string, who: string, note: string, expect: EvmRelayerStaffExpect | undefined, what: Pick<EvmRelayerStaffEntry, 'action' | 'nonce' | 'verdict'>, fn: (meta: Meta, c: Ctx) => Promise<string | null>): Promise<EvmRelayerStaffResult> {
    const text = (s: unknown, max: number): boolean => typeof s === 'string' && s.trim().length > 0 && s.length <= max && !/[\u0000-\u001f\u007f]/u.test(s);
    const seq = (n: unknown): boolean => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
    const expectOk = expect === undefined || (typeof expect === 'object' && expect !== null && Object.keys(expect).length === 2 && (expect.haltSince === null || seq(expect.haltSince)) && seq(expect.lastStaffSeq));
    if (guard !== EVM_RELAYER_STAFF_GUARD || !text(who, 128) || !text(note, 500) || (what.nonce !== null && (!Number.isSafeInteger(what.nonce) || what.nonce < 0)) || !expectOk) refuse('invalid_request');
    return this.#exclusive(async () => {
      this.#ops = { signatures: 0, recoveries: 0, fetches: 0, keyDerivations: 0 };
      const meta = this.#meta();
      let refused: string | null = 'no_state';
      let c: Ctx | null = null;
      try {
        if (expect && ((meta?.halted?.since ?? null) !== expect.haltSince || (meta?.staffSeq ?? 0) !== expect.lastStaffSeq)) refused = 'version_conflict';
        else if (meta) refused = await fn(meta, (c = this.#context(meta.chainId)));
        // A slot closed, filled or set by hand during a pause: Resume then needs the key confirmed (D843).
        if (refused === null && meta?.halted && what.action !== 'resume' && what.action !== 'cancel') this.#markLeak([], 'staff_tool');
      } catch (e) {
        refused = evmRelayerError(e)?.code ?? (e instanceof EvmRpcError ? 'rpc_unavailable' : 'internal');
      } finally {
        c?.key?.fill(0);
      }
      if (this.#meta()) {
        this.ctx.storage.transactionSync(() => this.#putStaffEntry({ at: Date.now(), who, ...what, note, done: refused === null, refused }));
        await this.#schedule(Date.now(), true);
      }
      log({ event: 'evm_relayer_staff', code: `${what.action}_${refused === null ? 'done' : 'refused'}`, ...(what.nonce !== null ? { nonce: String(what.nonce) } : {}) }, 'warn');
      return { done: refused === null, refused, status: await this.#staffView() };
    });
  }

  /** Adds one staff log entry (the next number; the oldest past 200 dropped). Inside the caller's transaction. */
  #putStaffEntry(e: Omit<EvmRelayerStaffEntry, 'seq'>): void {
    const m = this.#meta()!;
    const seq = m.staffSeq + 1;
    this.ctx.storage.kv.put(staffKey(seq), { seq, ...e } satisfies EvmRelayerStaffEntry);
    if (seq > STAFF_LOG_KEEP) this.ctx.storage.kv.delete(staffKey(seq - STAFF_LOG_KEEP));
    this.#putMeta({ ...m, staffSeq: seq });
  }

  async #staffView(): Promise<EvmRelayerStaffStatus> {
    const meta = this.#meta();
    const s = await this.status().catch(() => ({ address: '0x' as Hex, unmined: 0, awaitingConfirmation: 0, oldestUnminedMs: null, oldestUnacceptedMs: null, nextNonce: null, halted: null }));
    const records = this.#records().map(({ versions, to: _t, data: _d, authorization: _a, ...r }) => ({ ...r, versions: versions.map(({ raw: _r, ...v }) => v) }));
    const staffLog = Array.from(this.ctx.storage.kv.list<EvmRelayerStaffEntry>({ prefix: 'staff:', reverse: true, limit: 50 }), ([, v]) => v);
    return { ...s, chainId: meta?.chainId ?? null, day: meta?.day ?? null, dayWei: BigInt(meta?.dayWei ?? '0'), gapSeen: meta?.gapSeen ?? null, unconfirmedRefusal: meta?.unconfirmedRefusal ?? null, records, staffLog, autoRestart: this.#autoView(meta, Date.now()) };
  }
}
