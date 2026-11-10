// @vitest-environment happy-dom
// Hana Home's "Devices and auto-approve" (home-devices.ts, docs/hana-home-spec.md F5): the list on request, each stop
// behind its confirmation and sent once on a real click, signed with the Home identity, the honest sentences of what a
// stop does, partner strings as text only, every refusal's sentence, the end of the sign-in, and `?view=devices`.
import { decodeHomeIdentity, homeMessage } from '@hana-id/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dom, originText } from '../../src/auth/dom.ts';
import { HOME_UNNAMED_RULE, type HomeIdentity, homeDevicesApi, homeDevicesSearch, homePolicyLabel, homeStopBody, newHomeIdentity, parseHomeDevices } from '../../src/auth/home-api.ts';
import { HOME_STOP_CONFIRM, type HomeDevices, UNNAMED_DEVICE, devicesLinked, startHomeDevices, stopDoneText } from '../../src/auth/home-devices.ts';
import type { HomeScope } from '../../src/auth/home-api.ts';
import { ENV, FakeWindow, pageText, resetDom } from './helpers.ts';

const T0 = 1_800_000_000_000;
const XSS = '<img src=x onerror="__pwned=1"><script>__pwned=1</script>';
const ID = (n: number): string => `${String(n).padStart(2, '0')}${'A'.repeat(20)}`;

const json = (status: number, body: unknown, requestId = 'req_1'): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-request-id': requestId } });
const refusal = (status: number, code: string, error = 'internal words'): Response => json(status, { error, code, requestId: 'req_9' }, 'req_9');

const device = (n: number, over: Record<string, unknown> = {}) => ({
  shareId: ID(n),
  appId: 'app_sodax1',
  partnerOrigin: 'https://sodax.example',
  label: 'Chrome on macOS',
  signedInAtMs: T0 - 3_600_000,
  lastUsedAtMs: T0 - 600_000,
  idleUntilMs: T0 + 6_600_000,
  expiresAtMs: T0 + 39_600_000,
  consent: null,
  ...over,
});
const consent = (n: number, label = 'Swaps on Base') => ({ consentId: ID(n), label, grantedAtMs: T0 - 1_800_000, expiresAtMs: T0 + 1_800_000 });
const scopeOf = (scopeId: string, over: Record<string, unknown> = {}) => ({
  scopeId,
  apps: [{ appId: 'app_sodax1', name: 'Sodax', status: 'active' }],
  devices: [],
  consents: [],
  email: [],
  more: false,
  canStop: true,
  ...over,
});

interface Call {
  url: URL;
  method: string;
  header: string | null;
  body: string | null;
}

interface Harness {
  win: FakeWindow;
  devices: HomeDevices;
  calls: Call[];
  answer: (url: URL, call: Call) => Response | Promise<Response>;
  identity: HomeIdentity | null;
  signedOut: number;
  click(id: string): void;
  idle(): Promise<void>;
  mountFront(): void;
  mountApp(scopeId?: string): void;
}

const homeScope = (scopeId: string): HomeScope => ({ scopeId, mine: true, coverage: 'shared', googleClientId: null, supportId: null, addresses: [], apps: [{ appId: 'app_sodax1', name: 'Sodax', status: 'active', environment: 'live', origins: [], logoUrl: null }] });

async function start(o: { search?: string; isGesture?: boolean } = {}): Promise<Harness> {
  const win = new FakeWindow('/home', o.search ?? '');
  const calls: Call[] = [];
  const running = new Set<Promise<unknown>>();
  const identity = await newHomeIdentity(ENV.signer, T0);
  identity.attach('header.payload.signature');
  const h = {
    win,
    calls,
    identity,
    signedOut: 0,
    answer: (_url: URL): Response | Promise<Response> => json(200, { scopes: [], nextCursor: null }),
  } as unknown as Harness;
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = { url, method: init?.method ?? 'GET', header: new Headers(init?.headers).get('x-hana-home'), body: init?.body ? new TextDecoder().decode(init.body as Uint8Array) : null };
    calls.push(call);
    return h.answer(url, call);
  });
  h.devices = startHomeDevices({
    win,
    d: dom(document),
    api: homeDevicesApi(ENV.apiUrl, fetchFn as unknown as typeof fetch),
    isGesture: () => o.isGesture !== false,
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
    appName: (appId) => (appId === 'app_other1' ? 'Other from the list' : null),
  });
  h.click = (id) => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`No #${id} on the page: ${pageText()}`);
    (el as HTMLElement).click();
  };
  h.idle = async () => {
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setImmediate(r));
      if (running.size === 0) return;
    }
    throw new Error('still running');
  };
  h.mountFront = () => document.getElementById('app')!.replaceChildren(h.devices.frontView());
  h.mountApp = (scopeId = 's1') => document.getElementById('app')!.replaceChildren(h.devices.appView(homeScope(scopeId)));
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

