// @vitest-environment happy-dom
// Hana Home's "Your name" (home-profile.ts, D714): the three calls signed with the Home identity and their strict
// parsing, the name rule checked before anything is sent, the collapsed views read only on a click, Save, "Remove my
// name" behind its confirmation, sharing and stopping per app, every refusal's sentence, the end of the sign-in, the
// reset on sign-out, and the user's and the partner's words as text only.
import { PROFILE_NAME_MAX } from '@hana-id/core/identity';
import { decodeHomeIdentity, homeMessage } from '@hana-id/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dom } from '../../src/auth/dom.ts';
import { HOME_UNNAMED_APP, type HomeIdentity, type HomeScope, homeProfileApi, homeProfileBody, newHomeIdentity, parseHomeProfile } from '../../src/auth/home-api.ts';
import { HOME_NAME_REMOVE_CONFIRM, HOME_NAME_TEXT, HOME_NAME_TITLE, type HomeProfileSection, checkNameDraft, fullName, shareLabel, startHomeProfile } from '../../src/auth/home-profile.ts';
import { ENV, FakeWindow, pageText, resetDom } from './helpers.ts';

const T0 = 1_800_000_000_000;
const XSS_APP = '<img src=x onerror="__pwned=1"><script>__pwned=1</script>';
/** A name that is valid under the rule (it is display-safe, one line, under 50) but is markup if ever parsed as HTML. */
const XSS_NAME = '<img src=x onerror="__pwned=1">';
const S1 = 's1';

const json = (status: number, body: unknown, requestId = 'req_1'): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-request-id': requestId } });
const refusal = (status: number, code: string, error = 'internal words'): Response => json(status, { error, code, requestId: 'req_9' }, 'req_9');

const ADA = { givenName: 'Ada', familyName: 'Lovelace' };
const share = (appId: string, name: string, over: Record<string, unknown> = {}) => ({ appId, name, scopeId: S1, sharedAtMs: T0 - 86_400_000, ...over });
const profile = (over: Record<string, unknown> = {}) => ({ name: ADA, shares: [], more: false, app: null, ...over });

interface Call {
  url: URL;
  method: string;
  header: string | null;
  body: string | null;
}

interface Harness {
  win: FakeWindow;
  section: HomeProfileSection;
  calls: Call[];
  answer: (url: URL, call: Call) => Response | Promise<Response>;
  identity: HomeIdentity | null;
  signedOut: number;
  /** Whether the next event counts as the user's own. */
  gesture: boolean;
  click(id: string): void;
  type(id: string, value: string): void;
  submit(): void;
  idle(): Promise<void>;
  mountFront(): void;
  mountApp(scope?: HomeScope): void;
}

const homeScope = (scopeId = S1, apps: { appId: string; name: string; status?: 'active' | 'suspended' | 'deleted' }[] = [{ appId: 'app_sodax1', name: 'Sodax' }]): HomeScope => ({
  scopeId,
  mine: true,
  coverage: 'shared',
  googleClientId: null,
  supportId: null,
  addresses: [],
  apps: apps.map((a) => ({ appId: a.appId, name: a.name, status: a.status ?? 'active', environment: 'live', origins: [], logoUrl: null })),
});

async function start(o: { isGesture?: boolean } = {}): Promise<Harness> {
  const win = new FakeWindow('/home', '');
  const calls: Call[] = [];
  const running = new Set<Promise<unknown>>();
  const identity = await newHomeIdentity(ENV.signer, T0);
  identity.attach('header.payload.signature');
  const h = {
    win,
    calls,
    identity,
    signedOut: 0,
    gesture: o.isGesture !== false,
    answer: (): Response | Promise<Response> => json(200, profile()),
  } as unknown as Harness;
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = { url, method: init?.method ?? 'GET', header: new Headers(init?.headers).get('x-hana-home'), body: init?.body ? new TextDecoder().decode(init.body as Uint8Array) : null };
    calls.push(call);
    return h.answer(url, call);
  });
  h.section = startHomeProfile({
    win,
    d: dom(document),
    api: homeProfileApi(ENV.apiUrl, fetchFn as unknown as typeof fetch),
    isGesture: () => h.gesture,
    session: () => (h.identity?.usable ? h.identity : null),
    onSignedOut: () => {
      h.signedOut += 1;
      h.identity?.end();
      h.identity = null;
    },
    track: (p) => {
      running.add(p);
      void p.finally(() => running.delete(p));
    },
    now: () => T0,
  });
  h.click = (id) => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`No #${id} on the page: ${pageText()}`);
    (el as HTMLElement).click();
  };
  h.type = (id, value) => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (!el) throw new Error(`No #${id} on the page: ${pageText()}`);
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  h.submit = () => {
    const form = document.getElementById('home-name-form') as HTMLFormElement | null;
    if (!form) throw new Error(`No form on the page: ${pageText()}`);
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  };
  // Time-bound, not a count of turns: under a loaded machine (pnpm verify's parallel lanes) a few hundred turns can pass
  // before a signed request's WebCrypto settles.
  h.idle = async () => {
    const until = Date.now() + 5_000;
    while (Date.now() < until) {
      await new Promise((r) => setImmediate(r));
      if (running.size === 0) return;
    }
    throw new Error('still running');
  };
  h.mountFront = () => document.getElementById('app')!.replaceChildren(h.section.frontView());
  h.mountApp = (scope = homeScope()) => document.getElementById('app')!.replaceChildren(h.section.appView(scope));
  return h;
}

