// The pinned disposable-address domain list (docs/email-login-spec.md "Rate limits and abuse", Q10, D123, D157).
//
// GUARD: no Google-hosted domain is ever on the list, nor any parent of one, so a Gmail user can never be refused at
// email login. Google-hosted = gmail.com and googlemail.com by domain (spec "The four cases"); google.com is added as
// Google's own Workspace domain. Why the Gmail domains are one mailbox per person is cited from Google's help pages
// in test/vectors.test.ts (spec Q7): https://support.google.com/mail/answer/7436150 (dots don't matter),
// https://support.google.com/a/users/answer/9308648 (+suffix reaches the same inbox),
// https://support.google.com/mail/answer/61177 (a deleted Gmail address can't be used by anyone in the future).
import { describe, expect, it } from 'vitest';
import { DISPOSABLE_DOMAINS_SOURCE, disposableDomains, isDisposableDomain, normalizeDomain, normalizeEmail } from '../src/index.ts';
import { DISPOSABLE_DOMAINS_TEXT } from '../src/disposable-domains.ts';
import { PROTECTED_DOMAINS, protectedConflicts } from '../scripts/protected-domains.mjs';
import { readText, sha256Hex } from './helpers.ts';

describe('disposable-domain list: Google-hosted guard', () => {
  it.each([...PROTECTED_DOMAINS])('%s and its parents are not on the list', (d) => {
    const labels = d.split('.');
    for (let i = 0; i < labels.length; i++) expect(disposableDomains().has(labels.slice(i).join('.'))).toBe(false);
    expect(isDisposableDomain(d)).toBe(false);
  });

  it('a Gmail or googlemail address is never refused', () => {
    for (const input of ['a.b+c@gmail.com', 'x@googlemail.com', 'x@GMAIL.COM.']) {
      const r = normalizeEmail(input);
      expect(r.ok && isDisposableDomain(r.domain)).toBe(false);
    }
  });

  it('covers the spec Google-hosted domains, and the shared check the update script runs finds no conflict', () => {
    expect(PROTECTED_DOMAINS).toEqual(expect.arrayContaining(['gmail.com', 'googlemail.com']));
    expect(protectedConflicts(disposableDomains())).toEqual([]);
    expect(protectedConflicts(new Set(['com']))).toEqual(['com', 'com', 'com']);
    expect(protectedConflicts(new Set(['googlemail.com']))).toEqual(['googlemail.com']);
    expect(readText('scripts/update-disposable-domains.mjs')).toContain("import { protectedConflicts } from './protected-domains.mjs';");
  });
});

describe('disposable-domain list: pinned source', () => {
  it('is the upstream file at the pinned commit, byte for byte', () => {
    expect(DISPOSABLE_DOMAINS_SOURCE.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(sha256Hex(DISPOSABLE_DOMAINS_TEXT)).toBe(DISPOSABLE_DOMAINS_SOURCE.sha256);
    expect(disposableDomains().size).toBe(DISPOSABLE_DOMAINS_SOURCE.count);
    expect(DISPOSABLE_DOMAINS_SOURCE.count).toBeGreaterThan(5000);
    expect(DISPOSABLE_DOMAINS_SOURCE.license).toBe('CC0-1.0');
  });

  it('the README names the same commit and size', () => {
    const readme = readText('README.md');
    expect(readme).toContain(DISPOSABLE_DOMAINS_SOURCE.commit);
    expect(readme).toContain(String(DISPOSABLE_DOMAINS_SOURCE.count));
  });

  it('every entry is already a normalized domain with a dot, so the lookup after normalization can match it', () => {
    const bad = [...disposableDomains()].filter((d) => {
      const r = normalizeDomain(d);
      return !r.ok || r.domain !== d;
    });
    expect(bad).toEqual([]);
  });
});

describe('isDisposableDomain', () => {
  it('matches a listed domain and any subdomain of it (D157)', () => {
    expect(disposableDomains().has('mailinator.com')).toBe(true);
    expect(isDisposableDomain('mailinator.com')).toBe(true);
    expect(isDisposableDomain('x.mailinator.com')).toBe(true);
    expect(isDisposableDomain('a.b.mailinator.com')).toBe(true);
  });

  it('does not match by substring or a listed name under another parent', () => {
    expect(isDisposableDomain('hanamailinator.com')).toBe(false);
    expect(isDisposableDomain('mailinator.com.example.org')).toBe(false);
    expect(isDisposableDomain('example.com')).toBe(false);
    expect(isDisposableDomain('outlook.com')).toBe(false);
  });

  it('refuses a domain that is not normalized', () => {
    for (const d of ['Mailinator.com', 'mailinator.com.', 'localhost', '']) expect(() => isDisposableDomain(d)).toThrow(TypeError);
  });
});
