// One Durable Object per relayer access key (name from relayerKeyName(pool, index): `relayer-key-<i>` for the
// session pool, `owner-relayer-key-<i>` for the owner pool, `home-relayer-key-<i>` for the Home pool; and
// `near-relay-key-<i>` for a full-access key of the NEAR meta-transaction relay account, NEAR_RELAY_KEYS, D734). An
// object serves one of these roles for its whole life. It owns that key's nonce: nonces are handed out strictly
// in order inside a small critical section (nonce → sign → dispatch send_tx), and the outcome is awaited outside it,
// so many transactions per key can be in flight at once. Nonces are reserved in blocks (NONCE_RESERVATION), so most
// relays write nothing to storage and their broadcast never waits for a storage write.
import type { KeyPair } from '@near-js/crypto';
import { baseEncode } from '@near-js/utils';
import { DurableObject } from 'cloudflare:workers';
import { sha256 } from './bytes.ts';
import type { Env } from './env.ts';
import { gasFor } from './gas.ts';
import { log } from './log.ts';
import { ALREADY_RELAYED, POOL_SECRET, type Pool, isPool, parseRelayerKeys, poolAllows } from './relayer-config.ts';
import { RELAY_WAIT_UNTIL, type Rpc, type RpcError, nearRpc, invalidNonce, isDefiniteRejection, isExpired, type SendTxResult } from './near/rpc.ts';
import type { LinkTally } from './link-usage.ts';
import { type ContractCall, type SignedTx, parseKeyPair, signFunctionCall, waitForOutcome } from './near/tx.ts';
import { type RelayAction, encodeRelayTransaction, encodeSignedTransaction } from './near/delegate.ts';
import { parseNearRelayConfig } from './near/relay-config.ts';

export { parseRelayerKeys };

/** Refresh the reference block hash after this long (a tx is valid for ~24 h of blocks). */
const BLOCK_HASH_MAX_AGE_MS = 5 * 60_000;

/**
 * Nonces reserved per storage write. Storage holds a reservation R for the key ("no tx of this key was ever sent with
 * a nonce above R"), raised to `n + NONCE_RESERVATION - 1` only when a dispatch needs a nonce n above it.
 *
 * Why: while a storage write is unconfirmed, the object's outgoing network messages, fetch() included, are held
 * (output gates: https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/), and on SQLite-backed
 * objects a write is confirmed once 3 of 5 followers in other data centers have it
 * (https://blog.cloudflare.com/sqlite-in-durable-objects/). Writing the nonce before every send_tx held every
 * broadcast for that confirmation; now one relay in NONCE_RESERVATION waits for it.
 *
 * Why no nonce is ever sent twice, across crashes, evictions and deploys included:
 * - A tx with nonce n > R is only sent after R' ≥ n was written and `ctx.storage.sync()` resolved, i.e. the write is
 *   confirmed (https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#sync). The output gate would
 *   hold the fetch anyway; the explicit wait does not depend on it. A failed write rejects (and resets the object):
 *   nothing is sent.
 * - R only grows (R' = n + NONCE_RESERVATION - 1 with n > R), so every nonce ever sent is ≤ the stored R.
 * - A cold start takes max(R, the chain's access key nonce): the next nonce is above every nonce sent before.
 * - InvalidNonce / dropped recovery only raises the nonce, and a nonce above R is reserved before it is sent.
 * Not used: `allowUnconfirmed` (async KV API only), which would let the tx leave before R is durable: the reuse this
 * prevents.
 *
 * Cost: each restart skips up to NONCE_RESERVATION - 1 nonces. NEAR accepts gaps: a tx nonce must be above the access
 * key's and at most block height × 10^6 (https://docs.near.org/protocol/transactions/transaction-anatomy), a bound
 * that grows by 10^6 a block. A value stored before reservations (the last nonce used) is also a valid R.
 */
export const NONCE_RESERVATION = 100;

