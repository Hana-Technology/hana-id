// The login popup's first-party sessionStorage entry (docs/batch-b-spec.md "Login" steps 4 and 6). /login stores
// `{v, createdAt, relayKey}` (plus, for a pk_test_ app, `t`: its own stage durations) under `hana.login.<relayId>`
// before it navigates to Google; /login/callback, in the same browsing context and so the same sessionStorage, takes
// it exactly once. The `state` check therefore needs both a
// state that /login itself started and the relayKey stored with it, and a reused state finds nothing.
//
// SECURITY: relayKey is a session secret. It lives here only between the two pages and is deleted on first read.
import { RELAY_ID_PATTERN, RELAY_KEY_BYTES, base64UrlDecode, base64UrlEncode, isTimings } from '@hana-id/core';

export const LOGIN_ENTRY_PREFIX = 'hana.login.';
/** Entries older than this are deleted unused (a login never takes that long). */
export const LOGIN_ENTRY_MAX_AGE_MS = 10 * 60_000;

interface LoginEntry {
  v: 1;
  createdAt: number;
  relayKey: string;
  /** pk_test_ apps: /login's stage durations (ms), which the callback forwards to the vault in the relay slot. */
  t?: Record<string, number>;
}

/** What /login/callback takes: the relay key and /login's timings (null for a pk_live_ app). */
export interface TakenLogin {
  relayKey: Uint8Array;
  timings: Record<string, number> | null;
}

function readEntry(storage: Storage, key: string): LoginEntry | null {
  try {
    const v: unknown = JSON.parse(storage.getItem(key) ?? 'null');
    if (typeof v !== 'object' || v === null) return null;
    const e = v as Record<string, unknown>;
    if (e.v !== 1 || !Number.isSafeInteger(e.createdAt) || typeof e.relayKey !== 'string') return null;
    return { v: 1, createdAt: e.createdAt as number, relayKey: e.relayKey, ...(isTimings(e.t) ? { t: e.t } : {}) };
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

/**
 * Stores the relayKey for `relayId` (pruning old entries first), with /login's timings for a pk_test_ app. Throws if
 * storage is unavailable.
 */
export function storeLoginEntry(storage: Storage, relayId: string, relayKey: Uint8Array, now: number, timings?: Record<string, number>): void {
  if (!RELAY_ID_PATTERN.test(relayId)) throw new Error('Malformed relayId');
  if (relayKey.length !== RELAY_KEY_BYTES) throw new Error('Malformed relayKey');
  pruneLoginEntries(storage, now);
  const entry: LoginEntry = { v: 1, createdAt: now, relayKey: base64UrlEncode(relayKey), ...(timings && isTimings(timings) ? { t: timings } : {}) };
  storage.setItem(LOGIN_ENTRY_PREFIX + relayId, JSON.stringify(entry));
}

/**
 * Adds stage durations to the entry's timings (/login's `choose`, after the user picked a method). Only an entry that
 * already has timings (a pk_test_ app's) gets them; the relay key is left as it is. Best effort: never throws.
 */
export function addLoginTimings(storage: Storage, relayId: string, timings: Record<string, number>): void {
  if (!RELAY_ID_PATTERN.test(relayId)) return;
  const key = LOGIN_ENTRY_PREFIX + relayId;
  try {
    const e = readEntry(storage, key);
    if (!e?.t) return;
    const t = { ...e.t, ...timings };
    if (!isTimings(t)) return;
    storage.setItem(key, JSON.stringify({ ...e, t }));
  } catch {
    // The timings only lose this stage.
  }
}

/**
 * Takes the relayKey stored for `state` and deletes the entry (single use), or null when there is none, it is older
 * than 10 min, or it is malformed. A storage error counts as no entry.
 */
export function takeLoginEntry(storage: Storage, state: string, now: number): Uint8Array | null {
  return takeLogin(storage, state, now)?.relayKey ?? null;
}

/** As takeLoginEntry, with /login's timings (a pk_test_ app's) as well. */
export function takeLogin(storage: Storage, state: string, now: number): TakenLogin | null {
  if (!RELAY_ID_PATTERN.test(state)) return null;
  const key = LOGIN_ENTRY_PREFIX + state;
  try {
    const e = readEntry(storage, key);
    storage.removeItem(key);
    if (!e || now - e.createdAt > LOGIN_ENTRY_MAX_AGE_MS) return null;
    const relayKey = base64UrlDecode(e.relayKey);
    return relayKey.length === RELAY_KEY_BYTES ? { relayKey, timings: e.t ?? null } : null;
  } catch {
    return null;
  }
}
