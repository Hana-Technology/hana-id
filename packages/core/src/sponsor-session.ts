// The session binding of the EVM gas sponsorship calls (docs/decisions.md D856, docs/api.md "EVM gas sponsorship"):
// `POST /v1/evm/sponsor/prepare` and `POST /v1/evm/sponsor/send` prove they come from the user's signed-in Journear
// Passport session the way the vault's other authenticated calls do (POST /v1/identity/token, POST
// /v1/mainnet-demo/events): an Ed25519 signature by the session key over core's identityMessage, whose payload here binds
// the route, the partner origin, the chain, the account, a hash of the request body and the session's wallet proof of
// that account. The API also checks the proof's time, its single-use marker and the session on chain
// (checkChainSession); those need its own state, so they are its part (D856 lists the order).
//
//   payload = "evm-sponsor-request" ‖ borsh(method) ‖ borsh(parent_origin) ‖ u64le(chain_id) ‖ borsh(account)
//             ‖ request_hash(32) ‖ borsh(wallet_proof.address) ‖ borsh(Vec<u8> wallet_proof.signature)
//   request_hash = sha256("hana-id/evm-sponsor-request/v1" ‖ 0x00 ‖ utf8(JSON.stringify(canonical)))
//   canonical (prepare) = ["prepare", chainId, account, [[to, value, data], …]]
//   canonical (send)    = ["send", chainId, account, [[to, value, data], …], executeNonce, deadline, relayer, minGas,
//                          signature, authorization ? [chainId, address, nonce, yParity, r, s] : null]
//
// Every value is the body's own, as sent (strings stay strings, numbers numbers, no case change), so the API hashes
// exactly what it parsed. The message's prefix (identityMessage's "hana-id-identity-v1:") and the payload's label keep
// the signature from serving any other purpose: a mint's, a consent's or a demo event's payload starts with its own label.
//
// SECURITY: nothing here holds or logs a key; the wallet proof and the signatures are public to the API.
import { ed25519 } from '@noble/curves/ed25519';
import { canonicalWalletAddress, IDENTITY_NONCE_BYTES, IDENTITY_PROOF_WINDOW_MS, identityMessage, verifyWalletProof } from './identity.ts';
import { type Bytes, borshString, concatBytes, sha256, toBytes, u32le, u64le, utf8 } from './bytes.ts';

export const EVM_SPONSOR_REQUEST_PAYLOAD = 'evm-sponsor-request';
export const EVM_SPONSOR_REQUEST_HASH_DOMAIN = 'hana-id/evm-sponsor-request/v1';
export const EVM_SPONSOR_REQUEST_METHODS = ['prepare', 'send'] as const;
export type EvmSponsorRequestMethod = (typeof EVM_SPONSOR_REQUEST_METHODS)[number];

/** The body key that carries the proof; every other key of the body is hashed. */
export const EVM_SPONSOR_PROOF_KEY = 'sessionProof';

/** `sessionProof` in a prepare or send body: bytes as JSON number arrays, as the vault's other proofs are sent. */
export interface EvmSponsorSessionProof {
  /** The session's raw 32-byte Ed25519 public key. */
  sessionPublicKey: number[];
  /** The vault's server-corrected clock, ms. The API accepts IDENTITY_PROOF_WINDOW_MS either side of its own. */
  issuedAtMs: number;
  /** 16 random bytes, new for every request (the API's single-use marker). */
  nonce: number[];
  /** 64-byte Ed25519 signature by the session key over evmSponsorSessionMessage. */
  signature: number[];
  /** The session's wallet proof of the account (identity.ts walletProofMessage, the EVM key's 65-byte r‖s‖v). */
  walletProof: { address: string; signature: number[] };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isByteList = (v: unknown, len: number): v is number[] => Array.isArray(v) && v.length === len && v.every((b) => Number.isInteger(b) && b >= 0 && b <= 255);
const own = (o: Record<string, unknown>, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined);

/** True for a `sessionProof` of exactly the shape above (extra keys refused). */
export function isEvmSponsorSessionProof(v: unknown): v is EvmSponsorSessionProof {
  if (!isObj(v)) return false;
  const keys = Object.keys(v);
  if (keys.length !== 5 || !['sessionPublicKey', 'issuedAtMs', 'nonce', 'signature', 'walletProof'].every((k) => keys.includes(k))) return false;
  const w = v.walletProof;
  return (
    isByteList(v.sessionPublicKey, 32) &&
    Number.isSafeInteger(v.issuedAtMs) &&
    (v.issuedAtMs as number) > 0 &&
    isByteList(v.nonce, IDENTITY_NONCE_BYTES) &&
    isByteList(v.signature, 64) &&
    isObj(w) &&
    Object.keys(w).length === 2 &&
    typeof w.address === 'string' &&
    w.address.length === 42 &&
    isByteList(w.signature, 65)
  );
}

const PREPARE_KEYS = ['chainId', 'account', 'calls'] as const;
const SEND_KEYS = [...PREPARE_KEYS, 'executeNonce', 'deadline', 'relayer', 'minGas', 'signature'] as const;
const AUTHORIZATION_KEYS = ['chainId', 'address', 'nonce', 'yParity', 'r', 's'] as const;

function str(v: unknown, what: string): string {
  if (typeof v !== 'string') throw new TypeError(`${what} must be a string`);
  return v;
}

function num(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`${what} must be a number`);
  return v;
}

