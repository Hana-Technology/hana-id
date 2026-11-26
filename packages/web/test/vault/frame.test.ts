// Where the vault's parent sits (D934, pieces P11 and P12): the frame rule for web addresses an app may use only inside
// a frame, and what the windows are told about the page the person is on. Both read only what the browser tells the
// vault (`window.parent === window.top`, `location.ancestorOrigins`), never anything a page sends; a refusal is the
// same silence as every other hello the vault refuses; the frame site reaches the vault's own windows (sign-in,
// approval, consent) and never the partner page.
import { isFrameSite } from '@hana-id/core';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parseVaultConfig } from '../../src/vault/config.ts';
import { frameRuleAllows, frameSiteOf } from '../../src/vault/frame.ts';
import { Browser, type Google, type Tab, answer, google, login, makeConfig, openApproval, openTab, sleepReal, waitLauncher } from './harness.ts';

const W = 'https://widget.lumenpay.test';
const P = 'https://coffeeclub.test';
const Q = 'https://tea.test';

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

const cfg = (frameOnly: string[] | undefined, origins = [P, W]) => makeConfig({ origins, ...(frameOnly ? { frameOnly } : {}) });

function tab(o: Parameters<typeof openTab>[1], browser = new Browser()): Tab {
  const t = openTab(browser, { googleJwk: g.jwk, ...o });
  tabs.push(t);
  return t;
}

/** Whether the vault took a hello from `origin` (connected), given the tab's surroundings. */
async function takes(o: Parameters<typeof openTab>[1], origin: string): Promise<boolean> {
  const t = tab(o);
  t.hello({ origin });
  await sleepReal(40);
  return t.events.some((e) => e.event === 'connected');
}

describe('frameRuleAllows (P12)', () => {
  const rule = (frameOnly: string[] | undefined, parentOrigin: string, parentIsTop: boolean, ancestors?: string[]) => frameRuleAllows({ ...(frameOnly ? { frameOnly } : {}) }, { parentOrigin, parentIsTop, ancestors });
  it('an app with no frame-only web address: today’s behaviour, whatever the frames', () => {
    expect(rule(undefined, W, true)).toBe(true);
    expect(rule(undefined, W, true, [W])).toBe(true);
    expect(rule([], W, true)).toBe(true);
  });
  it('a frame-only parent is refused at the top (every browser: parentIsTop; or a single ancestor)', () => {
    expect(rule([W], W, true)).toBe(false);
    expect(rule([W], W, true, [W])).toBe(false);
    expect(rule([W], W, false, [W])).toBe(false);
  });
  it('a frame-only parent inside one of the app’s pages is taken; inside a frame-only page at the top it is not', () => {
    expect(rule([W], W, false, [W, P])).toBe(true);
    expect(rule([W], W, false, [W, Q, P])).toBe(true);
    expect(rule([W], W, false, [W, W])).toBe(false);
    expect(rule([W], W, false, [W, P, W])).toBe(false);
  });
  it('any parent whose top-level page is frame-only is refused (a partner page framed by the widget)', () => {
    expect(rule([W], P, false, [P, W])).toBe(false);
    expect(rule([W], P, true)).toBe(true);
  });
  it('without ancestorOrigins, a frame-only parent inside another frame is taken (frame-ancestors holds every ancestor to the app’s addresses)', () => {
    expect(rule([W], W, false)).toBe(true);
  });
});

describe('frameSiteOf (P11)', () => {
  const site = (frameOnly: string[] | undefined, parentOrigin: string, parentIsTop: boolean, ancestors?: string[], origins = [P, W]) =>
    frameSiteOf({ origins, ...(frameOnly ? { frameOnly } : {}) }, { parentOrigin, parentIsTop, ancestors });
  it('nothing when the parent is the top-level page (the windows show it, as before)', () => {
    expect(site([W], P, true)).toBeUndefined();
    expect(site(undefined, W, true, [W])).toBeUndefined();
  });
  it('the top-level page where the browser names it: the last ancestor, if not the parent itself', () => {
    expect(site([W], W, false, [W, P])).toEqual({ top: P });
    expect(site(undefined, W, false, [W, Q, P], [P, Q, W])).toEqual({ top: P });
    expect(site(undefined, P, false, [P, P])).toBeUndefined();
  });
  it('else that the browser didn’t say, with the one page to expect for a frame-only parent (never the localhost wildcard)', () => {
    expect(site([W], W, false)).toEqual({ top: null, expected: P });
    expect(site([W], W, false, undefined, [P, Q, W])).toEqual({ top: null });
    expect(site([W], W, false, undefined, [P, W, 'http://localhost:*'])).toEqual({ top: null, expected: P });
    expect(site(undefined, W, false)).toEqual({ top: null });
    expect(site([W], P, false)).toEqual({ top: null });
  });
  it('every answer is a FrameSite the windows take', () => {
    for (const s of [{ top: P }, { top: null }, { top: null, expected: P }]) expect(isFrameSite(s, W)).toBe(true);
    for (const bad of [{ top: W }, { top: null, expected: W }, { top: P, expected: P }, { top: 'nope' }, { top: undefined }, {}, { top: null, extra: 1 }, null]) expect(isFrameSite(bad, W), JSON.stringify(bad)).toBe(false);
  });
});

