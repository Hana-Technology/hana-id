// @vitest-environment happy-dom
// Hana Home (`/home`, docs/hana-home-spec.md): the page's states, the sign-in child and its opener checks, the signed API
// call, partner strings as text only, the sign-in's end (detect, warn, lose nothing, never retry, memory only) and how
// each API refusal reads.
import { ApiError, type RelayPayload, type RelayReadResponse, decodeHomeIdentity, encryptRelayPayload, homeMessage, homeNonce, parseWindowMessage } from '@hana-id/core';
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOME_UNNAMED_APP, homeApi, homeAppName, parseHomeApps, parseHomeConfig } from '../../src/auth/home-api.ts';
import { HOME_EXPIRY_WARN_MS, coverageText, HOME_LOGIN_LIMIT_MS, type HomePage, homeProblem, linkedAppId, startHomePage } from '../../src/auth/home-page.ts';
import { CLIENT_ID, ENV, EVIL, FakeWindow, type RemoteWindow, type TokenSigner, asWindow, crossOriginWindow, pageText, remoteWindow, resetDom, tokenSigner } from './helpers.ts';

const FILES = 'https://files.hana.test';
const HOME_ENV = { ...ENV, filesOrigin: FILES };
const G = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';
const EVM = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';
const T0 = 1_800_000_000_000;
const MIN = 60_000;
const XSS = '<img src=x onerror="__pwned=1"><script>__pwned=1</script>';
/** The sign-in child as Hana Home sees it: on this origin, at /login?mode=home. */
const childWindow = (): RemoteWindow => remoteWindow({ location: { pathname: '/login', search: '?mode=home' } as never });

type Scope = Record<string, unknown>;
const app = (name: string, over: Record<string, unknown> = {}) => ({ appId: `app_${name.replace(/[^A-Za-z0-9]/gu, '').slice(0, 20) || 'x'}`, name, status: 'active', environment: 'live', origins: ['https://app.example'], logoUrl: null, ...over });
const scope = (scopeId: string, over: Scope = {}): Scope => ({ scopeId, mine: false, coverage: 'shared', googleClientId: CLIENT_ID, apps: [app(`App ${scopeId}`)], ...over });
const mine = (scopeId: string, over: Scope = {}): Scope => scope(scopeId, { mine: true, supportId: 'HANA-AB12-CD34', addresses: [{ chain: 'stellar', address: G }, { chain: 'evm', address: EVM }], ...over });

const json = (status: number, body: unknown, requestId = 'req_1'): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-request-id': requestId } });
const refusal = (status: number, code: string, error = 'internal words'): Response => json(status, { error, code, requestId: 'req_9' }, 'req_9');

/** Lets real crypto and promise work finish (timers are faked, setImmediate isn't). */
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
/**
 * Waits for `cond` by real time, not by a count of ticks: a sign-in's key and nonce are real WebCrypto work, which on a
 * busy machine (verify runs four packages at once) can take more than a few hundred ticks. `Date` isn't faked here.
 */
const UNTIL_MS = 10_000;
async function until(cond: () => boolean, what = 'condition'): Promise<void> {
  const deadline = Date.now() + UNTIL_MS;
  while (Date.now() < deadline) {
    if (cond()) return;
    await tick();
  }
  if (cond()) return;
  throw new Error(`Timed out waiting for ${what}`);
}

const noChain = (): never => {
  throw new Error('Hana Home read NEAR without the user opening a wallet');
};

interface Call {
  url: URL;
  header: string | null;
}

interface Harness {
  win: FakeWindow;
  page: HomePage;
  child: RemoteWindow;
  calls: Call[];
  /** Calls to `/v1/home/apps` only. */
  appCalls(): Call[];
  /** Calls to `/v1/home/profile` and `/v1/home/name-sharing` ("Your name", home-profile.ts). */
  nameCalls(): Call[];
  /** What those calls answer. */
  nameAnswer: (url: URL, body: string | null) => Response | Promise<Response>;
  /** What the next `/v1/home/apps` calls answer, by the request's query. */
  answer: (url: URL) => Response | Promise<Response>;
  config: () => Response | Promise<Response>;
  relayReads: { relayId: string; readKey: string }[];
  /** Resolves the pending relay read with `payload`, encrypted as the callback page would. */
  relay(payload: RelayPayload | ((params: Record<string, unknown>) => Promise<RelayPayload> | RelayPayload)): Promise<void>;
  relayFail(err: unknown): void;
  token(over?: Record<string, unknown>): (params: Record<string, unknown>) => Promise<RelayPayload>;
  clipboard: { writeText: Mock<(text: string) => Promise<void>> };
  click(id: string): void;
  /** The whole sign-in, from the click to the list on screen. */
  signIn(sub?: string, button?: string): Promise<void>;
  /** The same, without waiting for what the page does next (a request may still be on its way). */
  signInStart(sub?: string, button?: string): Promise<void>;
  hello(): void;
  params(): Record<string, unknown>;
}

let now = T0;
let signer: TokenSigner;
let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];

function start(opts: { search?: string; isGesture?: boolean; framed?: boolean; opener?: RemoteWindow; clipboard?: null; config?: () => Response } = {}): Harness {
  const win = new FakeWindow('/home', opts.search ?? '');
  if (opts.framed) win.top = {};
  if (opts.opener) win.opener = asWindow(opts.opener);
  let child = childWindow();
  win.openResult = child;
  const calls: Call[] = [];
  const relayReads: { relayId: string; readKey: string }[] = [];
  let relayResolve: ((v: RelayReadResponse) => void) | null = null;
  let relayReject: ((e: unknown) => void) | null = null;
  const h = {
    win,
    calls,
    relayReads,
    answer: (_url: URL): Response | Promise<Response> => json(200, { scopes: [], nextCursor: null }),
    config: opts.config ?? ((): Response | Promise<Response> => json(200, { serverTimeMs: now, signer: ENV.signer, sharedGoogleClientId: CLIENT_ID, exitGoogleClientId: null })),
    clipboard: { writeText: vi.fn(async (_text: string) => {}) },
    nameAnswer: (): Response => json(200, { name: null, shares: [], more: false, app: null }),
  } as unknown as Harness;
  Object.defineProperty(h, 'child', { get: () => child });
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const header = new Headers(init?.headers).get('x-hana-home');
    calls.push({ url, header });
    if (url.pathname === '/v1/home/config') return h.config();
    if (url.pathname === '/v1/home/apps') return h.answer(url);
    if (url.pathname === '/v1/home/profile' || url.pathname === '/v1/home/name-sharing') return h.nameAnswer(url, init?.body ? new TextDecoder().decode(init.body as Uint8Array) : null);
    throw new Error(`Unexpected fetch ${url.pathname}`);
  });
  h.appCalls = () => calls.filter((c) => c.url.pathname === '/v1/home/apps');
  h.nameCalls = () => calls.filter((c) => c.url.pathname === '/v1/home/profile' || c.url.pathname === '/v1/home/name-sharing');
  h.page = startHomePage({
    win,
    env: HOME_ENV,
    api: homeApi(ENV.apiUrl, fetchFn as unknown as typeof fetch),
    relay: {
      readRelay: (relayId, readKey) => {
        relayReads.push({ relayId, readKey });
        return new Promise<RelayReadResponse>((resolve, reject) => {
          relayResolve = resolve;
          relayReject = reject;
        });
      },
    },
    // Listing and viewing read no chain: any NEAR read in these tests is a failure (opening a wallet is home-export.test.ts).
    near: { getSession: noChain, txOutcome: noChain, view: noChain, independent: noChain },
    jwks: async (kid) => (kid === signer.jwk.kid ? signer.jwk : null),
    deviceNow: () => now,
    sleep: async () => {},
    ...(opts.isGesture === false ? {} : { isGesture: () => true }),
    clipboard: opts.clipboard === null ? null : h.clipboard,
  });
  h.click = (id) => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`No #${id} on the page: ${pageText()}`);
    (el as HTMLElement).click();
  };
  h.params = () => {
    const sent = child.received.at(-1);
    if (!sent) throw new Error('Nothing was posted to the child');
    return sent as Record<string, unknown>;
  };
  h.hello = () => win.message({ v: 1, t: 'hana:auth-hello' }, ENV.authOrigin, child);
  h.relay = async (payload) => {
    await until(() => relayResolve !== null, 'a relay read');
    const p = h.params();
    const value = await encryptRelayPayload(p.relayKey as Uint8Array, p.relayId as string, typeof payload === 'function' ? await payload(p) : payload);
    const resolve = relayResolve as unknown as (v: RelayReadResponse) => void;
    relayResolve = null;
    resolve({ ...value, serverTimeMs: now });
  };
  h.relayFail = (err) => {
    const reject = relayReject as unknown as (e: unknown) => void;
    relayResolve = null;
    relayReject = null;
    reject(err);
  };
  h.token =
    (over = {}) =>
    async (p) => ({ idToken: await signer.sign({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: 'sub-1', nonce: p.nonce, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 3600, ...over }) });
  h.signInStart = async (sub = 'sub-1', button = 'home-sign-in') => {
    child = childWindow();
    win.openResult = child;
    h.click(button);
    await until(() => h.page.awaitingChild, 'the sign-in to be prepared');
    h.hello();
    await h.relay(h.token({ sub }));
  };
  h.signIn = async (sub = 'sub-1', button = 'home-sign-in') => {
    await h.signInStart(sub, button);
    await h.page.idle();
  };
  return h;
}

