// Invites through StaffRpc (docs/batch-c-spec.md "Invites and owner grants", "Tests: Invites and roles" rows that
// need no sign-in): who may call what, the 10-open-invites cap, notice first (no working link before the admin
// Worker's ack), the passkey gate, revocation, replays, and that no answer, row view or audit row ever carries a token,
// a token hash or (in the audit trail) the invitee's address.
import { LEGACY_ORG_ID, MAX_OPEN_INVITES, type MemberNotice } from '@hana-id/console-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { auditRows, db, hana, linkPair, member, seedMember, seedOrg, staffRpc, system } from './helpers.ts';

afterEach(() => vi.restoreAllMocks());

const issue = (o: Record<string, unknown>) => staffRpc().issueInvite({ ...hana(), role: 'viewer', email: `p${Math.random().toString(36).slice(2)}@partner.example`, ...o });

/** Every partner org but the legacy one, so the passkey gate tests start from "no partner org yet". */
async function clearPartnerOrgs(): Promise<void> {
  await db.prepare("UPDATE orgs SET kind = 'internal' WHERE kind = 'partner'").run();
  await db.prepare("UPDATE invites SET new_org_kind = 'internal' WHERE new_org_kind = 'partner'").run();
}

async function notices(): Promise<MemberNotice[]> {
  const r = await staffRpc().pendingMemberNotices({ ...system(), limit: 100 });
  if (!r.ok) throw new Error(r.code);
  return r.notices;
}

describe('StaffRpc actors and input', () => {
  it('refuses member and link actors on every staff method, and system on staff writes', async () => {
    const org = await seedOrg();
    const rpc = staffRpc();
    const link = { actor: { kind: 'link' as const, id: 'gc_x' }, requestId: 'req_12345678', clientIp: '203.0.113.1' };
    for (const ctx of [member(), link]) {
      expect(await rpc.issueInvite({ ...ctx, email: 'a@b.example', role: 'viewer', orgId: org })).toMatchObject({ ok: false, code: 'forbidden' });
      expect(await rpc.getOrg({ ...ctx, orgId: org })).toMatchObject({ ok: false, code: 'forbidden' });
      expect(await rpc.auditSince({ ...ctx, seq: 0, limit: 10 })).toMatchObject({ ok: false, code: 'forbidden' });
    }
    expect(await rpc.issueInvite({ ...system(), email: 'a@b.example', role: 'viewer', orgId: org })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await rpc.setMember({ ...system(), orgId: org, userId: 'usr_x', role: null })).toMatchObject({ ok: false, code: 'forbidden' });
  });

  it('only the admin Worker’s cron (system) may ack a notice, never a staffer by hand', async () => {
    const org = await seedOrg();
    const r = await issue({ orgId: org });
    if (!r.ok) throw new Error(r.code);
    const { hashB64 } = await linkPair();
    expect(await staffRpc().ackMemberNotice({ ...hana(), inviteId: r.invite.id, tokenHash: hashB64 })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await staffRpc().ackMemberNotice({ ...system(), inviteId: r.invite.id, tokenHash: hashB64 })).toEqual({ ok: true });
  });

  it('validates input: unknown fields, both or neither target, a viewer as a new org’s first member, kind without a new org', async () => {
    const org = await seedOrg();
    expect(await issue({ orgId: org, extra: 1 })).toMatchObject({ code: 'bad_request' });
    expect(await issue({})).toMatchObject({ code: 'bad_request' });
    expect(await issue({ orgId: org, newOrgName: 'Acme' })).toMatchObject({ code: 'bad_request' });
    expect(await issue({ newOrgName: 'Acme', role: 'viewer' })).toMatchObject({ code: 'bad_request' });
    expect(await issue({ orgId: org, kind: 'partner' })).toMatchObject({ code: 'bad_request' });
    expect(await issue({ orgId: org, email: 'not-an-email' })).toMatchObject({ code: 'bad_request' });
    expect(await issue({ newOrgName: 'Bad‮Name', role: 'owner', kind: 'internal' })).toMatchObject({ code: 'bad_request' });
  });

  it('never acts for org_legacy, an unknown or a frozen org', async () => {
    expect(await issue({ orgId: LEGACY_ORG_ID })).toMatchObject({ code: 'forbidden' });
    expect(await issue({ orgId: 'org_unknown123' })).toMatchObject({ code: 'not_found' });
    expect(await issue({ orgId: await seedOrg({ status: 'frozen' }) })).toMatchObject({ code: 'conflict' });
  });
});