async function verified(call: Call): Promise<boolean> {
  const header = decodeHomeIdentity(call.header as string);
  if (!header) return false;
  const key = await crypto.subtle.importKey('raw', header.key as BufferSource, { name: 'Ed25519' }, false, ['verify']);
  const body = call.body === null ? new Uint8Array(0) : new TextEncoder().encode(call.body);
  const message = homeMessage({ signer: ENV.signer, counter: header.counter, method: call.method, path: call.url.pathname + call.url.search, body });
  return crypto.subtle.verify({ name: 'Ed25519' }, key, header.sig as BufferSource, message as BufferSource);
}

const text = (id: string): string => document.getElementById(id)?.textContent ?? '';
const input = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement;
const posts = (h: Harness): Call[] => h.calls.filter((c) => c.method === 'POST');
const headings = (): string[] => [...document.querySelectorAll('#app h1, #app h2, #app h3, #app h4')].map((x) => x.textContent ?? '');

/** The front page, opened. */
async function front(answer: Record<string, unknown> = profile()): Promise<Harness> {
  const h = await start();
  h.mountFront();
  h.answer = () => json(200, answer);
  h.click('home-profile-show');
  await h.idle();
  return h;
}

/** An app's page, opened, with `shared` for each app asked about. */
async function appPage(o: { shared?: boolean; name?: unknown; scope?: HomeScope } = {}): Promise<Harness> {
  const h = await start();
  h.mountApp(o.scope);
  h.answer = (url) => json(200, profile({ name: o.name === undefined ? ADA : o.name, app: { appId: url.searchParams.get('appId'), shared: o.shared ?? false } }));
  h.click('home-app-profile-show');
  await h.idle();
  return h;
}

beforeEach(() => {
  resetDom();
  delete (window as unknown as Record<string, unknown>).__pwned;
});
afterEach(() => vi.restoreAllMocks());

