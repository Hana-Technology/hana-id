// The email identity's `sub` (docs/email-login-spec.md "`sub`: HMAC of the normalized email"). FROZEN at the address
// freeze: `sub` is in the CKD path `{scope}#email#{sub}#{key_index}`.
//
//   sub = "e1." ‖ b64url(HMAC-SHA256(K_sub, "hana-id/email-sub/v1" ‖ 0x00 ‖ utf8(normalized)))     (46 characters)
//
// K_sub is an input: this package never generates, stores, logs or returns it. Web Crypto only (Workers, browsers).

import { EMAIL_V1 } from './constants.ts';
import { isNormalizedEmail } from './normalize.ts';

/** `e1.` + 43 base64url characters of a 32-byte MAC; the last character carries 2 zero padding bits. */
const SUB_RE = /^e1\.[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

const encoder = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The exact bytes K_sub authenticates: `"hana-id/email-sub/v1" ‖ 0x00 ‖ utf8(normalized)`. */
export function subMessage(normalizedEmail: string): Uint8Array<ArrayBuffer> {
  const label = encoder.encode(EMAIL_V1.subLabel);
  const email = encoder.encode(normalizedEmail);
  const out = new Uint8Array(label.length + 1 + email.length);
  out.set(label, 0);
  out[label.length] = 0;
  out.set(email, label.length + 1);
  return out;
}

/** Imports K_sub (exactly 32 bytes) as a non-extractable HMAC-SHA256 signing key. The caller zeroes `raw`. */
export async function importSubKey(raw: Uint8Array): Promise<CryptoKey> {
  if (!(raw instanceof Uint8Array) || raw.length !== EMAIL_V1.subKeyBytes) {
    throw new TypeError(`K_sub must be ${EMAIL_V1.subKeyBytes} bytes`);
  }
  const copy = new Uint8Array(raw);
  try {
    return await crypto.subtle.importKey('raw', copy, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  } finally {
    copy.fill(0);
  }
}

function assertSubKey(key: CryptoKey): void {
  const alg = key.algorithm as Partial<HmacKeyAlgorithm>;
  if (
    key.type !== 'secret' ||
    alg.name !== 'HMAC' ||
    alg.hash?.name !== 'SHA-256' ||
    alg.length !== EMAIL_V1.subKeyBytes * 8 ||
    !key.usages.includes('sign')
  ) {
    throw new TypeError(`K_sub must be a ${EMAIL_V1.subKeyBytes}-byte HMAC-SHA256 signing key`);
  }
}

/**
 * `sub` of a normalized address. Throws a `TypeError` when `normalizedEmail` is not exactly `normalizeEmail`'s
 * output (so a raw, unnormalized address can never reach the HMAC) or the key is not a 32-byte HMAC-SHA256 key.
 * Pass a `CryptoKey` from {@link importSubKey} (preferred: imported once, non-extractable) or the raw 32 bytes.
 */
export async function emailSub(key: CryptoKey | Uint8Array, normalizedEmail: string): Promise<string> {
  if (!isNormalizedEmail(normalizedEmail)) throw new TypeError('emailSub needs a normalized address (normalizeEmail)');
  const k = key instanceof Uint8Array ? await importSubKey(key) : key;
  assertSubKey(k);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', k, subMessage(normalizedEmail)));
  return EMAIL_V1.subPrefix + b64url(mac);
}

/** True for a well-formed `e1.` sub (shape only: says nothing about which address it is). */
export function isEmailSub(sub: unknown): sub is string {
  return typeof sub === 'string' && SUB_RE.test(sub);
}
