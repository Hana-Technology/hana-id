// StaffRpc's input schemas and the console's link-confirm bodies (src/staff.ts): round trips, the email rule (trimmed and
// lowercased, never dot- or plus-normalised), exactly-one targets, and refusals of unknown fields and malformed ids.
import { describe, expect, it } from 'vitest';
import { ackMemberNoticeInput, auditFilters, cancelByLinkBody, issueInviteInput, memberNotice, ownerGrantCancelBody, queryAuditInput, setMemberInput } from '../src/index.ts';

const staff = { actor: { kind: 'hana', id: 'access-sub', email: 'staff@hana.example' }, requestId: 'req_12345678', clientIp: '198.51.100.1' } as const;

describe('issueInviteInput', () => {
  it('normalises the address by trimming and lowercasing only', () => {
    expect(issueInviteInput.parse({ ...staff, email: '  First.Last+Tag@Example.COM ', role: 'viewer', orgId: 'org_abc' }).email).toBe('first.last+tag@example.com');
  });

  it('takes exactly one of orgId and newOrgName; kind only with a new org; a new org’s first member is an owner', () => {
    expect(issueInviteInput.safeParse({ ...staff, email: 'a@b.example', role: 'owner', newOrgName: 'Acme', kind: 'internal' }).success).toBe(true);
    expect(issueInviteInput.safeParse({ ...staff, email: 'a@b.example', role: 'owner' }).success).toBe(false);
    expect(issueInviteInput.safeParse({ ...staff, email: 'a@b.example', role: 'owner', orgId: 'org_a', newOrgName: 'Acme' }).success).toBe(false);
    expect(issueInviteInput.safeParse({ ...staff, email: 'a@b.example', role: 'viewer', orgId: 'org_a', kind: 'partner' }).success).toBe(false);
    expect(issueInviteInput.safeParse({ ...staff, email: 'a@b.example', role: 'viewer', newOrgName: 'Acme' }).success).toBe(false);
    expect(issueInviteInput.safeParse({ ...staff, email: 'a@b.example', role: 'admin', orgId: 'org_a' }).success).toBe(false);
    expect(issueInviteInput.safeParse({ ...staff, email: 'a@b.example', role: 'viewer', orgId: 'org_a', extra: true }).success).toBe(false);
  });
});

describe('the other inputs', () => {
  it('ackMemberNotice takes exactly one id and a b64url sha256', () => {
    expect(ackMemberNoticeInput.safeParse({ ...staff, inviteId: 'inv_a', tokenHash: 'A'.repeat(43) }).success).toBe(true);
    expect(ackMemberNoticeInput.safeParse({ ...staff, grantId: 'og_a', tokenHash: 'A'.repeat(43) }).success).toBe(true);
    expect(ackMemberNoticeInput.safeParse({ ...staff, inviteId: 'inv_a', grantId: 'og_a', tokenHash: 'A'.repeat(43) }).success).toBe(false);
    expect(ackMemberNoticeInput.safeParse({ ...staff, tokenHash: 'A'.repeat(43) }).success).toBe(false);
    expect(ackMemberNoticeInput.safeParse({ ...staff, inviteId: 'inv_a', tokenHash: 'A'.repeat(44) }).success).toBe(false);
  });

  it('setMember takes a role or null; ids are typed by prefix', () => {
    expect(setMemberInput.safeParse({ ...staff, orgId: 'org_a', userId: 'usr_a', role: null }).success).toBe(true);
    expect(setMemberInput.safeParse({ ...staff, orgId: 'org_a', userId: 'inv_a', role: 'viewer' }).success).toBe(false);
    expect(setMemberInput.safeParse({ ...staff, orgId: 'org_a', userId: 'usr_a' }).success).toBe(false);
  });

  it('audit filters and cursors are strict', () => {
    expect(auditFilters.safeParse({ orgId: 'org_a', action: 'invite.issued', from: 0, to: 1 }).success).toBe(true);
    expect(auditFilters.safeParse({ action: "x' OR 1" }).success).toBe(false);
    expect(auditFilters.safeParse({ email: 'a@b.example' }).success).toBe(false);
    expect(queryAuditInput.safeParse({ ...staff, filters: {}, cursor: '0', limit: 10 }).success).toBe(false);
    expect(queryAuditInput.safeParse({ ...staff, filters: {}, cursor: '12', limit: 501 }).success).toBe(false);
  });

  it('the link bodies take an id of their kind and a 32-byte token, nothing else', () => {
    expect(cancelByLinkBody.safeParse({ changeId: 'gc_a', token: 'A'.repeat(43) }).success).toBe(true);
    expect(cancelByLinkBody.safeParse({ changeId: 'og_a', token: 'A'.repeat(43) }).success).toBe(false);
    expect(ownerGrantCancelBody.safeParse({ grantId: 'og_a', token: 'A'.repeat(43) }).success).toBe(true);
    expect(ownerGrantCancelBody.safeParse({ grantId: 'og_a', token: 'A'.repeat(43), x: 1 }).success).toBe(false);
  });

  it('a member notice has no token field', () => {
    const shape = Object.keys(memberNotice.shape);
    expect(shape).toEqual(['kind', 'invite', 'grant', 'member', 'owners']);
  });
});