describe('the calls', () => {
  it('GET /v1/home/profile and ?appId= are signed by the Home identity, with no body', async () => {
    const h = await start();
    const api = homeProfileApi(ENV.apiUrl, (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      h.calls.push({ url, method: init?.method ?? 'GET', header: new Headers(init?.headers).get('x-hana-home'), body: null });
      expect(init?.credentials).toBe('omit');
      expect(init?.cache).toBe('no-store');
      return json(200, profile({ app: url.searchParams.has('appId') ? { appId: 'app_sodax1', shared: true } : null }));
    }) as typeof fetch);
    expect(await api.profile(h.identity as HomeIdentity)).toEqual({ name: ADA, shares: [], more: false, app: null });
    expect(await api.profile(h.identity as HomeIdentity, 'app_sodax1')).toEqual({ name: ADA, shares: [], more: false, app: { appId: 'app_sodax1', shared: true } });
    expect(h.calls.map((c) => `${c.method} ${c.url.pathname}${c.url.search}`)).toEqual(['GET /v1/home/profile', 'GET /v1/home/profile?appId=app_sodax1']);
    for (const c of h.calls) expect(await verified(c)).toBe(true);
    // Never an app id the API wouldn't take.
    await expect(api.profile(h.identity as HomeIdentity, 'app_ x')).rejects.toThrow();
    expect(h.calls).toHaveLength(2);
  });

  it('POST /v1/home/profile and /v1/home/name-sharing send exactly the API’s bodies, signed over the bytes sent', async () => {
    const h = await start();
    const api = homeProfileApi(ENV.apiUrl, (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const call: Call = { url, method: init?.method ?? 'GET', header: new Headers(init?.headers).get('x-hana-home'), body: new TextDecoder().decode(init?.body as Uint8Array) };
      h.calls.push(call);
      expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
      const b = JSON.parse(call.body as string) as Record<string, unknown>;
      if (url.pathname === '/v1/home/profile') return json(200, b.givenName === null && b.familyName === null ? { name: null, stopped: 2 } : { name: b });
      return json(200, b.share ? { shared: true } : { shared: false, stopped: 1 });
    }) as typeof fetch);
    const id = h.identity as HomeIdentity;
    expect(await api.saveName(id, { givenName: 'Ada', familyName: null })).toEqual({ name: { givenName: 'Ada', familyName: null } });
    expect(await api.saveName(id, { givenName: null, familyName: null })).toEqual({ name: null, stopped: 2 });
    expect(await api.shareName(id, 'app_sodax1', true)).toEqual({ shared: true });
    expect(await api.shareName(id, 'app_sodax1', false)).toEqual({ shared: false, stopped: 1 });
    expect(h.calls.map((c) => [c.url.pathname, JSON.parse(c.body as string)])).toEqual([
      ['/v1/home/profile', { givenName: 'Ada', familyName: null }],
      ['/v1/home/profile', { givenName: null, familyName: null }],
      ['/v1/home/name-sharing', { appId: 'app_sodax1', share: true }],
      ['/v1/home/name-sharing', { appId: 'app_sodax1', share: false }],
    ]);
    for (const c of h.calls) expect(await verified(c)).toBe(true);
  });

  it('a body is only ever built from normalized parts', () => {
    expect(homeProfileBody({ givenName: 'Ada', familyName: null })).toBe('{"givenName":"Ada","familyName":null}');
    expect(() => homeProfileBody({ givenName: ' Ada', familyName: null })).toThrow();
    expect(() => homeProfileBody({ givenName: 'x'.repeat(PROFILE_NAME_MAX + 1), familyName: null })).toThrow();
  });

  it('an answer not of the API’s shape is bad_response; a malformed share is dropped; a partner’s name is held to the display rule', async () => {
    expect(() => parseHomeProfile({ name: { givenName: ' Ada ', familyName: null }, shares: [], more: false, app: null })).toThrow('Unexpected');
    expect(() => parseHomeProfile({ name: { givenName: null, familyName: null }, shares: [], more: false, app: null })).toThrow();
    expect(() => parseHomeProfile({ name: 'Ada', shares: [] })).toThrow();
    expect(() => parseHomeProfile({ name: ADA })).toThrow();
    // `app` only for the app asked about, and only a yes or a no.
    expect(() => parseHomeProfile(profile({ app: { appId: 'app_other1', shared: true } }), 'app_sodax1')).toThrow();
    expect(() => parseHomeProfile(profile({ app: { appId: 'app_sodax1', shared: 'yes' } }), 'app_sodax1')).toThrow();
    expect(() => parseHomeProfile(profile({ app: { appId: 'app_sodax1', shared: true } }))).toThrow();
    const p = parseHomeProfile(
      profile({
        shares: [share('app_a1', 'Alpha'), share('app_a1', 'Again'), share('app_ x', 'Bad id'), share('app_b1', 'Bad scope', { scopeId: 'S 1' }), share('app_c1', 'Bad time', { sharedAtMs: -1 }), share('app_d1', 'Swaps‮ on Base'), share('app_e1', 'x'.repeat(80))],
        more: true,
      }),
    );
    expect(p.shares.map((s) => [s.appId, s.name])).toEqual([
      ['app_a1', 'Alpha'],
      ['app_d1', HOME_UNNAMED_APP],
      ['app_e1', `${'x'.repeat(60)}…`],
    ]);
    expect(p.more).toBe(true);
    // No name: nothing is shared, whatever the answer listed.
    const none = parseHomeProfile({ name: null, shares: [share('app_a1', 'Alpha')], more: true, app: { appId: 'app_a1', shared: true } }, 'app_a1');
    expect(none).toEqual({ name: null, shares: [], more: false, app: { appId: 'app_a1', shared: false } });
  });

  it('a write’s answer that isn’t what was asked is bad_response', async () => {
    const h = await start();
    let reply: unknown = {};
    const api = homeProfileApi(ENV.apiUrl, (async () => json(200, reply)) as unknown as typeof fetch);
    const id = h.identity as HomeIdentity;
    for (const r of [{ name: { givenName: 'Bob', familyName: null } }, { name: null }, { name: null, stopped: -1 }, {}]) {
      reply = r;
      await expect(api.saveName(id, { givenName: 'Ada', familyName: null })).rejects.toMatchObject({ code: 'bad_response' });
    }
    reply = { name: { givenName: 'Ada', familyName: null } };
    await expect(api.saveName(id, { givenName: null, familyName: null })).rejects.toMatchObject({ code: 'bad_response' });
    for (const [r, share] of [[{ shared: false, stopped: 0 }, true], [{ shared: true }, false], [{ shared: false }, false]] as const) {
      reply = r;
      await expect(api.shareName(id, 'app_sodax1', share)).rejects.toMatchObject({ code: 'bad_response' });
    }
  });
});

