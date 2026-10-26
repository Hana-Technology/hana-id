// One Durable Object per relayer access key (name `relayer-key-<index>`). It owns that key's nonce: nonces are
// handed out strictly in order inside a small critical section (nonce → sign → dispatch send_tx), and the outcome
// is awaited outside it, so many transactions per key can be in flight at once.
import type { KeyPair } from '@near-js/crypto';
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env.ts';
import { log } from './log.ts';
import { parseRelayerKeys } from './relayer-config.ts';
import { Rpc, invalidNonce, isDefiniteRejection, isExpired, type SendTxResult } from './near/rpc.ts';
import { type ContractCall, parseKeyPair, signFunctionCall, waitForOutcome } from './near/tx.ts';

export { parseRelayerKeys };

/** The only methods the relayer will ever call, always on SIGNER_ACCOUNT. */
export const RELAYABLE_METHODS = new Set([
  'create_session',
  'derive_key',
  'revoke_session',
  'propose_change',
  'cancel_change',
  'remove_client',
  'execute_change',
]);

/** Refresh the reference block hash after this long (a tx is valid for ~24 h of blocks). */
const BLOCK_HASH_MAX_AGE_MS = 5 * 60_000;

export type RelayResult =
  | { ok: true; result: unknown; nearTx: string }
  | { ok: false; status: number; code: string; error: string; nearTx?: string };

interface Dispatched {
  hash: string;
  nonce: bigint;
  /** The send_tx response; awaited outside the critical section. */
  response: Promise<SendTxResult>;
}

export class RelayerKey extends DurableObject<Env> {
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

  async relay(keyIndex: number, call: ContractCall, requestId?: string): Promise<RelayResult> {
    if (!RELAYABLE_METHODS.has(call.method)) return { ok: false, status: 400, code: 'method_not_allowed', error: `Method ${call.method} is not relayed` };
    const rpc = new Rpc(this.env.NEAR_RPC);
    this.inflight++;
    try {
      this.loadKey(keyIndex);
      for (let attempt = 0; ; attempt++) {
        let sent: Dispatched;
        try {
          sent = await this.exclusive(() => this.dispatch(rpc, call));
        } catch (err) {
          log({ event: 'relay_dispatch_failed', requestId, keyIndex, method: call.method, code: 'near_unavailable' }, 'error');
          return { ok: false, status: 502, code: 'near_unavailable', error: `NEAR RPC failed: ${errorMessage(err)}` };
        }
        log({ event: 'relay_dispatched', requestId, keyIndex, method: call.method, nearTx: sent.hash, nonce: sent.nonce.toString(), attempt });

        let initial: SendTxResult | null = null;
        try {
          initial = await sent.response;
        } catch (err) {
          const bad = invalidNonce(err);
          if ((bad || isExpired(err)) && attempt === 0) {
            // Another writer used this key, or our view of the nonce/block was stale: re-read and retry once.
            await this.exclusive(() => this.recover(rpc, bad?.akNonce ?? null, !bad));
            log({ event: 'relay_retry', requestId, keyIndex, method: call.method, code: bad ? 'invalid_nonce' : 'expired', nearTx: sent.hash }, 'warn');
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
            log({ event: 'relay_retry', requestId, keyIndex, method: call.method, code: 'dropped', nearTx: sent.hash }, 'warn');
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

  private loadKey(keyIndex: number): void {
    if (this.keyPair) return;
    const secret = parseRelayerKeys(this.env.RELAYER_KEYS)[keyIndex];
    if (!secret) throw new Error(`No relayer key at index ${keyIndex}`);
    this.keyPair = parseKeyPair(secret);
    this.publicKey = this.keyPair.getPublicKey().toString();
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
    const response = rpc.sendTx(signed.bytes, 'EXECUTED');
    // Handled by the caller; this keeps an early rejection from being reported as unhandled.
    response.catch(() => undefined);
    return { hash: signed.hash, nonce, response };
  }

  /** Cold start: the larger of the stored nonce (txs may still be in the pool) and the chain's. */
  private async initNonce(rpc: Rpc): Promise<void> {
    const ak = await rpc.viewAccessKey(this.env.RELAYER_ACCOUNT, this.publicKey);
    const kv = this.ctx.storage.kv;
    const stored = kv.get<string>('publicKey') === this.publicKey ? kv.get<string>('nonce') : undefined;
    this.nonce = maxBig(BigInt(ak.nonce), stored ? BigInt(stored) : 0n);
    this.blockHash = ak.block_hash;
    this.blockHashAt = Date.now();
    this.persist();
  }

  /** After InvalidNonce (or an expired block hash): re-read the access key nonce and block hash from RPC. */
  private async recover(rpc: Rpc, akNonce: bigint | null, refreshBlockOnly: boolean): Promise<void> {
    if (refreshBlockOnly) {
      await this.refreshBlockHash(rpc);
      return;
    }
    const ak = await rpc.viewAccessKey(this.env.RELAYER_ACCOUNT, this.publicKey);
    this.nonce = maxBig(this.nonce ?? 0n, BigInt(ak.nonce), akNonce ?? 0n);
    this.blockHash = ak.block_hash;
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
