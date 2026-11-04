// Owner grants and acceptance (docs/batch-c-spec.md "Invites and owner grants", "Membership rules at sign-in"; D89,
// D241): grant timing for an owner invite and a promotion, the first-owner exception, the hourly cron recording a
// matured grant once, cancel by staff and by the emailed link (POST only, single use, refused after owner_from), the
// last-owner rule with a pending owner, and acceptance as one batch (the data path C9's sign-in calls).
import { type AcceptanceOutcome, acceptInvite, pendingMemberNotices } from '../src/invites.ts';
import { applyGrants } from '../src/cron.ts';
import { ipPrefix } from '../src/ip.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DELAY, type SeededUser, auditRows, db, hana, linkPair, post, request, roleOf, seedMember, seedOrg, seedUser, shiftClock, staffRpc, system } from './helpers.ts';

afterEach(() => vi.restoreAllMocks());

const delay = () => DELAY;

/** An owner invite to `org`, announced (invite and grant notices acked); returns the invite token's hash and the grant. */
async function announcedOwnerInvite(org: string, email: string) {
  const r = await staffRpc().issueInvite({ ...hana(), email, role: 'owner', orgId: org });
  if (!r.ok) throw new Error(r.code);
  const invite = await linkPair();
  const cancel = await linkPair();
  const grantId = (await db.prepare('SELECT id FROM owner_grants WHERE invite_id = ?').bind(r.invite.id).first<string>('id'))!;
  expect(await staffRpc().ackMemberNotice({ ...system(), inviteId: r.invite.id, tokenHash: invite.hashB64 })).toEqual({ ok: true });
  expect(await staffRpc().ackMemberNotice({ ...system(), grantId, tokenHash: cancel.hashB64 })).toEqual({ ok: true });
  return { inviteId: r.invite.id, invite, cancel, grantId };
}

const accept = (tokenHash: Uint8Array, u: { email: string; sub: string }, o: { hd?: string | null; now?: number; requestId?: string } = {}): Promise<AcceptanceOutcome> =>
  acceptInvite(db, { tokenHash, email: u.email, provider: 'google', sub: u.sub, hd: o.hd ?? null, requestId: o.requestId ?? `req_${Math.random().toString(36).slice(2)}`, now: o.now ?? Date.now(), ipPrefix: ipPrefix('203.0.113.9'), country: 'AU' }, delay);

const person = () => ({ email: `${Math.random().toString(36).slice(2)}@partner.example`, sub: `g-${Math.random().toString(36).slice(2)}` });

async function counts() {
  const one = (sql: string) => db.prepare(sql).first<number>('n');
  return { users: await one('SELECT COUNT(*) AS n FROM console_users'), orgs: await one('SELECT COUNT(*) AS n FROM orgs'), members: await one('SELECT COUNT(*) AS n FROM members'), audit: await one('SELECT COUNT(*) AS n FROM audit_log') };
}

