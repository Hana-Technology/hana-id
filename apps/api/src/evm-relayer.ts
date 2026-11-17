// The EVM relayer for gas sponsorship (D837): one SQLite-backed Durable Object per chain and relayer key, named
// `evm-relayer-<chainId>-<keyIndex>` (today one key, index 0). It holds the relayer EOA's funded key (the secret
// EVM_RELAY_KEYS) and owns that key's transaction nonce on its chain. The sponsorship handlers (evm/sponsor.ts) give
// it the user's signed Execute; it checks the signature and builds the call itself (`execute(...)` on the user's own
// account, type 2, or type 4 when the user's EIP-7702 authorization rides along), persists the transaction before it
// leaves, broadcasts it, and keeps it moving until a transaction with its nonce is CONFIRMED. It never waits for a
// receipt in a request: the handler polls the hash.
//
// What it guarantees, and how:
// - Never two transactions for one batch. The digest is computed here from the Execute (`executeDigest`), so it is
//   the batch that is sent: a digest already seen (pending, or mined and still remembered) returns that transaction
//   (`replay: true`), never a new one.
// - Never a nonce used twice. Nonces are handed out in order inside the critical section below; a record is written
//   (with `nextNonce`, in one transaction) and confirmed (`storage.sync()`) BEFORE its raw transaction is broadcast. A
//   crash at any point leaves either nothing (the nonce was never used) or a record the next run broadcasts again.
// - No record is dropped on one node's word. A record is done only when the CONFIRMED count (the `safe` block on an OP
//   Stack chain, else the latest block − 3) is past its nonce on every endpoint that answers (the lowest is taken; a
//   spread beyond 2 between endpoints counts as unknown: nothing is deleted or adopted), AND a receipt names one of its
//   hashes (the one that mined is recorded) or, with none of its hashes mined, the nonce has stayed confirmed for 2
//   minutes (another sender's: `taken`). Until then its raws are kept, so after a reorg (the latest count falls back
//   below it) it is broadcast again.
// - No permanent gap. A nonce goes back only when every endpoint reached refused it definitely and no endpoint's
//   pending count holds it. A nonce at or above the chain's pending count with no record (left by a lying node's count,
//   or another sender's pending transaction that was dropped) blocks every later one: after 5 minutes it is filled with
//   a 0-value self-transfer, so the object heals itself; `reconcile()` (staff only, below) does it at once.
// - Stuck transactions: the alarm (every 15 s while anything is pending, backing off to 5 minutes while nothing
//   changes) rebroadcasts what no node holds, replaces a transaction pending 60 s at the same nonce with both fees
//   × 1.125 (up to the chain's caps; nodes need +10% on both), and past the batch's deadline replaces it with a 0-value
//   self-transfer. A send must leave room for two such bumps under the caps (else `fees_too_high`).
// - A key whose address isn't the config's `relayerAddress`, a missing or malformed key, or one that changed while the
//   previous key's transactions are pending: every send and every signature is refused (`status().blockedReason` says
//   which). The key is parsed for each critical section, never stored, never logged, and zeroed after use.
// - Bounded work and storage: ≤ 45 fetches per invocation (the free plan allows 50 subrequests), ≤ 6 records advanced,
//   ≤ 4 rebroadcasts, ≤ 8 receipt reads and ≤ 2 gap fillers per run (the rest next run); ≤ 32 pending, ≤ 16 sends
//   waiting, ≤ 4096 remembered batches, ≤ 16 versions per nonce; a confirmed record is deleted at once, what is
//   remembered of it 10 minutes after its batch's deadline; reservations over 2 × the chain's `dailyBudgetEth` in a UTC
//   day are refused (`daily_cap`), a backstop under the handlers' budgets.
//
// Concurrency (why there is a queue and no blockConcurrencyWhile): a Durable Object runs one event at a time, and its
// input gate holds new events only while it awaits STORAGE; while it awaits a fetch (every RPC call) other requests
// and the alarm run. So every operation that reads or changes nonce state (send's section, the alarm's run,
// `reconcile`) goes through one FIFO promise queue (`exclusive`): one at a time, in arrival order, including across
// their RPC awaits. Storage is the synchronous SQLite-backed KV API (as RelayerKey, RateLimiter and LoginRelay use it):
// each state change is one `transactionSync` (all of it or none), and `storage.sync()` is awaited before any broadcast
// (the output gate would hold the fetch until the write is durable anyway; the explicit wait doesn't depend on it).
// `status` and `lookup` only read storage synchronously, so they see a consistent state without the queue.
// blockConcurrencyWhile would also serialize, but it would hold `status` for the length of RPC calls and resets the
// object after 30 s; the constructor does nothing asynchronous. The queue lives in memory: a reset object loses it,
// and storage (consistent at every await) is the only truth the next instance starts from; its first section
// reconciles with the chain before it assigns a nonce.
//
// Errors: every refusal is thrown as `Error('evm_relayer:<code>[:<reason>]')` (Workers RPC keeps the message), read
// back with `evmRelayerError`. A coded error means THIS call sent nothing; any other failure (the object reset, the
// stub unreachable) means unknown: the handler keeps the reservation and may resend the same Execute (idempotent).
//
// SECURITY: nothing here logs the key, a raw transaction, calldata, a signature, an authorization or an RPC URL.
import { DurableObject } from 'cloudflare:workers';
import {
  type ExecuteInput,
  type SignedAuthorization,
  SPONSOR_DELEGATES,
  type SponsorTx,
  encodeExecuteCalldata,
  executeDigest,
  recoverAuthorization,
  recoverExecuteSigner,
  signSponsorTx,
  sponsorTxHash,
} from '@hana-id/core/evm-sponsor';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import type { Env } from './env.ts';
import { log } from './log.ts';
import { type EndpointCounts, type EvmBroadcast, EvmRpcError, type Hex, type SponsorChain, sponsorChainFor } from './evm/sponsor-chain.ts';
import { type EvmSponsorChainConfig, type EvmSponsorConfig, checksumEvmAddress, parseEvmSponsorConfig, sponsorChain } from './evm/sponsor-config.ts';

export type { Hex };

/** The object's name for a chain and key index (EVM_RELAY_KEYS holds one key today: index 0). */
export const evmRelayerName = (chainId: number, keyIndex = 0): string => `evm-relayer-${chainId}-${keyIndex}`;

