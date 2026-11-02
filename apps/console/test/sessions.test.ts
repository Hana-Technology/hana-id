// The session model (docs/batch-c-spec.md "Sessions"): the `__Host-` cookie's attributes, lookup by hash only, 2 h
// idle and 12 h absolute expiry, `last_seen_at` at most every 5 min, a new id per sign-in, revocation, a disabled user,
// and malformed or doubled cookies. Batch C9 creates sessions at sign-in; the model is C7's.
import { describe, expect, it } from 'vitest';
import { b64url, hex } from '@hana-id/console-core';
import { SESSION_COOKIE, clearSessionCookie, cookieHash, createSession, readCookie, readSession, revokeSession, sessionCookie } from '../src/sessions.ts';
import { HOUR, db, seedUser } from './helpers.ts';

const cookie = (v: string) => `${SESSION_COOKIE}=${v}`;
const MIN = 60_000;

describe('the cookie', () => {
  it('is __Host- with Secure, HttpOnly, SameSite=Strict, Path=/ and no Domain', () => {
    const c = sessionCookie('A'.repeat(43));
    expect(c).toBe(`__Host-hana_cs=${'A'.repeat(43)}; Path=/; Secure; HttpOnly; SameSite=Strict`);
    expect(c).not.toMatch(/domain/iu);
    expect(clearSessionCookie()).toBe('__Host-hana_cs=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0');
  });

  it('reads exactly one value; a doubled name (cookie tossing) or a malformed value is no session', async () => {
    expect(readCookie(`a=1; ${cookie('x')}; b=2`, SESSION_COOKIE)).toBe('x');
    expect(readCookie(`${cookie('x')}; ${cookie('y')}`, SESSION_COOKIE)).toBeNull();
    expect(readCookie('hana_cs=x', SESSION_COOKIE)).toBeNull();
    expect(await cookieHash('short')).toBeNull();
    expect(await cookieHash(`${'A'.repeat(42)}+`)).toBeNull();
    expect(await cookieHash(null)).toBeNull();
  });
});

describe('sessions', () => {
  it('a new random id per sign-in; D1 holds only its sha256', async () => {
    const u = await seedUser();
    const now = Date.now();
    const a = await createSession(db, { userId: u.id, hd: null, now, ipPrefix: '203.0.113.0/24', country: 'AU' });
    const b = await createSession(db, { userId: u.id, hd: null, now });
    expect(a.cookieValue).not.toBe(b.cookieValue);
    expect(a.cookieValue).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const rows = (await db.prepare('SELECT hex(id_hash) AS h, absolute_expires_at, ip_prefix FROM console_sessions WHERE user_id = ? ORDER BY auth_at').bind(u.id).all<{ h: string; absolute_expires_at: number; ip_prefix: string | null }>()).results;
    expect(rows.map((r) => r.h).sort()).toEqual([hex(a.idHash).toUpperCase(), hex(b.idHash).toUpperCase()].sort());
    expect(JSON.stringify(rows)).not.toContain(a.cookieValue);
    expect(rows[0]!.absolute_expires_at).toBe(now + 12 * HOUR);
    expect(await readSession(db, cookie(a.cookieValue), now + MIN)).toMatchObject({ userId: u.id });
    expect(await readSession(db, cookie(b64url(new Uint8Array(32))), now)).toBeNull();
  });

  it('idle: refused 2 h after last_seen; last_seen written at most every 5 min', async () => {
    const u = await seedUser();
    const t = Date.now();
    const { cookieValue, idHash } = await createSession(db, { userId: u.id, hd: null, now: t });
    const lastSeen = () => db.prepare('SELECT last_seen_at FROM console_sessions WHERE id_hash = ?').bind(idHash).first<number>('last_seen_at');
    expect(await readSession(db, cookie(cookieValue), t + 4 * MIN)).not.toBeNull();
    expect(await lastSeen()).toBe(t);
    expect(await readSession(db, cookie(cookieValue), t + 5 * MIN)).not.toBeNull();
    expect(await lastSeen()).toBe(t + 5 * MIN);
    expect(await readSession(db, cookie(cookieValue), t + 9 * MIN)).not.toBeNull();
    expect(await lastSeen()).toBe(t + 5 * MIN);
    expect(await readSession(db, cookie(cookieValue), t + 5 * MIN + 2 * HOUR - 1)).not.toBeNull();
    expect(await readSession(db, cookie(cookieValue), t + 5 * MIN + 2 * HOUR - 1 + 2 * HOUR)).toBeNull();
  });

  it('absolute: refused at 12 h however active', async () => {
    const u = await seedUser();
    const t = Date.now();
    const { cookieValue } = await createSession(db, { userId: u.id, hd: null, now: t });
    for (let at = t; at < t + 12 * HOUR; at += HOUR) expect(await readSession(db, cookie(cookieValue), at), String(at - t)).not.toBeNull();
    expect(await readSession(db, cookie(cookieValue), t + 12 * HOUR)).toBeNull();
  });

  it('revoked, or its user disabled: no session', async () => {
    const u = await seedUser();
    const t = Date.now();
    const s = await createSession(db, { userId: u.id, hd: null, now: t });
    await revokeSession(db, s.idHash, t);
    expect(await readSession(db, cookie(s.cookieValue), t)).toBeNull();
    const s2 = await createSession(db, { userId: u.id, hd: null, now: t });
    await db.prepare('UPDATE console_users SET disabled_at = ? WHERE id = ?').bind(t, u.id).run();
    expect(await readSession(db, cookie(s2.cookieValue), t)).toBeNull();
  });
});