describe('an owner invite to an org with an owner (D89)', () => {
  it('is a viewer until owner_from = acceptance + ownerGrantDelayMs, then an owner by predicate, recorded once by the cron', async () => {
    const org = await seedOrg();
    await seedMember(org, 'owner');
    const p = person();
    const { invite, grantId } = await announcedOwnerInvite(org, p.email);
    const t = Date.now();
    const out = await accept(invite.hash, p, { now: t });
    expect(out).toMatchObject({ ok: true, orgId: org, role: 'viewer', newUser: true });
    if (!out.ok) return;
    const grant = await db.prepare('SELECT user_id, owner_from, applied_at FROM owner_grants WHERE id = ?').bind(grantId).first();
    expect(grant).toEqual({ user_id: out.userId, owner_from: t + DELAY, applied_at: null });
    expect(await roleOf(org, out.userId)).toBe('viewer');
    const listed = await staffRpc().listMembers({ ...hana(), orgId: org });
    expect(listed.ok && listed.members.find((m) => m.userId === out.userId)?.pendingOwnerFrom).toBe(t + DELAY);
    // Before owner_from the cron records nothing.
    expect((await applyGrants(db, t + DELAY - 1)).applied).toBe(0);
    // After it, an owner by predicate before the cron runs …
    shiftClock(DELAY + 1000);
    expect(await roleOf(org, out.userId)).toBe('owner');
    expect(await db.prepare('SELECT role FROM members WHERE org_id = ? AND user_id = ?').bind(org, out.userId).first('role')).toBe('viewer');
    // … and the cron records it once.
    const now = Date.now();
    expect(await applyGrants(db, now)).toEqual({ applied: expect.any(Number), orphaned: 0 });
    expect(await db.prepare('SELECT role, role_since FROM members WHERE org_id = ? AND user_id = ?').bind(org, out.userId).first()).toEqual({ role: 'owner', role_since: t + DELAY });
    expect(await db.prepare('SELECT applied_at FROM owner_grants WHERE id = ?').bind(grantId).first('applied_at')).toBe(now);
    await applyGrants(db, now + 1000);
    expect(await auditRows("action = 'member.owner_granted' AND org_id = ?", org)).toHaveLength(1);
  });

  it('can’t be accepted before the grant’s notice (with its cancel link) is acked', async () => {
    const org = await seedOrg();
    await seedMember(org, 'owner');
    const p = person();
    const r = await staffRpc().issueInvite({ ...hana(), email: p.email, role: 'owner', orgId: org });
    if (!r.ok) throw new Error(r.code);
    const invite = await linkPair();
    expect((await staffRpc().ackMemberNotice({ ...system(), inviteId: r.invite.id, tokenHash: invite.hashB64 })).ok).toBe(true);
    expect(await accept(invite.hash, p)).toEqual({ ok: false, code: 'invite_invalid' });
    const grantId = (await db.prepare('SELECT id FROM owner_grants WHERE invite_id = ?').bind(r.invite.id).first<string>('id'))!;
    expect((await staffRpc().ackMemberNotice({ ...system(), grantId, tokenHash: (await linkPair()).hashB64 })).ok).toBe(true);
    expect(await accept(invite.hash, p)).toMatchObject({ ok: true, role: 'viewer' });
  });

  it('a grant cancelled before acceptance leaves the person a viewer', async () => {
    const org = await seedOrg();
    await seedMember(org, 'owner');
    const p = person();
    const { invite, grantId } = await announcedOwnerInvite(org, p.email);
    expect(await staffRpc().cancelOwnerGrant({ ...hana(), grantId })).toEqual({ ok: true });
    const out = await accept(invite.hash, p);
    expect(out).toMatchObject({ ok: true, role: 'viewer' });
    shiftClock(DELAY * 2);
    if (out.ok) expect(await roleOf(org, out.userId)).toBe('viewer');
    await applyGrants(db, Date.now());
    expect(await db.prepare('SELECT applied_at, user_id FROM owner_grants WHERE id = ?').bind(grantId).first()).toEqual({ applied_at: null, user_id: null });
  });
});

describe('the first-owner exception', () => {
  it('the first owner of a new org is an owner on acceptance, in an org of the invite’s kind', async () => {
    await db.prepare("UPDATE orgs SET kind = 'internal' WHERE kind = 'partner'").run();
    await db.prepare("UPDATE invites SET new_org_kind = 'internal' WHERE new_org_kind = 'partner'").run();
    const p = person();
    const r = await staffRpc().issueInvite({ ...hana(), email: p.email, role: 'owner', newOrgName: 'Fresh Partner' });
    if (!r.ok) throw new Error(r.code);
    const invite = await linkPair();
    expect((await staffRpc().ackMemberNotice({ ...system(), inviteId: r.invite.id, tokenHash: invite.hashB64 })).ok).toBe(true);
    const out = await accept(invite.hash, p);
    expect(out).toMatchObject({ ok: true, role: 'owner' });
    if (!out.ok) return;
    expect(await db.prepare('SELECT name, kind, status FROM orgs WHERE id = ?').bind(out.orgId).first()).toEqual({ name: 'Fresh Partner', kind: 'partner', status: 'active' });
    expect(await db.prepare('SELECT role FROM members WHERE org_id = ? AND user_id = ?').bind(out.orgId, out.userId).first('role')).toBe('owner');
    const [row] = await auditRows("action = 'invite.accepted' AND target = ?", r.invite.id);
    expect(row).toMatchObject({ actor_kind: 'member', actor_id: out.userId, org_id: out.orgId });
    expect(JSON.parse(row!.details_json)).toEqual({ role: 'owner', newOrg: true });
  });

  it('an owner invite to an org with no usable owner applies its grant at once', async () => {
    const org = await seedOrg();
    await seedMember(org, 'owner', await seedUser({ disabled: true }));
    await seedMember(org, 'viewer');
    const p = person();
    const { invite, grantId } = await announcedOwnerInvite(org, p.email);
    const t = Date.now();
    const out = await accept(invite.hash, p, { now: t });
    expect(out).toMatchObject({ ok: true, role: 'owner' });
    expect(await db.prepare('SELECT owner_from, applied_at FROM owner_grants WHERE id = ?').bind(grantId).first()).toEqual({ owner_from: t, applied_at: t });
  });
});

