// The login popup's first-party sessionStorage entry (docs/batch-b-spec.md "Login" steps 4 and 6). /login stores
// `{v, createdAt, relayKey}` (plus, for a pk_test_ app, `t`: its own stage durations) under `hana.login.<relayId>`
// before it navigates to Google; /login/callback, in the same browsing context and so the same sessionStorage, takes
// it exactly once. The `state` check therefore needs both a
// state that /login itself started and the relayKey stored with it, and a reused state finds nothing.
//
// Linking (build plan batch 8b), in a login of an app with email: the entry also carries the follow-up channel's key
// (`f`), and each later leg of the login stores an entry of its own under the slot it answers (its OAuth `state`):
// the second Google request's (`leg: 'access'`), a proof the vault asked for (`leg: 'proof'`), and the email step's
// follow-up mode (`next`: the vault's next notice slot). `home` names the login (its first slot, `hana.email.<home>`);
// `b` is case B's "Link and continue" (D139); `c` the Google client, `i` that the interactive retry was spent; `task`
// marks a `hana.linkAccount` popup.
// token_first (D270, auth/google.ts): `tf` marks a login whose Google request asked for the access token first, `n`
// is the login's nonce (the ID token request after it needs it), `leg: 'id'` that ID token request's entry, `h` its
// `login_hint`, and `r` a record-only login (an app without email login: no follow-up mode, the window closes).
// A cancel on Google's screen (D341): `bk` says where token_first's Google step returns (Hana's method chooser, or case
// B's own choices with `ob`, the link the issuer offered there); `x` marks the entry the callback parks under the
// login's slot for that screen (no Google answer may use it: the email page takes it on load); `s` is the relay slot an
// attempt started after it (or from case B) answers, under an OAuth `state` of its own, so a cancelled attempt's state
// never finds an entry again.
//
// SECURITY: relayKey and followKey are session secrets. They live here only between pages and are deleted on read.
import { type CaseBProof, FOLLOW_KEY_BYTES, RELAY_ID_PATTERN, RELAY_KEY_BYTES, base64UrlDecode, base64UrlEncode, isTimings } from '@hana-id/core';

export const LOGIN_ENTRY_PREFIX = 'hana.login.';
/** Entries older than this are deleted unused (a login never takes that long). */
export const LOGIN_ENTRY_MAX_AGE_MS = 10 * 60_000;

/** The batch 8b parts of an entry (all optional; a Google-only login's entry has none). */
export interface FollowEntry {
  /** The follow-up channel's key. */
  followKey?: Uint8Array;
  /** The login's first slot (its relayId), for a later leg's entry. */
  home?: string;
  /** The vault's next notice slot, once this leg is relayed. */
  next?: number;
  leg?: 'access' | 'proof' | 'id';
  caseB?: CaseBProof;
  clientId?: string;
  interactive?: boolean;
  /** The access leg and token_first's ID leg: the Google `sub` the request asks for (its `login_hint`). */
  loginHint?: string;
  task?: boolean;
  /** token_first: the login's Google request asked for the access token first (auth/google.ts). */
  tokenFirst?: boolean;
  /** token_first: the login's nonce, for the ID token request after the access token. */
  nonce?: string;
  /** token_first in an app without email login: the access token is for the issuer's directory only; no follow-up mode. */
  record?: boolean;
  /** D341: the relay slot this Google attempt answers, when its OAuth `state` is a fresh one (not the slot's id). */
  slot?: string;
  /** D341: where a cancel on token_first's Google screen returns: Hana's method chooser, or case B's own choices. */
  back?: 'chooser' | 'case_b';
  /** D341: case B's link offer (the issuer's ticket), so its "Link and continue" can be offered again after a cancel. */
  offer?: CaseBProof;
  /** D341: parked by the callback after a cancel, for the email page's return screen; never a Google answer's entry. */
  cancelled?: boolean;
}

interface LoginEntry {
  v: 1;
  createdAt: number;
  relayKey: string;
  /** pk_test_ apps: /login's stage durations (ms), which the callback forwards to the vault in the relay slot. */
  t?: Record<string, number>;
  f?: string;
  home?: string;
  next?: number;
  leg?: 'access' | 'proof' | 'id';
  b?: CaseBProof;
  c?: string;
  i?: 1;
  h?: string;
  task?: 1;
  tf?: 1;
  n?: string;
  r?: 1;
  s?: string;
  bk?: 'c' | 'b';
  ob?: CaseBProof;
  x?: 1;
}

