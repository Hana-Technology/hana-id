// Hana Home's byte layouts (docs/hana-home-spec.md "Identity without a user database", D463): the identity nonce, the
// message every Home API call signs, the `x-hana-home` header, and the two server-consent payloads. Off-chain: a Home
// identity never reaches the contract. Node vectors: test/vectors/home-v1.json (scripts/gen-home-vectors.mjs).
//
// The nonce's domain differs from "hana-id/session/v1": a Home token can never open a session on chain, and a session
// token (public forever in the transaction args) can never be a Home identity.
//
// The module is Worker-safe (bytes.ts only): `@hana-id/core/home` is what the API imports, so the API and the /home page
// compute the nonce, the message and the header with the same code.
import { type Bytes, base64UrlDecode, base64UrlEncode, borshString, concatBytes, fromUtf8, sha256, toBytes, u64le, utf8 } from './bytes.ts';

export const HOME_NONCE_DOMAIN = 'hana-id/home/v1';
export const HOME_MESSAGE_DOMAIN = 'hana-id-home-v1:';
/** The request header of every Home API call. */
export const HOME_IDENTITY_HEADER = 'x-hana-home';
/** How long the page makes a Home identity last (the spec's `expiresAtMs = now + 15 min`). */
export const HOME_IDENTITY_LIFETIME_MS = 15 * 60_000;
/** The API refuses an identity ending later than this from now (`expiresAtMs ≤ now + 20 min`): the page's clock can be a little off. */
export const HOME_IDENTITY_MAX_LIFETIME_MS = 20 * 60_000;
export const HOME_KEY_BYTES = 32;
export const HOME_SALT_BYTES = 32;
export const HOME_SIGNATURE_BYTES = 64;
/** Longest accepted `x-hana-home` (an email token of MAX_JWT characters, JSON-escaped and base64url-encoded, with the other fields). */
export const HOME_HEADER_MAX_CHARS = 12_288;
/**
 * The `aud` the email issuer's Home route signs. It belongs to no scope today, and must not be registered on one: the
 * contract or the issuer has to refuse that client. Not `email:`-prefixed for that reason.
 */
export const HOME_EMAIL_AUDIENCE = 'hana-home';

export interface HomeNonceInput {
  /** The pinned SIGNER: binds the token to one deployment. */
  signer: string;
  /** Raw 32-byte Ed25519 Home public key `hk`. */
  homePublicKey: Uint8Array;
  expiresAtMs: number;
  /** 32 random bytes. */
  salt: Uint8Array;
}

/** "hana-id/home/v1" ‖ borsh(signer) ‖ hk_pub (32) ‖ u64le(expiresAtMs) ‖ salt (32). */
export function homeNoncePreimage(i: HomeNonceInput): Bytes {
  if (i.homePublicKey.length !== HOME_KEY_BYTES) throw new Error(`Home public key must be ${HOME_KEY_BYTES} bytes`);
  if (i.salt.length !== HOME_SALT_BYTES) throw new Error(`Home salt must be ${HOME_SALT_BYTES} bytes`);
  return concatBytes(utf8(HOME_NONCE_DOMAIN), borshString(i.signer), toBytes(i.homePublicKey), u64le(i.expiresAtMs), toBytes(i.salt));
}

/** The `nonce` a Home identity token must carry: b64url_nopad(sha256(preimage)), 43 characters. The preimage is zeroed once hashed. */
export function homeNonce(i: HomeNonceInput): string {
  const preimage = homeNoncePreimage(i);
  try {
    return base64UrlEncode(sha256(preimage));
  } finally {
    preimage.fill(0);
  }
}

export interface HomeMessageInput {
  /** The pinned SIGNER. */
  signer: string;
  /** u64; any value not used before with this Home key (the API marks it single-use until `expiresAtMs`). */
  counter: number;
  /** The HTTP method, as `Request.method` reports it. */
  method: string;
  /** `homeRequestPath(url)`: the path and the query, so a query can't be changed under the signature. */
  path: string;
  /** The request's raw body (empty for a GET). */
  body: Uint8Array;
}

/**
 * What the Home key `hk` signs for each API call: utf8("hana-id-home-v1:") ‖ borsh(signer) ‖ u64le(counter)
 * ‖ sha256(borsh(method) ‖ borsh(path) ‖ body). The prefix differs from every other signed message, so a Home signature
 * can never be replayed as a session, vault or identity-proof signature.
 */
export function homeMessage(i: HomeMessageInput): Bytes {
  return concatBytes(utf8(HOME_MESSAGE_DOMAIN), borshString(i.signer), u64le(i.counter), sha256(concatBytes(borshString(i.method), borshString(i.path), i.body)));
}

/** The `path` of `homeMessage` for a request URL: its path and query, as `URL` normalizes them at both ends. */
export const homeRequestPath = (url: URL): string => url.pathname + url.search;

