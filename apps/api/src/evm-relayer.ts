// The EVM relayer for gas sponsorship (D837): one SQLite-backed Durable Object per chain and relayer key, named
// `evm-relayer-<chainId>-<keyIndex>` (today one key, index 0). It holds the relayer EOA's funded key (the secret
// EVM_RELAY_KEYS) and owns that key's transaction nonce on its chain: it signs the sponsorship handlers' transactions
// (evm/sponsor.ts: a call to the user's own account, type 2, or type 4 when the user's EIP-7702 authorization rides
// along), persists each before it leaves, broadcasts it, and keeps it moving until a transaction with its nonce is
// mined. It never waits for a receipt in a request: the handler polls the hash.
//
// What it guarantees, and how:
// - Never two transactions for one batch. `send` is idempotent by the batch's EIP-712 digest: a digest it has seen
//   (pending, or mined and still remembered) returns that transaction's hash with `replay: true`, never a new one.
// - Never a nonce gap, never a nonce used twice. Nonces are handed out in order inside the critical section below;
//   every nonce below the stored `nextNonce` is mined or has a stored record, and a record is written (with
//   `nextNonce`, in one transaction) and confirmed (`storage.sync()`) BEFORE its raw transaction is broadcast. A crash
//   at any point leaves either nothing (the nonce was never used) or a record the next run broadcasts again (same raw,
//   same nonce). A nonce goes back (`nextNonce` lowered) only when every endpoint the broadcast reached refused it
//   definitely AND the chain's pending count confirms that nothing holds it; a nonce another sender took is dropped
//   only once the chain's mined count is past it. A nonce below `nextNonce` with no record (which the rules above
//   never leave) is filled with a 0-value self-transfer.
// - Every persisted transaction is kept until a transaction with its nonce is mined (the mined count passes it):
//   while pending, the alarm (every 15 s) rebroadcasts it when no node holds it, replaces it after 60 s at the same
//   nonce with both fees × 1.125 (up to the chain's caps; replacement needs +10% on both, so no bump past a cap), and
//   once the batch's deadline has passed (it can no longer execute) replaces it with a 0-value self-transfer that
//   frees the nonce. Every hash signed for a nonce is remembered, for the handler's lookup.
// - A key whose address isn't the config's `relayerAddress`, a missing or malformed key, or one that changed while
//   the previous key's transactions are pending: everything is refused (send, status, the alarm's sends). The key is
//   parsed for each critical section, never stored, never logged, and its bytes are zeroed after use.
// - Bounded storage: a mined transaction's record is deleted at once; what is remembered of it (its hashes and last
//   raw, for replays) is deleted 10 minutes after its batch's deadline; at most EVM_RELAYER_MAX_PENDING pending and
//   EVM_RELAYER_MAX_REMEMBERED remembered batches (beyond either, `relayer_busy`); at most 64 hashes per nonce.
//
// Concurrency (why there is a queue and no blockConcurrencyWhile): a Durable Object runs one event at a time, and its
// input gate holds new events only while it awaits STORAGE; while it awaits a fetch (every RPC call) other requests
// and the alarm run. So every operation that reads or changes nonce state (send's section and the alarm's run) goes
// through one FIFO promise queue (`exclusive`): one at a time, in arrival order, including across their RPC awaits.
// Storage is the synchronous SQLite-backed KV API (as RelayerKey, RateLimiter and LoginRelay use it): each state
// change is one `transactionSync` (all of it or none), and `storage.sync()` is awaited before any broadcast (the output
// gate would hold the fetch until the write is durable anyway; the explicit wait doesn't depend on it). `status` and
// `lookup` only read storage synchronously, so they see a consistent state without the queue. blockConcurrencyWhile
// would also serialize, but it would hold `status` for the length of RPC calls and resets the object after 30 s; the
// constructor does nothing asynchronous. The queue lives in memory: a reset object loses it, and storage (which the
// rules above keep consistent at every await) is the only truth the next instance starts from; its first section
// reconciles with the chain before it assigns a nonce.
//
// Errors: every refusal is thrown as `Error('evm_relayer:<code>')` (Workers RPC keeps the message), read back with
// `evmRelayerError`. A coded error means THIS call sent nothing; any other failure (the object reset, the stub
// unreachable) means unknown: the handler keeps the reservation and may resend the same digest (it is idempotent).
//
// SECURITY: nothing here logs the key, a raw transaction, calldata, a signature, an authorization or an RPC URL.
import { DurableObject } from 'cloudflare:workers';
import { EXECUTE_SELECTOR, type SignedAuthorization, SPONSOR_DELEGATES, type SponsorTx, recoverAuthorization, signSponsorTx, sponsorTxHash } from '@hana-id/core/evm-sponsor';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import type { Env } from './env.ts';
import { log } from './log.ts';
import { type EvmBroadcast, type Hex, type SponsorChain, sponsorChainFor } from './evm/sponsor-chain.ts';
import { type EvmSponsorChainConfig, type EvmSponsorConfig, checksumEvmAddress, parseEvmSponsorConfig, sponsorChain } from './evm/sponsor-config.ts';

