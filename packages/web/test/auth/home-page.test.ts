// @vitest-environment happy-dom
// Hana Home (`/home`, docs/hana-home-spec.md): the page's states, the sign-in child and its opener checks, the signed API
// call, partner strings as text only, the sign-in's end (detect, warn, lose nothing, never retry, memory only) and how
// each API refusal reads.
import { ApiError, type RelayPayload, type RelayReadResponse, decodeHomeIdentity, encryptRelayPayload, homeMessage, homeNonce, identityKeyHex, parseWindowMessage } from '@hana-id/core';
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOME_UNNAMED_APP, homeApi, homeAppName, parseHomeApps, parseHomeConfig } from '../../src/auth/home-api.ts';
import { HOME_EXPIRY_WARN_MS, HOME_TEXT, coverageText, HOME_LOGIN_LIMIT_MS, type HomePage, homeProblem, homeViewTitle, linkedAppId, startHomePage } from '../../src/auth/home-page.ts';
import { CLIENT_ID, ENV, EVIL, FakeWindow, type RemoteWindow, type TokenSigner, asWindow, crossOriginWindow, flush, pageText, remoteWindow, resetDom, tokenSigner } from './helpers.ts';

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
  /** Calls to `/v1/home/devices` ("Devices and auto-approve", home-devices.ts), and what they answer. */
  deviceCalls(): Call[];
  devicesAnswer: (url: URL) => Response | Promise<Response>;
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