export interface HomeIdentityHeader {
  /** The ID token (compact JWT) or email token (JWS JSON), its nonce = homeNonce(key, expiresAtMs, salt). */
  jwt: string;
  /** Raw 32-byte Home public key. */
  key: Uint8Array;
  expiresAtMs: number;
  /** 32 bytes. */
  salt: Uint8Array;
  /** u64: this call's counter (`homeMessage`). */
  counter: number;
  /** 64-byte Ed25519 signature by the Home key over `homeMessage`. */
  sig: Uint8Array;
}

/** `x-hana-home`: b64url(json {jwt, key, expiresAtMs, salt, counter, sig}), the byte fields b64url without padding. */
export function encodeHomeIdentity(h: HomeIdentityHeader): string {
  if (h.key.length !== HOME_KEY_BYTES) throw new Error(`Home public key must be ${HOME_KEY_BYTES} bytes`);
  if (h.salt.length !== HOME_SALT_BYTES) throw new Error(`Home salt must be ${HOME_SALT_BYTES} bytes`);
  if (h.sig.length !== HOME_SIGNATURE_BYTES) throw new Error(`Home signature must be ${HOME_SIGNATURE_BYTES} bytes`);
  return base64UrlEncode(utf8(JSON.stringify({ jwt: h.jwt, key: base64UrlEncode(h.key), expiresAtMs: h.expiresAtMs, salt: base64UrlEncode(h.salt), counter: h.counter, sig: base64UrlEncode(h.sig) })));
}

const HEADER_FIELDS: ReadonlySet<string> = new Set(['jwt', 'key', 'expiresAtMs', 'salt', 'counter', 'sig']);

/** A base64url field of exactly `length` bytes, canonical (no padding, no spare bits), or null. */
function strictBytes(value: unknown, length: number): Bytes | null {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  let bytes: Bytes;
  try {
    bytes = base64UrlDecode(value);
  } catch {
    return null;
  }
  return bytes.length === length && base64UrlEncode(bytes) === value ? bytes : null;
}

/** Parses `x-hana-home` strictly (exactly the six fields, each of its exact form), or null. Never throws. */
export function decodeHomeIdentity(header: string): HomeIdentityHeader | null {
  if (header.length === 0 || header.length > HOME_HEADER_MAX_CHARS || !/^[A-Za-z0-9_-]+$/u.test(header)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromUtf8(base64UrlDecode(header)));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== HEADER_FIELDS.size || !keys.every((k) => HEADER_FIELDS.has(k))) return null;
  if (typeof o.jwt !== 'string' || o.jwt.length === 0) return null;
  if (!Number.isSafeInteger(o.expiresAtMs) || (o.expiresAtMs as number) < 1 || !Number.isSafeInteger(o.counter) || (o.counter as number) < 0) return null;
  const key = strictBytes(o.key, HOME_KEY_BYTES);
  const salt = strictBytes(o.salt, HOME_SALT_BYTES);
  const sig = strictBytes(o.sig, HOME_SIGNATURE_BYTES);
  if (!key || !salt || !sig) return null;
  return { jwt: o.jwt, key, expiresAtMs: o.expiresAtMs as number, salt, counter: o.counter as number, sig };
}

// ---- vault message payloads for server consents (docs/hana-home-spec.md "Vault messages"; `vaultMessage`, layouts.ts) ----

export const CONSENT_ID_BYTES = 16;
export const CONSENT_POLICY_ID_BYTES = 32;

export interface ConsentRegisterInput {
  /** 16 random bytes, made by the vault at Allow. */
  consentId: Uint8Array;
  /** The policy's 32-byte id (sha256; policy/id.ts's hex, decoded). */
  policyId: Uint8Array;
  expiresAtMs: number;
  parentOrigin: string;
}

/** register: utf8("consent") ‖ consentId (16) ‖ policyId (32) ‖ u64le(expiresAtMs) ‖ borsh(parentOrigin). */
export function consentRegisterPayload(i: ConsentRegisterInput): Bytes {
  if (i.consentId.length !== CONSENT_ID_BYTES) throw new Error(`consentId must be ${CONSENT_ID_BYTES} bytes`);
  if (i.policyId.length !== CONSENT_POLICY_ID_BYTES) throw new Error(`policyId must be ${CONSENT_POLICY_ID_BYTES} bytes`);
  return concatBytes(utf8('consent'), toBytes(i.consentId), toBytes(i.policyId), u64le(i.expiresAtMs), borshString(i.parentOrigin));
}

/** revoke (the device): utf8("consent-revoke") ‖ consentId (16). */
export function consentRevokePayload(consentId: Uint8Array): Bytes {
  if (consentId.length !== CONSENT_ID_BYTES) throw new Error(`consentId must be ${CONSENT_ID_BYTES} bytes`);
  return concatBytes(utf8('consent-revoke'), toBytes(consentId));
}