beforeEach(() => {
  resetDom();
  delete (window as unknown as Record<string, unknown>).__pwned;
});
afterEach(() => vi.restoreAllMocks());

describe('the list', () => {
  it('reads nothing until the user asks, then one signed GET /v1/home/devices', async () => {
    const h = await start();
    h.mountFront();
    expect(h.calls).toEqual([]);
    expect(text('home-devices-title')).toBe('Devices and auto-approve');
    h.answer = () => json(200, { scopes: [scopeOf('s1', { devices: [device(1, { consent: consent(9) }), device(2, { label: null })] })], nextCursor: null });
    h.click('home-devices-show');
    await h.idle();
    expect(h.calls.map((c) => `${c.method} ${c.url.pathname}${c.url.search}`)).toEqual(['GET /v1/home/devices']);
    expect(await verified(h.calls[0]!)).toBe(true);
    expect(h.devices.front).toBe('ready');
    const items = [...document.querySelectorAll('#home-devices .home-device')];
    expect(items).toHaveLength(2);
    expect(items[0]!.querySelector('.home-device-name')?.textContent).toBe('Chrome on macOS on https://sodax.example');
    expect(items[0]!.textContent).toContain('Auto-approve on');
    expect(items[0]!.querySelector('.home-policy-label')?.textContent).toBe('Swaps on Base');
    expect(items[0]!.textContent).toContain('Signed in');
    expect(items[0]!.textContent).toContain('Last opened or approved here');
    expect(pageText()).toContain('doesn’t count requests the app signed by itself');
    expect(items[0]!.textContent).toContain('if it isn’t used before then');
    expect(items[1]!.querySelector('.home-device-name strong')?.textContent).toBe(UNNAMED_DEVICE);
    expect(items[1]!.textContent).toContain('Auto-approve is off: this device asks you to approve every request.');
    // Which app: the partner's name in the neutral box, never a heading.
    expect(document.querySelector('.home-devices-apps strong')?.textContent).toBe('Sodax');
    expect([...document.querySelectorAll('#app h1, #app h2, #app h3, #app h4')].map((x) => x.textContent)).toEqual(['Devices and auto-approve']);
  });

  it('the app page asks for its one scope', async () => {
    const h = await start();
    h.mountApp('s7');
    h.answer = () => json(200, { scopes: [scopeOf('s7')], nextCursor: null });
    h.click('home-app-devices-show');
    await h.idle();
    expect(h.calls[0]!.url.search).toBe('?scopeId=s7');
    expect(text('home-app-devices-empty')).toBe('No device is signed in to this app with Hana right now.');
    expect(text('home-email-none')).toBe('You aren’t sharing your email address with this app.');
    // Another app's page starts closed again, and asks nothing on its own.
    h.mountApp('s8');
    expect(document.getElementById('home-app-devices-show')).not.toBeNull();
    expect(h.calls).toHaveLength(1);
  });

  it('empty: says so, and that only apps Hana has on record are listed', async () => {
    const h = await start();
    h.mountFront();
    h.answer = () => json(200, { scopes: [scopeOf('s1'), scopeOf('s2')], nextCursor: null });
    h.click('home-devices-show');
    await h.idle();
    expect(text('home-devices-empty')).toContain('No device is signed in to your apps with Hana right now');
    expect(pageText()).toContain('Only apps Hana has on record for you are listed here.');
  });

  it('pages with Show more; the next page is added, never repeated', async () => {
    const h = await start();
    h.mountFront();
    h.answer = (url) =>
      url.searchParams.get('cursor') === 's1'
        ? json(200, { scopes: [scopeOf('s2', { devices: [device(2)] }), scopeOf('s1', { devices: [device(1)] })], nextCursor: null })
        : json(200, { scopes: [scopeOf('s1', { devices: [device(1)] })], nextCursor: 's1' });
    h.click('home-devices-show');
    await h.idle();
    h.click('home-devices-more');
    await h.idle();
    expect(h.calls.map((c) => c.url.search)).toEqual(['', '?cursor=s1']);
    expect([...document.querySelectorAll('#home-devices .home-devices-group')].map((g) => g.getAttribute('data-scope'))).toEqual(['s1', 's2']);
    expect(document.getElementById('home-devices-more')).toBeNull();
  });

  it('a capped scope says only the most recent are shown', async () => {
    const h = await start();
    h.mountFront();
    h.answer = () => json(200, { scopes: [scopeOf('s1', { devices: [device(1)], more: true })], nextCursor: null });
    h.click('home-devices-show');
    await h.idle();
    expect(pageText()).toContain('Hana Home shows the 25 most recent here; others are signed in too.');
  });

  it('a consent of an app that keeps no sign-in reads as an open tab', async () => {
    const h = await start();
    h.mountFront();
    h.answer = () => json(200, { scopes: [scopeOf('s1', { consents: [{ ...consent(3), appId: 'app_sodax1', partnerOrigin: 'https://sodax.example' }] })], nextCursor: null });
    h.click('home-devices-show');
    await h.idle();
    expect(pageText()).toContain('A tab (may be closed) on https://sodax.example');
    expect(pageText()).toContain('the tab is signed out when it closes');
    expect(document.getElementById(`home-stop-consent-front-${ID(3)}`)).not.toBeNull();
  });
});