/**
 * Time spent inside the object: getting a nonce and broadcasting (queue included; after a retry, the failed attempt
 * too), then waiting for the outcome. The other fields split dispatchMs, summed over attempts: waiting for earlier
 * critical sections, access key / block reads from RPC (cold start, block hash older than BLOCK_HASH_MAX_AGE_MS,
 * recovery), signing, and confirming a new nonce reservation (0 inside a reservation). The Workers clock only
 * advances on I/O (https://developers.cloudflare.com/workers/runtime-apis/performance/): CPU work such as signing
 * reads ~0.
 */
export interface RelayTiming {
  dispatchMs: number;
  outcomeMs: number;
  queueMs: number;
  chainReadMs: number;
  signMs: number;
  persistMs: number;
}

/** The parts of dispatchMs, accumulated across attempts. */
type DispatchTiming = Pick<RelayTiming, 'queueMs' | 'chainReadMs' | 'signMs' | 'persistMs'>;

/**
 * Which object instance served the relay, to explain chainReadMs: `cold` when this relay started a new instance
 * (first use, or after eviction or a deploy), `coldChainRead` when that start had to read the chain, `blockRefresh` when it re-read the reference block,
 * `served` relays this instance handled before this one, `ageMs` since the instance started.
 */
export interface RelayInstance {
  cold: boolean;
  /** A cold start that had to read the nonce from chain (no stored reservation for this key). */
  coldChainRead: boolean;
  blockRefresh: boolean;
  served: number;
  ageMs: number;
}

/**
 * Which key signed the transaction a result names, and with which nonce (decimal): on every result that carries a
 * `nearTx` (the last one sent, after a retry). The usage ledger records them beside the transaction, so the admin's
 * daily nonce cross-check can explain each key's nonce on chain (docs/batch-c-spec.md "Daily nonce cross-check").
 * `relayGasBurnt` / `relayTokensBurnt` (decimal; BigInt sums over the transaction and every receipt, near/tx.ts
 * burntGas) when the outcome settled and the RPC reported them: provisional (EXECUTED_OPTIMISTIC), never billed.
 */
export interface RelaySigner {
  relayerPk?: string;
  relayerNonce?: string;
  relayGasBurnt?: string;
  relayTokensBurnt?: string;
}

/** `executor`: on `contract_rejected`, the account whose receipt failed (null when the RPC did not say). */
export type RelayResult = (
  | ({ ok: true; result: unknown; nearTx: string; linkTally?: LinkTally } & RelaySigner)
  | ({ ok: false; status: number; code: string; error: string; nearTx?: string; executor?: string | null; rejection?: 'not_enough_balance' } & RelaySigner)
) & { timing?: RelayTiming; instance?: RelayInstance };

interface Dispatched {
  hash: string;
  nonce: bigint;
  /** The send_tx response; awaited outside the critical section. */
  response: Promise<SendTxResult>;
}

const alreadyRelayed: RelayResult = { ok: false, status: 409, code: ALREADY_RELAYED, error: 'This request was already relayed' };

/**
 * A NEAR relay job (near/relay.ts): the relayer's transaction to `receiverId` (the user's implicit account) carrying
 * either the user's signed delegate action, exactly as received and checked, or a zero Transfer that creates the
 * account (activation, D731).
 */
export interface NearRelayJob {
  receiverId: string;
  action: RelayAction;
  /**
   * Relays this key object may have in flight (near/relay-config.ts inFlightCapPerKey): beyond it the job is refused
   * `503 relayer_busy` before anything is signed, so the relays in flight never hold more of the account's balance
   * than `near.relay.inFlightNear`.
   */
  maxInFlight: number;
}

/** Durable Object name of a NEAR relay key (NEAR_RELAY_KEYS index). */
export const nearRelayKeyName = (index: number): string => `near-relay-key-${index}`;

/** How long a NEAR relay waits for its outcome: a meta transaction settles in about three blocks. */
export const NEAR_RELAY_OUTCOME_MS = 30_000;

