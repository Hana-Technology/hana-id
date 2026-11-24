// The other apps that use this wallet, vault side (D912): the vault passes its own GET /v1/app's `otherApps` (served to
// the vault's origin only) to the login popup (auth-params) and the approval popup (approve-request,
// consent-request), each name cut as Passport Home shows it, only when there are other apps; an app alone sends exactly
// the messages older pages take; nothing the vault sends the partner page (its port, its window) ever carries them.
import { OTHER_APPS_NAMES_MAX, isOtherApps } from '@hana-id/core';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HOME_UNNAMED_APP } from '../../src/auth/app-name.ts';
import { OTHER_APPS_WAIT_MS, otherAppsField, readServedOtherApps } from '../../src/vault/other-apps.ts';
import { functionSelector } from '@hana-id/core/decode';
import { Browser, type FakeWindow, type Google, HOUR, type Tab, answer, answerConsent, google, login, makeConfig, openApproval, readyTab, waitLauncher } from './harness.ts';
import { CHAIN, EVM_VAULT } from './chains.ts';

const POLICY = () => ({
  v: 1,
  label: 'Swaps on Example',
  maxConsentMs: 6 * HOUR,
  limits: { perDayCount: 5 },
  evm: {
    chains: [
      {
        chainId: CHAIN,
        maxValueWei: '101000',
        maxValueWeiPerDay: '900000',
        maxFeeWei: '100000',
        contracts: [{ address: EVM_VAULT, name: 'Example vault', selectors: [{ selector: functionSelector('deposit(uint256)'), signature: 'deposit(uint256)' }] }],
      },
    ],
  },
});

let g: Google;
const tabs: Tab[] = [];
beforeAll(async () => {
  g = await google();
});
afterEach(() => {
  for (const t of tabs.splice(0)) {
    t.close();
    t.browser.timers.dispose();
  }
});

const SHARED = { count: 7, names: ['Stamp Trail', 'Coffee Club', 'Kite Pay', 'Orbit Swap', 'Lumen'] };

async function session(otherApps: unknown) {
  const browser = new Browser();
  const app = { ...browser.backend.app };
  if (otherApps === undefined) delete app.otherApps;
  else app.otherApps = otherApps;
  browser.backend.app = app;
  const t = await readyTab(browser, { googleJwk: g.jwk });
  tabs.push(t);
  const { run } = await login(t, g);
  return { t, params: run.params as Record<string, unknown> };
}

/** The approval popup each tab opened (reused for its later requests, as the vault reuses it). */
const popups = new WeakMap<Tab, { popup: FakeWindow; shown: number }>();

/** The approval popup's request for a message signature, answered with Reject. */
async function approveRequest(t: Tab): Promise<Record<string, unknown>> {
  const reply = t.request('stellar_signMessage', { message: 'hi' });
  let open = popups.get(t);
  if (!open) {
    await waitLauncher(t, 'Review in Journear Passport');
    open = { popup: openApproval(t), shown: 0 };
    popups.set(t, open);
  }
  const req = await open.popup.next('hana:approve-request', open.shown);
  open.shown += 1;
  answer(t, open.popup, req, false);
  await reply;
  return req;
}

/** Every string anywhere in what the vault posted to the partner page: its port and its window. */
function partnerSaw(t: Tab): string {
  return JSON.stringify([t.portMessages, t.parent.posted.map((p) => p.message)]);
}

describe('readServedOtherApps (the API’s field, as the vault keeps it)', () => {
  it('keeps a count and the names, each cut as Passport Home shows it', () => {
    const long = 'A'.repeat(70);
    expect(readServedOtherApps({ count: 2, names: ['Stamp Trail', long] })).toEqual({ count: 2, names: ['Stamp Trail', `${'A'.repeat(60)}…`] });
    expect(readServedOtherApps({ count: 0, names: [] })).toEqual({ count: 0, names: [] });
  });

  it('replaces a name with a control, bidi or invisible character by Journear’s words, never showing it', () => {
    for (const bad of ['Pay\u202Egnp.exe', 'Zero\u200Bwidth', 'Line\nbreak', '   ', '']) expect(readServedOtherApps({ count: 1, names: [bad] })).toEqual({ count: 1, names: [HOME_UNNAMED_APP] });
  });

  it.each([
    ['absent (another API, a failed read)', undefined],
    ['null', null],
    ['a negative count', { count: -1, names: [] }],
    ['a count that is not a whole number', { count: 1.5, names: ['A'] }],
    ['names for a count of 0', { count: 0, names: ['A'] }],
    ['fewer names than the count asks for', { count: 3, names: ['A', 'B'] }],
    ['more names than the window lists', { count: 9, names: ['A', 'B', 'C', 'D', 'E', 'F'] }],
    ['an extra key', { count: 1, names: ['A'], origins: ['https://a.example'] }],
  ])('is no answer for %s', (_, v) => {
    expect(readServedOtherApps(v)).toBeNull();
  });

  it('a name that is not text counts, as “Unnamed app” (as Passport Home lists it)', () => {
    expect(readServedOtherApps({ count: 1, names: [7] })).toEqual({ count: 1, names: [HOME_UNNAMED_APP] });
  });

  it('a window field only when other apps share the wallet', () => {
    expect(otherAppsField({ count: 0, names: [] })).toEqual({});
    expect(otherAppsField(null)).toEqual({});
    const field = otherAppsField(SHARED);
    expect(field).toEqual({ otherApps: SHARED });
    expect(field.otherApps!.names).not.toBe(SHARED.names);
    expect(isOtherApps(field.otherApps)).toBe(true);
    expect(SHARED.names.length).toBe(OTHER_APPS_NAMES_MAX);
  });
});