describe('the name rule, before anything is sent', () => {
  it('trims, folds inner spaces and composes; an empty part is not set', () => {
    expect(checkNameDraft('  Ada   Augusta ', '')).toEqual({ ok: true, name: { givenName: 'Ada Augusta', familyName: null }, empty: false });
    expect(checkNameDraft('', '   ')).toEqual({ ok: true, name: { givenName: null, familyName: null }, empty: true });
    expect(checkNameDraft('Zoë', 'Ng')).toEqual({ ok: true, name: { givenName: 'Zoë', familyName: 'Ng' }, empty: false });
  });

  it('refuses a part over 50 characters, on two lines, or with a hidden or direction-changing character; counts characters, not code units', () => {
    expect(checkNameDraft('x'.repeat(PROFILE_NAME_MAX), '')).toMatchObject({ ok: true });
    expect(checkNameDraft('😀'.repeat(PROFILE_NAME_MAX), '')).toMatchObject({ ok: true });
    expect(checkNameDraft('x'.repeat(PROFILE_NAME_MAX + 1), '')).toEqual({ ok: false, bad: ['given'] });
    expect(checkNameDraft('Ada', 'Love\nlace')).toEqual({ ok: false, bad: ['family'] });
    expect(checkNameDraft('A​da', 'Love‮lace')).toEqual({ ok: false, bad: ['given', 'family'] });
  });

  it('the full name is the parts that are set', () => {
    expect(fullName(ADA)).toBe('Ada Lovelace');
    expect(fullName({ givenName: null, familyName: 'Lovelace' })).toBe('Lovelace');
  });
});

describe('the front page', () => {
  it('collapsed: a heading, one sentence and a button; nothing read until the user asks, then one signed GET', async () => {
    const h = await start();
    h.mountFront();
    expect(h.calls).toEqual([]);
    const root = document.getElementById('home-profile')!;
    expect([...root.children].map((c) => c.tagName)).toEqual(['H2', 'P', 'DIV']);
    expect(text('home-profile-title')).toBe(HOME_NAME_TITLE);
    expect(root.querySelector('p')?.textContent).toBe(HOME_NAME_TEXT.frontAbout);
    expect(HOME_NAME_TEXT.frontAbout).toContain('no app gets it until you turn on sharing for that app.');
    expect(HOME_NAME_TEXT.appAbout).toContain('it doesn’t unless you share it.');
    expect(root.querySelectorAll('button')).toHaveLength(1);
    expect(text('home-profile-show')).toBe('Show my name');
    h.answer = () => json(200, profile({ shares: [share('app_sodax1', 'Sodax'), share('app_earn1', 'Earn')] }));
    h.click('home-profile-show');
    await h.idle();
    expect(h.calls.map((c) => `${c.method} ${c.url.pathname}${c.url.search}`)).toEqual(['GET /v1/home/profile']);
    expect(await verified(h.calls[0]!)).toBe(true);
    expect(h.section.front).toBe('ready');
    expect(input('home-name-given').value).toBe('Ada');
    expect(input('home-name-family').value).toBe('Lovelace');
    for (const [id, auto] of [['home-name-given', 'given-name'], ['home-name-family', 'family-name']] as const) {
      expect(input(id).getAttribute('maxlength')).toBe('50');
      expect(input(id).getAttribute('autocomplete')).toBe(auto);
      expect(input(id).hasAttribute('required')).toBe(false);
    }
    expect(document.querySelector('label[for="home-name-given"]')?.textContent).toBe('First name');
    expect(document.querySelector('label[for="home-name-family"]')?.textContent).toBe('Last name');
    expect(text('home-name-help')).toContain('Both are optional');
    expect(text('home-name-help')).toContain('Nothing is shared until you turn it on for an app');
    expect([...document.querySelectorAll('.home-name-share strong')].map((x) => x.textContent)).toEqual(['Sodax', 'Earn']);
    expect(document.getElementById('home-name-remove')).not.toBeNull();
    expect(headings()).toEqual(['Your name', 'Apps you share your name with']);
  });

  it('no name yet: empty inputs, no Remove, no app listed', async () => {
    await front(profile({ name: null }));
    expect(input('home-name-given').value).toBe('');
    expect(document.getElementById('home-name-remove')).toBeNull();
    expect(text('home-name-shares-none')).toBe(HOME_NAME_TEXT.noShares);
    expect(pageText()).toContain(HOME_NAME_TEXT.howToShare);
  });

  it('Save sends the normalized name once, signed, and says who gets it', async () => {
    const h = await front(profile({ name: null }));
    h.type('home-name-given', '  Grace   Brewster ');
    h.type('home-name-family', ' Hopper');
    h.answer = (_url, call) => json(200, { name: JSON.parse(call.body as string) });
    h.submit();
    // A second submit while it's on its way sends nothing more.
    h.submit();
    await h.idle();
    expect(posts(h).map((c) => [c.url.pathname, JSON.parse(c.body as string)])).toEqual([['/v1/home/profile', { givenName: 'Grace Brewster', familyName: 'Hopper' }]]);
    expect(await verified(posts(h)[0]!)).toBe(true);
    expect(input('home-name-given').value).toBe('Grace Brewster');
    expect(text('home-profile-note')).toBe(HOME_NAME_TEXT.savedAlone);
    expect(document.getElementById('home-name-remove')).not.toBeNull();
  });

  it('a saved change with apps sharing it says they get the new one', async () => {
    const h = await front(profile({ shares: [share('app_sodax1', 'Sodax')] }));
    h.type('home-name-given', 'Augusta');
    h.answer = (_url, call) => json(200, { name: JSON.parse(call.body as string) });
    h.click('home-name-save');
    await h.idle();
    expect(JSON.parse(posts(h)[0]!.body as string)).toEqual({ givenName: 'Augusta', familyName: 'Lovelace' });
    expect(text('home-profile-note')).toBe(HOME_NAME_TEXT.savedShared);
  });

  it('a part that fails the rule is marked and nothing is sent', async () => {
    const h = await front();
    h.type('home-name-family', `Love‮lace`);
    h.submit();
    await h.idle();
    expect(posts(h)).toEqual([]);
    expect(input('home-name-family').getAttribute('aria-invalid')).toBe('true');
    expect(input('home-name-family').getAttribute('aria-describedby')).toContain('home-name-family-error');
    expect(text('home-name-family-error')).toBe(HOME_NAME_TEXT.invalid);
    expect(input('home-name-given').hasAttribute('aria-invalid')).toBe(false);
    // What was typed stays, to be fixed.
    expect(input('home-name-family').value).toBe('Love‮lace');
    h.type('home-name-family', 'Lovelace-King');
    h.answer = (_url, call) => json(200, { name: JSON.parse(call.body as string) });
    h.submit();
    await h.idle();
    expect(posts(h)).toHaveLength(1);
    expect(document.getElementById('home-name-family-error')).toBeNull();
  });

  it('nothing to save sends nothing: both empty with no name, or the same name again', async () => {
    const h = await front(profile({ name: null }));
    h.submit();
    expect(text('home-name-form-note')).toBe(HOME_NAME_TEXT.empty);
    resetDom();
    const g = await front();
    g.type('home-name-given', ' Ada ');
    g.submit();
    await g.idle();
    expect(text('home-name-form-note')).toBe(HOME_NAME_TEXT.unchanged);
    expect(posts(h)).toEqual([]);
    expect(posts(g)).toEqual([]);
  });

  it('a click or a submit a script made does nothing', async () => {
    const h = await start({ isGesture: false });
    h.mountFront();
    h.click('home-profile-show');
    await h.idle();
    expect(h.calls).toEqual([]);
    h.gesture = true;
    h.click('home-profile-show');
    await h.idle();
    h.gesture = false;
    h.type('home-name-given', 'Augusta');
    h.submit();
    h.click('home-name-save');
    h.click('home-name-remove');
    await h.idle();
    expect(posts(h)).toEqual([]);
    expect(h.section.confirming).toBe(false);
    h.mountApp();
    h.gesture = true;
    h.answer = () => json(200, profile({ app: { appId: 'app_sodax1', shared: false } }));
    h.click('home-app-profile-show');
    await h.idle();
    h.gesture = false;
    h.click('home-app-name-share-app_sodax1');
    await h.idle();
    expect(posts(h)).toEqual([]);
  });
});

