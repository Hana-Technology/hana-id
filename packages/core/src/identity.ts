// Partner identity token (docs/identity-token-spec.md, D120, D127): the byte layouts the vault signs and the API
// checks, the pseudonymous ids, the claim builder and the lifetime rule. Shared by the vault (packages/web), the API
// (apps/api) and the tests; test/identity.test.ts checks every layout against test/vectors/identity-v1.json, written by
// scripts/gen-identity-vectors.mjs (an independent node:crypto implementation).
//
// - Session proof (mint request): "hana-id-identity-v1:" ‖ borsh(signer) ‖ borsh(app_id) ‖ session_pk(32)
//   ‖ u64le(issued_at_ms) ‖ nonce(16) ‖ sha256(payload); payload = "identity-token" ‖ borsh(parent_origin)
//   ‖ wallet_proofs_hash(32) ‖ sha256(sealed_email or ""). Its prefix differs from the contract's
//   "hana-id-session-v1:" and the share actions' "hana-id-vault-v1:", so the signature serves no other purpose.
// - Email consent proof (D411, docs/email-sharing-spec.md): the same message, payload = "email-consent" ‖ borsh(action)
//   ‖ borsh(parent_origin) ‖ sha256(sealed_email or ""), action ∈ EMAIL_CONSENT_ACTIONS; a payload of one action never
//   equals another's or a mint's (each starts with its own label and the action is length-prefixed).
// - Wallet proof: "hana-id/identity-wallet/v1" ‖ 0x00 ‖ borsh(signer) ‖ borsh(app_id) ‖ session_pk(32)
//   ‖ borsh(chain) ‖ borsh(address); Stellar: Ed25519 over it; EVM: secp256k1 r‖s‖v over sha256(it). Neither can be a
//   chain transaction (those cover a 32-byte hash or a keccak of RLP) nor a SEP-53 / EIP-191 message.
// - `sub` = "u1_" ‖ b64url(HMAC-SHA256(IDENTITY_SUB_KEY, "hana-id/idt-sub/v1" ‖ 0x00 ‖ borsh(scope_id)
//   ‖ borsh(root_provider) ‖ borsh(root_sub))[0..16]); `sid` = "s1_" ‖ b64url(HMAC-SHA256(IDENTITY_SUB_KEY,
//   "hana-id/idt-sid/v1" ‖ 0x00 ‖ borsh(app_id) ‖ session_pk)[0..16]).
//
// SECURITY: IDENTITY_SUB_KEY is a secret (it maps partners' `sub`s back to on-chain paths). Nothing here logs.
import { ed25519 } from '@noble/curves/ed25519';
import { hmac } from '@noble/hashes/hmac';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2';
import { STRKEY_VERSION, checksumEvmAddress, decodeStrKey, parseEvmAddress } from './addresses.ts';
import { type Bytes, base64UrlEncode, borshString, concatBytes, sha256, toBytes, u32le, u64le, utf8 } from './bytes.ts';
import { recoverEvmAddress, signEvmDigest } from './signers/evm.ts';

export const IDENTITY_MESSAGE_DOMAIN = 'hana-id-identity-v1:';
export const IDENTITY_TOKEN_PAYLOAD = 'identity-token';
export const EMAIL_CONSENT_PAYLOAD = 'email-consent';
export const IDENTITY_WALLET_DOMAIN = 'hana-id/identity-wallet/v1';
export const IDENTITY_WALLET_PROOFS_DOMAIN = 'hana-id/identity-wallet-proofs/v1';
export const IDENTITY_SUB_LABEL = 'hana-id/idt-sub/v1';
export const IDENTITY_SID_LABEL = 'hana-id/idt-sid/v1';
export const SEALED_EMAIL_AAD_DOMAIN = 'hana-id/sealed-email/v1';

