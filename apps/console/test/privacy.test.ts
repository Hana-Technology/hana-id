// What the console writes about people (docs/batch-c-spec.md "Audit" allowlist; the batch's "no PII in logs" rule):
// the audit details allowlist (a snapshot, and unlisted keys refused), log lines that drop every field but the
// allowlisted ones, no email/sub/token in any log line of a full invite lifecycle, the IP helpers (subject equal to the
// API's; the forensics prefix never a full address), and the grant delay's fail-closed setting.
import { ipSubject as apiIpSubject } from '../../api/src/ip.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUDIT_DETAIL_KEYS, detailsJson } from '../src/audit.ts';
import { ownerGrantDelayMs } from '../src/config.ts';
import { ipPrefix, ipSubject } from '../src/ip.ts';
import { log } from '../src/log.ts';
import { hana, linkPair, seedMember, seedOrg, staffRpc, system } from './helpers.ts';

afterEach(() => vi.restoreAllMocks());

describe('audit details', () => {
  it('the allowlist (snapshot: a new key is a reviewed change)', () => {
    expect(AUDIT_DETAIL_KEYS).toMatchInlineSnapshot(`
      {
        "app.logo_removed": [
          "code",
        ],
        "app.logo_set": [
          "logoKey",
          "code",
        ],
        "app.renamed": [
          "code",
          "version",
        ],
        "app.resumed": [
          "code",
          "suspendedBy",
        ],
        "app.settings_changed": [
          "code",
          "version",
          "fields",
        ],
        "app.suspended": [
          "code",
          "suspendedBy",
        ],
        "app.turned_off": [
          "code",
          "version",
          "what",
        ],
        "change.cancelled": [
          "code",
        ],
        "change.link_cancel": [
          "code",
        ],
        "invite.accepted": [
          "role",
          "newOrg",
        ],
        "invite.expired": [],
        "invite.issued": [
          "role",
          "newOrg",
          "kind",
          "grantId",
        ],
        "invite.notified": [],
        "invite.revoked": [
          "grantCancelled",
        ],
        "key.created": [
          "code",
          "keyId",
        ],
        "key.revoked": [
          "code",
          "keyId",
        ],
        "key.rotated": [
          "code",
          "keyId",
          "newKeyId",
        ],
        "ledger.exported": [
          "month",
          "asOf",
          "rows",
          "sha256",
        ],
        "member.added": [
          "role",
          "grantId",
        ],
        "member.owner_granted": [
          "grantId",
        ],
        "member.removed": [
          "role",
          "grantCancelled",
        ],
        "member.role": [
          "from",
          "to",
          "grantCancelled",
        ],
        "org.frozen": [],
        "org.policy": [
          "requiredHd",
        ],
        "org.unfrozen": [],
        "origin.proposed": [
          "code",
          "version",
          "added",
          "removed",
        ],
        "origins.removed": [
          "code",
          "version",
          "removed",
        ],
        "owner_action.executed": [
          "code",
          "status",
          "changeId",
        ],
        "owner_action.relayed": [
          "code",
          "method",
          "status",
        ],
        "owner_grant.cancelled": [
          "via",
        ],
        "owner_grant.created": [
          "userId",
        ],
        "owner_grant.notified": [
          "ownerFrom",
        ],
        "policy.proposed": [
          "code",
          "version",
          "policyId",
          "changeId",
        ],
        "rate.overridden": [
          "day",
          "usdMicros",
          "overrideId",
        ],
        "raw_sign.proposed": [
          "code",
          "version",
          "changeId",
        ],
        "session.signed_in": [
          "invite",
        ],
        "session.signed_out": [],
        "signin.refused": [
          "code",
          "emailSha256",
        ],
        "statement.issued": [
          "month",
          "csvSha256",
          "pdfSha256",
          "asOf",
          "lines",
        ],
        "step_up.failed": [
          "kind",
          "code",
        ],
        "support.lookup": [
          "by",
          "ticket",
          "requestIds",
          "requestIdList",
          "days",
        ],
        "user.disabled": [],
        "user.enabled": [],
        "users.find": [
          "by",
          "ticket",
        ],
      }
    `);
    // The one exception: a refused sign-in names the person only by the sha256 of the address Google verified, as the
    // spec says ("Membership rules at sign-in": `not_invited` is audited with the email's sha256 only).
    for (const [action, keys] of Object.entries(AUDIT_DETAIL_KEYS)) {
      for (const k of keys) if (!(action === 'signin.refused' && k === 'emailSha256')) expect(k, action).not.toMatch(/email|sub|token|hash|cookie|ip|secret/iu);
    }
  });

  it('refuses an unlisted key', () => {
    expect(() => detailsJson('invite.issued', { email: 'x@y.example' })).toThrow(/not allowlisted/u);
    expect(() => detailsJson('invite.notified', { tokenHash: 'x' })).toThrow(/not allowlisted/u);
    expect(detailsJson('invite.issued', { role: 'viewer', newOrg: false })).toBe('{"role":"viewer","newOrg":false}');
  });
});