export type { Hex };

/** The object's name for a chain and key index (EVM_RELAY_KEYS holds one key today: index 0). */
export const evmRelayerName = (chainId: number, keyIndex = 0): string => `evm-relayer-${chainId}-${keyIndex}`;

/** How often the alarm runs while a transaction is pending. */
export const EVM_RELAYER_ALARM_MS = 15_000;
/** A pending transaction signed this long ago is replaced with higher fees. */
export const EVM_RELAYER_REPLACE_AFTER_MS = 60_000;
/** Each replacement multiplies both fees by 9/8 (× 1.125), up to the chain's caps. */
export const EVM_RELAYER_FEE_BUMP = { num: 9n, den: 8n } as const;
/** What a node requires of a replacement: both fees at least 110% of the transaction it replaces (geth's default). */
const NODE_REPLACEMENT_BUMP = { num: 11n, den: 10n } as const;
/** At most this many transactions pending at once; beyond it `relayer_busy`. */
export const EVM_RELAYER_MAX_PENDING = 32;
/** At most this many batches remembered (pending or mined, until forgotten); beyond it `relayer_busy`. */
export const EVM_RELAYER_MAX_REMEMBERED = 4096;
/** A mined batch is forgotten this long after its deadline (the handlers refuse a batch past its deadline). */
export const EVM_RELAYER_REMEMBER_AFTER_DEADLINE_MS = 10 * 60_000;
/** At most this many hashes per nonce (replacements stop there; the last one is still rebroadcast). */
export const EVM_RELAYER_MAX_HASHES = 64;
/** The longest calldata the object signs (the handlers' gas caps allow far less). */
export const EVM_RELAYER_MAX_DATA_BYTES = 32 * 1024;
/** A batch whose deadline is less than this far away is refused (`deadline_passed`): it could not land in time. */
export const EVM_RELAYER_MIN_DEADLINE_LEAD_S = 5;
/** Clock slack allowed above the chain's `deadlineMaxS`. */
const DEADLINE_SLACK_S = 60;
/** A 0-value self-transfer's gas. */
export const CANCEL_GAS = 21_000n;
/** A re-check of a key/config problem waits this long (nothing is sent meanwhile). */
const MISCONFIGURED_RETRY_MS = 60_000;

/** What the handlers send (bigints as bigints: Workers RPC carries them). */
export interface EvmRelayerSendRequest {
  /** The signed Execute's EIP-712 digest: the idempotency key. */
  digest: Hex;
  chainId: number;
  /** The user's account (the transaction's destination). */
  to: Hex;
  /** `execute(...)` calldata. */
  data: Hex;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** The user's EIP-7702 authorization, when the account is not yet delegated (then the transaction is type 4). */
  authorization?: SignedAuthorization;
  /** The Execute's deadline, unix seconds. */
  deadline: bigint;
  /** The handler's budget reservation for this send (at least gas × maxFeePerGas). */
  reservedWei: bigint;
}

export interface EvmRelayerSent {
  transactionHash: Hex;
  relayerNonce: number;
  raw: Hex;
  /** True when the digest was already sent: this is that transaction (its latest version), nothing new. */
  replay: boolean;
}

export interface EvmRelayerStatus {
  /** The relayer EOA (EIP-55). */
  address: Hex;
  /** Transactions not yet mined. */
  pending: number;
  /** Age of the oldest pending transaction (since its nonce was first used), or null. */
  oldestPendingMs: number | null;
  /** The next nonce this object will use, or null before its first send. */
  nextNonce: number | null;
}

