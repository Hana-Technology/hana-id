// The membership rules at sign-in and invite acceptance through the whole sign-in (docs/batch-c-spec.md "Membership
// rules at sign-in"; "Tests: Invites and roles" acceptance rows): refused invites (expired, revoked, reused, wrong email,
// wrong hd, not yet notified), two concurrent acceptances, a refused acceptance writing nothing, a removed member
// re-invited keeping their id, a disabled user, a member of org A joining org B, `already_member`, a new-org invite,
// not invited, `required_hd`, frozen orgs; and that a session stops working when the member is removed, their role
// changes, the user is disabled or their only org is frozen.
import { b64url, randomBytes } from '@hana-id/console-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type GoogleAccount, MockGoogle, account, getWith, landing, signIn } from './google.ts';
import { auditRows, db, hana, linkPair, post, seedOrg, shiftClock, staffRpc, system } from './helpers.ts';

let google: MockGoogle;
beforeEach(async () => {
  google = new MockGoogle();
  await google.init();
});
afterEach(() => vi.restoreAllMocks());

/** Issues a staff invite and acks its notice (and an owner grant's) as the admin Worker would; returns the link token. */
async function notifiedInvite(o: { email: string; role?: 'owner' | 'viewer'; orgId?: string; newOrgName?: string; ack?: boolean }): Promise<{ token: string; inviteId: string }> {
  const r = await staffRpc().issueInvite({ ...hana(), email: o.email, role: o.role ?? 'viewer', ...(o.orgId ? { orgId: o.orgId } : { newOrgName: o.newOrgName ?? 'New Org', kind: 'internal' }) });
  if (!r.ok) throw new Error(`issueInvite: ${r.code} ${r.error ?? ''}`);
  const pair = await linkPair();
  if (o.ack !== false) {
    const ack = await staffRpc().ackMemberNotice({ ...system(), inviteId: r.invite.id, tokenHash: pair.hashB64 });
    if (!ack.ok) throw new Error(`ack: ${ack.code}`);
    const notices = await staffRpc().pendingMemberNotices({ ...system(), limit: 100 });
    if (!notices.ok) throw new Error(notices.code);
    for (const n of notices.notices) {
      if (n.kind === 'owner_grant' && n.grant?.inviteId === r.invite.id) {
        const g = await linkPair();
        const ga = await staffRpc().ackMemberNotice({ ...system(), grantId: n.grant.id, tokenHash: g.hashB64 });
        if (!ga.ok) throw new Error(`grant ack: ${ga.code}`);
      }
    }
  }
  return { token: pair.tokenB64, inviteId: r.invite.id };
}

async function userBySub(sub: string) {
  return db.prepare('SELECT id, email, disabled_at FROM console_users WHERE sub = ?').bind(sub).first<{ id: string; email: string; disabled_at: number | null }>();
}

const memberRow = (orgId: string, userId: string) => db.prepare('SELECT role FROM members WHERE org_id = ? AND user_id = ?').bind(orgId, userId).first<{ role: string }>();

async function counts() {
  const one = async (t: string) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<number>('n'))!;
  return { users: await one('console_users'), orgs: await one('orgs'), members: await one('members'), audit: await one("audit_log WHERE action = 'invite.accepted'") };
}

/** Signs `acct` in as an existing member of a fresh org; returns the session cookie. */
async function memberSession(acct: GoogleAccount, o: { requiredHd?: string } = {}) {
  const org = await seedOrg(o.requiredHd ? { requiredHd: o.requiredHd } : {});
  const { token } = await notifiedInvite({ email: acct.email, orgId: org, role: 'viewer' });
  const s = await signIn(google, acct, { invite: token });
  expect(landing(s)).toBe('/');
  return { org, cs: s.browser.cs!, userId: (await userBySub(acct.sub))!.id };
}

