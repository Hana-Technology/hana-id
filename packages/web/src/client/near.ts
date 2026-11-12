// `hana.near`, the NEAR signer (D720–D729): the user's implicit account, transactions, NEP-366 delegate actions and
// NEP-413 messages, each behind Hana's approval window (none is ever signed automatically), and the gasless relay.
//
// - accountId / publicKey: the implicit account id (64 hex) and its `ed25519:` key, or null while logged out (or with
//   a vault that predates NEAR).
// - signTransaction({ network, transaction }): a borsh Transaction (bytes or base64) from accountId with publicKey; the
//   vault checks both, a test app signs for 'testnet' only, and its block hash must be a testnet block.
// - signDelegateAction({ network, delegateAction }): a borsh DelegateAction, with or without NEP-461's prefix (what
//   @near-js/transactions' encodeDelegateAction returns); the prefix is taken off before it goes to the vault.
// - signMessage({ message, recipient, nonce, callbackUrl? }): NEP-413 (the nonce: 32 bytes, or their base64).
// - relay({ network, signedDelegateAction }): POST {apiUrl}/v1/near/relay; Hana's relayer pays the gas.
// - activate(): POST {apiUrl}/v1/near/activate for the user's own account, which makes sure it exists on testnet (a new
//   implicit account exists only after a first transfer; a test app's delegate action needs it, near_key_unknown).
//
// Each sign method sends its request synchronously in the call, so a call from a click opens the approval popup in
// that click (client.ts, D99). Inputs are checked here only for shape; the vault decides.
import { type NearNetwork, NEP366_SIGNING_PREFIX, type PortMethod, type PortParamsMap, type PortResultMap, base64Decode, base64Encode, isNearNetwork, nearImplicitPublicKey, nearPublicKeyString } from '@hana-id/core';
import { HanaError, RpcCode, hanaError } from './errors.ts';
import type { FetchLike } from './rpc.ts';

export interface NearHost {
  /** The vault's NEAR account (the session's), or null. */
  nearAccountId(): string | null;
  request<M extends PortMethod>(method: M, params?: PortParamsMap[M]): Promise<PortResultMap[M]>;
  /** The Hana API of this env (`apiUrl`), for the relay; null when the build doesn't know it. */
  apiUrl: string | null;
  publishableKey: string;
  fetch: FetchLike;
}

/** Bytes, or their standard base64 (as near-api-js and NEAR RPCs print them). */
export type NearBytes = Uint8Array | string;

export interface NearSignTransactionParams {
  network: NearNetwork;
  /** borsh `Transaction` (e.g. `encodeTransaction(tx)` of @near-js/transactions), or its base64. */
  transaction: NearBytes;
}

export interface NearSignDelegateActionParams {
  network: NearNetwork;
  /** borsh `DelegateAction`, with or without NEP-461's prefix, or its base64. */
  delegateAction: NearBytes;
}

export interface NearSignMessageParams {
  message: string;
  /** Who the signature is for (NEP-413): the app's name or domain, shown prominently in Hana's window. */
  recipient: string;
  /** 32 random bytes (or their base64), new for every sign-in; the verifier must check it. */
  nonce: NearBytes;
  callbackUrl?: string;
}

export interface NearRelayParams {
  network: 'testnet';
  /** borsh `SignedDelegateAction` (signDelegateAction's `signedDelegateAction`), or its bytes. */
  signedDelegateAction: NearBytes;
}

export interface NearRelayResult {
  /** base58 hash of the relayer's transaction. */
  transactionHash: string;
  /** The relayer's status for it, as the API reports it (e.g. a NEAR final execution status). */
  status: string;
}

export interface NearActivateResult {
  /** true when Hana's relayer created the account now; false when it already existed. */
  created: boolean;
  /** The user's account (the session's). */
  accountId: string;
  /**
   * The access key's nonce as the relayer read it (decimal u64), or null when the account exists without the user's key.
   * With `blockHeight`, what `nearDelegateNonce({ keyNonce, blockHeight })` takes; absent from a relayer that doesn't say.
   */
  accessKeyNonce?: string | null;
  /** The final height the relayer read it at. */
  blockHeight?: number;
  /** base58 hash of the transfer that created the account, when `created`. */
  transactionHash?: string;
}

export type NearSignTransactionResult = PortResultMap['near_signTransaction'];
export type NearSignMessageResult = PortResultMap['near_signMessage'];
export type NearSignDelegateActionResult = PortResultMap['near_signDelegateAction'];