/** Builds and signs one transaction for a nonce and reference block (each role signs its own kind). */
type SignFor = (nonce: bigint, blockHash: string) => Promise<SignedTx>;

/**
 * How long a relayed claim is remembered: past the API's session cache (≤ 10 s, views.ts sessionCache), the longest an
 * isolate can still judge a copy against the session as it was before the original landed. Memory only: an evicted
 * object forgets (idle ~10 s, by when those cached views have expired too), and the copy then fails on chain.
 */
export const CLAIM_MEMORY_MS = 30_000;
/** At most this many remembered claims per object; the oldest go first. */
export const MAX_REMEMBERED_CLAIMS = 5_000;

export class RelayerKey extends DurableObject<Env> {
  /** The role this object serves, fixed by its first relay: a pool, or the NEAR relay (never two). */
  private role: Pool | 'near' | null = null;
  /** The account the key signs for: RELAYER_ACCOUNT for the pools, the NEAR relay account for `near`. */
  private accountId = '';
  /** What a stored reservation is for: the public key (pools), or account and key (`near`, whose account comes from config). */
  private storeId = '';
  private keyIndex = -1;
  private keyPair: KeyPair | null = null;
  private publicKey = '';
  /** Last nonce handed out; null until the cold-start read. */
  private nonce: bigint | null = null;
  /** The confirmed stored reservation for this key (see NONCE_RESERVATION); 0 while storage holds none for it. */
  private reserved = 0n;
  private blockHash: string | null = null;
  private blockHashAt = 0;
  /** The block hash changed since it was last stored (written after the next broadcast, see dispatch). */
  private blockDirty = false;
  private queue: Promise<unknown> = Promise.resolve();
  /** When this instance started, and how many relays it has taken (see RelayInstance). */
  private readonly startedAt = Date.now();
  private served = 0;
  private inflight = 0;
  /**
   * Requests signed once (D455, security.md (g)). Every copy of one lands here, from any isolate (relayer-pool.ts
   * claimKeyIndex; a copy that failed here moves on to the next key, the same one for every copy): held while the
   * original is in flight, then refused once it succeeded (a copy would only fail on chain, at ~2.2 Tgas), and relayed
   * when it failed (it may still succeed). An isolate's own holds and pre-checks come first (session-use.ts); this
   * covers what they can't see.
   */
  private readonly claims = new Map<string, Promise<void>>();
  /** Claim → when its success is forgotten (see CLAIM_MEMORY_MS). */
  private readonly relayed = new Map<string, number>();

  /** Requests currently being relayed through this key (dispatched or waiting for an outcome). */
  get busy(): number {
    return this.inflight;
  }

  async relay(pool: Pool, keyIndex: number, request: ContractCall, requestId?: string, claim?: string): Promise<RelayResult> {
    return this.claimed(claim, () => this.relayOnce(pool, keyIndex, request, requestId));
  }

  /**
   * The NEAR relay's transaction (D734): through this object's key of NEAR_RELAY_KEYS, on the relay account named by
   * NEAR_RELAY. With `claim` (the signed delegate's hash) copies of one request meet here as the pools' claims do.
   */
  async relayNear(keyIndex: number, job: NearRelayJob, requestId?: string, claim?: string): Promise<RelayResult> {
    return this.claimed(claim, () => this.timed((mark, parts, instance) => this.relayNearTimed(keyIndex, job, requestId, mark, parts, instance)));
  }

  /** Runs `run` once per claim at a time; a claim that succeeded is refused for CLAIM_MEMORY_MS (D455). */
  private async claimed(claim: string | undefined, run: () => Promise<RelayResult>): Promise<RelayResult> {
    if (claim === undefined) return run();
    for (;;) {
      if (this.isRelayed(claim)) return alreadyRelayed;
      const held = this.claims.get(claim);
      if (!held) break;
      await held;
    }
    let settle!: () => void;
    this.claims.set(claim, new Promise<void>((resolve) => (settle = resolve)));
    try {
      const result = await run();
      if (result.ok) this.rememberRelayed(claim);
      return result;
    } finally {
      this.claims.delete(claim);
      settle();
    }
  }

