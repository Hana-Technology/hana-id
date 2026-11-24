// @vitest-environment happy-dom
// Hana Home's "Devices and auto-approve" (home-devices.ts, docs/hana-home-spec.md F5): the list on request, each stop
// behind its confirmation and sent once on a real click, signed with the Home identity, the honest sentences of what a
// stop does, partner strings as text only, every refusal's sentence, the end of the sign-in, and `?view=devices`.
import { decodeHomeIdentity, homeMessage } from '@hana-id/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dom, originText } from '../../src/auth/dom.ts';
import { HOME_UNNAMED_RULE, type HomeIdentity, homeDevicesApi, homeDevicesSearch, homePolicyLabel, homeStopBody, newHomeIdentity, parseHomeDevices } from '../../src/auth/home-api.ts';
import { HOME_DEVICES_APP_INTRO, HOME_DEVICES_WALLET_INTRO, HOME_EMAIL_SHOW, HOME_EMAIL_TITLE, HOME_STOP_CONFIRM, type HomeDevices, UNNAMED_DEVICE, DEVICES_FRESH_MS, devicesLinked, devicesSummary, emailAbout, emailSummary, nextMidnight, startHomeDevices, stillTrue, stopDoneText, whenFull, whenWords } from '../../src/auth/home-devices.ts';
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
  /** The clock the section reads (D897); unset, the real one. */
  nowMs: number | null;
  timers: { run: () => void; at: number; live: boolean }[];
  /** Moves the clock on and runs every timer then due. */
  advance(ms: number): void;
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
    nowMs: null,
    timers: [],
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
    now: () => h.nowMs ?? Date.now(),
    setTimer: (run, ms) => {
      const t = { run, at: (h.nowMs ?? Date.now()) + ms, live: true };
      h.timers.push(t);
      return () => {
        t.live = false;
      };
    },
  });
  h.advance = (ms) => {
    h.nowMs = (h.nowMs ?? Date.now()) + ms;
    for (const t of [...h.timers]) {
      if (t.live && t.at <= h.nowMs) {
        t.live = false;
        t.run();
      }
    }
  };
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
  // D901: a wallet's page shows the devices and, in its own card, the email part of the same read.
  h.mountApp = (scopeId = 's1') => document.getElementById('app')!.replaceChildren(h.devices.appView(homeScope(scopeId)), h.devices.emailView(homeScope(scopeId)));
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
    expect(items[0]!.textContent).toContain('if it isn’t used, and');
    // D897: a short date, with the full one for a screen reader and a tooltip.
    expect(items[0]!.querySelector('.home-when time')?.getAttribute('title')).toBeTruthy();
    expect(items[0]!.querySelector('.home-when .sr-only')?.textContent).toBe(items[0]!.querySelector('.home-when time')?.getAttribute('title'));
    expect(items[1]!.querySelector('.home-device-name strong')?.textContent).toBe(UNNAMED_DEVICE);
    expect(items[1]!.textContent).toContain('Auto-approve is off: this device asks you to approve every request.');
    // Which app: the partner's name in the neutral box, never a heading.
    expect(document.querySelector('.home-devices-apps strong')?.textContent).toBe('Sodax');
    expect([...document.querySelectorAll('#app h1, #app h2, #app h3, #app h4')].map((x) => x.textContent)).toEqual(['Devices and auto-approve']);
  });

  it('the app page asks for its one scope', async () => {
    const h = await start();
    h.mountApp('s7');
    // D893: the wallet's page says "this wallet", and names its app or apps.
    expect(document.querySelector('#home-app-devices > p')?.textContent).toBe(HOME_DEVICES_WALLET_INTRO);
    h.answer = () => json(200, { scopes: [scopeOf('s7')], nextCursor: null });
    h.click('home-app-devices-show');
    await h.idle();
    expect(h.calls[0]!.url.search).toBe('?scopeId=s7');
    expect(text('home-app-devices-empty')).toContain('No device is signed in to this wallet right now.');
    // D897: once read, the line says where the wallet is signed in.
    expect(document.querySelector('#home-app-devices > p')?.textContent).toBe('Not signed in to this wallet anywhere right now.');
    // D901: the devices' sentence no longer speaks of the email; the email part says it, in its own card.
    expect(HOME_DEVICES_WALLET_INTRO).toBe('Where you’re signed in to this wallet, and what those devices may sign without asking.');
    expect(HOME_DEVICES_APP_INTRO).toBe('Where you’re signed in to this app with Journear, and what those devices may sign without asking.');
    expect(document.getElementById('home-app-devices-empty')?.classList.contains('jp-empty')).toBe(true);
    expect(text('home-app-email-summary')).toBe('You aren’t sharing your email address with this app.');
    expect(document.querySelector('#home-app-devices #home-app-email-summary')).toBeNull();
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
    expect(text('home-devices-empty')).toContain('No device is signed in to your apps with Journear right now');
    expect(pageText()).toContain('Only apps Journear has on record for you are listed here.');
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
    expect(pageText()).toContain('Passport Home shows the 25 most recent here; others are signed in too.');
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

  it('D765: each thing is a setting row with its control on the right; the danger button appears only inside the confirmation', async () => {
    const h = await listed();
    const item = document.querySelector('#home-devices .home-device') as HTMLElement;
    expect(item.classList.contains('jp-card')).toBe(true);
    // The device row, then its auto-approve row; each has its one control at the right.
    const rows = [...item.querySelectorAll(':scope > .jp-setting')];
    expect(rows.map((r) => r.querySelector('.home-setting-control button')?.textContent)).toEqual(['Sign out this device', 'Stop auto-approving']);
    expect(document.querySelector('#home-devices .home-email > .jp-setting .home-setting-control button')?.textContent).toBe('Stop sharing email');
    // No danger button until a stop is asked for; the asking buttons are secondary.
    expect(document.querySelectorAll('#home-devices .jp-btn-danger')).toHaveLength(0);
    for (const b of item.querySelectorAll('.home-setting-control button')) expect(b.classList.contains('jp-btn-secondary')).toBe(true);
    const button = `home-stop-share-front-${ID(1)}`;
    h.click(button);
    // The confirmation sits under the row, in place of the row's button; its stop is the only danger button.
    expect(document.getElementById(button)).toBeNull();
    const danger = [...document.querySelectorAll('#home-devices .jp-btn-danger')];
    expect(danger.map((b) => b.id)).toEqual([`${button}-confirm-go`]);
    expect(document.getElementById(`${button}-confirm`)?.previousElementSibling?.classList.contains('jp-setting')).toBe(true);
    h.click(`${button}-confirm-cancel`);
    expect(document.querySelectorAll('#home-devices .jp-btn-danger')).toHaveLength(0);
    expect(document.getElementById(button)).not.toBeNull();
  });

  it('D765: a stop’s outcome stays inline as a success alert beside the app it changed (not a toast)', async () => {
    const h = await listed();
    const button = `home-stop-consent-front-${ID(9)}`;
    h.click(button);
    h.answer = () => json(200, { revoked: true });
    h.click(`${button}-confirm-go`);
    await h.idle();
    const note = document.getElementById('home-devices-note-front-s1')!;
    expect(note.classList.contains('jp-alert-success')).toBe(true);
    expect(note.getAttribute('role')).toBe('status');
    expect(note.textContent).toBe(stopDoneText('consent', true));
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
    [404, 'unknown_share', 'Passport Home couldn’t find that device among yours'],
    [404, 'unknown_consent', 'Passport Home couldn’t find that auto-approve among yours'],
    [404, 'unknown_email_share', 'Passport Home found nothing you share with that app.'],
    [503, 'email_sharing_unavailable', 'Passport Home can’t change email sharing right now.'],
    [429, 'rate_limited', 'Too many requests. Wait a minute and try again.'],
    [503, 'home_directory_unavailable', 'Passport Home is not reachable right now.'],
    [400, 'bad_request', 'Passport Home couldn’t read that request.'],
  ])('a %i %s reads as Hana’s sentence, never the API’s words, and nothing is retried', async (status, code, sentence) => {
    const h = await listed();
    h.answer = () => refusal(status, code);
    h.click(`home-stop-share-front-${ID(1)}`);
    h.click(`home-stop-share-front-${ID(1)}-confirm-go`);
    await h.idle();
    expect(text('home-devices-problem-front')).toContain(sentence);
    expect(text('home-devices-problem-front')).toContain(`Error code (for support): ${code}`);
    expect(text('home-devices-problem-front')).toContain('Request ID (for support): req_9');
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
    expect(text('home-devices-problem-front')).toContain('Your sign-in to Passport Home has ended.');
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
      expect(text('home-devices-unconfirmed-front-s1')).toContain('couldn’t confirm that this sign-in is still part of your account');
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
    expect(text('home-devices-problem-front')).toContain('Your sign-in to Passport Home has ended.');
  });

  it('`?view=devices` is exactly that query (the page opens the view for it, home-page.test.ts)', () => {
    expect(devicesLinked('?view=devices')).toBe(true);
    for (const q of ['', '?view=device', '?view=devices&appId=app_x1', '?view=devices&view=devices', '?appId=app_x1']) expect(devicesLinked(q)).toBe(false);
  });

  it('D893: mounting the view reads nothing; opening it reads once, only while closed and signed in; leaving closes a confirmation', async () => {
    const h = await start({ search: '?view=devices' });
    h.answer = () => json(200, { scopes: [scopeOf('s1', { devices: [device(1)] })], nextCursor: null });
    // Drawing the section (Back and Forward do) never reads, even at `?view=devices`.
    h.mountFront();
    h.mountFront();
    await h.idle();
    expect(h.calls).toEqual([]);
    h.devices.openFront();
    h.devices.openFront();
    await h.idle();
    expect(h.calls).toHaveLength(1);
    expect(h.devices.front).toBe('ready');
    // Opened again: it shows what it has, and reads only on "Show again".
    h.devices.openFront();
    await h.idle();
    expect(h.calls).toHaveLength(1);
    // A confirmation left open closes when the user leaves the view; what it shows stays.
    h.click(`home-stop-share-front-${device(1).shareId}`);
    expect(h.devices.confirming).not.toBeNull();
    h.devices.leaveFront();
    expect(h.devices.confirming).toBeNull();
    expect(h.devices.front).toBe('ready');
    // Without a usable sign-in, opening sends nothing: the view keeps its "Show devices".
    h.devices.reset();
    h.identity = null;
    h.devices.openFront();
    await h.idle();
    expect(h.calls).toHaveLength(1);
    expect(h.devices.front).toBe('closed');
    expect(document.getElementById('home-devices-show')).not.toBeNull();
  });
});

