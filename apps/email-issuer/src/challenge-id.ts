// Challenge ids (D197): 32 random bytes, b64url (43 characters), split into a public half (bytes 0–15) and a secret
// half (16–31). The challenge object is named by sha256 of the public half, and the address it keeps for resends is
// AES-256-GCM-encrypted under a key derived from the secret half, which only the client (the popup) holds. So the
// stored record, and any point-in-time copy of the object's storage, holds no readable address; the worker can read it
// only during a request that carries the full id.
import { base64UrlDecode, base64UrlEncode, concatBytes, fromUtf8, sha256, utf8 } from './bytes.ts';

export const CHALLENGE_EMAIL_DOMAIN = 'hana-id/challenge-email/v1';

export interface ChallengeId {
  /** What the client gets and sends back. */
  id: string;
  /** The Durable Object's name: "c:" + b64url(sha256(public half)). */
  name: string;
  pub: Uint8Array;
  sec: Uint8Array;
}

function split(raw: Uint8Array): ChallengeId {
  const pub = raw.subarray(0, 16);
  const sec = raw.subarray(16, 32);
  return { id: base64UrlEncode(raw), name: `c:${base64UrlEncode(sha256(pub))}`, pub, sec };
}

export const newChallengeId = (): ChallengeId => split(crypto.getRandomValues(new Uint8Array(32)));

/** The parts of a challenge id the client sent, or null when it isn't one. */
export function parseChallengeId(id: unknown): ChallengeId | null {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(id)) return null;
  let raw: Uint8Array;
  try {
    raw = base64UrlDecode(id);
  } catch {
    return null;
  }
  return raw.length === 32 ? split(raw) : null;
}

const aesKey = (c: ChallengeId): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', sha256(concatBytes(utf8(CHALLENGE_EMAIL_DOMAIN), Uint8Array.of(0), c.sec)), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

/** b64url(iv ‖ AES-GCM(address)), the public half as AAD. */
export async function encryptEmail(c: ChallengeId, email: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: c.pub }, await aesKey(c), utf8(email)));
  return base64UrlEncode(concatBytes(iv, ct));
}

/** The address, or null when `enc` doesn't open under this id (a wrong secret half, or a tampered record). */
export async function decryptEmail(c: ChallengeId, enc: string): Promise<string | null> {
  try {
    const raw = base64UrlDecode(enc);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12), additionalData: c.pub }, await aesKey(c), raw.subarray(12));
    return fromUtf8(new Uint8Array(pt));
  } catch {
    return null;
  }
}