/** The JWS `typ` (RFC 8725 §3.11): no other Hana JWT can be taken for an identity token, and vice versa. */
export const IDENTITY_TOKEN_TYP = 'hana-identity+jwt';
export const IDENTITY_TOKEN_ALG = 'ES256';
export const IDENTITY_SUB_PREFIX = 'u1_';
export const IDENTITY_SID_PREFIX = 's1_';
/** `IDENTITY_SUB_KEY`: 32 random bytes per env, never rotated (a new key changes every user's `sub` at every partner). */
export const IDENTITY_SUB_KEY_BYTES = 32;
export const IDENTITY_NONCE_BYTES = 16;
export const IDENTITY_JTI_BYTES = 16;
/** A token lives at most this long (D120's ceiling, Privy's access-token default). */
export const IDENTITY_TOKEN_MAX_LIFETIME_S = 3600;
/** Less than this left before the session ends: no token (`410 session_ending`). */
export const IDENTITY_MIN_LIFETIME_S = 30;
/** The API accepts a session proof whose `issuedAtMs` is within this of its clock. */
export const IDENTITY_PROOF_WINDOW_MS = 60_000;
/** A proof's single-use marker lives until issuedAtMs + this (longer than the window on either side). */
export const IDENTITY_PROOF_MARKER_MS = 120_000;
/** The SDK hands out a cached token only while more than this remains; else it mints. */
export const IDENTITY_REFRESH_MARGIN_MS = 5 * 60_000;
/** `getIdentityToken({maxAgeMs})`: the smallest age a caller may ask for (a fresher one would be a mint per call). */
export const IDENTITY_MIN_MAX_AGE_MS = 30_000;
/** And the largest the port accepts (anything longer than a token's lifetime means "any cached token"). */
export const IDENTITY_MAX_MAX_AGE_MS = IDENTITY_TOKEN_MAX_LIFETIME_S * 1000;

export type IdentityChain = 'stellar' | 'evm';
export const IDENTITY_CHAINS: readonly IdentityChain[] = ['stellar', 'evm'];
/** Login providers a path can carry (`scope#provider#sub#key_index`). Email and Apple come with their batches. */
export type LoginProvider = string;

// ---- session proof ----

export interface IdentityMessageInput {
  /** The pinned SIGNER (hana-signer account). */
  signer: string;
  /** The D1 `apps.id` (`app_…`): a proof made for app A never verifies for app B. */
  appId: string;
  /** Raw 32-byte Ed25519 session public key. */
  sessionPublicKey: Uint8Array;
  /** The vault's server-corrected clock, ms. */
  issuedAtMs: number;
  /** 16 random bytes. */
  nonce: Uint8Array;
  payload: Uint8Array;
}

/** "hana-id-identity-v1:" ‖ borsh(signer) ‖ borsh(appId) ‖ sessionPk(32) ‖ u64le(issuedAtMs) ‖ nonce(16) ‖ sha256(payload). */
export function identityMessage(i: IdentityMessageInput): Bytes {
  if (i.sessionPublicKey.length !== 32) throw new Error('Session public key must be 32 bytes');
  if (i.nonce.length !== IDENTITY_NONCE_BYTES) throw new Error(`Identity nonce must be ${IDENTITY_NONCE_BYTES} bytes`);
  return concatBytes(utf8(IDENTITY_MESSAGE_DOMAIN), borshString(i.signer), borshString(i.appId), toBytes(i.sessionPublicKey), u64le(i.issuedAtMs), toBytes(i.nonce), sha256(i.payload));
}

/** "identity-token" ‖ borsh(parentOrigin) ‖ walletProofsHash(32) ‖ sha256(utf8(sealedEmail ?? "")). */
export function identityTokenPayload(i: { parentOrigin: string; walletProofsHash: Uint8Array; sealedEmail?: string | null }): Bytes {
  if (i.walletProofsHash.length !== 32) throw new Error('walletProofsHash must be 32 bytes');
  return concatBytes(utf8(IDENTITY_TOKEN_PAYLOAD), borshString(i.parentOrigin), toBytes(i.walletProofsHash), sha256(utf8(i.sealedEmail ?? '')));
}

/**
 * What an email consent proof is for (D411): read the state, record a decision, revoke every address, or let the auth
 * popup read the sealed address for the sheet (`preview`).
 */