describe('what "Sign out this device" says about a tab already open there', () => {
  it('up to about a minute in every app (the vault checks its share before each signature), 3 minutes only when the device can’t reach Hana', () => {
    const c = HOME_STOP_CONFIRM.share;
    expect(c.points).toContain('A tab already open there can keep signing for up to about a minute.');
    expect(c.more?.join(' ')).toContain('for up to about a minute, or for up to about 3 minutes while that device can’t reach Journear');
    expect(stopDoneText('share', true)).toContain('a tab already open there can’t sign after about a minute');
    expect(c.more?.join(' ')).toContain('may still look signed in for a few minutes, but it can’t sign anything');
    // No app is left with the old 10-minute bound.
    for (const line of [...c.points, ...(c.more ?? []), stopDoneText('share', true)]) expect(line).not.toMatch(/other apps|never signs by itself|10 minutes/u);
  });
});

describe('D897: the Security tab’s devices', () => {
  it('opening the tab reads once; the line says where the wallet is signed in; "Show devices" shows the details without a second read', async () => {
    const h = await start();
    h.mountApp('s1');
    h.answer = () => json(200, { scopes: [scopeOf('s1', { devices: [device(1, { consent: consent(9) }), device(2)], email: [{ appId: 'app_sodax1', addresses: ['ada@example.com'] }] })], nextCursor: null });
    const before = document.createElement('button');
    document.body.append(before);
    before.focus();
    expect(document.querySelector('#home-app-devices-summary')?.hasAttribute('data-read')).toBe(false);
    h.devices.openApp();
    h.devices.openApp();
    await h.idle();
    expect(h.calls).toHaveLength(1);
    // Read on its own: the focus stays where the person left it.
    expect(document.activeElement).toBe(before);
    before.remove();
    expect(h.devices.app).toBe('ready');
    expect(h.devices.appExpanded).toBe(false);
    expect(document.querySelector('#home-app-devices-summary')?.textContent).toBe('Signed in to this wallet in 2 places. 1 of them may sign without asking.');
    // D901: which app gets the email is said in the email part, from the same read.
    expect(document.querySelector('#home-app-email-summary')?.textContent).toBe('Your email is shared with this app.');
    // What was read is in the text colour; the section's own sentence before it was quiet.
    expect(document.querySelector('#home-app-devices-summary')?.hasAttribute('data-read')).toBe(true);
    expect(document.querySelector('#home-app-devices .home-device')).toBeNull();
    h.click('home-app-devices-show');
    expect(h.calls).toHaveLength(1);
    expect(h.devices.appExpanded).toBe(true);
    expect(document.querySelectorAll('#home-app-devices .home-device')).toHaveLength(2);
    // Opened again: nothing more is read.
    h.devices.openApp();
    await h.idle();
    expect(h.calls).toHaveLength(1);
    // "Show again" reads again.
    h.click('home-app-devices-refresh');
    await h.idle();
    expect(h.calls).toHaveLength(2);
  });

  it('nothing is read without a usable sign-in; a failed read leaves "Show devices", which reads and shows the details at once', async () => {
    const h = await start();
    h.mountApp('s1');
    h.answer = () => refusal(503, 'home_directory_unavailable');
    h.devices.openApp();
    await h.idle();
    expect(h.calls).toHaveLength(1);
    expect(h.devices.app).toBe('closed');
    h.answer = () => json(200, { scopes: [scopeOf('s1', { devices: [device(1)] })], nextCursor: null });
    h.click('home-app-devices-show');
    await h.idle();
    expect(h.devices.appExpanded).toBe(true);
    expect(document.querySelectorAll('#home-app-devices .home-device')).toHaveLength(1);
    h.devices.leaveApp();
    h.identity = null;
    h.mountApp('s2');
    h.devices.openApp();
    await h.idle();
    expect(h.calls).toHaveLength(2);
  });

  it('the line in each case: places, not devices; this wallet or this app (D901: the email is the email part’s)', () => {
    const one = [{ appId: 'a1', name: 'Sodax' }];
    const two = [{ appId: 'a1', name: 'Sodax' }, { appId: 'a2', name: 'Sodax Earn' }];
    const three = [...two, { appId: 'a3', name: 'Lumen' }];
    const dev = (consent: unknown) => ({ consent });
    expect(devicesSummary({ apps: one, devices: [], consents: [], email: [] })).toBe('Not signed in to this wallet anywhere right now.');
    expect(devicesSummary({ apps: one, devices: [], consents: [], email: [] }, false)).toBe('Not signed in to this app anywhere right now.');
    expect(devicesSummary({ apps: one, devices: [dev(null)], consents: [], email: [] })).toBe('Signed in to this wallet in 1 place. It asks you before signing.');
    expect(devicesSummary({ apps: one, devices: [dev({})], consents: [], email: null })).toBe('Signed in to this wallet in 1 place. It may sign without asking.');
    expect(devicesSummary({ apps: one, devices: [dev(null), dev(null)], consents: [], email: [] })).toBe('Signed in to this wallet in 2 places. Each asks you before signing.');
    expect(devicesSummary({ apps: one, devices: [dev({}), dev({}), dev(null)], consents: [], email: [] })).toBe('Signed in to this wallet in 3 places. 2 of them may sign without asking.');
    // No sign-in kept, but a tab's auto-approve: no contradiction.
    expect(devicesSummary({ apps: one, devices: [], consents: [{}], email: [] })).toBe('Not kept signed in to this wallet anywhere. A tab that may still be open can sign without asking.');
    expect(devicesSummary({ apps: one, devices: [dev(null)], consents: [{}, {}], email: [] })).toBe('Signed in to this wallet in 1 place. It asks you before signing. 2 tabs that may still be open can also sign without asking.');
    // D901: the devices' line never speaks of the email.
    expect(devicesSummary({ apps: two, devices: [], consents: [], email: [{ appId: 'a1' }] })).toBe('Not signed in to this wallet anywhere right now.');
    // The email part's line: "this app" with one app (one form in the card, as its title); otherwise the apps by name,
    // or how many (D897's words, moved).
    expect(emailSummary({ apps: one, email: [{ appId: 'a1' }] })).toBe('Your email is shared with this app.');
    expect(emailSummary({ apps: two, email: [{ appId: 'a2' }] })).toBe('Your email is shared with Sodax Earn.');
    expect(emailSummary({ apps: two, email: [{ appId: 'a1' }, { appId: 'a2' }] })).toBe('Your email is shared with Sodax and Sodax Earn.');
    expect(emailSummary({ apps: three, email: [{ appId: 'a1' }, { appId: 'a2' }, { appId: 'a3' }] })).toBe('Your email is shared with 3 apps.');
    // None, and can't tell (the sentences the wallet's page said under the devices, now the part's line).
    expect(emailSummary({ apps: one, email: [] })).toBe('You aren’t sharing your email address with this app.');
    expect(emailSummary({ apps: two, email: [] })).toBe('You aren’t sharing your email address with these apps.');
    expect(emailSummary({ apps: one, email: null })).toBe('Passport Home can’t tell right now whether you share your email with this app.');
    expect(emailSummary({ apps: two, email: null })).toBe('Passport Home can’t tell right now whether you share your email with these apps.');
    // Before anything is read.
    expect(emailAbout(1)).toBe('Whether you share your email address with this app.');
    expect(emailAbout(2)).toBe('Whether you share your email address with these apps.');
  });

  it('dates in a few plain words, in English with the device’s hours; the full date for a screen reader and a tooltip', () => {
    const now = new Date(2026, 10, 23, 14, 20).getTime();
    const h12 = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle !== 'h23';
    const time = (ms: number) => new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit', hourCycle: h12 ? 'h12' : 'h23' }).format(ms);
    const at = (y: number, m: number, d: number, h: number) => new Date(y, m, d, h, 5).getTime();
    expect(whenWords(at(2026, 10, 23, 9), now)).toBe(`today at ${time(at(2026, 10, 23, 9))}`);
    expect(whenWords(at(2026, 10, 24, 2), now)).toBe(`tomorrow at ${time(at(2026, 10, 24, 2))}`);
    expect(whenWords(at(2026, 10, 22, 23), now)).toBe(`yesterday at ${time(at(2026, 10, 22, 23))}`);
    expect(whenWords(at(2026, 11, 2, 8), now)).toBe(`on Dec 2 at ${time(at(2026, 11, 2, 8))}`);
    expect(whenWords(at(2027, 0, 5, 8), now)).toBe(`on Jan 5, 2027 at ${time(at(2027, 0, 5, 8))}`);
    expect(whenFull(at(2026, 10, 23, 14))).toBe(`Monday, November 23, 2026 at ${time(at(2026, 10, 23, 14))}`);
  });
});