function exact(o: Record<string, unknown>, required: readonly string[], optional: readonly string[], what: string): void {
  for (const k of Object.keys(o)) if (!required.includes(k) && !optional.includes(k)) throw new TypeError(`${what} has an unknown field`);
  for (const k of required) if (!Object.hasOwn(o, k)) throw new TypeError(`${what} lacks ${k}`);
}

/**
 * The 32-byte hash of a prepare or send body (without its `sessionProof`), over the body's own values in a fixed order
 * (see the module comment). Throws TypeError for a body of another shape: an unknown or missing field, a value of the
 * wrong JSON type, more than 8 calls (the API refuses those bodies anyway).
 */
export function evmSponsorRequestHash(method: EvmSponsorRequestMethod, body: Record<string, unknown>): Bytes {
  if (!(EVM_SPONSOR_REQUEST_METHODS as readonly string[]).includes(method)) throw new TypeError('Unknown sponsor request method');
  if (!isObj(body)) throw new TypeError('body must be an object');
  exact(body, method === 'prepare' ? PREPARE_KEYS : SEND_KEYS, method === 'send' ? ['authorization'] : [], 'body');
  const calls = own(body, 'calls');
  if (!Array.isArray(calls) || calls.length === 0 || calls.length > 8) throw new TypeError('calls must hold 1 to 8 calls');
  const canonical: unknown[] = [
    method,
    num(own(body, 'chainId'), 'chainId'),
    str(own(body, 'account'), 'account'),
    calls.map((c: unknown, i) => {
      if (!isObj(c)) throw new TypeError(`calls[${i}] must be an object`);
      exact(c, ['to', 'value', 'data'], [], `calls[${i}]`);
      return [str(c.to, 'to'), str(c.value, 'value'), str(c.data, 'data')];
    }),
  ];
  if (method === 'send') {
    canonical.push(str(own(body, 'executeNonce'), 'executeNonce'), str(own(body, 'deadline'), 'deadline'), str(own(body, 'relayer'), 'relayer'), str(own(body, 'minGas'), 'minGas'), str(own(body, 'signature'), 'signature'));
    const a = own(body, 'authorization');
    if (a === undefined) canonical.push(null);
    else {
      if (!isObj(a)) throw new TypeError('authorization must be an object');
      exact(a, AUTHORIZATION_KEYS, [], 'authorization');
      canonical.push([num(a.chainId, 'chainId'), str(a.address, 'address'), str(a.nonce, 'nonce'), num(a.yParity, 'yParity'), str(a.r, 'r'), str(a.s, 's')]);
    }
  }
  return sha256(concatBytes(utf8(EVM_SPONSOR_REQUEST_HASH_DOMAIN), Uint8Array.of(0), utf8(JSON.stringify(canonical))));
}

export interface EvmSponsorRequestPayloadInput {
  method: EvmSponsorRequestMethod;
  /** The partner origin the vault acts for (its pinned parent; the API's `x-hana-parent-origin` in force). */
  parentOrigin: string;
  chainId: number;
  /** The body's `account`, as sent. */
  account: string;
  /** evmSponsorRequestHash of the body. */
  requestHash: Uint8Array;
  walletProof: { address: string; signature: Uint8Array };
}

/** The identityMessage payload of a sponsor request (see the module comment). */
export function evmSponsorRequestPayload(i: EvmSponsorRequestPayloadInput): Bytes {
  if (!(EVM_SPONSOR_REQUEST_METHODS as readonly string[]).includes(i.method)) throw new TypeError('Unknown sponsor request method');
  if (!Number.isSafeInteger(i.chainId) || i.chainId <= 0) throw new TypeError('chainId must be a positive safe integer');
  if (i.requestHash.length !== 32) throw new TypeError('requestHash must be 32 bytes');
  return concatBytes(
    utf8(EVM_SPONSOR_REQUEST_PAYLOAD),
    borshString(i.method),
    borshString(i.parentOrigin),
    u64le(i.chainId),
    borshString(i.account),
    toBytes(i.requestHash),
    borshString(i.walletProof.address),
    u32le(i.walletProof.signature.length),
    toBytes(i.walletProof.signature),
  );
}