/** Every hash signed for a batch's nonce (oldest first) and where it stands. */
export interface EvmRelayerLookup {
  relayerNonce: number;
  /** The latest version's hash. */
  transactionHash: Hex;
  hashes: Hex[];
  /** `pending`; `cancelling` (past its deadline, replaced by a self-transfer); `mined` (some transaction with its nonce). */
  state: 'pending' | 'cancelling' | 'mined';
  /** The handler's reservation for it. */
  reservedWei: bigint;
}

export type EvmRelayerErrorCode =
  /** EVM_SPONSOR absent or refused, off testnet, or the chain not configured. */
  | 'relayer_unconfigured'
  /** EVM_RELAY_KEYS missing or malformed, its address not `relayerAddress`, or a key change with transactions pending. */
  | 'relayer_misconfigured'
  /** The request failed a check (shape, caps, authorization, calldata). */
  | 'invalid_request'
  /** This object serves another chain. */
  | 'wrong_chain'
  /** The deadline is past, or too close to land. */
  | 'deadline_passed'
  /** Too many pending or remembered transactions. */
  | 'relayer_busy'
  /** The chain could not be read to assign a nonce. */
  | 'rpc_unavailable'
  /** Every endpoint refused the transaction and the chain confirmed nothing holds its nonce (freed). */
  | 'rejected'
  /** An unexpected failure before anything was persisted. */
  | 'internal';

const ERROR_PREFIX = 'evm_relayer:';
const CODES: ReadonlySet<string> = new Set(['relayer_unconfigured', 'relayer_misconfigured', 'invalid_request', 'wrong_chain', 'deadline_passed', 'relayer_busy', 'rpc_unavailable', 'rejected', 'internal']);

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
  /**
   * The highest mined count any endpoint has reported (only grows): every nonce below it is mined. A lagging node's
   * lower count never brings a mined nonce back (no record is resurrected, no gap filler signed for it).
   */
  minedFloor: number;
  /**
   * The highest count (mined or pending) any endpoint has reported (only grows). A nonce below it with no record is
   * mined or another sender's (the key used elsewhere), never one of ours to fill; every nonce from it up to
   * `nextNonce` was handed out here.
   */
  seenFloor: number;
  /** How many `digest:` entries exist. */
  remembered: number;
}

interface StoredAuthorization {
  chainId: number;
  address: Hex;
  nonce: string;
  yParity: 0 | 1;
  r: Hex;
  s: Hex;
}

/** `tx:<nonce>`: a transaction not yet mined. */
interface PendingTx {
  nonce: number;
  /** The batch's digest; null for a gap filler. */
  digest: Hex | null;
  /** `execute`: the handler's transaction (or a fee replacement of it); `cancel`: a 0-value self-transfer. */
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
  raw: Hex;
  hash: Hex;
  /** Every hash signed for this nonce, oldest first. */
  hashes: Hex[];
  /** Whether an endpoint accepted the latest version. */
  accepted: boolean;
}

/** `digest:<digest>`: a batch this object sent. */
interface Remembered {
  nonce: number;
  state: 'pending' | 'mined';
  /** When it may be forgotten (ms): 10 minutes after its deadline. */
  forgetAt: number;
  reservedWei: string;
  /** Mined only (a pending one reads them from its record): the latest version, all hashes. */
  hash?: Hex;
  raw?: Hex;
  hashes?: Hex[];
}

const txKey = (nonce: number): string => `tx:${String(nonce).padStart(16, '0')}`;
const digestKey = (digest: string): string => `digest:${digest.toLowerCase()}`;
const forgetKey = (at: number, digest: string): string => `forget:${String(at).padStart(16, '0')}:${digest.toLowerCase()}`;

// ---- checks ----

const HEX_DATA = /^0x(?:[0-9a-fA-F]{2})*$/u;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const DIGEST = /^0x[0-9a-fA-F]{64}$/u;
const U256_MAX = (1n << 256n) - 1n;

