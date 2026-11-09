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

/** How many times newSessionKey asks WebCrypto for a key pair before it passes the platform's OperationError on. */
export const SESSION_KEYGEN_ATTEMPTS = 4;

/**
 * A fresh non-extractable Ed25519 session key.
 *
 * WebKit's Linux ports (WebKitGTK and WPE: GNOME Web, embedded WPE browsers, Playwright's Linux WebKit) reject
 * about 1 in 128 Ed25519 generateKey calls with an OperationError: the keys whose private seed or public key starts
 * with a zero byte (by audit: none of the keys it returns has either, and it refuses a PKCS#8 import of a seed
 * that starts with one). Each attempt is a fresh random key, so an OperationError is retried, up to
 * SESSION_KEYGEN_ATTEMPTS in all (four failures in a row there: about 4 in 10^9). Any other error (Ed25519 unsupported,
 * say) is passed on at once. Safari on Apple platforms, Chromium and Firefox never failed in testing. Callers report a
 * failure as `derive_failed` with sessionKeyFailure's reason, never as a network error.
 */
export async function newSessionKey(): Promise<SessionKey> {
  for (let attempt = 1; ; attempt++) {
    let keyPair: CryptoKeyPair;
    try {
      keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
    } catch (e) {
      if (attempt < SESSION_KEYGEN_ATTEMPTS && isOperationError(e)) continue;
      throw e;
    }
    // The public half of a WebCrypto key pair is always exportable, even with extractable = false.
    const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
    return { keyPair, publicKey };
  }
}

const errorName = (e: unknown): string | undefined => {
  const name = typeof e === 'object' && e !== null ? (e as { name?: unknown }).name : undefined;
  return typeof name === 'string' ? name : undefined;
};
const isOperationError = (e: unknown): boolean => errorName(e) === 'OperationError';

/** Why newSessionKey failed, as the login's `derive_failed` `data.reason`. */
export type SessionKeyFailureReason = 'webcrypto_unsupported' | 'webcrypto_failed';

export interface SessionKeyFailure {
  reason: SessionKeyFailureReason;
  /** The platform error's name (`NotSupportedError`, `OperationError`, …) when it is a plain identifier. Never its message. */
  error?: string;
}

/**
 * Classifies what newSessionKey threw. `webcrypto_unsupported`: the browser has no Ed25519 in WebCrypto
 * (`NotSupportedError`: Chrome and Edge before 137, Firefox before 129, Safari before 17), or no WebCrypto at all
 * (`crypto.subtle` is missing outside a secure context: a TypeError). `webcrypto_failed`: anything else, which
 * includes the OperationError described above, after SESSION_KEYGEN_ATTEMPTS refusals; trying again can help there, not with the
 * first.
 */
export function sessionKeyFailure(e: unknown): SessionKeyFailure {
  const name = errorName(e);
  const error = name !== undefined && /^[A-Za-z]{1,40}$/u.test(name) ? name : undefined;
  const unsupported = name === 'NotSupportedError' || e instanceof TypeError || typeof globalThis.crypto?.subtle?.generateKey !== 'function';
  return { reason: unsupported ? 'webcrypto_unsupported' : 'webcrypto_failed', ...(error === undefined ? {} : { error }) };
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
 * A linked login's counter-1 signature: over the linked CKD payload, which binds the link token and its mode,
 * so nobody but the session key holder can add, swap, change or strip the link.
 */
export const signDeriveLinked = (privateKey: CryptoKey, pk1: string, pk2: string, linkJwt: string, immediate: boolean): Promise<Bytes> =>
  signSessionMessage(privateKey, 1, linkedCkdPayload(pk1, pk2, linkJwt, immediate));

/** create_session's `signature`: the proof of possession over createProofPayload, counter 0. */
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