describe('D897 after review: fresh, quiet, true and focus', () => {
  const answerWith = (over: Record<string, unknown>) => () => json(200, { scopes: [scopeOf('s1', over)], nextCursor: null });

  it('"Show devices" reads again when the tab’s read is over a minute old, and the line follows', async () => {
    const h = await start();
    h.nowMs = T0;
    h.mountApp('s1');
    h.answer = answerWith({ devices: [device(1)] });
    h.devices.openApp();
    await h.idle();
    expect(document.getElementById('home-app-devices-summary')?.textContent).toBe('Signed in to this wallet in 1 place. It asks you before signing.');
    h.nowMs = T0 + DEVICES_FRESH_MS + 1;
    h.answer = answerWith({ devices: [device(1), device(2)] });
    h.click('home-app-devices-show');
    await h.idle();
    expect(h.calls).toHaveLength(2);
    expect(document.querySelectorAll('#home-app-devices .home-device')).toHaveLength(2);
    expect(document.getElementById('home-app-devices-summary')?.textContent).toBe('Signed in to this wallet in 2 places. Each asks you before signing.');
  });

  it('within the minute "Show devices" sends nothing', async () => {
    const h = await start();
    h.nowMs = T0;
    h.mountApp('s1');
    h.answer = answerWith({ devices: [device(1)] });
    h.devices.openApp();
    await h.idle();
    h.nowMs = T0 + DEVICES_FRESH_MS;
    h.click('home-app-devices-show');
    await h.idle();
    expect(h.calls).toHaveLength(1);
  });

  it('a failed quiet read says so quietly (no alert); the alert comes only after a press', async () => {
    const h = await start();
    h.mountApp('s1');
    h.answer = () => refusal(503, 'home_directory_unavailable');
    h.devices.openApp();
    await h.idle();
    expect(document.querySelector('#home-app-devices [role="alert"]')).toBeNull();
    expect(document.getElementById('home-devices-quiet-app')?.textContent).toBe('Passport Home couldn’t check this just now. “Show devices” tries again.');
    expect(document.getElementById('home-app-devices-summary')?.textContent).toBe(HOME_DEVICES_WALLET_INTRO);
    h.click('home-app-devices-show');
    await h.idle();
    expect(document.querySelector('#home-app-devices [role="alert"]')).not.toBeNull();
    expect(document.getElementById('home-devices-quiet-app')).toBeNull();
  });

  it('what is on screen is drawn again with no request: at the end of an auto-approve, at midnight, when the page is seen again', async () => {
    const h = await start();
    h.nowMs = T0;
    h.mountApp('s1');
    h.answer = answerWith({ devices: [device(1, { consent: consent(9) })], consents: [{ consentId: ID(8), appId: 'app_sodax1', partnerOrigin: 'https://sodax.example', label: 'Tab rule', grantedAtMs: T0 - 1000, expiresAtMs: T0 + 600_000 }] });
    h.devices.openApp();
    await h.idle();
    h.click('home-app-devices-show');
    expect(document.getElementById('home-app-devices-summary')?.textContent).toContain('It may sign without asking.');
    expect(document.querySelectorAll('#home-app-devices .home-device')).toHaveLength(2);
    // The tab's auto-approve ends first: its card goes, nothing is read.
    // (Timers run a little after the moment, so the date has passed.)
    h.advance(601_000);
    expect(document.querySelectorAll('#home-app-devices .home-device')).toHaveLength(1);
    expect(document.getElementById('home-app-devices-summary')?.textContent).not.toContain('tab');
    // Then the device's: "Auto-approve on" goes, the line says it asks.
    h.advance(1_200_000);
    expect(h.calls).toHaveLength(1);
    expect(document.querySelector('#home-app-devices .home-consent-state')).toBeNull();
    expect(document.querySelector('#home-app-devices .home-device')?.textContent).toContain('Auto-approve is off');
    expect(document.getElementById('home-app-devices-summary')?.textContent).toBe('Signed in to this wallet in 1 place. It asks you before signing.');
    // Past its idle moment: the sentence says what may have happened.
    h.advance(device(1).idleUntilMs - h.nowMs! + 1000);
    expect(document.querySelector('#home-app-devices .home-device-facts')?.textContent).toContain('If it wasn’t used, it signed out by itself');
    // At midnight "today" becomes "yesterday".
    const before = document.querySelector('#home-app-devices .home-device-facts time')?.textContent ?? '';
    h.advance(nextMidnight(h.nowMs!) - h.nowMs! + 1000);
    const after = document.querySelector('#home-app-devices .home-device-facts time')?.textContent ?? '';
    expect(before.startsWith('today') || before.startsWith('yesterday') || before.startsWith('on ')).toBe(true);
    if (before.startsWith('today')) expect(after.startsWith('yesterday')).toBe(true);
    // Seen again (another tab, a phone unlocked): drawn again; still nothing read.
    h.nowMs = device(1).expiresAtMs + 1;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(document.querySelectorAll('#home-app-devices .home-device')).toHaveLength(0);
    expect(h.calls).toHaveLength(1);
    delete (document as unknown as Record<string, unknown>).visibilityState;
  });

  it('drawing again keeps the focus on the same control', async () => {
    const h = await start();
    h.nowMs = T0;
    h.mountApp('s1');
    h.answer = answerWith({ devices: [device(1)], consents: [{ consentId: ID(8), appId: 'app_sodax1', partnerOrigin: 'https://sodax.example', label: 'Tab rule', grantedAtMs: T0 - 1000, expiresAtMs: T0 + 600_000 }] });
    h.devices.openApp();
    await h.idle();
    h.click('home-app-devices-show');
    const again = document.getElementById('home-app-devices-refresh') as HTMLElement;
    again.focus();
    h.advance(601_000);
    expect(document.activeElement?.id).toBe('home-app-devices-refresh');
    expect(document.activeElement).not.toBe(again);
  });

  it('a read that finishes after the person moved on leaves the focus where it is', async () => {
    const h = await start();
    h.mountFront();
    let release: () => void = () => {};
    h.answer = () => new Promise<Response>((r) => { release = () => r(json(200, { scopes: [scopeOf('s1', { devices: [device(1)] })], nextCursor: null })); });
    (document.getElementById('home-devices-title') as HTMLElement).focus();
    let sent = false;
    const answer = h.answer;
    h.answer = (u, c) => {
      sent = true;
      return answer(u, c);
    };
    h.devices.openFront();
    for (let i = 0; i < 200 && !sent; i++) await new Promise((r) => setImmediate(r));
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    elsewhere.focus();
    release();
    await h.idle();
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
    // Still on the heading (or nowhere): the heading takes it, as before.
    h.answer = answerWith({ devices: [device(1)] });
    (document.getElementById('home-devices-title') as HTMLElement).focus();
    h.click('home-devices-refresh');
    await h.idle();
    expect(document.activeElement?.id).toBe('home-devices-title');
  });

  it('stillTrue drops what ended and nothing else', () => {
    const sc = scopeOf('s1', { devices: [device(1, { consent: consent(9) }), device(2, { expiresAtMs: T0 - 1 })], consents: [] }) as unknown as Parameters<typeof stillTrue>[0];
    const out = stillTrue(sc, T0 + 1_800_000);
    expect(out.devices.map((x) => x.shareId)).toEqual([ID(1)]);
    expect(out.devices[0]!.consent).toBeNull();
    expect(stillTrue(sc, T0).devices[0]!.consent).not.toBeNull();
  });
});

