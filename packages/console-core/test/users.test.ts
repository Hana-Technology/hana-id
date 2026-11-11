// End-user ids and searches (src/users.ts, D312, D346): the User ID (the identity token's `sub`), the Support ID as
// its short form (the first 40 bits of the same HMAC output), the internal id from a uid, typed Support IDs, the
// search kinds for staff and partners, and the RPC inputs.
import { readFileSync } from 'node:fs';
import { IDENTITY_SUB_PREFIX, base64UrlEncode, identitySub, identitySubBytes } from '@hana-id/core';
import { describe, expect, it } from 'vitest';
import {
  USER_ID_PREFIX,
  adminFindUsersInput,
  adminGetUserInput,
  consoleGetUserInput,
  consoleListUsersInput,
  crockford32,
  formatSupportId,
  internalIdOf,
  parseSupportId,
  parseUserSearch,
  supportCodeOf,
  supportIdOf,
  uid,
  uidOfInternalId,
  userIdBytes,
} from '../src/index.ts';

const ctx = { actor: { kind: 'hana' as const, id: 'staff-1', email: 'staff@hana.example' }, requestId: 'req_12345678', clientIp: '203.0.113.9' };

// The identity token's own vectors (packages/core, written by an independent node:crypto implementation): the Support
// ID is pinned against the same `sub` values partners receive.
const V = JSON.parse(readFileSync(new URL('../../core/test/vectors/identity-v1.json', import.meta.url), 'utf8')) as {
  sub_key_hex: string;
  scope_id: string;
  subs: Record<string, { sub: string; sub_bytes_hex: string }>;
};
const hexBytes = (h: string) => Uint8Array.from(h.match(/../gu)!.map((x) => parseInt(x, 16)));

describe('crockford32', () => {
  it('encodes most significant bit first with Crockford’s alphabet', () => {
    expect(crockford32(Uint8Array.of())).toBe('');
    expect(crockford32(Uint8Array.of(0xff))).toBe('ZW');
    expect(crockford32(Uint8Array.of(0, 0, 0, 0, 0))).toBe('00000000');
    expect(crockford32(Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff))).toBe('ZZZZZZZZ');
    expect(crockford32(Uint8Array.of(0x08, 0x42, 0x10, 0x84, 0x21))).toBe('11111111');
  });
});