describe('issueInvite', () => {
  it('stores the address trimmed and lowercased, 7 days from creation, unusable (no token hash) until the notice', async () => {
    const org = await seedOrg();
    const r = await issue({ orgId: org, email: '  New.Person+tag@Partner.Example ' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.invite).toMatchObject({ email: 'new.person+tag@partner.example', orgId: org, role: 'viewer', createdByKind: 'hana', createdBy: 'access-sub-staff-1' });
    expect(r.invite.expiresAt - r.invite.createdAt).toBe(7 * 24 * 60 * 60_000);
    expect(r.invite.notifiedAt).toBeUndefined();
    const row = await db.prepare('SELECT token_hash, notified_at FROM invites WHERE id = ?').bind(r.invite.id).first();
    expect(row).toEqual({ token_hash: null, notified_at: null });
  });

  it('returns no token and no token hash, and never will: the answer, getOrg and the notices carry none', async () => {
    const org = await seedOrg();
    await seedMember(org, 'owner');
    const r = await issue({ orgId: org, role: 'owner' });
    if (!r.ok) throw new Error(r.code);
    const { hash, hashB64 } = await linkPair();
    const forbidden = (text: string) => {
      expect(text).not.toMatch(/token/iu);
      expect(text).not.toContain(hashB64);
      expect(text).not.toMatch(/"[A-Za-z0-9_-]{43}"/u);
    };
    forbidden(JSON.stringify(r));
    forbidden(JSON.stringify(await notices()));
    expect((await staffRpc().ackMemberNotice({ ...system(), inviteId: r.invite.id, tokenHash: hashB64 })).ok).toBe(true);
    forbidden(JSON.stringify(await staffRpc().getOrg({ ...hana(), orgId: org })));
    forbidden(JSON.stringify(await staffRpc().listMembers({ ...hana(), orgId: org })));
    forbidden(JSON.stringify(await staffRpc().auditSince({ ...hana(), seq: 0, limit: 500 })));
    // Stored only as the hash the admin Worker sent.
    const stored = await db.prepare('SELECT hex(token_hash) AS h FROM invites WHERE id = ?').bind(r.invite.id).first<string>('h');
    expect(stored).toBe([...hash].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase());
  });

  it(`refuses the ${MAX_OPEN_INVITES + 1}th open invite of an org; revoked and expired ones don't count`, async () => {
    const org = await seedOrg();
    const ids: string[] = [];
    for (let i = 0; i < MAX_OPEN_INVITES; i++) {
      const r = await issue({ orgId: org });
      expect(r.ok, `invite ${i + 1}`).toBe(true);
      if (r.ok) ids.push(r.invite.id);
    }
    expect(await issue({ orgId: org })).toMatchObject({ ok: false, code: 'conflict' });
    expect((await staffRpc().revokeInvite({ ...hana(), inviteId: ids[0]! })).ok).toBe(true);
    expect((await issue({ orgId: org })).ok).toBe(true);
    await db.prepare('UPDATE invites SET expires_at = created_at + 1 WHERE id = ?').bind(ids[1]).run();
    expect((await issue({ orgId: org })).ok).toBe(true);
    expect(await issue({ orgId: org })).toMatchObject({ ok: false, code: 'conflict' });
    // Another org is unaffected.
    expect((await issue({ orgId: await seedOrg() })).ok).toBe(true);
  });

  it('refuses a second open invite of the same address to the same org', async () => {
    const org = await seedOrg();
    expect((await issue({ orgId: org, email: 'dup@partner.example' })).ok).toBe(true);
    expect(await issue({ orgId: org, email: 'DUP@partner.example' })).toMatchObject({ ok: false, code: 'conflict' });
    expect((await issue({ orgId: await seedOrg(), email: 'dup@partner.example' })).ok).toBe(true);
  });

  it('an owner invite to an existing org also creates its owner grant; a new-org invite none', async () => {
    const org = await seedOrg();
    const r = await issue({ orgId: org, role: 'owner' });
    if (!r.ok) throw new Error(r.code);
    const grants = (await db.prepare('SELECT org_id, user_id, invite_id, granted_by_kind, granted_by, notified_at, owner_from FROM owner_grants WHERE invite_id = ?').bind(r.invite.id).all()).results;
    expect(grants).toEqual([{ org_id: org, user_id: null, invite_id: r.invite.id, granted_by_kind: 'hana', granted_by: 'access-sub-staff-1', notified_at: null, owner_from: null }]);
    const viewer = await issue({ orgId: org, role: 'viewer' });
    if (!viewer.ok) throw new Error(viewer.code);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM owner_grants WHERE invite_id = ?').bind(viewer.invite.id).first('n')).toBe(0);
    await clearPartnerOrgs();
    const created = await issue({ newOrgName: '  Acme Pty Ltd ', role: 'owner', kind: 'internal' });
    if (!created.ok) throw new Error(created.code);
    expect(created.invite).toMatchObject({ newOrgName: 'Acme Pty Ltd', role: 'owner' });
    expect(created.invite.orgId).toBeUndefined();
    expect(await db.prepare('SELECT COUNT(*) AS n FROM owner_grants WHERE invite_id = ?').bind(created.invite.id).first('n')).toBe(0);
  });

  it('a replayed request id writes nothing and is already_applied; reused for another write it is conflict', async () => {
    const org = await seedOrg();
    const ctx = hana();
    const first = await staffRpc().issueInvite({ ...ctx, email: 'replay@partner.example', role: 'viewer', orgId: org });
    expect(first.ok).toBe(true);
    const again = await staffRpc().issueInvite({ ...ctx, email: 'replay@partner.example', role: 'viewer', orgId: org });
    expect(again).toMatchObject({ ok: false, code: 'already_applied' });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM invites WHERE org_id = ? AND email_norm = 'replay@partner.example'").bind(org).first('n')).toBe(1);
    const other = await staffRpc().issueInvite({ ...ctx, actor: { kind: 'hana', id: 'another-staffer', email: 'b@hana.example' }, email: 'other@partner.example', role: 'viewer', orgId: org });
    expect(other).toMatchObject({ ok: false, code: 'conflict' });
  });

  it('audits the issue with the staff actor and no invitee address', async () => {
    const org = await seedOrg();
    const r = await issue({ orgId: org, role: 'owner', email: 'secret.person@partner.example' });
    if (!r.ok) throw new Error(r.code);
    const rows = await auditRows("action = 'invite.issued' AND target = ?", r.invite.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_kind: 'hana', actor_id: 'access-sub-staff-1', org_id: org, outcome: 'ok' });
    const details = JSON.parse(rows[0]!.details_json) as Record<string, unknown>;
    expect(details).toEqual({ role: 'owner', newOrg: false, grantId: expect.stringMatching(/^og_/u) });
    const all = await db.prepare('SELECT * FROM audit_log WHERE target = ?').bind(r.invite.id).all();
    expect(JSON.stringify(all.results)).not.toContain('secret.person');
    const ip = await db.prepare('SELECT ip_prefix FROM audit_log WHERE target = ?').bind(r.invite.id).first('ip_prefix');
    expect(ip).toBe('198.51.100.0/24');
  });
});