  private isRelayed(claim: string): boolean {
    const until = this.relayed.get(claim);
    if (until === undefined) return false;
    if (until > Date.now()) return true;
    this.relayed.delete(claim);
    return false;
  }

  private rememberRelayed(claim: string): void {
    const now = Date.now();
    if (this.relayed.size >= MAX_REMEMBERED_CLAIMS) {
      for (const [k, until] of this.relayed) if (until <= now) this.relayed.delete(k);
      for (const k of this.relayed.keys()) {
        if (this.relayed.size < MAX_REMEMBERED_CLAIMS) break;
        this.relayed.delete(k);
      }
    }
    this.relayed.set(claim, now + CLAIM_MEMORY_MS);
  }

  private relayOnce(pool: Pool, keyIndex: number, request: ContractCall, requestId?: string): Promise<RelayResult> {
    return this.timed((mark, parts, instance) => this.relayTimed(pool, keyIndex, request, requestId, mark, parts, instance));
  }

  private async timed(run: (mark: { dispatched: number }, parts: DispatchTiming, instance: RelayInstance) => Promise<RelayResult>): Promise<RelayResult> {
    const started = Date.now();
    const mark = { dispatched: started };
    const parts: DispatchTiming = { queueMs: 0, chainReadMs: 0, signMs: 0, persistMs: 0 };
    const instance: RelayInstance = { cold: false, coldChainRead: false, blockRefresh: false, served: this.served++, ageMs: started - this.startedAt };
    const result = await run(mark, parts, instance);
    const end = Date.now();
    return { ...result, timing: { dispatchMs: mark.dispatched - started, outcomeMs: end - mark.dispatched, ...parts }, instance };
  }

  /** `mark.dispatched` is set each time a transaction has been broadcast; `parts` accumulates the dispatch stages. */
  private async relayTimed(
    pool: Pool,
    keyIndex: number,
    request: ContractCall,
    requestId: string | undefined,
    mark: { dispatched: number },
    parts: DispatchTiming,
    instance: RelayInstance,
  ): Promise<RelayResult> {
    if (!isPool(pool)) return { ok: false, status: 400, code: 'method_not_allowed', error: 'Unknown relayer pool' };
    const method = request.method;
    if (!poolAllows(pool, method)) return { ok: false, status: 400, code: 'method_not_allowed', error: `Method ${method} is not relayed by the ${pool} pool` };
    if ((this.role !== null && this.role !== pool) || (this.keyIndex >= 0 && this.keyIndex !== keyIndex)) {
      return { ok: false, status: 503, code: 'relayer_unavailable', error: 'Relayer key mismatch' };
    }
    // Gas always comes from gas.ts (per method, env-overridable), never from the caller.
    const call: ContractCall = { method, args: request.args, gas: gasFor(method, this.env, request.args) };
    const rpc = nearRpc(this.env);
    this.inflight++;
    try {
      this.loadKey(pool, keyIndex);
      const keyPair = this.keyPair as KeyPair;
      const sign: SignFor = (nonce, blockHash) => signFunctionCall({ keyPair, signerId: this.env.RELAYER_ACCOUNT, receiverId: this.env.SIGNER_ACCOUNT, nonce, blockHash, call });
      return await this.sendWithRetry(rpc, sign, { pool, keyIndex, method: call.method }, { linkEventsFrom: this.env.SIGNER_ACCOUNT }, requestId, mark, parts, instance);
    } catch {
      // Key loading or an RPC read failed: the text could name a secret's binding or the RPC URL, so it isn't returned.
      log({ event: 'relay_failed', requestId, pool, keyIndex, method: call.method, code: 'relayer_unavailable' }, 'error');
      return { ok: false, status: 503, code: 'relayer_unavailable', error: 'The relayer is unavailable, try again' };
    } finally {
      this.inflight--;
    }
  }