describe('invite acceptance through sign-in', () => {
  it('a viewer invite: the account becomes a member, the invite is consumed, the session works', async () => {
    const org = await seedOrg();
    const acct = account();
    const { token, inviteId } = await notifiedInvite({ email: acct.email, orgId: org });
    const s = await signIn(google, acct, { invite: token });
    expect(s.auth!.loginHint).toBe(acct.email);
    expect(landing(s)).toBe('/');
    const user = (await userBySub(acct.sub))!;
    expect(await memberRow(org, user.id)).toEqual({ role: 'viewer' });
    const inv = await db.prepare('SELECT accepted_user_id, accepted_by_sub FROM invites WHERE id = ?').bind(inviteId).first();
    expect(inv).toEqual({ accepted_user_id: user.id, accepted_by_sub: acct.sub });
    expect(await auditRows("action = 'session.signed_in' AND target = ?", user.id)).toMatchObject([{ details_json: '{"invite":true}' }]);
    const me = (await (await getWith(s.browser.cs, '/api/me')).json()) as { memberships: { orgId: string; role: string }[] };
    expect(me.memberships).toEqual([expect.objectContaining({ orgId: org, role: 'viewer' })]);
  });

  it('a new-org invite creates the org, its member row on the new id, and an owner at once', async () => {
    const acct = account();
    const { token } = await notifiedInvite({ email: acct.email, role: 'owner', newOrgName: 'Acme Partner' });
    const s = await signIn(google, acct, { invite: token });
    expect(landing(s)).toBe('/');
    const me = (await (await getWith(s.browser.cs, '/api/me')).json()) as { memberships: { orgId: string; orgName: string; role: string }[] };
    expect(me.memberships).toEqual([expect.objectContaining({ orgName: 'Acme Partner', role: 'owner' })]);
    const orgId = me.memberships[0]!.orgId;
    expect(await db.prepare('SELECT name FROM orgs WHERE id = ?').bind(orgId).first('name')).toBe('Acme Partner');
  });

  it('an owner invite to an org with an owner: a viewer until the grant matures', async () => {
    const owner = account();
    const { org } = await memberSession(owner);
    // Make the first member the owner (staff promotion of the only member: the first-owner exception).
    const ownerUser = (await userBySub(owner.sub))!;
    expect(await staffRpc().setMember({ ...hana(), orgId: org, userId: ownerUser.id, role: 'owner' })).toMatchObject({ ok: true });
    const acct = account();
    const { token } = await notifiedInvite({ email: acct.email, orgId: org, role: 'owner' });
    const s = await signIn(google, acct, { invite: token });
    expect(landing(s)).toBe('/');
    const me = (await (await getWith(s.browser.cs, '/api/me')).json()) as { memberships: { role: string }[] };
    expect(me.memberships[0]!.role).toBe('viewer');
  });

  it('refused, unconsumed: expired, revoked, not yet notified (the link does nothing before the notice)', async () => {
    const org = await seedOrg();
    const acct = account();
    // Not notified: no token_hash, so the link names no invite at all.
    const pending = await notifiedInvite({ email: acct.email, orgId: org, ack: false });
    const r1 = await post('/api/auth/start', { purpose: 'login', invite: pending.token });
    expect(r1.status).toBe(403);
    expect(await r1.json()).toMatchObject({ error: { code: 'invite_invalid' } });
    // Revoked before sign-in.
    const org2 = await seedOrg();
    const revoked = await notifiedInvite({ email: acct.email, orgId: org2 });
    expect(await staffRpc().revokeInvite({ ...hana(), inviteId: revoked.inviteId })).toEqual({ ok: true });
    expect((await post('/api/auth/start', { purpose: 'login', invite: revoked.token })).status).toBe(403);
    // Expired (7 days).
    const org3 = await seedOrg();
    const expired = await notifiedInvite({ email: acct.email, orgId: org3 });
    shiftClock(7 * 24 * 3600_000 + 1000);
    expect((await post('/api/auth/start', { purpose: 'login', invite: expired.token })).status).toBe(403);
    vi.restoreAllMocks();
    await google.init();
    expect(await userBySub(acct.sub)).toBeNull();
  });

  it('revoked between the start and the end of the sign-in: invite_invalid, nothing written', async () => {
    const org = await seedOrg();
    const acct = account();
    const { token, inviteId } = await notifiedInvite({ email: acct.email, orgId: org });
    const before = await counts();
    // The flow runs to the callback; staff revoke the invite; then the browser completes.
    const s = await signIn(google, acct, { invite: token, beforeComplete: async () => void expect(await staffRpc().revokeInvite({ ...hana(), inviteId })).toEqual({ ok: true }) });
    expect(landing(s)).toBe('/signin#error=invite_invalid');
    expect(s.browser.cs).toBeUndefined();
    expect(await counts()).toEqual(before);
    // And the same link can't start another sign-in.
    expect((await signIn(google, acct, { invite: token })).start.status).toBe(403);
  });

  it('expired between the start and the end of the sign-in: invite_invalid, nothing written', async () => {
    const org = await seedOrg();
    const acct = account();
    const { token } = await notifiedInvite({ email: acct.email, orgId: org });
    const before = await counts();
    // Start 30 s before the 7 days end, complete 10 s after (inside the handoff's 60 s).
    const move = shiftClock(7 * 24 * 3600_000 - 30_000);
    const s = await signIn(google, acct, { invite: token, beforeComplete: async () => move(40_000) });
    expect(landing(s)).toBe('/signin#error=invite_invalid');
    expect(await counts()).toEqual(before);
  });

  it('wrong email: invite_invalid, and the refused acceptance inserts no user, org, member or audit row', async () => {
    const org = await seedOrg();
    const { token, inviteId } = await notifiedInvite({ email: 'invited@partner.example', orgId: org });
    const before = await counts();
    const s = await signIn(google, account({ email: 'someone-else@partner.example' }), { invite: token });
    expect(landing(s)).toBe('/signin#error=invite_invalid');
    expect(await counts()).toEqual(before);
    expect(await db.prepare('SELECT accepted_at FROM invites WHERE id = ?').bind(inviteId).first('accepted_at')).toBeNull();
  });

  it("wrong hd: an org with required_hd refuses another Workspace's (or a personal) account", async () => {
    const org = await seedOrg({ requiredHd: 'partner.example' });
    const acct = account({ hd: 'other.example' });
    const { token } = await notifiedInvite({ email: acct.email, orgId: org });
    expect(landing(await signIn(google, acct, { invite: token }))).toBe('/signin#error=invite_invalid');
    expect(landing(await signIn(google, { ...acct, hd: undefined } as never, { invite: token }))).toBe('/signin#error=invite_invalid');
    expect(landing(await signIn(google, { ...acct, hd: 'partner.example' }, { invite: token }))).toBe('/');
  });

  it('reused: a second person with the same link (or the same person again) gets invite_invalid', async () => {
    const org = await seedOrg();
    const acct = account();
    const { token } = await notifiedInvite({ email: acct.email, orgId: org });
    expect(landing(await signIn(google, acct, { invite: token }))).toBe('/');
    expect((await signIn(google, account({ email: acct.email }), { invite: token })).start.status).toBe(403);
  });

  it('two concurrent acceptances of one invite: exactly one member', async () => {
    const org = await seedOrg();
    const email = `race-${b64url(randomBytes(4)).toLowerCase()}@partner.example`;
    const { token } = await notifiedInvite({ email, orgId: org });
    const a = account({ email });
    const b = account({ email });
    // Both flows reach the callback before either completes.
    const runToCallback = async (acct: GoogleAccount) => {
      const steps = await signIn(google, acct, { invite: token });
      return steps;
    };
    const [sa, sb] = await Promise.all([runToCallback(a), runToCallback(b)]);
    const outcomes = [landing(sa), landing(sb)].sort();
    expect(outcomes).toEqual(['/', '/signin#error=invite_invalid']);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM members WHERE org_id = ?').bind(org).first<number>('n'))).toBe(1);
  });

  it('a member of org A joins org B with an invite; already a member of B: already_member, unconsumed', async () => {
    const acct = account();
    const { org: orgA, userId } = await memberSession(acct);
    const orgB = await seedOrg();
    const { token } = await notifiedInvite({ email: acct.email, orgId: orgB });
    const s = await signIn(google, acct, { invite: token });
    expect(landing(s)).toBe('/');
    expect((await userBySub(acct.sub))!.id).toBe(userId);
    const me = (await (await getWith(s.browser.cs, '/api/me')).json()) as { memberships: { orgId: string }[] };
    expect(me.memberships.map((m) => m.orgId).sort()).toEqual([orgA, orgB].sort());
    // A second invite to org A, where they already are a member.
    const again = await notifiedInvite({ email: acct.email, orgId: orgA });
    expect(landing(await signIn(google, acct, { invite: again.token }))).toBe('/signin#error=already_member');
    expect(await db.prepare('SELECT accepted_at FROM invites WHERE id = ?').bind(again.inviteId).first('accepted_at')).toBeNull();
  });

  it('a removed member re-invited keeps their user id', async () => {
    const acct = account();
    const { org, userId } = await memberSession(acct);
    expect(await staffRpc().setMember({ ...hana(), orgId: org, userId, role: null })).toMatchObject({ ok: true });
    const { token } = await notifiedInvite({ email: acct.email, orgId: org });
    expect(landing(await signIn(google, acct, { invite: token }))).toBe('/');
    expect((await userBySub(acct.sub))!.id).toBe(userId);
    expect(await memberRow(org, userId)).toEqual({ role: 'viewer' });
  });

  it("a disabled user: user_disabled (audited), the invite stays unconsumed, no session", async () => {
    const acct = account();
    const { userId } = await memberSession(acct);
    expect(await staffRpc().disableUser({ ...hana(), userId, disabled: true })).toMatchObject({ ok: true });
    const orgB = await seedOrg();
    const { token, inviteId } = await notifiedInvite({ email: acct.email, orgId: orgB });
    const s = await signIn(google, acct, { invite: token });
    expect(landing(s)).toBe('/signin#error=user_disabled');
    expect(s.browser.cs).toBeUndefined();
    expect(await db.prepare('SELECT accepted_at FROM invites WHERE id = ?').bind(inviteId).first('accepted_at')).toBeNull();
    // Without an invite too.
    expect(landing(await signIn(google, acct))).toBe('/signin#error=user_disabled');
    const rows = await auditRows("action = 'signin.refused' AND target = ?", userId);
    expect(rows.map((r) => r.details_json)).toEqual(['{"code":"user_disabled"}', '{"code":"user_disabled"}']);
  });
});