export const EMAIL_CONSENT_ACTIONS = ['state', 'granted', 'declined', 'revoke', 'preview'] as const;
export type EmailConsentAction = (typeof EMAIL_CONSENT_ACTIONS)[number];
export const isEmailConsentAction = (v: unknown): v is EmailConsentAction => (EMAIL_CONSENT_ACTIONS as readonly unknown[]).includes(v);

export function emailConsentPayload(i: { action: EmailConsentAction; parentOrigin: string; sealedEmail?: string | null }): Bytes {
  if (!isEmailConsentAction(i.action)) throw new Error('Unknown email consent action');
  return concatBytes(utf8(EMAIL_CONSENT_PAYLOAD), borshString(i.action), borshString(i.parentOrigin), sha256(utf8(i.sealedEmail ?? '')));
}

/**
 * The mainnet demo's signature report (D428, the security review of 2026-11-06): what the session key signs inside
 * identityMessage, binding the event to this session and to the wallet proof of the address that signed.
 * "mainnet-demo-event" ‖ borsh(chain) ‖ borsh(network) ‖ borsh(kind) ‖ borsh(usdMicros) ‖ borsh(address) ‖
 * borsh(Vec<u8> wallet proof signature).
 */
export const MAINNET_DEMO_EVENT_PAYLOAD = 'mainnet-demo-event';

export function mainnetDemoEventPayload(e: { chain: string; network: string; kind: string; usdMicros: string; walletProof: WalletProof }): Bytes {
  return concatBytes(
    utf8(MAINNET_DEMO_EVENT_PAYLOAD),
    borshString(e.chain),
    borshString(e.network),
    borshString(e.kind),
    borshString(e.usdMicros),
    borshString(e.walletProof.address),
    u32le(e.walletProof.signature.length),
    toBytes(e.walletProof.signature),
  );
}

// ---- wallet proofs ----

export interface WalletProof {
  /** Stellar `G…` strkey, or the EVM address in EIP-55 form. */
  address: string;
  /** Stellar: 64-byte Ed25519; EVM: 65-byte r‖s‖v with v ∈ {27, 28}. */
  signature: Uint8Array;
}

export interface WalletProofs {
  stellar: WalletProof;
  evm: WalletProof;
}

export interface WalletProofContext {
  signer: string;
  appId: string;
  sessionPublicKey: Uint8Array;
}

/** "hana-id/identity-wallet/v1" ‖ 0x00 ‖ borsh(signer) ‖ borsh(appId) ‖ sessionPk(32) ‖ borsh(chain) ‖ borsh(address). */
export function walletProofMessage(ctx: WalletProofContext, chain: IdentityChain, address: string): Bytes {
  if (ctx.sessionPublicKey.length !== 32) throw new Error('Session public key must be 32 bytes');
  return concatBytes(utf8(IDENTITY_WALLET_DOMAIN), Uint8Array.of(0), borshString(ctx.signer), borshString(ctx.appId), toBytes(ctx.sessionPublicKey), borshString(chain), borshString(address));
}

const borshBytes = (b: Uint8Array): Bytes => concatBytes(u32le(b.length), b);

/**
 * The hash the session proof commits to (so a proof can't be paired with other wallet proofs):
 * sha256("hana-id/identity-wallet-proofs/v1" ‖ 0x00 ‖ for stellar then evm: borsh(chain) ‖ borsh(address)
 * ‖ borsh(Vec<u8> signature)).
 */
export function walletProofsHash(proofs: WalletProofs): Bytes {
  const parts: Uint8Array[] = [utf8(IDENTITY_WALLET_PROOFS_DOMAIN), Uint8Array.of(0)];
  for (const chain of IDENTITY_CHAINS) parts.push(borshString(chain), borshString(proofs[chain].address), borshBytes(proofs[chain].signature));
  return sha256(concatBytes(...parts));
}