/** The relay can take a while (the relayer waits for the transaction); give up after this long. */
export const NEAR_RELAY_TIMEOUT_MS = 60_000;

const invalid = (message: string): HanaError => new HanaError(RpcCode.invalidParams, message);

function toBase64(v: NearBytes, what: string): string {
  if (v instanceof Uint8Array) return base64Encode(v);
  if (typeof v !== 'string') throw invalid(`${what} must be bytes or a base64 string`);
  try {
    base64Decode(v);
  } catch {
    throw invalid(`${what} must be bytes or a base64 string`);
  }
  return v;
}

function toBytes(v: NearBytes, what: string): Uint8Array {
  return base64Decode(toBase64(v, what));
}

function checkNetwork(network: unknown): NearNetwork {
  if (!isNearNetwork(network)) throw invalid("network must be 'testnet' or 'mainnet'");
  return network;
}

/** Takes NEP-461's 4-byte prefix off a delegate action, which can't start with it otherwise (an account id length). */
export function stripDelegatePrefix(bytes: Uint8Array): Uint8Array {
  if (bytes.length >= 4 && new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true) === NEP366_SIGNING_PREFIX) return bytes.slice(4);
  return bytes;
}

const isBase58Hash = (v: unknown): v is string => typeof v === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u.test(v);

export class HanaNear {
  readonly #host: NearHost;

  constructor(host: NearHost) {
    this.#host = host;
  }

  /** The user's NEAR implicit account id (64 lowercase hex), or null. */
  get accountId(): string | null {
    return this.#host.nearAccountId();
  }

  /** The account's key, `ed25519:<base58>`, or null. */
  get publicKey(): string | null {
    const id = this.accountId;
    return id === null ? null : nearPublicKeyString(nearImplicitPublicKey(id));
  }

  /** Signs a NEAR transaction after the user approves it in Hana's window. */
  async signTransaction(p: NearSignTransactionParams): Promise<NearSignTransactionResult> {
    this.#ready();
    if (typeof p !== 'object' || p === null) throw invalid('signTransaction takes { network, transaction }');
    return this.#host.request('near_signTransaction', { network: checkNetwork(p.network), transaction: toBase64(p.transaction, 'transaction') });
  }

  /** Signs a NEP-366 delegate action (a gasless meta transaction) after the user approves it. */
  async signDelegateAction(p: NearSignDelegateActionParams): Promise<NearSignDelegateActionResult> {
    this.#ready();
    if (typeof p !== 'object' || p === null) throw invalid('signDelegateAction takes { network, delegateAction }');
    const network = checkNetwork(p.network);
    return this.#host.request('near_signDelegateAction', { network, delegateAction: base64Encode(stripDelegatePrefix(toBytes(p.delegateAction, 'delegateAction'))) });
  }

  /** NEP-413: signs `message` for `recipient` with `nonce` after the user approves it. */
  async signMessage(p: NearSignMessageParams): Promise<NearSignMessageResult> {
    this.#ready();
    if (typeof p !== 'object' || p === null) throw invalid('signMessage takes { message, recipient, nonce, callbackUrl? }');
    if (typeof p.message !== 'string' || typeof p.recipient !== 'string' || (p.callbackUrl !== undefined && typeof p.callbackUrl !== 'string')) throw invalid('message, recipient and callbackUrl must be strings');
    const nonce = toBytes(p.nonce, 'nonce');
    if (nonce.length !== 32) throw invalid('nonce must be 32 bytes');
    return this.#host.request('near_signMessage', { message: p.message, recipient: p.recipient, nonce: base64Encode(nonce), ...(p.callbackUrl !== undefined ? { callbackUrl: p.callbackUrl } : {}) });
  }

  /**
   * Sends a signed delegate action through Hana's relayer (POST /v1/near/relay), which pays the gas. The API checks
   * this app's publishable key and this page's origin, as for every /v1 call from a partner page.
   */
  async relay(p: NearRelayParams): Promise<NearRelayResult> {
    if (typeof p !== 'object' || p === null || p.network !== 'testnet') throw invalid("relay takes { network: 'testnet', signedDelegateAction }");
    const signedDelegateAction = toBase64(p.signedDelegateAction, 'signedDelegateAction');
    const b = await this.#post('relay', { network: 'testnet', signedDelegateAction });
    if (!isBase58Hash(b.transactionHash) || typeof b.status !== 'string' || b.status.length === 0 || b.status.length > 64) throw hanaError('api_unavailable', 'Journear’s relayer gave an answer the SDK can’t read');
    return { transactionHash: b.transactionHash, status: b.status };
  }

