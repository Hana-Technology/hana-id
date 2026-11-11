// A fake NEAR RPC (and Google JWKS endpoint) behind a global fetch stub. The worker, its Durable Objects and the
// tests share one isolate, so stubbing globalThis.fetch intercepts every outbound call.
import { KeyPair } from '@near-js/crypto';
import { SignedTransaction, encodeTransaction } from '@near-js/transactions';
import { baseEncode } from '@near-js/utils';
import { env } from 'cloudflare:workers';
import { vi } from 'vitest';
import { base64Decode, base64Encode } from '../src/bytes.ts';
import { GOOGLE_JWKS_URL } from '../src/issuer-keys.ts';

export interface SentTx {
  hash: string;
  signerId: string;
  publicKey: string;
  receiverId: string;
  nonce: bigint;
  method: string;
  args: Record<string, unknown>;
  gas: bigint;
  /** Reference block hash the tx was signed against. */
  blockHash: string;
}

type Outcome = { SuccessValue: unknown } | { Failure: unknown };

/** A NEAR relay transaction (D734): the relay account's Delegate or activation Transfer to a user's implicit account. */
export interface SentNearTx {
  hash: string;
  signerId: string;
  publicKey: string;
  receiverId: string;
  nonce: bigint;
  kind: 'delegate' | 'transfer';
  /** How many actions the outer transaction carries (the relay's: exactly one). */
  actionCount: number;
  /** The delegate action as @near-js decodes it (delegate only). */
  delegate?: { senderId: string; receiverId: string; nonce: bigint; maxBlockHeight: bigint; methods: string[] };
  /** Transfer only: the amount, yocto. */
  amount?: bigint;
  blockHash: string;
}

/** What a NEAR relay transaction's outcome should say: a failure in the sender's receipt (the delegate itself) or in the receiver's call. */
export type NearOutcome = { ok: true } | { failIn: 'sender' | 'receiver'; failure: unknown };
type RpcReply = { result: unknown } | { error: unknown };

const rpcError = (name: string, info: unknown): { error: unknown } => ({
  error: { name: 'HANDLER_ERROR', cause: { name, info }, code: -32000, message: 'Server error', data: { TxExecutionError: { InvalidTxError: info } } },
});

export class NearMock {
  /** Chain view of each access key's nonce (public key → nonce). Accepted txs bump it, like inclusion would. */
  readonly akNonce = new Map<string, bigint>();
  readonly sent: SentTx[] = [];
  readonly viewCalls: { method: string; args: Record<string, unknown> }[] = [];
  readonly rpcMethods: string[] = [];
  readonly blockHash = baseEncode(new Uint8Array(32).fill(7));
  /** Hash of the latest final block (`block` with finality final); the access key view answers with `blockHash`. */
  finalBlockHash = this.blockHash;
  /** `wait_until` of every send_tx and tx call, in order. */
  readonly waitUntil: { method: 'send_tx' | 'tx'; waitUntil: unknown }[] = [];
  defaultNonce = 100n;
  /** `block` answers this height and gas price (yocto per gas). */
  height = 1000;
  gasPrice = '100000000';
  /** Accounts that don't exist (implicit ones until an activation Transfer reaches them). */
  readonly missingAccounts = new Set<string>();
  /** Accounts that exist without the key a view asks for. */
  readonly missingKeys = new Set<string>();
  /** `view_account` balances (yocto); others answer 5 NEAR. */
  readonly balances = new Map<string, string>();
  /** NEAR relay transactions, in order (Delegate and Transfer actions). */
  readonly nearSent: SentNearTx[] = [];
  /** The outcome of a NEAR relay transaction (default: success). */
  onNearTx?: (tx: SentNearTx) => NearOutcome | undefined;
  /**
   * Contract behaviour per method: return a value, or throw/return {Failure} for a panic (in the signer's receipt), or
   * return receiptFailure(...) for a failure in another account's receipt (the MPC) or in no receipt at all.
   */
  contract: Record<string, (args: Record<string, unknown>, tx: SentTx) => Outcome | unknown> = {};
  views: Record<string, (args: Record<string, unknown>) => unknown> = {};
  /** Optional hook before send_tx is processed: return a reply to override, or wait to delay. */
  onSendTx?: (tx: SentTx) => Promise<RpcReply | undefined> | RpcReply | undefined;
  /**
   * Optional hook for view calls: the answer is computed when the call arrives (the chain state then), then sent once
   * the hook settles, like a slow node.
   */
  onView?: (method: string, args: Record<string, unknown>) => Promise<void> | void;
  /** When true, send_tx answers TIMEOUT and the outcome is only available through `tx`. */
  sendTxTimesOut = false;
  /**
   * After send_tx was processed (the tx is included), answer like a broken proxy instead: an HTTP status with a
   * non-JSON body, or 'network' for a fetch that throws.
   */
  sendTxTransportError?: number | 'network';
  /** The next N `tx` polls get a non-JSON HTTP 503 (a flaky RPC proxy). */
  txPollFailures = 0;
  /**
   * Optional hook for access key views and block reads (to time the relayer's chain reads): the answer is computed when
   * the call arrives, then sent once the hook settles, like a slow node.
   */
  onRead?: () => Promise<void> | void;
  /** `view_access_key_list` of any account: `[{public_key, access_key: {nonce, permission}}]`. */
  accessKeyList: unknown[] = [];
  jwks: unknown = { keys: [] };
  /** When non-empty, each JWKS fetch takes the next answer from here (a status number answers that HTTP status) before falling back to `jwks`. */
  jwksSequence: unknown[] = [];
  jwksStatus = 200;
  /** Cache-Control of the JWKS response (Google sends `public, max-age=…`). */
  jwksCacheControl?: string;
  /** How many times the JWKS was fetched. */
  jwksFetches = 0;
  private readonly outcomes = new Map<string, unknown>();
  /** Which account sent each transaction (a `tx` status read must name it, as a node requires). */
  private readonly txSender = new Map<string, string>();
  /**
   * The account each relayer key belongs to (public key → account): the pools' keys on RELAYER_ACCOUNT, the NEAR relay's
   * on its account. A view or a transaction that names another account for one of them finds no key, as on chain.
   */
  readonly keyAccounts = new Map<string, string>();
  /** Awaited before a NEAR relay transaction is processed (to hold relays in flight). */
  onNearSend?: () => Promise<void>;
  /** When set, a NEAR relay transaction is refused with this InvalidTxError (e.g. NotEnoughBalance). */
  nearRejection?: unknown;
  private readonly pool = new Map<string, Set<bigint>>();

