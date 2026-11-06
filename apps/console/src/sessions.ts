// Console sessions (docs/batch-c-spec.md "Sessions", D75): server-side, looked up by the sha256 of a 32-byte random
// cookie value, so a database read never yields a usable cookie. Sign-in (sign-in.ts, batch C9) creates them; C7 owns
// the model (lifetimes, lookup, revocation) because StaffRpc's member, user and org changes revoke them.
//
// - Cookie `__Host-hana_cs`: `Secure; HttpOnly; SameSite=Strict; Path=/`, no `Domain` (the `__Host-` prefix makes the
//   browser enforce all three), console origin only. A new id at every sign-in.
// - 2 h idle (`last_seen_at` written at most every 5 min, so a busy session costs one write per 5 min), 12 h absolute.
// - Usable only while unrevoked, inside both limits, and its user isn't disabled. Roles are not cached on the session:
//   the BFF reads `members` on every request.
import { b64url, fromB64url, randomBytes, sha256 } from '@hana-id/console-core';
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS, SESSION_TOUCH_MS } from './config.ts';
import { lit } from './sql.ts';

export const SESSION_COOKIE = '__Host-hana_cs';
const COOKIE_ATTRS = 'Path=/; Secure; HttpOnly; SameSite=Strict';

/** `Set-Cookie` for a new session (no Max-Age: a browser-session cookie; the server enforces the lifetimes). */
export const sessionCookie = (value: string): string => `${SESSION_COOKIE}=${value}; ${COOKIE_ATTRS}`;
/** `Set-Cookie` that clears the session cookie (logout). */
export const clearSessionCookie = (): string => `${SESSION_COOKIE}=; ${COOKIE_ATTRS}; Max-Age=0`;

/** The value of one cookie in a `Cookie` header, or null. A name sent twice is refused (cookie tossing). */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  const values = header
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p.startsWith(`${name}=`))
    .map((p) => p.slice(name.length + 1));
  return values.length === 1 ? values[0]! : null;
}

/** sha256 of a cookie value (b64url of exactly 32 bytes), or null when it isn't one. */
export async function cookieHash(value: string | null): Promise<Uint8Array | null> {
  if (!value || !/^[A-Za-z0-9_-]{43}$/u.test(value)) return null;
  try {
    return await sha256(fromB64url(value));
  } catch {
    return null;
  }
}

export interface NewSession {
  userId: string;
  hd: string | null;
  now: number;
  country?: string | null;
  asn?: number | null;
  /** /24 or /48 (ip.ts ipPrefix), never a full address. */
  ipPrefix?: string | null;
}

/**
 * A new session's insert, unrun (sign-in runs it in one batch with its audit row), with the cookie value (to set once,
 * never stored or logged) and its hash.
 */
export async function sessionInsert(db: D1Database, s: NewSession): Promise<{ stmt: D1PreparedStatement; cookieValue: string; idHash: Uint8Array }> {
  const value = b64url(randomBytes(32));
  const idHash = (await cookieHash(value))!;
  const stmt = db
    .prepare('INSERT INTO console_sessions (id_hash, user_id, hd, auth_at, last_seen_at, absolute_expires_at, country, asn, ip_prefix) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(idHash, s.userId, s.hd, s.now, s.now, s.now + SESSION_ABSOLUTE_MS, s.country ?? null, s.asn ?? null, s.ipPrefix ?? null);
  return { stmt, cookieValue: value, idHash };
}

/** Creates a session and returns the cookie value (to set once, never stored or logged) and its hash. */
export async function createSession(db: D1Database, s: NewSession): Promise<{ cookieValue: string; idHash: Uint8Array }> {
  const { stmt, cookieValue, idHash } = await sessionInsert(db, s);
  await stmt.run();
  return { cookieValue, idHash };
}

export interface Session {
  idHash: Uint8Array;
  userId: string;
  hd: string | null;
  authAt: number;
  /** The 12 h absolute end (ms): `GET /api/me` answers it as `sessionExpiresAt` (the SPA's warning before it). */
  absoluteExpiresAt: number;
  /** The member's own address and Google `sub` (the ConsoleRpc member actor; never logged). */
  email: string;
  sub: string;
}

/**
 * The live session a `Cookie` header names, or null: unknown, revoked, idle past 2 h, past its 12 h, or its user
 * disabled. Touches `last_seen_at` when it is 5 min old or more (one guarded write, so concurrent requests write once).
 */
export async function readSession(db: D1Database, cookieHeader: string | null, now: number): Promise<Session | null> {
  const idHash = await cookieHash(readCookie(cookieHeader, SESSION_COOKIE));
  if (!idHash) return null;
  const row = await db
    .prepare(
      `SELECT s.user_id, s.hd, s.auth_at, s.last_seen_at, s.absolute_expires_at, u.email, u.sub FROM console_sessions s JOIN console_users u ON u.id = s.user_id
        WHERE s.id_hash = ? AND s.revoked_at IS NULL AND s.absolute_expires_at > ${lit(now)} AND s.last_seen_at > ${lit(now - SESSION_IDLE_MS)} AND u.disabled_at IS NULL`,
    )
    .bind(idHash)
    .first<{ user_id: string; hd: string | null; auth_at: number; last_seen_at: number; absolute_expires_at: number; email: string; sub: string }>();
  if (!row) return null;
  if (now - row.last_seen_at >= SESSION_TOUCH_MS) {
    await db.prepare(`UPDATE console_sessions SET last_seen_at = ? WHERE id_hash = ? AND last_seen_at <= ${lit(now - SESSION_TOUCH_MS)}`).bind(now, idHash).run();
  }
  return { idHash, userId: row.user_id, hd: row.hd, authAt: row.auth_at, absoluteExpiresAt: row.absolute_expires_at, email: row.email, sub: row.sub };
}

/** Logout: revokes this one session. */
export async function revokeSession(db: D1Database, idHash: Uint8Array, now: number): Promise<void> {
  await db.prepare('UPDATE console_sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL').bind(now, idHash).run();
}