  /**
   * Makes sure the user's implicit account exists on NEAR testnet (POST /v1/near/activate, the same gate as `relay`):
   * Hana's relayer creates it (a zero-value transfer) when it doesn't. A test app's delegate action can't be signed
   * before that (4100 `near_key_unknown`). Resolves `{ created }`; calling it for an account that exists is harmless.
   */
  async activate(): Promise<NearActivateResult> {
    const accountId = this.#host.nearAccountId();
    if (accountId === null) throw hanaError(4100, 'Not logged in, or this Journear Passport vault has no NEAR account yet');
    const b = await this.#post('activate', { accountId });
    if (typeof b.created !== 'boolean' || (b.accountId !== undefined && b.accountId !== accountId)) throw hanaError('api_unavailable', 'Journear’s relayer gave an answer the SDK can’t read');
    // The optional fields only in their exact shapes (anything else is left out, not trusted).
    const nonce = b.accessKeyNonce === null || (typeof b.accessKeyNonce === 'string' && /^(?:0|[1-9]\d{0,19})$/u.test(b.accessKeyNonce)) ? b.accessKeyNonce : undefined;
    return {
      created: b.created,
      accountId,
      ...(nonce !== undefined ? { accessKeyNonce: nonce } : {}),
      ...(Number.isSafeInteger(b.blockHeight) && (b.blockHeight as number) > 0 ? { blockHeight: b.blockHeight as number } : {}),
      ...(isBase58Hash(b.transactionHash) ? { transactionHash: b.transactionHash } : {}),
    };
  }

  /** POST {apiUrl}/v1/near/{path} with the publishable key: the answer's JSON object, or the HanaError of a refusal. */
  async #post(path: 'relay' | 'activate', payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const apiUrl = this.#host.apiUrl;
    if (!apiUrl) throw hanaError('api_unavailable', 'This build of the Journear Passport SDK has no API URL for its environment');
    // One deadline for the whole exchange: the abort stays armed until the body has been read, so a server that sends
    // its headers and then stalls can't hold the call open.
    const ctl = new AbortController();
    const timer = globalThis.setTimeout(() => ctl.abort(), NEAR_RELAY_TIMEOUT_MS);
    let res: Response;
    let body: unknown = null;
    try {
      try {
        res = await this.#host.fetch(`${apiUrl}/v1/near/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-hana-key': this.#host.publishableKey },
          body: JSON.stringify(payload),
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          signal: ctl.signal,
        });
      } catch {
        throw hanaError('api_unavailable', 'Journear’s relayer could not be reached');
      }
      try {
        body = await res.json();
      } catch {
        if (ctl.signal.aborted) throw hanaError('api_unavailable', 'Journear’s relayer did not answer in time');
        body = null;
      }
    } finally {
      globalThis.clearTimeout(timer);
    }
    const b = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    if (!res.ok) throw relayError(res.status, b);
    return b;
  }

  /** NEAR requests need a vault that reported a NEAR account: an older vault would drop them unanswered. */
  #ready(): void {
    if (this.#host.nearAccountId() === null) throw hanaError(4100, 'Not logged in, or this Journear Passport vault has no NEAR account yet');
  }
}

/** The HanaError of a refused relay or activation: the API's code where the SDK knows it, with its request id. */
function relayError(status: number, b: Record<string, unknown>): HanaError {
  const code = typeof b.code === 'string' ? b.code : '';
  const message = typeof b.error === 'string' ? b.error.slice(0, 300) : `Journear’s relayer refused the request (HTTP ${status})`;
  const data = {
    status,
    ...(code ? { reason: code.slice(0, 64) } : {}),
    ...(typeof b.requestId === 'string' ? { requestId: b.requestId.slice(0, 64) } : {}),
    // A nonce refusal (`delegate_nonce_used`, `delegate_nonce_too_large`) says the nonce the relayer holds the key at, so
    // the next delegate action can be built above it; `retryable` marks an answer worth asking again (the API's own word).
    ...(typeof b.accessKeyNonce === 'string' && /^(?:0|[1-9]\d{0,19})$/u.test(b.accessKeyNonce) ? { accessKeyNonce: b.accessKeyNonce } : {}),
    ...(b.retryable === true ? { retryable: true } : {}),
  };
  if (status === 429) return hanaError('rate_limited', message, data);
  if (code === 'origin_not_allowed' || code === 'app_suspended') return hanaError(code, message, data);
  if (status >= 400 && status < 500) return hanaError(4100, message, data);
  return hanaError('api_unavailable', message, data);
}