  install(): void {
    const own = (raw: string | undefined, account: string) => {
      for (const k of raw ? (JSON.parse(raw) as string[]) : []) this.keyAccounts.set(KeyPair.fromString(k as `ed25519:${string}`).getPublicKey().toString(), account);
    };
    for (const pool of [env.RELAYER_KEYS, env.OWNER_RELAYER_KEYS, env.HOME_RELAYER_KEYS]) own(pool, env.RELAYER_ACCOUNT);
    if (env.NEAR_RELAY) own(env.NEAR_RELAY_KEYS, (JSON.parse(env.NEAR_RELAY) as { account: string }).account);
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === GOOGLE_JWKS_URL) {
        this.jwksFetches++;
        const next = this.jwksSequence.length ? this.jwksSequence.shift() : undefined;
        if (typeof next === 'number') return Promise.resolve(new Response('unavailable', { status: next }));
        return Promise.resolve(Response.json(next ?? this.jwks, { status: this.jwksStatus, headers: this.jwksCacheControl ? { 'cache-control': this.jwksCacheControl } : {} }));
      }
      if (url.startsWith(env.NEAR_RPC) && typeof init?.body === 'string') {
        // Parsed synchronously so RPC calls are seen in exactly the order the worker sent them.
        const body = JSON.parse(init.body) as { id: string; method: string; params: Record<string, unknown> };
        if (body.method === 'tx' && this.txPollFailures > 0) {
          this.txPollFailures--;
          this.rpcMethods.push('tx');
          return Promise.resolve(new Response('<html>503 Service Unavailable</html>', { status: 503 }));
        }
        return this.handle(body.method, body.params).then((reply) => {
          const transport = body.method === 'send_tx' ? this.sendTxTransportError : undefined;
          if (transport === 'network') throw new TypeError('Network connection lost.');
          if (transport !== undefined) return new Response('<html>502 Bad Gateway</html>', { status: transport });
          return Response.json({ jsonrpc: '2.0', id: body.id, ...reply });
        });
      }
      return Promise.reject(new Error(`Unexpected fetch to ${url}`));
    });
  }

  nonceOf(publicKey: string): bigint {
    return this.akNonce.get(publicKey) ?? this.defaultNonce;
  }

  /** `reply` once onRead settles (answered as of the call's arrival, like a node that is slow to respond). */
  private afterRead(reply: RpcReply): Promise<RpcReply> {
    const hold = this.onRead?.();
    return hold ? hold.then(() => reply) : Promise.resolve(reply);
  }

  private handle(method: string, params: Record<string, unknown>): Promise<RpcReply> {
    this.rpcMethods.push(method);
    switch (method) {
      case 'query': {
        const reply = this.query(params);
        if (params.request_type === 'view_access_key') return this.afterRead(reply);
        const hold = params.request_type === 'call_function' ? this.onView?.(params.method_name as string, this.viewCalls.at(-1)!.args) : undefined;
        return hold ? hold.then(() => reply) : Promise.resolve(reply);
      }
      case 'block':
        return this.afterRead({ result: { header: { hash: params.finality === 'final' ? this.finalBlockHash : this.blockHash, height: this.height, gas_price: this.gasPrice } } });
      case 'send_tx':
        this.waitUntil.push({ method, waitUntil: params.wait_until });
        return this.sendTx(params);
      case 'tx': {
        this.waitUntil.push({ method, waitUntil: params.wait_until });
        const sender = this.txSender.get(params.tx_hash as string);
        const outcome = sender === undefined || sender === params.sender_account_id ? this.outcomes.get(params.tx_hash as string) : undefined;
        return Promise.resolve(outcome ? { result: outcome } : { error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_TRANSACTION' }, message: 'UNKNOWN_TRANSACTION' } });
      }
      default:
        return Promise.resolve({ error: { name: 'REQUEST_VALIDATION_ERROR', cause: { name: 'METHOD_NOT_FOUND' } } });
    }
  }

  private query(params: Record<string, unknown>): RpcReply {
    if (params.request_type === 'view_access_key') {
      // As a node answers a key it can't find (on a missing implicit account too): a result carrying `error` text.
      const id = params.account_id as string;
      const owner = this.keyAccounts.get(params.public_key as string);
      if (this.missingAccounts.has(id) || this.missingKeys.has(id) || (owner !== undefined && owner !== id)) return { result: { error: `access key ${params.public_key as string} does not exist while viewing`, logs: [], block_height: this.height, block_hash: this.blockHash } };
      return { result: { nonce: Number(this.nonceOf(params.public_key as string)), block_hash: this.blockHash, block_height: 1000, permission: 'FullAccess' } };
    }
    if (params.request_type === 'view_account') {
      const id = params.account_id as string;
      if (this.missingAccounts.has(id)) return { error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT', info: { requested_account_id: id } }, code: -32000, message: 'Server error', data: `account ${id} does not exist while viewing` } };
      return { result: { amount: this.balances.get(id) ?? '5000000000000000000000000', locked: '0', storage_usage: 182, block_height: this.height } };
    }
    if (params.request_type === 'view_access_key_list') return { result: { keys: this.accessKeyList, block_height: 1000 } };
    if (params.request_type === 'call_function') {
      const name = params.method_name as string;
      const args = JSON.parse(new TextDecoder().decode(base64Decode(params.args_base64 as string))) as Record<string, unknown>;
      this.viewCalls.push({ method: name, args });
      const view = this.views[name];
      if (!view) return { error: { name: 'HANDLER_ERROR', cause: { name: 'CONTRACT_EXECUTION_ERROR' }, data: `MethodNotFound ${name}` } };
      return { result: { result: [...new TextEncoder().encode(JSON.stringify(view(args) ?? null))], logs: [], block_height: 1000 } };
    }
    return { error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN' } } };
  }

  /**
   * Like a node: a tx is checked against the access key's nonce when it arrives (synchronously, in arrival order)
   * and against txs still in the pool; the access key nonce only moves when a tx is "included" (after the hook).
   */
  private async sendTx(params: Record<string, unknown>): Promise<RpcReply> {
    const signed = SignedTransaction.decode(base64Decode(params.signed_tx_base64 as string));
    const t = signed.transaction;
    const fc = t.actions[0]?.functionCall;
    if (!fc && (t.actions[0]?.signedDelegate || t.actions[0]?.transfer)) return this.sendNearTx(signed);
    if (!fc) return rpcError('INVALID_TRANSACTION', { ActionsValidation: 'no function call' });
    // Borsh decoding yields a plain `{ ed25519Key: { data } }`; render it like PublicKey.toString().
    const publicKey = `ed25519:${baseEncode(new Uint8Array((t.publicKey as unknown as { ed25519Key: { data: number[] } }).ed25519Key.data))}`;
    const nonce = BigInt(t.nonce);
    const keyOwner = this.keyAccounts.get(publicKey);
    if (keyOwner !== undefined && keyOwner !== t.signerId) return rpcError('INVALID_TRANSACTION', { InvalidAccessKeyError: { AccessKeyNotFound: { account_id: t.signerId, public_key: publicKey } } });
    const ak = this.nonceOf(publicKey);
    const pool = this.pool.get(publicKey) ?? new Set<bigint>();
    this.pool.set(publicKey, pool);
    if (nonce <= ak || pool.has(nonce)) return rpcError('INVALID_TRANSACTION', { InvalidNonce: { ak_nonce: Number(ak), tx_nonce: Number(nonce) } });
    pool.add(nonce);

    const hash = baseEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(encodeTransaction(t)))));
    const tx: SentTx = {
      hash,
      signerId: t.signerId,
      publicKey,
      receiverId: t.receiverId,
      nonce,
      method: fc.methodName,
      args: JSON.parse(new TextDecoder().decode(new Uint8Array(fc.args))) as Record<string, unknown>,
      gas: BigInt(fc.gas),
      blockHash: baseEncode(new Uint8Array(t.blockHash)),
    };
    let override: RpcReply | undefined;
    try {
      override = await this.onSendTx?.(tx);
    } finally {
      pool.delete(nonce);
    }
    if (override) return override;
    // Included: the chain's access key nonce moves up.
    if (nonce > this.nonceOf(publicKey)) this.akNonce.set(publicKey, nonce);
    this.sent.push(tx);

    const impl = this.contract[tx.method];
    let status: Record<string, unknown>;
    // Who ran the failing receipt: the signer's own (receiverId) unless the contract said otherwise; null for none.
    let failedIn: string | null = tx.receiverId;
    try {
      const value = impl ? impl(tx.args, tx) : null;
      if (value && typeof value === 'object' && 'Failure' in value) {
        status = { Failure: (value as { Failure: unknown }).Failure };
        if ('executor' in value) failedIn = (value as { executor: string | null }).executor;
      } else status = { SuccessValue: value === null || value === undefined ? '' : base64Encode(new TextEncoder().encode(JSON.stringify(value))) };
    } catch (err) {
      status = panic(err instanceof Error ? err.message : String(err));
    }
    const outcome = {
      status,
      transaction: { hash },
      transaction_outcome: { outcome: { ...MOCK_TX_GAS } },
      receipts_outcome: receiptsFor(tx.receiverId, status, failedIn),
      final_execution_status: 'EXECUTED',
    };
    this.outcomes.set(hash, outcome);
    this.txSender.set(hash, t.signerId);
    if (this.sendTxTimesOut) return { error: { name: 'HANDLER_ERROR', cause: { name: 'TIMEOUT_ERROR' }, message: 'Timeout', data: 'TIMEOUT' } };
    return { result: outcome };
  }

  /** A NEAR relay transaction: nonce checks as above, then an outcome shaped like a node's (the sender's receipt, the call's). */
  private async sendNearTx(signed: SignedTransaction): Promise<RpcReply> {
    const t = signed.transaction;
    const publicKey = `ed25519:${baseEncode(new Uint8Array((t.publicKey as unknown as { ed25519Key: { data: number[] } }).ed25519Key.data))}`;
    const nonce = BigInt(t.nonce);
    const keyOwner = this.keyAccounts.get(publicKey);
    if (keyOwner !== undefined && keyOwner !== t.signerId) return rpcError('INVALID_TRANSACTION', { InvalidAccessKeyError: { AccessKeyNotFound: { account_id: t.signerId, public_key: publicKey } } });
    const ak = this.nonceOf(publicKey);
    if (nonce <= ak) return rpcError('INVALID_TRANSACTION', { InvalidNonce: { ak_nonce: Number(ak), tx_nonce: Number(nonce) } });
    await this.onNearSend?.();
    if (this.nearRejection) return rpcError('INVALID_TRANSACTION', this.nearRejection);
    const hash = baseEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(encodeTransaction(t)))));
    const a = t.actions[0]!;
    const sd = a.signedDelegate as unknown as { delegateAction: { senderId: string; receiverId: string; nonce: bigint; maxBlockHeight: bigint; actions: { functionCall?: { methodName: string } }[] } } | undefined;
    const tx: SentNearTx = {
      hash,
      signerId: t.signerId,
      publicKey,
      receiverId: t.receiverId,
      nonce,
      kind: sd ? 'delegate' : 'transfer',
      actionCount: t.actions.length,
      ...(sd
        ? { delegate: { senderId: sd.delegateAction.senderId, receiverId: sd.delegateAction.receiverId, nonce: BigInt(sd.delegateAction.nonce), maxBlockHeight: BigInt(sd.delegateAction.maxBlockHeight), methods: sd.delegateAction.actions.map((x) => x.functionCall?.methodName ?? '?') } }
        : { amount: BigInt((a.transfer as unknown as { deposit: bigint }).deposit) }),
      blockHash: baseEncode(new Uint8Array(t.blockHash)),
    };
    this.akNonce.set(publicKey, nonce);
    this.nearSent.push(tx);
    const result = this.onNearTx?.(tx) ?? { ok: true };
    if (tx.kind === 'transfer' && 'ok' in result) this.missingAccounts.delete(tx.receiverId);
    const step = (executor: string, status: unknown) => ({ outcome: { executor_id: executor, logs: [], status, ...MOCK_RECEIPT_GAS } });
    const ok = { SuccessValue: '' };
    let receipts: unknown[];
    let status: unknown = ok;
    if ('ok' in result) receipts = tx.kind === 'delegate' ? [step(tx.receiverId, ok), step(tx.delegate!.receiverId, ok)] : [step(tx.receiverId, ok)];
    else if (result.failIn === 'sender') {
      status = { Failure: result.failure };
      receipts = [step(tx.receiverId, { Failure: result.failure })];
    } else receipts = [step(tx.receiverId, ok), step(tx.delegate?.receiverId ?? tx.receiverId, { Failure: result.failure })];
    const outcome = { status, transaction: { hash }, transaction_outcome: { outcome: { ...MOCK_TX_GAS } }, receipts_outcome: receipts, final_execution_status: 'EXECUTED' };
    this.outcomes.set(hash, outcome);
    this.txSender.set(hash, t.signerId);
    if (this.sendTxTimesOut) return { error: { name: 'HANDLER_ERROR', cause: { name: 'TIMEOUT_ERROR' }, message: 'Timeout', data: 'TIMEOUT' } };
    return { result: outcome };
  }
}

