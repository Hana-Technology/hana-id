// Audit rows in words (audit-words.ts), shared by the console's Audit page (D703) and the feed digests (D704).
import { describe, expect, it } from 'vitest';
import { ACTION_TITLES, SECURITY_EVENT_KINDS, SECURITY_EVENT_TITLES, actionLabel, detailFields, detailValue, keyLabel, securityEventLabel } from '../src/index.ts';

const iso = (ms: number) => new Date(ms).toISOString();

describe('codes in words', () => {
  it('a known title, else the code as words; nothing is hidden', () => {
    expect(actionLabel('member.invite')).toBe('Member invited');
    expect(actionLabel('org.security_contacts')).toBe('Security contacts replaced');
    expect(actionLabel('app.resumed')).toBe('Suspension lifted');
    expect(actionLabel('key.created')).toBe('Key created');
    expect(actionLabel('step_up.failed')).toBe('Step up failed');
    expect(actionLabel('change.announced')).toBe('Change announced');
    expect(actionLabel('some_new.kind')).toBe('Some new kind');
    // Only the map's own keys: an inherited name is a code like any other.
    for (const code of ['constructor', 'toString', '__proto__']) expect(actionLabel(code)).toBe(code === '__proto__' ? 'Proto' : code[0]!.toUpperCase() + code.slice(1));
    expect(actionLabel('')).toBe('');
    for (const title of Object.values(ACTION_TITLES)) expect(title).toMatch(/^[A-Z][a-z ]+$/u);
  });

  it('every security event kind has a title; an unknown kind reads as its words', () => {
    for (const k of SECURITY_EVENT_KINDS) expect(SECURITY_EVENT_TITLES[k]).toBeTruthy();
    expect(securityEventLabel('drift')).toBe('App setting in force without a notice');
    expect(securityEventLabel('home_budget_high')).toBe('Hana Home daily budget running high');
    expect(securityEventLabel('new_kind')).toBe('New kind');
    expect(securityEventLabel('constructor')).toBe('Constructor');
  });
});

describe('details in words', () => {
  it('times under …At, …From, …Until in the caller’s form; nulls dropped; yes and no; lists and objects as text; keys in words', () => {
    const t = Date.UTC(2026, 10, 11, 5, 5);
    expect(detailFields({ changeId: 'gc_1', activeFrom: t, endedAt: null, waived: false, origins: [{ changeId: 'gc_2', origin: 'https://a.example' }], empty: [], snake_case: 'y', count: t }, iso)).toEqual([
      'change id: gc_1',
      `active from: ${iso(t)}`,
      'waived: no',
      'origins: change id: gc_2, origin: https://a.example',
      'empty: none',
      'snake case: y',
      // Not under a time key: the number as it is.
      `count: ${t}`,
    ]);
    expect(detailValue('policyId', undefined, iso)).toBeNull();
    expect(detailValue('nested', { a: null }, iso)).toBe('none');
    expect(keyLabel('remainingYocto')).toBe('remaining yocto');
  });
});
