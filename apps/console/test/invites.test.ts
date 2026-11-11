// Invites through StaffRpc (docs/batch-c-spec.md "Invites and owner grants", "Tests: Invites and roles" rows that
// need no sign-in): who may call what, the 10-open-invites cap, notice first (no working link before the admin
// Worker's ack), the passkey gate, revocation, replays, and that no answer, row view or audit row ever carries a token,
// a token hash or (in the audit trail) the invitee's address.
import { LEGACY_ORG_ID, MAX_OPEN_INVITES, type MemberNotice, NEW_ORG_INVITES_WINDOW_MS, newId, randomBytes } from '@hana-id/console-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { acceptInvite, newOrgInvites } from '../src/invites.ts';
import { StaffRpc } from '../src/staff-rpc.ts';
import { DAY, HOUR, auditRows, db, hana, linkPair, member, seedMember, seedOrg, staffRpc, system } from './helpers.ts';

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

describe('the passkey gate (D242: no second partner org before passkeys; D698: lifted on testnet only)', () => {
  /** StaffRpc in an env on `network` (undefined: the var missing). The suite's own env is testnet (TEST_MANIFEST). */
  const rpcOn = (network: string | undefined) => new StaffRpc(createExecutionContext(), { ...env, NETWORK: network } as typeof env);
  const issueOn = (network: string | undefined, o: Record<string, unknown>) => rpcOn(network).issueInvite({ ...hana(), role: 'owner', email: `p${Math.random().toString(36).slice(2)}@partner.example`, ...o });

  for (const network of ['mainnet', undefined, '', 'Testnet', 'testnet ']) {
    it(`on ${JSON.stringify(network)}: allows the first partner org, refuses a second with passkeys_required; an open new-partner invite counts`, async () => {
      await clearPartnerOrgs();
      const first = await issueOn(network, { newOrgName: 'Sodax' });
      expect(first.ok).toBe(true);
      // The first is still only an invite, and already counts.
      expect(await issueOn(network, { newOrgName: 'Second', kind: 'partner' })).toMatchObject({ ok: false, code: 'passkeys_required' });
      // Internal orgs pass, and org_legacy (internal) never counts.
      expect((await issueOn(network, { newOrgName: 'Hana QA', kind: 'internal' })).ok).toBe(true);
      // Revoking the open one lets a partner org in; an existing partner org then blocks the next.
      if (first.ok) expect((await staffRpc().revokeInvite({ ...hana(), inviteId: first.invite.id })).ok).toBe(true);
      await seedOrg({ kind: 'partner' });
      expect(await issueOn(network, { newOrgName: 'Third' })).toMatchObject({ ok: false, code: 'passkeys_required' });
      // Inviting into an existing partner org is not a new partner org.
      const partner = await db.prepare("SELECT id FROM orgs WHERE kind = 'partner' LIMIT 1").first<string>('id');
      expect((await issueOn(network, { orgId: partner, role: 'viewer' })).ok).toBe(true);
    });
  }

  it('off testnet, the check is in the insert\'s own batch: of concurrent first-partner invites exactly one is issued', async () => {
    await clearPartnerOrgs();
    const results = await Promise.all(Array.from({ length: 4 }, (_, n) => issueOn('mainnet', { newOrgName: `Race ${n}` })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => (r as { code: string }).code)).toEqual(['passkeys_required', 'passkeys_required', 'passkeys_required']);
    const open = await db.prepare("SELECT COUNT(*) AS n FROM invites WHERE new_org_kind = 'partner' AND accepted_at IS NULL AND revoked_at IS NULL").first<number>('n');
    expect(open).toBe(1);
  });

  it('on testnet: a second partner org and a second open partner invite are allowed, and accepting each makes a partner org', async () => {
    await clearPartnerOrgs();
    await seedOrg({ kind: 'partner' });
    const a = await issueOn('testnet', { newOrgName: 'Second Partner' });
    const b = await issueOn('testnet', { newOrgName: 'Third Partner', kind: 'partner' });
    expect(a).toMatchObject({ ok: true, invite: { newOrgKind: 'partner' } });
    expect(b).toMatchObject({ ok: true, invite: { newOrgKind: 'partner' } });
    // The suite's own env (TEST_MANIFEST, network testnet) is the same.
    expect((await issue({ newOrgName: 'Fourth Partner', role: 'owner' })).ok).toBe(true);
    for (const r of [a, b]) {
      if (!r.ok) throw new Error(r.code);
      const { hash, hashB64 } = await linkPair();
      expect((await staffRpc().ackMemberNotice({ ...system(), inviteId: r.invite.id, tokenHash: hashB64 })).ok).toBe(true);
      const out = await acceptInvite(db, { tokenHash: hash, email: r.invite.email, provider: 'google', sub: `sub-${r.invite.id}`, hd: null, requestId: `req_${r.invite.id}`, now: Date.now(), ipPrefix: null, country: null, network: 'testnet' }, () => 60_000);
      expect(out).toMatchObject({ ok: true, role: 'owner' });
      if (out.ok) expect(await db.prepare('SELECT kind FROM orgs WHERE id = ?').bind(out.orgId).first('kind')).toBe('partner');
    }
    expect(await db.prepare("SELECT COUNT(*) AS n FROM orgs WHERE kind = 'partner'").first<number>('n')).toBe(3);
    // Back off testnet, the gate holds again at once.
    expect(await issueOn('mainnet', { newOrgName: 'Fifth Partner' })).toMatchObject({ ok: false, code: 'passkeys_required' });
  });

  it('off testnet, acceptance re-checks the gate in its batch: invites collected on testnet add no second partner org', async () => {
    await clearPartnerOrgs();
    const acceptOn = async (network: string | undefined, r: { invite: { id: string; email: string } }, hash: Uint8Array) =>
      acceptInvite(db, { tokenHash: hash, email: r.invite.email, provider: 'google', sub: `sub-${r.invite.id}-${network}`, hd: null, requestId: `req_${Math.random().toString(36).slice(2)}`, now: Date.now(), ipPrefix: null, country: null, network }, () => 60_000);
    const announced = [];
    for (const name of ['Gate One', 'Gate Two']) {
      const r = await issueOn('testnet', { newOrgName: name });
      if (!r.ok) throw new Error(r.code);
      const { hash, hashB64 } = await linkPair();
      expect((await staffRpc().ackMemberNotice({ ...system(), inviteId: r.invite.id, tokenHash: hashB64 })).ok).toBe(true);
      announced.push({ r, hash });
    }
    // The first partner org is allowed anywhere; the second is refused off testnet, and nothing is written.
    expect(await acceptOn('mainnet', announced[0]!.r, announced[0]!.hash)).toMatchObject({ ok: true, role: 'owner' });
    const auditBefore = await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'invite.accepted'").first<number>('n');
    for (const network of ['mainnet', undefined]) {
      expect(await acceptOn(network, announced[1]!.r, announced[1]!.hash)).toEqual({ ok: false, code: 'passkeys_required' });
    }
    expect(await db.prepare('SELECT accepted_at FROM invites WHERE id = ?').bind(announced[1]!.r.invite.id).first('accepted_at')).toBeNull();
    expect(await db.prepare("SELECT COUNT(*) AS n FROM orgs WHERE name = 'Gate Two'").first<number>('n')).toBe(0);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'invite.accepted'").first<number>('n')).toBe(auditBefore);
    // Concurrent acceptances of two open partner invites off testnet with no partner org yet: exactly one org.
    await clearPartnerOrgs();
    const pair = [];
    for (const name of ['Race A', 'Race B']) {
      const r = await issueOn('testnet', { newOrgName: name });
      if (!r.ok) throw new Error(r.code);
      const { hash, hashB64 } = await linkPair();
      expect((await staffRpc().ackMemberNotice({ ...system(), inviteId: r.invite.id, tokenHash: hashB64 })).ok).toBe(true);
      pair.push({ r, hash });
    }
    const outs = await Promise.all(pair.map((p) => acceptOn('mainnet', p.r, p.hash)));
    expect(outs.filter((o) => o.ok)).toHaveLength(1);
    expect(outs.filter((o) => !o.ok)).toEqual([{ ok: false, code: 'passkeys_required' }]);
    // The invite left over is still open: on testnet it can be accepted.
    const left = pair[outs.findIndex((o) => !o.ok)]!;
    expect(await acceptOn('testnet', left.r, left.hash)).toMatchObject({ ok: true, role: 'owner' });
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
    // Ended 9 ms ago (SQLite's SET reads the old created_at): `created_at + 1` could still be open in the same millisecond.
    await db.prepare('UPDATE invites SET created_at = created_at - 10, expires_at = created_at - 9 WHERE id = ?').bind(r.invite.id).run();
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
    // D283: the live owner grants (an owner invite to an org with an owner has one), without any hash column.
    expect(got.grants).toEqual([]);
    const ownerInvite = await issue({ orgId: org, role: 'owner' });
    const again = await staffRpc().getOrg({ ...hana(), orgId: org });
    if (!again.ok || !ownerInvite.ok) throw new Error('getOrg');
    expect(again.grants).toEqual([expect.objectContaining({ orgId: org, inviteId: ownerInvite.invite.id, grantedByKind: 'hana' })]);
    expect(JSON.stringify(again.grants)).not.toMatch(/hash/iu);
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

/**
 * An invite row as the console writes one, at chosen times (the window's edges need exact ones): to a new org unless
 * `orgId`; expiring 7 days after `created`; `notified`, `accepted`, `revoked` set the matching columns.
 */
async function seedInviteAt(o: { created: number; notified?: number; accepted?: number; revoked?: number; orgId?: string; kind?: 'partner' | 'internal' }): Promise<string> {
  const id = newId('invite');
  const accepted = o.accepted ?? null;
  await db
    .prepare(
      `INSERT INTO invites (id, token_hash, email_norm, org_id, new_org_name, new_org_kind, role, created_by_kind, created_by, notified_at, created_at, expires_at, accepted_at, accepted_user_id, accepted_by_sub, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, 'owner', 'hana', 'access-sub-staff-1', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      o.notified !== undefined ? randomBytes(32) : null,
      `${id.toLowerCase()}@partner.example`,
      o.orgId ?? null,
      o.orgId ? null : `New ${id}`,
      o.orgId ? null : (o.kind ?? 'internal'),
      o.notified ?? null,
      o.created,
      o.created + 7 * DAY,
      accepted,
      accepted !== null ? newId('user') : null,
      accepted !== null ? 'sub-accepted' : null,
      o.revoked ?? null,
    )
    .run();
  return id;
}

describe('newOrgInvites (D696: the admin Organisations page\'s "Pending invites")', () => {
  // A clock far ahead of the suite's own rows, so every invite another test wrote has ended more than 30 days before it.
  const T = Date.now() + 1000 * DAY;
  const W = NEW_ORG_INVITES_WINDOW_MS;

  it('lists open invites to new orgs first, then those that ended inside the window, newest first; never an existing org’s', async () => {
    const unsent = await seedInviteAt({ created: T - HOUR, kind: 'partner' });
    const sent = await seedInviteAt({ created: T - 2 * HOUR, notified: T - 2 * HOUR + 60_000 });
    const accepted = await seedInviteAt({ created: T - 11 * DAY, notified: T - 11 * DAY + 60_000, accepted: T - 10 * DAY });
    const revoked = await seedInviteAt({ created: T - 30 * DAY, revoked: T - 29 * DAY });
    const expired = await seedInviteAt({ created: T - 10 * DAY, notified: T - 10 * DAY + 60_000 });
    // Newer than every open one, but ended: open first puts it below them.
    const recentRevoked = await seedInviteAt({ created: T - 10 * 60_000, revoked: T - 9 * 60_000 });
    // The edges: ended exactly W before T is out; a millisecond later is in.
    const edgeIn = await seedInviteAt({ created: T - W - 7 * DAY + 1 });
    await seedInviteAt({ created: T - W - 7 * DAY });
    await seedInviteAt({ created: T - 40 * DAY, revoked: T - W });
    await seedInviteAt({ created: T - 32 * DAY, accepted: T - W - 1 });
    // Revoked before the window while its expiry (T − 25 d) is inside it: the revocation is when it ended, so it is out.
    await seedInviteAt({ created: T - 32 * DAY, revoked: T - W - 1 });
    // An open invite to an existing org is the org page's, not this list's.
    await seedInviteAt({ created: T - HOUR, orgId: await seedOrg() });

    const r = await newOrgInvites(db, T, 100);
    expect(r.truncated).toBe(false);
    expect(r.invites.map((i) => i.id)).toEqual([unsent, sent, recentRevoked, expired, accepted, revoked, edgeIn]);
    const byId = new Map(r.invites.map((i) => [i.id, i]));
    expect(byId.get(unsent)).toEqual({
      id: unsent,
      email: `${unsent.toLowerCase()}@partner.example`,
      newOrgName: `New ${unsent}`,
      newOrgKind: 'partner',
      role: 'owner',
      createdByKind: 'hana',
      createdBy: 'access-sub-staff-1',
      createdAt: T - HOUR,
      expiresAt: T - HOUR + 7 * DAY,
    });
    expect(byId.get(sent)).toMatchObject({ newOrgKind: 'internal', notifiedAt: T - 2 * HOUR + 60_000 });
    expect(byId.get(accepted)).toMatchObject({ acceptedAt: T - 10 * DAY, acceptedUserId: expect.stringMatching(/^usr_/u) });
    expect(byId.get(revoked)).toMatchObject({ revokedAt: T - 29 * DAY });
    expect(byId.get(expired)!.expiresAt).toBeLessThan(T);
    for (const i of r.invites) expect(i.orgId).toBeUndefined();
    // No token or hash column ever leaves (D240).
    expect(JSON.stringify(r)).not.toMatch(/token|hash/iu);
  });

  it('answers at most `limit` rows, open ones before ended ones, and says when there were more', async () => {
    const T2 = T + 200 * DAY;
    const ended = await seedInviteAt({ created: T2 - 2 * DAY - 7 * DAY });
    const open = [await seedInviteAt({ created: T2 - 3 * HOUR }), await seedInviteAt({ created: T2 - 2 * HOUR }), await seedInviteAt({ created: T2 - HOUR })];
    const two = await newOrgInvites(db, T2, 2);
    expect(two).toEqual({ invites: [expect.objectContaining({ id: open[2] }), expect.objectContaining({ id: open[1] })], truncated: true });
    const three = await newOrgInvites(db, T2, 3);
    expect(three.invites.map((i) => i.id)).toEqual([open[2], open[1], open[0]]);
    expect(three.truncated).toBe(true);
    expect(await newOrgInvites(db, T2, 4)).toEqual({ invites: [...three.invites, expect.objectContaining({ id: ended })], truncated: false });
  });

  it('through StaffRpc: staff only, validated, and an issued then revoked invite shows each state; no address in the log', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const email = `first.owner.${Math.random().toString(36).slice(2)}@newco.example`;
    const issued = await issue({ newOrgName: 'Newco Labs', role: 'owner', kind: 'internal', email });
    if (!issued.ok) throw new Error(issued.code);
    const listed = await staffRpc().newOrgInvites({ ...hana(), limit: 100 });
    if (!listed.ok) throw new Error(listed.code);
    expect(listed.invites.find((i) => i.id === issued.invite.id)).toEqual({ ...issued.invite, newOrgKind: 'internal' });
    expect(issued.invite.newOrgKind).toBe('internal');
    expect(await staffRpc().revokeInvite({ ...hana(), inviteId: issued.invite.id })).toEqual({ ok: true });
    const after = await staffRpc().newOrgInvites({ ...hana(), limit: 100 });
    if (!after.ok) throw new Error(after.code);
    expect(after.invites.find((i) => i.id === issued.invite.id)?.revokedAt).toEqual(expect.any(Number));
    const link = { actor: { kind: 'link' as const, id: 'gc_x' }, requestId: 'req_12345678', clientIp: '203.0.113.1' };
    for (const ctx of [member(), link, system()]) expect(await staffRpc().newOrgInvites({ ...ctx, limit: 10 })).toMatchObject({ ok: false, code: 'forbidden' });
    for (const bad of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, {}, { limit: 10, orgId: 'org_x1' }]) expect(await staffRpc().newOrgInvites({ ...hana(), ...bad })).toMatchObject({ ok: false, code: 'bad_request' });
    const text = logs.mock.calls.flat().join('\n');
    expect(text).toContain('staff.newOrgInvites');
    expect(text).not.toContain(email);
    expect(text).not.toContain('@newco.example');
  });
});
