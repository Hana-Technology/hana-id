// The byte layouts hana-signer checks (docs/contract-interface.md "Byte layouts", batch A.2). A mismatch shows up on
// chain only as a nonce panic or `Invalid session signature`, and at the API as `nonce_mismatch` /
// `invalid_signature`; test/layouts.test.ts checks these against the `layouts` vectors in
// contracts/hana-signer/src/test_fixture.json.
import { type Bytes, base64UrlEncode, borshString, concatBytes, sha256, toBytes, u32le, u64le, utf8 } from './bytes.ts';

export const SESSION_NONCE_DOMAIN = 'hana-id/session/v1';
export const SESSION_MESSAGE_DOMAIN = 'hana-id-session-v1:';
export const CKD_PAYLOAD_PREFIX = 'hana-id-ckd-v1:';
export const REVOKE_PAYLOAD = 'revoke';

export interface SessionNonceInput {
  /** hana-signer account (`env::current_account_id()`): binds the token to one deployment. */
  signer: string;
  /** The app's scope id (from GET /v1/app). */
  scopeId: string;
  /** Raw 32-byte Ed25519 session public key. */
  sessionPublicKey: Uint8Array;
  expiresAtMs: number;
  keyIndex: number;
  maxUses: number;
  /** 16..=64 random bytes. */
  salt: Uint8Array;
}

/**
 * "hana-id/session/v1" ‖ borsh(signer) ‖ borsh(scope_id) ‖ session_public_key (32) ‖ expires_at_ms u64 LE
 * ‖ key_index u32 LE ‖ max_uses u32 LE ‖ salt
 */
export function sessionNoncePreimage(i: SessionNonceInput): Bytes {
  if (i.sessionPublicKey.length !== 32) throw new Error('Session public key must be 32 bytes');
  if (i.salt.length < 16 || i.salt.length > 64) throw new Error('Salt must be 16-64 bytes');
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
export async function sessionNonce(i: SessionNonceInput): Promise<string> {
  return base64UrlEncode(await sha256(sessionNoncePreimage(i)));
}

/** What the session key signs: "hana-id-session-v1:" ‖ counter u64 LE ‖ sha256(payload). */
export async function sessionMessage(counter: number, payload: Bytes): Promise<Bytes> {
  return concatBytes(utf8(SESSION_MESSAGE_DOMAIN), u64le(counter), await sha256(payload));
}

/** derive_key payload: "hana-id-ckd-v1:" ‖ pk1 ‖ ":" ‖ pk2 (UTF-8 of the strings exactly as sent). */
export const ckdPayload = (pk1: string, pk2: string): Bytes => utf8(`${CKD_PAYLOAD_PREFIX}${pk1}:${pk2}`);

/** revoke_session payload. */
export const revokePayload = (): Bytes => utf8(REVOKE_PAYLOAD);
