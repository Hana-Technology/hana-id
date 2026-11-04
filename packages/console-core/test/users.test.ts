// End-user ids and searches (src/users.ts, D312): the user id from a uid, the Support ID as its short form and the
// uid's first 40 bits, typed Support IDs, the search kinds, and the RPC inputs.
import { describe, expect, it } from 'vitest';
import {
  adminFindUsersInput,
  consoleGetUserInput,
  consoleListUsersInput,
  crockford32,
  formatSupportId,
  parseSupportId,
  parseUserSearch,
  supportCodeOf,
  supportIdOf,
  uid,
  userIdOf,
} from '../src/index.ts';

const ctx = { actor: { kind: 'hana' as const, id: 'staff-1', email: 'staff@hana.example' }, requestId: 'req_12345678', clientIp: '203.0.113.9' };

describe('crockford32', () => {
  it('encodes most significant bit first with Crockford’s alphabet', () => {
    expect(crockford32(Uint8Array.of())).toBe('');
    expect(crockford32(Uint8Array.of(0xff))).toBe('ZW');
    expect(crockford32(Uint8Array.of(0, 0, 0, 0, 0))).toBe('00000000');
    expect(crockford32(Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff))).toBe('ZZZZZZZZ');
    expect(crockford32(Uint8Array.of(0x08, 0x42, 0x10, 0x84, 0x21))).toBe('11111111');
  });
});

describe('user id and Support ID', () => {
  it('the user id is hu_ + 26 lowercase characters, and the Support ID is its first 8: the uid’s first 5 bytes', async () => {
    const u = await uid(new Uint8Array(32).fill(7), { scopeId: 's1', provider: 'google', sub: '1102' });
    const id = userIdOf(u);
    expect(id).toMatch(/^hu_[0-9a-hjkmnp-tv-z]{26}$/u);
    expect(supportCodeOf(id)).toBe(crockford32(u.subarray(0, 5)));
    expect(supportIdOf(id)).toBe(formatSupportId(crockford32(u.subarray(0, 5))));
    expect(supportIdOf(id)).toMatch(/^HANA-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/u);
    expect(() => userIdOf(u.subarray(1))).toThrow();
    expect(() => supportCodeOf('usr_abc')).toThrow();
  });

  it('reads a typed Support ID with or without HANA-, dashes, case and look-alikes', () => {
    expect(parseSupportId('HANA-1234-ABCD')).toBe('1234ABCD');
    expect(parseSupportId('hana 1234 abcd')).toBe('1234ABCD');
    expect(parseSupportId('1234abcd')).toBe('1234ABCD');
    expect(parseSupportId('HANA-I234-OBCD')).toBe('12340BCD');
    expect(parseSupportId('HANA-1234-ABCU')).toBeNull();
    expect(parseSupportId('HANA-1234')).toBeNull();
  });
});

describe('parseUserSearch', () => {
  const G = `G${'A'.repeat(55)}`;
  const E = `0x${'aB'.repeat(20)}`;
  const id = `hu_${'0'.repeat(26)}`;
  it('names addresses, user ids and Support IDs, for staff and partners alike', () => {
    for (const allowSub of [true, false]) {
      expect(parseUserSearch(` ${G} `, { allowSub })).toEqual({ kind: 'address', chain: 'stellar', address: G });
      expect(parseUserSearch(E, { allowSub })).toEqual({ kind: 'address', chain: 'evm', address: E });
      expect(parseUserSearch(id, { allowSub })).toEqual({ kind: 'userId', userId: id });
      expect(parseUserSearch('HANA-ABCD-1234', { allowSub })).toEqual({ kind: 'supportId', code: 'ABCD1234' });
    }
  });
  it('takes a sub from staff only', () => {
    expect(parseUserSearch('110248495921238986420', { allowSub: true })).toEqual({ kind: 'sub', sub: '110248495921238986420' });
    expect(parseUserSearch('110248495921238986420', { allowSub: false })).toBeNull();
    expect(parseUserSearch('a b', { allowSub: true })).toBeNull();
    expect(parseUserSearch('', { allowSub: true })).toBeNull();
    expect(parseUserSearch('x'.repeat(256), { allowSub: true })).toBeNull();
  });
});

describe('RPC inputs', () => {
  it('are strict and check ids, cursors and limits', () => {
    expect(consoleListUsersInput.safeParse({ ...ctx, orgId: 'org_abc' }).success).toBe(true);
    expect(consoleListUsersInput.safeParse({ ...ctx, orgId: 'org_abc', sub: 'x' }).success).toBe(false);
    expect(consoleListUsersInput.safeParse({ ...ctx, orgId: 'org_abc', cursor: `123:hu_${'0'.repeat(26)}` }).success).toBe(true);
    expect(consoleListUsersInput.safeParse({ ...ctx, orgId: 'org_abc', cursor: 'nope' }).success).toBe(false);
    expect(consoleListUsersInput.safeParse({ ...ctx, orgId: 'org_abc', limit: 101 }).success).toBe(false);
    expect(consoleGetUserInput.safeParse({ ...ctx, orgId: 'org_abc', userId: 'hu_short' }).success).toBe(false);
    expect(adminFindUsersInput.safeParse({ ...ctx, query: 'x', provider: 'Google' }).success).toBe(false);
  });
});