  private async relayNearTimed(keyIndex: number, job: NearRelayJob, requestId: string | undefined, mark: { dispatched: number }, parts: DispatchTiming, instance: RelayInstance): Promise<RelayResult> {
    const method = job.action.kind === 'delegate' ? 'delegate' : 'activate';
    if ((this.role !== null && this.role !== 'near') || (this.keyIndex >= 0 && this.keyIndex !== keyIndex)) {
      return { ok: false, status: 503, code: 'relayer_unavailable', error: 'Relayer key mismatch' };
    }
    const config = parseNearRelayConfig(this.env.NEAR_RELAY);
    // Testnet only, checked again here (D733): this object never signs on another network, whatever its caller said.
    if (!config || this.env.NETWORK !== 'testnet') return { ok: false, status: 503, code: 'relayer_unconfigured', error: 'The NEAR relay is not configured' };
    if (config.account === this.env.RELAYER_ACCOUNT || config.account === this.env.SIGNER_ACCOUNT) return { ok: false, status: 503, code: 'relayer_unconfigured', error: 'The NEAR relay is not configured' };
    if (!Number.isSafeInteger(job.maxInFlight) || this.inflight >= job.maxInFlight) {
      return { ok: false, status: 503, code: 'relayer_busy', error: 'The NEAR relay has too many transactions in flight, try again' };
    }
    const rpc = nearRpc(this.env);
    this.inflight++;
    try {
      this.loadNearKey(keyIndex, config.account);
      const keyPair = this.keyPair as KeyPair;
      const publicKey = keyPair.getPublicKey().data;
      const sign: SignFor = async (nonce, blockHash) => {
        const tx = encodeRelayTransaction({ signerId: config.account, publicKey, nonce, receiverId: job.receiverId, blockHash, action: job.action });
        const hash = await sha256(tx);
        return { bytes: encodeSignedTransaction(tx, keyPair.sign(hash).signature), hash: baseEncode(hash) };
      };
      return await this.sendWithRetry(rpc, sign, { pool: 'near', keyIndex, method }, { timeoutMs: NEAR_RELAY_OUTCOME_MS }, requestId, mark, parts, instance);
    } catch {
      log({ event: 'relay_failed', requestId, pool: 'near', keyIndex, method, code: 'relayer_unavailable' }, 'error');
      return { ok: false, status: 503, code: 'relayer_unavailable', error: 'The relayer is unavailable, try again' };
    } finally {
      this.inflight--;
    }
  }