function start(opts: { search?: string; isGesture?: boolean; framed?: boolean; opener?: RemoteWindow; clipboard?: null; config?: () => Response; view?: (signer: string, method: string, args: unknown) => Promise<unknown> } = {}): Harness {
  const independentViews = opts.view ? (s: string) => ({ primary: (m: string, a: unknown) => opts.view!(s, `primary:${m}`, a), second: (m: string, a: unknown) => opts.view!(s, `second:${m}`, a) }) : noChain;
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
    devicesAnswer: (): Response => json(200, { scopes: [], nextCursor: null }),
  } as unknown as Harness;
  Object.defineProperty(h, 'child', { get: () => child });
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const header = new Headers(init?.headers).get('x-hana-home');
    calls.push({ url, header });
    if (url.pathname === '/v1/home/config') return h.config();
    if (url.pathname === '/v1/home/apps') return h.answer(url);
    if (url.pathname === '/v1/home/profile' || url.pathname === '/v1/home/name-sharing') return h.nameAnswer(url, init?.body ? new TextDecoder().decode(init.body as Uint8Array) : null);
    if (url.pathname === '/v1/home/devices') return h.devicesAnswer(url);
    throw new Error(`Unexpected fetch ${url.pathname}`);
  });
  h.appCalls = () => calls.filter((c) => c.url.pathname === '/v1/home/apps');
  h.nameCalls = () => calls.filter((c) => c.url.pathname === '/v1/home/profile' || c.url.pathname === '/v1/home/name-sharing');
  h.deviceCalls = () => calls.filter((c) => c.url.pathname === '/v1/home/devices');
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
    // "Ways to sign in" reads its two views on both providers only when asked (`opts.view`, named `primary:` or `second:`).
    near: { getSession: noChain, txOutcome: noChain, view: noChain, independent: independentViews },
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
    expect(document.getElementById('home-title')?.textContent).toBe('Passport Home');
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
    // Who is signed in is in the top bar, outside the page's content (D888).
    expect(document.getElementById('home-account')?.textContent).toContain('Signed in with Google');
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
    // D893: the view's h1 is "Your wallets"; "Your account" and "Other apps" follow it.
    expect([...document.querySelectorAll('#app h1, #app h2, #app h3')].map((x) => `${x.tagName} ${x.textContent}`)).toEqual(['H1 Your wallets', 'H2 Your account', 'H2 Other apps']);
    expect(document.title).toBe('Your wallets – Passport Home');
    // The user's own wallets under "Your wallets", the others under "Other apps" (after the search).
    expect([...document.querySelectorAll('#home-mine .home-row')].map((c) => c.getAttribute('data-scope'))).toEqual(['s1', 's2']);
    expect([...document.querySelectorAll('#home-others .home-row')].map((c) => c.getAttribute('data-scope'))).toEqual(['s3', 's4', 's5', 's6']);
    const cards = [...document.querySelectorAll('.home-row[data-scope]')];
    expect(cards.map((c) => c.getAttribute('data-scope'))).toEqual(['s1', 's2', 's3', 's4', 's5', 's6']);
    // A row names every app that shares the wallet, with their state, and where the first runs (quieter, D893).
    expect([...(cards[0]?.querySelectorAll('.home-row-name') ?? [])].map((x) => x.textContent)).toEqual(['Sodax', 'Sodax Earn']);
    expect(cards[0]?.querySelector('.home-row-sub')?.textContent).toBe('https://app.example and 1 more website');
    expect(cards[0]?.getAttribute('aria-label')).toBe('Sodax, Sodax Earn (Paused), Safe if the apps close');
    expect(cards[5]?.getAttribute('aria-label')).toBe('Sandbox (Test app), Safe if the app closes');
    // Every row has a tile: a neutral placeholder where the app has no logo.
    expect(cards.every((c) => c.querySelector('.home-tile > svg.ic') !== null && c.querySelector('.home-tile')?.getAttribute('aria-hidden') === 'true')).toBe(true);
    const badgeOf = (id: string) => document.querySelector(`.home-row[data-scope="${id}"] > .badge`)?.textContent;
    expect(badgeOf('s1')).toBe('Safe if the apps close');
    expect(badgeOf('s2')).toBe('Safe if the app closes');
    expect(badgeOf('s3')).toBe('Needs the app');
    expect(badgeOf('s4')).toBe('Can’t be opened here');
    // An app where the user has no wallet is never called theirs, or "available".
    expect(badgeOf('s6')).toBe('Safe if the app closes');
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
    expect(document.getElementById('home-empty')?.textContent).toBe('No wallets yetYou don’t have a wallet with this Google account yet. A wallet appears here after you sign in to an app with Journear.');
    expect(document.querySelectorAll('.home-row[data-scope]')).toHaveLength(0);
    expect(document.getElementById('home-search')).not.toBeNull();
    // D893: "Other apps" says it has none to list, in the same pattern.
    expect(document.getElementById('home-others-empty')?.textContent).toBe('No other apps listedSome apps appear only when you search for their whole name.');
    expect(document.getElementById('home-others-empty')?.classList.contains('jp-empty')).toBe(true);
  });

  it('opens an app’s page: addresses, an explorer link for Stellar only, the Support ID, copy', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    (document.querySelector('.home-row[data-scope="s1"]') as HTMLElement).click();
    expect(h.page.openScope).toBe('s1');
    expect(h.page.view).toBe('wallet');
    expect(document.getElementById('home-app-title')?.tagName).toBe('H1');
    expect(document.getElementById('home-app-title')?.textContent).toBe('Wallet details');
    expect(document.title).toBe('Wallet details – Passport Home');
    expect(document.activeElement?.id).toBe('home-app-title');
    expect(document.getElementById('home-app-label')?.textContent).toBe('Apps that use this wallet');
    expect([...document.querySelectorAll('.home-app-all .home-app-name strong')].map((x) => x.textContent)).toEqual(['Sodax', 'Sodax Earn']);
    expect(document.getElementById('home-address-stellar')?.textContent).toBe(G);
    expect(document.getElementById('home-address-evm')?.textContent).toBe(EVM);
    expect(document.getElementById('home-support-id')?.textContent).toBe('HANA-AB12-CD34');
    // PR 122's review: a wallet two apps use reads "these apps".
    expect(pageText()).toContain('If these apps shut down, you can still sign in to this wallet through Journear.');
    expect(document.querySelector('#home-coverage .sr-only')?.textContent).toBe('Does this wallet need these apps? No. ');
    const links = [...document.querySelectorAll('#app a')] as HTMLAnchorElement[];
    expect(links.map((a) => a.getAttribute('href'))).toEqual([`https://stellar.expert/explorer/testnet/account/${G}`]);
    expect(links[0]?.getAttribute('rel')).toBe('noopener noreferrer');
    // Opening a page whose coverage is known reads nothing.
    expect(h.appCalls()).toHaveLength(1);

    h.click('home-copy-stellar');
    await h.page.idle();
    expect(h.clipboard.writeText).toHaveBeenCalledWith(G);
    // A copy that worked is a toast (D765), outside the page's content; the inline status line stays empty.
    expect([...document.querySelectorAll('.home-toasts .jp-toast')].map((t) => t.textContent)).toEqual(['Copied the Stellar address.']);
    expect(document.querySelector('.home-toasts .jp-toast')?.getAttribute('role')).toBe('status');
    expect(document.getElementById('home-copied')?.textContent).toBe('');
    h.click('home-copy-support');
    await h.page.idle();
    expect(h.clipboard.writeText).toHaveBeenLastCalledWith('HANA-AB12-CD34');

    h.click('home-back');
    expect(h.page.openScope).toBeNull();
    expect(h.page.view).toBe('front');
    expect(document.querySelectorAll('.home-row[data-scope]')).toHaveLength(6);
    // Back on the front page, focus is on the row the user opened.
    expect(document.activeElement?.getAttribute('data-scope')).toBe('s1');
  });

  it('D765: a copy the browser refuses stays on the page (the user must copy by hand), never as a toast; sign-out clears the toasts', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    (document.querySelector('.home-row[data-scope="s1"]') as HTMLElement).click();
    h.clipboard.writeText.mockRejectedValueOnce(new Error('denied'));
    h.click('home-copy-stellar');
    await h.page.idle();
    expect(document.getElementById('home-copied')?.textContent).toBe('This browser didn’t allow the copy. Select the Stellar address and copy it yourself.');
    expect(document.querySelectorAll('.home-toasts .jp-toast')).toHaveLength(0);
    h.click('home-copy-stellar');
    await h.page.idle();
    // A copy that works clears the hand-copy line and says so in a toast instead.
    expect(document.getElementById('home-copied')?.textContent).toBe('');
    expect(document.querySelectorAll('.home-toasts .jp-toast')).toHaveLength(1);
    h.click('home-sign-out');
    expect(document.querySelectorAll('.home-toasts .jp-toast')).toHaveLength(0);
    // The stack is outside the page's content, so a redraw of #app never drops it.
    expect(document.querySelector('.home-toasts')?.closest('#app')).toBeNull();
  });

  it('D765: the empty list is the system’s empty state; the signed-out screen offers Google as the one primary provider', async () => {
    const h = await ready();
    expect(document.getElementById('home-sign-in')?.className).toBe('jp-provider primary');
    expect(document.getElementById('home-title')?.textContent).toBe('Passport Home');
    await h.signIn();
    expect(document.getElementById('home-empty')?.classList.contains('jp-empty')).toBe(true);
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
    (document.querySelector('.home-row[data-scope="s1"]') as HTMLElement).click();
    expect([...document.querySelectorAll('.home-address-label')].map((x) => x.textContent)).toEqual(['Stellar', 'Ethereum-style (Ethereum and similar networks)', 'NEAR']);
    expect(document.getElementById('home-address-near')?.textContent).toBe(NEAR);
    expect(document.getElementById('home-no-near')).toBeNull();
    const links = [...document.querySelectorAll('#app a')].map((a) => a.getAttribute('href'));
    expect(links).toEqual([`https://stellar.expert/explorer/testnet/account/${G}`, `https://testnet.nearblocks.io/address/${NEAR}`]);
    h.click('home-copy-near');
    await h.page.idle();
    expect(h.clipboard.writeText).toHaveBeenCalledWith(NEAR);
    expect([...document.querySelectorAll('.home-toasts .jp-toast')].at(-1)?.textContent).toBe('Copied the NEAR account.');
    h.click('home-back');
    (document.querySelector('.home-row[data-scope="s2"]') as HTMLElement).click();
    expect(document.getElementById('home-address-near')).toBeNull();
    expect(document.getElementById('home-no-near')?.textContent).toBe('No NEAR account on record here yet. It appears after you next sign in to this app, if the app uses NEAR.');
    expect(pageText()).not.toContain('alice.testnet');
  });

  it('shows no Support ID and no address where the API gave none', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    (document.querySelector('.home-row[data-scope="s2"]') as HTMLElement).click();
    expect(document.getElementById('home-app-title')?.textContent).toBe('Wallet details');
    expect(document.getElementById('home-app-label')?.textContent).toBe('App that uses this wallet');
    expect(document.querySelector('.home-app-all')?.textContent).toBe('App that uses this walletOld ExchangeClosed');
    expect(document.querySelector('#home-coverage .sr-only')?.textContent).toBe('Does this wallet need the app? No. ');
    expect(document.getElementById('home-support-id')).toBeNull();
    expect(pageText()).not.toContain('Support ID');
    expect(document.getElementById('home-no-address')?.textContent).toBe('Journear has no address on record for this wallet yet.');
    h.click('home-back');
    (document.querySelector('.home-row[data-scope="s4"]') as HTMLElement).click();
    // An app where the user has no wallet keeps "App details" and its label (D893: "wallet" only for the user's own).
    expect(document.getElementById('home-app-title')?.textContent).toBe('App details');
    expect(document.title).toBe('App details – Passport Home');
    expect(document.getElementById('home-app-label')?.textContent).toBe('App');
    expect(document.getElementById('home-no-address')?.textContent).toBe('Journear has no wallet on record for this Google account in this app.');
    expect(pageText()).toContain('If the app still runs, use the app itself.');
  });

  it('checks an unchecked app once when its page opens: the user’s own by its id, another by its app', async () => {
    const h = await ready();
    h.answer = () => json(200, { scopes: [mine('s1', { coverage: 'unknown' }), scope('s5', { coverage: 'unknown' })], nextCursor: null });
    await h.signIn();
    h.answer = (url) => json(200, { scopes: [url.searchParams.has('scopeId') ? mine('s1', { coverage: 'shared' }) : scope('s5', { coverage: 'none' })], nextCursor: null });
    (document.querySelector('.home-row[data-scope="s1"]') as HTMLElement).click();
    await h.page.idle();
    expect(h.appCalls().at(-1)?.url.search).toBe('?scopeId=s1');
    expect(document.querySelector('#home-coverage .badge')?.textContent).toBe('Safe if the app closes');
    h.click('home-back');
    (document.querySelector('.home-row[data-scope="s5"]') as HTMLElement).click();
    await h.page.idle();
    expect(h.appCalls().at(-1)?.url.search).toBe('?appId=app_Apps5');
    expect(document.querySelector('#home-coverage .badge')?.textContent).toBe('Can’t be opened here');
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
    expect(document.querySelector('#home-results .home-row')?.getAttribute('data-scope')).toBe('s9');
    // The results take the list's place under "Other apps" until cleared.
    expect(document.getElementById('home-results')?.closest('#home-others')).not.toBeNull();
    expect(document.getElementById('home-others-list')).toBeNull();

    h.click('home-search-clear');
    expect(document.getElementById('home-results')).toBeNull();
    expect(document.getElementById('home-others-list')).not.toBeNull();
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
    expect([...document.querySelectorAll('.home-row[data-scope]')].map((c) => c.getAttribute('data-scope'))).toEqual(['s1', 's2', 's3', 's4', 's5', 's6', 's7']);
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
    expect([...document.querySelectorAll('#home-content h1, #home-content h2')].map((x) => x.textContent)).toEqual(['Your wallets', 'The app from your link', 'Your account', 'Other apps']);
    expect(document.querySelector('#home-linked .note')?.textContent).toContain('Journear has no wallet on record for this Google account in it.');
    expect([...document.querySelectorAll('.home-row[data-scope]')].map((c) => c.getAttribute('data-scope'))).toEqual(['s1', 's8']);
    expect(document.querySelector('#home-linked .home-row > .badge')?.textContent).toBe('Safe if the app closes');
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
    expect(root.querySelector('.home-row-name')?.textContent).toBe(XSS);
    expect(root.textContent).toContain('https://ok.example');
    expect(root.textContent).not.toContain('javascript:');
    (root.querySelector('.home-row[data-scope]') as HTMLElement).click();
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
    expect(document.querySelector('#home-linked .home-row')?.getAttribute('data-scope')).toBe('s3');
    expect([...document.querySelectorAll('.home-row[data-scope]')].map((c) => c.getAttribute('data-scope'))).toEqual(['s1', 's3', 's4']);
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
    expect(document.querySelector('.home-row-name')?.textContent).toBe('Unnamed app');
    // The row is one button named by its own words (no label of the partner's beyond them).
    const open = document.querySelector('.home-row[data-scope]') as HTMLElement;
    expect(open.tagName).toBe('BUTTON');
    expect(open.getAttribute('aria-label')).toBe('Unnamed app, Safe if the app closes');
    expect(open.textContent).toContain('Unnamed app');
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
    const open = document.querySelector('.home-row[data-scope]') as HTMLElement;
    expect(open.querySelector('.home-row-name')?.textContent).toBe(shown);
    open.click();
    expect(document.querySelector('.home-app-all strong')?.textContent).toBe(shown);
    expect(pageText()).not.toContain('before Friday');
    expect(document.documentElement.outerHTML).not.toContain('hana-restore.example');
  });

  it('an app’s name is never a heading: the app page’s headings are Hana’s own words', async () => {
    const h = await ready();
    h.answer = () => json(200, { scopes: [scope('s1', { apps: [app(XSS, { appId: 'app_x1', status: 'deleted' })] })], nextCursor: null });
    await h.signIn();
    const open = document.querySelector('.home-row[data-scope]') as HTMLElement;
    expect(open.querySelector('.home-row-name')?.textContent).toBe(XSS);
    open.click();
    // D893: the view's h1 is Journear's words ("App details" here: no wallet of the user's); the move flow's screens
    // keep their h3 (home-export.ts unchanged).
    // D895: the page's sections are in the tabs' panels: "Your addresses" (Addresses), then the tools (Security),
    // then the move flow (Move wallet), now an h2 too; the apps and the coverage question are labels, not headings.
    expect([...document.querySelectorAll('#app h1, #app h2, #app h3')].map((x) => `${x.tagName} ${x.textContent}`)).toEqual([
      'H1 App details',
      'H2 Your addresses',
      'H2 Ways to sign in',
      'H2 Devices and auto-approve',
      'H2 Your name',
      'H2 Move this wallet to another wallet app',
    ]);
    expect(document.title).toBe('App details – Passport Home');
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

describe('the views and their words (D893)', () => {
  const LIST = () => json(200, { scopes: [mine('s1', { apps: [app('Sodax'), app('Sodax Earn')] }), scope('s3')], nextCursor: null });
  const row = (id: string): HTMLElement => document.querySelector(`.home-row[data-scope="${id}"]`) as HTMLElement;

  it('a row is one button: a click and the keyboard (a button’s Enter and Space are its click) open it; the badge and the names are in it', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    const r = row('s1');
    expect(r.tagName).toBe('BUTTON');
    expect(r.getAttribute('type')).toBe('button');
    expect(r.closest('li')?.parentElement?.id).toBe('home-mine-list');
    // Nothing else in the row can take focus or a click.
    expect(r.querySelectorAll('button, a, input, [tabindex]')).toHaveLength(0);
    expect(r.querySelector(':scope > .badge')?.textContent).toBe('Safe if the apps close');
    // A screen reader names the row by the apps, with pauses, and its badge; where the first app runs is its
    // description, not its name (PR 116's review).
    expect(r.textContent).toBe('Sodax · Sodax Earnhttps://app.example and 1 more websiteSafe if the apps close');
    expect(r.getAttribute('aria-label')).toBe('Sodax, Sodax Earn, Safe if the apps close');
    expect(document.getElementById(r.getAttribute('aria-describedby') ?? '')?.textContent).toBe('https://app.example and 1 more website');
    const account = document.getElementById('home-open-devices') as HTMLElement;
    expect(account.getAttribute('aria-label')).toBeNull();
    expect(document.getElementById(account.getAttribute('aria-describedby') ?? '')?.textContent).toBe(HOME_TEXT.devicesRow);
    r.focus();
    expect(document.activeElement).toBe(r);
    r.click();
    expect(h.page.view).toBe('wallet');
    expect(h.page.openScope).toBe('s1');
  });

  it('the headings and the window’s title name the view; the product’s name is in the bar only', async () => {
    const h = await ready();
    expect(document.title).toBe('Passport Home');
    h.answer = LIST;
    await h.signIn();
    const outline = (): string[] => [...document.querySelectorAll('#app h1, #app h2')].map((x) => `${x.tagName} ${x.textContent}`);
    expect(outline()).toEqual(['H1 Your wallets', 'H2 Your account', 'H2 Other apps']);
    expect(document.querySelectorAll('#app h1')).toHaveLength(1);
    expect(document.title).toBe(homeViewTitle('Your wallets'));
    expect(document.title).toBe('Your wallets – Passport Home');
    expect(pageText()).not.toContain('Passport Home');
    h.click('home-open-devices');
    await h.page.idle();
    expect(outline()[0]).toBe('H1 Devices and auto-approve');
    expect(document.querySelectorAll('#app h1')).toHaveLength(1);
    expect(document.title).toBe('Devices and auto-approve – Passport Home');
    expect(document.activeElement?.id).toBe('home-devices-title');
    h.click('home-back');
    row('s1').click();
    expect(document.querySelectorAll('#app h1')).toHaveLength(1);
    expect(document.title).toBe('Wallet details – Passport Home');
    h.click('home-back');
    row('s3').click();
    expect(document.title).toBe('App details – Passport Home');
    // Signed out: the page's name again.
    h.click('home-sign-out');
    expect(document.title).toBe('Passport Home');
    expect(document.getElementById('home-title')?.textContent).toBe('Passport Home');
  });

  it('the bar’s Sign out is named apart from “Sign out this device”', async () => {
    const h = await ready();
    await h.signIn();
    const out = document.getElementById('home-sign-out') as HTMLElement;
    expect(out.textContent).toBe('Sign out');
    expect(out.getAttribute('aria-label')).toBe('Sign out of Passport Home');
    expect(out.getAttribute('title')).toBe('Sign out of Passport Home');
    expect(HOME_TEXT.signOutName).toBe('Sign out of Passport Home');
  });

  it('“Your account” has the two rows, each its own view; the all-wallets sections are no longer on the front page', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    expect([...document.querySelectorAll('#home-your-account .home-row')].map((r) => [r.id, r.querySelector('.home-row-title')?.textContent, r.querySelector('.home-row-sub')?.textContent])).toEqual([
      ['home-open-devices', 'Devices and auto-approve', 'Where you’re signed in to your apps, and what may sign without asking'],
      ['home-open-profile', 'Your name', 'A name for your apps, if you want one. No app gets it until you share it.'],
    ]);
    expect(document.getElementById('home-devices')).toBeNull();
    expect(document.getElementById('home-profile')).toBeNull();
    // Nothing is read until a row is pressed; the row reads once.
    expect(h.deviceCalls()).toEqual([]);
    h.click('home-open-devices');
    expect(h.page.view).toBe('devices');
    expect(document.getElementById('home-back')?.textContent).toBe('Your wallets');
    await h.page.idle();
    expect(h.deviceCalls()).toHaveLength(1);
    expect(h.page.devices.front).toBe('ready');
    h.click('home-back');
    expect(document.activeElement?.id).toBe('home-open-devices');
    h.click('home-open-devices');
    await h.page.idle();
    expect(h.deviceCalls()).toHaveLength(1);
  });

  it('each group’s loading, empty and failed states', async () => {
    const h = await ready();
    let answer: ((r: Response) => void) | null = null;
    h.answer = () => new Promise<Response>((r) => (answer = r));
    await h.signInStart();
    await until(() => answer !== null, 'the list to be asked for');
    expect(h.page.list).toBe('loading');
    const loading = document.getElementById('home-loading');
    expect(loading?.querySelector('[role="status"]')?.textContent).toBe('Loading your wallets…');
    // Placeholder rows, hidden from screen readers, in "Your wallets" and "Other apps"; "Your account" is ready.
    expect(loading?.querySelector('.home-rows')?.getAttribute('aria-hidden')).toBe('true');
    expect(document.getElementById('home-others-loading')?.querySelector('.home-rows')?.getAttribute('aria-hidden')).toBe('true');
    expect(document.getElementById('home-open-devices')).not.toBeNull();
    // The search can be typed in while the list loads; the list's arrival keeps the field's focus and words.
    const typing = document.getElementById('home-search') as HTMLInputElement;
    typing.focus();
    typing.value = 'Sod';
    typing.dispatchEvent(new Event('input'));
    (answer as unknown as (r: Response) => void)(json(200, { scopes: [], nextCursor: null }));
    await h.page.idle();
    expect(document.getElementById('home-search')).not.toBe(typing);
    expect(document.activeElement?.id).toBe('home-search');
    expect((document.getElementById('home-search') as HTMLInputElement).value).toBe('Sod');
    (document.getElementById('home-search') as HTMLInputElement).value = '';
    document.getElementById('home-search')?.dispatchEvent(new Event('input'));
    expect(document.getElementById('home-empty')?.querySelector('strong')?.textContent).toBe('No wallets yet');
    expect(document.getElementById('home-others-empty')?.querySelector('strong')?.textContent).toBe('No other apps listed');
    // A search with no result says so in the same pattern.
    const input = document.getElementById('home-search') as HTMLInputElement;
    input.value = 'Nothing Here';
    input.dispatchEvent(new Event('input'));
    h.answer = () => json(200, { scopes: [], nextCursor: null });
    h.click('home-search-go');
    await h.page.idle();
    expect(document.getElementById('home-no-results')?.textContent).toBe('No app found with that nameCheck the spelling, or type the app’s whole name.');
    expect(document.getElementById('home-no-results')?.classList.contains('jp-empty')).toBe(true);
    // A refusal of the search shows under the search, where the user acted, not at the top of the page.
    h.answer = () => refusal(429, 'rate_limited');
    h.click('home-search-go');
    await h.page.idle();
    expect(document.getElementById('home-problem')?.closest('#home-others')).not.toBeNull();
    expect(document.getElementById('home-notice')?.previousElementSibling?.classList.contains('home-search-field')).toBe(true);
  });

  it('the old words are gone from every Home view, the new ones are there', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    const every: string[] = [pageText()];
    row('s1').click();
    every.push(pageText());
    h.click('home-back');
    row('s3').click();
    every.push(pageText());
    h.click('home-back');
    h.click('home-open-devices');
    await h.page.idle();
    every.push(pageText());
    h.click('home-back');
    h.click('home-open-profile');
    await h.page.idle();
    every.push(pageText());
    const all = every.join('\n');
    for (const old of ['Your apps', 'Back to all apps', 'Find an app\n', 'App name', 'Other apps that use Journear', 'Nothing here yet', 'No apps yet for this', 'Journear has no address on record for you in this app yet.', 'The sign-ins that open your wallet in this app.', 'No device is signed in to this app with Journear', 'go back to all apps', 'open the app’s page from']) {
      expect(all).not.toContain(old);
    }
    for (const now of ['Your wallets', 'Your account', 'Other apps', 'Find an app by name', 'Wallet details', 'App details', 'Apps that use this wallet', 'The sign-ins that open this wallet.', 'Where you’re signed in to this wallet']) expect(all).toContain(now);
  });
});

