// Staff membership changes (docs/batch-c-spec.md "Roles and permissions", "Sessions"): setMember's adds, removals,
// demotions and promotions with the last-owner rule; disableUser and freezeOrg; every role change, removal, disable and
// freeze of a member's only org revoking the user's sessions at once; the feed's audit reads.
import { LEGACY_ORG_ID } from '@hana-id/console-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { auditRows, db, hana, liveSessions, roleOf, seedMember, seedOrg, seedSession, seedUser, staffRpc } from './helpers.ts';

afterEach(() => vi.restoreAllMocks());

const set = (orgId: string, userId: string, role: 'owner' | 'viewer' | null) => staffRpc().setMember({ ...hana(), orgId, userId, role });

describe('setMember', () => {
  it('adds a viewer; adds the first owner of an ownerless org at once; adds an owner to an org with one through a grant', async () => {
    const org = await seedOrg();
    const a = await seedUser();
    expect(await set(org, a.id, 'viewer')).toEqual({ ok: true });
    expect(await roleOf(org, a.id)).toBe('viewer');
    const b = await seedUser();
    expect(await set(org, b.id, 'owner')).toEqual({ ok: true });
    expect(await roleOf(org, b.id)).toBe('owner');
    const c = await seedUser();
    expect(await set(org, c.id, 'owner')).toEqual({ ok: true });
    expect(await roleOf(org, c.id)).toBe('viewer');
    expect(await db.prepare('SELECT COUNT(*) AS n FROM owner_grants WHERE org_id = ? AND user_id = ? AND cancelled_at IS NULL').bind(org, c.id).first('n')).toBe(1);
    expect((await auditRows("action = 'member.added' AND org_id = ?", org)).map((r) => JSON.parse(r.details_json))).toEqual([
      { role: 'viewer' },
      { role: 'owner' },
      { role: 'viewer', grantId: expect.stringMatching(/^og_/u) },
    ]);
  });

  it('removes a member at once with their sessions and live grants; the last owner can’t be removed or demoted', async () => {
    const org = await seedOrg();
    const owner = await seedMember(org, 'owner');
    const v = await seedMember(org, 'viewer');
    await seedSession(v.id);
    expect(await set(org, owner.id, null)).toMatchObject({ ok: false, code: 'conflict' });
    expect(await set(org, owner.id, 'viewer')).toMatchObject({ ok: false, code: 'conflict' });
    expect((await set(org, v.id, 'owner')).ok).toBe(true);
    expect(await set(org, v.id, null)).toEqual({ ok: true });
    expect(await roleOf(org, v.id)).toBeUndefined();
    expect(await liveSessions(v.id)).toBe(0);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM owner_grants WHERE org_id = ? AND user_id = ? AND cancelled_at IS NULL').bind(org, v.id).first('n')).toBe(0);
    expect(await set(org, v.id, null)).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('demotes an owner when another owner remains, revoking the demoted user’s sessions only', async () => {
    const org = await seedOrg();
    const a = await seedMember(org, 'owner');
    const b = await seedMember(org, 'owner');
    await seedSession(a.id);
    await seedSession(b.id);
    expect(await set(org, a.id, 'viewer')).toEqual({ ok: true });
    expect(await roleOf(org, a.id)).toBe('viewer');
    expect(await liveSessions(a.id)).toBe(0);
    expect(await liveSessions(b.id)).toBe(1);
    expect(await set(org, b.id, 'viewer')).toMatchObject({ ok: false, code: 'conflict' });
    const [row] = await auditRows("action = 'member.role' AND target = ?", a.id);
    expect(JSON.parse(row!.details_json)).toEqual({ from: 'owner', to: 'viewer' });
  });

  it('a disabled owner doesn’t count: the only usable owner can’t be removed', async () => {
    const org = await seedOrg();
    const usable = await seedMember(org, 'owner');
    await seedMember(org, 'owner', await seedUser({ disabled: true }));
    expect(await set(org, usable.id, null)).toMatchObject({ ok: false, code: 'conflict' });
  });

  it('promotes a viewer of an ownerless org at once (sessions revoked), and the role already in force is a no-op', async () => {
    const org = await seedOrg();
    const v = await seedMember(org, 'viewer');
    await seedSession(v.id);
    expect(await set(org, v.id, 'owner')).toEqual({ ok: true });
    expect(await roleOf(org, v.id)).toBe('owner');
    expect(await liveSessions(v.id)).toBe(0);
    const before = (await auditRows('org_id = ?', org)).length;
    expect(await set(org, v.id, 'owner')).toEqual({ ok: true });
    const w = await seedMember(org, 'viewer');
    expect(await set(org, w.id, 'viewer')).toEqual({ ok: true });
    expect((await auditRows('org_id = ?', org)).length).toBe(before);
  });

  it('setting a pending owner to viewer cancels the grant', async () => {
    const org = await seedOrg();
    await seedMember(org, 'owner');
    const v = await seedMember(org, 'viewer');
    expect((await set(org, v.id, 'owner')).ok).toBe(true);
    expect(await set(org, v.id, 'viewer')).toEqual({ ok: true });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM owner_grants WHERE org_id = ? AND user_id = ? AND cancelled_at IS NULL').bind(org, v.id).first('n')).toBe(0);
  });

  it('refuses org_legacy, an unknown org or user, and adding a disabled user', async () => {
    const u = await seedUser();
    expect(await set(LEGACY_ORG_ID, u.id, 'viewer')).toMatchObject({ code: 'forbidden' });
    expect(await set('org_unknown1234', u.id, 'viewer')).toMatchObject({ code: 'not_found' });
    const org = await seedOrg();
    expect(await set(org, 'usr_unknown1234', 'viewer')).toMatchObject({ code: 'not_found' });
    expect(await set(org, (await seedUser({ disabled: true })).id, 'viewer')).toMatchObject({ code: 'conflict' });
  });

  it('refuses promoting a disabled member to owner, at once or through a grant, and writes nothing', async () => {
    const ownerless = await seedOrg();
    const d1 = await seedMember(ownerless, 'viewer', await seedUser({ disabled: true }));
    expect(await set(ownerless, d1.id, 'owner')).toMatchObject({ ok: false, code: 'conflict' });
    expect(await roleOf(ownerless, d1.id)).toBe('viewer');
    const owned = await seedOrg();
    await seedMember(owned, 'owner');
    const d2 = await seedMember(owned, 'viewer', await seedUser({ disabled: true }));
    expect(await set(owned, d2.id, 'owner')).toMatchObject({ ok: false, code: 'conflict' });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM owner_grants WHERE user_id = ?').bind(d2.id).first('n')).toBe(0);
    expect(await auditRows("action IN ('member.role', 'owner_grant.created') AND target IN (?, ?)", d1.id, d2.id)).toEqual([]);
    // A disabled owner can still be demoted or removed while another usable owner remains.
    expect(await set(owned, d2.id, null)).toEqual({ ok: true });
  });
});

describe('disableUser', () => {
  it('disables (sessions revoked at once) and re-enables; repeats are no-ops', async () => {
    const u = await seedUser();
    await seedSession(u.id);
    await seedSession(u.id);
    expect(await staffRpc().disableUser({ ...hana(), userId: u.id, disabled: true })).toEqual({ ok: true });
    expect(await liveSessions(u.id)).toBe(0);
    expect(await db.prepare('SELECT disabled_at IS NOT NULL AS d FROM console_users WHERE id = ?').bind(u.id).first('d')).toBe(1);
    expect(await staffRpc().disableUser({ ...hana(), userId: u.id, disabled: true })).toEqual({ ok: true });
    expect(await staffRpc().disableUser({ ...hana(), userId: u.id, disabled: false })).toEqual({ ok: true });
    expect((await auditRows('target = ?', u.id)).map((r) => r.action)).toEqual(['user.disabled', 'user.enabled']);
    expect(await staffRpc().disableUser({ ...hana(), userId: 'usr_unknown1234', disabled: true })).toMatchObject({ code: 'not_found' });
  });
});

describe('freezeOrg', () => {
  it('freezes; revokes sessions of members with no other active org; unfreezes', async () => {
    const org = await seedOrg();
    const other = await seedOrg();
    const onlyHere = await seedMember(org, 'owner');
    const alsoElsewhere = await seedMember(org, 'viewer');
    await seedMember(other, 'viewer', alsoElsewhere);
    await seedSession(onlyHere.id);
    await seedSession(alsoElsewhere.id);
    expect(await staffRpc().freezeOrg({ ...hana(), orgId: org, frozen: true })).toEqual({ ok: true });
    expect(await db.prepare('SELECT status FROM orgs WHERE id = ?').bind(org).first('status')).toBe('frozen');
    expect(await liveSessions(onlyHere.id)).toBe(0);
    expect(await liveSessions(alsoElsewhere.id)).toBe(1);
    expect(await staffRpc().freezeOrg({ ...hana(), orgId: org, frozen: false })).toEqual({ ok: true });
    expect(await db.prepare('SELECT status FROM orgs WHERE id = ?').bind(org).first('status')).toBe('active');
    expect((await auditRows("org_id = ? AND action LIKE 'org.%'", org)).map((r) => r.action)).toEqual(['org.frozen', 'org.unfrozen']);
    expect(await staffRpc().freezeOrg({ ...hana(), orgId: LEGACY_ORG_ID, frozen: true })).toMatchObject({ code: 'forbidden' });
  });
});

describe('the audit reads', () => {
  it('auditSince pages the feed oldest first; queryAudit filters newest first with a cursor', async () => {
    const org = await seedOrg();
    const users = [await seedUser(), await seedUser(), await seedUser()];
    for (const u of users) expect((await set(org, u.id, 'viewer')).ok).toBe(true);
    const all = await staffRpc().queryAudit({ ...hana(), filters: { orgId: org, action: 'member.added' }, limit: 2 });
    if (!all.ok) throw new Error(all.code);
    expect(all.rows.map((r) => r.target)).toEqual([users[2]!.id, users[1]!.id]);
    expect(all.next).toBeDefined();
    const page2 = await staffRpc().queryAudit({ ...hana(), filters: { orgId: org, action: 'member.added' }, cursor: all.next!, limit: 2 });
    if (!page2.ok) throw new Error(page2.code);
    expect(page2.rows.map((r) => r.target)).toEqual([users[0]!.id]);
    expect(page2.next).toBeUndefined();
    const first = all.rows[1]!.seq - 1;
    const feed = await staffRpc().auditSince({ ...hana(), seq: first, limit: 500 });
    if (!feed.ok) throw new Error(feed.code);
    const mine = feed.rows.filter((r) => r.orgId === org);
    expect(mine.map((r) => r.target)).toEqual([users[1]!.id, users[2]!.id]);
    expect(mine[0]).toMatchObject({ actorKind: 'hana', actorId: 'access-sub-staff-1', actorEmail: 'staff@hana.example', action: 'member.added', details: { role: 'viewer' }, outcome: 'ok' });
    expect(Object.keys(mine[0]!)).not.toContain('ipPrefix');
    expect(await staffRpc().queryAudit({ ...hana(), filters: { action: 'DROP TABLE' }, limit: 1 })).toMatchObject({ code: 'bad_request' });
    // Past 2^53 − 1 a cursor or time can't be a SQL literal: refused as input, never an internal error.
    expect(await staffRpc().queryAudit({ ...hana(), filters: {}, cursor: '9999999999999999', limit: 1 })).toMatchObject({ code: 'bad_request' });
    expect(await staffRpc().queryAudit({ ...hana(), filters: { from: 2 ** 60 }, limit: 1 })).toMatchObject({ code: 'bad_request' });
  });
});
