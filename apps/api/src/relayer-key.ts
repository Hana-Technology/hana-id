// One Durable Object per relayer access key (name from relayerKeyName(pool, index): `relayer-key-<i>` for the
// session pool, `owner-relayer-key-<i>` for the owner pool). It owns that key's nonce: nonces are handed out strictly
// in order inside a small critical section (nonce → sign → dispatch send_tx), and the outcome is awaited outside it,
// so many transactions per key can be in flight at once. Nonces are reserved in blocks (NONCE_RESERVATION), so most
// relays write nothing to storage and their broadcast never waits for a storage write.
import type { KeyPair } from '@near-js/crypto';
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env.ts';
import { gasFor } from './gas.ts';
import { log } from './log.ts';
import { POOL_SECRET, type Pool, isPool, parseRelayerKeys, poolAllows } from './relayer-config.ts';
import { RELAY_WAIT_UNTIL, Rpc, invalidNonce, isDefiniteRejection, isExpired, type SendTxResult } from './near/rpc.ts';
import { type ContractCall, parseKeyPair, signFunctionCall, waitForOutcome } from './near/tx.ts';

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

export type RelayResult = (
  | { ok: true; result: unknown; nearTx: string }
  | { ok: false; status: number; code: string; error: string; nearTx?: string }
) & { timing?: RelayTiming };

interface Dispatched {
  hash: string;
  nonce: bigint;
  /** The send_tx response; awaited outside the critical section. */
  response: Promise<SendTxResult>;
}

export class RelayerKey extends DurableObject<Env> {
  /** The pool this object serves, fixed by its first relay (an object never signs for two pools). */
  private pool: Pool | null = null;
  private keyIndex = -1;
  private keyPair: KeyPair | null = null;
  private publicKey = '';
  /** Last nonce handed out; null until the cold-start read. */
  private nonce: bigint | null = null;
  /** The confirmed stored reservation for this key (see NONCE_RESERVATION); 0 while storage holds none for it. */
  private reserved = 0n;
  private blockHash: string | null = null;
  private blockHashAt = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private inflight = 0;

  /** Requests currently being relayed through this key (dispatched or waiting for an outcome). */
  get busy(): number {
    return this.inflight;
  }

  async relay(pool: Pool, keyIndex: number, request: ContractCall, requestId?: string): Promise<RelayResult> {
    const started = Date.now();
    const mark = { dispatched: started };
    const parts: DispatchTiming = { queueMs: 0, chainReadMs: 0, signMs: 0, persistMs: 0 };
    const result = await this.relayTimed(pool, keyIndex, request, requestId, mark, parts);
    const end = Date.now();
    return { ...result, timing: { dispatchMs: mark.dispatched - started, outcomeMs: end - mark.dispatched, ...parts } };
  }