/**
 * A wallet proof by `key` (the Stellar Ed25519 seed or the EVM secp256k1 key `d`, as derivation.ts withChainKey hands
 * it). Synchronous, so it fits inside withChainKey; the key is never kept.
 */
export function signWalletProof(chain: IdentityChain, key: Uint8Array, message: Uint8Array): Bytes {
  if (chain === 'stellar') {
    if (key.length !== 32) throw new Error('Ed25519 seed must be 32 bytes');
    return toBytes(ed25519.sign(message, key));
  }
  return signEvmDigest(key, sha256(message));
}

/** The canonical form of an address for the proof message (G… as is, EVM in EIP-55), or null when malformed. */
export function canonicalWalletAddress(chain: IdentityChain, address: string): string | null {
  try {
    if (chain === 'stellar') {
      decodeStrKey(STRKEY_VERSION.ed25519PublicKey, address);
      return address;
    }
    return checksumEvmAddress(parseEvmAddress(address));
  } catch {
    return null;
  }
}

/**
 * Checks one wallet proof: the address is well formed (EVM in any accepted case, canonicalized to EIP-55 for the
 * message) and the signature over walletProofMessage(ctx, chain, canonical) is by that address's key. Returns the
 * canonical address, or null.
 */
export function verifyWalletProof(ctx: WalletProofContext, chain: IdentityChain, proof: WalletProof): string | null {
  const address = canonicalWalletAddress(chain, proof.address);
  if (address === null) return null;
  const message = walletProofMessage(ctx, chain, address);
  try {
    if (chain === 'stellar') {
      if (proof.signature.length !== 64) return null;
      const pk = decodeStrKey(STRKEY_VERSION.ed25519PublicKey, address);
      // zip215: false, the strict RFC 8032 rules (canonical encodings), as the contract's verifier.
      return ed25519.verify(proof.signature, message, pk, { zip215: false }) ? address : null;
    }
    return recoverEvmAddress(sha256(message), proof.signature) === address ? address : null;
  } catch {
    return null;
  }
}

// ---- pseudonymous ids ----

/**
 * The account root identity in an on-chain session path `scope#provider#sub#key_index`: the known `scope#` prefix
 * stripped, exactly three parts left (a non-empty provider and sub, a decimal key index), `key_index` dropped. Null
 * for anything else (the API then refuses to mint).
 */
export function identityRoot(path: string, scopeId: string): { provider: LoginProvider; sub: string } | null {
  const prefix = `${scopeId}#`;
  if (typeof path !== 'string' || !path.startsWith(prefix)) return null;
  const parts = path.slice(prefix.length).split('#');
  if (parts.length !== 3) return null;
  const [provider, sub, keyIndex] = parts as [string, string, string];
  if (!/^[a-z][a-z0-9_-]{0,31}$/u.test(provider) || sub.length === 0 || !/^(?:0|[1-9]\d{0,9})$/u.test(keyIndex)) return null;
  return { provider, sub };
}

function checkSubKey(key: Uint8Array): void {
  if (key.length !== IDENTITY_SUB_KEY_BYTES) throw new Error(`IDENTITY_SUB_KEY must be ${IDENTITY_SUB_KEY_BYTES} bytes`);
}

const mac16 = (key: Uint8Array, input: Uint8Array): Bytes => toBytes(hmac(nobleSha256, key, input).subarray(0, 16));

/** The 16 bytes behind `sub` (D1 keys a user's per-app rows on these, never on the string). */
export function identitySubBytes(key: Uint8Array, scopeId: string, root: { provider: string; sub: string }): Bytes {
  checkSubKey(key);
  return mac16(key, concatBytes(utf8(IDENTITY_SUB_LABEL), Uint8Array.of(0), borshString(scopeId), borshString(root.provider), borshString(root.sub)));
}

/** `sub`: "u1_" ‖ 22 base64url characters (25 in all), per scope and account root, `key_index` excluded. */
export const identitySub = (key: Uint8Array, scopeId: string, root: { provider: string; sub: string }): string => IDENTITY_SUB_PREFIX + base64UrlEncode(identitySubBytes(key, scopeId, root));

