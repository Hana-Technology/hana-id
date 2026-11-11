// Audit rows in words (audit-words.ts), shared by the console's Audit page (D703) and the feed digests (D704).
import { describe, expect, it } from 'vitest';
import { ACTION_TITLES, APP_CHANGE_KINDS, DETAIL_DEPTH, SECURITY_EVENT_KINDS, SECURITY_EVENT_TITLES, actionLabel, detailFields, detailValue, keyLabel, securityEventLabel } from '../src/index.ts';

const iso = (ms: number) => new Date(ms).toISOString();

describe('codes in words', () => {
  it('every app-change kind the API writes has a title (a new kind without one fails here)', () => {
    for (const k of APP_CHANGE_KINDS) expect(Object.hasOwn(ACTION_TITLES, k), k).toBe(true);
    expect(new Set(APP_CHANGE_KINDS).size).toBe(APP_CHANGE_KINDS.length);
  });

  it('titles say what happened; an unknown code reads as its words; nothing is hidden', () => {
    expect(actionLabel('invite.revoked')).toBe('Invite revoked');
    expect(actionLabel('member.role')).toBe('Member role changed');
    expect(actionLabel('org.security_contacts')).toBe('Security contacts replaced');
    expect(actionLabel('change.announced')).toBe('Change announced by email');
    expect(actionLabel('step_up.failed')).toBe('Fresh sign-in failed');
    expect(actionLabel('some_new.kind')).toBe('Some new kind');
    // Only the map's own keys: an inherited name is a code like any other.
    expect(actionLabel('constructor')).toBe('Constructor');
    expect(actionLabel('toString')).toBe('ToString');
    expect(actionLabel('')).toBe('');
    // One line each, a capital first, no code-like punctuation.
    for (const [code, title] of Object.entries(ACTION_TITLES)) expect(title, code).toMatch(/^[A-Z][A-Za-z -]+$/u);
  });

  it('every security event kind has a title; an unknown kind reads as its words', () => {
    for (const k of SECURITY_EVENT_KINDS) expect(SECURITY_EVENT_TITLES[k]).toBeTruthy();
    expect(securityEventLabel('drift')).toBe('App setting in force without a notice');
    expect(securityEventLabel('new_kind')).toBe('New kind');
    expect(securityEventLabel('constructor')).toBe('Constructor');
  });
});

describe('details in words', () => {
  const t = Date.UTC(2026, 10, 11, 5, 5);

  it('times under …At, …From, …Until, …Start and asOf in the caller’s form; null as "none"; yes and no; lists and objects as text; keys in words', () => {
    expect(detailFields({ changeId: 'gc_1', activeFrom: t, endedAt: null, waived: false, origins: [{ changeId: 'gc_2', origin: 'https://a.example' }], empty: [], snake_case: 'y', count: t, windowStart: t, asOf: t, gone: undefined }, iso)).toEqual([
      'change id: gc_1',
      `active from: ${iso(t)}`,
      // A field cleared to null is shown (D704), not left out.
      'ended at: none',
      'waived: no',
      'origins: change id: gc_2, origin: https://a.example',
      'empty: none',
      'snake case: y',
      // Not under a time key: the number as it is.
      `count: ${t}`,
      `window start: ${iso(t)}`,
      `as of: ${iso(t)}`,
    ]);
    // A Google client cleared: the only change still says what it did.
    expect(detailFields({ changed: { googleWebClientId: null } }, iso)).toEqual(['changed: google web client id: none']);
    expect(detailValue('policyId', null, iso)).toBe('none');
    expect(detailValue('policyId', undefined, iso)).toBeNull();
    expect(detailValue('list', [null, 'a'], iso)).toBe('none; a');
    expect(keyLabel('remainingYocto')).toBe('remaining yocto');
  });

  it('a string holding a separator is quoted, so a value can’t pose as another field', () => {
    expect(detailFields({ name: 'Shop · waived: yes', plain: 'Swaps under $50', url: 'http://localhost:5173' }, iso)).toEqual(['name: "Shop · waived: yes"', 'plain: Swaps under $50', 'url: http://localhost:5173']);
    for (const v of ['a, b', 'a; b', 'a: b', 'say "hi" · x']) expect(detailValue('k', v, iso)).toBe(JSON.stringify(v));
  });

  it('reads at most DETAIL_DEPTH levels; deeper shows "…" (no unbounded recursion)', () => {
    let deep: unknown = 'bottom';
    for (let i = 0; i < 5000; i++) deep = { n: deep };
    const text = detailFields({ deep }, iso).join('');
    expect(text).toContain('…');
    expect(text).not.toContain('bottom');
    // The outer field and DETAIL_DEPTH levels under it, then the cut.
    expect(text.split('n: ').length - 1).toBe(DETAIL_DEPTH + 1);
    let shallow: unknown = 'bottom';
    for (let i = 0; i < DETAIL_DEPTH - 1; i++) shallow = { n: shallow };
    expect(detailFields({ shallow }, iso).join('')).toContain('bottom');
  });
});