describe('logs', () => {
  it('keep only the allowlisted fields', () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    log({ event: 'x', orgId: 'org_a', ...({ email: 'a@b.example', sub: 's', token: 't', ip: '203.0.113.1' } as object) });
    const line = JSON.parse(String(out.mock.calls[0]![0])) as Record<string, unknown>;
    expect(Object.keys(line).sort()).toEqual(['at', 'event', 'level', 'orgId']);
  });

  it('carry no email, sub, token or hash through an invite’s whole life', async () => {
    const lines: string[] = [];
    for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
    const org = await seedOrg();
    const owner = await seedMember(org, 'owner');
    const email = 'very.private.person@partner.example';
    const r = await staffRpc().issueInvite({ ...hana(), email, role: 'owner', orgId: org });
    if (!r.ok) throw new Error(r.code);
    const p = await linkPair();
    await staffRpc().pendingMemberNotices({ ...system(), limit: 100 });
    await staffRpc().ackMemberNotice({ ...system(), inviteId: r.invite.id, tokenHash: p.hashB64 });
    await staffRpc().ackMemberNotice({ ...system(), inviteId: r.invite.id, tokenHash: (await linkPair()).hashB64 });
    await staffRpc().revokeInvite({ ...hana(), inviteId: r.invite.id });
    await staffRpc().issueInvite({ ...hana(), email: 'bad', role: 'owner', orgId: org });
    const text = lines.join('\n');
    expect(lines.length).toBeGreaterThan(3);
    for (const secret of [email, 'staff@hana.example', owner.email, owner.sub, p.hashB64, p.tokenB64, 'access-sub-staff-1']) expect(text).not.toContain(secret);
  });
});

describe('IP helpers', () => {
  it('ipSubject equals the API’s (the same IP is limited alike)', () => {
    for (const ip of ['203.0.113.7', '2001:db8:1:2:3:4:5:6', '::ffff:192.0.2.1', '[2001:db8::1]', 'fe80::1%eth0', 'garbage', '', '1.2.3.256']) {
      expect(ipSubject(ip), ip).toBe(apiIpSubject(ip));
    }
  });

  it('ipPrefix keeps a /24 or /48, never the address', () => {
    expect(ipPrefix('203.0.113.7')).toBe('203.0.113.0/24');
    expect(ipPrefix('::ffff:192.0.2.1')).toBe('192.0.2.0/24');
    expect(ipPrefix('2001:db8:abcd:12:1:2:3:4')).toBe('2001:db8:abcd::/48');
    expect(ipPrefix('unknown')).toBeNull();
    expect(ipPrefix(null)).toBeNull();
  });
});

describe('OWNER_GRANT_DELAY_MS', () => {
  it('fails closed when missing or outside the manifest bounds', () => {
    expect(ownerGrantDelayMs({ OWNER_GRANT_DELAY_MS: '60000' })).toBe(60_000);
    for (const v of [undefined, '', 'abc', '59999', String(7 * 24 * 60 * 60_000 + 1), '1e5']) {
      expect(() => ownerGrantDelayMs({ OWNER_GRANT_DELAY_MS: v }), String(v)).toThrow(/OWNER_GRANT_DELAY_MS/u);
    }
  });

  it('a promotion notice can’t be acked without it (internal), so no grant clock starts', async () => {
    const org = await seedOrg();
    await seedMember(org, 'owner');
    const v = await seedMember(org, 'viewer');
    expect((await staffRpc().setMember({ ...hana(), orgId: org, userId: v.id, role: 'owner' })).ok).toBe(true);
    const { db } = await import('./helpers.ts');
    const grantId = (await db.prepare('SELECT id FROM owner_grants WHERE org_id = ? AND user_id = ?').bind(org, v.id).first<string>('id'))!;
    const { StaffRpc } = await import('../src/staff-rpc.ts');
    const { createExecutionContext } = await import('cloudflare:test');
    const { env } = await import('cloudflare:workers');
    const rpc = new StaffRpc(createExecutionContext(), { ...env, OWNER_GRANT_DELAY_MS: undefined });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await rpc.ackMemberNotice({ ...system(), grantId, tokenHash: (await linkPair()).hashB64 })).toMatchObject({ ok: false, code: 'internal' });
    expect(await db.prepare('SELECT notified_at FROM owner_grants WHERE id = ?').bind(grantId).first('notified_at')).toBeNull();
  });
});