function fromHex(h: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array((h.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(2 + 2 * i, 4 + 2 * i), 16);
  return out;
}

const isBig = (v: unknown, min: bigint, max: bigint): v is bigint => typeof v === 'bigint' && v >= min && v <= max;
const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
const minBig = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const maxBig = (a: bigint, b: bigint): bigint => (a > b ? a : b);

/** The bumped fees for a replacement, or null when the caps leave no valid replacement (+10% on both fields). */
export function bumpedFees(prev: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }, caps: { maxFeePerGasWei: bigint; maxPriorityFeePerGasWei: bigint }): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | null {
  const { num, den } = EVM_RELAYER_FEE_BUMP;
  const tip = minBig(ceilDiv(prev.maxPriorityFeePerGas * num, den), caps.maxPriorityFeePerGasWei);
  const fee = maxBig(minBig(ceilDiv(prev.maxFeePerGas * num, den), caps.maxFeePerGasWei), tip);
  const needTip = ceilDiv(prev.maxPriorityFeePerGas * NODE_REPLACEMENT_BUMP.num, NODE_REPLACEMENT_BUMP.den);
  const needFee = ceilDiv(prev.maxFeePerGas * NODE_REPLACEMENT_BUMP.num, NODE_REPLACEMENT_BUMP.den);
  if (tip < needTip || fee < needFee || (tip === prev.maxPriorityFeePerGas && fee === prev.maxFeePerGas)) return null;
  return { maxFeePerGas: fee, maxPriorityFeePerGas: tip };
}

/** Everything one critical section needs: the config, the chain's settings, the key (zeroed at the end) and its address. */
interface Ready {
  config: EvmSponsorConfig;
  chain: Readonly<EvmSponsorChainConfig>;
  key: Uint8Array;
  address: Hex;
}

export class EvmRelayer extends DurableObject<Env> {
  private queue: Promise<unknown> = Promise.resolve();
  /** Whether this instance has reconciled with the chain (once per instance, before its first nonce). */
  private reconciled = false;

  // ---- the interface (Workers RPC) ----

  /** Signs, persists and broadcasts the handler's transaction (or returns the one already sent for this digest). */
  async send(req: EvmRelayerSendRequest): Promise<EvmRelayerSent> {
    if (typeof req !== 'object' || req === null || typeof req.digest !== 'string' || !DIGEST.test(req.digest) || !Number.isSafeInteger(req.chainId) || req.chainId <= 0) refuse('invalid_request');
    return this.exclusive(async () => {
      const r = this.ready(req.chainId, true);
      try {
        return await this.sendLocked(req, r);
      } finally {
        r.key.fill(0);
      }
    });
  }

  /** The relayer's address and its pending transactions (storage only, no RPC). */
  async status(): Promise<EvmRelayerStatus> {
    const meta = this.meta();
    const { address } = this.checkKeyOnly(meta);
    const records = this.pendingRecords();
    const now = Date.now();
    const oldest = records.length ? Math.min(...records.map((p) => p.sentAt)) : null;
    return { address, pending: records.length, oldestPendingMs: oldest === null ? null : Math.max(0, now - oldest), nextNonce: meta?.nextNonce ?? null };
  }

