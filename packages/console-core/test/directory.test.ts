// DirectoryRpc's shared inputs and constants (src/directory.ts; D275 as confirmed 2026-11-05): the ticket required to
// open one identity and optional to search, the page and budget bounds, the cursor, the audit actions.
import { describe, expect, it } from 'vitest';
import {
  DIRECTORY_AUDIT_ACTIONS,
  DIRECTORY_GET_PURPOSES,
  DIRECTORY_PAGE_MAX,
  DIRECTORY_ROWS_PER_DAY,
  DIRECTORY_ROWS_PER_HOUR,
  SUPPORT_TICKET_RE,
  UNVERIFIED_CLAIM_WARNING,
  directoryAuditInput,
  directoryGetInput,
  directorySearchInput,
  isFullAddress,
} from '../src/index.ts';

const call = { requestId: 'req_12345678', accessJwt: 'x'.repeat(40) };

describe('DirectoryRpc inputs', () => {
  it('get needs a support reference; search takes one optionally', () => {
    expect(directoryGetInput.safeParse({ ...call, provider: 'google', sub: '1' }).success).toBe(false);
    expect(directoryGetInput.safeParse({ ...call, provider: 'google', sub: '1', ticket: 'ZD-1' }).success).toBe(true);
    expect(directorySearchInput.safeParse({ ...call }).success).toBe(true);
    expect(directorySearchInput.safeParse({ ...call, ticket: 'ZD-1' }).success).toBe(true);
    for (const ticket of ['', 'x'.repeat(65), 'has space', 'a@b.example']) {
      expect(directoryGetInput.safeParse({ ...call, provider: 'email', sub: 'e1.x', ticket }).success, ticket).toBe(false);
      expect(SUPPORT_TICKET_RE.test(ticket), ticket).toBe(false);
    }
  });

  it('get’s purpose names its audit row: user_view (the default) or support_lookup (the lookup’s email join, D399), nothing else', () => {
    const base = { ...call, provider: 'google', sub: '1', ticket: 'ZD-1' };
    expect(DIRECTORY_GET_PURPOSES).toEqual(['user_view', 'support_lookup']);
    for (const purpose of DIRECTORY_GET_PURPOSES) expect(directoryGetInput.safeParse({ ...base, purpose }).success, purpose).toBe(true);
    // Each purpose is one of the issuer audit's actions (migration 0003's CHECK list).
    for (const purpose of DIRECTORY_GET_PURPOSES) expect(DIRECTORY_AUDIT_ACTIONS).toContain(purpose);
    for (const purpose of ['user_search', 'unlock', 'support.lookup', '', null]) expect(directoryGetInput.safeParse({ ...base, purpose }).success, String(purpose)).toBe(false);
  });

  it('bounds: a page of at most 100, two providers, a sub without spaces, no extra field, the cursor’s form', () => {
    expect(DIRECTORY_PAGE_MAX).toBe(100);
    expect(directorySearchInput.safeParse({ ...call, limit: 101 }).success).toBe(false);
    expect(directorySearchInput.safeParse({ ...call, provider: 'apple' }).success).toBe(false);
    expect(directorySearchInput.safeParse({ ...call, sub: 'a b' }).success).toBe(false);
    expect(directorySearchInput.safeParse({ ...call, actor: {} }).success).toBe(false);
    expect(directorySearchInput.safeParse({ ...call, cursor: '0:1700000000000:google:1234' }).success).toBe(true);
    expect(directorySearchInput.safeParse({ ...call, cursor: '1:1700000000000:email:e1.abc' }).success).toBe(true);
    expect(directorySearchInput.safeParse({ ...call, cursor: '2:1:google:1' }).success).toBe(false);
    expect(directorySearchInput.safeParse({ ...call, cursor: '0:1:apple:1' }).success).toBe(false);
    expect(directorySearchInput.safeParse({ requestId: 'req_12345678', accessJwt: 'short' }).success).toBe(false);
  });

  it('the audit walk takes id or before, exactly one, and the known actions', () => {
    expect(directoryAuditInput.safeParse({ ...call, id: 0, limit: 10 }).success).toBe(true);
    expect(directoryAuditInput.safeParse({ ...call, before: 5, limit: 10 }).success).toBe(true);
    expect(directoryAuditInput.safeParse({ ...call, limit: 10 }).success).toBe(false);
    expect(directoryAuditInput.safeParse({ ...call, id: 0, before: 5, limit: 10 }).success).toBe(false);
    expect(directoryAuditInput.safeParse({ ...call, id: 0, limit: 10, action: 'user_export' }).success).toBe(false);
    expect(DIRECTORY_AUDIT_ACTIONS).toEqual(['client_proof', 'unlock', 'unsuppress', 'revoke_tickets', 'user_search', 'user_view', 'support_lookup']);
  });

  it('the budget and the warning are the confirmed (provisional) numbers and the CLI’s words', () => {
    expect([DIRECTORY_ROWS_PER_HOUR, DIRECTORY_ROWS_PER_DAY]).toEqual([500, 2000]);
    expect(UNVERIFIED_CLAIM_WARNING).toBe('UNVERIFIED: this Google account claims the address but Google hasn’t verified it; don’t treat it as the owner');
  });

  it('a full address is an exact search; anything else a substring', () => {
    for (const a of ['a@b.example', ' A.B+tag@Sub.Example.com ']) expect(isFullAddress(a), a).toBe(true);
    for (const a of ['@b.example', 'a@b', 'gmail.com', 'a b@c.example', 'abc']) expect(isFullAddress(a), a).toBe(false);
  });
});