describe('Back and Forward inside Home (D893)', () => {
  const LIST = () => json(200, { scopes: [mine('s1'), mine('s2', { coverage: 'unknown' }), scope('s3')], nextCursor: null });
  const MARK = /^home:[A-Za-z0-9_-]{16}:1$/u;
  const row = (id: string): HTMLElement => document.querySelector(`.home-row[data-scope="${id}"]`) as HTMLElement;

  it('opening a wallet adds one entry at the same address holding only an opaque marker; Back returns to the list, Forward to the wallet; neither reads', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    const hist = h.win.history;
    expect(hist.scrollRestoration).toBe('manual');
    expect(hist.entries).toHaveLength(1);
    row('s1').click();
    expect(h.page.view).toBe('wallet');
    expect(hist.entries).toHaveLength(2);
    expect(hist.pushState).toHaveBeenCalledTimes(1);
    // No URL argument: the address never changes (D555), and nothing is assigned or replaced.
    expect(hist.pushState.mock.calls[0]).toHaveLength(2);
    expect(h.win.replaced).toEqual([]);
    expect(h.win.location.assigned).toEqual([]);
    // The marker: a random tag and the step's number; nothing of the person, the wallet or the app.
    const state = hist.state as string;
    expect(state).toMatch(MARK);
    for (const word of ['s1', 'App s1', 'sub-1', 'app_', G, EVM, 'HANA-', 'google']) expect(state).not.toContain(word);
    const calls = h.calls.length;

    hist.back();
    await flush();
    expect(h.page.view).toBe('front');
    expect(document.getElementById('home-title')?.textContent).toBe('Your wallets');
    expect(document.title).toBe('Your wallets – Passport Home');
    // Focus returns to the row the user opened.
    expect(document.activeElement?.getAttribute('data-scope')).toBe('s1');

    hist.forward();
    await flush();
    expect(h.page.view).toBe('wallet');
    expect(h.page.openScope).toBe('s1');
    expect(document.getElementById('home-address-stellar')?.textContent).toBe(G);
    expect(document.activeElement?.id).toBe('home-app-title');
    expect(hist.entries).toHaveLength(2);
    expect(h.calls).toHaveLength(calls);

    // An unchecked wallet is checked when the user opens it, never when Back or Forward shows it again.
    hist.back();
    await flush();
    row('s2').click();
    await h.page.idle();
    expect(h.appCalls().at(-1)?.url.search).toBe('?scopeId=s2');
    const after = h.calls.length;
    hist.back();
    await flush();
    hist.forward();
    await flush();
    await h.page.idle();
    expect(h.page.openScope).toBe('s2');
    expect(h.calls).toHaveLength(after);

    // Back to the list, then Back from the list leaves Home, as before.
    hist.back();
    await flush();
    expect(hist.left).toBe(0);
    hist.back();
    expect(hist.left).toBe(1);
  });

  it('“Your wallets” goes back to the list’s own entry, so the list stays the first entry and Forward still reaches the view', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    const hist = h.win.history;
    row('s1').click();
    h.click('home-back');
    expect(hist.go).toHaveBeenLastCalledWith(-1);
    // The list is drawn at once; the browser's own popstate comes after and changes nothing.
    expect(h.page.view).toBe('front');
    await flush();
    expect(h.page.view).toBe('front');
    expect(hist.index).toBe(0);
    expect(hist.entries).toHaveLength(2);
    hist.forward();
    await flush();
    expect(h.page.openScope).toBe('s1');
    // A view opened right after the way back, before the browser's popstate, waits for it and then takes the entry after
    // the list's: still one entry past the list.
    h.click('home-back');
    row('s3').click();
    expect(h.page.openScope).toBe('s3');
    expect(document.getElementById('home-app-title')?.textContent).toBe('App details');
    await flush();
    expect(hist.index).toBe(1);
    expect(hist.entries).toHaveLength(2);
    expect(hist.state).toMatch(MARK);
    hist.back();
    await flush();
    expect(h.page.view).toBe('front');
    hist.forward();
    await flush();
    expect(h.page.openScope).toBe('s3');
  });

  it('the account views: Back returns to the list, Forward shows them again without a read; `?view=devices` opens Devices with one read and an entry', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    const hist = h.win.history;
    h.click('home-open-devices');
    await h.page.idle();
    expect(h.deviceCalls()).toHaveLength(1);
    expect(hist.state).toMatch(MARK);
    hist.back();
    await flush();
    expect(h.page.view).toBe('front');
    expect(document.activeElement?.id).toBe('home-open-devices');
    hist.forward();
    await flush();
    await h.page.idle();
    expect(h.page.view).toBe('devices');
    expect(h.deviceCalls()).toHaveLength(1);

    resetDom();
    const l = await ready({ search: '?view=devices' });
    l.answer = LIST;
    await l.signIn();
    expect(l.page.view).toBe('devices');
    expect(l.deviceCalls()).toHaveLength(1);
    expect(l.win.history.entries).toHaveLength(2);
    expect(document.activeElement?.id).toBe('home-devices-title');
    l.win.history.back();
    await flush();
    expect(l.page.view).toBe('front');
    expect(l.page.list).toBe('ready');
    // The link is the page's address: it never changed.
    expect(l.win.replaced).toEqual([]);
  });

  it('after the sign-in ends, Back and Forward move between what is on screen and read nothing; after Sign out they show nothing of the account', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    const hist = h.win.history;
    row('s1').click();
    advance(15 * MIN);
    expect(h.page.session).toBe('ended');
    const calls = h.calls.length;
    hist.back();
    await flush();
    expect(h.page.view).toBe('front');
    expect(row('s1')).not.toBeNull();
    hist.forward();
    await flush();
    expect(h.page.openScope).toBe('s1');
    expect(h.calls).toHaveLength(calls);

    // Sign out: everything goes, and the browser goes back to the page's first entry.
    h.click('home-sign-out');
    expect(hist.go).toHaveBeenLastCalledWith(-1);
    await flush();
    expect(hist.index).toBe(0);
    expect(h.page.stage).toBe('signed_out');
    for (const move of [() => hist.forward(), () => hist.back()]) {
      move();
      await flush();
      expect(h.page.stage).toBe('signed_out');
      expect(document.getElementById('home-sign-in')).not.toBeNull();
      expect(document.querySelector('.home-row')).toBeNull();
      expect(document.getElementById('home-address-stellar')).toBeNull();
      expect(document.documentElement.outerHTML).not.toContain(G);
    }
    expect(h.calls).toHaveLength(calls);
  });

  it('another account’s sign-in: the entries left by the one before show nothing of it', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn('sub-1');
    const hist = h.win.history;
    row('s1').click();
    advance(15 * MIN);
    h.answer = () => json(200, { scopes: [mine('s9')], nextCursor: null });
    await h.signIn('sub-2', 'home-sign-in-again');
    expect(h.page.view).toBe('front');
    expect(hist.go).toHaveBeenLastCalledWith(-1);
    await flush();
    expect(hist.index).toBe(0);
    // Forward reaches the first account's entry: it shows this account's list, nothing of the other's wallet.
    hist.forward();
    await flush();
    expect(h.page.view).toBe('front');
    expect(row('s9')).not.toBeNull();
    expect(document.querySelector('[data-scope="s1"]')).toBeNull();
    expect(document.getElementById('home-address-stellar')).toBeNull();
  });

  it('a reload signs out (D553): the entries the page before left show the signed-out page, and after a sign-in only the list', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    row('s1').click();
    const old = h.win.history.state;
    expect(old).toMatch(MARK);
    // The reloaded page: a new page on the same entries, with nothing in memory.
    resetDom();
    const r = start();
    r.win.history.entries.push({ state: old });
    r.win.history.index = 1;
    await r.page.idle();
    for (const move of [() => r.win.history.back(), () => r.win.history.forward()]) {
      move();
      await flush();
      expect(r.page.stage).toBe('signed_out');
    }
    r.answer = LIST;
    await r.signIn();
    r.win.history.back();
    await flush();
    expect(r.page.view).toBe('front');
    r.win.history.forward();
    await flush();
    // The old entry's tag isn't this sign-in's: it is the list, never the wallet it was.
    expect(r.page.view).toBe('front');
    expect(r.page.openScope).toBeNull();
  });

  it('a browser that refuses a new entry: the view still opens, and the way back draws the list without going back in history', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    const hist = h.win.history;
    hist.pushState.mockImplementationOnce(() => {
      throw new DOMException('Too many calls', 'SecurityError');
    });
    row('s1').click();
    expect(h.page.view).toBe('wallet');
    expect(hist.entries).toHaveLength(1);
    h.click('home-back');
    expect(hist.go).not.toHaveBeenCalled();
    expect(h.page.view).toBe('front');
  });

  it('keeps nothing: no storage, and the history entries hold only the marker', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    row('s1').click();
    h.click('home-back');
    await flush();
    h.click('home-open-profile');
    await h.page.idle();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(h.win.history.entries.map((e) => e.state)).toEqual([null, expect.stringMatching(MARK)]);
    expect(h.win.history.pushState.mock.calls.every((c) => c.length === 2 && typeof c[0] === 'string' && MARK.test(c[0] as string))).toBe(true);
  });
});


