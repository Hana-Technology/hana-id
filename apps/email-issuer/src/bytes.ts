// Byte helpers and the session nonce preimage, kept here so the Worker doesn't pull @hana-id/core's root (Stellar and
// EVM code it never runs). The same definitions as @hana-id/core (bytes.ts, layouts.ts, display-safe.ts); the layout
// tests check the results byte for byte against the contract's worked examples, so a drift can't go unnoticed.
import { sha256 as nobleSha256 } from '@noble/hashes/sha2';

export type Bytes = Uint8Array<ArrayBuffer>;

const encoder = new TextEncoder();
export const utf8 = (s: string): Bytes => encoder.encode(s) as Bytes;
/** Strict UTF-8 decode: throws on invalid sequences. */
export const fromUtf8 = (b: Uint8Array): string => new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(b);

export function concatBytes(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Constant-time equality of two byte arrays (the length is not secret). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function u64le(n: number): Bytes {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`Not a u64 safe integer: ${n}`);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n), true);
  return out;
}

export function u32le(n: number): Bytes {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new RangeError(`Not a u32: ${n}`);
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
}

/** Borsh `String`: u32 LE byte length ‖ UTF-8 bytes. */
export function borshString(s: string): Bytes {
  const bytes = utf8(s);
  return concatBytes(u32le(bytes.length), bytes);
}

/** SHA-256 (synchronous, @noble/hashes). */
export const sha256 = (bytes: Uint8Array): Bytes => Uint8Array.from(nobleSha256(bytes));

export const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export function fromHex(hex: string): Bytes {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/u.test(hex)) throw new Error('Invalid hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function base64Encode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** Standard base64 (padding required) → bytes. Throws on anything else. */
export function base64Decode(text: string): Bytes {
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(text)) throw new Error('Invalid base64');
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export const base64UrlEncode = (bytes: Uint8Array): string => base64Encode(bytes).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');

/** base64url (no padding) → bytes. Throws on anything else. */
export function base64UrlDecode(text: string): Bytes {
  if (!/^[A-Za-z0-9_-]*$/u.test(text) || text.length % 4 === 1) throw new Error('Invalid base64url');
  const b64 = text.replace(/-/gu, '+').replace(/_/gu, '/');
  return base64Decode(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
}

// ---- the session nonce (docs/contract-interface.md "Session nonce"; @hana-id/core layouts.ts) ----

export const SESSION_NONCE_DOMAIN = 'hana-id/session/v1';
/** `key_index ≥ 2^31` is reserved (contract, API and SDK refuse it). */
export const KEY_INDEX_LIMIT = 0x7fffffff;
/** The contract's `max_uses` bound. */
export const MAX_USES_LIMIT = 500;

/**
 * "hana-id/session/v1" ‖ borsh(signer) ‖ borsh(scope_id) ‖ session_public_key (32) ‖ expires_at_ms u64 LE
 * ‖ key_index u32 LE ‖ max_uses u32 LE ‖ salt
 */
export function sessionNoncePreimage(i: { signer: string; scopeId: string; sessionPublicKey: Uint8Array; expiresAtMs: number; keyIndex: number; maxUses: number; salt: Uint8Array }): Bytes {
  if (i.sessionPublicKey.length !== 32) throw new Error('Session public key must be 32 bytes');
  if (i.salt.length < 16 || i.salt.length > 64) throw new Error('Salt must be 16-64 bytes');
  return concatBytes(utf8(SESSION_NONCE_DOMAIN), borshString(i.signer), borshString(i.scopeId), i.sessionPublicKey, u64le(i.expiresAtMs), u32le(i.keyIndex), u32le(i.maxUses), i.salt);
}

// ---- display safety (@hana-id/core display-safe.ts, D118): one-line text with no control or invisible character ----

const INVISIBLE = String.raw`\p{Cf}\p{Co}\p{Zl}\p{Zp}͏ᅟᅠ឴឵᠋-᠏ㅤ︀-️ﾠ\u{e0100}-\u{e01ef}`;
const UNSAFE_LINE = new RegExp(String.raw`[\p{Cc}${INVISIBLE}]`, 'u');
export const isDisplaySafeLine = (text: string): boolean => !UNSAFE_LINE.test(text);
