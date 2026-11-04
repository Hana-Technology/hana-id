// The hourly cron (docs/batch-c-spec.md "Crons", "Retention"): invite expiry once (audited, grant cancelled), the
// short-lived purges at their lifetimes, replaced logos deleted from R2 after 30 days, and the scheduled handler
// running every step even when one fails.
import { createScheduledController } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expireInvites, hourly, purgeLogos, purgeShortLived } from '../src/cron.ts';
import { DAY, HOUR, auditRows, db, hana, seedOrg, seedUser, staffRpc } from './helpers.ts';

afterEach(() => vi.restoreAllMocks());

const h32 = () => crypto.getRandomValues(new Uint8Array(32));

describe('invite expiry', () => {
  it('logs each expired invite once (system actor), cancels its grant, and skips open, accepted and revoked ones', async () => {
    const org = await seedOrg();
    const issue = async (role: 'owner' | 'viewer') => {
      const r = await staffRpc().issueInvite({ ...hana(), email: `${Math.random().toString(36).slice(2)}@partner.example`, role, orgId: org });
      if (!r.ok) throw new Error(r.code);
      return r.invite.id;
    };
    const expired = await issue('owner');
    const open = await issue('viewer');
    const revoked = await issue('viewer');
    expect((await staffRpc().revokeInvite({ ...hana(), inviteId: revoked })).ok).toBe(true);
    await db.prepare('UPDATE invites SET expires_at = created_at + 1 WHERE id IN (?, ?)').bind(expired, revoked).run();
    const now = Date.now();
    expect(await expireInvites(db, now)).toBeGreaterThanOrEqual(1);
    await expireInvites(db, now + 1000);
    const rows = await auditRows("action = 'invite.expired' AND org_id = ?", org);
    expect(rows).toEqual([expect.objectContaining({ actor_kind: 'system', actor_id: 'console-cron', target: expired, details_json: '{}' })]);
    expect(await db.prepare('SELECT cancelled_by FROM owner_grants WHERE invite_id = ?').bind(expired).first('cancelled_by')).toBe('system:invite_expired');
    expect(await db.prepare('SELECT expired_logged_at FROM invites WHERE id = ?').bind(open).first('expired_logged_at')).toBeNull();
  });
});

