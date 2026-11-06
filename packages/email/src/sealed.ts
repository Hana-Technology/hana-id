// The sealed email (docs/email-sharing-spec.md "Where the address comes from", D419; docs/identity-token-spec.md "The
// sealed email", D127): how the email issuer hands the API a verified address through the vault, which can't read it.
//
//   sealed_email = "se1." ‖ b64url( u32le(key_id) ‖ u64le(not_after_ms) ‖ iv(12) ‖ ct )
//   ct           = AES-256-GCM(IDENTITY_SEAL_KEY[key_id], utf8(json{"email","src"}), aad)
//   aad          = "hana-id/sealed-email/v1" ‖ 0x00 ‖ borsh(app_id) ‖ session_pk(32) ‖ u64le(not_after_ms)
//
// The AAD is @hana-id/core's sealedEmailAad, pinned by core's identity vectors (test/sealed.test.ts checks this copy
// against them): a blob opens only for the app and the session it was sealed for, and only until `not_after_ms` (the
// session's on-chain expiry). Sealed by the issuer (apps/email-issuer), opened by the API (apps/api/src/identity/
// email.ts). IDENTITY_SEAL_KEY is `<id>:<base64 of 32 bytes>` with `id` 1..4294967295; a rotation seals with the new id
// while the API still opens the previous one (IDENTITY_SEAL_KEY_PREVIOUS).
//
// SECURITY: the plaintext is a person's address. Nothing here logs; errors name a reason, never the blob or address.

export const SEALED_EMAIL_PREFIX = 'se1.';
export const SEALED_EMAIL_AAD_DOMAIN = 'hana-id/sealed-email/v1';
export const SEAL_KEY_BYTES = 32;
/** The longest blob anyone accepts (the API's mint body allows 1024 characters). */
export const SEALED_EMAIL_MAX = 1024;
/** The longest address sealed (RFC 5321's path limit). */
export const SEALED_EMAIL_ADDRESS_MAX = 254;
const IV_BYTES = 12;
const HEADER_BYTES = 4 + 8;
const TAG_BYTES = 16;

export type SealedEmailSource = 'google' | 'email';

export interface SealKey {
  id: number;
  key: CryptoKey;
}

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

const u32le = (n: number): Uint8Array<ArrayBuffer> => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
const u64le = (n: number): Uint8Array<ArrayBuffer> => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
};
const concat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const borsh = (s: string): Uint8Array<ArrayBuffer> => {
  const b = enc.encode(s);
  return concat(u32le(b.length), b);
};