describe('sign-in without an invite', () => {
  it('not invited: 403 not_invited, no user row, audited with the address sha256 only', async () => {
    const acct = account();
    const s = await signIn(google, acct);
    expect(landing(s)).toBe('/signin#error=not_invited');
    expect(await userBySub(acct.sub)).toBeNull();
    const rows = (await db.prepare("SELECT actor_kind, actor_id, target, details_json, outcome, actor_email, actor_sub FROM audit_log WHERE action = 'signin.refused' ORDER BY seq DESC LIMIT 1").all()).results;
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(acct.email))), (b) => b.toString(16).padStart(2, '0')).join('');
    expect(rows).toEqual([{ actor_kind: 'system', actor_id: 'console-sign-in', target: null, details_json: JSON.stringify({ code: 'not_invited', emailSha256: hash }), outcome: 'failed', actor_email: null, actor_sub: null }]);
    expect(JSON.stringify(rows)).not.toContain(acct.email);
    expect(JSON.stringify(rows)).not.toContain(acct.sub);
  });

  it('an existing user with no usable membership (removed everywhere, only a frozen org, or another hd) is not invited', async () => {
    const acct = account();
    const { org, userId } = await memberSession(acct);
    expect(await staffRpc().freezeOrg({ ...hana(), orgId: org, frozen: true })).toMatchObject({ ok: true });
    expect(landing(await signIn(google, acct))).toBe('/signin#error=not_invited');
    expect(await staffRpc().freezeOrg({ ...hana(), orgId: org, frozen: false })).toMatchObject({ ok: true });
    expect(landing(await signIn(google, acct))).toBe('/');
    expect(await staffRpc().setMember({ ...hana(), orgId: org, userId, role: null })).toMatchObject({ ok: true });
    expect(landing(await signIn(google, acct))).toBe('/signin#error=not_invited');
  });

  it("required_hd: memberships in orgs whose required_hd isn't the token's hd are ignored, at sign-in and in /api/me", async () => {
    const acct = account({ hd: 'partner.example' });
    const { org: plain, userId } = await memberSession(acct);
    const strict = await seedOrg({ requiredHd: 'partner.example' });
    await db.prepare("INSERT INTO members (org_id, user_id, role, role_since, added_by, added_at) VALUES (?, ?, 'viewer', 0, 'test', 0)").bind(strict, userId).run();
    const other = await seedOrg({ requiredHd: 'elsewhere.example' });
    await db.prepare("INSERT INTO members (org_id, user_id, role, role_since, added_by, added_at) VALUES (?, ?, 'viewer', 0, 'test', 0)").bind(other, userId).run();
    const s = await signIn(google, acct);
    const me = (await (await getWith(s.browser.cs, '/api/me')).json()) as { memberships: { orgId: string }[] };
    expect(me.memberships.map((m) => m.orgId).sort()).toEqual([plain, strict].sort());
    expect((await getWith(s.browser.cs, `/api/orgs/${other}`)).status).toBe(404);
    // A personal account (no hd) of the same sub sees only the org without a required domain.
    const personal = await signIn(google, { sub: acct.sub, email: acct.email });
    const me2 = (await (await getWith(personal.browser.cs, '/api/me')).json()) as { memberships: { orgId: string }[] };
    expect(me2.memberships.map((m) => m.orgId)).toEqual([plain]);
  });
});