/** How often the alarm runs while a transaction is pending and something changed. */
export const EVM_RELAYER_ALARM_MS = 15_000;
/** The longest wait between alarm runs while something is pending and nothing changes (doubling from 15 s). */
export const EVM_RELAYER_ALARM_MAX_MS = 5 * 60_000;
/** A pending transaction signed this long ago is replaced with higher fees. */
export const EVM_RELAYER_REPLACE_AFTER_MS = 60_000;
/** Each replacement multiplies both fees by 9/8 (× 1.125), up to the chain's caps. */
export const EVM_RELAYER_FEE_BUMP = { num: 9n, den: 8n } as const;
/** What a node requires of a replacement: both fees at least 110% of the transaction it replaces (geth's default). */
const NODE_REPLACEMENT_BUMP = { num: 11n, den: 10n } as const;
/** Blocks below the latest at which a chain without a `safe` tag counts a nonce as confirmed. */
export const EVM_RELAYER_CONFIRMATIONS = 3;
/** The most two endpoints' mined (or confirmed) counts may differ before the counts count as unknown. */
export const EVM_RELAYER_COUNT_TOLERANCE = 2;
/** A confirmed nonce with none of our hashes mined is another sender's only after it stays so this long. */
export const EVM_RELAYER_TAKEN_AFTER_MS = 2 * 60_000;
/** A nonce gap (no record, at or above the chain's pending count) is filled after it has blocked this long. */
export const EVM_RELAYER_GAP_HEAL_MS = 5 * 60_000;
/** At most this many transactions pending at once; beyond it `relayer_busy`. */
export const EVM_RELAYER_MAX_PENDING = 32;
/** At most this many sends waiting for the critical section; beyond it `relayer_busy` at once. */
export const EVM_RELAYER_MAX_QUEUE = 16;
/** At most this many batches remembered (pending or mined, until forgotten); beyond it `relayer_busy`. */
export const EVM_RELAYER_MAX_REMEMBERED = 4096;
/** A mined batch is forgotten this long after its deadline (the handlers refuse a batch past its deadline). */
export const EVM_RELAYER_REMEMBER_AFTER_DEADLINE_MS = 10 * 60_000;
/** At most this many versions (hashes) per nonce: replacements stop there; the last one is still rebroadcast. */
export const EVM_RELAYER_MAX_HASHES = 16;
/** The longest calldata the object signs (the handlers' gas caps allow far less). */
export const EVM_RELAYER_MAX_DATA_BYTES = 32 * 1024;
/** A batch whose deadline is less than this far away is refused (`deadline_passed`): it could not land in time. */
export const EVM_RELAYER_MIN_DEADLINE_LEAD_S = 5;
/** The day's reservations may reach this many times the chain's `dailyBudgetEth` (a backstop under the handlers'). */
export const EVM_RELAYER_DAILY_CAP_FACTOR = 2n;
/** Fetches per invocation (the free plan allows 50 subrequests). */
export const EVM_RELAYER_MAX_REQUESTS = 45;
/** Per alarm run: records advanced, rebroadcasts, receipt reads and gap fillers. */
export const EVM_RELAYER_RUN_LIMITS = Object.freeze({ records: 6, rebroadcasts: 4, receipts: 8, gapFills: 2 });
/** Clock slack allowed above the chain's `deadlineMaxS`. */
const DEADLINE_SLACK_S = 60;
/** A 0-value self-transfer's gas. */
export const CANCEL_GAS = 21_000n;
const DAY_MS = 24 * 60 * 60_000;

/** What the handlers send (bigints as bigints: Workers RPC carries them). */
export interface EvmRelayerSendRequest {
  chainId: number;
  /** The user's Execute (core's ExecuteInput: chainId, account, implementation, calls, nonce, deadline, relayer, minGas). */
  execute: ExecuteInput;
  /** The user's 65-byte `r ‖ s ‖ v` signature over executeDigest(execute). */
  signature: Hex;
  /** The user's EIP-7702 authorization, when the account is not yet delegated (then the transaction is type 4). */
  authorization?: SignedAuthorization;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** The handler's budget reservation for this send (at least gas × maxFeePerGas). */
  reservedWei: bigint;
}

export interface EvmRelayerSent {
  /** executeDigest(execute), computed here. */
  digest: Hex;
  /** The mined version's hash once known, else the latest version's. */
  transactionHash: Hex;
  relayerNonce: number;
  /** That version's raw transaction. */
  raw: Hex;
  /** True when this Execute was already sent: this is that transaction, nothing new. */
  replay: boolean;
}

/** Why the object can't make progress right now (null: it can). */
export type EvmRelayerBlockedReason =
  /** EVM_RELAY_KEYS holds a new key while the previous key's transactions are pending: nothing is signed until they resolve. */
  | 'key_changed_with_pending'
  /** The endpoints' counts disagreed beyond the tolerance at the last read. */
  | 'counts_disagree'
  /** The chain could not be read at the last run. */
  | 'rpc_unavailable'
  /** A nonce gap is blocking later transactions (filled after 5 minutes, or by `reconcile`). */
  | 'nonce_gap';

export interface EvmRelayerStatus {
  /** The relayer EOA (EIP-55) of the configured key. */
  address: Hex;
  /** Transactions not yet confirmed. */
  pending: number;
  /** Age of the oldest pending transaction (since its nonce was first used), or null. */
  oldestPendingMs: number | null;
  /** The next nonce this object will use, or null before its first send. */
  nextNonce: number | null;
  blockedReason: EvmRelayerBlockedReason | null;
}

/** Every hash signed for a batch's nonce (oldest first) and where it stands. */
export interface EvmRelayerLookup {
  digest: Hex;
  relayerNonce: number;
  /** The mined version's hash once known, else the latest version's. */
  transactionHash: Hex;
  hashes: Hex[];
  /**
   * `pending`; `cancelling` (past its deadline, its latest version a self-transfer); `mined` (confirmed, one of its
   * hashes mined: `minedHash`); `taken` (confirmed, none of its hashes mined: the batch did not run).
   */
  state: 'pending' | 'cancelling' | 'mined' | 'taken';
  /** The hash with a receipt (tentative while pending: a reorg can clear it), or null. */
  minedHash: Hex | null;
  /** Which version mined: the batch (`execute`) or the self-transfer (`cancel`); null when none known. */
  outcome: 'execute' | 'cancel' | null;
  /** The handler's reservation for it. */
  reservedWei: bigint;
}

/** What `reconcile` found and did. */
export interface EvmRelayerReconcileReport {
  chainId: number;
  address: Hex;
  /** Each endpoint's counts (indexes, never URLs). */
  counts: EndpointCounts[];
  /** Whether they agreed within the tolerance (otherwise nothing was deleted, adopted or filled). */
  agreed: boolean;
  nextNonce: number | null;
  /** Records confirmed and deleted by this run. */
  finalized: number;
  /** Nonces filled with a self-transfer by this run. */
  gapsFilled: number[];
  /** Gaps still open (no record, at or above the pending count). */
  gaps: number[];
  pending: { nonce: number; kind: 'execute' | 'cancel'; included: boolean; minedHash: Hex | null }[];
  blockedReason: EvmRelayerBlockedReason | null;
}

export type EvmRelayerErrorCode =
  /** EVM_SPONSOR absent or refused, off testnet, or the chain not configured. */
  | 'relayer_unconfigured'
  /** EVM_RELAY_KEYS missing or malformed, its address not `relayerAddress`, or a key change with transactions pending. */
  | 'relayer_misconfigured'
  /** The request failed a check (shape, signature, relayer, implementation, calls, caps, authorization). */
  | 'invalid_request'
  /** The fees leave no room for two × 1.125 bumps under the chain's caps (start at or below `maxStartingFees`). */
  | 'fees_too_high'
  /** This object serves another chain. */
  | 'wrong_chain'
  /** The deadline is past, or too close to land. */
  | 'deadline_passed'
  /** Too many pending, waiting or remembered transactions. */
  | 'relayer_busy'
  /** The day's reservations would pass 2 × the chain's daily budget. */
  | 'daily_cap'
  /** The chain could not be read (or its endpoints disagreed) to assign a first nonce. */
  | 'rpc_unavailable'
  /** Every endpoint refused the transaction and no endpoint's pending count holds its nonce (freed). */
  | 'rejected'
  /** An unexpected failure before anything was persisted. */
  | 'internal';

const ERROR_PREFIX = 'evm_relayer:';
const CODES: ReadonlySet<string> = new Set(['relayer_unconfigured', 'relayer_misconfigured', 'invalid_request', 'fees_too_high', 'wrong_chain', 'deadline_passed', 'relayer_busy', 'daily_cap', 'rpc_unavailable', 'rejected', 'internal']);

class RelayerRefusal extends Error {
  constructor(code: EvmRelayerErrorCode, reason?: string) {
    super(`${ERROR_PREFIX}${code}${reason ? `:${reason}` : ''}`);
    this.name = 'Error';
  }
}
const refuse = (code: EvmRelayerErrorCode, reason?: string): never => {
  throw new RelayerRefusal(code, reason);
};

/**
 * The code (and for `rejected` the pool's reason, e.g. `insufficient_funds`) of an error the object threw, or null
 * for any other failure (unknown whether anything was sent).
 */
export function evmRelayerError(err: unknown): { code: EvmRelayerErrorCode; reason: string | null } | null {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const m = /^evm_relayer:([a-z_]+)(?::([a-z_]+))?$/u.exec(message);
  if (!m || !CODES.has(m[1]!)) return null;
  return { code: m[1] as EvmRelayerErrorCode, reason: m[2] ?? null };
}