describe('a promotion (staff setMember owner)', () => {
  it('creates a grant at once; owner_from = notified_at + delay; a viewer until then', async () => {
    const org = await seedOrg();
    await seedMember(org, 'owner');
    const v = await seedMember(org, 'viewer');
    const r = await staffRpc().setMember({ ...hana(), orgId: org, userId: v.id, role: 'owner' });
    expect(r).toEqual({ ok: true });
    const grant = (await db.prepare('SELECT id, user_id, invite_id, owner_from, notified_at FROM owner_grants WHERE org_id = ? AND user_id = ?').bind(org, v.id).first<{ id: string; owner_from: number | null }>())!;
    expect(grant).toMatchObject({ user_id: v.id, invite_id: null, owner_from: null, notified_at: null });
    // Without the notice the clock never starts, however long it waits.
    shiftClock(DELAY * 100);
    expect(await roleOf(org, v.id)).toBe('viewer');
    vi.restoreAllMocks();
    // The notice lists the promoted member and the current owners.
    const n = await staffRpc().pendingMemberNotices({ ...system(), limit: 100 });
    const mine = n.ok ? n.notices.find((x) => x.grant?.id === grant.id) : undefined;
    expect(mine).toMatchObject({ kind: 'owner_grant', member: { userId: v.id, email: v.email }, owners: [expect.objectContaining({ email: expect.any(String) })] });
    expect(mine?.invite).toBeUndefined();
    const t0 = Date.now();
    expect(await staffRpc().ackMemberNotice({ ...system(), grantId: grant.id, tokenHash: (await linkPair()).hashB64 })).toEqual({ ok: true });
    const after = (await db.prepare('SELECT owner_from, notified_at FROM owner_grants WHERE id = ?').bind(grant.id).first<{ owner_from: number; notified_at: number }>())!;
    expect(after.owner_from).toBe(after.notified_at + DELAY);
    expect(after.notified_at).toBeGreaterThanOrEqual(t0);
    expect(await roleOf(org, v.id)).toBe('viewer');
    shiftClock(DELAY + 1000);
    expect(await roleOf(org, v.id)).toBe('owner');
  });

  it('refuses a second promotion while one is pending; staff can cancel it, leaving a viewer', async () => {
    const org = await seedOrg();
    await seedMember(org, 'owner');
    const v = await seedMember(org, 'viewer');
    expect((await staffRpc().setMember({ ...hana(), orgId: org, userId: v.id, role: 'owner' })).ok).toBe(true);
    expect(await staffRpc().setMember({ ...hana(), orgId: org, userId: v.id, role: 'owner' })).toMatchObject({ ok: false, code: 'conflict' });
    const grantId = (await db.prepare('SELECT id FROM owner_grants WHERE org_id = ? AND user_id = ?').bind(org, v.id).first<string>('id'))!;
    expect(await staffRpc().cancelOwnerGrant({ ...hana(), grantId })).toEqual({ ok: true });
    expect(await staffRpc().cancelOwnerGrant({ ...hana(), grantId })).toMatchObject({ ok: false, code: 'not_pending' });
    expect(await roleOf(org, v.id)).toBe('viewer');
    expect((await auditRows("action = 'owner_grant.cancelled' AND target = ?", grantId)).map((r) => [r.actor_kind, JSON.parse(r.details_json)])).toEqual([['hana', { via: 'hana' }]]);
  });

  it('a pending owner doesn’t count for the last-owner rule', async () => {
    const org = await seedOrg();
    const owner = await seedMember(org, 'owner');
    const v = await seedMember(org, 'viewer');
    expect((await staffRpc().setMember({ ...hana(), orgId: org, userId: v.id, role: 'owner' })).ok).toBe(true);
    const grantId = (await db.prepare('SELECT id FROM owner_grants WHERE org_id = ? AND user_id = ?').bind(org, v.id).first<string>('id'))!;
    expect((await staffRpc().ackMemberNotice({ ...system(), grantId, tokenHash: (await linkPair()).hashB64 })).ok).toBe(true);
    expect(await staffRpc().setMember({ ...hana(), orgId: org, userId: owner.id, role: null })).toMatchObject({ ok: false, code: 'conflict' });
    expect(await staffRpc().setMember({ ...hana(), orgId: org, userId: owner.id, role: 'viewer' })).toMatchObject({ ok: false, code: 'conflict' });
    // Once matured, the other owner may go.
    shiftClock(DELAY + 1000);
    expect(await staffRpc().setMember({ ...hana(), orgId: org, userId: owner.id, role: null })).toEqual({ ok: true });
    expect(await roleOf(org, v.id)).toBe('owner');
  });
});

