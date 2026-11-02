// The RPC input schemas (src/rpc.ts) and the app-name rule (src/names.ts): round trips, refusals, and the name rule
// equal to @hana-id/core's isDisplaySafeLine on every code point.
import { isDisplaySafeLine } from '@hana-id/core';
import { describe, expect, it } from 'vitest';
import {
  APP_NAME_MAX,
  ackNoticeInput,
  adminSetSuspendedInput,
  createAppInput,
  expediteChangeInput,
  isDisplaySafeName,
  listChangesInput,
  normaliseAppName,
  removeOriginsInput,
  setLogoInput,
  setSecurityContactsInput,
  updateSettingsInput,
} from '../src/index.ts';

const ctx = { actor: { kind: 'hana', id: 'access-sub', email: 'staff@hana.example' }, requestId: 'req_12345678', clientIp: '198.51.100.1' } as const;
const member = { actor: { kind: 'member', id: 'usr_1', sub: 's', email: 'o@p.example', sessionHash: 'A'.repeat(43) }, requestId: 'req_12345678', clientIp: '203.0.113.1' } as const;

describe('RPC inputs', () => {
  it('accept the spec’s shapes', () => {
    expect(removeOriginsInput.parse({ ...member, orgId: 'org_legacy', appId: 'app_abc', remove: ['https://a.example'], expectedVersion: 3 })).toMatchObject({ expectedVersion: 3 });
    expect(updateSettingsInput.safeParse({ ...member, orgId: 'org_abc', appId: 'app_abc', expectedVersion: 0, googleWebClientId: null }).success).toBe(true);
    expect(createAppInput.safeParse({ ...ctx, orgId: 'org_abc', scopeId: 's1', environment: 'live', name: 'App', origins: [], orgOwnerSubs: ['1'] }).success).toBe(true);
    expect(ackNoticeInput.safeParse({ ...ctx, changeId: 'gc_abc', cancelTokenHash: 'A'.repeat(43) }).success).toBe(true);
    expect(adminSetSuspendedInput.safeParse({ ...ctx, appId: 'app_x', bit: 4, suspended: false }).success).toBe(true);
    expect(setLogoInput.safeParse({ ...member, orgId: 'org_a', appId: 'app_x', logoKey: `logos/app_x/${'0'.repeat(64)}.png`, expectedVersion: 0 }).success).toBe(true);
  });

  it('refuse unknown fields, bad ids, out-of-range values and short reasons', () => {
    expect(removeOriginsInput.safeParse({ ...member, orgId: 'org_a', appId: 'app_a', remove: ['https://a.example'], expectedVersion: 0, extra: 1 }).success).toBe(false);
    expect(removeOriginsInput.safeParse({ ...member, orgId: 'org_a', appId: 'app_a', remove: [], expectedVersion: 0 }).success).toBe(false);
    expect(removeOriginsInput.safeParse({ ...member, orgId: 'org_a', appId: 'app_a', remove: Array(21).fill('https://a.example'), expectedVersion: 0 }).success).toBe(false);
    expect(removeOriginsInput.safeParse({ ...member, orgId: "org_a' OR 1", appId: 'app_a', remove: ['https://a.example'], expectedVersion: 0 }).success).toBe(false);
    expect(removeOriginsInput.safeParse({ ...member, orgId: 'org_a', appId: 'app_a', remove: ['https://a.example'], expectedVersion: -1 }).success).toBe(false);
    expect(listChangesInput.safeParse({ ...member, orgId: 'org_a', limit: 201 }).success).toBe(false);
    expect(adminSetSuspendedInput.safeParse({ ...ctx, appId: 'app_x', bit: 3, suspended: true }).success).toBe(false);
    expect(expediteChangeInput.safeParse({ ...ctx, changeId: 'gc_a', reason: 'x'.repeat(19) }).success).toBe(false);
    expect(expediteChangeInput.safeParse({ ...ctx, changeId: 'gc_a', reason: ` ${'x'.repeat(19)} ` }).success).toBe(false);
    expect(setSecurityContactsInput.safeParse({ ...ctx, orgId: 'org_a', emails: ['A@b.example'] }).success).toBe(false);
    expect(setSecurityContactsInput.safeParse({ ...ctx, orgId: 'org_a', emails: Array.from({ length: 11 }, (_, k) => `${k}@b.example`) }).success).toBe(false);
    expect(setLogoInput.safeParse({ ...member, orgId: 'org_a', appId: 'app_x', logoKey: 'logos/app_x/../x.png', expectedVersion: 0 }).success).toBe(false);
    expect(ackNoticeInput.safeParse({ ...ctx, changeId: 'gc_a', cancelTokenHash: 'A'.repeat(44) }).success).toBe(false);
  });
});

describe('app names', () => {
  it('normalise (NFC, trimmed) and refuse empty, long or unsafe names', () => {
    expect(normaliseAppName('  Café  ')).toEqual({ ok: true, name: 'Café' });
    expect(normaliseAppName('   ').ok).toBe(false);
    expect(normaliseAppName('x'.repeat(APP_NAME_MAX)).ok).toBe(true);
    expect(normaliseAppName('x'.repeat(APP_NAME_MAX + 1)).ok).toBe(false);
    expect(normaliseAppName('😀'.repeat(APP_NAME_MAX)).ok).toBe(true);
    for (const bad of ['a‮b', 'a​b', 'a\nb', 'a\u0007b', 'a️b', 'a\u{E0041}b']) expect(normaliseAppName(bad).ok, JSON.stringify(bad)).toBe(false);
  });

  it('the rule equals @hana-id/core isDisplaySafeLine on every code point', () => {
    const differ: number[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const s = String.fromCodePoint(cp);
      if (isDisplaySafeName(s) !== isDisplaySafeLine(s)) differ.push(cp);
    }
    expect(differ).toEqual([]);
  });
});
