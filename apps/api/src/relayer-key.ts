// One Durable Object per relayer access key (name from relayerKeyName(pool, index): `relayer-key-<i>` for the
// session pool, `owner-relayer-key-<i>` for the owner pool). It owns that key's nonce: nonces are handed out strictly
// in order inside a small critical section (nonce → sign → dispatch send_tx), and the outcome is awaited outside it,
// so many transactions per key can be in flight at once.
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

/** Time spent inside the object: getting a nonce and broadcasting (queue included), then waiting for the outcome. */
export interface RelayTiming {
  dispatchMs: number;
  outcomeMs: number;
}

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
  private nonce: bigint | null = null;
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
    const result = await this.relayTimed(pool, keyIndex, request, requestId, mark);
    const end = Date.now();
    return { ...result, timing: { dispatchMs: mark.dispatched - started, outcomeMs: end - mark.dispatched } };
  }

  /** `mark.dispatched` is set each time a transaction has been broadcast. */
  private async relayTimed(pool: Pool, keyIndex: number, request: ContractCall, requestId: string | undefined, mark: { dispatched: number }): Promise<RelayResult> {
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
          sent = await this.exclusive(() => this.dispatch(rpc, call));
        } catch (err) {
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
            await this.exclusive(() => this.recover(rpc, bad?.akNonce ?? null, !bad));
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
            await this.exclusive(() => this.recover(rpc, null, false));
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

  /** Runs `fn` after every earlier critical section has finished; never runs two at once. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
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

  /** Critical section: next nonce, sign, start the broadcast. Does not wait for the broadcast to answer. */
  private async dispatch(rpc: Rpc, call: ContractCall): Promise<Dispatched> {
    const keyPair = this.keyPair;
    if (!keyPair) throw new Error('Relayer key not loaded');
    if (this.nonce === null) await this.initNonce(rpc);
    if (!this.blockHash || Date.now() - this.blockHashAt > BLOCK_HASH_MAX_AGE_MS) await this.refreshBlockHash(rpc);
    const nonce = (this.nonce ?? 0n) + 1n;
    const signed = await signFunctionCall({
      keyPair,
      signerId: this.env.RELAYER_ACCOUNT,
      receiverId: this.env.SIGNER_ACCOUNT,
      nonce,
      blockHash: this.blockHash as string,
      call,
    });
    this.nonce = nonce;
    this.persist();
    const response = rpc.sendTx(signed.bytes, RELAY_WAIT_UNTIL);
    // Handled by the caller; this keeps an early rejection from being reported as unhandled.
    response.catch(() => undefined);
    return { hash: signed.hash, nonce, response };
  }

  /**
   * Cold start: the larger of the stored nonce (txs may still be in the pool) and the chain's. The reference block is
   * a final one, read alongside: the access key view answers at an optimistic block, which an RPC node that is a
   * block behind rejects as `Expired` (seen on testnet, costing a retry).
   */
  private async initNonce(rpc: Rpc): Promise<void> {
    const [ak, blockHash] = await Promise.all([rpc.viewAccessKey(this.env.RELAYER_ACCOUNT, this.publicKey), rpc.latestBlockHash()]);
    const kv = this.ctx.storage.kv;
    const stored = kv.get<string>('publicKey') === this.publicKey ? kv.get<string>('nonce') : undefined;
    this.nonce = maxBig(BigInt(ak.nonce), stored ? BigInt(stored) : 0n);
    this.blockHash = blockHash;
    this.blockHashAt = Date.now();
    this.persist();
  }

  /** After InvalidNonce (or an expired block hash): re-read the access key nonce and block hash from RPC. */
  private async recover(rpc: Rpc, akNonce: bigint | null, refreshBlockOnly: boolean): Promise<void> {
    if (refreshBlockOnly) {
      await this.refreshBlockHash(rpc);
      return;
    }
    const [ak, blockHash] = await Promise.all([rpc.viewAccessKey(this.env.RELAYER_ACCOUNT, this.publicKey), rpc.latestBlockHash()]);
    this.nonce = maxBig(this.nonce ?? 0n, BigInt(ak.nonce), akNonce ?? 0n);
    this.blockHash = blockHash;
    this.blockHashAt = Date.now();
    this.persist();
  }

  private async refreshBlockHash(rpc: Rpc): Promise<void> {
    this.blockHash = await rpc.latestBlockHash();
    this.blockHashAt = Date.now();
  }

  private persist(): void {
    if (this.nonce === null) return;
    this.ctx.storage.kv.put('publicKey', this.publicKey);
    this.ctx.storage.kv.put('nonce', this.nonce.toString());
  }
}

const maxBig = (...xs: bigint[]): bigint => xs.reduce((a, b) => (b > a ? b : a));
const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