describe('the passkey gate (Deferred: no second partner org before passkeys)', () => {
  it('allows the first partner org, refuses a second with passkeys_required; an open new-partner invite counts', async () => {
    await clearPartnerOrgs();
    const first = await issue({ newOrgName: 'Sodax', role: 'owner' });
    expect(first.ok).toBe(true);
    // The first is still only an invite, and already counts.
    expect(await issue({ newOrgName: 'Second', role: 'owner', kind: 'partner' })).toMatchObject({ ok: false, code: 'passkeys_required' });
    // Internal orgs pass, and org_legacy (internal) never counts.
    expect((await issue({ newOrgName: 'Hana QA', role: 'owner', kind: 'internal' })).ok).toBe(true);
    // Revoking the open one lets a partner org in; an existing partner org then blocks the next.
    if (first.ok) expect((await staffRpc().revokeInvite({ ...hana(), inviteId: first.invite.id })).ok).toBe(true);
    await seedOrg({ kind: 'partner' });
    expect(await issue({ newOrgName: 'Third', role: 'owner' })).toMatchObject({ ok: false, code: 'passkeys_required' });
    // Inviting into an existing partner org is not a new partner org.
    const partner = await db.prepare("SELECT id FROM orgs WHERE kind = 'partner' LIMIT 1").first<string>('id');
    expect((await issue({ orgId: partner })).ok).toBe(true);
  });
});