function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function b64urlDecode(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/u.test(text) || text.length % 4 === 1) return null;
  const bin = atob(text.replace(/-/gu, '+').replace(/_/gu, '/') + '='.repeat((4 - (text.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64Decode(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bin = atob(text);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** The AAD: exactly @hana-id/core's sealedEmailAad (core's vectors pin it). */
export function sealedEmailAad(appId: string, sessionPublicKey: Uint8Array, notAfterMs: number): Uint8Array<ArrayBuffer> {
  if (sessionPublicKey.length !== 32) throw new Error('Session public key must be 32 bytes');
  if (!Number.isSafeInteger(notAfterMs) || notAfterMs < 0) throw new Error('notAfterMs must be a non-negative integer');
  return concat(enc.encode(SEALED_EMAIL_AAD_DOMAIN), Uint8Array.of(0), borsh(appId), sessionPublicKey, u64le(notAfterMs));
}

const KEY_RE = /^([1-9]\d{0,9}):([A-Za-z0-9+/]{43}=)$/u;

/** An IDENTITY_SEAL_KEY value, or null when it is not `<id>:<base64 of 32 bytes>` (the value never reaches an error). */
export async function parseSealKey(value: string | undefined): Promise<SealKey | null> {
  const m = value ? KEY_RE.exec(value.trim()) : null;
  if (!m) return null;
  const id = Number(m[1]);
  if (id > 0xffffffff) return null;
  const raw = b64Decode(m[2]!);
  if (!raw || raw.length !== SEAL_KEY_BYTES) return null;
  const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  raw.fill(0);
  return { id, key };
}

export interface SealInput {
  appId: string;
  sessionPublicKey: Uint8Array;
  /** The session's expiry (the commitment's expiresAtMs): the blob opens until then. */
  notAfterMs: number;
  /** The address as verified (Google's, lowercased; or the normalized login address). */
  email: string;
  src: SealedEmailSource;
}

/** Seals one address for one app and session. Throws only on a malformed input (never with the address in it). */
export async function sealEmail(key: SealKey, i: SealInput): Promise<string> {
  if (typeof i.email !== 'string' || i.email.length < 3 || i.email.length > SEALED_EMAIL_ADDRESS_MAX || !i.email.includes('@')) throw new Error('Not an address to seal');
  if (i.src !== 'google' && i.src !== 'email') throw new Error('Unknown address source');
  const aad = sealedEmailAad(i.appId, i.sessionPublicKey, i.notAfterMs);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const pt = enc.encode(JSON.stringify({ email: i.email, src: i.src }));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key.key, pt));
  pt.fill(0);
  return SEALED_EMAIL_PREFIX + b64urlEncode(concat(u32le(key.id), u64le(i.notAfterMs), iv, ct));
}

export type OpenedEmail = { ok: true; email: string; src: SealedEmailSource; notAfterMs: number } | { ok: false; reason: 'malformed' | 'unknown_key' | 'expired' | 'bad_seal' };

/** The key id and expiry a blob names, or null when it isn't one (read before any key is tried). */
export function sealedEmailHeader(blob: unknown): { keyId: number; notAfterMs: number } | null {
  if (typeof blob !== 'string' || blob.length > SEALED_EMAIL_MAX || !blob.startsWith(SEALED_EMAIL_PREFIX)) return null;
  const bytes = b64urlDecode(blob.slice(SEALED_EMAIL_PREFIX.length));
  if (!bytes || bytes.length < HEADER_BYTES + IV_BYTES + TAG_BYTES + 1) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const notAfter = view.getBigUint64(4, true);
  if (notAfter > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { keyId: view.getUint32(0, true), notAfterMs: Number(notAfter) };
}

/**
 * Opens a blob for this app and session at `nowMs` with whichever of `keys` has its id. Every failure is a reason, never
 * an exception: a blob for another app or session, a tampered one and one sealed under a key not given are `bad_seal`
 * or `unknown_key`; one past its expiry `expired`.
 */
export async function openSealedEmail(keys: readonly SealKey[], blob: unknown, i: { appId: string; sessionPublicKey: Uint8Array; nowMs: number }): Promise<OpenedEmail> {
  const header = sealedEmailHeader(blob);
  if (!header) return { ok: false, reason: 'malformed' };
  const key = keys.find((k) => k.id === header.keyId);
  if (!key) return { ok: false, reason: 'unknown_key' };
  if (header.notAfterMs <= i.nowMs) return { ok: false, reason: 'expired' };
  const bytes = b64urlDecode((blob as string).slice(SEALED_EMAIL_PREFIX.length)) as Uint8Array<ArrayBuffer>;
  const iv = bytes.subarray(HEADER_BYTES, HEADER_BYTES + IV_BYTES);
  const ct = bytes.subarray(HEADER_BYTES + IV_BYTES);
  let pt: Uint8Array;
  try {
    pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: sealedEmailAad(i.appId, i.sessionPublicKey, header.notAfterMs) }, key.key, ct));
  } catch {
    return { ok: false, reason: 'bad_seal' };
  }
  try {
    const v = JSON.parse(dec.decode(pt)) as { email?: unknown; src?: unknown };
    const keysOk = v !== null && typeof v === 'object' && Object.keys(v).sort().join(',') === 'email,src';
    if (!keysOk || typeof v.email !== 'string' || v.email.length < 3 || v.email.length > SEALED_EMAIL_ADDRESS_MAX || !v.email.includes('@') || (v.src !== 'google' && v.src !== 'email')) {
      return { ok: false, reason: 'bad_seal' };
    }
    return { ok: true, email: v.email, src: v.src, notAfterMs: header.notAfterMs };
  } catch {
    return { ok: false, reason: 'bad_seal' };
  } finally {
    pt.fill(0);
  }
}