/** `sid`: "s1_" ‖ 22 base64url characters, one per (app, session key). */
export function identitySid(key: Uint8Array, appId: string, sessionPublicKey: Uint8Array): string {
  checkSubKey(key);
  if (sessionPublicKey.length !== 32) throw new Error('Session public key must be 32 bytes');
  return IDENTITY_SID_PREFIX + base64UrlEncode(mac16(key, concatBytes(utf8(IDENTITY_SID_LABEL), Uint8Array.of(0), borshString(appId), toBytes(sessionPublicKey))));
}

// ---- sealed email (build step 6; the AAD is fixed now so the vectors pin it) ----

/** "hana-id/sealed-email/v1" ‖ 0x00 ‖ borsh(appId) ‖ sessionPk(32) ‖ u64le(notAfterMs). */
export function sealedEmailAad(appId: string, sessionPublicKey: Uint8Array, notAfterMs: number): Bytes {
  if (sessionPublicKey.length !== 32) throw new Error('Session public key must be 32 bytes');
  return concatBytes(utf8(SEALED_EMAIL_AAD_DOMAIN), Uint8Array.of(0), borshString(appId), toBytes(sessionPublicKey), u64le(notAfterMs));
}

// ---- lifetime ----

export interface IdentityLifetimeInput {
  /** The API's clock, ms. */
  nowMs: number;
  /** The on-chain session's `expires_at_ms`. */
  sessionExpiresAtMs: number;
  /** 'session' mode: the share's `idle_until` and its absolute cap, min(abs_expires_at, created_at + session_ttl_ms). */
  share?: { idleUntilMs: number; absCapMs: number };
}

/**
 * `{iat, exp}` in seconds: exp = min(iat + 3600, the session's end) where the session's end is the on-chain expiry
 * and, in 'session' mode, the share's idle limit and absolute cap. Null when less than IDENTITY_MIN_LIFETIME_S would
 * remain (no token: `410 session_ending`). `exp` is rounded down, so a token never outlives its session.
 */
export function identityLifetime(i: IdentityLifetimeInput): { iat: number; exp: number } | null {
  const iat = Math.floor(i.nowMs / 1000);
  const endMs = Math.min(i.sessionExpiresAtMs, i.share ? Math.min(i.share.idleUntilMs, i.share.absCapMs) : Number.POSITIVE_INFINITY);
  const exp = Math.min(iat + IDENTITY_TOKEN_MAX_LIFETIME_S, Math.floor(endMs / 1000));
  return exp - iat >= IDENTITY_MIN_LIFETIME_S ? { iat, exp } : null;
}

// ---- claims ----

export interface IdentityWalletClaim {
  chain: IdentityChain;
  address: string;
}

export interface IdentityClaims {
  iss: string;
  aud: string;
  sub: string;
  sid: string;
  iat: number;
  exp: number;
  jti: string;
  wallets: IdentityWalletClaim[];
  login_methods: string[];
  email?: string;
  email_verified?: true;
}

export interface IdentityClaimsInput {
  iss: string;
  /** The D1 apps.id (`app_…`). */
  aud: string;
  sub: string;
  sid: string;
  iat: number;
  exp: number;
  /** 16 random bytes. */
  jti: Uint8Array;
  wallets: { stellar: string; evm: string };
  loginMethods: readonly string[];
  /** A verified address (build step 6); `email_verified: true` comes with it, never alone. */
  email?: string | null;
}

const SUB_RE = /^u1_[A-Za-z0-9_-]{22}$/u;
const SID_RE = /^s1_[A-Za-z0-9_-]{22}$/u;

/**
 * Exactly the spec's claims, in its order: iss, aud, sub, sid, iat, exp, jti, wallets (stellar then evm), the sorted
 * distinct login_methods, and `email` + `email_verified: true` only together. Throws on anything malformed, so a bug
 * can never put an unexpected value in a signed token.
 */