  /**
   * The broadcast and its outcome, for any role: a nonce and a signature inside the critical section, the outcome
   * outside it, and one retry with a fresh nonce for InvalidNonce, an expired block hash or a dropped transaction (none
   * of which executed). Throws only when a chain read for the recovery fails (the callers answer relayer_unavailable).
   */
  private async sendWithRetry(
    rpc: Rpc,
    sign: SignFor,
    label: { pool: string; keyIndex: number; method: string },
    waitOpts: { linkEventsFrom?: string; timeoutMs?: number },
    requestId: string | undefined,
    mark: { dispatched: number },
    parts: DispatchTiming,
    instance: RelayInstance,
  ): Promise<RelayResult> {
    const { pool, keyIndex, method } = label;
    for (let attempt = 0; ; attempt++) {
      let sent: Dispatched;
      try {
        sent = await this.exclusive(() => this.dispatch(rpc, sign, parts, instance), parts);
      } catch {
        // An RPC read failed (or, rarely, the reservation write did): either way nothing was sent.
        log({ event: 'relay_dispatch_failed', requestId, pool, keyIndex, method: method, code: 'near_unavailable' }, 'error');
        // The RPC's or the runtime's error text stays out of the answer: a fetch error can name the provider's URL,
        // and an RPC URL can carry an API key.
        return { ok: false, status: 502, code: 'near_unavailable', error: 'Could not reach NEAR, try again' };
      }
      mark.dispatched = Date.now();
      log({ event: 'relay_dispatched', requestId, pool, keyIndex, method: method, nearTx: sent.hash, nonce: sent.nonce.toString(), attempt });
      const signer: RelaySigner = { relayerPk: this.publicKey, relayerNonce: sent.nonce.toString() };

      let initial: SendTxResult | null = null;
      try {
        initial = await sent.response;
      } catch (err) {
        const bad = invalidNonce(err);
        if ((bad || isExpired(err)) && attempt === 0) {
          // Another writer used this key, or our view of the nonce/block was stale: re-read and retry once.
          await this.exclusive(() => this.recover(rpc, bad?.akNonce ?? null, !bad, parts), parts);
          log({ event: 'relay_retry', requestId, pool, keyIndex, method: method, code: bad ? 'invalid_nonce' : 'expired', nearTx: sent.hash }, 'warn');
          continue;
        }
        if (bad) return { ok: false, status: 503, code: 'relayer_busy', error: 'The relayer could not get a valid nonce, try again', nearTx: sent.hash, ...signer };
        // Only a validation error is a definite "not accepted". Anything else (timeout, dropped connection, a
        // non-JSON 5xx from a proxy, any answer after an RPC failover, D435) may have been forwarded and may still
        // execute: poll its hash.
        if (isDefiniteRejection(err)) {
          log({ event: 'relay_rejected', requestId, pool, keyIndex, method: method, code: rejectionName(err), nearTx: sent.hash }, 'error');
          // A relay account short of balance (the pessimistic gas hold of the relays in flight): said, so the caller
          // charges it rather than giving it back (M1 of the 2026-11-11 review).
          const short = /NotEnoughBalance|LackBalanceForState/u.test(JSON.stringify((err as RpcError).rpc ?? null));
          return { ok: false, status: 502, code: 'near_rejected', error: 'NEAR rejected the transaction', nearTx: sent.hash, ...signer, ...(short ? { rejection: 'not_enough_balance' as const } : {}) };
        }
      }

      const nonce = sent.nonce;
      const outcome = await waitForOutcome(rpc, sent.hash, this.accountId, initial, {
        ...waitOpts,
        // A later nonce of this key landed first: this tx can never be included (it was dropped from the pool).
        superseded: async () => BigInt((await rpc.viewAccessKey(this.accountId, this.publicKey)).nonce) >= nonce,
      });
      const burnt: RelaySigner = outcome.gas ? { relayGasBurnt: outcome.gas.gasBurnt.toString(), relayTokensBurnt: outcome.gas.tokensBurnt.toString() } : {};
      if (outcome.ok) return { ok: true, result: outcome.value, nearTx: sent.hash, ...signer, ...burnt, ...(outcome.linkTally ? { linkTally: outcome.linkTally } : {}) };
      if (outcome.kind === 'dropped') {
        if (attempt === 0) {
          // It never executed: resend once with a fresh nonce (re-read, since other txs moved the key on).
          await this.exclusive(() => this.recover(rpc, null, false, parts), parts);
          log({ event: 'relay_retry', requestId, pool, keyIndex, method: method, code: 'dropped', nearTx: sent.hash }, 'warn');
          continue;
        }
        return { ok: false, status: 503, code: 'relayer_busy', error: 'The transaction was dropped, try again', nearTx: sent.hash, ...signer };
      }
      if (outcome.kind === 'failure') return { ok: false, status: 422, code: 'contract_rejected', error: outcome.error, nearTx: sent.hash, executor: outcome.executor, ...signer, ...burnt };
      if (outcome.kind === 'timeout') return { ok: false, status: 504, code: 'timeout', error: outcome.error, nearTx: sent.hash, ...signer };
      return { ok: false, status: 502, code: 'near_error', error: outcome.error, nearTx: sent.hash, ...signer, ...burnt };
    }
  }