describe('PR 116’s review (D893)', () => {
  const row = (id: string): HTMLElement => document.querySelector(`.home-row[data-scope="${id}"]`) as HTMLElement;

  it('the link’s wallet never pulls the person out of a view they opened while the list loaded; it stays a row', async () => {
    const h = await ready({ search: '?appId=app_mine1' });
    let answer: ((r: Response) => void) | null = null;
    h.answer = () => new Promise<Response>((r) => (answer = r));
    await h.signInStart();
    await until(() => answer !== null, 'the list to be asked for');
    h.click('home-open-devices');
    expect(h.page.view).toBe('devices');
    (answer as unknown as (r: Response) => void)(json(200, { scopes: [mine('s1', { apps: [app('Mine', { appId: 'app_mine1' })] })], nextCursor: null }));
    await h.page.idle();
    expect(h.page.view).toBe('devices');
    expect(h.win.history.entries).toHaveLength(2);
    expect(h.win.history.state).toMatch(/^home:[A-Za-z0-9_-]{16}:1$/u);
    h.win.history.back();
    await flush();
    expect(h.page.view).toBe('front');
    expect(row('s1')).not.toBeNull();
    // On the front page, the link's wallet opens as before (one entry over the list).
    resetDom();
    const f = await ready({ search: '?appId=app_mine1' });
    f.answer = () => json(200, { scopes: [mine('s1', { apps: [app('Mine', { appId: 'app_mine1' })] })], nextCursor: null });
    await f.signIn();
    expect(f.page.openScope).toBe('s1');
    expect(f.win.history.entries).toHaveLength(2);
  });

  it('an app where the person has no wallet keeps the app’s words in its tools: no wallet is called theirs', async () => {
    const h = await ready();
    h.answer = () => json(200, { scopes: [mine('s1'), scope('s3')], nextCursor: null });
    await h.signIn();
    row('s3').click();
    expect(document.getElementById('home-app-title')?.textContent).toBe('App details');
    expect(document.querySelector('#home-app-devices > p')?.textContent).toBe('Where you’re signed in to this app with Journear, what those devices may sign without asking, and whether you share your email with it.');
    expect(document.querySelector('#home-sign-ins > p')?.textContent).toBe('The sign-ins that open a wallet in this app, if you have one.');
    h.click('home-back');
    row('s1').click();
    expect(document.querySelector('#home-app-devices > p')?.textContent).toContain('signed in to this wallet');
    expect(document.querySelector('#home-sign-ins > p')?.textContent).toBe('The sign-ins that open this wallet.');
  });

  it('a view opened while the page’s own Back is on its way waits for it, however late: no flip back to the list', async () => {
    const h = await ready();
    h.answer = () => json(200, { scopes: [mine('s1'), scope('s3')], nextCursor: null });
    await h.signIn();
    const hist = h.win.history;
    row('s1').click();
    hist.hold = true;
    h.click('home-back');
    row('s3').click();
    // The browser is slow: well past a second, the traversal hasn't landed and no entry was added during it.
    advance(5_000);
    expect(hist.entries).toHaveLength(2);
    expect(hist.index).toBe(0);
    hist.hold = false;
    hist.release();
    await flush();
    expect(h.page.openScope).toBe('s3');
    expect(hist.index).toBe(1);
    expect(hist.state).toMatch(/^home:[A-Za-z0-9_-]{16}:1$/u);
    hist.back();
    await flush();
    expect(h.page.view).toBe('front');
  });

  it('a traversal that never lands: after 10 s the view keeps no entry, and a popstate that comes even later changes nothing', async () => {
    const h = await ready();
    h.answer = () => json(200, { scopes: [mine('s1'), scope('s3')], nextCursor: null });
    await h.signIn();
    const hist = h.win.history;
    row('s1').click();
    hist.hold = true;
    h.click('home-back');
    row('s3').click();
    advance(11_000);
    hist.hold = false;
    hist.release();
    await flush();
    expect(h.page.openScope).toBe('s3');
    expect(hist.index).toBe(0);
  });
});