describe('cancel by the emailed link (POST /api/owner-grants/cancel)', () => {
  async function promotion() {
    const org = await seedOrg();
    await seedMember(org, 'owner');
    const v = await seedMember(org, 'viewer');
    expect((await staffRpc().setMember({ ...hana(), orgId: org, userId: v.id, role: 'owner' })).ok).toBe(true);
    const grantId = (await db.prepare('SELECT id FROM owner_grants WHERE org_id = ? AND user_id = ?').bind(org, v.id).first<string>('id'))!;
    const pair = await linkPair();
    expect((await staffRpc().ackMemberNotice({ ...system(), grantId, tokenHash: pair.hashB64 })).ok).toBe(true);
    return { org, v, grantId, pair };
  }

  it('cancels with the token, once, and leaves a viewer; audited as the link', async () => {
    const { org, v, grantId, pair } = await promotion();
    const res = await post('/api/owner-grants/cancel', { grantId, token: pair.tokenB64 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    const again = await post('/api/owner-grants/cancel', { grantId, token: pair.tokenB64 });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: 'not_pending' } });
    shiftClock(DELAY * 2);
    expect(await roleOf(org, v.id)).toBe('viewer');
    expect(await db.prepare('SELECT cancelled_by FROM owner_grants WHERE id = ?').bind(grantId).first('cancelled_by')).toBe(`link:${grantId}`);
    const rows = await auditRows("action = 'owner_grant.cancelled' AND target = ?", grantId);
    expect(rows).toEqual([expect.objectContaining({ actor_kind: 'link', actor_id: grantId, org_id: org, details_json: '{"via":"link"}' })]);
  });

  it('refuses a GET, a wrong token, another grant’s token and an unannounced grant (403, nothing written)', async () => {
    const a = await promotion();
    const b = await promotion();
    expect((await request(`/api/owner-grants/cancel?grantId=${a.grantId}&token=${a.pair.tokenB64}`)).status).toBe(405);
    expect((await post('/api/owner-grants/cancel', { grantId: a.grantId, token: b.pair.tokenB64 })).status).toBe(403);
    expect((await post('/api/owner-grants/cancel', { grantId: a.grantId, token: (await linkPair()).tokenB64 })).status).toBe(403);
    expect((await post('/api/owner-grants/cancel', { grantId: 'og_nosuchgrant1', token: a.pair.tokenB64 })).status).toBe(403);
    const org = await seedOrg();
    await seedMember(org, 'owner');
    const v = await seedMember(org, 'viewer');
    expect((await staffRpc().setMember({ ...hana(), orgId: org, userId: v.id, role: 'owner' })).ok).toBe(true);
    const unannounced = (await db.prepare('SELECT id FROM owner_grants WHERE org_id = ?').bind(org).first<string>('id'))!;
    expect((await post('/api/owner-grants/cancel', { grantId: unannounced, token: a.pair.tokenB64 })).status).toBe(403);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM owner_grants WHERE id IN (?, ?) AND cancelled_at IS NOT NULL').bind(a.grantId, b.grantId).first('n')).toBe(0);
    expect(await auditRows("action = 'owner_grant.cancelled' AND target IN (?, ?)", a.grantId, b.grantId)).toEqual([]);
  });

  it('is refused once owner_from has passed (the grant took effect)', async () => {
    const { org, v, grantId, pair } = await promotion();
    shiftClock(DELAY + 1000);
    const res = await post('/api/owner-grants/cancel', { grantId, token: pair.tokenB64 });
    expect(res.status).toBe(409);
    expect(await roleOf(org, v.id)).toBe('owner');
  });
});