describe('Remove my name', () => {
  it('asks first, saying it stops sharing with every app; Cancel sends nothing; Remove sends both parts empty once', async () => {
    const h = await front(profile({ shares: [share('app_sodax1', 'Sodax')] }));
    h.click('home-name-remove');
    expect(h.section.confirming).toBe(true);
    const panel = document.getElementById('home-name-remove-confirm')!;
    expect(panel.querySelector('.home-confirm-title')?.textContent).toBe(HOME_NAME_REMOVE_CONFIRM.title);
    expect([...panel.querySelectorAll('li')].map((li) => li.textContent)).toEqual([...HOME_NAME_REMOVE_CONFIRM.points]);
    expect(HOME_NAME_REMOVE_CONFIRM.points[0]).toContain('stops sharing your name with every app');
    // Save waits while the question is open.
    expect(document.getElementById('home-name-save')?.hasAttribute('disabled')).toBe(true);
    h.click('home-name-remove-confirm-cancel');
    expect(h.section.confirming).toBe(false);
    expect(posts(h)).toEqual([]);

    h.click('home-name-remove');
    h.answer = () => json(200, { name: null, stopped: 1 });
    h.click('home-name-remove-confirm-go');
    document.getElementById('home-name-remove-confirm-go')?.click();
    await h.idle();
    expect(posts(h).map((c) => [c.url.pathname, JSON.parse(c.body as string)])).toEqual([['/v1/home/profile', { givenName: null, familyName: null }]]);
    expect(await verified(posts(h)[0]!)).toBe(true);
    expect(text('home-profile-note')).toBe(HOME_NAME_TEXT.removed);
    expect(input('home-name-given').value).toBe('');
    expect(input('home-name-family').value).toBe('');
    expect(document.querySelector('.home-name-share')).toBeNull();
    expect(document.getElementById('home-name-remove')).toBeNull();
  });

  it('saving both parts empty while a name is set is a removal: it asks first', async () => {
    const h = await front();
    h.type('home-name-given', ' ');
    h.type('home-name-family', '');
    h.submit();
    expect(h.section.confirming).toBe(true);
    expect(posts(h)).toEqual([]);
  });
});