  /** Every hash signed for a digest and its state, or null when it is not (or no longer) remembered. */
  async lookup(digest: Hex): Promise<EvmRelayerLookup | null> {
    if (typeof digest !== 'string' || !DIGEST.test(digest)) refuse('invalid_request');
    const rem = this.ctx.storage.kv.get<Remembered>(digestKey(digest));
    if (!rem) return null;
    if (rem.state === 'mined') return { relayerNonce: rem.nonce, transactionHash: rem.hash!, hashes: [...(rem.hashes ?? [])], state: 'mined', reservedWei: BigInt(rem.reservedWei) };
    const p = this.ctx.storage.kv.get<PendingTx>(txKey(rem.nonce));
    if (!p) return null;
    return { relayerNonce: p.nonce, transactionHash: p.hash, hashes: [...p.hashes], state: p.kind === 'cancel' ? 'cancelling' : 'pending', reservedWei: BigInt(rem.reservedWei) };
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

  /** The config and the key's address, checked against each other (and against a stored address with pending work). */
  private checkKeyOnly(meta: Meta | undefined): { config: EvmSponsorConfig; address: Hex } {
    const setting = parseEvmSponsorConfig(this.env.EVM_SPONSOR, { network: this.env.NETWORK, envName: this.env.ENV_NAME, pinnedDelegates: SPONSOR_DELEGATES });
    if (setting.status !== 'configured') refuse('relayer_unconfigured');
    const config = (setting as { config: EvmSponsorConfig }).config;
    const address = evmRelayKeyAddress(this.env.EVM_RELAY_KEYS);
    if (!address || address !== config.relayerAddress) {
      log({ event: 'evm_relayer_key_mismatch', code: address ? 'address_mismatch' : 'key_missing_or_malformed' }, 'error');
      refuse('relayer_misconfigured');
    }
    if (meta && meta.address !== address && this.pendingRecords().length > 0) {
      log({ event: 'evm_relayer_key_mismatch', code: 'key_changed_with_pending' }, 'error');
      refuse('relayer_misconfigured');
    }
    return { config, address: address as Hex };
  }

  /**
   * The checks every section starts with. `bind`: a first send fixes the object's chain (stored); a new key with
   * nothing pending starts a new nonce life (stored address, nonce re-read from chain).
   */
  private ready(chainId: number, bind: boolean): Ready {
    let meta = this.meta();
    const { config, address } = this.checkKeyOnly(meta);
    if (meta && meta.chainId !== chainId) refuse('wrong_chain');
    const chain = sponsorChain(config, chainId);
    if (!chain) refuse('relayer_unconfigured');
    if (bind && (!meta || meta.address !== address)) {
      meta = { v: SCHEMA, chainId, address, nextNonce: null, minedFloor: 0, seenFloor: 0, remembered: meta?.remembered ?? 0 };
      this.putMeta(meta);
      this.reconciled = false;
    }
    const key = parseEvmRelayKey(this.env.EVM_RELAY_KEYS);
    if (!key) return refuse('relayer_misconfigured');
    return { config, chain: chain!, key, address };
  }

  private async sendLocked(req: EvmRelayerSendRequest, r: Ready): Promise<EvmRelayerSent> {
    const kv = this.ctx.storage.kv;
    const digest = req.digest.toLowerCase() as Hex;
    const known = kv.get<Remembered>(digestKey(digest));
    if (known) return this.replay(known);
    const checked = this.check(req, r);
    const meta = this.meta()!;
    if (this.pendingRecords().length >= EVM_RELAYER_MAX_PENDING || meta.remembered >= EVM_RELAYER_MAX_REMEMBERED) {
      log({ event: 'evm_relay_busy', chainId: r.chain.chainId, code: 'relayer_busy' }, 'warn');
      refuse('relayer_busy');
    }
    const rpc = sponsorChainFor(this.env, r.chain);
    if (!this.reconciled || meta.nextNonce === null) {
      try {
        await this.repair(rpc, r, Date.now());
      } catch {
        log({ event: 'evm_relay_rpc_unavailable', chainId: r.chain.chainId, code: 'rpc_unavailable' }, 'error');
        refuse('rpc_unavailable');
      }
      this.reconciled = true;
    }

    for (let attempt = 0; ; attempt++) {
      const nonce = this.meta()!.nextNonce!;
      const now = Date.now();
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
        hashes: [hash],
        accepted: false,
      };
      const forgetAt = Number(checked.deadline) * 1000 + EVM_RELAYER_REMEMBER_AFTER_DEADLINE_MS;
      // Persist BEFORE the broadcast: the record, the batch's memory and the next nonce, in one transaction.
      this.ctx.storage.transactionSync(() => {
        const m = this.meta()!;
        kv.put(txKey(nonce), record);
        kv.put(digestKey(digest), { nonce, state: 'pending', forgetAt, reservedWei: record.reservedWei } satisfies Remembered);
        kv.put(forgetKey(forgetAt, digest), 1);
        this.putMeta({ ...m, nextNonce: nonce + 1, remembered: m.remembered + 1 });
      });
      await this.ensureAlarm(now + EVM_RELAYER_ALARM_MS);
      await this.ctx.storage.sync();

      const sent = await rpc.broadcast(raw);
      log({ event: 'evm_relay_sent', chainId: r.chain.chainId, nonce: String(nonce), evmTx: hash, attempt, code: sent.kind === 'rejected' ? sent.reason : sent.kind });
      const answer: EvmRelayerSent = { transactionHash: hash, relayerNonce: nonce, raw, replay: false };
      if (sent.kind === 'accepted') {
        this.markAccepted(nonce, hash);
        return answer;
      }
      // No definite answer (or nothing reachable): the record stays and the alarm broadcasts it again.
      if (sent.kind !== 'rejected') return answer;

      if (sent.reason === 'nonce_too_low') {
        // Another sender used this key's nonce (no record of ours was at it). Dropped only once the chain's mined count
        // is past it; then once more with the chain's next nonce.
        let latest: number;
        try {
          latest = await rpc.transactionCount(r.address, 'latest');
        } catch {
          return answer;
        }
        if (latest <= nonce) return answer;
        this.forgetUnsent(nonce, digest, forgetAt);
        log({ event: 'evm_relay_nonce_taken', chainId: r.chain.chainId, nonce: String(nonce), code: 'nonce_too_low' }, 'warn');
        try {
          await this.repair(rpc, r, Date.now());
        } catch {
          return refuse('rpc_unavailable');
        }
        if (attempt === 0) continue;
        return refuse('rejected', 'nonce_too_low');
      }
      // A definite refusal by every endpoint reached: the nonce goes back only when the chain's pending count says
      // nothing holds it (and it is still the newest), else the record stays for the alarm.
      let pending: number;
      try {
        pending = await rpc.transactionCount(r.address, 'pending');
      } catch {
        return answer;
      }
      if (pending > nonce || this.meta()!.nextNonce !== nonce + 1) return answer;
      // The record, the batch's memory and the nonce go back in one transaction (never a gap after a crash).
      this.forgetUnsent(nonce, digest, forgetAt, nonce);
      log({ event: 'evm_relay_rejected', chainId: r.chain.chainId, nonce: String(nonce), evmTx: hash, code: sent.reason }, 'warn');
      return refuse('rejected', sent.reason);
    }
  }

