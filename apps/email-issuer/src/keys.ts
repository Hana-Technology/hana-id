// The issuer's HMAC keys, imported once per isolate as non-extractable Web Crypto keys, and the values derived from
// them. K_sub feeds `sub` through @hana-id/email (the only place `sub` is computed); K_code hashes codes; K_rl keys the
// limiters and suppressions (spec "Rate limits and abuse": a separate key, so limiter state never holds an on-chain id).
// Never logged.
import { base64Decode, base64UrlEncode, concatBytes, sha256, toHex, utf8 } from './bytes.ts';
import { importSubKey } from '@hana-id/email';

export class KeysUnavailable extends Error {}

export interface IssuerKeys {
  sub: CryptoKey;
  code: CryptoKey;
  rl: CryptoKey;
}

function raw32(value: string | undefined, name: string): Uint8Array {
  if (!value || !/^[A-Za-z0-9+/]{43}=$/u.test(value)) throw new KeysUnavailable(`${name} is not set`);
  const bytes = base64Decode(value);
  if (bytes.length !== 32) throw new KeysUnavailable(`${name} is not 32 bytes`);
  return bytes;
}

const hmacKey = (raw: Uint8Array): Promise<CryptoKey> => crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);

export async function importKeys(env: { EMAIL_SUB_KEY?: string | undefined; EMAIL_CODE_KEY?: string | undefined; EMAIL_RL_KEY?: string | undefined }): Promise<IssuerKeys> {
  const sub = raw32(env.EMAIL_SUB_KEY, 'EMAIL_SUB_KEY');
  const code = raw32(env.EMAIL_CODE_KEY, 'EMAIL_CODE_KEY');
  const rl = raw32(env.EMAIL_RL_KEY, 'EMAIL_RL_KEY');
  if (sub.every((b, i) => b === code[i]) || sub.every((b, i) => b === rl[i]) || code.every((b, i) => b === rl[i])) throw new KeysUnavailable('the three keys must differ');
  try {
    const keys = { sub: await importSubKey(sub), code: await hmacKey(code), rl: await hmacKey(rl) };
    return keys;
  } finally {
    sub.fill(0);
    code.fill(0);
    rl.fill(0);
  }
}

const mac = async (key: CryptoKey, data: Uint8Array): Promise<string> => base64UrlEncode(new Uint8Array(await crypto.subtle.sign('HMAC', key, data)));

/**
 * The mailbox key = HMAC-SHA256(K_rl, mailbox), b64url, where `mailbox` is `normalizeEmail(...).mailbox` (the normalized
 * address without its `+tag`, D159): the key of every per-mailbox limit and of suppressions, so cycling tags neither
 * mails one inbox without bound nor escapes a bounce.
 */
export const mailboxKey = (keys: IssuerKeys, mailbox: string): Promise<string> => mac(keys.rl, utf8(mailbox));

/** A requester inside a mailbox object: the first 16 bytes of sha256(IP subject), hex (never the raw address). */
export const requesterKey = (ipSubject: string): string => toHex(sha256(utf8(ipSubject)).subarray(0, 16));

/** HMAC-SHA256(K_code, challengeId ‖ code), b64url (challengeId is fixed-length, so the concatenation is unambiguous). */
export const codeMac = (keys: IssuerKeys, challengeId: string, code: string): Promise<string> => mac(keys.code, concatBytes(utf8(challengeId), utf8(code)));

/** 32 random bytes, b64url (challenge ids, link tickets). */
export function randomId(bytes = 32): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return base64UrlEncode(b);
}

/** Codes are exactly 6 decimal digits. */
export const CODE_RE = /^\d{6}$/u;

/**
 * A 6-digit code from crypto.getRandomValues with rejection sampling: a u32 is drawn and redrawn while it falls in the
 * top partial range, so every code is equally likely (no modulo bias). `random` is injectable for the test.
 */
export function newCode(random: (out: Uint32Array) => Uint32Array = (o) => crypto.getRandomValues(o)): string {
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  const buf = new Uint32Array(1);
  for (let i = 0; i < 1000; i++) {
    const v = random(buf)[0]!;
    if (v < limit) return String(v % 1_000_000).padStart(6, '0');
  }
  throw new Error('random source keeps returning out-of-range values');
}