describe('D901: the email part of “What these apps get from you” on a wallet’s page', () => {
  const withEmail = (over: Record<string, unknown> = {}) => () => json(200, { scopes: [scopeOf('s1', { devices: [device(1)], email: [{ appId: 'app_sodax1', addresses: ['ada@example.com'] }], ...over })], nextCursor: null });

  async function opened(): Promise<Harness> {
    const h = await start();
    h.nowMs = T0;
    h.mountApp('s1');
    h.answer = withEmail();
    h.devices.openApp();
    await h.idle();
    return h;
  }

  it('its heading, its line from the tab’s read, and its rows only after “Show email sharing” (no second read while fresh); the devices’ cards stay behind their own button', async () => {
    const h = await start();
    h.nowMs = T0;
    h.mountApp('s1');
    const part = document.getElementById('home-app-email') as HTMLElement;
    expect(part.tagName).toBe('SECTION');
    expect(part.getAttribute('aria-labelledby')).toBe('home-app-email-title');
    expect(document.getElementById('home-app-email-title')?.tagName).toBe('H3');
    expect(text('home-app-email-title')).toBe(HOME_EMAIL_TITLE);
    // Before anything is read: what the part is about, quiet; nothing is sent by drawing it.
    expect(text('home-app-email-summary')).toBe(emailAbout(1));
    expect(document.getElementById('home-app-email-summary')?.hasAttribute('data-read')).toBe(false);
    expect(text('home-app-email-show')).toBe(HOME_EMAIL_SHOW);
    expect(h.calls).toHaveLength(0);
    h.answer = withEmail();
    h.devices.openApp();
    await h.idle();
    expect(text('home-app-email-summary')).toBe('Your email is shared with this app.');
    expect(document.getElementById('home-app-email-summary')?.hasAttribute('data-read')).toBe(true);
    expect(pageText()).not.toContain('ada@example.com');
    expect(h.devices.emailExpanded).toBe(false);
    h.click('home-app-email-show');
    await h.idle();
    expect(h.calls).toHaveLength(1);
    expect(h.devices.emailExpanded).toBe(true);
    expect(document.activeElement?.id).toBe('home-app-email-title');
    const row = document.querySelector('#home-app-email .home-email') as HTMLElement;
    expect(row.classList.contains('jp-card')).toBe(true);
    expect(row.textContent).toContain('Your email is shared with this app: ada@example.com');
    expect(row.querySelector('.home-setting-control button')?.textContent).toBe('Stop sharing email');
    // The devices: still behind "Show devices"; their section never holds the email rows.
    expect(h.devices.appExpanded).toBe(false);
    expect(document.querySelector('#home-app-devices .home-device')).toBeNull();
    h.click('home-app-devices-show');
    expect(document.querySelectorAll('#home-app-devices .home-device')).toHaveLength(1);
    expect(document.querySelector('#home-app-devices .home-email')).toBeNull();
    expect(h.calls).toHaveLength(1);
    // "Show again" reads again (one read for both parts).
    h.click('home-app-email-refresh');
    await h.idle();
    expect(h.calls).toHaveLength(2);
  });

  it('“Show email sharing” reads again when the tab’s read is over a minute old; pressed first (no tab read), it reads once and keeps the devices’ cards closed', async () => {
    const h = await opened();
    h.nowMs = T0 + DEVICES_FRESH_MS + 1;
    h.click('home-app-email-show');
    await h.idle();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.url.search).toBe('?scopeId=s1');
    expect(document.querySelector('#home-app-email .home-email')).not.toBeNull();
    // A wallet whose Security tab was reached by Back or Forward (no tab read): the press reads once.
    h.devices.leaveApp();
    h.mountApp('s2');
    h.answer = withEmail({ scopeId: 's2' });
    h.click('home-app-email-show');
    await h.idle();
    expect(h.calls).toHaveLength(3);
    expect(h.devices.emailExpanded).toBe(true);
    expect(h.devices.appExpanded).toBe(false);
    expect(document.querySelector('#home-app-devices .home-device')).toBeNull();
    expect(document.getElementById('home-app-devices-show')).not.toBeNull();
  });

  it('“Stop sharing email” asks first, in the email part; Cancel sends nothing; the stop is one signed POST; its outcome and the line are the part’s', async () => {
    const h = await opened();
    h.click('home-app-email-show');
    const button = 'home-stop-email-app-s1-app_sodax1';
    h.click(button);
    const panel = document.getElementById(`${button}-confirm`) as HTMLElement;
    expect(document.getElementById('home-app-email')?.contains(panel)).toBe(true);
    expect(panel.querySelector('.home-confirm-title')?.textContent).toBe(HOME_STOP_CONFIRM.email.title);
    expect([...panel.querySelectorAll(':scope > ul > li')].map((li) => li.textContent)).toEqual([...HOME_STOP_CONFIRM.email.points]);
    expect(document.activeElement?.id).toBe(`${button}-confirm-title`);
    expect([...document.querySelectorAll('.jp-btn-danger')].map((b) => b.id)).toEqual([`${button}-confirm-go`]);
    h.click(`${button}-confirm-cancel`);
    expect(h.devices.confirming).toBeNull();
    expect(h.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    h.click(button);
    h.answer = () => json(200, { state: 'declined', revoked: 1 });
    h.click(`${button}-confirm-go`);
    document.getElementById(`${button}-confirm-go`)?.click();
    await h.idle();
    const stops = h.calls.filter((c) => c.method === 'POST');
    expect(stops.map((c) => c.url.pathname)).toEqual(['/v1/home/email-sharing/revoke']);
    expect(JSON.parse(stops[0]!.body as string)).toEqual({ appId: 'app_sodax1' });
    expect(await verified(stops[0]!)).toBe(true);
    const note = document.getElementById('home-app-email-note') as HTMLElement;
    expect(note.textContent).toBe(stopDoneText('email', true));
    expect(note.classList.contains('jp-alert-success')).toBe(true);
    expect(note.getAttribute('role')).toBe('status');
    expect(document.activeElement).toBe(note);
    expect(document.querySelector('#home-app-email .home-email')).toBeNull();
    expect(text('home-app-email-summary')).toBe('You aren’t sharing your email address with this app.');
    // The devices' section says nothing about it.
    expect(text('home-devices-note-app-s1')).toBe('');
  });

  it('a refused email stop reads as Journear’s sentence in the email part, not the devices’; the row stays', async () => {
    const h = await opened();
    h.click('home-app-email-show');
    const button = 'home-stop-email-app-s1-app_sodax1';
    h.click(button);
    h.answer = () => refusal(503, 'email_sharing_unavailable');
    h.click(`${button}-confirm-go`);
    await h.idle();
    expect(text('home-app-email-problem')).toContain('Passport Home can’t change email sharing right now.');
    expect(text('home-app-email-problem')).toContain('Error code (for support): email_sharing_unavailable');
    expect(document.activeElement?.id).toBe('home-app-email-problem');
    expect(document.getElementById('home-devices-problem-app')).toBeNull();
    expect(document.querySelector('#home-app-email .home-email')).not.toBeNull();
    expect(pageText()).not.toContain('internal words');
  });

  it('a failed tab read is quiet in both parts; “Show email sharing” then reads, and a refusal of that press shows in the email part', async () => {
    const h = await start();
    h.mountApp('s1');
    h.answer = () => refusal(503, 'home_directory_unavailable');
    h.devices.openApp();
    await h.idle();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(text('home-email-quiet')).toBe('Passport Home couldn’t check this just now. “Show email sharing” tries again.');
    expect(text('home-app-email-summary')).toBe(emailAbout(1));
    h.click('home-app-email-show');
    await h.idle();
    expect(text('home-app-email-problem')).toContain('Passport Home is not reachable right now.');
    expect(document.getElementById('home-devices-problem-app')).toBeNull();
    h.answer = withEmail();
    h.click('home-app-email-show');
    await h.idle();
    expect(document.getElementById('home-app-email-problem')).toBeNull();
    expect(document.querySelector('#home-app-email .home-email')).not.toBeNull();
  });

  it('an account Journear couldn’t confirm: no stop and no email shown; the part says it can’t tell', async () => {
    const h = await start();
    h.mountApp('s1');
    h.answer = () => json(200, { scopes: [scopeOf('s1', { devices: [device(1)], email: null, canStop: false })], nextCursor: null });
    h.devices.openApp();
    await h.idle();
    expect(text('home-app-email-summary')).toBe('Passport Home can’t tell right now whether you share your email with this app.');
    h.click('home-app-email-show');
    expect(document.querySelector('#home-app-email .home-email')).toBeNull();
    expect(document.querySelector('#home-app-email button[id^="home-stop-"]')).toBeNull();
  });

  it('PR 130’s review: while a stop is on its way, neither part’s “Show …” can start a read; the stop’s outcome then stays, with the focus on it', async () => {
    for (const which of ['email', 'share'] as const) {
      resetDom();
      const h = await opened();
      let release: (r: Response) => void = () => {};
      if (which === 'email') {
        h.click('home-app-email-show');
        h.click('home-stop-email-app-s1-app_sodax1');
        h.answer = () => new Promise<Response>((r) => (release = r));
        h.click('home-stop-email-app-s1-app_sodax1-confirm-go');
        // The devices' cards are still behind their button, which waits for the stop.
        expect(document.getElementById('home-app-devices-show')?.hasAttribute('disabled')).toBe(true);
        h.click('home-app-devices-show');
      } else {
        h.click('home-app-devices-show');
        h.click(`home-stop-share-app-${ID(1)}`);
        h.answer = () => new Promise<Response>((r) => (release = r));
        h.click(`home-stop-share-app-${ID(1)}-confirm-go`);
        expect(document.getElementById('home-app-email-show')?.hasAttribute('disabled')).toBe(true);
        h.nowMs = T0 + DEVICES_FRESH_MS + 1;
        h.click('home-app-email-show');
      }
      for (let i = 0; i < 100 && !h.calls.some((c) => c.method === 'POST'); i++) await new Promise((r) => setImmediate(r));
      expect(h.calls.filter((c) => c.method === 'GET')).toHaveLength(1);
      release(json(200, which === 'email' ? { state: 'declined', revoked: 1 } : { revoked: true }));
      await h.idle();
      expect(h.calls.filter((c) => c.method === 'GET')).toHaveLength(1);
      const note = document.getElementById(which === 'email' ? 'home-app-email-note' : 'home-devices-note-app-s1') as HTMLElement;
      expect(note.textContent).toBe(stopDoneText(which, true));
      expect(document.activeElement).toBe(note);
      // Once it is done, the buttons work again.
      expect(document.getElementById(which === 'email' ? 'home-app-devices-show' : 'home-app-email-show')?.hasAttribute('disabled')).toBe(false);
    }
  });

  it('PR 130’s review: a stop answered after the person moved to another wallet changes what it stopped, but says nothing and moves no focus on the page now open', async () => {
    const h = await opened();
    h.click('home-app-email-show');
    h.click('home-stop-email-app-s1-app_sodax1');
    let release: (r: Response) => void = () => {};
    h.answer = () => new Promise<Response>((r) => (release = r));
    h.click('home-stop-email-app-s1-app_sodax1-confirm-go');
    for (let i = 0; i < 100 && !h.calls.some((c) => c.method === 'POST'); i++) await new Promise((r) => setImmediate(r));
    h.devices.leaveApp();
    h.mountApp('s2');
    // (Its buttons wait for the stop on its way, so the person is, say, on the part's heading.)
    expect(document.getElementById('home-app-email-show')?.hasAttribute('disabled')).toBe(true);
    (document.getElementById('home-app-email-title') as HTMLElement).focus();
    release(json(200, { state: 'declined', revoked: 1 }));
    await h.idle();
    expect(text('home-app-email-note')).toBe('');
    expect(document.getElementById('home-devices-note-app-s2')).toBeNull();
    expect(document.activeElement?.id).toBe('home-app-email-title');
    expect(document.getElementById('home-app-email-show')?.hasAttribute('disabled')).toBe(false);
    expect(h.devices.confirming).toBeNull();
    expect(text('home-app-email-summary')).toBe(emailAbout(1));
    // The same wallet opened again is a new page too: nothing of the old stop's outcome is said there.
    const h2 = await opened();
    h2.click('home-app-email-show');
    h2.click('home-stop-email-app-s1-app_sodax1');
    h2.answer = () => new Promise<Response>((r) => (release = r));
    h2.click('home-stop-email-app-s1-app_sodax1-confirm-go');
    for (let i = 0; i < 100 && !h2.calls.some((c) => c.method === 'POST'); i++) await new Promise((r) => setImmediate(r));
    h2.devices.leaveApp();
    h2.mountApp('s1');
    release(json(200, { state: 'declined', revoked: 1 }));
    await h2.idle();
    expect(text('home-app-email-note')).toBe('');
    expect(document.getElementById('home-app-email-show')).not.toBeNull();
  });

  it('PR 130’s review: on a wallet’s page the “couldn’t confirm” warning no longer speaks of email (the card does); the account view keeps it', async () => {
    const h = await start();
    h.mountApp('s1');
    h.answer = () => json(200, { scopes: [scopeOf('s1', { devices: [device(1)], email: null, canStop: false })], nextCursor: null });
    h.devices.openApp();
    await h.idle();
    h.click('home-app-devices-show');
    expect(text('home-devices-unconfirmed-app-s1')).toBe('Passport Home couldn’t confirm that this sign-in is still part of your account, so it offers no stop for now. Show your devices again in a moment.');
    h.mountFront();
    h.click('home-devices-show');
    await h.idle();
    expect(text('home-devices-unconfirmed-front-s1')).toContain('shows no email sharing here for now');
  });

  it('partner strings stay text in the email part', async () => {
    const h = await start();
    h.mountApp('s1');
    h.answer = () => json(200, { scopes: [scopeOf('s1', { apps: [{ appId: 'app_sodax1', name: XSS, status: 'active' }, { appId: 'app_other1', name: XSS, status: 'active' }], email: [{ appId: 'app_sodax1', addresses: ['ada@example.com', '<script>@x'] }] })], nextCursor: null });
    h.devices.openApp();
    await h.idle();
    h.click('home-app-email-show');
    expect(text('home-app-email-summary')).toBe(`Your email is shared with ${XSS}.`);
    expect(document.querySelector('#app script, #app img')).toBeNull();
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
    expect([...document.querySelectorAll('#home-app-email .home-email .mono')].map((x) => x.textContent)).toEqual(['ada@example.com']);
  });
});