  /** `mark.dispatched` is set each time a transaction has been broadcast; `parts` accumulates the dispatch stages. */
  private async relayTimed(
    pool: Pool,
    keyIndex: number,
    request: ContractCall,
    requestId: string | undefined,
    mark: { dispatched: number },
    parts: DispatchTiming,
  ): Promise<RelayResult> {
    if (!isPool(pool)) return { ok: false, status: 400, code: 'method_not_allowed', error: 'Unknown relayer pool' };
    const method = request.method;
    if (!poolAllows(pool, method)) return { ok: false, status: 400, code: 'method_not_allowed', error: `Method ${method} is not relayed by the ${pool} pool` };
    if ((this.pool !== null && this.pool !== pool) || (this.keyIndex >= 0 && this.keyIndex !== keyIndex)) {
      return { ok: false, status: 503, code: 'relayer_unavailable', error: 'Relayer key mismatch' };
    }
    // Gas always comes from gas.ts (per method, env-overridable), never from the caller.
    const call: ContractCall = { method, args: request.args, gas: gasFor(method, this.env, request.args) };
    const rpc = new Rpc(this.env.NEAR_RPC);
    this.inflight++;
    try {
      this.loadKey(pool, keyIndex);
      for (let attempt = 0; ; attempt++) {
        let sent: Dispatched;
        try {
          sent = await this.exclusive(() => this.dispatch(rpc, call, parts), parts);
        } catch (err) {
          // An RPC read failed (or, rarely, the reservation write did): either way nothing was sent.
          log({ event: 'relay_dispatch_failed', requestId, pool, keyIndex, method: call.method, code: 'near_unavailable' }, 'error');
          return { ok: false, status: 502, code: 'near_unavailable', error: `NEAR RPC failed: ${errorMessage(err)}` };
        }
        mark.dispatched = Date.now();
        log({ event: 'relay_dispatched', requestId, pool, keyIndex, method: call.method, nearTx: sent.hash, nonce: sent.nonce.toString(), attempt });

        let initial: SendTxResult | null = null;
        try {
          initial = await sent.response;
        } catch (err) {
          const bad = invalidNonce(err);
          if ((bad || isExpired(err)) && attempt === 0) {
            // Another writer used this key, or our view of the nonce/block was stale: re-read and retry once.
            await this.exclusive(() => this.recover(rpc, bad?.akNonce ?? null, !bad, parts), parts);
            log({ event: 'relay_retry', requestId, pool, keyIndex, method: call.method, code: bad ? 'invalid_nonce' : 'expired', nearTx: sent.hash }, 'warn');
            continue;
          }
          if (bad) return { ok: false, status: 503, code: 'relayer_busy', error: 'The relayer could not get a valid nonce, try again', nearTx: sent.hash };
          // Only a validation error is a definite "not accepted". Anything else (timeout, dropped connection, a
          // non-JSON 5xx from a proxy) may have been forwarded and may still execute: poll its hash.
          if (isDefiniteRejection(err)) return { ok: false, status: 502, code: 'near_rejected', error: `NEAR rejected the transaction: ${errorMessage(err)}`, nearTx: sent.hash };
        }

        const nonce = sent.nonce;
        const outcome = await waitForOutcome(rpc, sent.hash, this.env.RELAYER_ACCOUNT, initial, {
          // A later nonce of this key landed first: this tx can never be included (it was dropped from the pool).
          superseded: async () => BigInt((await rpc.viewAccessKey(this.env.RELAYER_ACCOUNT, this.publicKey)).nonce) >= nonce,
        });
        if (outcome.ok) return { ok: true, result: outcome.value, nearTx: sent.hash };
        if (outcome.kind === 'dropped') {
          if (attempt === 0) {
            // It never executed: resend once with a fresh nonce (re-read, since other txs moved the key on).
            await this.exclusive(() => this.recover(rpc, null, false, parts), parts);
            log({ event: 'relay_retry', requestId, pool, keyIndex, method: call.method, code: 'dropped', nearTx: sent.hash }, 'warn');
            continue;
          }
          return { ok: false, status: 503, code: 'relayer_busy', error: 'The transaction was dropped, try again', nearTx: sent.hash };
        }
        if (outcome.kind === 'failure') return { ok: false, status: 422, code: 'contract_rejected', error: outcome.error, nearTx: sent.hash };
        if (outcome.kind === 'timeout') return { ok: false, status: 504, code: 'timeout', error: outcome.error, nearTx: sent.hash };
        return { ok: false, status: 502, code: 'near_error', error: outcome.error, nearTx: sent.hash };
      }
    } catch (err) {
      return { ok: false, status: 503, code: 'relayer_unavailable', error: errorMessage(err) };
    } finally {
      this.inflight--;
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
    this.pool = pool;
    this.keyIndex = keyIndex;
  }

  /**
   * Critical section: next nonce, sign, reserve the nonce if it is above the reservation (see NONCE_RESERVATION),
   * start the broadcast. Does not wait for the broadcast to answer.
   */
  private async dispatch(rpc: Rpc, call: ContractCall, parts: DispatchTiming): Promise<Dispatched> {
    const keyPair = this.keyPair;
    if (!keyPair) throw new Error('Relayer key not loaded');
    let at = Date.now();
    if (this.nonce === null) await this.initNonce(rpc);
    if (!this.blockHash || Date.now() - this.blockHashAt > BLOCK_HASH_MAX_AGE_MS) await this.refreshBlockHash(rpc);
    at = addLap(parts, 'chainReadMs', at);
    const nonce = (this.nonce ?? 0n) + 1n;
    const signed = await signFunctionCall({
      keyPair,
      signerId: this.env.RELAYER_ACCOUNT,
      receiverId: this.env.SIGNER_ACCOUNT,
      nonce,
      blockHash: this.blockHash as string,
      call,
    });
    at = addLap(parts, 'signMs', at);
    // Confirmed before the tx leaves this object; if it throws, nothing is sent and the nonce is not used.
    if (nonce > this.reserved) await this.reserve(nonce);
    addLap(parts, 'persistMs', at);
    this.nonce = nonce;
    const response = rpc.sendTx(signed.bytes, RELAY_WAIT_UNTIL);
    // Handled by the caller; this keeps an early rejection from being reported as unhandled.
    response.catch(() => undefined);
    return { hash: signed.hash, nonce, response };
  }

  /**
   * Cold start: the larger of the stored reservation (txs up to it may have been sent and still be in the pool) and
   * the chain's nonce. Nothing is written: the first dispatch reserves. The reference block is a final one, read
   * alongside: the access key view answers at an optimistic block, which an RPC node that is a block behind rejects as
   * `Expired` (seen on testnet, costing a retry).
   */
  private async initNonce(rpc: Rpc): Promise<void> {
    const [ak, blockHash] = await Promise.all([rpc.viewAccessKey(this.env.RELAYER_ACCOUNT, this.publicKey), rpc.latestBlockHash()]);
    const kv = this.ctx.storage.kv;
    // A reservation stored for another key (the secret at this index was replaced) says nothing about this one.
    const stored = kv.get<string>('publicKey') === this.publicKey ? kv.get<string>('nonce') : undefined;
    this.reserved = stored ? BigInt(stored) : 0n;
    this.nonce = maxBig(BigInt(ak.nonce), this.reserved);
    this.blockHash = blockHash;
    this.blockHashAt = Date.now();
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
      const [ak, blockHash] = await Promise.all([rpc.viewAccessKey(this.env.RELAYER_ACCOUNT, this.publicKey), rpc.latestBlockHash()]);
      this.nonce = maxBig(this.nonce ?? 0n, BigInt(ak.nonce), akNonce ?? 0n);
      this.blockHash = blockHash;
      this.blockHashAt = Date.now();
    }
    addLap(parts, 'chainReadMs', at);
  }

  private async refreshBlockHash(rpc: Rpc): Promise<void> {
    this.blockHash = await rpc.latestBlockHash();
    this.blockHashAt = Date.now();
  }

  /** Stores a reservation covering `nonce` (above the current one) and waits until the write is confirmed. */
  private async reserve(nonce: bigint): Promise<void> {
    const reserved = nonce + BigInt(NONCE_RESERVATION) - 1n;
    this.ctx.storage.kv.put('publicKey', this.publicKey);
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
const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