/** A started page, past `GET /v1/home/config`. */
async function ready(opts: Parameters<typeof start>[0] = {}): Promise<Harness> {
  const h = start(opts);
  await h.page.idle();
  return h;
}

beforeEach(async () => {
  resetDom();
  window.localStorage.clear();
  now = T0;
  signer ??= await tokenSigner();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
  delete (window as unknown as Record<string, unknown>).__pwned;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Moves the clock and the timers together. */
function advance(ms: number): void {
  now += ms;
  vi.advanceTimersByTime(ms);
}

async function verifiedHeader(call: Call) {
  const header = decodeHomeIdentity(call.header as string);
  if (!header) throw new Error('x-hana-home did not parse');
  const key = await crypto.subtle.importKey('raw', header.key as BufferSource, { name: 'Ed25519' }, false, ['verify']);
  const message = homeMessage({ signer: ENV.signer, counter: header.counter, method: 'GET', path: call.url.pathname + call.url.search, body: new Uint8Array(0) });
  return { header, signed: await crypto.subtle.verify({ name: 'Ed25519' }, key, header.sig as BufferSource, message as BufferSource) };
}

describe('start', () => {
  it('reads the config and offers Google, with nothing else fetched', async () => {
    const h = await ready();
    expect(h.page.stage).toBe('signed_out');
    expect(h.page.session).toBe('none');
    expect(h.calls.map((c) => c.url.pathname)).toEqual(['/v1/home/config']);
    expect(h.calls[0]?.header).toBeNull();
    expect(document.getElementById('home-sign-in')?.textContent).toBe('Continue with Google');
    expect(document.getElementById('home-title')?.textContent).toBe('Hana Home');
  });

  it('refuses to run framed, and fetches nothing', async () => {
    const h = await ready({ framed: true });
    expect(h.page.stage).toBe('stopped');
    expect(h.calls).toEqual([]);
    expect(pageText()).toContain('can’t run inside another page');
    expect(h.win.listenerCount('message')).toBe(0);
  });

  it('drops its opener at load and takes no message from it', async () => {
    const opener = remoteWindow();
    const h = await ready({ opener });
    expect(h.win.opener).toBeNull();
    h.win.message({ v: 1, t: 'hana:auth-hello' }, ENV.authOrigin, opener);
    h.win.message({ v: 1, t: 'hana:auth-hello' }, EVIL, opener);
    expect(opener.received).toEqual([]);
    expect(h.win.opened).toEqual([]);
    expect(h.page.stage).toBe('signed_out');
  });

  it.each([
    ['the config can’t be read', () => refusal(503, 'rate_limiter_unavailable'), 'rate_limiter_unavailable'],
    ['no sign-in client is in force', () => json(200, { serverTimeMs: T0, signer: ENV.signer, sharedGoogleClientId: null, exitGoogleClientId: null }), 'no_google_client'],
    ['the API names another signer', () => json(200, { serverTimeMs: T0, signer: 'other-signer.testnet', sharedGoogleClientId: CLIENT_ID, exitGoogleClientId: null }), 'config_mismatch'],
    ['the answer is malformed', () => json(200, { serverTimeMs: 'soon', signer: ENV.signer, sharedGoogleClientId: CLIENT_ID }), 'bad_response'],
  ])('is unavailable when %s, and reads again only on a click', async (_, config, code) => {
    const h = start({ config });
    await h.page.idle();
    expect(h.page.stage).toBe('unavailable');
    expect(h.page.errorCode).toBe(code);
    expect(document.getElementById('home-sign-in')).toBeNull();
    advance(30 * MIN);
    await h.page.idle();
    expect(h.calls).toHaveLength(1);
    h.config = () => json(200, { serverTimeMs: now, signer: ENV.signer, sharedGoogleClientId: CLIENT_ID, exitGoogleClientId: null });
    h.click('home-retry');
    await h.page.idle();
    expect(h.page.stage).toBe('signed_out');
    expect(h.calls).toHaveLength(2);
  });

  it('acts only on real clicks', async () => {
    const h = await ready({ isGesture: false });
    h.click('home-sign-in');
    expect(h.win.opened).toEqual([]);
    expect(h.page.stage).toBe('signed_out');
  });
});

describe('sign-in', () => {
  it('opens the child in the click, at /login?mode=home', async () => {
    const h = await ready();
    h.click('home-sign-in');
    expect(h.win.opened).toHaveLength(1);
    expect(h.win.opened[0]?.url).toBe(`${ENV.authOrigin}/login?mode=home`);
    expect(h.win.opened[0]?.target).toMatch(/^hana-home-login-[0-9a-f]{32}$/u);
    expect(h.page.stage).toBe('signing_in');
    expect(pageText()).toContain('Finish signing in with Google in the other window.');
    await until(() => h.page.awaitingChild);
  });

  it('says so when the browser blocks the window', async () => {
    const h = await ready();
    h.win.openResult = null;
    h.click('home-sign-in');
    expect(h.page.stage).toBe('signed_out');
    expect(h.page.errorCode).toBe('popup_blocked');
    expect(pageText()).toContain('blocked the sign-in window');
  });

  it('answers only its own child’s hello, once, with a nonce that commits to this sign-in’s key', async () => {
    const h = await ready();
    h.click('home-sign-in');
    await until(() => h.page.awaitingChild);
    const stranger = childWindow();
    // Another window, another origin, another message: none is answered.
    h.win.message({ v: 1, t: 'hana:auth-hello' }, ENV.authOrigin, stranger);
    h.win.message({ v: 1, t: 'hana:auth-hello' }, ENV.vaultOrigin, h.child);
    h.win.message({ v: 1, t: 'hana:auth-hello' }, EVIL, h.child);
    h.win.message({ v: 1, t: 'hana:export-hello' }, ENV.authOrigin, h.child);
    h.win.message({ v: 1, t: 'hana:auth-hello', extra: 1 }, ENV.authOrigin, h.child);
    expect(h.child.received).toEqual([]);
    expect(stranger.received).toEqual([]);

    h.hello();
    expect(h.child.postMessage).toHaveBeenCalledTimes(1);
    expect(h.child.postMessage.mock.calls[0]?.[1]).toBe(ENV.authOrigin);
    const params = parseWindowMessage(h.child.received[0], ['hana:home-params']);
    expect(params).not.toBeNull();
    if (!params) return;
    expect(params.signer).toBe(ENV.signer);
    expect(params.clientId).toBe(CLIENT_ID);
    expect(params.expiresAtMs).toBe(T0 + 15 * MIN);
    expect(params.nonce).toBe(homeNonce({ signer: ENV.signer, homePublicKey: params.homePublicKey, expiresAtMs: params.expiresAtMs, salt: params.salt }));
    // No token, no private key: the message has exactly the fields above (parseWindowMessage is strict).
    h.hello();
    h.hello();
    expect(h.child.postMessage).toHaveBeenCalledTimes(1);
    // The page's own copy of what it posted no longer holds the relay key.
    expect(Array.from((h.child.postMessage.mock.calls[0]?.[0] as { relayKey: Uint8Array }).relayKey).every((b) => b === 0)).toBe(true);
  });

  it('signs in, then lists with a request the API’s gate would accept', async () => {
    const h = await ready();
    h.answer = () => json(200, { scopes: [mine('s1')], nextCursor: null });
    await h.signIn();
    expect(h.page.stage).toBe('signed_in');
    expect(h.page.session).toBe('active');
    expect(h.page.list).toBe('ready');
    expect(h.child.closed).toBe(true);
    expect(h.appCalls()).toHaveLength(1);
    const call = h.appCalls()[0] as Call;
    expect(call.url.search).toBe('');
    const { header, signed } = await verifiedHeader(call);
    expect(signed).toBe(true);
    expect(header.expiresAtMs).toBe(T0 + 15 * MIN);
    expect(header.counter).toBe(1);
    const claims = JSON.parse(Buffer.from(header.jwt.split('.')[1] as string, 'base64url').toString()) as { nonce: string };
    expect(claims.nonce).toBe(homeNonce({ signer: ENV.signer, homePublicKey: header.key, expiresAtMs: header.expiresAtMs, salt: header.salt }));
    expect(pageText()).toContain('App s1');
    expect(pageText()).toContain('Signed in with Google');
  });

  it.each([
    ['a token for another nonce', (h: Harness) => h.token({ nonce: 'x'.repeat(43) }), 'token_invalid'],
    ['a token for another client', (h: Harness) => h.token({ aud: 'partner-client.apps.googleusercontent.com' }), 'token_invalid'],
    ['a token with an email claim', (h: Harness) => h.token({ email: 'a@b.example' }), 'token_has_pii'],
    ['an expired token', (h: Harness) => h.token({ exp: Math.floor(T0 / 1000) - 3600, iat: Math.floor(T0 / 1000) - 7200 }), 'token_invalid'],
    ['an email-issuer token', () => ({ idToken: '{"payload":"e30","signatures":[]}' }), 'token_invalid'],
    ['a token with an access token beside it', (h: Harness) => async (p: Record<string, unknown>) => ({ ...(await h.token()(p)), accessToken: 'ya29.x' }), 'token_invalid'],
    ['Google’s cancel', () => ({ error: 'access_denied' }), 'login_cancelled'],
    ['another Google error', () => ({ error: 'server_error' }), 'google_error'],
  ] as const)('refuses %s and stays signed out', async (_, payload, code) => {
    const h = await ready();
    h.click('home-sign-in');
    await until(() => h.page.awaitingChild);
    h.hello();
    await h.relay(payload(h) as never);
    await h.page.idle();
    expect(h.page.stage).toBe('signed_out');
    expect(h.page.session).toBe('none');
    expect(h.page.errorCode).toBe(code);
    expect(h.appCalls()).toEqual([]);
    expect(document.getElementById('home-sign-in')).not.toBeNull();
  });

  it('answers no hello from its child at any other address, or one whose address it can’t read', async () => {
    for (const location of [{ pathname: '/login', search: '?mode=export' }, { pathname: '/login', search: '' }, { pathname: '/export', search: '?mode=home' }, { pathname: '/login/callback', search: '?mode=home' }, { pathname: '/home', search: '' }]) {
      resetDom();
      const h = await ready();
      h.win.openResult = remoteWindow({ location: location as never });
      h.click('home-sign-in');
      await until(() => h.page.awaitingChild);
      const child = h.win.openResult as RemoteWindow;
      h.win.message({ v: 1, t: 'hana:auth-hello' }, ENV.authOrigin, child);
      expect(child.received, JSON.stringify(location)).toEqual([]);
      expect(h.page.awaitingChild).toBe(true);
    }
    resetDom();
    const h = await ready();
    const cross = crossOriginWindow();
    h.win.openResult = cross;
    h.click('home-sign-in');
    await until(() => h.page.awaitingChild);
    h.win.message({ v: 1, t: 'hana:auth-hello' }, ENV.authOrigin, cross);
    expect(cross.received).toEqual([]);
  });

  it('offers a new attempt when the child closes before it connects', async () => {
    const h = await ready();
    h.click('home-sign-in');
    await until(() => h.page.awaitingChild);
    h.child.closed = true;
    vi.advanceTimersByTime(600);
    expect(h.page.stage).toBe('signed_out');
    expect(h.page.errorCode).toBe('login_cancelled');
    // The hello of a window that is no longer this sign-in's is not answered.
    h.hello();
    expect(h.child.received).toEqual([]);
  });

  it('Cancel ends the attempt; a late answer changes nothing', async () => {
    const h = await ready();
    h.click('home-sign-in');
    await until(() => h.page.awaitingChild);
    h.hello();
    const late = h.relay(h.token());
    h.click('home-cancel');
    expect(h.page.stage).toBe('signed_out');
    expect(h.child.closed).toBe(true);
    await late;
    await h.page.idle();
    expect(h.page.stage).toBe('signed_out');
    expect(h.appCalls()).toEqual([]);
  });

  it('gives up after the time limit', async () => {
    const h = await ready();
    h.click('home-sign-in');
    await until(() => h.page.awaitingChild);
    h.hello();
    await until(() => h.relayReads.length === 1);
    now += HOME_LOGIN_LIMIT_MS + 1000;
    h.relayFail(new Error('network'));
    await h.page.idle();
    expect(h.page.stage).toBe('signed_out');
    expect(h.page.errorCode).toBe('login_timeout');
  });

  it('a relay slot that is gone ends the attempt', async () => {
    const h = await ready();
    h.click('home-sign-in');
    await until(() => h.page.awaitingChild);
    h.hello();
    await until(() => h.relayReads.length === 1);
    h.relayFail(new ApiError(410, 'relay_gone', 'gone', null, null));
    await h.page.idle();
    expect(h.page.errorCode).toBe('token_invalid');
  });
});

describe('your apps', () => {
  const LIST = () =>
    json(200, {
      scopes: [
        mine('s1', { apps: [app('Sodax'), app('Sodax Earn', { status: 'suspended' })] }),
        mine('s2', { coverage: 'exit', apps: [app('Old Exchange', { status: 'deleted', origins: [] })], addresses: [], supportId: undefined }),
        scope('s3', { coverage: 'partner_client' }),
        scope('s4', { coverage: 'none' }),
        scope('s5', { coverage: 'unknown', googleClientId: null }),
        scope('s6', { coverage: 'hana_client', apps: [app('Sandbox', { environment: 'test' })] }),
      ],
      nextCursor: 's6',
    });

  it('shows the user’s own apps first, each with its coverage, state and origin', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    const sections = [...document.querySelectorAll('#home-content h2')].map((x) => x.textContent);
    expect(sections).toEqual(['Your apps', 'Devices and auto-approve', 'Your name', 'Find an app', 'Other apps that use Hana']);
    const cards = [...document.querySelectorAll('.home-card')];
    expect(cards.map((c) => c.getAttribute('data-scope'))).toEqual(['s1', 's2', 's3', 's4', 's5', 's6']);
    const badgeOf = (id: string) => document.querySelector(`.home-card[data-scope="${id}"] .home-card-foot .badge`)?.textContent;
    expect(badgeOf('s1')).toBe('Stays reachable');
    expect(badgeOf('s2')).toBe('Stays reachable');
    expect(badgeOf('s3')).toBe('Depends on the app');
    expect(badgeOf('s4')).toBe('Out of reach');
    // An app where the user has no wallet is never called theirs, or "available".
    expect(badgeOf('s6')).toBe('Supported');
    expect(badgeOf('s5')).toBe('Not checked yet');
    expect(cards[0]?.textContent).toContain('Sodax Earn');
    expect(cards[0]?.textContent).toContain('Paused');
    expect(cards[1]?.textContent).toContain('Closed');
    expect(cards[5]?.textContent).toContain('Test app');
    expect(cards[0]?.textContent).toContain('https://app.example');
    expect(document.getElementById('home-more')).not.toBeNull();
    // No internal word reaches the page.
    for (const word of ['scope', 'coverage', 'shared', 'exit', 'hana_client', 'partner_client', 'derive', 'nonce', 'identity']) expect(pageText().toLowerCase()).not.toContain(word);
  });

  it('every coverage has a badge and a sentence', () => {
    for (const c of ['shared', 'hana_client', 'exit', 'partner_client', 'email', 'none', 'unknown'] as const) {
      for (const own of [true, false]) {
        const t = coverageText(c, own);
        expect(t.badge.length).toBeGreaterThan(3);
        expect(t.detail.length).toBeGreaterThan(20);
        // No promise of an action the page doesn't offer, and nothing called "your wallet" where Hana knows of none.
        expect(`${t.badge} ${t.question} ${t.detail}`).not.toMatch(/\b(?:export|move|open|recover|available)\b/iu);
        if (!own) expect(`${t.question} ${t.detail}`).not.toMatch(/this wallet|your wallet/iu);
      }
    }
  });

  it('says so when the account has no app yet, and still lets the user search', async () => {
    const h = await ready();
    await h.signIn();
    expect(document.getElementById('home-empty')?.textContent).toContain('No apps yet for this Google account');
    expect(document.querySelectorAll('.home-card')).toHaveLength(0);
    expect(document.getElementById('home-search')).not.toBeNull();
    expect(document.getElementById('home-others-title')).toBeNull();
  });

  it('opens an app’s page: addresses, an explorer link for Stellar only, the Support ID, copy', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    (document.querySelector('.home-card[data-scope="s1"] .home-open') as HTMLElement).click();
    expect(h.page.openScope).toBe('s1');
    expect(document.getElementById('home-app-title')?.textContent).toBe('App details');
    expect(document.getElementById('home-app-label')?.textContent).toBe('Apps that share one wallet');
    expect([...document.querySelectorAll('.home-app-all .home-app-name strong')].map((x) => x.textContent)).toEqual(['Sodax', 'Sodax Earn']);
    expect(document.getElementById('home-address-stellar')?.textContent).toBe(G);
    expect(document.getElementById('home-address-evm')?.textContent).toBe(EVM);
    expect(document.getElementById('home-support-id')?.textContent).toBe('HANA-AB12-CD34');
    expect(pageText()).toContain('Signing in to this wallet doesn’t depend on the app');
    const links = [...document.querySelectorAll('#app a')] as HTMLAnchorElement[];
    expect(links.map((a) => a.getAttribute('href'))).toEqual([`https://stellar.expert/explorer/testnet/account/${G}`]);
    expect(links[0]?.getAttribute('rel')).toBe('noopener noreferrer');
    // Opening a page whose coverage is known reads nothing.
    expect(h.appCalls()).toHaveLength(1);

    h.click('home-copy-stellar');
    await h.page.idle();
    expect(h.clipboard.writeText).toHaveBeenCalledWith(G);
    expect(document.getElementById('home-copied')?.textContent).toBe('Copied the Stellar address.');
    h.click('home-copy-support');
    await h.page.idle();
    expect(h.clipboard.writeText).toHaveBeenLastCalledWith('HANA-AB12-CD34');

    h.click('home-back');
    expect(h.page.openScope).toBeNull();
    expect(document.querySelectorAll('.home-card')).toHaveLength(6);
  });

  it('shows a NEAR account with its copy and explorer link; a listing without one says so plainly (D755)', async () => {
    const NEAR = 'ab'.repeat(32);
    const h = await ready();
    h.answer = () =>
      json(200, {
        // The answer's order doesn't matter: Stellar, EVM, then NEAR. A malformed NEAR id is left out.
        scopes: [mine('s1', { addresses: [{ chain: 'near', address: NEAR }, { chain: 'stellar', address: G }, { chain: 'evm', address: EVM }] }), mine('s2', { addresses: [{ chain: 'stellar', address: G }, { chain: 'near', address: 'alice.testnet' }] })],
        nextCursor: null,
      });
    await h.signIn();
    (document.querySelector('.home-card[data-scope="s1"] .home-open') as HTMLElement).click();
    expect([...document.querySelectorAll('.home-address-label')].map((x) => x.textContent)).toEqual(['Stellar', 'EVM (Ethereum and similar networks)', 'NEAR']);
    expect(document.getElementById('home-address-near')?.textContent).toBe(NEAR);
    expect(document.getElementById('home-no-near')).toBeNull();
    const links = [...document.querySelectorAll('#app a')].map((a) => a.getAttribute('href'));
    expect(links).toEqual([`https://stellar.expert/explorer/testnet/account/${G}`, `https://testnet.nearblocks.io/address/${NEAR}`]);
    h.click('home-copy-near');
    await h.page.idle();
    expect(h.clipboard.writeText).toHaveBeenCalledWith(NEAR);
    expect(document.getElementById('home-copied')?.textContent).toBe('Copied the NEAR account.');
    h.click('home-back');
    (document.querySelector('.home-card[data-scope="s2"] .home-open') as HTMLElement).click();
    expect(document.getElementById('home-address-near')).toBeNull();
    expect(document.getElementById('home-no-near')?.textContent).toBe('No NEAR account on record here yet. It appears after you next sign in to this app, if the app uses NEAR.');
    expect(pageText()).not.toContain('alice.testnet');
  });

  it('shows no Support ID and no address where the API gave none', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    (document.querySelector('.home-card[data-scope="s2"] .home-open') as HTMLElement).click();
    expect(document.getElementById('home-app-title')?.textContent).toBe('App details');
    expect(document.getElementById('home-app-label')?.textContent).toBe('App');
    expect(document.querySelector('.home-app-all')?.textContent).toBe('Old ExchangeClosed');
    expect(document.getElementById('home-support-id')).toBeNull();
    expect(pageText()).not.toContain('Support ID');
    expect(document.getElementById('home-no-address')?.textContent).toBe('Hana has no address on record for you in this app yet.');
    h.click('home-back');
    (document.querySelector('.home-card[data-scope="s4"] .home-open') as HTMLElement).click();
    expect(document.getElementById('home-no-address')?.textContent).toBe('Hana has no wallet on record for this Google account in this app.');
    expect(pageText()).toContain('If the app still runs, use the app itself.');
  });

  it('checks an unchecked app once when its page opens: the user’s own by its id, another by its app', async () => {
    const h = await ready();
    h.answer = () => json(200, { scopes: [mine('s1', { coverage: 'unknown' }), scope('s5', { coverage: 'unknown' })], nextCursor: null });
    await h.signIn();
    h.answer = (url) => json(200, { scopes: [url.searchParams.has('scopeId') ? mine('s1', { coverage: 'shared' }) : scope('s5', { coverage: 'none' })], nextCursor: null });
    (document.querySelector('.home-card[data-scope="s1"] .home-open') as HTMLElement).click();
    await h.page.idle();
    expect(h.appCalls().at(-1)?.url.search).toBe('?scopeId=s1');
    expect(document.querySelector('#home-coverage .badge')?.textContent).toBe('Stays reachable');
    h.click('home-back');
    (document.querySelector('.home-card[data-scope="s5"] .home-open') as HTMLElement).click();
    await h.page.idle();
    expect(h.appCalls().at(-1)?.url.search).toBe('?appId=app_Apps5');
    expect(document.querySelector('#home-coverage .badge')?.textContent).toBe('Out of reach');
    expect(h.appCalls()).toHaveLength(3);
  });

  it('searches by name: too short a term sends nothing; results replace the list until cleared', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    const input = document.getElementById('home-search') as HTMLInputElement;
    input.value = ' a ';
    input.dispatchEvent(new Event('input'));
    h.click('home-search-go');
    await h.page.idle();
    expect(h.appCalls()).toHaveLength(1);
    expect(h.page.errorCode).toBe('search_term');

    h.answer = () => json(200, { scopes: [scope('s9', { apps: [app('Quiet Bank')] })], nextCursor: null });
    const again = document.getElementById('home-search') as HTMLInputElement;
    again.value = ' Quiet Bank ';
    again.dispatchEvent(new Event('input'));
    h.click('home-search-go');
    await h.page.idle();
    expect(h.appCalls().at(-1)?.url.search).toBe('?q=Quiet+Bank');
    expect(document.getElementById('home-results-title')?.textContent).toBe('Results for Quiet Bank');
    expect(document.querySelector('#home-results .home-card')?.getAttribute('data-scope')).toBe('s9');
    expect(document.getElementById('home-others-title')).toBeNull();

    h.click('home-search-clear');
    expect(document.getElementById('home-results')).toBeNull();
    expect(document.getElementById('home-others-title')).not.toBeNull();
    expect((document.getElementById('home-search') as HTMLInputElement).value).toBe('');
  });

  it('Show more reads the next page and adds to the list', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    h.answer = () => json(200, { scopes: [scope('s7'), scope('s3')], nextCursor: null });
    h.click('home-more');
    await h.page.idle();
    expect(h.appCalls().at(-1)?.url.search).toBe('?cursor=s6');
    expect([...document.querySelectorAll('.home-card')].map((c) => c.getAttribute('data-scope'))).toEqual(['s1', 's2', 's3', 's4', 's5', 's6', 's7']);
    expect(document.getElementById('home-more')).toBeNull();
    const counters = await Promise.all(h.appCalls().map(async (c) => (await verifiedHeader(c)).header.counter));
    expect(counters).toEqual([1, 2]);
  });

  it('a partner’s link to an app that isn’t the user’s shows their own list first, with the app under Hana’s notice', async () => {
    expect(linkedAppId('?appId=app_abc123')).toBe('app_abc123');
    for (const bad of ['', '?appId=', '?appId=abc', '?appId=app_a&x=1', '?appId=app_a&appId=app_b', '?scopeId=s1', '?appId=app_%3Cb%3E']) expect(linkedAppId(bad)).toBeNull();
    const h = await ready({ search: '?appId=app_quiet1' });
    h.answer = (url) => (url.searchParams.get('appId') === 'app_quiet1' ? json(200, { scopes: [scope('s8', { apps: [app('Quiet Bank', { appId: 'app_quiet1' })] })], nextCursor: null }) : json(200, { scopes: [mine('s1')], nextCursor: null }));
    await h.signIn();
    expect(h.appCalls().map((c) => c.url.search)).toEqual(['', '?appId=app_quiet1']);
    // The partner's words are never the landing screen: the user's own apps come first, nothing is opened.
    expect(h.page.openScope).toBeNull();
    expect([...document.querySelectorAll('#home-content h2')].map((x) => x.textContent)).toEqual(['Your apps', 'The app from your link', 'Devices and auto-approve', 'Your name', 'Find an app']);
    expect(document.querySelector('#home-linked .note')?.textContent).toContain('Hana has no wallet on record for this Google account in it.');
    expect([...document.querySelectorAll('.home-card')].map((c) => c.getAttribute('data-scope'))).toEqual(['s1', 's8']);
    expect(document.querySelector('#home-linked .home-card-foot .badge')?.textContent).toBe('Supported');
    // The link's parameter is an app id, never anything of the user's; the page changed no URL.
    expect(h.win.replaced).toEqual([]);
    expect(h.win.location.assigned).toEqual([]);
  });
});

