// The issuer's HMAC keys, imported once per isolate as non-extractable Web Crypto keys, and the values derived from
// them. Never logged.
// - K_sub feeds `sub` through @hana-id/email (the only place `sub` is computed). Never rotated. A second key derived
//   from it, K_sup = HMAC(K_sub, "hana-id/suppression-key/v1"), keys suppressions, so they survive any rotation of K_rl
//   or K_code (D199).
// - K_code hashes codes. A key derived from it, K_device = HMAC(K_code, "hana-id/device-ticket-key/v1"), signs owner
//   device tickets (D198): rotating K_code voids every ticket.
// - K_rl keys the rate limits (spec "Rate limits and abuse": a separate key, so limiter state never holds an on-chain
//   id). Rotating it only resets limit windows.
import { base64Decode, base64UrlDecode, base64UrlEncode, bytesEqual, concatBytes, sha256, toHex, u64le, utf8 } from './bytes.ts';
import { importSubKey } from '@hana-id/email';

export class KeysUnavailable extends Error {}

export interface IssuerKeys {
  sub: CryptoKey;
  code: CryptoKey;
  rl: CryptoKey;
  /** K_sup: suppressions (derived from K_sub). */
  sup: CryptoKey;
  /** K_device: owner device tickets (derived from K_code). */
  device: CryptoKey;
}

function raw32(value: string | undefined, name: string): Uint8Array {
  if (!value || !/^[A-Za-z0-9+/]{43}=$/u.test(value)) throw new KeysUnavailable(`${name} is not set`);
  const bytes = base64Decode(value);
  if (bytes.length !== 32) throw new KeysUnavailable(`${name} is not 32 bytes`);
  return bytes;
}

const hmacKey = (raw: Uint8Array): Promise<CryptoKey> => crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
const macBytes = async (key: CryptoKey, data: Uint8Array): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
const mac = async (key: CryptoKey, data: Uint8Array): Promise<string> => base64UrlEncode(await macBytes(key, data));

/** A key derived from `parent` for one purpose: HMAC(parent, label), imported as a non-extractable HMAC key. */
async function derived(parent: CryptoKey, label: string): Promise<CryptoKey> {
  const raw = await macBytes(parent, utf8(label));
  try {
    return await hmacKey(raw);
  } finally {
    raw.fill(0);
  }
}

export const SUPPRESSION_KEY_LABEL = 'hana-id/suppression-key/v1';
export const DEVICE_TICKET_KEY_LABEL = 'hana-id/device-ticket-key/v1';

export async function importKeys(env: { EMAIL_SUB_KEY?: string | undefined; EMAIL_CODE_KEY?: string | undefined; EMAIL_RL_KEY?: string | undefined }): Promise<IssuerKeys> {
  const sub = raw32(env.EMAIL_SUB_KEY, 'EMAIL_SUB_KEY');
  const code = raw32(env.EMAIL_CODE_KEY, 'EMAIL_CODE_KEY');
  const rl = raw32(env.EMAIL_RL_KEY, 'EMAIL_RL_KEY');
  if (sub.every((b, i) => b === code[i]) || sub.every((b, i) => b === rl[i]) || code.every((b, i) => b === rl[i])) throw new KeysUnavailable('the three keys must differ');
  try {
    const subKey = await importSubKey(sub);
    const codeKey = await hmacKey(code);
    // K_sub's own key object only signs `sub` messages; K_sup comes from a separate HMAC key over the same bytes.
    const subHmac = await hmacKey(sub);
    return { sub: subKey, code: codeKey, rl: await hmacKey(rl), sup: await derived(subHmac, SUPPRESSION_KEY_LABEL), device: await derived(codeKey, DEVICE_TICKET_KEY_LABEL) };
  } finally {
    sub.fill(0);
    code.fill(0);
    rl.fill(0);
  }
}