describe('a session ends with the membership that made it', () => {
  it('removal, a role change, a disabled user and freezing their only org each revoke the session at once', async () => {
    for (const change of ['remove', 'role', 'disable', 'freeze'] as const) {
      const acct = account();
      const { org, userId, cs } = await memberSession(acct);
      expect((await getWith(cs, '/api/me')).status, change).toBe(200);
      const rpc = staffRpc();
      if (change === 'remove') await rpc.setMember({ ...hana(), orgId: org, userId, role: null });
      if (change === 'role') await rpc.setMember({ ...hana(), orgId: org, userId, role: 'owner' });
      if (change === 'disable') await rpc.disableUser({ ...hana(), userId, disabled: true });
      if (change === 'freeze') await rpc.freezeOrg({ ...hana(), orgId: org, frozen: true });
      expect((await getWith(cs, '/api/me')).status, change).toBe(401);
    }
  });

  it('roles are read on every request: a pending owner whose grant matures is an owner on the next request', async () => {
    const owner = account();
    const { org } = await memberSession(owner);
    await staffRpc().setMember({ ...hana(), orgId: org, userId: (await userBySub(owner.sub))!.id, role: 'owner' });
    const acct = account();
    const { token } = await notifiedInvite({ email: acct.email, orgId: org, role: 'owner' });
    const s = await signIn(google, acct, { invite: token });
    const role = async () => ((await (await getWith(s.browser.cs, `/api/orgs/${org}`)).json()) as { role: string }).role;
    expect(await role()).toBe('viewer');
    shiftClock(61_000); // ownerGrantDelayMs in the test manifest
    expect(await role()).toBe('owner');
  });

  it('idle 2 h and absolute 12 h, through the BFF', async () => {
    const acct = account();
    const { cs } = await memberSession(acct);
    const move = shiftClock(2 * 3600_000 + 1000);
    expect((await getWith(cs, '/api/me')).status).toBe(401);
    void move;
    vi.restoreAllMocks();
    await google.init();
    const acct2 = account();
    const s2 = await memberSession(acct2);
    const step = shiftClock(0);
    for (let h = 1; h < 12; h++) {
      step(3600_000);
      expect((await getWith(s2.cs, '/api/me')).status, `${h} h`).toBe(200);
    }
    step(3600_000);
    expect((await getWith(s2.cs, '/api/me')).status).toBe(401);
  });
});