describe('User ID and Support ID (D346)', () => {
  it('the User ID prefix is the identity token’s', () => {
    expect(USER_ID_PREFIX).toBe(IDENTITY_SUB_PREFIX);
  });

  it('pins the Support ID of the identity token’s vector subs: Crockford base32 of the sub’s first 5 bytes', () => {
    const expected: Record<string, string> = { google_k0: 'HANA-2750-G5HM', google_k1: 'HANA-2750-G5HM', google_other_scope: 'HANA-RWR8-1A1X', email_root: 'HANA-CQ87-RVT7' };
    for (const [name, v] of Object.entries(V.subs)) {
      expect(userIdBytes(v.sub), name).toEqual(hexBytes(v.sub_bytes_hex));
      expect(supportCodeOf(v.sub), name).toBe(crockford32(hexBytes(v.sub_bytes_hex).subarray(0, 5)));
      expect(supportIdOf(v.sub), name).toBe(expected[name]);
    }
  });

  it('comes from the identity token’s own sub code, for any key and root (decode is the inverse of the encoding)', () => {
    for (let i = 0; i < 50; i++) {
      const key = crypto.getRandomValues(new Uint8Array(32));
      const root = { provider: i % 2 ? 'google' : 'email', sub: `sub-${i}-${Math.random()}` };
      const sub = identitySub(key, `s${i}`, root);
      const bytes = identitySubBytes(key, `s${i}`, root);
      expect(sub).toBe(IDENTITY_SUB_PREFIX + base64UrlEncode(bytes));
      expect(userIdBytes(sub)).toEqual(bytes);
      expect(supportIdOf(sub)).toBe(formatSupportId(crockford32(bytes.subarray(0, 5))));
      expect(supportIdOf(sub)).toMatch(/^HANA-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/u);
    }
  });

  it('refuses anything that isn’t a canonical User ID', () => {
    const ok = V.subs.google_k0!.sub;
    expect(() => supportCodeOf(ok)).not.toThrow();
    for (const bad of ['', `hu_${'0'.repeat(26)}`, ok.slice(0, -1), `${ok}A`, `U1_${ok.slice(3)}`, `u1_${ok.slice(3, -1)}B`, `u1_${'+'.repeat(21)}A`]) {
      expect(() => supportCodeOf(bad), bad).toThrow(TypeError);
    }
  });

  it('the internal id is hu_ + 26 lowercase characters of the uid', async () => {
    const u = await uid(new Uint8Array(32).fill(7), { scopeId: 's1', provider: 'google', sub: '1102' });
    expect(internalIdOf(u)).toBe(`hu_${crockford32(u).toLowerCase()}`);
    expect(internalIdOf(u)).toMatch(/^hu_[0-9a-hjkmnp-tv-z]{26}$/u);
    expect(() => internalIdOf(u.subarray(1))).toThrow();
  });

  it('an internal id decodes back to its uid (the erasure script, D361); anything else is null', async () => {
    for (let k = 0; k < 20; k++) {
      const u = await uid(new Uint8Array(32).fill(k), { scopeId: `s${k}`, provider: 'email', sub: `e1.${k}` });
      expect(uidOfInternalId(internalIdOf(u))).toEqual(u);
    }
    expect(uidOfInternalId(internalIdOf(new Uint8Array(16)))).toEqual(new Uint8Array(16));
    expect(uidOfInternalId(internalIdOf(new Uint8Array(16).fill(0xff)))).toEqual(new Uint8Array(16).fill(0xff));
    // The last character carries 3 data bits and 2 zero padding bits: a set padding bit is no internal id.
    const id = internalIdOf(new Uint8Array(16));
    expect(uidOfInternalId(`${id.slice(0, -1)}1`)).toBeNull();
    for (const bad of ['', 'hu_', id.slice(0, -1), `${id}0`, id.replace('hu_', 'hx_'), id.toUpperCase(), `${id.slice(0, -1)}u`, `u1_${'A'.repeat(22)}`]) expect(uidOfInternalId(bad), bad).toBeNull();
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
  const userId = V.subs.google_k0!.sub;
  const internal = `hu_${'0'.repeat(26)}`;
  it('names addresses, User IDs (exact case) and Support IDs, for staff and partners alike', () => {
    for (const staff of [true, false]) {
      expect(parseUserSearch(` ${G} `, { staff })).toEqual({ kind: 'address', chain: 'stellar', address: G });
      expect(parseUserSearch(E, { staff })).toEqual({ kind: 'address', chain: 'evm', address: E });
      // A NEAR implicit account id (D755), any case, lowercased; 63 or 65 hex characters is none.
      const N = 'ab'.repeat(32);
      expect(parseUserSearch(N, { staff })).toEqual({ kind: 'address', chain: 'near', address: N });
      expect(parseUserSearch(N.toUpperCase(), { staff })).toEqual({ kind: 'address', chain: 'near', address: N });
      expect(parseUserSearch(N.slice(1), { staff })?.kind).not.toBe('address');
      expect(parseUserSearch(`${N}a`, { staff })?.kind).not.toBe('address');
      expect(parseUserSearch(userId, { staff })).toEqual({ kind: 'userId', userId });
      expect(parseUserSearch('HANA-ABCD-1234', { staff })).toEqual({ kind: 'supportId', code: 'ABCD1234' });
    }
    // Base64url is case-sensitive: another case is another id, searched as typed (never folded onto this one).
    expect(parseUserSearch(userId.toLowerCase(), { staff: false })).toEqual({ kind: 'userId', userId: userId.toLowerCase() });
  });
  it('takes an internal id (any case) and a sub from staff only', () => {
    expect(parseUserSearch(internal, { staff: true })).toEqual({ kind: 'internalId', internalId: internal });
    expect(parseUserSearch(internal.toUpperCase().replace('HU_', 'hu_'), { staff: true })).toEqual({ kind: 'internalId', internalId: internal });
    expect(parseUserSearch(internal, { staff: false })).toBeNull();
    expect(parseUserSearch('110248495921238986420', { staff: true })).toEqual({ kind: 'sub', sub: '110248495921238986420' });
    expect(parseUserSearch('110248495921238986420', { staff: false })).toBeNull();
    expect(parseUserSearch('a b', { staff: true })).toBeNull();
    expect(parseUserSearch('', { staff: true })).toBeNull();
    expect(parseUserSearch('x'.repeat(256), { staff: true })).toBeNull();
  });
});

describe('RPC inputs', () => {
  const userId = V.subs.google_k0!.sub;
  it('are strict and check ids, cursors and limits', () => {
    expect(consoleListUsersInput.safeParse({ ...ctx, orgId: 'org_abc' }).success).toBe(true);
    expect(consoleListUsersInput.safeParse({ ...ctx, orgId: 'org_abc', sub: 'x' }).success).toBe(false);
    expect(consoleListUsersInput.safeParse({ ...ctx, orgId: 'org_abc', cursor: `123:${userId}` }).success).toBe(true);
    // A cursor never carries an internal id.
    expect(consoleListUsersInput.safeParse({ ...ctx, orgId: 'org_abc', cursor: `123:hu_${'0'.repeat(26)}` }).success).toBe(false);
    expect(consoleListUsersInput.safeParse({ ...ctx, orgId: 'org_abc', cursor: 'nope' }).success).toBe(false);
    expect(consoleListUsersInput.safeParse({ ...ctx, orgId: 'org_abc', limit: 101 }).success).toBe(false);
    expect(consoleGetUserInput.safeParse({ ...ctx, orgId: 'org_abc', userId }).success).toBe(true);
    expect(consoleGetUserInput.safeParse({ ...ctx, orgId: 'org_abc', userId: `hu_${'0'.repeat(26)}` }).success).toBe(false);
    expect(consoleGetUserInput.safeParse({ ...ctx, orgId: 'org_abc', internalId: `hu_${'0'.repeat(26)}` }).success).toBe(false);
    expect(adminFindUsersInput.safeParse({ ...ctx, query: 'x', provider: 'Google' }).success).toBe(false);
  });
  it('AdminRpc.getUser takes a User ID or an internal id, exactly one', () => {
    expect(adminGetUserInput.safeParse({ ...ctx, userId }).success).toBe(true);
    expect(adminGetUserInput.safeParse({ ...ctx, internalId: `hu_${'0'.repeat(26)}` }).success).toBe(true);
    expect(adminGetUserInput.safeParse({ ...ctx }).success).toBe(false);
    expect(adminGetUserInput.safeParse({ ...ctx, userId, internalId: `hu_${'0'.repeat(26)}` }).success).toBe(false);
    expect(adminGetUserInput.safeParse({ ...ctx, userId: `hu_${'0'.repeat(26)}` }).success).toBe(false);
  });
});