describe('sharing per app', () => {
  it('the app page: collapsed until asked, then one signed GET ?appId= per app; Share, then Stop, each one signed POST', async () => {
    const h = await start();
    h.mountApp();
    expect(h.calls).toEqual([]);
    const root = document.getElementById('home-app-profile')!;
    expect([...root.children].map((c) => c.tagName)).toEqual(['H3', 'P', 'DIV']);
    expect(text('home-app-profile-title')).toBe(HOME_NAME_TITLE);
    h.answer = () => json(200, profile({ app: { appId: 'app_sodax1', shared: false } }));
    h.click('home-app-profile-show');
    await h.idle();
    expect(h.calls.map((c) => `${c.method} ${c.url.pathname}${c.url.search}`)).toEqual(['GET /v1/home/profile?appId=app_sodax1']);
    expect(await verified(h.calls[0]!)).toBe(true);
    expect(document.querySelector('#home-app-name-current .home-name-value')?.textContent).toBe('Ada Lovelace');
    expect(document.querySelector('.home-name-app .badge')?.textContent).toBe('Not shared');
    expect(text('home-app-name-share-app_sodax1')).toBe('Share my name with Sodax');

    h.answer = () => json(200, { shared: true });
    h.click('home-app-name-share-app_sodax1');
    document.getElementById('home-app-name-share-app_sodax1')?.click();
    await h.idle();
    expect(posts(h).map((c) => JSON.parse(c.body as string))).toEqual([{ appId: 'app_sodax1', share: true }]);
    expect(await verified(posts(h)[0]!)).toBe(true);
    expect(document.querySelector('.home-name-app .badge')?.textContent).toBe('Shared');
    expect(text('home-app-profile-note-app_sodax1')).toBe('Shared. Sodax gets your name with its next sign-in.');
    expect(text('home-app-name-stop-app_sodax1')).toBe('Stop sharing my name');

    h.answer = () => json(200, { shared: false, stopped: 1 });
    h.click('home-app-name-stop-app_sodax1');
    await h.idle();
    expect(posts(h).map((c) => JSON.parse(c.body as string))).toEqual([
      { appId: 'app_sodax1', share: true },
      { appId: 'app_sodax1', share: false },
    ]);
    expect(document.querySelector('.home-name-app .badge')?.textContent).toBe('Not shared');
    expect(text('home-app-profile-note-app_sodax1')).toContain('Stopped sharing your name with Sodax.');
    expect(text('home-app-profile-note-app_sodax1')).toContain('up to an hour');
    expect(document.getElementById('home-app-name-share-app_sodax1')).not.toBeNull();
  });

  it('a listing of several apps asks about each, one control each; a deleted app is not asked about', async () => {
    const scope = homeScope(S1, [
      { appId: 'app_sodax1', name: 'Sodax' },
      { appId: 'app_earn1', name: 'Earn' },
      { appId: 'app_gone1', name: 'Gone', status: 'deleted' },
    ]);
    const h = await appPage({ scope, shared: false });
    expect(h.calls.map((c) => c.url.searchParams.get('appId'))).toEqual(['app_sodax1', 'app_earn1']);
    expect([...document.querySelectorAll('.home-name-app')].map((x) => x.getAttribute('data-app'))).toEqual(['app_sodax1', 'app_earn1', 'app_gone1']);
    expect(text('home-app-name-share-app_earn1')).toBe(shareLabel('Earn'));
    expect(document.querySelector('.home-name-app[data-app="app_gone1"]')?.textContent).toContain(HOME_NAME_TEXT.deleted);
    expect(document.querySelector('.home-name-app[data-app="app_gone1"] button')).toBeNull();
  });

  it('an app already shared offers Stop sharing my name', async () => {
    await appPage({ shared: true });
    expect(document.querySelector('.home-name-app .badge')?.textContent).toBe('Shared');
    expect(document.getElementById('home-app-name-stop-app_sodax1')).not.toBeNull();
    expect(document.getElementById('home-app-name-share-app_sodax1')).toBeNull();
  });

  it('no name yet: says to set one first, and offers no share', async () => {
    await appPage({ name: null });
    expect(text('home-app-name-none')).toBe(HOME_NAME_TEXT.noName);
    expect(document.querySelector('.home-name-app button')).toBeNull();
  });

  it('an app Hana can’t share a name with (the answer’s app is null) says so, with no control', async () => {
    const h = await start();
    h.mountApp();
    h.answer = () => json(200, profile());
    h.click('home-app-profile-show');
    await h.idle();
    expect(document.querySelector('.home-name-app')?.textContent).toContain(HOME_NAME_TEXT.cantShare);
    expect(document.querySelector('.home-name-app button')).toBeNull();
  });

  it('a 409 no_profile_name (the name was removed elsewhere) says to set one first, and the share is gone', async () => {
    const h = await appPage();
    h.answer = () => refusal(409, 'no_profile_name');
    h.click('home-app-name-share-app_sodax1');
    await h.idle();
    expect(text('home-profile-problem-app')).toContain('Set your name first');
    expect(text('home-app-name-none')).toBe(HOME_NAME_TEXT.noName);
    expect(document.getElementById('home-app-name-share-app_sodax1')).toBeNull();
    expect(posts(h)).toHaveLength(1);
  });

  it('Stop sharing on the front page: one POST, the app leaves the list, the sentence names it as text', async () => {
    const h = await front(profile({ shares: [share('app_sodax1', 'Sodax'), share('app_earn1', 'Earn')] }));
    h.answer = () => json(200, { shared: false, stopped: 1 });
    h.click('home-name-stop-app_sodax1');
    await h.idle();
    expect(posts(h).map((c) => [c.url.pathname, JSON.parse(c.body as string)])).toEqual([['/v1/home/name-sharing', { appId: 'app_sodax1', share: false }]]);
    expect([...document.querySelectorAll('.home-name-share')].map((x) => x.getAttribute('data-app'))).toEqual(['app_earn1']);
    expect(text('home-profile-note')).toContain('Stopped sharing your name with Sodax.');
    expect(document.querySelector('#home-profile-note strong')?.textContent).toBe('Sodax');
  });

  it('a stop that had already happened says so', async () => {
    const h = await front(profile({ shares: [share('app_sodax1', 'Sodax')] }));
    h.answer = () => json(200, { shared: false, stopped: 0 });
    h.click('home-name-stop-app_sodax1');
    await h.idle();
    expect(text('home-profile-note')).toBe('Your name was no longer shared with Sodax.');
  });

  it('what one view changes, the other shows: a share on the app page joins the front list, a removal ends the app’s share', async () => {
    const h = await front(profile({ shares: [] }));
    h.mountApp();
    h.answer = () => json(200, profile({ app: { appId: 'app_sodax1', shared: false } }));
    h.click('home-app-profile-show');
    await h.idle();
    h.answer = () => json(200, { shared: true });
    h.click('home-app-name-share-app_sodax1');
    await h.idle();
    h.mountFront();
    expect([...document.querySelectorAll('.home-name-share strong')].map((x) => x.textContent)).toEqual(['Sodax']);
    h.click('home-name-remove');
    h.answer = () => json(200, { name: null, stopped: 1 });
    h.click('home-name-remove-confirm-go');
    await h.idle();
    h.mountApp();
    expect(text('home-app-name-none')).toBe(HOME_NAME_TEXT.noName);
    expect(document.querySelector('.home-name-app .badge')?.textContent).toBe('Not shared');
    expect(document.querySelector('.home-name-app button')).toBeNull();
  });

  it('another app’s page starts closed again and asks nothing by itself; leaving closes it', async () => {
    const h = await appPage();
    h.mountApp(homeScope('s2', [{ appId: 'app_other1', name: 'Other' }]));
    expect(document.getElementById('home-app-profile-show')).not.toBeNull();
    expect(h.calls).toHaveLength(1);
    h.section.leaveApp();
    expect(h.section.app).toBe('closed');
  });
});

