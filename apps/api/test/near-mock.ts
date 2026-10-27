// A fake NEAR RPC (and Google JWKS endpoint) behind a global fetch stub. The worker, its Durable Objects and the
// tests share one isolate, so stubbing globalThis.fetch intercepts every outbound call.
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
  /** Contract behaviour per method: return a value, or throw/return {Failure} for a panic. */
  contract: Record<string, (args: Record<string, unknown>, tx: SentTx) => Outcome | unknown> = {};
  views: Record<string, (args: Record<string, unknown>) => unknown> = {};
  /** Optional hook before send_tx is processed: return a reply to override, or wait to delay. */
  onSendTx?: (tx: SentTx) => Promise<RpcReply | undefined> | RpcReply | undefined;
  /** When true, send_tx answers TIMEOUT and the outcome is only available through `tx`. */
  sendTxTimesOut = false;
  /**
   * After send_tx was processed (the tx is included), answer like a broken proxy instead: an HTTP status with a
   * non-JSON body, or 'network' for a fetch that throws.
   */
  sendTxTransportError?: number | 'network';
  /** The next N `tx` polls get a non-JSON HTTP 503 (a flaky RPC proxy). */
  txPollFailures = 0;
  jwks: unknown = { keys: [] };
  jwksStatus = 200;
  /** Cache-Control of the JWKS response (Google sends `public, max-age=…`). */
  jwksCacheControl?: string;
  /** How many times the JWKS was fetched. */
  jwksFetches = 0;
  private readonly outcomes = new Map<string, unknown>();
  private readonly pool = new Map<string, Set<bigint>>();

  install(): void {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === GOOGLE_JWKS_URL) {
        this.jwksFetches++;
        return Promise.resolve(Response.json(this.jwks, { status: this.jwksStatus, headers: this.jwksCacheControl ? { 'cache-control': this.jwksCacheControl } : {} }));
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

  private handle(method: string, params: Record<string, unknown>): Promise<RpcReply> {
    this.rpcMethods.push(method);
    switch (method) {
      case 'query':
        return Promise.resolve(this.query(params));
      case 'block':
        return Promise.resolve({ result: { header: { hash: params.finality === 'final' ? this.finalBlockHash : this.blockHash, height: 1000 } } });
      case 'send_tx':
        this.waitUntil.push({ method, waitUntil: params.wait_until });
        return this.sendTx(params);
      case 'tx': {
        this.waitUntil.push({ method, waitUntil: params.wait_until });
        const outcome = this.outcomes.get(params.tx_hash as string);
        return Promise.resolve(outcome ? { result: outcome } : { error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_TRANSACTION' }, message: 'UNKNOWN_TRANSACTION' } });
      }
      default:
        return Promise.resolve({ error: { name: 'REQUEST_VALIDATION_ERROR', cause: { name: 'METHOD_NOT_FOUND' } } });
    }
  }

  private query(params: Record<string, unknown>): RpcReply {
    if (params.request_type === 'view_access_key') {
      return { result: { nonce: Number(this.nonceOf(params.public_key as string)), block_hash: this.blockHash, block_height: 1000, permission: 'FullAccess' } };
    }
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
    if (!fc) return rpcError('INVALID_TRANSACTION', { ActionsValidation: 'no function call' });
    // Borsh decoding yields a plain `{ ed25519Key: { data } }`; render it like PublicKey.toString().
    const publicKey = `ed25519:${baseEncode(new Uint8Array((t.publicKey as unknown as { ed25519Key: { data: number[] } }).ed25519Key.data))}`;
    const nonce = BigInt(t.nonce);
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
    try {
      const value = impl ? impl(tx.args, tx) : null;
      if (value && typeof value === 'object' && 'Failure' in value) status = { Failure: (value as { Failure: unknown }).Failure };
      else status = { SuccessValue: value === null || value === undefined ? '' : base64Encode(new TextEncoder().encode(JSON.stringify(value))) };
    } catch (err) {
      status = panic(err instanceof Error ? err.message : String(err));
    }
    const outcome = { status, transaction: { hash }, receipts_outcome: [], final_execution_status: 'EXECUTED' };
    this.outcomes.set(hash, outcome);
    if (this.sendTxTimesOut) return { error: { name: 'HANDLER_ERROR', cause: { name: 'TIMEOUT_ERROR' }, message: 'Timeout', data: 'TIMEOUT' } };
    return { result: outcome };
  }
}

/** A contract panic as it appears in an outcome's Failure. */
export function panic(msg: string): { Failure: unknown } {
  return { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${msg}` } } } } };
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
