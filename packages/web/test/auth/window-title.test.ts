// @vitest-environment happy-dom
// D881: the sign-in window's title follows the screen in view (dom.ts `titleFromHeading`), and the banner change the
// email page remembers across a Google proof (email-storage.ts `bannerAction`) is checked field by field.
import { relayIdFor } from '@hana-id/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { SIGN_IN_WINDOW, dom, errorView } from '../../src/auth/dom.ts';
import { type EmailContext, EMAIL_ENTRY_PREFIX, isBannerAction, readEmailContext, storeEmailContext } from '../../src/auth/email-storage.ts';
import { resetDom } from './helpers.ts';

beforeEach(() => resetDom());

describe('the sign-in window’s title (D881)', () => {
  it('is the shown screen’s heading, white space collapsed; a screen without one gets the built title back', () => {
    document.title = 'Sign in with email';
    const d = dom(document, SIGN_IN_WINDOW);
    d.show(d.h('section', {}, d.h('h1', {}, 'You can now sign in ', d.h('strong', {}, 'with Google'), '  too')));
    expect(document.title).toBe('You can now sign in with Google too');
    d.show(errorView(d, 'Sign-in stopped', 'Start again from the app.', 'login_timeout'));
    expect(document.title).toBe('Sign-in stopped');
    d.show(d.h('p', {}, 'No heading'));
    expect(document.title).toBe('Sign in with email');
    // A second dom() on the same page (the callback page makes several) still knows the built title.
    d.show(d.h('h1', {}, 'Signed in'));
    const again = dom(document, SIGN_IN_WINDOW);
    again.show(d.h('p', {}, 'No heading'));
    expect(document.title).toBe('Sign in with email');
  });

  it('other pages keep their built title (the option is the sign-in window’s)', () => {
    document.title = 'Review in Journear Passport';
    const d = dom(document);
    d.show(d.h('h1', {}, 'Approved'));
    expect(document.title).toBe('Review in Journear Passport');
  });
});

describe('the banner change the email page remembers (D881)', () => {
  const ok = { kind: 'unlink', provider: 'email', method: 'google', slot: 4, signedIn: true };

  it('accepts only kinds, a follow-up slot and a flag', () => {
    expect(isBannerAction(ok)).toBe(true);
    expect(isBannerAction({ ...ok, kind: 'cancel', provider: 'google', method: 'email', slot: 12, signedIn: false })).toBe(true);
    for (const bad of [{ ...ok, kind: 'link' }, { ...ok, provider: 'apple' }, { ...ok, slot: 1 }, { ...ok, slot: 13 }, { ...ok, slot: 4.5 }, { ...ok, signedIn: 'yes' }, { ...ok, address: 'ada@example.com' }, null, [ok]]) {
      expect(isBannerAction(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('round-trips with the context; a context without it reads as before, a malformed one is refused', () => {
    const relayId = relayIdFor(crypto.getRandomValues(new Uint8Array(32)));
    const ctx: EmailContext = {
      pk: 'pk_test_x',
      appName: 'App',
      parentOrigin: 'https://partner.example',
      scopeId: 's1',
      sessionPublicKey: new Uint8Array(32),
      expiresAtMs: 2_000,
      salt: new Uint8Array(32),
      keyIndex: 0,
      maxUses: 1,
      nonce: 'n',
      clientId: null,
      methods: ['google', 'email'],
      opener: 'partner',
      vaultFrame: null,
      emailHint: null,
      challengeId: null,
    };
    storeEmailContext(window.sessionStorage, relayId, ctx, 1_000);
    expect(readEmailContext(window.sessionStorage, relayId, 1_000)?.context.bannerAction).toBeUndefined();
    storeEmailContext(window.sessionStorage, relayId, { ...ctx, bannerAction: ok as EmailContext['bannerAction'] }, 1_000);
    expect(readEmailContext(window.sessionStorage, relayId, 1_000)?.context.bannerAction).toEqual(ok);
    const raw = JSON.parse(window.sessionStorage.getItem(EMAIL_ENTRY_PREFIX + relayId)!);
    raw.c.bannerAction = { ...ok, slot: 99 };
    window.sessionStorage.setItem(EMAIL_ENTRY_PREFIX + relayId, JSON.stringify(raw));
    expect(readEmailContext(window.sessionStorage, relayId, 1_000)).toBeNull();
  });

  it('a field a page doesn’t know is read along, kept and stored again unused (as an older page treats `bannerAction`)', () => {
    const relayId = relayIdFor(crypto.getRandomValues(new Uint8Array(32)));
    const ctx = {
      pk: 'pk_test_x',
      appName: 'App',
      parentOrigin: 'https://partner.example',
      scopeId: 's1',
      sessionPublicKey: new Uint8Array(32),
      expiresAtMs: 2_000,
      salt: new Uint8Array(32),
      keyIndex: 0,
      maxUses: 1,
      nonce: 'n',
      clientId: null,
      methods: ['google', 'email'],
      opener: 'partner',
      vaultFrame: null,
      emailHint: null,
      challengeId: null,
    } as EmailContext;
    storeEmailContext(window.sessionStorage, relayId, ctx, 1_000);
    const raw = JSON.parse(window.sessionStorage.getItem(EMAIL_ENTRY_PREFIX + relayId)!);
    raw.c.laterField = { any: 'thing' };
    window.sessionStorage.setItem(EMAIL_ENTRY_PREFIX + relayId, JSON.stringify(raw));
    // Read: valid, the unknown field along with the rest (the read spreads the stored object).
    const read = readEmailContext(window.sessionStorage, relayId, 1_000)!.context as EmailContext & { laterField?: unknown };
    expect(read.laterField).toEqual({ any: 'thing' });
    // Stored again (a page's `remember`): still there, for the page that knows it.
    storeEmailContext(window.sessionStorage, relayId, { ...read, challengeId: null }, 1_000);
    expect(JSON.parse(window.sessionStorage.getItem(EMAIL_ENTRY_PREFIX + relayId)!).c.laterField).toEqual({ any: 'thing' });
  });
});