describe('housekeeping purges', () => {
  it('removes rows at their lifetimes, never sooner', async () => {
    const now = Date.now();
    const u = await seedUser();
    const org = await seedOrg();
    const inv = async (o: Record<string, unknown>) => {
      const id = `inv_p${Math.random().toString(36).slice(2)}`;
      const row = { id, email_norm: 'x@partner.example', org_id: org, role: 'viewer', created_by_kind: 'hana', created_by: 's', created_at: now - 200 * DAY, expires_at: now - 193 * DAY, ...o };
      const cols = Object.keys(row);
      await db.prepare(`INSERT INTO invites (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).bind(...Object.values(row)).run();
      return id;
    };
    const oldAccepted = await inv({ accepted_at: now - 91 * DAY, accepted_user_id: u.id, accepted_by_sub: 's' });
    const recentAccepted = await inv({ accepted_at: now - 89 * DAY, accepted_user_id: u.id, accepted_by_sub: 's' });
    const oldExpired = await inv({ expired_logged_at: now - 100 * DAY });
    const expiredUnlogged = await inv({});
    const session = async (lastSeen: number, revoked: number | null, auth = lastSeen) => {
      const h = h32();
      await db.prepare('INSERT INTO console_sessions (id_hash, user_id, auth_at, last_seen_at, absolute_expires_at, revoked_at, ip_prefix) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(h, u.id, auth, lastSeen, auth + 12 * HOUR, revoked, '203.0.113.0/24').run();
      return h;
    };
    const oldSession = await session(now - 31 * DAY, null);
    const recentSession = await session(now - 29 * DAY, null);
    const flow = async (expires: number) => {
      await db.prepare("INSERT INTO auth_flows (state_hash, start_hash, purpose, pre_cookie_hash, pkce_verifier, nonce, scope, created_at, expires_at) VALUES (?, ?, 'login', ?, 'v', 'n', 'openid email', ?, ?)").bind(h32(), h32(), h32(), expires - 300_000, expires).run();
    };
    await flow(now - 25 * HOUR);
    await flow(now - 23 * HOUR);
    const counts = await purgeShortLived(db, now);
    expect(counts.invites).toBeGreaterThanOrEqual(2);
    const exists = (id: string) => db.prepare('SELECT COUNT(*) AS n FROM invites WHERE id = ?').bind(id).first<number>('n');
    expect(await exists(oldAccepted)).toBe(0);
    expect(await exists(oldExpired)).toBe(0);
    expect(await exists(recentAccepted)).toBe(1);
    expect(await exists(expiredUnlogged)).toBe(1);
    const sessionExists = (h: Uint8Array) => db.prepare('SELECT COUNT(*) AS n FROM console_sessions WHERE id_hash = ?').bind(h).first<number>('n');
    expect(await sessionExists(oldSession)).toBe(0);
    expect(await sessionExists(recentSession)).toBe(1);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM auth_flows WHERE expires_at <= ?').bind(now - 24 * HOUR).first('n')).toBe(0);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM auth_flows WHERE expires_at = ?').bind(now - 23 * HOUR).first('n')).toBe(1);
  });

  it('never touches audit rows or owner grants', async () => {
    const before = await db.prepare('SELECT (SELECT COUNT(*) FROM audit_log) AS a, (SELECT COUNT(*) FROM owner_grants) AS g').first();
    await purgeShortLived(db, Date.now() + 10_000 * DAY);
    expect(await db.prepare('SELECT (SELECT COUNT(*) FROM audit_log) AS a, (SELECT COUNT(*) FROM owner_grants) AS g').first()).toEqual(before);
  });
});

describe('replaced logos', () => {
  it('deletes objects replaced more than 30 days ago from LOGOS, then their rows; keeps current and recent ones', async () => {
    const now = Date.now();
    const key = (n: string) => `logos/app_cron${n}/${'0'.repeat(63)}${n}.png`;
    const rows: [string, number | null][] = [
      [key('1'), now - 31 * DAY],
      [key('2'), now - 29 * DAY],
      [key('3'), null],
    ];
    for (const [k, replaced] of rows) {
      await env.LOGOS!.put(k, new Uint8Array([137, 80, 78, 71]));
      await db.prepare('INSERT INTO logo_objects (key, app_id, created_at, replaced_at) VALUES (?, ?, ?, ?)').bind(k, 'app_cron', now - 40 * DAY, replaced).run();
    }
    expect(await purgeLogos(env, now)).toBe(1);
    expect(await env.LOGOS!.head(key('1'))).toBeNull();
    expect(await env.LOGOS!.head(key('2'))).not.toBeNull();
    expect(await env.LOGOS!.head(key('3'))).not.toBeNull();
    expect((await db.prepare("SELECT key FROM logo_objects WHERE app_id = 'app_cron' ORDER BY key").all<{ key: string }>()).results.map((r) => r.key)).toEqual([key('2'), key('3')]);
    expect(await purgeLogos({ CONSOLE_DB: db }, now)).toBe(0);
  });
});

describe('replaced logos: races with an upload (batch C11)', () => {
  const now = Date.now();
  const key = (n: string) => `logos/app_race${n}/${'0'.repeat(63)}${n}.png`;
  const rowOf = (k: string) => db.prepare('SELECT replaced_at FROM logo_objects WHERE key = ?').bind(k).first<{ replaced_at: number | null }>();

  it('takes only rows still marked: a key an upload un-marked keeps its object and its row', async () => {
    await env.LOGOS!.put(key('a'), new Uint8Array([137, 80, 78, 71]));
    await db.prepare('INSERT INTO logo_objects (key, app_id, created_at, replaced_at) VALUES (?, ?, ?, ?)').bind(key('a'), 'app_racea', now - 40 * DAY, now - 31 * DAY).run();
    // The upload's statement (logo.ts): the same image again is current again.
    await db.prepare('INSERT INTO logo_objects (key, app_id, created_at, replaced_at) VALUES (?1, ?2, ?3, NULL) ON CONFLICT (key) DO UPDATE SET replaced_at = NULL').bind(key('a'), 'app_racea', now).run();
    const del = vi.fn((keys: string[]) => env.LOGOS!.delete(keys));
    expect(await purgeLogos({ CONSOLE_DB: db, LOGOS: { delete: del } as unknown as R2Bucket }, now)).toBe(0);
    expect(del).not.toHaveBeenCalled();
    expect(await env.LOGOS!.head(key('a'))).not.toBeNull();
    expect(await rowOf(key('a'))).toEqual({ replaced_at: null });
  });

  it('a failed object delete puts the rows back, so the next run retries them', async () => {
    await db.prepare('INSERT INTO logo_objects (key, app_id, created_at, replaced_at) VALUES (?, ?, ?, ?)').bind(key('b'), 'app_raceb', now - 40 * DAY, now - 31 * DAY).run();
    await env.LOGOS!.put(key('b'), new Uint8Array([137, 80, 78, 71]));
    const broken = { CONSOLE_DB: db, LOGOS: { delete: () => Promise.reject(new Error('r2 down')) } as unknown as R2Bucket };
    await expect(purgeLogos(broken, now)).rejects.toThrow('r2 down');
    expect(await rowOf(key('b'))).toEqual({ replaced_at: now - 31 * DAY });
    expect(await purgeLogos(env, now)).toBe(1);
    expect(await env.LOGOS!.head(key('b'))).toBeNull();
    expect(await rowOf(key('b'))).toBeNull();
  });
});

describe('the scheduled handler', () => {
  it('runs every step; one step failing doesn’t stop the others', async () => {
    const org = await seedOrg();
    const r = await staffRpc().issueInvite({ ...hana(), email: 'expiring@partner.example', role: 'viewer', orgId: org });
    if (!r.ok) throw new Error(r.code);
    await db.prepare('UPDATE invites SET expires_at = created_at + 1 WHERE id = ?').bind(r.invite.id).run();
    const broken = { ...env, LOGOS: { delete: () => Promise.reject(new Error('r2 down')) } as unknown as R2Bucket };
    await db.prepare("INSERT INTO logo_objects (key, app_id, created_at, replaced_at) VALUES ('logos/app_b/x.png', 'app_b', 0, 0)").run();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await hourly(broken, Date.now());
    expect(await auditRows("action = 'invite.expired' AND target = ?", r.invite.id)).toHaveLength(1);
    expect(errors.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringContaining('"step":"logos"')]);
    expect(String(errors.mock.calls[0]![0])).not.toContain('r2 down');
    await db.prepare("DELETE FROM logo_objects WHERE key = 'logos/app_b/x.png'").run();
  });

  it('is the Worker’s scheduled export', async () => {
    const worker = exports as unknown as { default: { scheduled?: unknown } };
    expect(worker.default).toBeDefined();
    const { default: handler } = await import('../src/index.ts');
    await handler.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: '0 * * * *' }), env);
  });
});
