// The email step's storage on authOrigin (docs/email-login-spec.md "Vault, popup and SDK changes", "Codes, attempts,
// expiry, replay"; build plan batch 8a):
//
// - The email context, in sessionStorage under `hana.email.<relayId>`: /login writes it when the user picks email
//   (beside the relay key entry of login-storage.ts), /login/email reads it in the same browsing context. It holds the
//   public facts the vault sent (app, parent origin, scope, the session commitment, the Google client for the case-B
//   "Continue with Google"), and, once a code was sent, the `challengeId`. Never the relay key, an address, a code or a
//   token. Deleted when the step ends, and pruned after 10 min like the relay key entry.
// - Device tickets, in localStorage (the popup is top-level, so first-party), one per address under
//   `hana.dt.<b64url(sha256(trimmed lowercased address))>`: the issuer's owner proof of an earlier verified code at that
//   exact address (`dt2.…`, 30 days, D198), sent with the next `start`. The key is a hash so the store lists no address.
//   A ticket can't sign anyone in: it only lets its owner's code mail past the shared limits. At most 5 are kept.
// - A staff unlock (D866), in localStorage under `hana.ug`: one entry, the token of the unlock link this browser's
//   `/email/unlock` page pressed (`ug1.…`), the address the issuer said it is for, and when it lapses (24 h after the
//   mail). /login/email sends it with each `start` while it lasts: the issuer counts it only for that exact address,
//   once, and ignores it otherwise. It can't sign anyone in either. Dropped after a sign-in with that address, or once
//   it lapsed.
import { RELAY_ID_PATTERN, type LoginMethod, base64UrlDecode, base64UrlEncode, isEmailHint, isLogoUrl, sha256, utf8 } from '@hana-id/core';
import { LOGIN_ENTRY_MAX_AGE_MS } from './login-storage.ts';

export const EMAIL_ENTRY_PREFIX = 'hana.email.';
/**
 * How long /login/email keeps going after /login stored its context: the vault's pending limit (vault/login.ts
 * LOGIN_PENDING_MS, 5 min from hana_login) less the popup's connect window (the SDK's 15 s), so the page never outlives
 * the vault's wait. Tested against LOGIN_PENDING_MS.
 */
export const EMAIL_STEP_LIMIT_MS = 5 * 60_000 - 15_000;
export const DEVICE_TICKET_PREFIX = 'hana.dt.';
/** The issuer's device tickets live 30 days (D198); one older than that is dropped unsent. */
export const DEVICE_TICKET_MAX_AGE_MS = 30 * 24 * 3_600_000;
export const DEVICE_TICKETS_KEPT = 5;
/** `dt2.` + 75 base64url characters (apps/email-issuer keys.ts). */
export const DEVICE_TICKET_RE = /^dt2\.[A-Za-z0-9_-]{75}$/u;
/** The issuer's challengeId: 32 bytes, base64url (D197). */
export const CHALLENGE_ID_RE = /^[A-Za-z0-9_-]{43}$/u;

export type OpenerKind = 'partner' | 'vault';

/** What /login hands /login/email for one login. */
export interface EmailContext {
  pk: string;
  appName: string;
  /** Batch C11: the app's logo URL as auth-params carried it (shown only from the build's files origin, logo.ts). */
  logoUrl?: string;
  parentOrigin: string;
  scopeId: string;
  sessionPublicKey: Uint8Array;
  expiresAtMs: number;
  salt: Uint8Array;
  keyIndex: number;
  maxUses: number;
  /** The session nonce (for the case-B Google step, which needs it in Google's request). */
  nonce: string;
  /** The Google client, for the case-B "Continue with Google"; null when the app offers no Google. */
  clientId: string | null;
  methods: LoginMethod[];
  /**
   * D348: the method the partner named (`hana.login({method})`), when it did. After a cancel on Google's screen the
   * chooser then offers that method only.
   */
  method?: LoginMethod;
  /** How /login was opened, so /login/email can tell the vault the code was sent (`hana:auth-progress`). */
  opener: OpenerKind;
  vaultFrame: string | null;
  /**
   * The partner's `emailHint`: stored only for the navigation from /login, then dropped from storage by /login/email on
   * load (kept in its memory).
   */
  emailHint: string | null;
  /** The live challenge, once `start` answered (resend and verify need only this). */
  challengeId: string | null;
  /**
   * `hana.linkAccount({method: 'email'})` (build plan batch 8b): the first sign-in is the new address's code over this
   * purpose and commitment (`link_new`), not a login's `session`.
   */
  proof?: { purpose: 'link_new'; commitment: Record<string, unknown> } | null;
  /** The export window's email re-authentication (export mode): no follow-up channel, no case B link. */
  exportMode?: boolean;
}