describe('the inlined frameOnly list', () => {
  const base = () => JSON.parse(JSON.stringify(makeConfig({ origins: [P, W, 'http://localhost:*'] }))) as Record<string, unknown>;
  it('absent reads as none; a list of the app’s own web addresses is kept', () => {
    expect(parseVaultConfig(base())?.frameOnly).toBeUndefined();
    expect(parseVaultConfig({ ...base(), frameOnly: [W] })?.frameOnly).toEqual([W]);
  });
  it('anything else refuses the whole config: empty, repeated, not one of origins, the wildcard, not a list', () => {
    for (const bad of [[], [W, W], [Q], ['http://localhost:*'], W, [1], null]) expect(parseVaultConfig({ ...base(), frameOnly: bad }), JSON.stringify(bad)).toBeNull();
  });
});

describe('the hello (P12): the same silence as any refusal', () => {
  it('a frame-only parent opened at the top is refused, in a browser with ancestorOrigins and without', async () => {
    expect(await takes({ config: cfg([W]), parentIsTop: true }, W)).toBe(false);
    expect(await takes({ config: cfg([W]), ancestorOrigins: [W] }, W)).toBe(false);
    // Unreadable reads as top-level.
    expect(await takes({ config: cfg([W]), parentIsTop: 'throws' }, W)).toBe(false);
    // The same app, its partner page at the top: taken.
    expect(await takes({ config: cfg([W]), parentIsTop: true }, P)).toBe(true);
  });
  it('a frame-only parent inside the partner’s page is taken; inside another frame-only page, or an unlisted page, is not', async () => {
    expect(await takes({ config: cfg([W]), ancestorOrigin: W, ancestorOrigins: [W, P] }, W)).toBe(true);
    expect(await takes({ config: cfg([W]), ancestorOrigin: W, ancestorOrigins: [W, W] }, W)).toBe(false);
    expect(await takes({ config: cfg([W]), ancestorOrigin: W, ancestorOrigins: [W, 'https://evil.test'] }, W)).toBe(false);
    // Firefox without ancestorOrigins: framed (parentIsTop false) is taken; frame-ancestors holds who frames it.
    expect(await takes({ config: cfg([W]), parentIsTop: false }, W)).toBe(true);
  });
  it('the partner page framed by the widget (the widget at the top) is refused', async () => {
    expect(await takes({ config: cfg([W]), ancestorOrigin: P, ancestorOrigins: [P, W] }, P)).toBe(false);
  });
  it('the same widget address, not frame-only for this app: today’s behaviour, at the top too', async () => {
    expect(await takes({ config: cfg(undefined), parentIsTop: true }, W)).toBe(true);
  });
});

/** Logs in on a tab (taken hello) and returns the login popup's auth-params. */
async function params(o: Parameters<typeof openTab>[1], origin: string): Promise<Record<string, unknown>> {
  const t = tab(o);
  t.hello({ origin });
  await t.ready();
  return (await login(t, g)).run.params as Record<string, unknown>;
}

describe('the windows are told where the page is (P11)', () => {
  it('sign-in: the top-level page where the browser names it; the browser’s silence otherwise; nothing at the top', async () => {
    expect((await params({ config: cfg([W]), ancestorOrigin: W, ancestorOrigins: [W, P] }, W)).frame).toEqual({ top: P });
    expect((await params({ config: cfg([W]), parentIsTop: false }, W)).frame).toEqual({ top: null, expected: P });
    expect((await params({ config: cfg(undefined, [P, Q, W]), parentIsTop: false }, W)).frame).toEqual({ top: null });
    const top = await params({ config: cfg([W]) }, P);
    expect(top).not.toHaveProperty('frame');
    expect(top.parentOrigin).toBe(P);
  });

  it('approval: the request carries it, the digest still binds the parent only; the partner page is never told', async () => {
    const t = tab({ config: cfg([W]), ancestorOrigin: W, ancestorOrigins: [W, P] });
    t.hello({ origin: W });
    await t.ready();
    await login(t, g);
    const reply = t.request('stellar_signMessage', { message: 'hi' });
    await waitLauncher(t, 'Review in Journear Passport');
    const popup = openApproval(t);
    const req = await popup.next('hana:approve-request', 0);
    expect(req).toMatchObject({ parentOrigin: W, frame: { top: P } });
    answer(t, popup, req, true);
    expect((await reply).error).toBeUndefined();
    expect(JSON.stringify([t.portMessages, t.parent.posted.map((p) => p.message)])).not.toContain('"frame"');
  });
});