describe('acceptance (one batch; the data path of C9)', () => {
  async function announcedInvite(org: string | null, email: string, role: 'owner' | 'viewer' = 'viewer') {
    const r = await staffRpc().issueInvite({ ...hana(), email, role, ...(org ? { orgId: org } : { newOrgName: 'New Org', kind: 'internal' }) });
    if (!r.ok) throw new Error(r.code);
    const pair = await linkPair();
    expect((await staffRpc().ackMemberNotice({ ...system(), inviteId: r.invite.id, tokenHash: pair.hashB64 })).ok).toBe(true);
    return { id: r.invite.id, pair };
  }

  it('refuses: not yet notified, wrong email, wrong hd, expired, revoked, reused, frozen org; and writes nothing', async () => {
    const org = await seedOrg({ requiredHd: 'partner.example' });
    const p = person();
    // Not notified: no token hash exists yet, so no token can match.
    const r = await staffRpc().issueInvite({ ...hana(), email: p.email, role: 'viewer', orgId: org });
    if (!r.ok) throw new Error(r.code);
    const before = await counts();
    expect(await accept((await linkPair()).hash, p, { hd: 'partner.example' })).toEqual({ ok: false, code: 'invite_invalid' });
    const { pair, id } = await announcedInvite(org, p.email.replace('@', '+x@'));
    expect(await accept(pair.hash, p, { hd: 'partner.example' })).toEqual({ ok: false, code: 'invite_invalid' });
    const ok = await announcedInvite(org, `w${p.email}`);
    expect(await accept(ok.pair.hash, { ...p, email: `w${p.email}` }, { hd: 'other.example' })).toEqual({ ok: false, code: 'invite_invalid' });
    expect(await accept(ok.pair.hash, { ...p, email: `w${p.email}` }, { hd: null })).toEqual({ ok: false, code: 'invite_invalid' });
    expect(await accept(ok.pair.hash, { ...p, email: `w${p.email}` }, { hd: 'partner.example', now: Date.now() + 8 * 24 * 60 * 60_000 })).toEqual({ ok: false, code: 'invite_invalid' });
    expect((await staffRpc().revokeInvite({ ...hana(), inviteId: id })).ok).toBe(true);
    expect(await accept(pair.hash, { ...p, email: p.email.replace('@', '+x@') }, { hd: 'partner.example' })).toEqual({ ok: false, code: 'invite_invalid' });
    const after = await counts();
    expect(after.users).toBe(before.users);
    expect(after.members).toBe(before.members);
    expect(after.orgs).toBe(before.orgs);
    // Only the invite issues, acks and the revoke wrote audit rows: no acceptance row.
    expect(await auditRows("action = 'invite.accepted' AND org_id = ?", org)).toEqual([]);
    // The right hd works; reuse is refused.
    expect(await accept(ok.pair.hash, { ...p, email: `w${p.email}` }, { hd: 'partner.example' })).toMatchObject({ ok: true });
    expect(await accept(ok.pair.hash, { ...p, email: `w${p.email}` }, { hd: 'partner.example' })).toMatchObject({ ok: false });
    const frozen = await seedOrg();
    const f = await announcedInvite(frozen, 'f@partner.example');
    await db.prepare("UPDATE orgs SET status = 'frozen' WHERE id = ?").bind(frozen).run();
    expect(await accept(f.pair.hash, { email: 'f@partner.example', sub: 'g-frozen' })).toEqual({ ok: false, code: 'invite_invalid' });
  });

  it('two concurrent acceptances give exactly one member', async () => {
    const org = await seedOrg();
    const p = person();
    const { pair } = await announcedInvite(org, p.email);
    const results = await Promise.all([accept(pair.hash, p), accept(pair.hash, p), accept(pair.hash, { ...p, sub: 'g-someone-else' })]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM members WHERE org_id = ?').bind(org).first('n')).toBe(1);
  });

  it('a disabled user is refused and the invite stays unconsumed', async () => {
    const org = await seedOrg();
    const u = await seedUser({ disabled: true });
    const { pair, id } = await announcedInvite(org, u.email);
    expect(await accept(pair.hash, u)).toEqual({ ok: false, code: 'user_disabled' });
    expect(await db.prepare('SELECT accepted_at FROM invites WHERE id = ?').bind(id).first('accepted_at')).toBeNull();
  });

  it('a member of org A joins org B with the same user id; already a member is already_member, the invite unconsumed', async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    const u: SeededUser = await seedMember(a, 'owner');
    const inB = await announcedInvite(b, u.email);
    const out = await accept(inB.pair.hash, u);
    expect(out).toMatchObject({ ok: true, userId: u.id, orgId: b, newUser: false });
    const again = await announcedInvite(a, u.email);
    expect(await accept(again.pair.hash, u)).toEqual({ ok: false, code: 'already_member' });
    expect(await db.prepare('SELECT accepted_at FROM invites WHERE id = ?').bind(again.id).first('accepted_at')).toBeNull();
  });

  it('a removed member re-invited keeps their user id', async () => {
    const org = await seedOrg();
    await seedMember(org, 'owner');
    const u = await seedMember(org, 'viewer');
    expect((await staffRpc().setMember({ ...hana(), orgId: org, userId: u.id, role: null })).ok).toBe(true);
    const { pair } = await announcedInvite(org, u.email);
    expect(await accept(pair.hash, u)).toMatchObject({ ok: true, userId: u.id, role: 'viewer' });
  });
});