export interface EvmSponsorSessionContext {
  /** The pinned SIGNER (hana-signer account). */
  signer: string;
  /** The D1 `apps.id`. */
  appId: string;
  parentOrigin: string;
}

/** The bytes the session key signs for a sponsor request: identityMessage with evmSponsorRequestPayload. */
export function evmSponsorSessionMessage(
  ctx: EvmSponsorSessionContext,
  i: { method: EvmSponsorRequestMethod; body: Record<string, unknown>; sessionPublicKey: Uint8Array; issuedAtMs: number; nonce: Uint8Array; walletProof: { address: string; signature: Uint8Array } },
): Bytes {
  const chainId = num(own(i.body, 'chainId'), 'chainId');
  const account = str(own(i.body, 'account'), 'account');
  const payload = evmSponsorRequestPayload({ method: i.method, parentOrigin: ctx.parentOrigin, chainId, account, requestHash: evmSponsorRequestHash(i.method, i.body), walletProof: i.walletProof });
  return identityMessage({ signer: ctx.signer, appId: ctx.appId, sessionPublicKey: i.sessionPublicKey, issuedAtMs: i.issuedAtMs, nonce: i.nonce, payload });
}

/** Why a sponsor request's session proof was refused (each a distinct API code, docs/api.md). */
export type EvmSponsorProofRefusal = 'missing_session_proof' | 'bad_session_proof' | 'stale_session_proof' | 'invalid_session_signature' | 'bad_wallet_proof';

export type EvmSponsorProofCheck =
  | { ok: true; sessionPublicKey: Uint8Array; nonce: Uint8Array; issuedAtMs: number; account: string }
  | { ok: false; reason: EvmSponsorProofRefusal };

/**
 * The stateless part of the API's check of a sponsor request (D856 steps 1 to 4): the proof's shape, its time
 * (IDENTITY_PROOF_WINDOW_MS of `nowMs`), the session key's signature over this route, origin, app and body, and the wallet
 * proof naming the body's account (EIP-55 compared) for this session. `body` is the whole parsed request body, with its
 * `sessionProof`. On success the API still has to apply the single-use marker (`identity-proof:<session key>` and the
 * nonce) and check the session on chain, then the directory rule (D856).
 */
export function checkEvmSponsorSessionProof(i: { method: EvmSponsorRequestMethod; body: Record<string, unknown>; ctx: EvmSponsorSessionContext; nowMs: number }): EvmSponsorProofCheck {
  if (!isObj(i.body) || !Object.hasOwn(i.body, EVM_SPONSOR_PROOF_KEY)) return { ok: false, reason: 'missing_session_proof' };
  const { [EVM_SPONSOR_PROOF_KEY]: proof, ...rest } = i.body;
  if (!isEvmSponsorSessionProof(proof)) return { ok: false, reason: 'bad_session_proof' };
  if (Math.abs(i.nowMs - proof.issuedAtMs) > IDENTITY_PROOF_WINDOW_MS) return { ok: false, reason: 'stale_session_proof' };
  const sessionPublicKey = Uint8Array.from(proof.sessionPublicKey);
  const nonce = Uint8Array.from(proof.nonce);
  const walletProof = { address: proof.walletProof.address, signature: Uint8Array.from(proof.walletProof.signature) };
  let message: Bytes;
  try {
    message = evmSponsorSessionMessage(i.ctx, { method: i.method, body: rest, sessionPublicKey, issuedAtMs: proof.issuedAtMs, nonce, walletProof });
  } catch {
    return { ok: false, reason: 'bad_session_proof' };
  }
  let valid = false;
  try {
    // zip215: false, the strict RFC 8032 rules, as every other session proof.
    valid = ed25519.verify(Uint8Array.from(proof.signature), message, sessionPublicKey, { zip215: false });
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'invalid_session_signature' };
  const account = canonicalWalletAddress('evm', String(rest.account));
  const proven = verifyWalletProof({ signer: i.ctx.signer, appId: i.ctx.appId, sessionPublicKey }, 'evm', walletProof);
  if (account === null || proven === null || proven !== account) return { ok: false, reason: 'bad_wallet_proof' };
  return { ok: true, sessionPublicKey, nonce, issuedAtMs: proof.issuedAtMs, account };
}