/**
 * The mailbox key = HMAC-SHA256(K_rl, "mailbox" ‖ 0x00 ‖ mailbox), b64url, where `mailbox` is `normalizeEmail(...).mailbox`
 * (the normalized address without its `+tag`, D159): the key of the per-mailbox **rate limits only**, so cycling tags
 * can't mail one inbox without bound. Never a suppression key: on a domain where `+` isn't sub-addressing,
 * `victim+x@domain` is another person's mailbox (D199).
 */
export const mailboxKey = (keys: IssuerKeys, mailbox: string): Promise<string> => mac(keys.rl, concatBytes(utf8('mailbox'), Uint8Array.of(0), utf8(mailbox)));

/** A recipient domain's limiter key (its registrable domain), under K_rl. */
export const domainKey = (keys: IssuerKeys, registrableDomain: string): Promise<string> => mac(keys.rl, concatBytes(utf8('domain'), Uint8Array.of(0), utf8(registrableDomain)));

/**
 * `email_key` of a suppression = HMAC-SHA256(K_sup, exact normalized address), b64url: a bounce or complaint suppresses
 * exactly the address it came from, `+tag` included.
 */
export const suppressionKey = (keys: IssuerKeys, normalized: string): Promise<string> => mac(keys.sup, utf8(normalized));

/** A requester inside a mailbox object: the first 16 bytes of sha256(IP subject), hex (never the raw address). */
export const requesterKey = (ipSubject: string): string => toHex(sha256(utf8(ipSubject)).subarray(0, 16));

/** HMAC-SHA256(K_code, challengeId ‖ code), b64url (challengeId is fixed-length, so the concatenation is unambiguous). */
export const codeMac = (keys: IssuerKeys, challengeId: string, code: string): Promise<string> => mac(keys.code, concatBytes(utf8(challengeId), utf8(code)));

// ---- owner device tickets (D198) ----

export const DEVICE_TICKET_PREFIX = 'dt1.';
export const DEVICE_TICKET_DOMAIN = 'hana-id/device-ticket/v1';
/** A device ticket is valid 30 days from the `verify` that issued it. */
export const DEVICE_TICKET_TTL_MS = 30 * 86_400_000;

const ticketMessage = (mailbox: string, expMs: number): Uint8Array => concatBytes(utf8(DEVICE_TICKET_DOMAIN), Uint8Array.of(0), utf8(mailbox), Uint8Array.of(0), u64le(expMs));

/**
 * An opaque owner device ticket for the mailbox `mailboxKeyValue`: "dt1." + b64url(expiry u64 LE ms ‖ HMAC(K_device,
 * domain ‖ 0 ‖ mailbox key ‖ 0 ‖ expiry)). Only a successful `verify` issues one, so only someone who read a code at that
 * mailbox can hold it. The popup keeps it on `authOrigin` (batch 8).
 */
export async function deviceTicket(keys: IssuerKeys, mailboxKeyValue: string, now: number): Promise<string> {
  const exp = now + DEVICE_TICKET_TTL_MS;
  const m = await macBytes(keys.device, ticketMessage(mailboxKeyValue, exp));
  return DEVICE_TICKET_PREFIX + base64UrlEncode(concatBytes(u64le(exp), m));
}

/** Whether `ticket` is a live device ticket for this mailbox (constant-time MAC check). */
export async function isDeviceTicketFor(keys: IssuerKeys, ticket: unknown, mailboxKeyValue: string, now: number): Promise<boolean> {
  if (typeof ticket !== 'string' || !ticket.startsWith(DEVICE_TICKET_PREFIX) || ticket.length !== DEVICE_TICKET_PREFIX.length + 54) return false;
  let raw: Uint8Array;
  try {
    raw = base64UrlDecode(ticket.slice(DEVICE_TICKET_PREFIX.length));
  } catch {
    return false;
  }
  if (raw.length !== 40) return false;
  const exp = Number(new DataView(raw.buffer, raw.byteOffset, 8).getBigUint64(0, true));
  if (!(exp > now) || exp > now + DEVICE_TICKET_TTL_MS + 60_000) return false;
  return bytesEqual(raw.subarray(8), await macBytes(keys.device, ticketMessage(mailboxKeyValue, exp)));
}

/** 32 random bytes, b64url (link tickets). */
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