describe('a wallet’s tabs (D895)', () => {
  const LIST = () => json(200, { scopes: [mine('s1'), scope('s3')], nextCursor: null });
  const MARK = (n: number) => new RegExp(`^home:[A-Za-z0-9_-]{16}:${n}$`, 'u');
  const tab = (which: string): HTMLElement => document.getElementById(`home-tab-${which}`) as HTMLElement;
  const panel = (which: string): HTMLElement => document.getElementById(`home-panel-${which}`) as HTMLElement;
  const key = (el: HTMLElement, k: string): void => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  };

  it('Addresses, Security and Move wallet as tabs: roles, names, one open, Addresses first', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    (document.querySelector('.home-row[data-scope="s1"]') as HTMLElement).click();
    const list = document.querySelector('[role="tablist"]') as HTMLElement;
    expect(list.getAttribute('aria-label')).toBe('This wallet');
    expect([...list.querySelectorAll('[role="tab"]')].map((t) => [t.id, t.textContent, t.getAttribute('aria-selected'), t.getAttribute('tabindex'), t.getAttribute('aria-controls')])).toEqual([
      ['home-tab-addresses', 'Addresses', 'true', '0', 'home-panel-addresses'],
      ['home-tab-security', 'Security', 'false', '-1', 'home-panel-security'],
      ['home-tab-move', 'Move wallet', 'false', '-1', 'home-panel-move'],
    ]);
    for (const which of ['addresses', 'security', 'move']) {
      expect(panel(which).getAttribute('role')).toBe('tabpanel');
      expect(panel(which).getAttribute('aria-labelledby')).toBe(`home-tab-${which}`);
    }
    expect([panel('addresses').hidden, panel('security').hidden, panel('move').hidden]).toEqual([false, true, true]);
    expect(panel('addresses').contains(document.getElementById('home-address-stellar'))).toBe(true);
    expect(panel('security').contains(document.getElementById('home-sign-ins'))).toBe(true);
    expect(panel('move').contains(document.getElementById('home-export'))).toBe(true);
    expect(h.page.tab).toBe('addresses');
    // An app where the person has no wallet: the same tabs, its list named for the app.
    h.click('home-back');
    (document.querySelector('.home-row[data-scope="s3"]') as HTMLElement).click();
    expect(document.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe('This app');
  });

  it('the arrow keys, Home and End move between the tabs without opening one; Enter or Space (a click) opens it', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    (document.querySelector('.home-row[data-scope="s1"]') as HTMLElement).click();
    tab('addresses').focus();
    key(tab('addresses'), 'ArrowRight');
    expect(document.activeElement?.id).toBe('home-tab-security');
    expect(tab('security').getAttribute('tabindex')).toBe('0');
    expect(tab('addresses').getAttribute('tabindex')).toBe('-1');
    expect(h.page.tab).toBe('addresses');
    key(tab('security'), 'End');
    expect(document.activeElement?.id).toBe('home-tab-move');
    key(tab('move'), 'ArrowRight');
    expect(document.activeElement?.id).toBe('home-tab-addresses');
    key(tab('addresses'), 'ArrowLeft');
    expect(document.activeElement?.id).toBe('home-tab-move');
    key(tab('move'), 'Home');
    expect(document.activeElement?.id).toBe('home-tab-addresses');
    expect(h.win.history.entries).toHaveLength(2);
    // A button's Enter and Space are its click.
    tab('security').click();
    expect(h.page.tab).toBe('security');
    expect(tab('security').getAttribute('aria-selected')).toBe('true');
    expect(panel('security').hidden).toBe(false);
    expect(panel('addresses').hidden).toBe(true);
    expect(document.activeElement?.id).toBe('home-tab-security');
  });

  it('each tab opened is a history entry: Back and Forward move between tabs, then to the list; nothing is read', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    const hist = h.win.history;
    (document.querySelector('.home-row[data-scope="s1"]') as HTMLElement).click();
    const calls = h.calls.length;
    tab('security').click();
    expect(hist.state).toMatch(MARK(2));
    tab('move').click();
    expect(hist.state).toMatch(MARK(3));
    expect(hist.entries).toHaveLength(4);
    hist.back();
    await flush();
    expect(h.page.tab).toBe('security');
    expect(document.activeElement?.id).toBe('home-tab-security');
    hist.back();
    await flush();
    expect(h.page.tab).toBe('addresses');
    hist.forward();
    await flush();
    expect(h.page.tab).toBe('security');
    // The same tab again adds nothing.
    tab('security').click();
    expect(hist.entries).toHaveLength(4);
    // "Your wallets" goes back to the list's own entry, however many tabs were opened.
    h.click('home-back');
    expect(hist.go).toHaveBeenLastCalledWith(-2);
    await flush();
    expect(h.page.view).toBe('front');
    expect(hist.index).toBe(0);
    expect(h.calls).toHaveLength(calls);
    // Opening the wallet again starts on Addresses.
    (document.querySelector('.home-row[data-scope="s1"]') as HTMLElement).click();
    expect(h.page.tab).toBe('addresses');
  });
});

