// Login relay payload (docs/batch-b-spec.md "Login" steps 6 and 7): the callback page encrypts Google's answer under
// `relayKey` (AES-GCM-256, 12-byte random IV, AAD = relayAad(relayId)) and the vault (or the export window) decrypts
// it. The API stores only `{iv, ct}` and can neither read nor replace the token.
//
// SECURITY: the plaintext holds a Google ID token. Never log it; drop it once verified.
import { base64UrlDecode, base64UrlEncode, fromUtf8, toBytes, utf8 } from './bytes.ts';
import { relayAad } from './layouts.ts';

export const RELAY_IV_BYTES = 12;
export const RELAY_KEY_BYTES = 32;
/** The relay's body cap (8 KiB, enforced by the API too). */
export const RELAY_MAX_BODY_BYTES = 8192;
const GOOGLE_ERROR = /^[a-z_]{1,64}$/u;

/** What Google returned: a token, or its `error` code. */
export type RelayPayload = { idToken: string } | { error: string };

/** The relay slot value, base64url. */
export interface RelayCiphertext {
  iv: string;
  ct: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** True for exactly `{idToken: string}` or `{error: ^[a-z_]{1,64}$}`. */
export function isRelayPayload(v: unknown): v is RelayPayload {
  if (!isObj(v)) return false;
  const keys = Object.keys(v);
  if (keys.length !== 1) return false;
  if (keys[0] === 'idToken') return typeof v.idToken === 'string' && v.idToken.length > 0 && v.idToken.length <= 4096;
  if (keys[0] === 'error') return typeof v.error === 'string' && GOOGLE_ERROR.test(v.error);
  return false;
}

async function importKey(relayKey: Uint8Array, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  if (relayKey.length !== RELAY_KEY_BYTES) throw new Error(`relayKey must be ${RELAY_KEY_BYTES} bytes`);
  // importKey keeps its own copy: the one made for it is zeroed straight after.
  const raw = toBytes(relayKey);
  try {
    return await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [usage]);
  } finally {
    raw.fill(0);
  }
}

/** Encrypts the callback's payload for `relayId`. */
export async function encryptRelayPayload(relayKey: Uint8Array, relayId: string, payload: RelayPayload): Promise<RelayCiphertext> {
  if (!isRelayPayload(payload)) throw new Error('Malformed relay payload');
  const key = await importKey(relayKey, 'encrypt');
  const iv = crypto.getRandomValues(new Uint8Array(RELAY_IV_BYTES));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: relayAad(relayId) }, key, utf8(JSON.stringify(payload))));
  return { iv: base64UrlEncode(iv), ct: base64UrlEncode(ct) };
}

/** Decrypts and validates a relay slot value. Throws (without detail) if it doesn't decrypt under `relayKey` for `relayId`. */
export async function decryptRelayPayload(relayKey: Uint8Array, relayId: string, value: RelayCiphertext): Promise<RelayPayload> {
  const key = await importKey(relayKey, 'decrypt');
  let plain: Uint8Array;
  try {
    const iv = base64UrlDecode(value.iv);
    if (iv.length !== RELAY_IV_BYTES) throw new Error('bad iv');
    plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: relayAad(relayId) }, key, base64UrlDecode(value.ct)));
  } catch {
    throw new Error('The relay payload does not decrypt');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromUtf8(plain));
  } catch {
    parsed = null;
  } finally {
    plain.fill(0);
  }
  if (!isRelayPayload(parsed)) throw new Error('Malformed relay payload');
  return parsed;
}