interface Stored {
  v: 1;
  createdAt: number;
  c: Omit<EmailContext, 'sessionPublicKey' | 'salt'> & { sessionPublicKey: string; salt: string };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => Number.isSafeInteger(v);

function decode(raw: string | null): Stored | null {
  try {
    const v: unknown = JSON.parse(raw ?? 'null');
    if (!isObj(v) || v.v !== 1 || !isInt(v.createdAt) || !isObj(v.c)) return null;
    const c = v.c;
    const ok =
      typeof c.pk === 'string' &&
      typeof c.appName === 'string' &&
      (c.logoUrl === undefined || isLogoUrl(c.logoUrl)) &&
      typeof c.parentOrigin === 'string' &&
      typeof c.scopeId === 'string' &&
      typeof c.sessionPublicKey === 'string' &&
      isInt(c.expiresAtMs) &&
      typeof c.salt === 'string' &&
      isInt(c.keyIndex) &&
      isInt(c.maxUses) &&
      typeof c.nonce === 'string' &&
      (c.clientId === null || typeof c.clientId === 'string') &&
      Array.isArray(c.methods) &&
      c.methods.every((m) => m === 'google' || m === 'email') &&
      (c.method === undefined || c.method === 'google' || c.method === 'email') &&
      (c.emailHint === null || isEmailHint(c.emailHint)) &&
      (c.opener === 'partner' || c.opener === 'vault') &&
      (c.vaultFrame === null || typeof c.vaultFrame === 'string') &&
      (c.challengeId === null || (typeof c.challengeId === 'string' && CHALLENGE_ID_RE.test(c.challengeId))) &&
      (c.proof === undefined || c.proof === null || (isObj(c.proof) && c.proof.purpose === 'link_new' && isObj(c.proof.commitment))) &&
      (c.exportMode === undefined || typeof c.exportMode === 'boolean');
    return ok ? (v as unknown as Stored) : null;
  } catch {
    return null;
  }
}

/** Deletes every `hana.email.*` entry older than 10 min, or unreadable. */
export function pruneEmailEntries(storage: Storage, now: number): void {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k?.startsWith(EMAIL_ENTRY_PREFIX)) keys.push(k);
  }
  for (const k of keys) {
    const e = decode(storage.getItem(k));
    if (!e || now - e.createdAt > LOGIN_ENTRY_MAX_AGE_MS || e.createdAt > now + LOGIN_ENTRY_MAX_AGE_MS) storage.removeItem(k);
  }
}

/** Stores the context for `relayId` (pruning old entries first). Throws if storage is unavailable. */
export function storeEmailContext(storage: Storage, relayId: string, c: EmailContext, now: number, createdAt: number = now): void {
  if (!RELAY_ID_PATTERN.test(relayId)) throw new Error('Malformed relayId');
  pruneEmailEntries(storage, now);
  const stored: Stored = { v: 1, createdAt, c: { ...c, sessionPublicKey: base64UrlEncode(c.sessionPublicKey), salt: base64UrlEncode(c.salt) } };
  storage.setItem(EMAIL_ENTRY_PREFIX + relayId, JSON.stringify(stored));
}

/** The context for `relayId` with its creation time, or null (none, malformed, older than 10 min, storage error). */
export function readEmailContext(storage: Storage, relayId: string, now: number): { context: EmailContext; createdAt: number } | null {
  if (!RELAY_ID_PATTERN.test(relayId)) return null;
  try {
    const e = decode(storage.getItem(EMAIL_ENTRY_PREFIX + relayId));
    if (!e || now - e.createdAt > LOGIN_ENTRY_MAX_AGE_MS || e.createdAt > now + LOGIN_ENTRY_MAX_AGE_MS) return null;
    const sessionPublicKey = base64UrlDecode(e.c.sessionPublicKey);
    const salt = base64UrlDecode(e.c.salt);
    if (sessionPublicKey.length !== 32) return null;
    return { context: { ...e.c, sessionPublicKey, salt }, createdAt: e.createdAt };
  } catch {
    return null;
  }
}

export function dropEmailContext(storage: Storage, relayId: string): void {
  try {
    storage.removeItem(EMAIL_ENTRY_PREFIX + relayId);
  } catch {
    // Nothing else to do: it is pruned after 10 min.
  }
}

// ---- device tickets ----

/** The ticket store key of an address (a hash of it, trimmed and lowercased: the issuer checks the exact address). */
export const deviceTicketKey = (email: string): string => DEVICE_TICKET_PREFIX + base64UrlEncode(sha256(utf8(email.trim().toLowerCase())));

interface StoredTicket {
  t: string;
  at: number;
}