describe('the phone’s “Sign in again” chip (D895, as revised after PR 122’s review)', () => {
  const LIST = () => json(200, { scopes: [mine('s1'), scope('s3')], nextCursor: null });
  const rect = (top: number, height: number, left = 0, width = 390): DOMRect => ({ top, bottom: top + height, left, right: left + width, width, height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
  const frame = (): Promise<void> => new Promise((r) => setImmediate(r));
  const shown = (): boolean => document.getElementById('home-again-chip')?.hasAttribute('data-shown') === true;

  it('shows once the notice offers "Sign in again" and is out of view, and stays: on the list, Addresses and Security, over controls too; room at the foot while it shows', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    const chip = document.getElementById('home-again-chip') as HTMLElement;
    expect(chip.closest('#app')).toBeNull();
    chip.getBoundingClientRect = () => rect(window.innerHeight - 60, 44, 120, 150);
    const banner = document.getElementById('home-banner') as HTMLElement;
    banner.getBoundingClientRect = () => rect(-200, 60);
    expect(shown()).toBe(false);
    expect(document.body.classList.contains('home-chip-on')).toBe(false);
    advance(13 * MIN + 1000);
    // The list, mid-page: shown, with room at the page's foot.
    expect(shown()).toBe(true);
    expect(document.body.classList.contains('home-chip-on')).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--home-chip-space')).toBe('76px');
    // A control under it changes nothing: it stays (no flicker).
    (document.querySelector('#app button') as HTMLElement).getBoundingClientRect = () => rect(790, 32, 140, 80);
    window.dispatchEvent(new Event('scroll'));
    await frame();
    expect(shown()).toBe(true);
    // A wallet's Addresses and Security.
    (document.querySelector('.home-row[data-scope="s1"]') as HTMLElement).click();
    expect(h.page.tab).toBe('addresses');
    expect(shown()).toBe(true);
    h.click('home-tab-security');
    expect(shown()).toBe(true);
    // The notice in view: gone, and so is the room.
    banner.getBoundingClientRect = () => rect(70, 60);
    window.dispatchEvent(new Event('scroll'));
    await frame();
    expect(shown()).toBe(false);
    expect(document.body.classList.contains('home-chip-on')).toBe(false);
    // Hidden, it takes no click or focus: `visibility: hidden` (home.css) unless data-shown; it is a real button only when shown.
    expect(chip.getAttribute('data-shown')).toBeNull();
  });

  it('never on “Move wallet”, in any screen of the flow, even when the flow changes screen with no scroll', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    (document.getElementById('home-again-chip') as HTMLElement).getBoundingClientRect = () => rect(780, 44, 120, 150);
    (document.getElementById('home-banner') as HTMLElement).getBoundingClientRect = () => rect(-200, 60);
    (document.querySelector('.home-row[data-scope="s1"]') as HTMLElement).click();
    h.click('home-tab-move');
    advance(13 * MIN + 1000);
    expect(document.getElementById('home-ending')).not.toBeNull();
    expect(shown()).toBe(false);
    h.click('home-export-open');
    expect(shown()).toBe(false);
    // Back to Security: it shows; Forward to Move wallet: it goes, with no scroll event.
    h.click('home-tab-security');
    expect(shown()).toBe(true);
    h.win.history.back();
    await flush();
    expect(h.page.tab).toBe('move');
    expect(shown()).toBe(false);
  });

  it('pressed: up to the notice, focus on its "Sign in again"; it leaves nothing; signed out it goes', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    (document.getElementById('home-again-chip') as HTMLElement).getBoundingClientRect = () => rect(780, 44, 120, 150);
    (document.getElementById('home-banner') as HTMLElement).getBoundingClientRect = () => rect(-200, 60);
    (document.querySelector('.home-row[data-scope="s1"]') as HTMLElement).click();
    h.click('home-tab-security');
    advance(13 * MIN + 1000);
    const chip = document.getElementById('home-again-chip') as HTMLElement;
    expect(chip.textContent).toContain('Sign in again');
    expect(document.getElementById(chip.getAttribute('aria-describedby') ?? '')?.textContent?.trim()).toBe('Your sign-in to Passport Home ends soon.');
    const scrolled = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    chip.click();
    expect(scrolled).toHaveBeenCalledWith(0, 0);
    expect(document.activeElement?.id).toBe('home-sign-in-again');
    expect(h.page.view).toBe('wallet');
    expect(h.page.tab).toBe('security');
    advance(2 * MIN + 1000);
    expect(document.getElementById('home-again-chip-why')?.textContent?.trim()).toBe('Your sign-in to Passport Home has ended.');
    h.click('home-sign-out');
    expect(shown()).toBe(false);
    expect(document.body.classList.contains('home-chip-on')).toBe(false);
  });
});

describe('PR 122’s review: Back between tabs and the tab stop', () => {
  const LIST = () => json(200, { scopes: [mine('s1')], nextCursor: null });
  const rect = (top: number, height: number): DOMRect => ({ top, bottom: top + height, left: 0, right: 390, width: 390, height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

  it('Back or Forward to a tab with the tab list above the window brings it back into view (smooth only without reduced motion)', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    (document.querySelector('.home-row[data-scope="s1"]') as HTMLElement).click();
    document.getElementById('home-tab-security')?.click();
    const scrolled = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 900 });
    // Every redraw makes a new list: wherever it is drawn, it is 400 px above the window's top.
    const orig = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      return this.classList.contains('home-tabs') ? rect(-400, 48) : orig.call(this);
    };
    h.win.history.back();
    await flush();
    expect(h.page.tab).toBe('addresses');
    expect(scrolled).toHaveBeenLastCalledWith({ top: 492, behavior: 'smooth' });
    expect(document.activeElement?.id).toBe('home-tab-addresses');
    // Reduced motion: no smooth scroll.
    const realMatch = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    h.win.history.forward();
    await flush();
    expect(h.page.tab).toBe('security');
    expect(scrolled).toHaveBeenLastCalledWith({ top: 492, behavior: 'auto' });
    // A tab opened by a click doesn't scroll (the person is at the tabs).
    scrolled.mockClear();
    document.getElementById('home-tab-addresses')?.click();
    expect(scrolled).not.toHaveBeenCalled();
    HTMLElement.prototype.getBoundingClientRect = orig;
    window.matchMedia = realMatch;
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
  });

  it('focus leaving the tab list puts the tab stop back on the open tab', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    (document.querySelector('.home-row[data-scope="s1"]') as HTMLElement).click();
    const tab = (w: string) => document.getElementById(`home-tab-${w}`) as HTMLElement;
    tab('addresses').focus();
    tab('addresses').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(tab('security').getAttribute('tabindex')).toBe('0');
    expect(tab('addresses').getAttribute('tabindex')).toBe('-1');
    // Focus moves within the list: nothing resets.
    tab('security').dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: tab('move') }));
    expect(tab('security').getAttribute('tabindex')).toBe('0');
    // Focus leaves the list: the open tab (Addresses) is the stop again.
    tab('security').dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: document.getElementById('home-back') }));
    expect(tab('addresses').getAttribute('tabindex')).toBe('0');
    expect(tab('security').getAttribute('tabindex')).toBe('-1');
    expect(tab('move').getAttribute('tabindex')).toBe('-1');
  });
});

