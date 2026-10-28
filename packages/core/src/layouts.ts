// Byte layouts. The on-chain ones (session nonce, session message, CKD payload) are the ones hana-signer checks
// (docs/contract-interface.md "Byte layouts", batch A.2): a mismatch shows up on chain only as a nonce panic or
// `Invalid session signature`, and at the API as `nonce_mismatch` / `invalid_signature`. The off-chain ones (vault
// message, vault record AAD, approval digest, relay AAD) are docs/batch-b-spec.md's. test/layouts.test.ts checks
// them against contracts/hana-signer/src/test_fixture.json and test/vectors/layouts-v1.json (written by
// scripts/gen-layout-vectors.mjs, an independent implementation).
import { type Bytes, base64UrlEncode, borshString, concatBytes, sha256, toBytes, u32le, u64le, utf8 } from './bytes.ts';

export const SESSION_NONCE_DOMAIN = 'hana-id/session/v1';
export const SESSION_MESSAGE_DOMAIN = 'hana-id-session-v1:';
export const CKD_PAYLOAD_PREFIX = 'hana-id-ckd-v1:';
export const REVOKE_PAYLOAD = 'revoke';
export const VAULT_MESSAGE_DOMAIN = 'hana-id-vault-v1:';
export const VAULT_RECORD_AAD_DOMAIN = 'hana-id/vault/v1';
export const APPROVAL_DIGEST_DOMAIN = 'hana-id/approve/v1';
export const RELAY_AAD_DOMAIN = 'hana-id/relay/v1';

/** `key_index ≥ 2^31` is reserved (contract, API and SDK refuse it). */
export const KEY_INDEX_LIMIT = 0x7fffffff;
/** The contract's `max_uses` bound. */
export const MAX_USES_LIMIT = 500;
export const SALT_MIN_BYTES = 16;
export const SALT_MAX_BYTES = 64;
/** `shareId` length (vault endpoints). */
export const SHARE_ID_BYTES = 16;

export interface SessionNonceInput {
  /** hana-signer account (`env::current_account_id()`): binds the token to one deployment. The pinned SIGNER. */
  signer: string;
  /** The app's scope id. */
  scopeId: string;
  /** Raw 32-byte Ed25519 session public key. */
  sessionPublicKey: Uint8Array;
  expiresAtMs: number;
  keyIndex: number;
  maxUses: number;
  /** 16..=64 random bytes. */
  salt: Uint8Array;
}

/** Throws unless `keyIndex` is 0..KEY_INDEX_LIMIT and `maxUses` 1..MAX_USES_LIMIT. */
export function checkSessionParams(p: { keyIndex: number; maxUses: number }): void {
  if (!Number.isInteger(p.keyIndex) || p.keyIndex < 0 || p.keyIndex > KEY_INDEX_LIMIT) {
    throw new RangeError(`key_index must be an integer 0..${KEY_INDEX_LIMIT} (key_index ≥ 2^31 is reserved)`);
  }
  if (!Number.isInteger(p.maxUses) || p.maxUses < 1 || p.maxUses > MAX_USES_LIMIT) throw new RangeError(`max_uses must be an integer 1..${MAX_USES_LIMIT}`);
}

/**
 * "hana-id/session/v1" ‖ borsh(signer) ‖ borsh(scope_id) ‖ session_public_key (32) ‖ expires_at_ms u64 LE
 * ‖ key_index u32 LE ‖ max_uses u32 LE ‖ salt
 */
export function sessionNoncePreimage(i: SessionNonceInput): Bytes {
  if (i.sessionPublicKey.length !== 32) throw new Error('Session public key must be 32 bytes');
  if (i.salt.length < SALT_MIN_BYTES || i.salt.length > SALT_MAX_BYTES) throw new Error(`Salt must be ${SALT_MIN_BYTES}-${SALT_MAX_BYTES} bytes`);
  return concatBytes(
    utf8(SESSION_NONCE_DOMAIN),
    borshString(i.signer),
    borshString(i.scopeId),
    toBytes(i.sessionPublicKey),
    u64le(i.expiresAtMs),
    u32le(i.keyIndex),
    u32le(i.maxUses),
    toBytes(i.salt),
  );
}

/** The `nonce` Google must put in the ID token: b64url_nopad(sha256(preimage)), 43 characters. */
export const sessionNonce = (i: SessionNonceInput): string => base64UrlEncode(sha256(sessionNoncePreimage(i)));

/** What the session key signs on chain: "hana-id-session-v1:" ‖ counter u64 LE ‖ sha256(payload). */
export const sessionMessage = (counter: number, payload: Uint8Array): Bytes => concatBytes(utf8(SESSION_MESSAGE_DOMAIN), u64le(counter), sha256(payload));

/** derive_key payload: "hana-id-ckd-v1:" ‖ pk1 ‖ ":" ‖ pk2 (UTF-8 of the strings exactly as sent). */
export const ckdPayload = (pk1: string, pk2: string): Bytes => utf8(`${CKD_PAYLOAD_PREFIX}${pk1}:${pk2}`);

/** revoke_session payload. */
export const revokePayload = (): Bytes => utf8(REVOKE_PAYLOAD);

// ---- vault message (off-chain only; docs/batch-b-spec.md "Vault message layout") ----

export interface VaultMessageInput {
  /** The pinned SIGNER. */
  signer: string;
  /** The D1 `apps.id` (not the CKD app_id): a signature made for app A never verifies for app B. */
  appId: string;
  /** 16 bytes; all zero for create-share. */
  shareId: Uint8Array;
  /** u64; 0 for create-share, n + 1 otherwise. */
  counter: number;
  payload: Uint8Array;
}