function readTicket(raw: string | null): StoredTicket | null {
  try {
    const v: unknown = JSON.parse(raw ?? 'null');
    return isObj(v) && typeof v.t === 'string' && DEVICE_TICKET_RE.test(v.t) && isInt(v.at) ? { t: v.t, at: v.at } : null;
  } catch {
    return null;
  }
}

/** This device's ticket for `email`, or null (none, expired, malformed, or storage unavailable). */
export function deviceTicketFor(storage: Storage | null, email: string, now: number): string | null {
  if (!storage) return null;
  try {
    const t = readTicket(storage.getItem(deviceTicketKey(email)));
    return t && now - t.at < DEVICE_TICKET_MAX_AGE_MS && t.at <= now + 60_000 ? t.t : null;
  } catch {
    return null;
  }
}

/**
 * Keeps the ticket `verify` returned for `email`, dropping expired and malformed entries and, past 5, the oldest. A
 * storage failure is ignored: the next login just sends no ticket.
 */
export function saveDeviceTicket(storage: Storage | null, email: string, ticket: string, now: number): void {
  if (!storage || !DEVICE_TICKET_RE.test(ticket)) return;
  try {
    const key = deviceTicketKey(email);
    const others: { k: string; at: number }[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (!k?.startsWith(DEVICE_TICKET_PREFIX) || k === key) continue;
      const t = readTicket(storage.getItem(k));
      others.push({ k, at: t && now - t.at < DEVICE_TICKET_MAX_AGE_MS ? t.at : -1 });
    }
    for (const o of others.filter((o) => o.at < 0)) storage.removeItem(o.k);
    const live = others.filter((o) => o.at >= 0).sort((a, b) => a.at - b.at);
    while (live.length >= DEVICE_TICKETS_KEPT) storage.removeItem((live.shift() as { k: string }).k);
    storage.setItem(key, JSON.stringify({ t: ticket, at: now } satisfies StoredTicket));
  } catch {
    // Storage full or blocked: no ticket next time.
  }
}

// ---- a staff unlock (D866) ----

export const UNLOCK_TOKEN_KEY = 'hana.ug';
/** `ug1.` + 43 base64url characters (apps/email-issuer support-link.ts). */
export const UNLOCK_TOKEN_RE = /^ug1\.[A-Za-z0-9_-]{43}$/u;
/** The issuer's grant lasts 24 h from its mail: an entry claiming more is refused. */
const UNLOCK_MAX_MS = 24 * 3_600_000 + 60_000;

interface StoredUnlock {
  t: string;
  e: string;
  until: number;
}

function readUnlock(raw: string | null): StoredUnlock | null {
  try {
    const v: unknown = JSON.parse(raw ?? 'null');
    return isObj(v) && typeof v.t === 'string' && UNLOCK_TOKEN_RE.test(v.t) && typeof v.e === 'string' && v.e.length <= 320 && isInt(v.until) ? { t: v.t, e: v.e, until: v.until } : null;
  } catch {
    return null;
  }
}

/** Keeps the pressed unlock (replacing an older one). False when storage refused it: the page then says so. */
export function saveUnlockToken(storage: Storage | null, token: string, email: string, untilMs: number, now: number): boolean {
  if (!storage || !UNLOCK_TOKEN_RE.test(token) || untilMs <= now || untilMs > now + UNLOCK_MAX_MS) return false;
  try {
    storage.setItem(UNLOCK_TOKEN_KEY, JSON.stringify({ t: token, e: email, until: untilMs } satisfies StoredUnlock));
    return readUnlock(storage.getItem(UNLOCK_TOKEN_KEY))?.t === token;
  } catch {
    return false;
  }
}

/** The live unlock token, or null (none, lapsed, malformed, storage unavailable). A lapsed one is dropped. */
export function liveUnlockToken(storage: Storage | null, now: number): string | null {
  if (!storage) return null;
  try {
    const u = readUnlock(storage.getItem(UNLOCK_TOKEN_KEY));
    if (u && u.until > now && u.until <= now + UNLOCK_MAX_MS) return u.t;
    storage.removeItem(UNLOCK_TOKEN_KEY);
    return null;
  } catch {
    return null;
  }
}

/** After a sign-in with `email`: its unlock was used (or not needed), so it is dropped. Other addresses keep it. */
export function dropUnlockTokenFor(storage: Storage | null, email: string): void {
  if (!storage) return;
  try {
    const u = readUnlock(storage.getItem(UNLOCK_TOKEN_KEY));
    if (u && u.e.trim().toLowerCase() === email.trim().toLowerCase()) storage.removeItem(UNLOCK_TOKEN_KEY);
  } catch {
    // Nothing to do: it lapses in 24 h.
  }
}