describe('D897: the Security tab’s reads, and the badges of a shared wallet', () => {
  const LIST = () => json(200, { scopes: [mine('s1', { apps: [app('Sodax'), app('Sodax Earn')] }), mine('s2')], nextCursor: null });

  it('opening Security reads the wallet’s devices once; Back and Forward to it read nothing; another visit reads again', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    h.devicesAnswer = () => json(200, { scopes: [{ scopeId: 's1', apps: [{ appId: 'app_Sodax', name: 'Sodax', status: 'active' }], devices: [], consents: [], email: [], more: false, canStop: true }], nextCursor: null });
    (document.querySelector('.home-row[data-scope="s1"]') as HTMLElement).click();
    expect(h.deviceCalls()).toHaveLength(0);
    h.click('home-tab-security');
    await h.page.idle();
    expect(h.deviceCalls().map((c) => c.url.search)).toEqual(['?scopeId=s1']);
    expect(document.getElementById('home-app-devices-summary')?.textContent).toBe('Not signed in to this wallet anywhere right now.');
    // The other sections read nothing until asked.
    expect(h.nameCalls()).toHaveLength(0);
    h.click('home-tab-addresses');
    h.click('home-tab-security');
    await h.page.idle();
    h.win.history.back();
    await flush();
    h.win.history.forward();
    await flush();
    await h.page.idle();
    expect(h.page.tab).toBe('security');
    expect(h.deviceCalls()).toHaveLength(1);
    h.click('home-back');
    await flush();
    (document.querySelector('.home-row[data-scope="s1"]') as HTMLElement).click();
    h.click('home-tab-security');
    await h.page.idle();
    expect(h.deviceCalls()).toHaveLength(2);
  });

  it('a wallet two apps share reads "the apps" in its badge and its answer; one app keeps "the app"', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    expect(document.querySelector('.home-row[data-scope="s1"] > .badge')?.textContent).toBe('Safe if the apps close');
    expect(document.querySelector('.home-row[data-scope="s2"] > .badge')?.textContent).toBe('Safe if the app closes');
    (document.querySelector('.home-row[data-scope="s1"]') as HTMLElement).click();
    expect(document.querySelector('#home-coverage .badge')?.textContent).toBe('Safe if the apps close');
    // The answer's "No." is read with the question, before the badge; not shown.
    expect(document.querySelector('#home-coverage > .sr-only')?.textContent).toBe('Does this wallet need these apps? No. ');
    expect(document.querySelector('#home-coverage .home-coverage-text')?.textContent).toBe('If these apps shut down, you can still sign in to this wallet through Journear.');
    expect([...document.querySelector('#home-coverage')!.children].map((c) => c.className.split(' ')[0])).toEqual(['sr-only', 'badge', 'home-coverage-text']);
    expect(coverageText('partner_client', true, false, 2).badge).toBe('Needs the apps');
    expect(coverageText('partner_client', true, false, 1).badge).toBe('Needs the app');
  });
});

describe('the shell (D888)', () => {
  const LIST = () => json(200, { scopes: [mine('s1'), scope('s3')], nextCursor: null });

  it('one header outside the page’s content: who is signed in and Sign out in it while signed in (no nav: it holds no navigation), nothing of them after sign-out', async () => {
    const h = await ready();
    const headers = document.querySelectorAll('header');
    expect(headers).toHaveLength(1);
    expect(headers[0]?.closest('#app')).toBeNull();
    // Signed out: the bar has no account part and no notice.
    const account = document.getElementById('home-account') as HTMLElement;
    expect(account.closest('header')).toBe(headers[0]);
    expect(account.textContent).toBe('');
    expect(document.getElementById('home-banner')?.textContent).toBe('');
    h.answer = LIST;
    await h.signIn();
    expect(document.querySelector('nav')).toBeNull();
    expect(account.querySelector('#home-who')?.textContent).toBe('Signed in with Google');
    expect(account.querySelector('#home-sign-out')).not.toBeNull();
    // The page's content has its heading, no second header, and none of the bar's parts.
    expect(document.querySelector('#app header, #app #home-who, #app #home-sign-out, #app #home-banner')).toBeNull();
    expect(document.getElementById('home-title')?.closest('#app')).not.toBeNull();
    h.click('home-sign-out');
    expect(account.textContent).toBe('');
    expect(document.getElementById('home-who')).toBeNull();
    expect(document.querySelectorAll('header')).toHaveLength(1);
  });

  it('the notice is a row of the bar: it sits after who is signed in, inside the header, never over the page', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    const header = document.querySelector('header') as HTMLElement;
    const notice = document.getElementById('home-banner')?.parentElement as HTMLElement;
    expect(notice.parentElement).toBe(header);
    expect(notice.previousElementSibling?.id).toBe('home-account');
    expect(notice.nextElementSibling).toBeNull();
  });

  it('a sign-in again that fails is said in the bar’s notice, where it was started, not at the top of the page', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    advance(15 * MIN);
    // The browser blocks the window.
    h.win.openResult = null;
    h.click('home-sign-in-again');
    expect(h.page.errorCode).toBe('popup_blocked');
    expect(document.getElementById('home-notice')?.textContent).toBe('');
    const failed = document.getElementById('home-renew-problem') as HTMLElement;
    expect(failed.closest('#home-banner')).not.toBeNull();
    expect(failed.textContent).toContain('Your browser blocked the sign-in window.');
    // The ended notice and its Sign in again stay under it.
    expect(document.getElementById('home-ended')).not.toBeNull();
    // Dismiss takes it away; a new attempt clears it too.
    (failed.querySelector('button.link') as HTMLElement).click();
    expect(document.getElementById('home-renew-problem')).toBeNull();
    expect(h.page.errorCode).toBeNull();
  });

  it('the notice is in the bar, a live region kept for the page’s life; it never touches the page’s content', async () => {
    const h = await ready();
    const banner = document.getElementById('home-banner');
    expect(banner?.getAttribute('aria-live')).toBe('polite');
    expect(banner?.closest('header')).not.toBeNull();
    h.answer = LIST;
    await h.signIn();
    const app = document.getElementById('app')?.innerHTML;
    advance(15 * MIN - HOME_EXPIRY_WARN_MS);
    expect(document.getElementById('home-ending')?.closest('#home-banner')).toBe(banner);
    advance(HOME_EXPIRY_WARN_MS);
    expect(document.getElementById('home-ended')?.closest('#home-banner')).toBe(banner);
    expect(document.getElementById('app')?.innerHTML).toBe(app);
    // The same element throughout: a live region that is there before it speaks.
    expect(document.getElementById('home-banner')).toBe(banner);
  });

  it('a skip link before the bar moves focus into the page and never follows its #app', async () => {
    await ready();
    const skip = document.body.firstElementChild as HTMLAnchorElement;
    expect(skip.tagName).toBe('A');
    expect(skip.textContent).toBe('Skip to content');
    expect(skip.getAttribute('href')).toBe('#app');
    expect(skip.nextElementSibling?.tagName).toBe('HEADER');
    const main = document.getElementById('app') as HTMLElement;
    expect(main.getAttribute('tabindex')).toBe('-1');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    skip.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(main);
  });

  it('D895: the copy line takes no space until a copy fails (Copy and the guarded buttons are on different tabs now)', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    (document.querySelector('.home-row[data-scope="s1"]') as HTMLElement).click();
    const line = document.getElementById('home-copied') as HTMLElement;
    const box = line.parentElement as HTMLElement;
    expect(box.classList.contains('reserved')).toBe(false);
    expect(box.classList.contains('home-copied-box')).toBe(true);
    expect(box.querySelectorAll(':scope > .sizer')).toHaveLength(0);
    expect(line.getAttribute('role')).toBe('status');
    expect(line.textContent).toBe('');
    // The addresses and the Support ID sit side by side where there is room; the per-app tools come after the line.
    expect(document.querySelector('.home-app-split > .home-app-addresses + .home-support')).not.toBeNull();
    expect(box.nextElementSibling).toBeNull();
    // D895: the line is in the Addresses tab's panel; the tools are in Security's, after it.
    expect(document.getElementById('home-panel-addresses')?.contains(box)).toBe(true);
    expect(document.getElementById('home-panel-security')?.contains(document.getElementById('home-app-extras'))).toBe(true);
  });
});