describe('partner strings are text only', () => {
  it('never builds markup, a link or an image from a name, an origin or a logo', async () => {
    const h = await ready();
    h.answer = () =>
      json(200, {
        scopes: [
          mine('s1', {
            apps: [
              app(XSS, { appId: 'app_x1', origins: ['https://ok.example', 'javascript:alert(1)', 'https://a.example/<b>', '"><img src=x>'], logoUrl: 'https://evil.test/logos/app_x1/' + '0d'.repeat(32) + '.png' }),
              app('Good logo', { appId: 'app_x2', logoUrl: `${FILES}/logos/app_x2/${'0d'.repeat(32)}.png` }),
              app('Script logo', { appId: 'app_x3', logoUrl: 'javascript:alert(1)' }),
            ],
            supportId: '<b>HANA</b>',
            addresses: [{ chain: 'stellar', address: '<img src=x onerror=alert(1)>' }, { chain: 'evm', address: EVM }, { chain: 'solana', address: 'x' }],
          }),
        ],
        nextCursor: null,
      });
    await h.signIn();
    const root = document.getElementById('app') as HTMLElement;
    const check = () => {
      expect(root.querySelector('script')).toBeNull();
      expect(root.querySelector('b')).toBeNull();
      expect(root.querySelector('iframe, object, embed, form, style, link')).toBeNull();
      // The only image is the logo on the files origin this build pins.
      const imgs = [...root.querySelectorAll('img')];
      expect(imgs.map((i) => i.getAttribute('src'))).toEqual([`${FILES}/logos/app_x2/${'0d'.repeat(32)}.png`]);
      expect(imgs[0]?.getAttribute('alt')).toBe('');
      for (const el of root.querySelectorAll('*')) for (const attr of el.getAttributeNames()) expect(attr.startsWith('on')).toBe(false);
      for (const a of root.querySelectorAll('a')) expect(a.getAttribute('href')).toMatch(/^https:\/\/stellar\.expert\/explorer\/testnet\/account\/G[A-Z2-7]{55}$/u);
      expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
    };
    check();
    // The name shows exactly as sent, as characters.
    expect(root.querySelector('.home-app-name strong')?.textContent).toBe(XSS);
    expect(root.textContent).toContain('https://ok.example');
    expect(root.textContent).not.toContain('javascript:');
    (root.querySelector('.home-open') as HTMLElement).click();
    check();
    expect(root.querySelector('.home-app-all .home-app-name strong')?.textContent).toBe(XSS);
    // A malformed address or Support ID is left out, never shown.
    expect(document.getElementById('home-address-stellar')).toBeNull();
    expect(document.getElementById('home-address-evm')?.textContent).toBe(EVM);
    expect(document.getElementById('home-support-id')).toBeNull();
    expect(root.querySelectorAll('a')).toHaveLength(0);
  });

  it('a link to an app that is the user’s own opens its page; one already in the list moves under the notice', async () => {
    const own = await ready({ search: '?appId=app_mine1' });
    own.answer = () => json(200, { scopes: [mine('s1', { apps: [app('Mine', { appId: 'app_mine1' })] })], nextCursor: null });
    await own.signIn();
    expect(own.page.openScope).toBe('s1');
    expect(own.appCalls()).toHaveLength(1);

    resetDom();
    const other = await ready({ search: '?appId=app_other1' });
    other.answer = () => json(200, { scopes: [mine('s1'), scope('s3', { apps: [app('Other', { appId: 'app_other1' })] }), scope('s4')], nextCursor: null });
    await other.signIn();
    expect(other.page.openScope).toBeNull();
    expect(other.appCalls()).toHaveLength(1);
    expect(document.querySelector('#home-linked .home-card')?.getAttribute('data-scope')).toBe('s3');
    expect([...document.querySelectorAll('.home-card')].map((c) => c.getAttribute('data-scope'))).toEqual(['s1', 's3', 's4']);
  });

  it.each([
    ['a right-to-left override', 'Hana \u202EecitoN ytiruceS'],
    ['a zero-width space', 'Hana\u200B Security'],
    ['a bidi isolate', '\u2066Hana\u2069 notice'],
    ['a line break', 'Hana\nSecurity notice: wallet locked'],
    ['a tab', 'Hana\tnotice'],
    ['a soft hyphen', 'Ha\u00ADna'],
    ['a variation selector', 'Hana\uFE0F'],
    ['nothing but spaces', '   '],
    ['201 characters', 'x'.repeat(201)],
    ['a number', 7],
  ])('a name with %s is never shown: Hana’s stand-in takes its place, in the text and in the button’s label', async (_, name) => {
    expect(homeAppName(name)).toBe(HOME_UNNAMED_APP);
    const h = await ready();
    h.answer = () => json(200, { scopes: [mine('s1', { apps: [{ ...app('x', { appId: 'app_x1' }), name }] })], nextCursor: null });
    await h.signIn();
    // The app stays listed (a user's wallet is never hidden by its app's name).
    expect(document.querySelector('.home-app-name strong')?.textContent).toBe('Unnamed app');
    const open = document.querySelector('.home-open') as HTMLElement;
    expect(open.getAttribute('aria-label')).toBe('View Unnamed app');
    open.click();
    expect(document.querySelector('.home-app-all strong')?.textContent).toBe('Unnamed app');
    if (typeof name === 'string' && name.trim() !== '') expect(document.documentElement.outerHTML).not.toContain(name.slice(0, 5) === 'xxxxx' ? 'x'.repeat(100) : name);
  });

  it('a long name is cut to 60 characters, everywhere it shows', async () => {
    const long = 'Hana security notice: your wallet is locked, restore it at hana-restore.example before Friday';
    const shown = 'Hana security notice: your wallet is locked, restore it at h…';
    expect(homeAppName(long)).toBe(shown);
    expect([...shown]).toHaveLength(61);
    expect(homeAppName('é'.repeat(60))).toBe('é'.repeat(60));
    expect(homeAppName(`${'😀'.repeat(61)}`)).toBe(`${'😀'.repeat(60)}…`);
    const h = await ready();
    h.answer = () => json(200, { scopes: [scope('s1', { apps: [app(long, { appId: 'app_x1' })] })], nextCursor: null });
    await h.signIn();
    const open = document.querySelector('.home-open') as HTMLElement;
    expect(open.getAttribute('aria-label')).toBe(`View ${shown}`);
    open.click();
    expect(document.querySelector('.home-app-all strong')?.textContent).toBe(shown);
    expect(pageText()).not.toContain('before Friday');
    expect(document.documentElement.outerHTML).not.toContain('hana-restore.example');
  });

  it('an app’s name is never a heading: the app page’s headings are Hana’s own words', async () => {
    const h = await ready();
    h.answer = () => json(200, { scopes: [scope('s1', { apps: [app(XSS, { appId: 'app_x1', status: 'deleted' })] })], nextCursor: null });
    await h.signIn();
    const open = document.querySelector('.home-open') as HTMLElement;
    expect(open.getAttribute('aria-label')).toBe(`View ${XSS}`);
    open.click();
    expect([...document.querySelectorAll('#app h1, #app h2, #app h3')].map((x) => x.textContent)).toEqual(['Hana Home', 'App details', 'App', 'Would a wallet here depend on the app?', 'Your addresses', 'Devices and auto-approve', 'Your name', 'Move this wallet to another wallet app']);
    expect(document.querySelector('.home-app-all strong')?.textContent).toBe(XSS);
    expect(document.querySelector('#app script')).toBeNull();
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
  });

  it('a search term echoes as text', async () => {
    const h = await ready();
    await h.signIn();
    const input = document.getElementById('home-search') as HTMLInputElement;
    input.value = '<b>x</b>';
    input.dispatchEvent(new Event('input'));
    h.click('home-search-go');
    await h.page.idle();
    expect(document.querySelector('#home-results b')).toBeNull();
    expect(document.querySelector('#home-results-title strong')?.textContent).toBe('<b>x</b>');
  });

  it('the parser drops what isn’t of the API’s shape', () => {
    const page = parseHomeApps({
      scopes: [mine('s1'), mine('s1'), { scopeId: 'S 2', mine: true, coverage: 'shared', googleClientId: null, apps: [] }, scope('s3', { coverage: 'magic' }), scope('s4', { supportId: 'HANA-AB12-CD34', addresses: [{ chain: 'evm', address: EVM }] }), scope('s5', { apps: [app('ok'), { appId: 'nope', name: 'x' }, app('x'.repeat(201))] })],
      nextCursor: null,
    });
    expect(page.scopes.map((s) => s.scopeId)).toEqual(['s1', 's4', 's5']);
    // Someone else's listing never carries a Support ID or addresses, whatever the answer says.
    expect(page.scopes[1]).toMatchObject({ supportId: null, addresses: [] });
    expect(page.scopes[2]?.apps.map((a) => a.name)).toEqual(['ok', 'Unnamed app']);
    expect(() => parseHomeApps({ scopes: 'x' })).toThrow(ApiError);
    expect(() => parseHomeApps({ scopes: [], nextCursor: '<b>' })).toThrow(ApiError);
    expect(() => parseHomeConfig({ serverTimeMs: 1, signer: 'Not An Account', sharedGoogleClientId: null })).toThrow(ApiError);
  });
});