describe('acceptance fails closed (scan findings)', () => {
  async function announced(email: string) {
    const org = await seedOrg();
    const r = await staffRpc().issueInvite({ ...hana(), email, role: 'viewer', orgId: org });
    if (!r.ok) throw new Error(r.code);
    const pair = await linkPair();
    expect((await staffRpc().ackMemberNotice({ ...system(), inviteId: r.invite.id, tokenHash: pair.hashB64 })).ok).toBe(true);
    return { org, id: r.invite.id, pair };
  }
  const userCount = (sub: string) => db.prepare('SELECT COUNT(*) AS n FROM console_users WHERE sub = ?').bind(sub).first<number>('n');
  const acceptedAt = (id: string) => db.prepare('SELECT accepted_at FROM invites WHERE id = ?').bind(id).first('accepted_at');

  it('a reused request id aborts the batch: another valid invite, a revoked one, an unknown token, the same one again', async () => {
    const requestId = `req_replay_${Math.random().toString(36).slice(2)}`;
    const p1 = person();
    const a = await announced(p1.email);
    expect(await accept(a.pair.hash, p1, { requestId })).toMatchObject({ ok: true });
    // Another person's valid invite under the same request id.
    const p2 = person();
    const b = await announced(p2.email);
    expect(await accept(b.pair.hash, p2, { requestId })).toEqual({ ok: false, code: 'invite_invalid' });
    expect(await acceptedAt(b.id)).toBeNull();
    expect(await userCount(p2.sub)).toBe(0);
    // A revoked invite under it: without the probe, the gate found the earlier commit row and the later statements ran.
    const p3 = person();
    const c = await announced(p3.email);
    expect((await staffRpc().revokeInvite({ ...hana(), inviteId: c.id })).ok).toBe(true);
    expect(await accept(c.pair.hash, p3, { requestId })).toEqual({ ok: false, code: 'invite_invalid' });
    expect(await acceptedAt(c.id)).toBeNull();
    expect(await userCount(p3.sub)).toBe(0);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM members WHERE org_id IN (?, ?)').bind(b.org, c.org).first('n')).toBe(0);
    // A token matching no invite: no stray user row either.
    const p4 = person();
    expect(await accept((await linkPair()).hash, p4, { requestId })).toEqual({ ok: false, code: 'invite_invalid' });
    expect(await userCount(p4.sub)).toBe(0);
    // The same acceptance replayed: still one audit row for the request.
    expect(await accept(a.pair.hash, p1, { requestId })).toEqual({ ok: false, code: 'invite_invalid' });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE request_id = ? AND action = 'invite.accepted'").bind(requestId).first('n')).toBe(1);
  });

  it('an invite revoked between its notice and the acceptance is refused and writes nothing', async () => {
    const p = person();
    const { id, pair, org } = await announced(p.email);
    expect((await staffRpc().revokeInvite({ ...hana(), inviteId: id })).ok).toBe(true);
    const before = await counts();
    expect(await accept(pair.hash, p)).toEqual({ ok: false, code: 'invite_invalid' });
    expect(await acceptedAt(id)).toBeNull();
    expect(await userCount(p.sub)).toBe(0);
    expect(await counts()).toEqual(before);
    expect(await auditRows("action = 'invite.accepted' AND org_id = ?", org)).toEqual([]);
  });
});

