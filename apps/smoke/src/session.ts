// Session key for the page: a non-extractable WebCrypto Ed25519 key pair (@hana-id/core session.ts), kept in memory
// only; a reload starts over. The nonce layout and the signatures come from @hana-id/core.
import { type Bytes, type SessionNonceInput, checkSessionParams, newSessionKey, randomBytes, sessionNonce, signCreate } from '@hana-id/core';

export { signDerive, signRevoke } from '@hana-id/core';

/** Session lifetime used by the page (the contract allows up to 24 h). */
export const SESSION_LIFETIME_MS = 60 * 60 * 1000;
export const SALT_BYTES = 32;

export type SessionParams = Pick<SessionNonceInput, 'signer' | 'scopeId' | 'keyIndex' | 'maxUses'>;

export interface PendingSession extends SessionParams {
  /** Non-extractable private key; only `sign` uses it. */
  privateKey: CryptoKey;
  publicKey: Bytes;
  salt: Bytes;
  expiresAtMs: number;
  nonce: string;
}

/**
 * create_session's proof of possession (D137): the session key's signature over session_message(0,
 * "hana-id-create-v1:" ‖ sha256(the session nonce preimage)). Contract v3 requires it; v2 ignores the extra field.
 */
export async function signCreateProof(p: PendingSession): Promise<Bytes> {
  return signCreate(p.privateKey, { signer: p.signer, scopeId: p.scopeId, sessionPublicKey: p.publicKey, expiresAtMs: p.expiresAtMs, keyIndex: p.keyIndex, maxUses: p.maxUses, salt: p.salt });
}

/** Makes the session key, a random 32-byte salt and expiry (now + 1 h), and the Google nonce committing to them. */
export async function newPendingSession(p: SessionParams, now = Date.now()): Promise<PendingSession> {
  checkSessionParams(p);
  const { keyPair, publicKey } = await newSessionKey();
  const salt = randomBytes(SALT_BYTES);
  const expiresAtMs = now + SESSION_LIFETIME_MS;
  const nonce = sessionNonce({ ...p, sessionPublicKey: publicKey, expiresAtMs, salt });
  return { ...p, privateKey: keyPair.privateKey, publicKey, salt, expiresAtMs, nonce };
}
