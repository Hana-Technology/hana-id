// The login popup's first-party sessionStorage entry (docs/batch-b-spec.md "Login" steps 4 and 6). /login stores
// `{v, createdAt, relayKey}` under `hana.login.<relayId>` before it navigates to Google; /login/callback, in the same
// browsing context and so the same sessionStorage, takes it exactly once. The `state` check therefore needs both a
// state that /login itself started and the relayKey stored with it, and a reused state finds nothing.
//
// SECURITY: relayKey is a session secret. It lives here only between the two pages and is deleted on first read.
import { RELAY_ID_PATTERN, RELAY_KEY_BYTES, base64UrlDecode, base64UrlEncode } from '@hana-id/core';

export const LOGIN_ENTRY_PREFIX = 'hana.login.';
/** Entries older than this are deleted unused (a login never takes that long). */
export const LOGIN_ENTRY_MAX_AGE_MS = 10 * 60_000;

interface LoginEntry {
  v: 1;
  createdAt: number;
  relayKey: string;
}

function readEntry(storage: Storage, key: string): LoginEntry | null {
  try {
    const v: unknown = JSON.parse(storage.getItem(key) ?? 'null');
    if (typeof v !== 'object' || v === null) return null;
    const e = v as Record<string, unknown>;
    if (e.v !== 1 || !Number.isSafeInteger(e.createdAt) || typeof e.relayKey !== 'string') return null;
    return { v: 1, createdAt: e.createdAt as number, relayKey: e.relayKey };
  } catch {
    return null;
  }
}

/** Deletes every `hana.login.*` entry older than 10 min, or unreadable. */
export function pruneLoginEntries(storage: Storage, now: number): void {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k?.startsWith(LOGIN_ENTRY_PREFIX)) keys.push(k);
  }
  for (const k of keys) {
    const e = readEntry(storage, k);
    if (!e || now - e.createdAt > LOGIN_ENTRY_MAX_AGE_MS || e.createdAt > now + LOGIN_ENTRY_MAX_AGE_MS) storage.removeItem(k);
  }
}

/** Stores the relayKey for `relayId` (pruning old entries first). Throws if storage is unavailable. */
export function storeLoginEntry(storage: Storage, relayId: string, relayKey: Uint8Array, now: number): void {
  if (!RELAY_ID_PATTERN.test(relayId)) throw new Error('Malformed relayId');
  if (relayKey.length !== RELAY_KEY_BYTES) throw new Error('Malformed relayKey');
  pruneLoginEntries(storage, now);
  storage.setItem(LOGIN_ENTRY_PREFIX + relayId, JSON.stringify({ v: 1, createdAt: now, relayKey: base64UrlEncode(relayKey) } satisfies LoginEntry));
}

/**
 * Takes the relayKey stored for `state` and deletes the entry (single use), or null when there is none, it is older
 * than 10 min, or it is malformed. A storage error counts as no entry.
 */
export function takeLoginEntry(storage: Storage, state: string, now: number): Uint8Array | null {
  if (!RELAY_ID_PATTERN.test(state)) return null;
  const key = LOGIN_ENTRY_PREFIX + state;
  try {
    const e = readEntry(storage, key);
    storage.removeItem(key);
    if (!e || now - e.createdAt > LOGIN_ENTRY_MAX_AGE_MS) return null;
    const relayKey = base64UrlDecode(e.relayKey);
    return relayKey.length === RELAY_KEY_BYTES ? relayKey : null;
  } catch {
    return null;
  }
}