// ---- the key ----

const KEY_RE = /^0x[0-9a-f]{64}$/u;

/**
 * EVM_RELAY_KEYS (D834): a JSON array of exactly one `0x` + 64 lowercase hex secp256k1 private key. Returns the key's
 * bytes (the caller zeroes them after use) or null; never says why in a way that could quote the key.
 */
export function parseEvmRelayKey(raw: string | undefined): Uint8Array | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 200) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(v) || v.length !== 1 || typeof v[0] !== 'string' || !KEY_RE.test(v[0])) return null;
  const d = new Uint8Array(32);
  for (let i = 0; i < 32; i++) d[i] = Number.parseInt((v[0] as string).slice(2 + 2 * i, 4 + 2 * i), 16);
  try {
    if (secp256k1.utils.isValidPrivateKey(d)) return d;
  } catch {
    // falls through
  }
  d.fill(0);
  return null;
}

/** The EIP-55 address of a secp256k1 private key. */
function addressOfKey(d: Uint8Array): Hex {
  const pub = secp256k1.getPublicKey(d, false).subarray(1);
  const a = keccak_256(pub).subarray(-20);
  return checksumEvmAddress(`0x${Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('')}`) as Hex;
}

/** The address of EVM_RELAY_KEYS' key, or null when it is missing or malformed (for the handlers' readiness checks). */
export function evmRelayKeyAddress(raw: string | undefined): Hex | null {
  const d = parseEvmRelayKey(raw);
  if (!d) return null;
  try {
    return addressOfKey(d);
  } finally {
    d.fill(0);
  }
}

// ---- fees ----

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
const minBig = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const maxBig = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const bump = (x: bigint): bigint => ceilDiv(x * EVM_RELAYER_FEE_BUMP.num, EVM_RELAYER_FEE_BUMP.den);

export interface FeeCaps {
  maxFeePerGasWei: bigint;
  maxPriorityFeePerGasWei: bigint;
}

/** The bumped fees for a replacement, or null when the caps leave no valid replacement (+10% on both fields). */
export function bumpedFees(prev: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }, caps: FeeCaps): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | null {
  const tip = minBig(bump(prev.maxPriorityFeePerGas), caps.maxPriorityFeePerGasWei);
  const fee = maxBig(minBig(bump(prev.maxFeePerGas), caps.maxFeePerGasWei), tip);
  const needTip = ceilDiv(prev.maxPriorityFeePerGas * NODE_REPLACEMENT_BUMP.num, NODE_REPLACEMENT_BUMP.den);
  const needFee = ceilDiv(prev.maxFeePerGas * NODE_REPLACEMENT_BUMP.num, NODE_REPLACEMENT_BUMP.den);
  if (tip < needTip || fee < needFee || (tip === prev.maxPriorityFeePerGas && fee === prev.maxFeePerGas)) return null;
  return { maxFeePerGas: fee, maxPriorityFeePerGas: tip };
}

/** Whether two × 1.125 bumps of both fees stay within the caps (room for a replacement and the deadline's self-transfer). */
export function hasFeeHeadroom(fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }, caps: FeeCaps): boolean {
  return bump(bump(fees.maxFeePerGas)) <= caps.maxFeePerGasWei && bump(bump(fees.maxPriorityFeePerGas)) <= caps.maxPriorityFeePerGasWei;
}

/** The highest fees a send may start with (both at most cap ÷ 1.265625, rounding included): the handlers start at or below. */
export function maxStartingFees(caps: FeeCaps): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } {
  const highest = (cap: bigint): bigint => {
    let x = (cap * 64n) / 81n;
    while (x > 0n && bump(bump(x)) > cap) x--;
    return x;
  };
  return { maxFeePerGas: highest(caps.maxFeePerGasWei), maxPriorityFeePerGas: highest(caps.maxPriorityFeePerGasWei) };
}

// ---- storage ----

/** Storage schema version (`meta.v`). */
const SCHEMA = 1;

interface Meta {
  v: number;
  /** The chain this object serves, fixed by its first send. */
  chainId: number;
  /** The relayer address the records were signed by (EIP-55). */
  address: Hex;
  /** The next nonce to use; null until the first reconciliation with the chain. */
  nextNonce: number | null;
  /** How many `digest:` entries exist. */
  remembered: number;
  /** The UTC day (ms since epoch ÷ 1 day) and the wei reserved by sends that day (decimal). */
  day: number;
  dayReservedWei: string;
  /** Open nonce gaps: nonce → when first seen (ms). */
  gaps: Record<string, number>;
  /** The last run's reason it couldn't use the chain, or null. */
  blocked: 'counts_disagree' | 'rpc_unavailable' | null;
  /** The alarm's current interval (ms): 15 s after a change, doubling to 5 minutes while nothing changes. */
  alarmMs: number;
}

interface StoredAuthorization {
  chainId: number;
  address: Hex;
  nonce: string;
  yParity: 0 | 1;
  r: Hex;
  s: Hex;
}

interface Version {
  hash: Hex;
  kind: 'execute' | 'cancel';
  raw: Hex;
}

/** `tx:<nonce>`: a transaction not yet confirmed. */
interface PendingTx {
  nonce: number;
  /** The batch's digest; null for a gap filler. */
  digest: Hex | null;
  /** The latest version: `execute` (the batch, or a fee replacement of it) or `cancel` (a 0-value self-transfer). */
  kind: 'execute' | 'cancel';
  to: Hex;
  data: Hex;
  gas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  authorization: StoredAuthorization | null;
  /** The batch's deadline (unix s, decimal); "0" for a gap filler. */
  deadline: string;
  reservedWei: string;
  /** When this nonce was first used (ms). */
  sentAt: number;
  /** When the latest version was signed (ms). */
  signedAt: number;
  /** The latest version's raw and hash. */
  raw: Hex;
  hash: Hex;
  /** Every version signed for this nonce, oldest first (each kept until the nonce is confirmed, for reorgs). */
  versions: Version[];
  /** Whether an endpoint accepted the latest version. */
  accepted: boolean;
  /** The version with a receipt (tentative until confirmed; cleared by a reorg). */
  minedHash: Hex | null;
  /** When the nonce was first seen confirmed with none of our hashes mined (ms), or null. */
  takenSince: number | null;
}

/** `digest:<digest>`: a batch this object sent. */
interface Remembered {
  nonce: number;
  state: 'pending' | 'mined' | 'taken';
  /** When it may be forgotten (ms): 10 minutes after its deadline. */
  forgetAt: number;
  reservedWei: string;
  /** Once confirmed (a pending one reads them from its record). */
  hash?: Hex;
  raw?: Hex;
  hashes?: Hex[];
  minedHash?: Hex | null;
  outcome?: 'execute' | 'cancel' | null;
}

const txKey = (nonce: number): string => `tx:${String(nonce).padStart(16, '0')}`;
const digestKey = (digest: string): string => `digest:${digest.toLowerCase()}`;
const forgetKey = (at: number, digest: string): string => `forget:${String(at).padStart(16, '0')}:${digest.toLowerCase()}`;

// ---- checks ----

const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const DIGEST = /^0x[0-9a-fA-F]{64}$/u;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/u;
const U256_MAX = (1n << 256n) - 1n;
const ZERO = /^0x0{40}$/u;