/**
 * utf8("hana-id-vault-v1:") ‖ borsh(signer) ‖ borsh(appId) ‖ shareId(16) ‖ u64le(counter) ‖ sha256(payload).
 * The prefix differs from "hana-id-session-v1:", so a vault signature can never be relayed as a derive or a revoke.
 */
export function vaultMessage(i: VaultMessageInput): Bytes {
  if (i.shareId.length !== SHARE_ID_BYTES) throw new Error(`shareId must be ${SHARE_ID_BYTES} bytes`);
  return concatBytes(utf8(VAULT_MESSAGE_DOMAIN), borshString(i.signer), borshString(i.appId), toBytes(i.shareId), u64le(i.counter), sha256(i.payload));
}

/** The shareId of the create-share message: 16 zero bytes (counter 0). A fresh array each call. */
export const createShareId = (): Bytes => new Uint8Array(SHARE_ID_BYTES);

/** Vault message payloads, one per action. */
export const vaultPayload = {
  /** create share: utf8("share") ‖ borsh(parentOrigin), with shareId = 16 zero bytes and counter 0. */
  createShare: (parentOrigin: string): Bytes => concatBytes(utf8('share'), borshString(parentOrigin)),
  unlock: (): Bytes => utf8('unlock'),
  touch: (): Bytes => utf8('touch'),
  revoke: (): Bytes => utf8('revoke'),
  revokeAll: (): Bytes => utf8('revoke-all'),
} as const;

// ---- vault record AAD (docs/batch-b-spec.md "Record") ----

export interface RecordAadInput {
  signer: string;
  appId: string;
  path: string;
  sessionPublicKey: Uint8Array;
  derivationVersion: number;
  /** sha256 of the pinned ckdNetworkKey's 96-byte compressed G2 (ckd.ts ckdKeyHash). */
  ckdKeyHash: Uint8Array;
  parentOrigin: string;
  expiresAtMs: number;
}

/**
 * utf8("hana-id/vault/v1") ‖ borsh(signer) ‖ borsh(appId) ‖ borsh(path) ‖ sessionPk ‖ u32le(derivationVersion)
 * ‖ ckdKeyHash ‖ borsh(parentOrigin) ‖ u64le(expiresAtMs)
 */
export function recordAad(i: RecordAadInput): Bytes {
  if (i.sessionPublicKey.length !== 32) throw new Error('Session public key must be 32 bytes');
  if (i.ckdKeyHash.length !== 32) throw new Error('ckdKeyHash must be 32 bytes');
  return concatBytes(
    utf8(VAULT_RECORD_AAD_DOMAIN),
    borshString(i.signer),
    borshString(i.appId),
    borshString(i.path),
    toBytes(i.sessionPublicKey),
    u32le(i.derivationVersion),
    toBytes(i.ckdKeyHash),
    borshString(i.parentOrigin),
    u64le(i.expiresAtMs),
  );
}

// ---- approval digest (docs/batch-b-spec.md "Approval flow", step 6) ----

/** What the approval popup rendered and the vault queued; `bytes` are exactly the bytes to be signed or decoded. */
export interface ApprovalDigestInput {
  id: string;
  kind: string;
  chain: string;
  address: string;
  parentOrigin: string;
  /** The network passphrase (Stellar), the decimal chain ID (EVM), or '' where the request has no network context. */
  contextString: string;
  bytes: Uint8Array;
}

/**
 * sha256(utf8("hana-id/approve/v1") ‖ borsh(id) ‖ borsh(kind) ‖ borsh(chain) ‖ borsh(address) ‖ borsh(parentOrigin)
 *        ‖ borsh(contextString) ‖ u32le(len(bytes)) ‖ bytes)
 */
export function approvalDigest(i: ApprovalDigestInput): Bytes {
  return sha256(
    concatBytes(
      utf8(APPROVAL_DIGEST_DOMAIN),
      borshString(i.id),
      borshString(i.kind),
      borshString(i.chain),
      borshString(i.address),
      borshString(i.parentOrigin),
      borshString(i.contextString),
      u32le(i.bytes.length),
      toBytes(i.bytes),
    ),
  );
}

/** The approval `contextString`: the passphrase, the decimal chain ID, or '' (raw and message requests without one). */
export function approvalContextString(context: { networkPassphrase: string } | { chainId: number } | Record<string, never>): string {
  if ('networkPassphrase' in context) return context.networkPassphrase;
  if ('chainId' in context) {
    if (!Number.isSafeInteger(context.chainId) || context.chainId <= 0) throw new RangeError('chainId must be a positive safe integer');
    return String(context.chainId);
  }
  return '';
}

// ---- login relay (docs/batch-b-spec.md "Login" steps 2, 6, 7) ----

export const RELAY_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

/** relayId = b64url(sha256(relayReadKey)), 43 characters; also the OAuth `state`. */
export function relayIdFor(relayReadKey: Uint8Array): string {
  if (relayReadKey.length !== 32) throw new Error('relayReadKey must be 32 bytes');
  return base64UrlEncode(sha256(relayReadKey));
}

/** AES-GCM AAD of the relay payload: utf8("hana-id/relay/v1") ‖ utf8(relayId). */
export function relayAad(relayId: string): Bytes {
  if (!RELAY_ID_PATTERN.test(relayId)) throw new Error('Malformed relayId');
  return concatBytes(utf8(RELAY_AAD_DOMAIN), utf8(relayId));
}