  /** The answer for a digest already sent: its latest version. */
  private replay(rem: Remembered): EvmRelayerSent {
    if (rem.state === 'pending') {
      const p = this.ctx.storage.kv.get<PendingTx>(txKey(rem.nonce));
      if (p) return { transactionHash: p.hash, relayerNonce: p.nonce, raw: p.raw, replay: true };
    }
    if (rem.hash && rem.raw) return { transactionHash: rem.hash, relayerNonce: rem.nonce, raw: rem.raw, replay: true };
    // A memory without its record (never left by the rules here): refuse rather than send the digest again.
    log({ event: 'evm_relay_replay_unreadable', code: 'internal' }, 'error');
    return refuse('internal');
  }

  /** The request, checked against the chain's settings (the handlers checked it first; this object trusts no caller). */
  private check(req: EvmRelayerSendRequest, r: Ready): { to: Hex; data: Hex; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; authorization: StoredAuthorization | null; deadline: bigint; reservedWei: bigint } {
    const c = r.chain;
    const { to, data, gas, maxFeePerGas, maxPriorityFeePerGas, deadline, reservedWei, authorization } = req;
    if (typeof to !== 'string' || !ADDRESS.test(to) || /^0x0{40}$/u.test(to) || sameAddress(to, r.address) || sameAddress(to, c.delegate)) refuse('invalid_request');
    if (typeof data !== 'string' || !HEX_DATA.test(data) || data.length > 2 + 2 * EVM_RELAYER_MAX_DATA_BYTES || data.slice(0, 10).toLowerCase() !== EXECUTE_SELECTOR) refuse('invalid_request');
    if (!isBig(gas, CANCEL_GAS, c.maxGasPerTx)) refuse('invalid_request');
    if (!isBig(maxFeePerGas, 1n, c.maxFeePerGasWei) || !isBig(maxPriorityFeePerGas, 0n, minBig(maxFeePerGas as bigint, c.maxPriorityFeePerGasWei))) refuse('invalid_request');
    if (!isBig(reservedWei, (gas as bigint) * (maxFeePerGas as bigint), U256_MAX)) refuse('invalid_request');
    if (typeof deadline !== 'bigint') refuse('invalid_request');
    const nowS = BigInt(Math.floor(Date.now() / 1000));
    if (deadline <= nowS + BigInt(EVM_RELAYER_MIN_DEADLINE_LEAD_S)) refuse('deadline_passed');
    if (deadline > nowS + BigInt(c.deadlineMaxS + DEADLINE_SLACK_S)) refuse('invalid_request');
    let auth: StoredAuthorization | null = null;
    if (authorization !== undefined) {
      if (typeof authorization !== 'object' || authorization === null) refuse('invalid_request');
      const a = authorization as SignedAuthorization;
      // The pinned delegate on this chain, signed by the account the transaction goes to.
      if (a.chainId !== c.chainId || typeof a.address !== 'string' || !sameAddress(a.address, c.delegate) || typeof a.nonce !== 'bigint') refuse('invalid_request');
      let signer: string;
      try {
        signer = recoverAuthorization(a);
      } catch {
        return refuse('invalid_request');
      }
      if (!sameAddress(signer, to)) refuse('invalid_request');
      auth = { chainId: a.chainId, address: a.address, nonce: a.nonce.toString(), yParity: a.yParity, r: a.r, s: a.s };
    }
    return { to: to.toLowerCase() as Hex, data: data.toLowerCase() as Hex, gas, maxFeePerGas, maxPriorityFeePerGas, authorization: auth, deadline, reservedWei };
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
   * Deletes a record no node holds, with its batch's memory (the digest may be sent again), in one transaction; with
   * `nextNonce`, the nonce goes back too.
   */
  private forgetUnsent(nonce: number, digest: Hex, forgetAt: number, nextNonce?: number): void {
    const kv = this.ctx.storage.kv;
    this.ctx.storage.transactionSync(() => {
      kv.delete(txKey(nonce));
      const m = this.meta()!;
      const had = kv.get(digestKey(digest)) !== undefined;
      kv.delete(digestKey(digest));
      kv.delete(forgetKey(forgetAt, digest));
      this.putMeta({ ...m, remembered: had ? Math.max(0, m.remembered - 1) : m.remembered, ...(nextNonce !== undefined ? { nextNonce } : {}) });
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
   * Reconciles with the chain and repairs what it finds: records whose nonce is below the mined count (the highest
   * ever reported, `minedFloor`) are done; `nextNonce` becomes the largest of what is stored, the mined count, the
   * pending count and the newest record + 1 (never lower); records no node holds (nonce ≥ the pending count) are
   * broadcast again; a nonce in [seenFloor, nextNonce) with no record is filled. Throws when the counts
   * can't be read (nothing changed then).
   */
  private async repair(rpc: SponsorChain, r: Ready, now: number): Promise<{ latest: number; pending: number }> {
    const [latestRead, pending] = await Promise.all([rpc.transactionCount(r.address, 'latest'), rpc.transactionCount(r.address, 'pending')]);
    const records = this.pendingRecords();
    let floor = 0;
    let seen = 0;
    this.ctx.storage.transactionSync(() => {
      const m = this.meta()!;
      floor = Math.max(m.minedFloor ?? 0, latestRead);
      seen = Math.max(m.seenFloor ?? 0, floor, pending);
      for (const p of records) if (p.nonce < floor) this.mined(p);
      const stored = m.nextNonce ?? 0;
      const newest = records.reduce((a, p) => Math.max(a, p.nonce + 1), 0);
      if (m.nextNonce !== null && pending > stored) log({ event: 'evm_relayer_foreign_pending', chainId: r.chain.chainId, nonce: String(pending), code: 'foreign_pending' }, 'warn');
      this.putMeta({ ...m, minedFloor: floor, seenFloor: seen, nextNonce: Math.max(stored, floor, pending, newest) });
    });
    const latest = floor;
    const next = this.meta()!.nextNonce!;
    const filledNow = new Set<number>();
    // Gap fillers: a nonce in [seenFloor, next) with no record (never left by the rules; storage is the truth).
    for (let n = seen, filled = 0; n < next && filled < EVM_RELAYER_MAX_PENDING; n++) {
      if (this.ctx.storage.kv.get(txKey(n)) !== undefined) continue;
      filled++;
      filledNow.add(n);
      log({ event: 'evm_relayer_gap', chainId: r.chain.chainId, nonce: String(n), code: 'gap_filled' }, 'error');
      await this.persistAndBroadcast(rpc, r, {
        nonce: n,
        digest: null,
        kind: 'cancel',
        sentAt: now,
        reservedWei: '0',
        deadline: '0',
        fees: { maxFeePerGas: r.chain.maxFeePerGasWei, maxPriorityFeePerGas: r.chain.maxPriorityFeePerGasWei },
        hashes: [],
      });
    }
    for (const p of this.pendingRecords()) {
      if (p.nonce >= pending && !filledNow.has(p.nonce)) await this.rebroadcast(rpc, r, p);
    }
    return { latest, pending };
  }

  /** A record whose nonce the chain has mined past: its record goes, its batch is remembered as mined (sync, in a transaction). */
  private mined(p: PendingTx): void {
    const kv = this.ctx.storage.kv;
    kv.delete(txKey(p.nonce));
    if (p.digest) {
      const rem = kv.get<Remembered>(digestKey(p.digest));
      if (rem) kv.put(digestKey(p.digest), { ...rem, state: 'mined', hash: p.hash, raw: p.raw, hashes: p.hashes } satisfies Remembered);
    }
    log({ event: 'evm_relay_mined', nonce: String(p.nonce), evmTx: p.hash, code: p.kind });
  }

  private async rebroadcast(rpc: SponsorChain, r: Ready, p: PendingTx): Promise<EvmBroadcast> {
    const sent = await rpc.broadcast(p.raw);
    if (sent.kind === 'accepted') this.markAccepted(p.nonce, p.hash);
    else log({ event: 'evm_relay_rebroadcast', chainId: r.chain.chainId, nonce: String(p.nonce), evmTx: p.hash, code: sent.kind === 'rejected' ? sent.reason : sent.kind }, 'warn');
    return sent;
  }

  /**
   * Signs a version of nonce `nonce` (an `execute` replacement with the record's payload, or a self-transfer),
   * stores it as the record (hashes appended) and only then broadcasts it.
   */
  private async persistAndBroadcast(
    rpc: SponsorChain,
    r: Ready,
    v: { nonce: number; digest: Hex | null; kind: 'execute' | 'cancel'; sentAt: number; reservedWei: string; deadline: string; fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }; hashes: Hex[]; payload?: PendingTx },
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
      hashes: [...v.hashes, hash],
      accepted: false,
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
      await this.schedule(now, MISCONFIGURED_RETRY_MS);
      return;
    }
    try {
      if (this.pendingRecords().length > 0 && meta.address === r.address) {
        const rpc = sponsorChainFor(this.env, r.chain);
        try {
          await this.repair(rpc, r, now);
          this.reconciled = true;
        } catch {
          log({ event: 'evm_relay_rpc_unavailable', chainId: r.chain.chainId, code: 'rpc_unavailable' }, 'warn');
          await this.schedule(now, EVM_RELAYER_ALARM_MS);
          return;
        }
        for (const p of this.pendingRecords()) await this.advance(rpc, r, p, now);
      }
      this.prune(now);
      const left = this.pendingRecords().length;
      if (left > 0) log({ event: 'evm_relayer_pending', chainId: r.chain.chainId, pending: left });
      await this.schedule(now, EVM_RELAYER_ALARM_MS);
    } finally {
      r.key.fill(0);
    }
  }

  /** One pending record's next step (see the header): a self-transfer past the deadline, a fee replacement after 60 s. */
  private async advance(rpc: SponsorChain, r: Ready, p: PendingTx, now: number): Promise<void> {
    const prev = { maxFeePerGas: BigInt(p.maxFeePerGas), maxPriorityFeePerGas: BigInt(p.maxPriorityFeePerGas) };
    const caps = { maxFeePerGasWei: r.chain.maxFeePerGasWei, maxPriorityFeePerGasWei: r.chain.maxPriorityFeePerGasWei };
    const canReplace = p.hashes.length < EVM_RELAYER_MAX_HASHES;
    const expired = p.kind === 'execute' && BigInt(Math.floor(now / 1000)) > BigInt(p.deadline);
    if (expired || (canReplace && now - p.signedAt >= EVM_RELAYER_REPLACE_AFTER_MS)) {
      const fees = canReplace ? bumpedFees(prev, caps) : null;
      if (fees) {
        await this.persistAndBroadcast(rpc, r, {
          nonce: p.nonce,
          digest: p.digest,
          kind: expired ? 'cancel' : p.kind,
          sentAt: p.sentAt,
          reservedWei: p.reservedWei,
          deadline: p.deadline,
          fees,
          hashes: p.hashes,
          payload: p,
        });
        return;
      }
      // At the caps: no valid replacement. The last version stays (repair broadcast it again if no node held it); it
      // lands (or, past the deadline, reverts and frees the nonce) once the base fee allows.
    }
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

  /** The next alarm: `every` from now while anything is pending, else the next forget time, else none. */
  private async schedule(now: number, every: number): Promise<void> {
    if (this.pendingRecords().length > 0) {
      await this.ctx.storage.setAlarm(now + every);
      return;
    }
    const next = Array.from(this.ctx.storage.kv.list<number>({ prefix: 'forget:', limit: 1 }), ([k]) => k)[0];
    if (next) await this.ctx.storage.setAlarm(Math.max(now + 1_000, Number(next.slice('forget:'.length, 'forget:'.length + 16)) + 1));
    else await this.ctx.storage.deleteAlarm();
  }
}