describe('the sign-in’s end', () => {
  const LIST = () => json(200, { scopes: [mine('s1'), scope('s3')], nextCursor: 's3' });

  it('warns two minutes before, then ends at 15 minutes; the screen stays and nothing is fetched', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    (document.querySelector('.home-row[data-scope="s1"]') as HTMLElement).click();
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
    expect([...document.querySelectorAll('.home-row[data-scope]')].map((c) => c.getAttribute('data-scope'))).toEqual(['s1', 's3']);
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
    expect([...document.querySelectorAll('.home-row[data-scope]')].map((c) => c.getAttribute('data-scope'))).toEqual(['s1', 's3']);
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
    (document.querySelector('.home-row[data-scope="s1"]') as HTMLElement).click();
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
    expect([...document.querySelectorAll('.home-row[data-scope]')].map((c) => c.getAttribute('data-scope'))).toEqual(['s2']);
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
    await until(() => document.querySelector('.home-row[data-scope="s2"]') !== null, 'account B’s list');
    expect([...document.querySelectorAll('.home-row[data-scope]')].map((c) => c.getAttribute('data-scope'))).toEqual(['s2']);
    release(json(200, { scopes: [mine('s7', { apps: [app('A secret app')], supportId: 'HANA-ZZZZ-ZZZZ' })], nextCursor: null }));
    await h.page.idle();
    await tick();
    expect(pageText()).not.toContain('A secret app');
    expect(document.documentElement.outerHTML).not.toContain('HANA-ZZZZ-ZZZZ');
    expect([...document.querySelectorAll('.home-row[data-scope]')].map((c) => c.getAttribute('data-scope'))).toEqual(['s2']);
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
    expect([...document.querySelectorAll('.home-row[data-scope]')]).toHaveLength(2);
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
    expect([...document.querySelectorAll('.home-row[data-scope]')]).toHaveLength(2);
  });

  it('keeps the sign-in in memory only: no storage, no URL, no log', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    (document.querySelector('.home-row[data-scope="s1"]') as HTMLElement).click();
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
    [429, 'home_busy', 'Passport Home has reached its limit for today. Try again tomorrow.'],
    [429, 'rate_limited', 'Too many requests. Wait a minute and try again.'],
    [403, 'home_account_mismatch', 'Sign in as the same account you used in Passport Home.'],
    [409, 'link_pending', 'A sign-in method is still being added to this wallet. Try again once that has finished.'],
    [409, 'counter_reused', 'That request was already sent. Try again.'],
    [503, 'home_directory_unavailable', 'Passport Home is not reachable right now. Nothing on screen was lost. Try again in a moment.'],
    [503, 'rate_limiter_unavailable', 'Passport Home is not reachable right now. Nothing on screen was lost. Try again in a moment.'],
    [502, 'near_unavailable', 'Passport Home is not reachable right now. Nothing on screen was lost. Try again in a moment.'],
    [500, 'something_new', 'Passport Home is not reachable right now. Nothing on screen was lost. Try again in a moment.'],
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
    // D893: the group says what failed, with the refusal and "Try again" together, never a lone button.
    const alert = document.getElementById('home-list-failed');
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert?.closest('#home-mine')).not.toBeNull();
    expect(alert?.querySelector('strong')?.textContent).toBe('Your wallets didn’t load');
    expect(alert?.textContent).toContain('Passport Home is not reachable right now.');
    expect([...(alert?.querySelectorAll('.code') ?? [])].map((x) => x.textContent)).toEqual(['Error code (for support): home_directory_unavailable', 'Request ID (for support): req_9']);
    expect(document.getElementById('home-reload')?.closest('#home-list-failed')).toBe(alert);
    // "Other apps" says its list didn't load either; the search still works.
    expect(document.getElementById('home-others-failed')?.textContent).toBe('The list of other apps didn’t load either. You can still find an app by name.');
    expect(document.getElementById('home-search')).not.toBeNull();
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
    expect([...document.querySelectorAll('.home-row[data-scope]')]).toHaveLength(2);
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

  it('D893: its own view under “Your account”; nothing is read at sign-in, opening the view reads once', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    expect(document.getElementById('home-profile')).toBeNull();
    expect(document.getElementById('home-open-profile')?.closest('#home-your-account')).not.toBeNull();
    expect(h.nameCalls()).toEqual([]);
    h.nameAnswer = () => json(200, { name: ADA, shares: [], more: false, app: null });
    h.click('home-open-profile');
    expect(h.page.view).toBe('profile');
    await h.page.idle();
    expect(h.nameCalls().map((c) => c.url.pathname + c.url.search)).toEqual(['/v1/home/profile']);
    expect(h.page.profile.front).toBe('ready');
    expect((document.getElementById('home-name-given') as HTMLInputElement).value).toBe('Ada');
    expect([...document.querySelectorAll('#app h1, #app h2')].map((x) => `${x.tagName} ${x.textContent}`)).toEqual(['H1 Your name', 'H2 Apps you share your name with']);
    expect(document.title).toBe('Your name – Passport Home');
    expect(document.getElementById('home-back')?.textContent).toBe('Your wallets');
    // Back on the front page and in again: what it shows stays, and nothing is read again.
    h.click('home-back');
    expect(document.activeElement?.id).toBe('home-open-profile');
    h.click('home-open-profile');
    await h.page.idle();
    expect(h.nameCalls()).toHaveLength(1);
    expect((document.getElementById('home-name-given') as HTMLInputElement).value).toBe('Ada');
  });

  it('an app’s page has it between the devices and the move, and reads ?appId= only on a click', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    (document.querySelector('.home-row[data-scope="s1"]') as HTMLElement).click();
    const extras = [...(document.getElementById('home-app-extras')?.children ?? [])].map((c) => c.id);
    // D895: the Security tab holds the ways to sign in, then the devices, then the name (option A's a3).
    expect(extras.slice(0, 3)).toEqual(['home-sign-ins', 'home-app-devices', 'home-app-profile']);
    expect(h.nameCalls()).toEqual([]);
    h.nameAnswer = (url) => json(200, { name: ADA, shares: [], more: false, app: { appId: url.searchParams.get('appId'), shared: false } });
    h.click('home-app-profile-show');
    await h.page.idle();
    expect(h.nameCalls().map((c) => c.url.search)).toEqual(['?appId=app_Apps1']);
    expect(document.getElementById('home-app-name-share-app_Apps1')?.textContent).toBe('Share my name with App s1');
    // Leaving the page closes it: back on it, it reads again only when asked.
    h.click('home-back');
    (document.querySelector('.home-row[data-scope="s1"]') as HTMLElement).click();
    expect(document.getElementById('home-app-profile-show')).not.toBeNull();
    expect(h.nameCalls()).toHaveLength(1);
  });

  it('after the 15 minutes nothing is sent: the name stays on screen, a Save asks for a new sign-in', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    h.nameAnswer = () => json(200, { name: ADA, shares: [], more: false, app: null });
    h.click('home-open-profile');
    await h.page.idle();
    advance(15 * MIN);
    expect(h.page.session).toBe('ended');
    h.click('home-name-remove');
    h.click('home-name-remove-confirm-go');
    await h.page.idle();
    expect(h.nameCalls()).toHaveLength(1);
    expect(document.getElementById('home-profile-problem-front')?.textContent).toContain('Your sign-in to Passport Home has ended.');
  });

  it('Sign out clears the name and anything typed; the next account starts with the section closed', async () => {
    const h = await ready();
    h.answer = LIST;
    await h.signIn();
    h.nameAnswer = () => json(200, { name: ADA, shares: [], more: false, app: null });
    h.click('home-open-profile');
    await h.page.idle();
    const given = document.getElementById('home-name-given') as HTMLInputElement;
    given.value = 'Typed, never saved';
    given.dispatchEvent(new Event('input', { bubbles: true }));
    h.click('home-sign-out');
    expect(document.documentElement.outerHTML).not.toContain('Lovelace');
    await h.signIn('sub-2');
    expect(h.page.profile.front).toBe('closed');
    expect(h.page.view).toBe('front');
    expect(document.getElementById('home-name-given')).toBeNull();
    expect(document.documentElement.outerHTML).not.toContain('Typed, never saved');
    expect(document.documentElement.outerHTML).not.toContain('Lovelace');
  });
});

describe('“Ways to sign in” on the page (home-sign-ins.ts, D874)', () => {
  it('sits on each app’s page, reads the chain only when asked, for the signed-in identity, and starts over for another account', async () => {
    const views: { method: string; args: unknown }[] = [];
    const h = await ready({
      view: async (s, method, args) => {
        expect(s).toBe(ENV.signer);
        views.push({ method, args });
        const a = args as { scope_id: string; provider: string; sub: string };
        return method.endsWith(':get_identity') ? { key: identityKeyHex(a.scope_id, a.provider, a.sub), status: 'own', opened: true, root: null, effective_at_ms: null, account_epoch: 0 } : null;
      },
    });
    h.answer = () => json(200, { scopes: [mine('s1')], nextCursor: null });
    await h.signIn();
    (document.querySelector('.home-row[data-scope="s1"]') as HTMLElement).click();
    await h.page.idle();
    expect(document.getElementById('home-sign-ins-title')?.textContent).toBe('Ways to sign in');
    expect(views).toEqual([]);
    expect(h.page.signIns.state).toBe('closed');
    h.click('home-sign-ins-show');
    await h.page.idle();
    const args = { scope_id: 's1', provider: 'google', sub: 'sub-1' };
    expect(views).toEqual([
      { method: 'primary:get_identity', args },
      { method: 'primary:get_account', args },
      { method: 'second:get_identity', args },
      { method: 'second:get_account', args },
    ]);
    expect(h.page.signIns.state).toBe('ready');
    expect(document.querySelector('#home-sign-ins-list > li')?.textContent).toContain('Your Google account');
    // Back and in again: what was read is shown again, nothing is read.
    h.click('home-back');
    (document.querySelector('.home-row[data-scope="s1"]') as HTMLElement).click();
    expect(h.page.signIns.state).toBe('ready');
    expect(views).toHaveLength(4);
    // Signed out, then another account: nothing of the first one's stays.
    h.click('home-sign-out');
    await h.signIn('sub-2');
    (document.querySelector('.home-row[data-scope="s1"]') as HTMLElement).click();
    expect(h.page.signIns.state).toBe('closed');
    expect(views).toHaveLength(4);
  });
});