export function buildIdentityClaims(i: IdentityClaimsInput): IdentityClaims {
  if (!i.iss.startsWith('https://') && !i.iss.startsWith('http://')) throw new Error('iss must be a URL');
  if (!/^app_[A-Za-z0-9_-]{1,64}$/u.test(i.aud)) throw new Error('aud must be an app id');
  if (!SUB_RE.test(i.sub) || !SID_RE.test(i.sid)) throw new Error('Malformed sub or sid');
  if (!Number.isSafeInteger(i.iat) || !Number.isSafeInteger(i.exp) || i.iat <= 0) throw new Error('iat and exp must be integers');
  if (i.exp - i.iat > IDENTITY_TOKEN_MAX_LIFETIME_S || i.exp - i.iat < IDENTITY_MIN_LIFETIME_S) throw new Error('Token lifetime out of range');
  if (i.jti.length !== IDENTITY_JTI_BYTES) throw new Error(`jti must be ${IDENTITY_JTI_BYTES} bytes`);
  const stellar = canonicalWalletAddress('stellar', i.wallets.stellar);
  const evm = canonicalWalletAddress('evm', i.wallets.evm);
  if (stellar === null || evm === null || stellar !== i.wallets.stellar || evm !== i.wallets.evm) throw new Error('Wallets must be canonical addresses');
  const methods = [...new Set(i.loginMethods)].sort();
  if (methods.length === 0 || !methods.every((m) => /^[a-z][a-z0-9_-]{0,31}$/u.test(m))) throw new Error('Malformed login methods');
  const claims: IdentityClaims = {
    iss: i.iss,
    aud: i.aud,
    sub: i.sub,
    sid: i.sid,
    iat: i.iat,
    exp: i.exp,
    jti: base64UrlEncode(i.jti),
    wallets: [
      { chain: 'stellar', address: stellar },
      { chain: 'evm', address: evm },
    ],
    login_methods: methods,
  };
  if (i.email !== undefined && i.email !== null) {
    if (typeof i.email !== 'string' || i.email.length < 3 || i.email.length > 254 || !i.email.includes('@')) throw new Error('Malformed email');
    claims.email = i.email;
    claims.email_verified = true;
  }
  return claims;
}

/** The protected header: alg ES256, the key's RFC 7638 thumbprint as kid, the explicit type. */
export const identityTokenHeader = (kid: string): { alg: 'ES256'; kid: string; typ: typeof IDENTITY_TOKEN_TYP } => ({ alg: 'ES256', kid, typ: IDENTITY_TOKEN_TYP });

/** `base64url(header) "." base64url(claims)`: the JWS signing input, as bytes. */
export function identitySigningInput(header: object, claims: object): { text: string; bytes: Bytes } {
  const text = `${base64UrlEncode(utf8(JSON.stringify(header)))}.${base64UrlEncode(utf8(JSON.stringify(claims)))}`;
  return { text, bytes: utf8(text) };
}

// ---- JWK thumbprint (RFC 7638) ----

/** A P-256 public JWK (the fields a thumbprint covers). */
export interface P256PublicJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

const COORD_RE = /^[A-Za-z0-9_-]{43}$/u;

/** True for `{kty: 'EC', crv: 'P-256', x, y}` with 32-byte base64url coordinates (extra members ignored). */
export const isP256PublicJwk = (v: unknown): v is P256PublicJwk =>
  typeof v === 'object' && v !== null && (v as P256PublicJwk).kty === 'EC' && (v as P256PublicJwk).crv === 'P-256' && COORD_RE.test(String((v as P256PublicJwk).x)) && COORD_RE.test(String((v as P256PublicJwk).y));

/** RFC 7638: b64url(sha256('{"crv":"P-256","kty":"EC","x":"…","y":"…"}')), the members in lexicographic order. */
export function jwkThumbprint(jwk: P256PublicJwk): string {
  if (!isP256PublicJwk(jwk)) throw new Error('Not a P-256 public JWK');
  return base64UrlEncode(sha256(utf8(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))));
}

