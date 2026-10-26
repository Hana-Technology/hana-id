// Byte layouts the contract checks, reproduced so the API can reject bad requests before relaying (each relayed tx
// costs gas even when the contract rejects it). Layouts: docs/batch-a2-shared-client.md ("Byte layouts") and
// docs/contract-interface.md. The contract re-checks everything.
import { base64UrlEncode, borshString, concatBytes, sha256, u32le, u64le } from './bytes.ts';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

export const SESSION_NONCE_DOMAIN = 'hana-id/session/v1';
export const SESSION_MESSAGE_DOMAIN = 'hana-id-session-v1:';
export const CKD_PAYLOAD_PREFIX = 'hana-id-ckd-v1:';
export const REVOKE_PAYLOAD = 'revoke';

export interface SessionNonceInput {
  /** hana-signer account (`env::current_account_id()`), i.e. SIGNER_ACCOUNT. */
  signer: string;
  /** The app's scope id (from D1, never from the client). */
  scopeId: string;
  sessionPublicKey: Uint8Array | number[];
  expiresAtMs: number;
  keyIndex: number;
  maxUses: number;
  salt: Uint8Array | number[];
}

/**
 * The `nonce` an ID token must carry to open a session:
 * b64url(sha256("hana-id/session/v1" ‖ borsh(signer) ‖ borsh(scope_id) ‖ session_public_key (32) ‖ expires_at_ms u64 LE
 * ‖ key_index u32 LE ‖ max_uses u32 LE ‖ salt)).
 */
export async function sessionNonce(i: SessionNonceInput): Promise<string> {
  const preimage = concatBytes(
    utf8(SESSION_NONCE_DOMAIN),
    borshString(i.signer),
    borshString(i.scopeId),
    Uint8Array.from(i.sessionPublicKey),
    u64le(i.expiresAtMs),
    u32le(i.keyIndex),
    u32le(i.maxUses),
    Uint8Array.from(i.salt),
  );
  return base64UrlEncode(await sha256(preimage));
}

/** What a session key signs: "hana-id-session-v1:" ‖ counter u64 LE ‖ sha256(payload). */
export async function sessionMessage(counter: number, payload: Uint8Array): Promise<Uint8Array> {
  return concatBytes(utf8(SESSION_MESSAGE_DOMAIN), u64le(counter), await sha256(payload));
}

/** derive_key payload: "hana-id-ckd-v1:" ‖ pk1 ‖ ":" ‖ pk2. */
export const ckdPayload = (pk1: string, pk2: string): Uint8Array => utf8(`${CKD_PAYLOAD_PREFIX}${pk1}:${pk2}`);
export const revokePayload = (): Uint8Array => utf8(REVOKE_PAYLOAD);

/**
 * Ed25519 (WebCrypto) check of a session-key signature over sessionMessage(counter, payload). False for any malformed
 * key or signature. Counter freshness is left to the contract.
 */
export async function verifySessionSignature(sessionPublicKey: number[], counter: number, signature: number[], payload: Uint8Array): Promise<boolean> {
  if (sessionPublicKey.length !== 32 || signature.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey('raw', Uint8Array.from(sessionPublicKey), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, Uint8Array.from(signature), await sessionMessage(counter, payload));
  } catch {
    return false;
  }
}
