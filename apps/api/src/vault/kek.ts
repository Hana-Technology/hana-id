// Envelope encryption of vault shares. A share's K_s (32 bytes) is stored only as
//   share_enc = iv (12) ‖ AES-256-GCM(KEK, iv, K_s, aad = share_id (16) ‖ utf8(app_id) ‖ session_pk (32))
// so D1 alone never yields K_s, and a row's ciphertext can't be moved to another share, app or session key.
//
// VAULT_KEK is `<id>:<base64 of 32 bytes>`; `id` (a positive integer) is stored with each row as `kek_id`. To rotate:
// set VAULT_KEK_PREVIOUS to the current value and VAULT_KEK to a new key with a new id; rows under the previous key
// are re-wrapped on their next unlock and by the hourly cron (vault/cron.ts). Once no row has the old id, remove
// VAULT_KEK_PREVIOUS.
import { base64Decode, concatBytes } from '../bytes.ts';
import type { Env } from '../env.ts';

export const KEK_BYTES = 32;
export const SHARE_KEY_BYTES = 32;
const IV_BYTES = 12;
const KEK_RE = /^([1-9]\d{0,8}):([A-Za-z0-9+/]{43}=)$/u;

export interface Kek {
  id: number;
  key: CryptoKey;
}

export interface Keks {
  current: Kek;
  previous: Kek | null;
}

/** A KEK secret, or null when it is not `<id>:<base64 of 32 bytes>`. Never includes the value in errors or logs. */
export async function parseKek(value: string | undefined): Promise<Kek | null> {
  const m = value ? KEK_RE.exec(value.trim()) : null;
  if (!m) return null;
  const raw = base64Decode(m[2]!);
  if (raw.length !== KEK_BYTES) return null;
  const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  raw.fill(0);
  return { id: Number(m[1]), key };
}

/** Parsed keys per secret value: an isolate imports each key once. */
const cache = new Map<string, Promise<Keks | null>>();

/**
 * The configured KEKs, or null when VAULT_KEK is missing or malformed, or VAULT_KEK_PREVIOUS is set but malformed or
 * has the current key's id (the vault endpoints then answer 503 rather than write rows under an ambiguous id).
 */
export function loadKeks(env: Pick<Env, 'VAULT_KEK' | 'VAULT_KEK_PREVIOUS'>): Promise<Keks | null> {
  const cacheKey = `${env.VAULT_KEK ?? ''}\n${env.VAULT_KEK_PREVIOUS ?? ''}`;
  let hit = cache.get(cacheKey);
  if (!hit) {
    hit = (async () => {
      const current = await parseKek(env.VAULT_KEK);
      if (!current) return null;
      if (!env.VAULT_KEK_PREVIOUS) return { current, previous: null };
      const previous = await parseKek(env.VAULT_KEK_PREVIOUS);
      return previous && previous.id !== current.id ? { current, previous } : null;
    })();
    if (cache.size >= 4) cache.clear();
    cache.set(cacheKey, hit);
  }
  return hit;
}

/** The KEK a row's `kek_id` names, or null when neither configured key has that id. */
export function kekFor(keks: Keks, kekId: number): Kek | null {
  if (keks.current.id === kekId) return keks.current;
  return keks.previous?.id === kekId ? keks.previous : null;
}

export interface ShareBinding {
  shareId: Uint8Array;
  appId: string;
  sessionPk: Uint8Array;
}

const aad = (b: ShareBinding): Uint8Array => concatBytes(b.shareId, new TextEncoder().encode(b.appId), b.sessionPk);

/** iv ‖ AES-GCM(kek, iv, ks, aad(binding)). */
export async function wrapShareKey(kek: Kek, binding: ShareBinding, ks: Uint8Array): Promise<Uint8Array> {
  if (ks.length !== SHARE_KEY_BYTES) throw new Error('K_s must be 32 bytes');
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(binding) }, kek.key, ks));
  return concatBytes(iv, ct);
}

/** K_s from `shareEnc`, or null if it does not authenticate under `kek` for `binding`. */
export async function unwrapShareKey(kek: Kek, binding: ShareBinding, shareEnc: Uint8Array): Promise<Uint8Array | null> {
  if (shareEnc.length !== IV_BYTES + SHARE_KEY_BYTES + 16) return null;
  try {
    const ks = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: shareEnc.subarray(0, IV_BYTES), additionalData: aad(binding) }, kek.key, shareEnc.subarray(IV_BYTES)),
    );
    return ks.length === SHARE_KEY_BYTES ? ks : null;
  } catch {
    return null;
  }
}

/** Tests only. */
export function clearKekCache(): void {
  cache.clear();
}