/** The JWKS entry for a P-256 key: `{kty, crv, x, y, kid, use: "sig", alg: "ES256"}` (public members only, never `d`). */
export const identityJwksEntry = (jwk: P256PublicJwk): { kty: 'EC'; crv: 'P-256'; x: string; y: string; kid: string; use: 'sig'; alg: 'ES256' } => ({
  kty: 'EC',
  crv: 'P-256',
  x: jwk.x,
  y: jwk.y,
  kid: jwkThumbprint(jwk),
  use: 'sig',
  alg: 'ES256',
});

// ---- POST /v1/identity/token (the vault's request and the API's answer) ----

/**
 * `emailStatus` in a mint answer (D411, D441): `off` (the app's setting), `not_asked` / `declined` (the session's sealed
 * address has no consent / was declined), `missing` (no sealed address and nothing shared), `invalid` (a sealed address
 * the API can't open, and nothing shared), `included` (the token carries `email`).
 */
export const IDENTITY_EMAIL_STATUSES = ['off', 'not_asked', 'declined', 'missing', 'invalid', 'included'] as const;
export type IdentityEmailStatus = (typeof IDENTITY_EMAIL_STATUSES)[number];

/** The mint request body: bytes as JSON number arrays; `sealedEmail` when the session has one (D438). */
export interface IdentityTokenBody {
  sessionPublicKey: number[];
  issuedAtMs: number;
  nonce: number[];
  signature: number[];
  walletProofs: { stellar: { address: string; signature: number[] }; evm: { address: string; signature: number[] } };
  sealedEmail?: string;
}

export interface IdentityTokenResponse {
  identityToken: string;
  /** exp × 1000. */
  expiresAtMs: number;
  emailStatus: IdentityEmailStatus;
}

/** A compact JWS: three base64url parts, the signature 64 bytes (86 characters). */
const COMPACT_ES256_RE = /^[A-Za-z0-9_-]{10,4096}\.[A-Za-z0-9_-]{10,8192}\.[A-Za-z0-9_-]{86}$/u;

export const isIdentityTokenResponse = (v: unknown): v is IdentityTokenResponse =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as IdentityTokenResponse).identityToken === 'string' &&
  COMPACT_ES256_RE.test((v as IdentityTokenResponse).identityToken) &&
  Number.isSafeInteger((v as IdentityTokenResponse).expiresAtMs) &&
  (v as IdentityTokenResponse).expiresAtMs > 0 &&
  (IDENTITY_EMAIL_STATUSES as readonly unknown[]).includes((v as IdentityTokenResponse).emailStatus);

// ---- email consent (D411, docs/email-sharing-spec.md) ----

/** The app setting `identity_email`: when Hana asks the user to share their address with the app. */
export const IDENTITY_EMAIL_SETTINGS = ['off', 'on_request', 'at_login'] as const;
export type IdentityEmailSetting = (typeof IDENTITY_EMAIL_SETTINGS)[number];
export const isIdentityEmailSetting = (v: unknown): v is IdentityEmailSetting => (IDENTITY_EMAIL_SETTINGS as readonly unknown[]).includes(v);

/** A consent state for the session's address (`unavailable`: the session has no address the API can read). */
export const EMAIL_CONSENT_STATES = ['granted', 'declined', 'not_asked', 'unavailable'] as const;
export type EmailConsentState = (typeof EMAIL_CONSENT_STATES)[number];

/** A consent call's session proof fields (bytes as JSON number arrays), the mint's minus the wallet proofs. */
export interface EmailConsentProof {
  sessionPublicKey: number[];
  issuedAtMs: number;
  nonce: number[];
  signature: number[];
}

/** `POST /v1/identity/email-consent/state` → this. */
export interface EmailConsentStateResponse {
  setting: IdentityEmailSetting;
  state: EmailConsentState;
}

export const isEmailConsentStateResponse = (v: unknown): v is EmailConsentStateResponse =>
  typeof v === 'object' &&
  v !== null &&
  isIdentityEmailSetting((v as EmailConsentStateResponse).setting) &&
  (EMAIL_CONSENT_STATES as readonly unknown[]).includes((v as EmailConsentStateResponse).state);
