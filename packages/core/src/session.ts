// Session key: a non-extractable WebCrypto Ed25519 key pair. The private half can sign but never be read out, so it
// can sit in IndexedDB as is (docs/batch-b-spec.md "Record"). Ported from apps/smoke/src/session.ts.
import { type Bytes, toBytes } from './bytes.ts';
import { type SessionNonceInput, type VaultMessageInput, ckdPayload, createProofPayload, revokePayload, sessionMessage, vaultMessage } from './layouts.ts';
import { linkedCkdPayload } from './links.ts';

export const SALT_BYTES = 32;

export interface SessionKey {
  keyPair: CryptoKeyPair;
  /** Raw 32-byte public key. */
  publicKey: Bytes;
}

/** A fresh non-extractable Ed25519 session key. */
export async function newSessionKey(): Promise<SessionKey> {
  const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
  // The public half of a WebCrypto key pair is always exportable, even with extractable = false.
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  return { keyPair, publicKey };
}

/** `n` random bytes from the platform CSPRNG (session salt, relay keys). */
export const randomBytes = (n: number): Bytes => crypto.getRandomValues(new Uint8Array(n));

async function sign(privateKey: CryptoKey, message: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, message));
}

/** Ed25519 signature (64 bytes) by the session key over sessionMessage(counter, payload). */
export const signSessionMessage = (privateKey: CryptoKey, counter: number, payload: Uint8Array): Promise<Bytes> => sign(privateKey, sessionMessage(counter, payload));

/** The derive_key signature over the CKD payload. */
export const signDerive = (privateKey: CryptoKey, counter: number, pk1: string, pk2: string): Promise<Bytes> => signSessionMessage(privateKey, counter, ckdPayload(pk1, pk2));

/**
 * A linked login's counter-1 signature (D133): over the linked CKD payload, which binds the link token and its mode,
 * so nobody but the session key holder can add, swap, change or strip the link.
 */
export const signDeriveLinked = (privateKey: CryptoKey, pk1: string, pk2: string, linkJwt: string, immediate: boolean): Promise<Bytes> =>
  signSessionMessage(privateKey, 1, linkedCkdPayload(pk1, pk2, linkJwt, immediate));

/** create_session's `signature` (D137): the proof of possession over createProofPayload, counter 0. */
export const signCreate = (privateKey: CryptoKey, session: SessionNonceInput): Promise<Bytes> => signSessionMessage(privateKey, 0, createProofPayload(session));

/** The revoke_session signature. */
export const signRevoke = (privateKey: CryptoKey, counter: number): Promise<Bytes> => signSessionMessage(privateKey, counter, revokePayload());

/** Ed25519 signature by the session key over the off-chain vault message. */
export const signVaultMessage = (privateKey: CryptoKey, input: VaultMessageInput): Promise<Bytes> => sign(privateKey, vaultMessage(input));

/** Verifies an Ed25519 signature against a raw 32-byte public key (WebCrypto). */
export async function verifyEd25519(publicKey: Uint8Array, signature: Uint8Array, message: Uint8Array): Promise<boolean> {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey('raw', toBytes(publicKey), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, toBytes(signature), toBytes(message));
  } catch {
    return false;
  }
}