// D343: freezing an org pauses its pending memberships. A grant still waiting loses its notice and its clock (it is
// re-confirmed after the unfreeze: a new notice, then the full wait), the cron records nothing in a frozen org, open
// invites lose their notice (the link stops working) and no notice of a frozen org is listed or acked.
describe('a freeze pauses pending owner grants and invites (D343)', () => {
  const freeze = (orgId: string, frozen: boolean) => staffRpc().freezeOrg({ ...hana(), orgId, frozen });
  // The data function itself, with a limit past every other test's leftovers (StaffRpc caps a page).
  const notices = () => pendingMemberNotices(db, Date.now(), 10_000);
  const appliedAt = (grantId: string) => db.prepare('SELECT applied_at FROM owner_grants WHERE id = ?').bind(grantId).first<number | null>('applied_at');

  it('an accepted owner invite’s grant neither matures nor is recorded while frozen, and waits the full delay from its new notice', async () => {
    const org = await seedOrg();
    await seedMember(org, 'owner');
    const p = person();
    const { invite, grantId, cancel } = await announcedOwnerInvite(org, p.email);
    const out = await accept(invite.hash, p);
    if (!out.ok) throw new Error(out.code);
    expect(await freeze(org, true)).toEqual({ ok: true });
    expect(await db.prepare('SELECT notified_at, owner_from, cancel_token_hash FROM owner_grants WHERE id = ?').bind(grantId).first()).toEqual({ notified_at: null, owner_from: null, cancel_token_hash: null });
    // Past the old owner_from: still a viewer, and the cron records nothing; no notice is listed for a frozen org.
    const later = Date.now() + DELAY + 1000;
    shiftClock(DELAY + 1000);
    expect(await roleOf(org, out.userId)).toBe('viewer');
    await applyGrants(db, later);
    expect(await appliedAt(grantId)).toBeNull();
    expect((await notices()).some((n) => n.grant?.id === grantId)).toBe(false);
    // The old cancel link doesn't work while the notice is undone (the grant can't mature meanwhile).
    expect((await post('/api/owner-grants/cancel', { grantId, token: cancel.tokenB64 })).status).toBe(403);
    // An ack while frozen is refused.
    expect(await staffRpc().ackMemberNotice({ ...system(), grantId, tokenHash: cancel.hashB64 })).toMatchObject({ ok: false, code: 'not_pending' });
    // After the unfreeze it is listed again and, once acked, waits the whole ownerGrantDelayMs from that notice.
    expect(await freeze(org, false)).toEqual({ ok: true });
    expect((await notices()).some((n) => n.kind === 'owner_grant' && n.grant?.id === grantId)).toBe(true);
    expect(await roleOf(org, out.userId)).toBe('viewer');
    const ackAt = Date.now();
    expect(await staffRpc().ackMemberNotice({ ...system(), grantId, tokenHash: cancel.hashB64 })).toEqual({ ok: true });
    const ownerFrom = (await db.prepare('SELECT owner_from FROM owner_grants WHERE id = ?').bind(grantId).first<number>('owner_from'))!;
    expect(ownerFrom).toBeGreaterThanOrEqual(ackAt + DELAY);
    expect(await roleOf(org, out.userId)).toBe('viewer');
    await applyGrants(db, ownerFrom - 1);
    expect(await appliedAt(grantId)).toBeNull();
    await applyGrants(db, ownerFrom + 1);
    expect(await appliedAt(grantId)).toBe(ownerFrom + 1);
    expect(await db.prepare('SELECT role FROM members WHERE org_id = ? AND user_id = ?').bind(org, out.userId).first('role')).toBe('owner');
  });

  it('a promotion’s grant is paused and re-confirmed the same way', async () => {
    const org = await seedOrg();
    await seedMember(org, 'owner');
    const v = await seedMember(org, 'viewer');
    expect(await staffRpc().setMember({ ...hana(), orgId: org, userId: v.id, role: 'owner' })).toEqual({ ok: true });
    const grantId = (await db.prepare('SELECT id FROM owner_grants WHERE org_id = ? AND user_id = ?').bind(org, v.id).first<string>('id'))!;
    const cancel = await linkPair();
    expect(await staffRpc().ackMemberNotice({ ...system(), grantId, tokenHash: cancel.hashB64 })).toEqual({ ok: true });
    expect(await freeze(org, true)).toEqual({ ok: true });
    shiftClock(DELAY + 1000);
    expect(await roleOf(org, v.id)).toBe('viewer');
    expect(await freeze(org, false)).toEqual({ ok: true });
    expect(await roleOf(org, v.id)).toBe('viewer');
    expect((await notices()).some((n) => n.grant?.id === grantId && n.member?.userId === v.id)).toBe(true);
  });

  it('a grant that had matured before the freeze stays matured, and the cron records it only once the org is active', async () => {
    const org = await seedOrg();
    await seedMember(org, 'owner');
    const v = await seedMember(org, 'viewer');
    expect(await staffRpc().setMember({ ...hana(), orgId: org, userId: v.id, role: 'owner' })).toEqual({ ok: true });
    const grantId = (await db.prepare('SELECT id FROM owner_grants WHERE org_id = ? AND user_id = ?').bind(org, v.id).first<string>('id'))!;
    expect(await staffRpc().ackMemberNotice({ ...system(), grantId, tokenHash: (await linkPair()).hashB64 })).toEqual({ ok: true });
    await db.prepare('UPDATE owner_grants SET owner_from = ? WHERE id = ?').bind(Date.now() - 1000, grantId).run();
    expect(await freeze(org, true)).toEqual({ ok: true });
    expect(await roleOf(org, v.id)).toBe('owner');
    await applyGrants(db, Date.now());
    expect(await appliedAt(grantId)).toBeNull();
    expect(await freeze(org, false)).toEqual({ ok: true });
    await applyGrants(db, Date.now());
    expect(await appliedAt(grantId)).not.toBeNull();
  });

  it('open invites lose their notice: the link stops working, no notice is listed or acked while frozen, and a new one is needed after', async () => {
    const org = await seedOrg();
    await seedMember(org, 'owner');
    const p = person();
    const r = await staffRpc().issueInvite({ ...hana(), email: p.email, role: 'viewer', orgId: org });
    if (!r.ok) throw new Error(r.code);
    const unsent = await staffRpc().issueInvite({ ...hana(), email: person().email, role: 'viewer', orgId: org });
    if (!unsent.ok) throw new Error(unsent.code);
    const link = await linkPair();
    expect(await staffRpc().ackMemberNotice({ ...system(), inviteId: r.invite.id, tokenHash: link.hashB64 })).toEqual({ ok: true });
    expect(await freeze(org, true)).toEqual({ ok: true });
    expect(await db.prepare('SELECT token_hash, notified_at FROM invites WHERE id = ?').bind(r.invite.id).first()).toEqual({ token_hash: null, notified_at: null });
    expect((await notices()).some((n) => n.invite?.orgId === org)).toBe(false);
    expect(await staffRpc().ackMemberNotice({ ...system(), inviteId: unsent.invite.id, tokenHash: (await linkPair()).hashB64 })).toMatchObject({ ok: false, code: 'not_pending' });
    expect(await accept(link.hash, p)).toEqual({ ok: false, code: 'invite_invalid' });
    // After the unfreeze the old link still doesn't work until the invite's notice is sent and acked again.
    expect(await freeze(org, false)).toEqual({ ok: true });
    expect(await accept(link.hash, p)).toEqual({ ok: false, code: 'invite_invalid' });
    const listed = (await notices()).filter((n) => n.kind === 'invite' && n.invite?.orgId === org).map((n) => n.invite!.id);
    expect(listed.sort()).toEqual([r.invite.id, unsent.invite.id].sort());
    expect(await staffRpc().ackMemberNotice({ ...system(), inviteId: r.invite.id, tokenHash: link.hashB64 })).toEqual({ ok: true });
    expect(await accept(link.hash, p)).toMatchObject({ ok: true, role: 'viewer' });
  });
});