/** What /login/callback takes: the relay key and /login's timings (null for a pk_live_ app). */
export interface TakenLogin extends FollowEntry {
  relayKey: Uint8Array;
  timings: Record<string, number> | null;
}

/** A session nonce (core protocol.ts `isNonce`). */
const NONCE = /^[A-Za-z0-9_-]{43}$/u;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCaseB = (v: unknown): v is CaseBProof =>
  isObj(v) && typeof v.linkTicket === 'string' && /^[A-Za-z0-9_-]{22,64}$/u.test(v.linkTicket) && typeof v.emailSub === 'string' && /^e1\.[A-Za-z0-9_-]{43}$/u.test(v.emailSub);

function readEntry(storage: Storage, key: string): LoginEntry | null {
  try {
    const v: unknown = JSON.parse(storage.getItem(key) ?? 'null');
    if (typeof v !== 'object' || v === null) return null;
    const e = v as Record<string, unknown>;
    if (e.v !== 1 || !Number.isSafeInteger(e.createdAt) || typeof e.relayKey !== 'string') return null;
    return {
      v: 1,
      createdAt: e.createdAt as number,
      relayKey: e.relayKey,
      ...(isTimings(e.t) ? { t: e.t } : {}),
      ...(typeof e.f === 'string' ? { f: e.f } : {}),
      ...(typeof e.home === 'string' && RELAY_ID_PATTERN.test(e.home) ? { home: e.home } : {}),
      ...(Number.isInteger(e.next) && (e.next as number) >= 2 && (e.next as number) <= 12 ? { next: e.next as number } : {}),
      ...(e.leg === 'access' || e.leg === 'proof' || e.leg === 'id' ? { leg: e.leg } : {}),
      ...(isCaseB(e.b) ? { b: { linkTicket: e.b.linkTicket, emailSub: e.b.emailSub } } : {}),
      ...(typeof e.c === 'string' && e.c.length <= 256 ? { c: e.c } : {}),
      ...(e.i === 1 ? { i: 1 as const } : {}),
      ...(typeof e.h === 'string' && /^[0-9A-Za-z_-]{1,255}$/u.test(e.h) ? { h: e.h } : {}),
      ...(e.task === 1 ? { task: 1 as const } : {}),
      ...(e.tf === 1 ? { tf: 1 as const } : {}),
      ...(typeof e.n === 'string' && NONCE.test(e.n) ? { n: e.n } : {}),
      ...(e.r === 1 ? { r: 1 as const } : {}),
      ...(typeof e.s === 'string' && RELAY_ID_PATTERN.test(e.s) ? { s: e.s } : {}),
      ...(e.bk === 'c' || e.bk === 'b' ? { bk: e.bk } : {}),
      ...(isCaseB(e.ob) ? { ob: { linkTicket: e.ob.linkTicket, emailSub: e.ob.emailSub } } : {}),
      ...(e.x === 1 ? { x: 1 as const } : {}),
    };
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
 * Stores the relayKey for `relayId` (pruning old entries first), with /login's timings for a pk_test_ app and the
 * follow-up parts. Throws if storage is unavailable.
 */
export function storeLoginEntry(storage: Storage, relayId: string, relayKey: Uint8Array, now: number, timings?: Record<string, number>, follow: FollowEntry = {}, createdAt = now): void {
  if (!RELAY_ID_PATTERN.test(relayId)) throw new Error('Malformed relayId');
  if (relayKey.length !== RELAY_KEY_BYTES) throw new Error('Malformed relayKey');
  if (follow.followKey && follow.followKey.length !== FOLLOW_KEY_BYTES) throw new Error('Malformed followKey');
  if (follow.nonce !== undefined && !NONCE.test(follow.nonce)) throw new Error('Malformed nonce');
  if (follow.slot !== undefined && !RELAY_ID_PATTERN.test(follow.slot)) throw new Error('Malformed slot');
  pruneLoginEntries(storage, now);
  const entry: LoginEntry = {
    v: 1,
    createdAt,
    relayKey: base64UrlEncode(relayKey),
    ...(timings && isTimings(timings) ? { t: timings } : {}),
    ...(follow.followKey ? { f: base64UrlEncode(follow.followKey) } : {}),
    ...(follow.home ? { home: follow.home } : {}),
    ...(follow.next !== undefined ? { next: follow.next } : {}),
    ...(follow.leg ? { leg: follow.leg } : {}),
    ...(follow.caseB ? { b: follow.caseB } : {}),
    ...(follow.clientId ? { c: follow.clientId } : {}),
    ...(follow.interactive ? { i: 1 as const } : {}),
    ...(follow.loginHint ? { h: follow.loginHint } : {}),
    ...(follow.task ? { task: 1 as const } : {}),
    ...(follow.tokenFirst ? { tf: 1 as const } : {}),
    ...(follow.nonce ? { n: follow.nonce } : {}),
    ...(follow.record ? { r: 1 as const } : {}),
    ...(follow.slot ? { s: follow.slot } : {}),
    ...(follow.back ? { bk: follow.back === 'case_b' ? ('b' as const) : ('c' as const) } : {}),
    ...(follow.offer ? { ob: follow.offer } : {}),
    ...(follow.cancelled ? { x: 1 as const } : {}),
  };
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

const toTaken = (e: LoginEntry): TakenLogin | null => {
  const relayKey = base64UrlDecode(e.relayKey);
  if (relayKey.length !== RELAY_KEY_BYTES) return null;
  const followKey = e.f ? base64UrlDecode(e.f) : undefined;
  if (followKey && followKey.length !== FOLLOW_KEY_BYTES) return null;
  return {
    relayKey,
    timings: e.t ?? null,
    ...(followKey ? { followKey } : {}),
    ...(e.home ? { home: e.home } : {}),
    ...(e.next !== undefined ? { next: e.next } : {}),
    ...(e.leg ? { leg: e.leg } : {}),
    ...(e.b ? { caseB: e.b } : {}),
    ...(e.c ? { clientId: e.c } : {}),
    ...(e.i ? { interactive: true } : {}),
    ...(e.h ? { loginHint: e.h } : {}),
    ...(e.task ? { task: true } : {}),
    ...(e.tf ? { tokenFirst: true } : {}),
    ...(e.n ? { nonce: e.n } : {}),
    ...(e.r ? { record: true } : {}),
    ...(e.s ? { slot: e.s } : {}),
    ...(e.bk ? { back: e.bk === 'b' ? ('case_b' as const) : ('chooser' as const) } : {}),
    ...(e.ob ? { offer: e.ob } : {}),
    ...(e.x ? { cancelled: true } : {}),
  };
};

/** As takeLoginEntry, with /login's timings (a pk_test_ app's) and the follow-up parts as well. */
export function takeLogin(storage: Storage, state: string, now: number): TakenLogin | null {
  if (!RELAY_ID_PATTERN.test(state)) return null;
  const key = LOGIN_ENTRY_PREFIX + state;
  try {
    const e = readEntry(storage, key);
    storage.removeItem(key);
    if (!e || now - e.createdAt > LOGIN_ENTRY_MAX_AGE_MS) return null;
    return toTaken(e);
  } catch {
    return null;
  }
}

/** The entry for `state` without taking it (the email step checks whether it is in follow-up mode), or null. */
export function peekLogin(storage: Storage, state: string, now: number): (Omit<TakenLogin, 'relayKey' | 'followKey'> & { createdAt: number; follows: boolean }) | null {
  if (!RELAY_ID_PATTERN.test(state)) return null;
  try {
    const e = readEntry(storage, LOGIN_ENTRY_PREFIX + state);
    if (!e || now - e.createdAt > LOGIN_ENTRY_MAX_AGE_MS) return null;
    const t = toTaken(e);
    if (!t) return null;
    zeroTaken(t);
    const { relayKey: _r, followKey: _f, ...rest } = t;
    void _r;
    // Whether the entry carries the follow-up key (a login of an app with email), never the key itself.
    return { ...rest, createdAt: e.createdAt, follows: _f !== undefined };
  } catch {
    return null;
  }
}

/** Zeroes a taken entry's secrets. */
export function zeroTaken(t: Pick<TakenLogin, 'relayKey' | 'followKey'>): void {
  t.relayKey.fill(0);
  t.followKey?.fill(0);
}