describe('notice first (fails closed)', () => {
  it('lists an unannounced invite with the org’s current owners, then not once acked', async () => {
    const org = await seedOrg();
    const owner = await seedMember(org, 'owner');
    await seedMember(org, 'viewer');
    const r = await issue({ orgId: org });
    if (!r.ok) throw new Error(r.code);
    const mine = (await notices()).filter((n) => n.invite?.id === r.invite.id);
    expect(mine).toEqual([{ kind: 'invite', invite: r.invite, owners: [{ email: owner.email }] }]);
    const { hashB64 } = await linkPair();
    expect(await staffRpc().ackMemberNotice({ ...system(), inviteId: r.invite.id, tokenHash: hashB64 })).toEqual({ ok: true });
    expect((await notices()).filter((n) => n.invite?.id === r.invite.id && n.kind === 'invite')).toEqual([]);
    expect(await db.prepare('SELECT notified_at IS NOT NULL AS n FROM invites WHERE id = ?').bind(r.invite.id).first('n')).toBe(1);
    expect((await auditRows("action = 'invite.notified' AND target = ?", r.invite.id)).map((x) => x.actor_kind)).toEqual(['system']);
  });

  it('an unacked invite stays unusable: a failed send (no ack) leaves token_hash NULL', async () => {
    const org = await seedOrg();
    const r = await issue({ orgId: org });
    if (!r.ok) throw new Error(r.code);
    // The admin Worker's send failed: it never acks. The invite keeps appearing and keeps no token.
    expect((await notices()).some((n) => n.invite?.id === r.invite.id)).toBe(true);
    expect(await db.prepare('SELECT token_hash FROM invites WHERE id = ?').bind(r.invite.id).first('token_hash')).toBeNull();
  });

  it('a repeated ack with the same hash is fine; another hash is conflict; a revoked invite is not_pending', async () => {
    const org = await seedOrg();
    const a = await issue({ orgId: org });
    const b = await issue({ orgId: org });
    if (!a.ok || !b.ok) throw new Error('issue');
    const p1 = await linkPair();
    const p2 = await linkPair();
    expect(await staffRpc().ackMemberNotice({ ...system(), inviteId: a.invite.id, tokenHash: p1.hashB64 })).toEqual({ ok: true });
    expect(await staffRpc().ackMemberNotice({ ...system(), inviteId: a.invite.id, tokenHash: p1.hashB64 })).toEqual({ ok: true });
    expect(await staffRpc().ackMemberNotice({ ...system(), inviteId: a.invite.id, tokenHash: p2.hashB64 })).toMatchObject({ ok: false, code: 'conflict' });
    expect((await staffRpc().revokeInvite({ ...hana(), inviteId: b.invite.id })).ok).toBe(true);
    expect(await staffRpc().ackMemberNotice({ ...system(), inviteId: b.invite.id, tokenHash: p2.hashB64 })).toMatchObject({ ok: false, code: 'not_pending' });
    expect(await staffRpc().ackMemberNotice({ ...system(), inviteId: 'inv_unknown12345', tokenHash: p2.hashB64 })).toMatchObject({ ok: false, code: 'not_found' });
    expect(await staffRpc().ackMemberNotice({ ...system(), inviteId: a.invite.id, grantId: 'og_x', tokenHash: p2.hashB64 } as never)).toMatchObject({ ok: false, code: 'bad_request' });
  });

  it('an expired invite is neither listed nor ackable', async () => {
    const org = await seedOrg();
    const r = await issue({ orgId: org });
    if (!r.ok) throw new Error(r.code);
    await db.prepare('UPDATE invites SET expires_at = created_at + 1 WHERE id = ?').bind(r.invite.id).run();
    expect((await notices()).some((n) => n.invite?.id === r.invite.id)).toBe(false);
    expect(await staffRpc().ackMemberNotice({ ...system(), inviteId: r.invite.id, tokenHash: (await linkPair()).hashB64 })).toMatchObject({ ok: false, code: 'not_pending' });
  });
});