describe('the sign-in’s end', () => {
  const LIST = () => json(200, { scopes: [mine('s1'), scope('s3')], nextCursor: 's3' });

  it('warns two minutes before, then ends at 15 minutes; the screen stays and nothing is fetched', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    (document.querySelector('.home-card[data-scope="s1"] .home-open') as HTMLElement).click();
    const before = document.getElementById('home-content')?.innerHTML;
    advance(15 * MIN - HOME_EXPIRY_WARN_MS - 1000);
    expect(h.page.session).toBe('active');
    expect(document.getElementById('home-ending')).toBeNull();
    advance(1000);
    expect(h.page.session).toBe('ending');
    expect(document.getElementById('home-ending')?.textContent).toContain('ends in about 2 minutes');
    expect(document.getElementById('home-banner')?.getAttribute('aria-live')).toBe('polite');
    expect(document.getElementById('home-content')?.innerHTML).toBe(before);

    advance(HOME_EXPIRY_WARN_MS);
    expect(h.page.session).toBe('ended');
    expect(h.page.stage).toBe('signed_in');
    expect(document.getElementById('home-ended')?.textContent).toContain('has ended. Everything on screen stays.');
    expect(document.getElementById('home-content')?.innerHTML).toBe(before);
    expect(document.getElementById('home-address-stellar')?.textContent).toBe(G);

    // Nothing is sent after the end: not by the page on its own, however long it waits, and not by a click.
    advance(60 * MIN);
    await h.page.idle();
    expect(h.appCalls()).toHaveLength(1);
    h.click('home-back');
    h.click('home-more');
    await h.page.idle();
    expect(h.appCalls()).toHaveLength(1);
    expect(h.page.requests).toBe(1);
    expect([...document.querySelectorAll('.home-card')].map((c) => c.getAttribute('data-scope'))).toEqual(['s1', 's3']);
  });

  it('notices the end when the page is shown again after its timers slept', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    now += 16 * MIN;
    expect(h.page.session).toBe('active');
    h.win.dispatch('visibilitychange');
    expect(h.page.session).toBe('ended');
    expect(h.appCalls()).toHaveLength(1);
  });

  it('a 401 ends it: the screen stays, the request is not sent again', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    h.answer = () => refusal(401, 'home_identity_expired');
    h.click('home-more');
    await h.page.idle();
    expect(h.page.session).toBe('ended');
    expect(h.appCalls()).toHaveLength(2);
    expect([...document.querySelectorAll('.home-card')].map((c) => c.getAttribute('data-scope'))).toEqual(['s1', 's3']);
    expect(document.getElementById('home-ended')).not.toBeNull();
    expect(document.getElementById('home-problem')).toBeNull();
    advance(30 * MIN);
    await h.page.idle();
    expect(h.appCalls()).toHaveLength(2);
  });

  it('signing in again as the same account keeps the screen, fetches nothing, and uses a new key', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    const first = (await verifiedHeader(h.appCalls()[0] as Call)).header;
    (document.querySelector('.home-card[data-scope="s1"] .home-open') as HTMLElement).click();
    advance(15 * MIN);
    expect(h.page.session).toBe('ended');
    const before = document.getElementById('home-content')?.innerHTML;

    h.click('home-sign-in-again');
    expect(h.page.renewing).toBe(true);
    expect(h.page.stage).toBe('signed_in');
    expect(document.getElementById('home-banner')?.textContent).toContain('Finish signing in with Google in the other window.');
    expect(document.getElementById('home-content')?.innerHTML).toBe(before);
    await until(() => h.page.awaitingChild);
    h.hello();
    await h.relay(h.token());
    await h.page.idle();
    expect(h.page.session).toBe('active');
    expect(h.page.renewing).toBe(false);
    expect(document.getElementById('home-banner')?.textContent).toBe('');
    expect(document.getElementById('home-content')?.innerHTML).toBe(before);
    // The page sent nothing by itself after the new sign-in.
    expect(h.appCalls()).toHaveLength(1);

    h.click('home-back');
    h.answer = () => json(200, { scopes: [scope('s7')], nextCursor: null });
    h.click('home-more');
    await h.page.idle();
    const second = await verifiedHeader(h.appCalls()[1] as Call);
    expect(second.signed).toBe(true);
    expect(Array.from(second.header.key)).not.toEqual(Array.from(first.key));
    expect(Array.from(second.header.salt)).not.toEqual(Array.from(first.salt));
    expect(second.header.expiresAtMs).toBe(T0 + 30 * MIN);
    expect(second.header.counter).toBe(1);
  });

  it('signing in again early replaces the warning; another account starts the screen over', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    advance(15 * MIN - HOME_EXPIRY_WARN_MS);
    expect(h.page.session).toBe('ending');
    h.answer = () => json(200, { scopes: [mine('s2', { apps: [app('Other account app')] })], nextCursor: null });
    await h.signIn('sub-2', 'home-sign-in-again');
    expect(h.page.session).toBe('active');
    expect(h.appCalls()).toHaveLength(2);
    expect([...document.querySelectorAll('.home-card')].map((c) => c.getAttribute('data-scope'))).toEqual(['s2']);
    expect(pageText()).not.toContain('App s1');
  });

  it('an answer for one account that arrives after another signed in is thrown away, never shown', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn('sub-1');
    advance(15 * MIN - HOME_EXPIRY_WARN_MS);
    let release: (r: Response) => void = () => {};
    h.answer = () => new Promise<Response>((r) => (release = r));
    h.click('home-more');
    await until(() => h.appCalls().length === 2);
    // Account B signs in while A's request is still on its way.
    h.answer = () => json(200, { scopes: [mine('s2', { apps: [app('B only')] })], nextCursor: null });
    await h.signInStart('sub-2', 'home-sign-in-again');
    await until(() => document.querySelector('.home-card[data-scope="s2"]') !== null, 'account B’s list');
    expect([...document.querySelectorAll('.home-card')].map((c) => c.getAttribute('data-scope'))).toEqual(['s2']);
    release(json(200, { scopes: [mine('s7', { apps: [app('A secret app')], supportId: 'HANA-ZZZZ-ZZZZ' })], nextCursor: null }));
    await h.page.idle();
    await tick();
    expect(pageText()).not.toContain('A secret app');
    expect(document.documentElement.outerHTML).not.toContain('HANA-ZZZZ-ZZZZ');
    expect([...document.querySelectorAll('.home-card')].map((c) => c.getAttribute('data-scope'))).toEqual(['s2']);
    expect(h.page.errorCode).toBeNull();
  });

  it('a request cut off by signing in again as the same account shows no problem and is not sent again', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    advance(15 * MIN - HOME_EXPIRY_WARN_MS);
    let fail: (e: unknown) => void = () => {};
    h.answer = () => new Promise<Response>((_, reject) => (fail = reject));
    h.click('home-more');
    await until(() => h.appCalls().length === 2);
    // The old request dies (its sign-in was replaced) only after the new sign-in is in.
    await h.signInStart('sub-1', 'home-sign-in-again');
    await until(() => h.page.session === 'active' && !h.page.renewing, 'the new sign-in');
    fail(new TypeError('The request was cut off'));
    await h.page.idle();
    expect(h.page.errorCode).toBeNull();
    expect(document.getElementById('home-problem')).toBeNull();
    expect(pageText()).not.toContain('not reachable');
    expect([...document.querySelectorAll('.home-card')]).toHaveLength(2);
    expect(document.getElementById('home-more')?.hasAttribute('disabled')).toBe(false);
    advance(MIN);
    await h.page.idle();
    expect(h.appCalls()).toHaveLength(2);
  });

  it('a failed new sign-in leaves the screen and the ended state as they were', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    advance(15 * MIN);
    h.click('home-sign-in-again');
    await until(() => h.page.awaitingChild);
    h.hello();
    await h.relay({ error: 'access_denied' });
    await h.page.idle();
    expect(h.page.session).toBe('ended');
    expect(h.page.errorCode).toBe('login_cancelled');
    expect(document.getElementById('home-ended')).not.toBeNull();
    expect([...document.querySelectorAll('.home-card')]).toHaveLength(2);
  });

  it('keeps the sign-in in memory only: no storage, no URL, no log', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    (document.querySelector('.home-card[data-scope="s1"] .home-open') as HTMLElement).click();
    advance(15 * MIN);
    await h.signIn('sub-1', 'home-sign-in-again');
    expect(setItem).not.toHaveBeenCalled();
    expect(window.sessionStorage.length).toBe(0);
    expect(window.localStorage.length).toBe(0);
    expect(document.cookie).toBe('');
    expect(h.win.location.assigned).toEqual([]);
    expect(h.win.replaced).toEqual([]);
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
    // The token is nowhere in the document, and no request URL carries the header's parts.
    const { header } = await verifiedHeader(h.appCalls()[0] as Call);
    expect(document.documentElement.outerHTML).not.toContain(header.jwt.slice(0, 40));
    for (const c of h.calls) expect(c.url.toString()).not.toContain(header.jwt.slice(0, 40));
  });

  it('Sign out drops everything, and an answer still on its way is ignored', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    let release: (r: Response) => void = () => {};
    h.answer = () => new Promise<Response>((r) => (release = r));
    h.click('home-more');
    await until(() => h.appCalls().length === 2);
    h.click('home-sign-out');
    expect(h.page.stage).toBe('signed_out');
    expect(h.page.session).toBe('none');
    expect(pageText()).not.toContain('App s1');
    release(json(200, { scopes: [scope('s7')], nextCursor: null }));
    await h.page.idle();
    expect(pageText()).not.toContain('App s7');
    advance(20 * MIN);
    expect(h.page.session).toBe('none');
    expect(document.getElementById('home-ended')).toBeNull();
  });
});