describe('refusals and the end of the sign-in', () => {
  it.each([
    [400, 'bad_name', 'Each name can be up to 50 characters'],
    [503, 'profile_unavailable', 'Names aren’t available in Hana Home yet.'],
    [503, 'home_directory_unavailable', 'Hana Home is not reachable right now.'],
    [429, 'rate_limited', 'Too many requests.'],
  ])('Save refused with %i %s reads as Hana’s sentence, keeps what was typed, and is not sent again', async (status, code, sentence) => {
    const h = await front();
    h.type('home-name-given', 'Augusta');
    h.answer = () => refusal(status, code);
    h.submit();
    await h.idle();
    expect(text('home-profile-problem-front')).toContain(sentence);
    expect(text('home-profile-problem-front')).toContain(`Code: ${code}`);
    expect(text('home-profile-problem-front')).toContain('Request: req_9');
    expect(pageText()).not.toContain('internal words');
    expect(h.section.errorCode).toBe(code);
    expect(input('home-name-given').value).toBe('Augusta');
    await h.idle();
    expect(posts(h)).toHaveLength(1);
  });

  it.each([
    [404, 'unknown_app', 'Hana doesn’t list it now.'],
    [503, 'near_unavailable', 'Hana Home is not reachable right now.'],
    [503, 'name_sharing_unavailable', 'Hana Home can’t change name sharing right now.'],
    [503, 'profile_unavailable', 'Names aren’t available in Hana Home yet.'],
  ])('a share refused with %i %s reads as Hana’s sentence, and the app stays as it was', async (status, code, sentence) => {
    const h = await appPage();
    h.answer = () => refusal(status, code);
    h.click('home-app-name-share-app_sodax1');
    await h.idle();
    expect(text('home-profile-problem-app')).toContain(sentence);
    expect(pageText()).not.toContain('internal words');
    expect(document.querySelector('.home-name-app .badge')?.textContent).toBe('Not shared');
    expect(posts(h)).toHaveLength(1);
  });

  it('a refused read leaves the section closed with the problem, and only a click reads again', async () => {
    const h = await start();
    h.mountFront();
    h.answer = () => refusal(503, 'profile_unavailable');
    h.click('home-profile-show');
    await h.idle();
    expect(h.section.front).toBe('closed');
    expect(text('home-profile-problem-front')).toContain('Names aren’t available in Hana Home yet.');
    await h.idle();
    expect(h.calls).toHaveLength(1);
  });

  it('a 401 ends the Home sign-in: the page is told, what is on screen stays, and nothing more is sent', async () => {
    const h = await front(profile({ shares: [share('app_sodax1', 'Sodax')] }));
    h.answer = () => refusal(401, 'home_identity_expired');
    h.click('home-name-stop-app_sodax1');
    await h.idle();
    expect(h.signedOut).toBe(1);
    expect(text('home-profile-problem-front')).toContain('Your sign-in to Hana Home has ended.');
    expect(document.querySelector('.home-name-share')).not.toBeNull();
    const sent = h.calls.length;
    h.click('home-name-stop-app_sodax1');
    h.type('home-name-given', 'Augusta');
    h.submit();
    h.click('home-profile-refresh');
    await h.idle();
    expect(h.calls).toHaveLength(sent);
  });

  it('with no usable sign-in a click sends nothing and asks for a new sign-in', async () => {
    const h = await start();
    h.identity = null;
    h.mountFront();
    h.click('home-profile-show');
    await h.idle();
    expect(h.calls).toEqual([]);
    expect(text('home-profile-problem-front')).toContain('Your sign-in to Hana Home has ended.');
  });

  it('reset (sign-out, another account) drops the name, the drafts and both views; an answer on its way shows nothing', async () => {
    const h = await front();
    h.type('home-name-given', 'Typed but not saved');
    let release: (r: Response) => void = () => {};
    h.answer = () => new Promise<Response>((r) => (release = r));
    h.submit();
    for (const until = Date.now() + 5_000; posts(h).length === 0 && Date.now() < until; ) await new Promise((r) => setImmediate(r));
    expect(posts(h)).toHaveLength(1);
    h.section.reset();
    release(json(200, { name: { givenName: 'Typed but not saved', familyName: 'Lovelace' } }));
    await h.idle();
    expect(h.section.front).toBe('closed');
    expect(h.section.app).toBe('closed');
    expect(document.getElementById('home-name-given')).toBeNull();
    expect(document.getElementById('home-profile-show')).not.toBeNull();
    expect(document.documentElement.outerHTML).not.toContain('Lovelace');
    expect(document.documentElement.outerHTML).not.toContain('Typed but not saved');
    // Opened again, it reads again; nothing typed before is there.
    h.answer = () => json(200, profile({ name: null }));
    h.click('home-profile-show');
    await h.idle();
    expect(input('home-name-given').value).toBe('');
  });
});

describe('names are text only', () => {
  it('the user’s name and the apps’ names never become markup, on either page or in a button', async () => {
    const name = { givenName: XSS_NAME, familyName: '<b>Lovelace</b>' };
    const h = await front(profile({ name, shares: [share('app_sodax1', XSS_APP)] }));
    expect(input('home-name-given').value).toBe(XSS_NAME);
    expect(document.querySelector('.home-name-share strong')?.textContent).toBe(`${'<img src=x onerror="__pwned=1"><script>__pwned=1</script>'}`);
    h.mountApp(homeScope(S1, [{ appId: 'app_sodax1', name: XSS_APP }]));
    h.answer = () => json(200, profile({ name, app: { appId: 'app_sodax1', shared: false } }));
    h.click('home-app-profile-show');
    await h.idle();
    expect(document.querySelector('.home-name-value')?.textContent).toBe(`${XSS_NAME} <b>Lovelace</b>`);
    expect(text('home-app-name-share-app_sodax1')).toBe(shareLabel(XSS_APP));
    expect(document.querySelector('#app script, #app img, #app b')).toBeNull();
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
    // Never a heading either: the headings are Hana's own words.
    expect(headings()).toEqual(['Your name']);
  });
});