  /** Runs `fn` after every earlier critical section has finished; never runs two at once. The wait counts as queueMs. */
  private exclusive<T>(fn: () => Promise<T>, parts: DispatchTiming): Promise<T> {
    const queued = Date.now();
    const start = (): Promise<T> => {
      parts.queueMs += Date.now() - queued;
      return fn();
    };
    const run = this.queue.then(start, start);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private loadKey(pool: Pool, keyIndex: number): void {
    if (this.keyPair) return;
    const name = POOL_SECRET[pool];
    const secret = parseRelayerKeys(this.env[name], name)[keyIndex];
    if (!secret) throw new Error(`No ${name} key at index ${keyIndex}`);
    this.keyPair = parseKeyPair(secret);
    this.publicKey = this.keyPair.getPublicKey().toString();
    this.role = pool;
    this.keyIndex = keyIndex;
    this.accountId = this.env.RELAYER_ACCOUNT;
    this.storeId = this.publicKey;
  }

  /** The NEAR relay's key at `keyIndex` of NEAR_RELAY_KEYS, signing for `account` (a changed account is a new key's life). */
  private loadNearKey(keyIndex: number, account: string): void {
    if (this.keyPair && this.accountId === account) return;
    if (this.keyPair) throw new Error('The NEAR relay account changed under a live object');
    const secret = parseRelayerKeys(this.env.NEAR_RELAY_KEYS, 'NEAR_RELAY_KEYS')[keyIndex];
    if (!secret) throw new Error(`No NEAR_RELAY_KEYS key at index ${keyIndex}`);
    this.keyPair = parseKeyPair(secret);
    this.publicKey = this.keyPair.getPublicKey().toString();
    this.role = 'near';
    this.keyIndex = keyIndex;
    this.accountId = account;
    this.storeId = `${account}/${this.publicKey}`;
  }

  /**
   * Critical section: next nonce, sign, reserve the nonce if it is above the reservation (see NONCE_RESERVATION),
   * start the broadcast. Does not wait for the broadcast to answer.
   */
  private async dispatch(rpc: Rpc, sign: SignFor, parts: DispatchTiming, instance: RelayInstance): Promise<Dispatched> {
    if (!this.keyPair) throw new Error('Relayer key not loaded');
    let at = Date.now();
    if (this.nonce === null) {
      instance.cold = true;
      instance.coldChainRead = (await this.initNonce(rpc)).chainRead;
    }
    if (!this.blockHash || Date.now() - this.blockHashAt > BLOCK_HASH_MAX_AGE_MS) {
      instance.blockRefresh = true;
      await this.refreshBlockHash(rpc);
    }
    at = addLap(parts, 'chainReadMs', at);
    const nonce = (this.nonce ?? 0n) + 1n;
    const signed = await sign(nonce, this.blockHash as string);
    at = addLap(parts, 'signMs', at);
    // Confirmed before the tx leaves this object; if it throws, nothing is sent and the nonce is not used.
    if (nonce > this.reserved) await this.reserve(nonce);
    addLap(parts, 'persistMs', at);
    this.nonce = nonce;
    const response = rpc.sendTx(signed.bytes, RELAY_WAIT_UNTIL);
    // Handled by the caller; this keeps an early rejection from being reported as unhandled.
    response.catch(() => undefined);
    // After the broadcast has left: an unconfirmed write would hold it (output gate). Losing this write only costs
    // the next cold start a block read.
    if (this.blockDirty) this.storeBlock();
    return { hash: signed.hash, nonce, response };
  }

  /**
   * Cold start. With a reservation stored for this key, it starts from that reservation without reading the chain:
   * idle objects are evicted after ~10 s (measured on sandbox-dev: every relay of a quiet pool started cold, ~0.24 s of
   * RPC each), and only this object sends with this key, so every nonce it ever sent is ≤ the reservation. If the key
   * was used elsewhere anyway, the node answers InvalidNonce and `recover` re-reads the chain (one retry). The stored
   * block hash is reused while under BLOCK_HASH_MAX_AGE_MS. The first dispatch then reserves a new block of nonces.
   *
   * Without a stored reservation (a new or replaced key): the chain's nonce, and a final block read alongside (the
   * access key view answers at an optimistic block, which an RPC node a block behind rejects as `Expired`).
   */
  private async initNonce(rpc: Rpc): Promise<{ chainRead: boolean }> {
    const kv = this.ctx.storage.kv;
    // A reservation stored for another key (the secret at this index was replaced) says nothing about this one.
    const mine = kv.get<string>('publicKey') === this.storeId;
    const stored = mine ? kv.get<string>('nonce') : undefined;
    if (stored) {
      this.reserved = BigInt(stored);
      this.nonce = this.reserved;
      const block = kv.get<{ hash: string; at: number }>('block');
      if (block && typeof block.hash === 'string' && typeof block.at === 'number') {
        this.blockHash = block.hash;
        this.blockHashAt = block.at;
      }
      return { chainRead: false };
    }
    const [ak, blockHash] = await Promise.all([rpc.viewAccessKey(this.accountId, this.publicKey), rpc.latestBlockHash()]);
    this.reserved = 0n;
    this.nonce = BigInt(ak.nonce);
    this.setBlock(blockHash);
    return { chainRead: true };
  }

  /**
   * After InvalidNonce (or an expired block hash): re-read the access key nonce and block hash from RPC. The nonce
   * only moves up; the next dispatch reserves it if it left the reservation.
   */
  private async recover(rpc: Rpc, akNonce: bigint | null, refreshBlockOnly: boolean, parts: DispatchTiming): Promise<void> {
    const at = Date.now();
    if (refreshBlockOnly) {
      await this.refreshBlockHash(rpc);
    } else {
      const [ak, blockHash] = await Promise.all([rpc.viewAccessKey(this.accountId, this.publicKey), rpc.latestBlockHash()]);
      this.nonce = maxBig(this.nonce ?? 0n, BigInt(ak.nonce), akNonce ?? 0n);
      this.setBlock(blockHash);
    }
    addLap(parts, 'chainReadMs', at);
  }

  private async refreshBlockHash(rpc: Rpc): Promise<void> {
    this.setBlock(await rpc.latestBlockHash());
  }

  private setBlock(hash: string): void {
    this.blockHash = hash;
    this.blockHashAt = Date.now();
    this.blockDirty = true;
  }

  /** Stores the reference block for the next cold start (no wait: see dispatch). */
  private storeBlock(): void {
    this.ctx.storage.kv.put('publicKey', this.storeId);
    this.ctx.storage.kv.put('block', { hash: this.blockHash, at: this.blockHashAt });
    this.blockDirty = false;
  }

  /** Stores a reservation covering `nonce` (above the current one) and waits until the write is confirmed. */
  private async reserve(nonce: bigint): Promise<void> {
    const reserved = nonce + BigInt(NONCE_RESERVATION) - 1n;
    this.ctx.storage.kv.put('publicKey', this.storeId);
    this.ctx.storage.kv.put('nonce', reserved.toString());
    await this.ctx.storage.sync();
    this.reserved = reserved;
  }
}

/** Adds the time since `since` to `parts[name]`; returns now. */
function addLap(parts: DispatchTiming, name: keyof DispatchTiming, since: number): number {
  const now = Date.now();
  parts[name] += now - since;
  return now;
}

const maxBig = (...xs: bigint[]): bigint => xs.reduce((a, b) => (b > a ? b : a));
/** The NEAR error class of a definite rejection (`InvalidTxError`, `INVALID_TRANSACTION`, …), for the log only. */
function rejectionName(err: unknown): string {
  const rpc = (err as RpcError).rpc;
  const name = rpc?.cause?.name ?? rpc?.name ?? 'rejected';
  return /^[A-Za-z_]{1,64}$/u.test(name) ? name : 'rejected';
}