describe('API refusals', () => {
  it.each([
    [404, 'home_no_wallet', 'There is no wallet for this sign-in in that app.'],
    [429, 'home_busy', 'Hana Home has reached its limit for today. Try again tomorrow.'],
    [429, 'rate_limited', 'Too many requests. Wait a minute and try again.'],
    [403, 'home_account_mismatch', 'Sign in as the same account you used in Hana Home.'],
    [409, 'link_pending', 'A sign-in method is still being added to this wallet. Try again once that has finished.'],
    [409, 'counter_reused', 'That request was already sent. Try again.'],
    [503, 'home_directory_unavailable', 'Hana Home is not reachable right now. Nothing on screen was lost. Try again in a moment.'],
    [503, 'rate_limiter_unavailable', 'Hana Home is not reachable right now. Nothing on screen was lost. Try again in a moment.'],
    [502, 'near_unavailable', 'Hana Home is not reachable right now. Nothing on screen was lost. Try again in a moment.'],
    [500, 'something_new', 'Hana Home is not reachable right now. Nothing on screen was lost. Try again in a moment.'],
    [429, 'something_new', 'Too many requests. Wait a minute and try again.'],
    [400, 'something_new', 'Something went wrong. Try again.'],
  ])('%i %s reads as a plain sentence, never the API’s own words', (status, code, text) => {
    const p = homeProblem(new ApiError(status, code, '<b>internal</b> scope s1 sub 123', null, 'req_abc'));
    expect(p).toEqual({ code, text, requestId: 'req_abc', signInAgain: false });
  });

  it('every 401 asks for a new sign-in; a network failure is "not reachable"; odd codes and ids are not shown', () => {
    for (const code of ['home_identity_expired', 'invalid_signature', 'not_a_home_client', 'nonce_mismatch', 'missing_home_identity']) expect(homeProblem(new ApiError(401, code, 'x', null, null)).signInAgain).toBe(true);
    expect(homeProblem(new TypeError('Failed to fetch'))).toMatchObject({ code: 'api_unavailable', signInAgain: false });
    expect(homeProblem(new ApiError(500, '<script>', 'x', null, '<img>'))).toMatchObject({ code: 'error', requestId: null });
  });

  it('a 503 on the first list shows the problem and a Try again that only a click runs', async () => {
    const h = await ready();
    h.answer = () => refusal(503, 'home_directory_unavailable', '<b>D1 is down</b>');
    await h.signIn();
    expect(h.page.stage).toBe('signed_in');
    expect(h.page.list).toBe('error');
    expect(h.page.errorCode).toBe('home_directory_unavailable');
    const alert = document.getElementById('home-problem');
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert?.textContent).toContain('Hana Home is not reachable right now.');
    expect([...(alert?.querySelectorAll('.code') ?? [])].map((x) => x.textContent)).toEqual(['Code: home_directory_unavailable', 'Request: req_9']);
    expect(pageText()).not.toContain('D1 is down');
    advance(5 * MIN);
    await h.page.idle();
    expect(h.appCalls()).toHaveLength(1);
    h.answer = () => json(200, { scopes: [mine('s1')], nextCursor: null });
    h.click('home-reload');
    await h.page.idle();
    expect(h.page.list).toBe('ready');
    expect(h.page.errorCode).toBeNull();
    expect(h.appCalls()).toHaveLength(2);
  });

  it('a refusal later on keeps the list, shows the problem, and is not repeated', async () => {
    const h = await ready();
    h.answer = () => json(200, { scopes: [mine('s1'), scope('s3')], nextCursor: 's3' });
    await h.signIn();
    h.answer = () => refusal(429, 'rate_limited');
    h.click('home-more');
    await h.page.idle();
    expect(document.getElementById('home-problem')?.textContent).toContain('Too many requests.');
    expect([...document.querySelectorAll('.home-card')]).toHaveLength(2);
    expect(h.page.session).toBe('active');
    advance(2 * MIN);
    await h.page.idle();
    expect(h.appCalls()).toHaveLength(2);
    // The button is back for the user to press.
    expect(document.getElementById('home-more')?.hasAttribute('disabled')).toBe(false);
  });

  it('a network failure reads the same way', async () => {
    const h = await ready();
    h.answer = () => {
      throw new TypeError('Failed to fetch');
    };
    await h.signIn();
    expect(h.page.errorCode).toBe('api_unavailable');
    expect(h.page.list).toBe('error');
  });
});