function fromHex(h: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array((h.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(2 + 2 * i, 4 + 2 * i), 16);
  return out;
}
const toHex = (b: Uint8Array): Hex => `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;

const isBig = (v: unknown, min: bigint, max: bigint): v is bigint => typeof v === 'bigint' && v >= min && v <= max;
const sameAddress = (a: string, b: string): boolean => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/** The latest-first order in which a record's versions are looked up (the latest, then the original, then the rest). */
const lookupOrder = (p: PendingTx): Version[] => {
  const v = [...p.versions];
  if (v.length <= 1) return v;
  const last = v.pop()!;
  return [last, v[0]!, ...v.slice(1).reverse()];
};

/** Everything one critical section needs: the config, the chain's settings, the key (zeroed at the end) and its address. */
interface Ready {
  config: EvmSponsorConfig;
  chain: Readonly<EvmSponsorChainConfig>;
  key: Uint8Array;
  address: Hex;
}

interface Checked {
  digest: Hex;
  to: Hex;
  data: Hex;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  authorization: StoredAuthorization | null;
  deadline: bigint;
  reservedWei: bigint;
}

/** What a reconciliation saw (the lowest of the endpoints' counts, the highest pending) and did. */
interface Repaired {
  each: EndpointCounts[];
  agreed: boolean;
  latest: number;
  pending: number;
  pendingHigh: number;
  confirmed: number;
  changed: boolean;
  finalized: number;
  filled: number[];
}

export class EvmRelayer extends DurableObject<Env> {
  private queue: Promise<unknown> = Promise.resolve();
  /** Sends waiting for the critical section (EVM_RELAYER_MAX_QUEUE). */
  private waiting = 0;
  /** Whether this instance has reconciled with the chain (once per instance, before its first nonce). */
  private reconciled = false;

  // ---- the interface (Workers RPC) ----

  /** Checks the Execute, then signs, persists and broadcasts its transaction (or returns the one already sent for it). */
  async send(req: EvmRelayerSendRequest): Promise<EvmRelayerSent> {
    if (typeof req !== 'object' || req === null || !Number.isSafeInteger(req.chainId) || req.chainId <= 0 || typeof req.execute !== 'object' || req.execute === null) refuse('invalid_request');
    if (this.waiting >= EVM_RELAYER_MAX_QUEUE) {
      log({ event: 'evm_relay_busy', chainId: req.chainId, code: 'queue_full' }, 'warn');
      refuse('relayer_busy');
    }
    this.waiting++;
    let started = false;
    return this.exclusive(async () => {
      started = true;
      this.waiting--;
      const r = this.ready(req.chainId, true);
      try {
        return await this.sendLocked(req, r);
      } finally {
        r.key.fill(0);
      }
    }).finally(() => {
      if (!started) this.waiting--;
    });
  }

  /** The relayer's address, its pending transactions and why it is blocked, if it is (storage only, no RPC). */
  async status(): Promise<EvmRelayerStatus> {
    const meta = this.meta();
    const { address, keyChangedWithPending } = this.checkKey(meta);
    const records = this.pendingRecords();
    const now = Date.now();
    const oldest = records.length ? Math.min(...records.map((p) => p.sentAt)) : null;
    return { address, pending: records.length, oldestPendingMs: oldest === null ? null : Math.max(0, now - oldest), nextNonce: meta?.nextNonce ?? null, blockedReason: this.blockedReason(meta, keyChangedWithPending) };
  }

  /** Every hash signed for an Execute digest and its state, or null when it is not (or no longer) remembered. */
  async lookup(digest: Hex): Promise<EvmRelayerLookup | null> {
    if (typeof digest !== 'string' || !DIGEST.test(digest)) refuse('invalid_request');
    const d = digest.toLowerCase() as Hex;
    const rem = this.ctx.storage.kv.get<Remembered>(digestKey(d));
    if (!rem) return null;
    if (rem.state !== 'pending') {
      return { digest: d, relayerNonce: rem.nonce, transactionHash: rem.minedHash ?? rem.hash!, hashes: [...(rem.hashes ?? [])], state: rem.state, minedHash: rem.minedHash ?? null, outcome: rem.outcome ?? null, reservedWei: BigInt(rem.reservedWei) };
    }
    const p = this.ctx.storage.kv.get<PendingTx>(txKey(rem.nonce));
    if (!p) return null;
    const outcome = p.minedHash ? (p.versions.find((v) => v.hash === p.minedHash)?.kind ?? null) : null;
    return { digest: d, relayerNonce: p.nonce, transactionHash: p.minedHash ?? p.hash, hashes: p.versions.map((v) => v.hash), state: p.kind === 'cancel' ? 'cancelling' : 'pending', minedHash: p.minedHash, outcome, reservedWei: BigInt(rem.reservedWei) };
  }

  /**
   * STAFF ONLY (D837): re-reads the chain and repairs at once what the alarm would in time (confirmed records, a gap
   * filled now with `fillGapsNow`), and reports what it found. For the admin package to call through AdminRpc; the
   * sponsorship handlers never call it, and no route reaches it.
   */
  async reconcile(opts: { fillGapsNow?: boolean } = {}): Promise<EvmRelayerReconcileReport> {
    return this.exclusive(async () => {
      const meta = this.meta();
      if (!meta) refuse('relayer_unconfigured');
      const r = this.ready(meta!.chainId, false);
      try {
        const rpc = sponsorChainFor(this.env, r.chain, { maxRequests: EVM_RELAYER_MAX_REQUESTS });
        let rep: Repaired;
        try {
          rep = await this.repair(rpc, r, Date.now(), { fillGapsNow: opts.fillGapsNow === true });
        } catch {
          this.setBlocked('rpc_unavailable');
          return refuse('rpc_unavailable');
        }
        const m = this.meta()!;
        const counts = { latest: rep.latest };
        return {
          chainId: m.chainId,
          address: r.address,
          counts: rep.each,
          agreed: rep.agreed,
          nextNonce: m.nextNonce,
          finalized: rep.finalized,
          gapsFilled: rep.filled,
          gaps: Object.keys(m.gaps).map(Number).sort((a, b) => a - b),
          pending: this.pendingRecords().map((p) => ({ nonce: p.nonce, kind: p.kind, included: counts.latest > p.nonce, minedHash: p.minedHash })),
          blockedReason: this.blockedReason(m, false),
        };
      } finally {
        r.key.fill(0);
      }
    });
  }

  override async alarm(): Promise<void> {
    try {
      await this.exclusive(() => this.tick());
    } catch {
      // Never thrown to the runtime (its retries would run outside this schedule): try again later.
      log({ event: 'evm_relayer_alarm_failed', code: 'internal' }, 'error');
      await this.ctx.storage.setAlarm(Date.now() + EVM_RELAYER_ALARM_MS);
    }
  }

  // ---- the critical section ----

  /** Runs `fn` after every earlier one has finished; never two at once (see the header). */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private meta(): Meta | undefined {
    const m = this.ctx.storage.kv.get<Meta>('meta');
    return m && m.v === SCHEMA ? m : undefined;
  }

  private putMeta(m: Meta): void {
    this.ctx.storage.kv.put('meta', m);
  }

  private setBlocked(blocked: Meta['blocked']): void {
    const m = this.meta();
    if (m && m.blocked !== blocked) this.putMeta({ ...m, blocked });
  }

  private blockedReason(meta: Meta | undefined, keyChangedWithPending: boolean): EvmRelayerBlockedReason | null {
    if (keyChangedWithPending) return 'key_changed_with_pending';
    if (meta?.blocked) return meta.blocked;
    if (meta && Object.keys(meta.gaps).length > 0) return 'nonce_gap';
    return null;
  }

  /** The config and the key's address, checked against each other; whether a stored address with pending work differs. */
  private checkKey(meta: Meta | undefined): { config: EvmSponsorConfig; address: Hex; keyChangedWithPending: boolean } {
    const setting = parseEvmSponsorConfig(this.env.EVM_SPONSOR, { network: this.env.NETWORK, envName: this.env.ENV_NAME, pinnedDelegates: SPONSOR_DELEGATES });
    if (setting.status !== 'configured') refuse('relayer_unconfigured');
    const config = (setting as { config: EvmSponsorConfig }).config;
    const address = evmRelayKeyAddress(this.env.EVM_RELAY_KEYS);
    if (!address || address !== config.relayerAddress) {
      log({ event: 'evm_relayer_key_mismatch', code: address ? 'address_mismatch' : 'key_missing_or_malformed' }, 'error');
      refuse('relayer_misconfigured');
    }
    const keyChangedWithPending = meta !== undefined && meta.address !== address && this.pendingRecords().length > 0;
    return { config, address: address as Hex, keyChangedWithPending };
  }

  /**
   * The checks every section starts with. `bind`: a first send fixes the object's chain (stored); a new key with
   * nothing pending starts a new nonce life (stored address, nonce re-read from chain).
   */
  private ready(chainId: number, bind: boolean): Ready {
    let meta = this.meta();
    const { config, address, keyChangedWithPending } = this.checkKey(meta);
    if (keyChangedWithPending) {
      log({ event: 'evm_relayer_key_mismatch', code: 'key_changed_with_pending' }, 'error');
      refuse('relayer_misconfigured');
    }
    if (meta && meta.chainId !== chainId) refuse('wrong_chain');
    const chain = sponsorChain(config, chainId);
    if (!chain) refuse('relayer_unconfigured');
    if (bind && (!meta || meta.address !== address)) {
      meta = { v: SCHEMA, chainId, address, nextNonce: null, remembered: meta?.remembered ?? 0, day: 0, dayReservedWei: '0', gaps: {}, blocked: null, alarmMs: EVM_RELAYER_ALARM_MS };
      this.putMeta(meta);
      this.reconciled = false;
    }
    const key = parseEvmRelayKey(this.env.EVM_RELAY_KEYS);
    if (!key) return refuse('relayer_misconfigured');
    return { config, chain: chain!, key, address };
  }

  private async sendLocked(req: EvmRelayerSendRequest, r: Ready): Promise<EvmRelayerSent> {
    const kv = this.ctx.storage.kv;
    let digest: Hex;
    try {
      digest = toHex(executeDigest(req.execute));
    } catch {
      return refuse('invalid_request');
    }
    const known = kv.get<Remembered>(digestKey(digest));
    if (known) return this.replay(digest, known);
    const checked = this.check(req, r, digest);
    const rpc = sponsorChainFor(this.env, r.chain, { maxRequests: EVM_RELAYER_MAX_REQUESTS });
    // The cold repair first (it may confirm and delete records, which the busy check counts).
    if (!this.reconciled || this.meta()!.nextNonce === null) {
      let rep: Repaired;
      try {
        rep = await this.repair(rpc, r, Date.now(), {});
      } catch {
        this.setBlocked('rpc_unavailable');
        log({ event: 'evm_relay_rpc_unavailable', chainId: r.chain.chainId, code: 'rpc_unavailable' }, 'error');
        return refuse('rpc_unavailable');
      }
      // Endpoints that disagree can't give a first nonce; a stored one still stands.
      if (!rep.agreed && this.meta()!.nextNonce === null) refuse('rpc_unavailable');
      this.reconciled = true;
    }
    const meta = this.meta()!;
    if (this.pendingRecords().length >= EVM_RELAYER_MAX_PENDING || meta.remembered >= EVM_RELAYER_MAX_REMEMBERED) {
      log({ event: 'evm_relay_busy', chainId: r.chain.chainId, code: 'relayer_busy' }, 'warn');
      refuse('relayer_busy');
    }

    for (let attempt = 0; ; attempt++) {
      const nonce = this.meta()!.nextNonce!;
      const now = Date.now();
      const day = Math.floor(now / DAY_MS);
      const m0 = this.meta()!;
      const dayReserved = m0.day === day ? BigInt(m0.dayReservedWei) : 0n;
      if (dayReserved + checked.reservedWei > r.chain.dailyBudgetWei * EVM_RELAYER_DAILY_CAP_FACTOR) {
        log({ event: 'evm_relay_daily_cap', chainId: r.chain.chainId, code: 'daily_cap' }, 'error');
        refuse('daily_cap');
      }
      let raw: Hex;
      try {
        raw = signSponsorTx(r.key, this.buildTx(r.chain.chainId, nonce, checked));
      } catch {
        // Core refused a field (EvmSponsorError: fixed message, no values): nothing was signed or stored.
        return refuse('invalid_request');
      }
      const hash = sponsorTxHash(raw);
      const record: PendingTx = {
        nonce,
        digest,
        kind: 'execute',
        to: checked.to,
        data: checked.data,
        gas: checked.gas.toString(),
        maxFeePerGas: checked.maxFeePerGas.toString(),
        maxPriorityFeePerGas: checked.maxPriorityFeePerGas.toString(),
        authorization: checked.authorization,
        deadline: checked.deadline.toString(),
        reservedWei: checked.reservedWei.toString(),
        sentAt: now,
        signedAt: now,
        raw,
        hash,
        versions: [{ hash, kind: 'execute', raw }],
        accepted: false,
        minedHash: null,
        takenSince: null,
      };
      const forgetAt = Number(checked.deadline) * 1000 + EVM_RELAYER_REMEMBER_AFTER_DEADLINE_MS;
      // Persist BEFORE the broadcast: the record, the batch's memory, the next nonce and the day's reservation, in one
      // transaction.
      this.ctx.storage.transactionSync(() => {
        const m = this.meta()!;
        kv.put(txKey(nonce), record);
        kv.put(digestKey(digest), { nonce, state: 'pending', forgetAt, reservedWei: record.reservedWei } satisfies Remembered);
        kv.put(forgetKey(forgetAt, digest), 1);
        this.putMeta({ ...m, nextNonce: nonce + 1, remembered: m.remembered + 1, day, dayReservedWei: (dayReserved + checked.reservedWei).toString(), alarmMs: EVM_RELAYER_ALARM_MS });
      });
      await this.ensureAlarm(now + EVM_RELAYER_ALARM_MS);
      await this.ctx.storage.sync();

      const sent = await rpc.broadcast(raw);
      log({ event: 'evm_relay_sent', chainId: r.chain.chainId, nonce: String(nonce), evmTx: hash, attempt, code: sent.kind === 'rejected' ? sent.reason : sent.kind });
      const answer: EvmRelayerSent = { digest, transactionHash: hash, relayerNonce: nonce, raw, replay: false };
      if (sent.kind === 'accepted') {
        this.markAccepted(nonce, hash);
        return answer;
      }
      // No definite answer (or nothing reachable): the record stays and the alarm broadcasts it again.
      if (sent.kind !== 'rejected') return answer;

      const each = await rpc.countsEach(r.address, { confirmations: EVM_RELAYER_CONFIRMATIONS, safeTag: r.chain.opStack });
      if (each.length === 0) return answer;
      if (sent.reason === 'nonce_too_low') {
        // Another sender used this key's nonce (no record of ours was at it). Dropped only once every answering
        // endpoint's CONFIRMED count is past it; then once more with the chain's next nonce.
        if (Math.min(...each.map((c) => c.confirmed)) <= nonce) return answer;
        this.forgetUnsent(nonce, digest, forgetAt, { giveBackWei: checked.reservedWei, day });
        log({ event: 'evm_relay_nonce_taken', chainId: r.chain.chainId, nonce: String(nonce), code: 'nonce_too_low' }, 'warn');
        try {
          await this.repair(rpc, r, Date.now(), {});
        } catch {
          return refuse('rpc_unavailable');
        }
        if (attempt === 0 && this.meta()!.nextNonce! > nonce) continue;
        return refuse('rejected', 'nonce_too_low');
      }
      // A definite refusal by every endpoint reached: the nonce goes back only when no endpoint's pending count holds
      // it (and it is still the newest), else the record stays for the alarm.
      if (Math.max(...each.map((c) => c.pending)) > nonce || this.meta()!.nextNonce !== nonce + 1) return answer;
      // The record, the batch's memory, the reservation and the nonce go back in one transaction (never a gap after a crash).
      this.forgetUnsent(nonce, digest, forgetAt, { nextNonce: nonce, giveBackWei: checked.reservedWei, day });
      log({ event: 'evm_relay_rejected', chainId: r.chain.chainId, nonce: String(nonce), evmTx: hash, code: sent.reason }, 'warn');
      return refuse('rejected', sent.reason);
    }
  }

  /** The answer for an Execute already sent: the mined version once known, else the latest. */
  private replay(digest: Hex, rem: Remembered): EvmRelayerSent {
    if (rem.state === 'pending') {
      const p = this.ctx.storage.kv.get<PendingTx>(txKey(rem.nonce));
      if (p) {
        const mined = p.minedHash ? p.versions.find((v) => v.hash === p.minedHash) : undefined;
        return { digest, transactionHash: mined?.hash ?? p.hash, relayerNonce: p.nonce, raw: mined?.raw ?? p.raw, replay: true };
      }
    }
    if (rem.hash && rem.raw) return { digest, transactionHash: rem.minedHash ?? rem.hash, relayerNonce: rem.nonce, raw: rem.raw, replay: true };
    // A memory without its record (never left by the rules here): refuse rather than send the batch again.
    log({ event: 'evm_relay_replay_unreadable', code: 'internal' }, 'error');
    return refuse('internal');
  }

  /**
   * The request, checked against the chain's settings, and the transaction built from it (the handlers checked it
   * first; this object trusts no caller): the Execute names this chain, the pinned delegate and this relayer, is signed
   * by its account, has 1 to maxCallsPerBatch calls of value 0 to anything but the zero address, the account or the
   * delegate, a minGas between the chain's floor and the gas, and a deadline that can still land; the transaction goes
   * to the account with value 0 and the calldata built here, within the caps (with room for two bumps), reserved in full.
   */
  private check(req: EvmRelayerSendRequest, r: Ready, digest: Hex): Checked {
    const c = r.chain;
    const e = req.execute;
    const { gas, maxFeePerGas, maxPriorityFeePerGas, reservedWei, authorization, signature } = req;
    if (e.chainId !== c.chainId) refuse('invalid_request');
    if (!sameAddress(e.implementation, c.delegate) || !sameAddress(e.relayer, r.address)) refuse('invalid_request');
    const account = e.account;
    if (typeof account !== 'string' || !ADDRESS.test(account) || ZERO.test(account) || sameAddress(account, r.address) || sameAddress(account, c.delegate)) refuse('invalid_request');
    const calls = Array.isArray(e.calls) ? e.calls : [];
    if (calls.length < 1 || calls.length > c.maxCallsPerBatch) refuse('invalid_request');
    for (const call of calls) {
      if (typeof call !== 'object' || call === null || call.value !== 0n || typeof call.to !== 'string' || ZERO.test(call.to) || sameAddress(call.to, account) || sameAddress(call.to, c.delegate)) refuse('invalid_request');
    }
    if (!isBig(gas, CANCEL_GAS, c.maxGasPerTx)) refuse('invalid_request');
    if (!isBig(e.minGas, c.minGas, gas as bigint)) refuse('invalid_request');
    if (!isBig(maxFeePerGas, 1n, c.maxFeePerGasWei) || !isBig(maxPriorityFeePerGas, 0n, minBig(maxFeePerGas as bigint, c.maxPriorityFeePerGasWei))) refuse('invalid_request');
    if (!hasFeeHeadroom({ maxFeePerGas, maxPriorityFeePerGas }, c)) refuse('fees_too_high');
    if (!isBig(reservedWei, (gas as bigint) * (maxFeePerGas as bigint), U256_MAX)) refuse('invalid_request');
    const deadline = e.deadline;
    if (typeof deadline !== 'bigint') refuse('invalid_request');
    const nowS = BigInt(Math.floor(Date.now() / 1000));
    if (deadline <= nowS + BigInt(EVM_RELAYER_MIN_DEADLINE_LEAD_S)) refuse('deadline_passed');
    if (deadline > nowS + BigInt(c.deadlineMaxS + DEADLINE_SLACK_S)) refuse('invalid_request');
    if (typeof signature !== 'string' || !SIGNATURE.test(signature)) refuse('invalid_request');
    let signer: string;
    let data: Hex;
    try {
      signer = recoverExecuteSigner(e, signature);
      data = encodeExecuteCalldata(e, signature).toLowerCase() as Hex;
    } catch {
      return refuse('invalid_request');
    }
    if (!sameAddress(signer, account)) refuse('invalid_request');
    if (data.length > 2 + 2 * EVM_RELAYER_MAX_DATA_BYTES) refuse('invalid_request');
    let auth: StoredAuthorization | null = null;
    if (authorization !== undefined) {
      if (typeof authorization !== 'object' || authorization === null) refuse('invalid_request');
      const a = authorization as SignedAuthorization;
      // The pinned delegate on this chain, signed by the account the transaction goes to.
      if (a.chainId !== c.chainId || typeof a.address !== 'string' || !sameAddress(a.address, c.delegate) || typeof a.nonce !== 'bigint') refuse('invalid_request');
      let authSigner: string;
      try {
        authSigner = recoverAuthorization(a);
      } catch {
        return refuse('invalid_request');
      }
      if (!sameAddress(authSigner, account)) refuse('invalid_request');
      auth = { chainId: a.chainId, address: a.address, nonce: a.nonce.toString(), yParity: a.yParity, r: a.r, s: a.s };
    }
    return { digest, to: account.toLowerCase() as Hex, data, gas, maxFeePerGas, maxPriorityFeePerGas, authorization: auth, deadline, reservedWei };
  }

  private buildTx(chainId: number, nonce: number, t: { to: Hex; data: Hex; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; authorization: StoredAuthorization | null }): SponsorTx {
    const base = {
      chainId: BigInt(chainId),
      nonce: BigInt(nonce),
      maxPriorityFeePerGas: t.maxPriorityFeePerGas,
      maxFeePerGas: t.maxFeePerGas,
      gas: t.gas,
      to: fromHex(t.to),
      value: 0n,
      data: fromHex(t.data),
      accessList: [],
    };
    if (!t.authorization) return { type: 'eip1559', ...base };
    const a = t.authorization;
    return { type: 'eip7702', ...base, authorizationList: [{ chainId: a.chainId, address: a.address, nonce: BigInt(a.nonce), yParity: a.yParity, r: a.r, s: a.s }] };
  }

  private markAccepted(nonce: number, hash: Hex): void {
    const kv = this.ctx.storage.kv;
    const p = kv.get<PendingTx>(txKey(nonce));
    if (p && p.hash === hash && !p.accepted) kv.put(txKey(nonce), { ...p, accepted: true });
  }

  /**
   * Deletes a record no node holds, with its batch's memory (the Execute may be sent again) and its reservation for
   * the day, in one transaction; with `nextNonce`, the nonce goes back too.
   */
  private forgetUnsent(nonce: number, digest: Hex, forgetAt: number, o: { nextNonce?: number; giveBackWei: bigint; day: number }): void {
    const kv = this.ctx.storage.kv;
    this.ctx.storage.transactionSync(() => {
      kv.delete(txKey(nonce));
      const m = this.meta()!;
      const had = kv.get(digestKey(digest)) !== undefined;
      kv.delete(digestKey(digest));
      kv.delete(forgetKey(forgetAt, digest));
      const reserved = m.day === o.day ? BigInt(m.dayReservedWei) - o.giveBackWei : 0n;
      this.putMeta({
        ...m,
        remembered: had ? Math.max(0, m.remembered - 1) : m.remembered,
        dayReservedWei: (reserved > 0n ? reserved : 0n).toString(),
        ...(o.nextNonce !== undefined ? { nextNonce: o.nextNonce } : {}),
      });
    });
  }

  private pendingRecords(): PendingTx[] {
    return Array.from(this.ctx.storage.kv.list<PendingTx>({ prefix: 'tx:' }), ([, v]) => v);
  }

  private async ensureAlarm(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  // ---- the chain ----

  /**
   * Reconciles with the chain (every endpoint's counts, cross-checked: the lowest taken, a spread beyond the tolerance
   * changes nothing) and repairs what it finds: a record whose nonce is confirmed is done once a receipt names one of
   * its versions (or, none of them mined, once it has stayed confirmed for 2 minutes: taken); a record whose nonce is
   * mined but not yet confirmed keeps its raws, its mined hash noted (and cleared again by a reorg); `nextNonce`
   * becomes the largest of what is stored, the newest record + 1, the confirmed and the pending count (never lower); a
   * gap (no record, at or above the pending count, below `nextNonce`) is filled after it has blocked for 5 minutes
   * (`fillGapsNow`: at once); a record no node holds is broadcast again. Throws when no endpoint answered (nothing
   * changed then).
   */
  private async repair(rpc: SponsorChain, r: Ready, now: number, opts: { fillGapsNow?: boolean }): Promise<Repaired> {
    const each = await rpc.countsEach(r.address, { confirmations: EVM_RELAYER_CONFIRMATIONS, safeTag: r.chain.opStack });
    if (each.length === 0) throw new EvmRpcError('unavailable');
    const lo = (k: keyof Omit<EndpointCounts, 'endpoint'>) => Math.min(...each.map((c) => c[k]));
    const hi = (k: keyof Omit<EndpointCounts, 'endpoint'>) => Math.max(...each.map((c) => c[k]));
    const latest = lo('latest');
    const pending = lo('pending');
    const confirmed = lo('confirmed');
    const agreed = hi('latest') - latest <= EVM_RELAYER_COUNT_TOLERANCE && hi('confirmed') - confirmed <= EVM_RELAYER_COUNT_TOLERANCE;
    const out: Repaired = { each, agreed, latest, pending, pendingHigh: hi('pending'), confirmed, changed: false, finalized: 0, filled: [] };
    if (!agreed) {
      log({ event: 'evm_relayer_counts_disagree', chainId: r.chain.chainId, code: 'counts_disagree' }, 'error');
      this.setBlocked('counts_disagree');
      return out;
    }
    const kv = this.ctx.storage.kv;
    let receipts = 0;
    for (const p0 of this.pendingRecords()) {
      let p = p0;
      const included = latest > p.nonce;
      if (included && !p.minedHash) {
        for (const v of lookupOrder(p)) {
          if (receipts >= EVM_RELAYER_RUN_LIMITS.receipts || rpc.exhausted) break;
          receipts++;
          let got: Awaited<ReturnType<SponsorChain['receipt']>>;
          try {
            got = await rpc.receipt(v.hash);
          } catch {
            break;
          }
          if (got) {
            p = { ...p, minedHash: v.hash, takenSince: null };
            kv.put(txKey(p.nonce), p);
            out.changed = true;
            break;
          }
        }
      }
      if (!included && (p.minedHash || p.takenSince !== null)) {
        // Un-mined by a reorg: back to pending, its raws still here to broadcast again.
        log({ event: 'evm_relay_reorg', chainId: r.chain.chainId, nonce: String(p.nonce), code: 'unmined' }, 'warn');
        p = { ...p, minedHash: null, takenSince: null, accepted: false };
        kv.put(txKey(p.nonce), p);
        out.changed = true;
        continue;
      }
      if (confirmed > p.nonce) {
        if (p.minedHash) {
          this.finalize(p, 'mined');
          out.finalized++;
          out.changed = true;
        } else if (p.takenSince === null) {
          kv.put(txKey(p.nonce), { ...p, takenSince: now });
          out.changed = true;
        } else if (now - p.takenSince >= EVM_RELAYER_TAKEN_AFTER_MS) {
          log({ event: 'evm_relay_nonce_taken', chainId: r.chain.chainId, nonce: String(p.nonce), code: 'taken' }, 'warn');
          this.finalize(p, 'taken');
          out.finalized++;
          out.changed = true;
        }
      }
    }
    const records = this.pendingRecords();
    const m = this.meta()!;
    const stored = m.nextNonce;
    const newest = records.reduce((a, p) => Math.max(a, p.nonce + 1), 0);
    const next = Math.max(stored ?? 0, newest, confirmed, pending);
    if (stored !== null && pending > stored) log({ event: 'evm_relayer_foreign_pending', chainId: r.chain.chainId, nonce: String(pending), code: 'foreign_pending' }, 'warn');
    // Gaps: a nonce at or above the chain's (lowest) pending count and below next with no record. Only once a nonce
    // was ours to hand out (stored !== null): a first reconciliation adopts the chain's counts as they are.
    const gaps: Record<string, number> = {};
    if (stored !== null) {
      for (let g = Math.max(confirmed, pending); g < next && g < Math.max(confirmed, pending) + 64; g++) {
        if (kv.get(txKey(g)) === undefined) gaps[String(g)] = m.gaps[String(g)] ?? now;
      }
    }
    this.ctx.storage.transactionSync(() => this.putMeta({ ...this.meta()!, nextNonce: next, gaps, blocked: null }));
    const due = Object.entries(gaps)
      .filter(([, since]) => opts.fillGapsNow === true || now - since >= EVM_RELAYER_GAP_HEAL_MS)
      .map(([g]) => Number(g))
      .sort((a, b) => a - b)
      .slice(0, EVM_RELAYER_RUN_LIMITS.gapFills);
    const start = maxStartingFees(r.chain);
    for (const g of due) {
      log({ event: 'evm_relayer_gap', chainId: r.chain.chainId, nonce: String(g), code: 'gap_filled' }, 'error');
      await this.persistAndBroadcast(rpc, r, { nonce: g, digest: null, kind: 'cancel', sentAt: now, reservedWei: '0', deadline: '0', fees: start, versions: [] });
      out.filled.push(g);
      out.changed = true;
    }
    if (out.filled.length) {
      const left = { ...this.meta()!.gaps };
      for (const g of out.filled) delete left[String(g)];
      this.ctx.storage.transactionSync(() => this.putMeta({ ...this.meta()!, gaps: left }));
    }
    let rebroadcasts = 0;
    for (const p of this.pendingRecords()) {
      if (rebroadcasts >= EVM_RELAYER_RUN_LIMITS.rebroadcasts || rpc.exhausted) break;
      if (p.nonce < pending || latest > p.nonce || out.filled.includes(p.nonce)) continue;
      rebroadcasts++;
      if ((await this.rebroadcast(rpc, r, p)).kind === 'accepted' && !p.accepted) out.changed = true;
    }
    return out;
  }

  /** A record whose nonce is confirmed: its record goes, its batch is remembered as mined or taken (in a transaction). */
  private finalize(p: PendingTx, state: 'mined' | 'taken'): void {
    const kv = this.ctx.storage.kv;
    this.ctx.storage.transactionSync(() => {
      kv.delete(txKey(p.nonce));
      if (p.digest) {
        const rem = kv.get<Remembered>(digestKey(p.digest));
        const mined = p.minedHash ? p.versions.find((v) => v.hash === p.minedHash) : undefined;
        if (rem) {
          kv.put(digestKey(p.digest), {
            ...rem,
            state,
            hash: p.hash,
            raw: mined?.raw ?? p.raw,
            hashes: p.versions.map((v) => v.hash),
            minedHash: mined?.hash ?? null,
            outcome: mined?.kind ?? null,
          } satisfies Remembered);
        }
      }
      const gaps = { ...(this.meta()?.gaps ?? {}) };
      delete gaps[String(p.nonce)];
      const m = this.meta();
      if (m) this.putMeta({ ...m, gaps });
    });
    log({ event: 'evm_relay_mined', nonce: String(p.nonce), evmTx: p.minedHash ?? p.hash, code: state === 'mined' ? (p.versions.find((v) => v.hash === p.minedHash)?.kind ?? 'execute') : 'taken' });
  }

  private async rebroadcast(rpc: SponsorChain, r: Ready, p: PendingTx): Promise<EvmBroadcast> {
    const sent = await rpc.broadcast(p.raw);
    if (sent.kind === 'accepted') this.markAccepted(p.nonce, p.hash);
    else log({ event: 'evm_relay_rebroadcast', chainId: r.chain.chainId, nonce: String(p.nonce), evmTx: p.hash, code: sent.kind === 'rejected' ? sent.reason : sent.kind }, 'warn');
    return sent;
  }

  /**
   * Signs a version of nonce `nonce` (an `execute` replacement with the record's payload, or a self-transfer),
   * stores it as the record (its version appended) and only then broadcasts it.
   */
  private async persistAndBroadcast(
    rpc: SponsorChain,
    r: Ready,
    v: { nonce: number; digest: Hex | null; kind: 'execute' | 'cancel'; sentAt: number; reservedWei: string; deadline: string; fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }; versions: Version[]; payload?: PendingTx },
  ): Promise<void> {
    const now = Date.now();
    const t =
      v.kind === 'execute' && v.payload
        ? { to: v.payload.to, data: v.payload.data, gas: BigInt(v.payload.gas), authorization: v.payload.authorization }
        : { to: r.address.toLowerCase() as Hex, data: '0x' as Hex, gas: CANCEL_GAS, authorization: null };
    const raw = signSponsorTx(r.key, this.buildTx(r.chain.chainId, v.nonce, { ...t, ...v.fees }));
    const hash = sponsorTxHash(raw);
    const record: PendingTx = {
      nonce: v.nonce,
      digest: v.digest,
      kind: v.kind,
      to: t.to,
      data: t.data,
      gas: t.gas.toString(),
      maxFeePerGas: v.fees.maxFeePerGas.toString(),
      maxPriorityFeePerGas: v.fees.maxPriorityFeePerGas.toString(),
      authorization: t.authorization,
      deadline: v.deadline,
      reservedWei: v.reservedWei,
      sentAt: v.sentAt,
      signedAt: now,
      raw,
      hash,
      versions: [...v.versions, { hash, kind: v.kind, raw }],
      accepted: false,
      minedHash: null,
      takenSince: null,
    };
    this.ctx.storage.transactionSync(() => this.ctx.storage.kv.put(txKey(v.nonce), record));
    await this.ensureAlarm(now + EVM_RELAYER_ALARM_MS);
    await this.ctx.storage.sync();
    const sent = await rpc.broadcast(raw);
    if (sent.kind === 'accepted') this.markAccepted(v.nonce, hash);
    log({ event: v.kind === 'cancel' ? 'evm_relay_cancel_sent' : 'evm_relay_replaced', chainId: r.chain.chainId, nonce: String(v.nonce), evmTx: hash, code: sent.kind === 'rejected' ? sent.reason : sent.kind }, sent.kind === 'accepted' ? 'info' : 'warn');
  }

  // ---- the alarm ----

  private async tick(): Promise<void> {
    const now = Date.now();
    const meta = this.meta();
    if (!meta) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    let r: Ready | null = null;
    try {
      r = this.ready(meta.chainId, false);
    } catch {
      // Misconfigured or unconfigured: nothing is signed or sent; pending work waits (it is not dropped).
      log({ event: 'evm_relayer_alarm_refused', chainId: meta.chainId, code: 'relayer_misconfigured' }, 'error');
      this.prune(now);
      await this.schedule(now, false);
      return;
    }
    let changed = false;
    try {
      if (this.pendingRecords().length > 0 && meta.address === r.address) {
        const rpc = sponsorChainFor(this.env, r.chain, { maxRequests: EVM_RELAYER_MAX_REQUESTS });
        let rep: Repaired | null = null;
        try {
          rep = await this.repair(rpc, r, now, {});
          this.reconciled = true;
        } catch {
          this.setBlocked('rpc_unavailable');
          log({ event: 'evm_relay_rpc_unavailable', chainId: r.chain.chainId, code: 'rpc_unavailable' }, 'warn');
        }
        if (rep) {
          changed = rep.changed;
          if (rep.agreed) {
            let advanced = 0;
            for (const p of this.pendingRecords()) {
              if (advanced >= EVM_RELAYER_RUN_LIMITS.records || rpc.exhausted) break;
              if (rep.latest > p.nonce) continue; // mined, waiting to be confirmed
              // Only records that sent something count against the run's limit.
              if (await this.advance(rpc, r, p, now)) {
                changed = true;
                advanced++;
              }
            }
          }
        }
      }
      this.prune(now);
      const left = this.pendingRecords().length;
      if (left > 0) log({ event: 'evm_relayer_pending', chainId: r.chain.chainId, pending: left });
      await this.schedule(now, changed);
    } finally {
      r.key.fill(0);
    }
  }

  /** One pending record's next step (see the header): a self-transfer past the deadline, a fee replacement after 60 s. */
  private async advance(rpc: SponsorChain, r: Ready, p: PendingTx, now: number): Promise<boolean> {
    const prev = { maxFeePerGas: BigInt(p.maxFeePerGas), maxPriorityFeePerGas: BigInt(p.maxPriorityFeePerGas) };
    const canReplace = p.versions.length < EVM_RELAYER_MAX_HASHES;
    const expired = p.kind === 'execute' && p.digest !== null && BigInt(Math.floor(now / 1000)) > BigInt(p.deadline);
    if (!(expired || (canReplace && now - p.signedAt >= EVM_RELAYER_REPLACE_AFTER_MS))) return false;
    const fees = canReplace ? bumpedFees(prev, r.chain) : null;
    // At the caps (or the version cap): no valid replacement. The last version stays (repair broadcast it again if no
    // node held it); it lands once the base fee allows.
    if (!fees) return false;
    await this.persistAndBroadcast(rpc, r, { nonce: p.nonce, digest: p.digest, kind: expired ? 'cancel' : p.kind, sentAt: p.sentAt, reservedWei: p.reservedWei, deadline: p.deadline, fees, versions: p.versions, payload: p });
    return true;
  }

  /** Forgets mined batches past their memory, and stale index entries. */
  private prune(now: number): void {
    const kv = this.ctx.storage.kv;
    const due = Array.from(kv.list<number>({ prefix: 'forget:', end: `forget:${String(now).padStart(16, '0')};` }), ([k]) => k);
    if (due.length === 0) return;
    this.ctx.storage.transactionSync(() => {
      let forgotten = 0;
      for (const k of due) {
        const digest = k.slice(k.lastIndexOf(':') + 1);
        const rem = kv.get<Remembered>(digestKey(digest));
        kv.delete(k);
        if (!rem) continue;
        if (rem.state === 'pending') {
          // Still pending at its time (stuck): kept, looked at again later.
          const later = now + EVM_RELAYER_REMEMBER_AFTER_DEADLINE_MS;
          kv.put(digestKey(digest), { ...rem, forgetAt: later });
          kv.put(forgetKey(later, digest), 1);
          continue;
        }
        kv.delete(digestKey(digest));
        forgotten++;
      }
      const m = this.meta();
      if (m && forgotten > 0) this.putMeta({ ...m, remembered: Math.max(0, m.remembered - forgotten) });
    });
  }

  /**
   * The next alarm: while anything is pending, 15 s after a run that changed something, else double the last
   * interval up to 5 minutes; with nothing pending, the next forget time; else none.
   */
  private async schedule(now: number, changed: boolean): Promise<void> {
    if (this.pendingRecords().length > 0) {
      const m = this.meta();
      const every = changed || !m ? EVM_RELAYER_ALARM_MS : Math.min(Math.max(m.alarmMs, EVM_RELAYER_ALARM_MS) * 2, EVM_RELAYER_ALARM_MAX_MS);
      if (m && m.alarmMs !== every) this.putMeta({ ...m, alarmMs: every });
      await this.ctx.storage.setAlarm(now + every);
      return;
    }
    const next = Array.from(this.ctx.storage.kv.list<number>({ prefix: 'forget:', limit: 1 }), ([k]) => k)[0];
    if (next) await this.ctx.storage.setAlarm(Math.max(now + 1_000, Number(next.slice('forget:'.length, 'forget:'.length + 16)) + 1));
    else await this.ctx.storage.deleteAlarm();
  }
}