/** A contract panic as it appears in an outcome's Failure. */
export function panic(msg: string): { Failure: unknown } {
  return { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${msg}` } } } } };
}

/**
 * A failure in the receipt of `executor` (e.g. the MPC contract the signer called), or, with null, a transaction
 * that failed without any failed receipt (receipts_outcome empty).
 */
export function receiptFailure(executor: string | null, msg: string): { Failure: unknown; executor: string | null } {
  return { ...panic(msg), executor };
}

/**
 * receipts_outcome as NEAR reports it: the signer's receipt first; a failure elsewhere comes after the signer's receipt,
 * which then succeeded (it returned the promise that failed).
 */
/** What every mock transaction burns: its conversion step, and each receipt (usage events carry the BigInt sum). */
export const MOCK_TX_GAS = { gas_burnt: 2_427_922_607_472, tokens_burnt: '242792260747200000000' } as const;
export const MOCK_RECEIPT_GAS = { gas_burnt: 5_123_456_789_012, tokens_burnt: '512345678901200000000' } as const;

function receiptsFor(signer: string, status: Record<string, unknown>, failedIn: string | null): unknown[] {
  const outcome = (executor: string, s: unknown): unknown => ({ outcome: { executor_id: executor, logs: [], status: s, ...MOCK_RECEIPT_GAS } });
  if (!('Failure' in status)) return [outcome(signer, status)];
  if (failedIn === null) return [];
  if (failedIn === signer) return [outcome(signer, status)];
  return [outcome(signer, { SuccessReceiptId: 'receipt-1' }), outcome(failedIn, status)];
}

const b64url = (s: string): string => base64Encode(new TextEncoder().encode(s)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');

/** An unsigned-looking ID token (app endpoints only decode tokens; the contract verifies them). */
export function makeJwt(claims: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}.${b64url('signature-not-checked-by-api')}`;
}

export interface RsaSigner {
  /** JWKS entry for the mock's Google JWKS endpoint. */
  jwk: { kid: string; n: string; e: string; kty: 'RSA'; alg: 'RS256'; use: 'sig' };
  /** A real RS256 token over `claims`. */
  sign(claims: Record<string, unknown>, header?: Record<string, unknown>): Promise<string>;
}

/** A fresh RSA key and a signer for real RS256 ID tokens (owner actions verify signatures off-chain). */
export async function rsaSigner(kid = `kid-${Math.random().toString(36).slice(2, 8)}`): Promise<RsaSigner> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  return {
    jwk: { kid, n: pub.n!, e: pub.e!, kty: 'RSA', alg: 'RS256', use: 'sig' },
    async sign(claims, header = {}) {
      const input = `${b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT', ...header }))}.${b64url(JSON.stringify(claims))}`;
      const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(input)));
      return `${input}.${base64Encode(sig).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')}`;
    },
  };
}