describe('“Your name” on the page (home-profile.ts)', () => {
  const LIST = () => json(200, { scopes: [mine('s1')], nextCursor: null });
  const ADA = { givenName: 'Ada', familyName: 'Lovelace' };

  it('sits on the front page after the devices, reads nothing at sign-in, and reads once on a click', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    expect(document.getElementById('home-profile-show')).not.toBeNull();
    expect(h.nameCalls()).toEqual([]);
    h.nameAnswer = () => json(200, { name: ADA, shares: [], more: false, app: null });
    h.click('home-profile-show');
    await h.page.idle();
    expect(h.nameCalls().map((c) => c.url.pathname + c.url.search)).toEqual(['/v1/home/profile']);
    expect(h.page.profile.front).toBe('ready');
    expect((document.getElementById('home-name-given') as HTMLInputElement).value).toBe('Ada');
  });

  it('an app’s page has it between the devices and the move, and reads ?appId= only on a click', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    (document.querySelector('.home-card[data-scope="s1"] .home-open') as HTMLElement).click();
    const extras = [...(document.getElementById('home-app-extras')?.children ?? [])].map((c) => c.id);
    expect(extras.slice(0, 2)).toEqual(['home-app-devices', 'home-app-profile']);
    expect(h.nameCalls()).toEqual([]);
    h.nameAnswer = (url) => json(200, { name: ADA, shares: [], more: false, app: { appId: url.searchParams.get('appId'), shared: false } });
    h.click('home-app-profile-show');
    await h.page.idle();
    expect(h.nameCalls().map((c) => c.url.search)).toEqual(['?appId=app_Apps1']);
    expect(document.getElementById('home-app-name-share-app_Apps1')?.textContent).toBe('Share my name with App s1');
    // Leaving the page closes it: back on it, it reads again only when asked.
    h.click('home-back');
    (document.querySelector('.home-card[data-scope="s1"] .home-open') as HTMLElement).click();
    expect(document.getElementById('home-app-profile-show')).not.toBeNull();
    expect(h.nameCalls()).toHaveLength(1);
  });

  it('after the 15 minutes nothing is sent: the name stays on screen, a Save asks for a new sign-in', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    h.nameAnswer = () => json(200, { name: ADA, shares: [], more: false, app: null });
    h.click('home-profile-show');
    await h.page.idle();
    advance(15 * MIN);
    expect(h.page.session).toBe('ended');
    h.click('home-name-remove');
    h.click('home-name-remove-confirm-go');
    await h.page.idle();
    expect(h.nameCalls()).toHaveLength(1);
    expect(document.getElementById('home-profile-problem-front')?.textContent).toContain('Your sign-in to Hana Home has ended.');
  });

  it('Sign out clears the name and anything typed; the next account starts with the section closed', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    h.nameAnswer = () => json(200, { name: ADA, shares: [], more: false, app: null });
    h.click('home-profile-show');
    await h.page.idle();
    const given = document.getElementById('home-name-given') as HTMLInputElement;
    given.value = 'Typed, never saved';
    given.dispatchEvent(new Event('input', { bubbles: true }));
    h.click('home-sign-out');
    expect(document.documentElement.outerHTML).not.toContain('Lovelace');
    await h.signIn('sub-2');
    expect(h.page.profile.front).toBe('closed');
    expect(document.getElementById('home-name-given')).toBeNull();
    expect(document.getElementById('home-profile-show')).not.toBeNull();
    expect(document.documentElement.outerHTML).not.toContain('Typed, never saved');
    expect(document.documentElement.outerHTML).not.toContain('Lovelace');
  });
});