describe('revokeInvite', () => {
  it('revokes an open invite once, cancels its owner grant, and audits it', async () => {
    const org = await seedOrg();
    const r = await issue({ orgId: org, role: 'owner' });
    if (!r.ok) throw new Error(r.code);
    expect(await staffRpc().revokeInvite({ ...hana(), inviteId: r.invite.id })).toEqual({ ok: true });
    expect(await staffRpc().revokeInvite({ ...hana(), inviteId: r.invite.id })).toMatchObject({ ok: false, code: 'not_pending' });
    expect(await staffRpc().revokeInvite({ ...hana(), inviteId: 'inv_nope12345678' })).toMatchObject({ ok: false, code: 'not_found' });
    const grant = await db.prepare('SELECT cancelled_at IS NOT NULL AS c, cancelled_by FROM owner_grants WHERE invite_id = ?').bind(r.invite.id).first();
    expect(grant).toEqual({ c: 1, cancelled_by: 'access-sub-staff-1' });
    const [row] = await auditRows("action = 'invite.revoked' AND target = ?", r.invite.id);
    expect(JSON.parse(row!.details_json)).toEqual({ grantCancelled: expect.stringMatching(/^og_/u) });
    // The cancelled grant's notice is no longer pending either.
    expect((await notices()).some((n) => n.invite?.id === r.invite.id)).toBe(false);
  });
});

describe('getOrg, listOrgs, listMembers', () => {
  it('pages orgs by id; getOrg returns the org, its members (with sub) and its invites', async () => {
    const org = await seedOrg({ requiredHd: 'partner.example' });
    const owner = await seedMember(org, 'owner');
    const r = await issue({ orgId: org });
    const got = await staffRpc().getOrg({ ...hana(), orgId: org });
    if (!got.ok || !r.ok) throw new Error('getOrg');
    expect(got.org).toMatchObject({ id: org, kind: 'internal', status: 'active', requiredHd: 'partner.example' });
    expect(got.members).toEqual([expect.objectContaining({ userId: owner.id, email: owner.email, sub: owner.sub, role: 'owner', disabled: false })]);
    expect(got.invites.map((i) => i.id)).toEqual([r.invite.id]);
    expect(await staffRpc().getOrg({ ...hana(), orgId: 'org_none12345' })).toMatchObject({ ok: false, code: 'not_found' });
    const all: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 100; i++) {
      const page = await staffRpc().listOrgs({ ...hana(), limit: 3, ...(cursor ? { cursor } : {}) });
      if (!page.ok) throw new Error(page.code);
      all.push(...page.orgs.map((o) => o.id));
      if (!page.next) break;
      cursor = page.next;
    }
    expect(all).toContain(org);
    expect(all).toContain(LEGACY_ORG_ID);
    expect([...all].sort()).toEqual(all);
    expect(new Set(all).size).toBe(all.length);
  });
});