describe('the stops', () => {
  async function listed(over: Record<string, unknown> = {}): Promise<Harness> {
    const h = await start();
    h.mountFront();
    h.answer = () => json(200, { scopes: [scopeOf('s1', { devices: [device(1, { consent: consent(9) })], email: [{ appId: 'app_sodax1', addresses: ['ada@example.com'] }], ...over })], nextCursor: null });
    h.click('home-devices-show');
    await h.idle();
    return h;
  }

  it.each([
    ['share', `home-stop-share-front-${ID(1)}`, '/v1/home/shares/revoke', { shareId: ID(1) }],
    ['consent', `home-stop-consent-front-${ID(9)}`, '/v1/home/consents/revoke', { consentId: ID(9) }],
    ['email', 'home-stop-email-front-s1-app_sodax1', '/v1/home/email-sharing/revoke', { appId: 'app_sodax1' }],
  ] as const)('%s: asks first, with what it does and doesn’t; Cancel sends nothing; the stop is one signed POST', async (kind, button, path, body) => {
    const h = await listed();
    h.click(button);
    expect(h.devices.confirming).not.toBeNull();
    const panel = document.getElementById(`${button}-confirm`)!;
    expect(panel.querySelector('.home-confirm-title')?.textContent).toBe(HOME_STOP_CONFIRM[kind].title);
    expect([...panel.querySelectorAll(':scope > ul > li')].map((li) => li.textContent)).toEqual([...HOME_STOP_CONFIRM[kind].points]);
    expect(HOME_STOP_CONFIRM[kind].points.length).toBeLessThanOrEqual(3);
    // The full detail, where there is more, sits in a closed native disclosure.
    const more = panel.querySelector('details');
    if (HOME_STOP_CONFIRM[kind].more) {
      expect(more?.hasAttribute('open')).toBe(false);
      expect(more?.querySelector('summary')?.textContent).toBe('More');
      expect([...(more?.querySelectorAll('li') ?? [])].map((li) => li.textContent)).toEqual([...(HOME_STOP_CONFIRM[kind].more ?? [])]);
    } else expect(more).toBeNull();
    h.click(`${button}-confirm-cancel`);
    expect(h.devices.confirming).toBeNull();
    expect(h.calls).toHaveLength(1);

    h.click(button);
    h.answer = () => json(200, kind === 'email' ? { state: 'declined', revoked: 1 } : { revoked: true });
    h.click(`${button}-confirm-go`);
    // A second click while it's on its way sends nothing more.
    document.getElementById(`${button}-confirm-go`)?.click();
    await h.idle();
    const stops = h.calls.filter((c) => c.method === 'POST');
    expect(stops.map((c) => c.url.pathname)).toEqual([path]);
    expect(JSON.parse(stops[0]!.body as string)).toEqual(body);
    expect(await verified(stops[0]!)).toBe(true);
    expect(text('home-devices-note-front-s1')).toBe(stopDoneText(kind, true));
  });

  it('after Sign out the device is gone; after Stop auto-approving it stays, with auto-approve off; after Stop sharing the line is gone', async () => {
    const h = await listed();
    h.answer = () => json(200, { revoked: true });
    h.click(`home-stop-consent-front-${ID(9)}`);
    h.click(`home-stop-consent-front-${ID(9)}-confirm-go`);
    await h.idle();
    expect(document.querySelectorAll('#home-devices .home-device')).toHaveLength(1);
    expect(pageText()).toContain('Auto-approve is off');
    h.click('home-stop-email-front-s1-app_sodax1');
    h.answer = () => json(200, { state: 'declined', revoked: 1 });
    h.click('home-stop-email-front-s1-app_sodax1-confirm-go');
    await h.idle();
    expect(document.querySelector('.home-email')).toBeNull();
    h.click(`home-stop-share-front-${ID(1)}`);
    h.answer = () => json(200, { revoked: true });
    h.click(`home-stop-share-front-${ID(1)}-confirm-go`);
    await h.idle();
    expect(document.querySelectorAll('#home-devices .home-device')).toHaveLength(0);
    expect(text('home-devices-note-front-s1')).toBe(stopDoneText('share', true));
  });

  it('a stop that had already happened says so', async () => {
    const h = await listed();
    h.answer = () => json(200, { revoked: false });
    h.click(`home-stop-share-front-${ID(1)}`);
    h.click(`home-stop-share-front-${ID(1)}-confirm-go`);
    await h.idle();
    expect(text('home-devices-note-front-s1')).toBe('That device was already signed out.');
  });

  it.each([
    [404, 'unknown_share', 'Hana Home couldn’t find that device among yours'],
    [404, 'unknown_consent', 'Hana Home couldn’t find that auto-approve among yours'],
    [404, 'unknown_email_share', 'Hana Home found nothing you share with that app.'],
    [503, 'email_sharing_unavailable', 'Hana Home can’t change email sharing right now.'],
    [429, 'rate_limited', 'Too many requests. Wait a minute and try again.'],
    [503, 'home_directory_unavailable', 'Hana Home is not reachable right now.'],
    [400, 'bad_request', 'Hana Home couldn’t read that request.'],
  ])('a %i %s reads as Hana’s sentence, never the API’s words, and nothing is retried', async (status, code, sentence) => {
    const h = await listed();
    h.answer = () => refusal(status, code);
    h.click(`home-stop-share-front-${ID(1)}`);
    h.click(`home-stop-share-front-${ID(1)}-confirm-go`);
    await h.idle();
    expect(text('home-devices-problem-front')).toContain(sentence);
    expect(text('home-devices-problem-front')).toContain(`Code: ${code}`);
    expect(text('home-devices-problem-front')).toContain('Request: req_9');
    expect(pageText()).not.toContain('internal words');
    expect(h.devices.errorCode).toBe(code);
    // The device stays listed, and the page sends nothing more by itself.
    expect(document.querySelectorAll('#home-devices .home-device')).toHaveLength(1);
    await h.idle();
    expect(h.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('a 401 ends the Home sign-in: the page is told, the list stays, and nothing more is sent', async () => {
    const h = await listed();
    h.answer = () => refusal(401, 'home_identity_expired');
    h.click(`home-stop-share-front-${ID(1)}`);
    h.click(`home-stop-share-front-${ID(1)}-confirm-go`);
    await h.idle();
    expect(h.signedOut).toBe(1);
    expect(text('home-devices-problem-front')).toContain('Your sign-in to Hana Home has ended.');
    expect(document.querySelectorAll('#home-devices .home-device')).toHaveLength(1);
    const sent = h.calls.length;
    h.click(`home-stop-share-front-${ID(1)}`);
    h.click(`home-stop-share-front-${ID(1)}-confirm-go`);
    h.click('home-devices-refresh');
    await h.idle();
    expect(h.calls).toHaveLength(sent);
  });

  it('a click that isn’t the user’s does nothing', async () => {
    const h = await start({ isGesture: false });
    h.mountFront();
    h.click('home-devices-show');
    await h.idle();
    expect(h.calls).toEqual([]);
  });

  it('a stop sent before a reset (another account) shows nothing when it answers', async () => {
    const h = await listed();
    let release: (r: Response) => void = () => {};
    h.answer = () => new Promise<Response>((r) => (release = r));
    h.click(`home-stop-share-front-${ID(1)}`);
    h.click(`home-stop-share-front-${ID(1)}-confirm-go`);
    for (let i = 0; i < 100 && !h.calls.some((c) => c.method === 'POST'); i++) await new Promise((r) => setImmediate(r));
    h.devices.reset();
    release(json(200, { revoked: true }));
    await h.idle();
    expect(h.devices.front).toBe('closed');
    expect(document.querySelector('.home-devices-note')).toBeNull();
    expect(document.getElementById('home-devices-show')).not.toBeNull();
  });
});

describe('an account Hana couldn’t confirm (D661)', () => {
  it('lists its devices with no stop and says why; a missing canStop offers none either', async () => {
    for (const over of [{ canStop: false }, { canStop: undefined }]) {
      resetDom();
      const h = await start();
      h.mountFront();
      h.answer = () => json(200, { scopes: [scopeOf('s1', { devices: [device(1, { consent: consent(9) })], email: null, ...over })], nextCursor: null });
      h.click('home-devices-show');
      await h.idle();
      expect(document.querySelectorAll('#home-devices .home-device')).toHaveLength(1);
      expect(document.querySelector('#home-devices button[id^="home-stop-"]')).toBeNull();
      expect(text('home-devices-unconfirmed-front-s1')).toContain('couldn’t check on NEAR that this sign-in is still part of this account');
    }
  });
});

describe('partner strings are text only', () => {
  it('a policy label, an app name and an origin never become markup, and the label is held to the display-safety rule', async () => {
    const h = await start();
    h.mountFront();
    h.answer = () =>
      json(200, {
        scopes: [
          scopeOf('s1', {
            apps: [{ appId: 'app_sodax1', name: XSS, status: 'active' }],
            devices: [device(1, { consent: consent(9, XSS), label: '<b>Chrome</b>' }), device(2, { consent: consent(8, 'Swaps‮on Base') })],
            email: [{ appId: 'app_sodax1', addresses: ['ada@example.com', '<script>@x'] }],
          }),
        ],
        nextCursor: null,
      });
    h.click('home-devices-show');
    await h.idle();
    expect(document.querySelector('#app script, #app img, #app b')).toBeNull();
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
    const labels = [...document.querySelectorAll('.home-policy-label')].map((x) => x.textContent);
    expect(labels).toEqual([XSS, HOME_UNNAMED_RULE]);
    expect(document.querySelector('.home-devices-apps strong')?.textContent).toBe(XSS);
    // The device label is the vault's word of a fixed shape: anything else isn't shown.
    expect(document.querySelector('.home-device-name strong')?.textContent).toBe(UNNAMED_DEVICE);
    expect([...document.querySelectorAll('.home-email .mono')].map((x) => x.textContent)).toEqual(['ada@example.com']);
    expect([...document.querySelectorAll('#app h1, #app h2, #app h3, #app h4')].map((x) => x.textContent)).toEqual(['Devices and auto-approve']);
  });

  it('the parsers drop what isn’t of the API’s shape', () => {
    const page = parseHomeDevices({
      scopes: [
        scopeOf('s1', { devices: [device(1), device(2, { shareId: 'short' }), device(3, { partnerOrigin: 'javascript:alert(1)' }), device(4, { consent: { consentId: 'x' } })] }),
        scopeOf('s1'),
        { scopeId: 'S 2', apps: [], devices: [], consents: [], email: [] },
        scopeOf('s3', { email: 'yes' }),
        scopeOf('s4', { email: null }),
      ],
      nextCursor: null,
    });
    expect(page.scopes.map((s) => s.scopeId)).toEqual(['s1', 's4']);
    expect(page.scopes[0]!.devices.map((x) => x.shareId)).toEqual([ID(1)]);
    expect(page.scopes[1]!.email).toBeNull();
    expect(() => parseHomeDevices({ scopes: [], nextCursor: 'A B' })).toThrow();
    expect(homePolicyLabel('x'.repeat(81))).toBe(HOME_UNNAMED_RULE);
    expect(homePolicyLabel('  Deposits  ')).toBe('Deposits');
  });

  it('an origin wraps only after :// and before . : and /, and reads as itself', () => {
    const el = originText(dom(document), 'https://earn.sodax.example:8443');
    expect(el.textContent).toBe('https://earn.sodax.example:8443');
    expect(el.className).toBe('origin');
    expect(el.innerHTML).toBe('https://<wbr>earn<wbr>.sodax<wbr>.example<wbr>:8443');
    // Partner text stays text: markup in an origin is never markup.
    expect(originText(dom(document), 'https://<b>x</b>.example').querySelector('b')).toBeNull();
  });

  it('a request’s query and bodies are exactly the API’s', () => {
    expect(homeDevicesSearch({ kind: 'first' })).toBe('');
    expect(homeDevicesSearch({ kind: 'cursor', cursor: 's1' })).toBe('?cursor=s1');
    expect(homeDevicesSearch({ kind: 'scope', scopeId: 's9' })).toBe('?scopeId=s9');
    expect(homeStopBody({ kind: 'share', shareId: ID(1) })).toEqual({ shareId: ID(1) });
    expect(homeStopBody({ kind: 'consent', consentId: ID(2) })).toEqual({ consentId: ID(2) });
    expect(homeStopBody({ kind: 'email', appId: 'app_x1' })).toEqual({ appId: 'app_x1' });
  });
});

describe('the sign-in’s end and the link', () => {
  it('with no usable sign-in a click sends nothing and asks for a new sign-in', async () => {
    const h = await start();
    h.identity = null;
    h.mountFront();
    h.click('home-devices-show');
    await h.idle();
    expect(h.calls).toEqual([]);
    expect(text('home-devices-problem-front')).toContain('Your sign-in to Hana Home has ended.');
  });

  it('`?view=devices` loads the list once after sign-in; any other query doesn’t', async () => {
    expect(devicesLinked('?view=devices')).toBe(true);
    for (const q of ['', '?view=device', '?view=devices&appId=app_x1', '?view=devices&view=devices', '?appId=app_x1']) expect(devicesLinked(q)).toBe(false);
    const h = await start({ search: '?view=devices' });
    h.answer = () => json(200, { scopes: [scopeOf('s1', { devices: [device(1)] })], nextCursor: null });
    h.mountFront();
    h.mountFront();
    await h.idle();
    expect(h.calls).toHaveLength(1);
    expect(h.devices.front).toBe('ready');
    h.mountFront();
    await h.idle();
    expect(h.calls).toHaveLength(1);
  });
});

describe('what "Sign out this device" says about a tab already open there', () => {
  it('up to about a minute in every app (the vault checks its share each minute), and 10 minutes only when the device can’t reach Hana', () => {
    const c = HOME_STOP_CONFIRM.share;
    expect(c.points).toContain('A tab already open there can keep working for up to about a minute.');
    expect(c.more?.join(' ')).toContain('for up to about a minute, or for up to about 10 minutes while that device can’t reach Hana');
    expect(stopDoneText('share', true)).toContain('a tab already open there stops working within about a minute');
    // No app is left with the old 10-minute bound.
    for (const line of [...c.points, ...(c.more ?? []), stopDoneText('share', true)]) expect(line).not.toMatch(/other apps|never signs by itself|few minutes/u);
  });
});
