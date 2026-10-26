// Session key: a non-extractable WebCrypto Ed25519 key pair (the private half can sign here but never be read out).
// Kept in memory only; a reload starts over.
import { type Bytes, toBytes } from './bytes.ts';
import { ckdPayload, revokePayload, sessionMessage, sessionNonce } from './layouts.ts';

/** Session lifetime used by the page (the contract allows up to 24 h). */
export const SESSION_LIFETIME_MS = 60 * 60 * 1000;
export const SALT_BYTES = 32;
export const MAX_USES_LIMIT = 500;
export const KEY_INDEX_LIMIT = 0xffffffff;

export interface SessionParams {
  signer: string;
  scopeId: string;
  keyIndex: number;
  maxUses: number;
}

export interface PendingSession extends SessionParams {
  /** Non-extractable private key; only `sign` uses it. */
  privateKey: CryptoKey;
  publicKey: Bytes;
  salt: Bytes;
  expiresAtMs: number;
  nonce: string;
}

export function checkSessionParams(p: Pick<SessionParams, 'keyIndex' | 'maxUses'>): void {
  if (!Number.isInteger(p.keyIndex) || p.keyIndex < 0 || p.keyIndex > KEY_INDEX_LIMIT) throw new Error('key_index must be an integer 0..4294967295');
  if (!Number.isInteger(p.maxUses) || p.maxUses < 1 || p.maxUses > MAX_USES_LIMIT) throw new Error(`max_uses must be an integer 1..${MAX_USES_LIMIT}`);
}

/** Makes the session key, a random 32-byte salt and expiry (now + 1 h), and the Google nonce committing to them. */
export async function newPendingSession(p: SessionParams, now = Date.now()): Promise<PendingSession> {
  checkSessionParams(p);
  const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
  // The public half of a WebCrypto key pair is always exportable, even with extractable = false.
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const expiresAtMs = now + SESSION_LIFETIME_MS;
  const nonce = await sessionNonce({ ...p, sessionPublicKey: publicKey, expiresAtMs, salt });
  return { ...p, privateKey: keys.privateKey, publicKey, salt, expiresAtMs, nonce };
}

/** Ed25519 signature (64 bytes) by the session key over sessionMessage(counter, payload). */
export async function signSessionMessage(privateKey: CryptoKey, counter: number, payload: Bytes): Promise<Bytes> {
  const message = await sessionMessage(counter, payload);
  return new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, message));
}

export const signDerive = (privateKey: CryptoKey, counter: number, pk1: string, pk2: string): Promise<Bytes> =>
  signSessionMessage(privateKey, counter, ckdPayload(pk1, pk2));

export const signRevoke = (privateKey: CryptoKey, counter: number): Promise<Bytes> => signSessionMessage(privateKey, counter, revokePayload());

/** JSON byte array, as the API and contract take `Vec<u8>`. */
export const jsonBytes = (b: Uint8Array): number[] => Array.from(toBytes(b));
