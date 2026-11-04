// The user directory (D269): upserts keep one row per identity and per (identity, app), the latest address and the
// widest seen window; a failed write never throws into the caller.
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { type UserEmailRecord, recordUserEmail, recordUserEmailLater, userEmailStatements } from '../src/directory.ts';

const base: UserEmailRecord = { provider: 'google', sub: '1098765432', email: 'User@Example.com', emailVerified: true, hosted: false, appId: 'app_1', scopeId: 's1', nowMs: 1_000 };

const rows = async () => (await env.DB.prepare('SELECT * FROM user_emails ORDER BY provider, sub').all()).results;
const appRows = async () => (await env.DB.prepare('SELECT * FROM user_email_apps ORDER BY app_id').all()).results;

describe('user directory', () => {
  it('records an identity and its app; Google addresses are lowercased', async () => {
    await recordUserEmail(env.DB, base);
    expect(await rows()).toEqual([{ provider: 'google', sub: '1098765432', email: 'user@example.com', email_verified: 1, hosted: 0, first_seen_ms: 1_000, last_seen_ms: 1_000 }]);
    expect(await appRows()).toEqual([{ provider: 'google', sub: '1098765432', app_id: 'app_1', scope_id: 's1', first_seen_ms: 1_000, last_seen_ms: 1_000 }]);
  });

  it('keeps one row per identity: the latest address, first_seen kept, last_seen never moves back', async () => {
    await recordUserEmail(env.DB, base);
    await recordUserEmail(env.DB, { ...base, email: 'new@example.com', nowMs: 5_000, appId: 'app_2' });
    await recordUserEmail(env.DB, { ...base, nowMs: 3_000 });
    const [r] = await rows();
    expect(r).toMatchObject({ email: 'user@example.com', first_seen_ms: 1_000, last_seen_ms: 5_000 });
    expect((await appRows()).map((a) => [a.app_id, a.first_seen_ms, a.last_seen_ms])).toEqual([['app_1', 1_000, 3_000], ['app_2', 5_000, 5_000]]);
  });

  it('keeps email and Google identities apart; an email address is stored as given (already normalized)', async () => {
    await recordUserEmail(env.DB, base);
    await recordUserEmail(env.DB, { ...base, provider: 'email', sub: 'e1.abc', email: 'user@example.com', hosted: null });
    expect((await rows()).map((r) => [r.provider, r.sub, r.hosted])).toEqual([['email', 'e1.abc', null], ['google', '1098765432', 0]]);
  });

  it('refuses malformed records', () => {
    for (const bad of [{ sub: '' }, { sub: 'x'.repeat(256) }, { email: 'no-at-sign' }, { email: '' }, { nowMs: 0 }, { provider: 'apple' as never }]) {
      expect(() => userEmailStatements(env.DB, { ...base, ...bad })).toThrow(TypeError);
    }
  });

  it('recordUserEmailLater never throws: a malformed record or a D1 failure is logged without the address or the sub', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((l: string) => void lines.push(l));
    const pending: Promise<unknown>[] = [];
    expect(() => recordUserEmailLater(env.DB, (p) => pending.push(p), { ...base, email: 'bad' })).not.toThrow();
    const broken = { batch: () => Promise.reject(new Error('d1 down')), prepare: env.DB.prepare.bind(env.DB) } as unknown as D1Database;
    recordUserEmailLater(broken, (p) => pending.push(p), base);
    await Promise.all(pending);
    spy.mockRestore();
    expect(lines).toHaveLength(2);
    for (const l of lines) {
      expect(JSON.parse(l)).toMatchObject({ event: 'directory_write_failed', appId: 'app_1', scopeId: 's1' });
      expect(l.toLowerCase()).not.toContain('user@example.com');
      expect(l).not.toContain(base.sub);
    }
  });
});