describe('the shared-wallet line’s apps (vault side, D912)', () => {
  it('passes them to the login popup and the approval popup, and never to the partner page', async () => {
    const { t, params } = await session(SHARED);
    expect(params.otherApps).toEqual(SHARED);
    const req = await approveRequest(t);
    expect(req.otherApps).toEqual(SHARED);
    // The proof the partner page can't read it: not one name (nor the field) in anything the vault sent it.
    const seen = partnerSaw(t);
    expect(seen).not.toContain('otherApps');
    for (const name of SHARED.names) expect(seen).not.toContain(name);
    // Posted to the windows on the auth origin only.
    const popups = t.opened.flatMap((w) => w.posted).filter((p) => 'otherApps' in p.message);
    expect(popups.length).toBeGreaterThan(0);
    for (const p of popups) expect(p.targetOrigin).toBe(t.vault['env'].authOrigin);
  });

  it('an app alone on its scope sends exactly the older messages: no field anywhere', async () => {
    const { t, params } = await session({ count: 0, names: [] });
    expect(params).not.toHaveProperty('otherApps');
    expect(await approveRequest(t)).not.toHaveProperty('otherApps');
  });

  it.each([
    ['an older API (no field)', undefined],
    ['a field it can’t read', { count: 2, names: ['Only one'] }],
  ])('%s: no line, and the login and the approval still work', async (_, v) => {
    const { t, params } = await session(v);
    expect(params).not.toHaveProperty('otherApps');
    expect(await approveRequest(t)).not.toHaveProperty('otherApps');
  });

  it('a later read without the field (a failed read) keeps what the vault knew; a newer one replaces it', async () => {
    const { t } = await session(SHARED);
    const app = { ...t.browser.backend.app };
    delete app.otherApps;
    t.browser.backend.app = app;
    await t.vault['refreshPolicy']();
    expect((await approveRequest(t)).otherApps).toEqual(SHARED);
    t.browser.backend.app = { ...app, otherApps: { count: 1, names: ['Stamp Trail'] } };
    await t.vault['refreshPolicy']();
    expect((await approveRequest(t)).otherApps).toEqual({ count: 1, names: ['Stamp Trail'] });
    t.browser.backend.app = { ...app, otherApps: { count: 0, names: [] } };
    await t.vault['refreshPolicy']();
    expect(await approveRequest(t)).not.toHaveProperty('otherApps');
  });

  it('the auto-approve consent screen gets them too', async () => {
    const browser = new Browser();
    browser.backend.app = { ...browser.backend.app, otherApps: SHARED };
    browser.backend.serverNow = () => browser.timers.now;
    const t = await readyTab(browser, { googleJwk: g.jwk, config: makeConfig({ settings: { autoApprovePolicy: POLICY() } }) });
    tabs.push(t);
    await login(t, g);
    const pending = t.request('hana_requestAutoApprove');
    await waitLauncher(t, 'Review in Journear Passport');
    const popup = openApproval(t);
    const consent = await popup.next('hana:consent-request');
    expect(consent.otherApps).toEqual(SHARED);
    answerConsent(t, popup, consent, false);
    await pending;
    const seen = partnerSaw(t);
    for (const name of SHARED.names) expect(seen).not.toContain(name);
  });

  it('a request before the vault’s first answer waits once for a read, at most OTHER_APPS_WAIT_MS, then shows the line', async () => {
    const browser = new Browser();
    browser.backend.app = { ...browser.backend.app, otherApps: SHARED };
    const t = await readyTab(browser, { googleJwk: g.jwk });
    tabs.push(t);
    await login(t, g);
    // As if no answer had come yet.
    t.vault['otherApps'] = null;
    const before = browser.backend.calls.filter((c) => c.path === '/v1/app').length;
    const req = await approveRequest(t);
    expect(req.otherApps).toEqual(SHARED);
    expect(browser.backend.calls.filter((c) => c.path === '/v1/app').length).toBe(before + 1);
    expect(OTHER_APPS_WAIT_MS).toBe(3_000);
  });

  it('a request whose read never answers goes after OTHER_APPS_WAIT_MS, without the line, and is never refused for it', async () => {
    const browser = new Browser();
    const t = await readyTab(browser, { googleJwk: g.jwk });
    tabs.push(t);
    await login(t, g);
    t.vault['otherApps'] = null;
    browser.backend.overrides.set('/v1/app', () => new Promise<Response>(() => undefined));
    const req = await approveRequest(t);
    expect(req).not.toHaveProperty('otherApps');
  });

  it('a request whose read answers without the field goes at once, without the line', async () => {
    const browser = new Browser();
    const t = await readyTab(browser, { googleJwk: g.jwk });
    tabs.push(t);
    await login(t, g);
    t.vault['otherApps'] = null;
    const app = { ...browser.backend.app };
    delete app.otherApps;
    browser.backend.app = app;
    const req = await approveRequest(t);
    expect(req).not.toHaveProperty('otherApps');
  });
});
