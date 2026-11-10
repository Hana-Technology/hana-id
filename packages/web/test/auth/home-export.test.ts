// @vitest-environment happy-dom
// Hana Home's "Move this wallet to another wallet app" (home-export.ts, on /home): the address Home opens is the
// vault's (the frozen derivation vectors, for an identity's own path and for a linked member's root); the secret is
// erased at 5 minutes and on leaving; a path only one NEAR provider gives is refused; each refusal reads as its own
// sentence; the guard and the 60 s auto-hide; and nothing is opened, relayed or derived from the page's address alone.
import { bls12_381 as bls } from '@noble/curves/bls12-381';
import {
  type RelayPayload,
  type RelayReadResponse,
  addressOfExport,
  chainAddress,
  chainPrivateKey,
  ckdAppId,
  decodeHomeIdentity,
  encryptRelayPayload,
  extractPrk,
  homeMessage,
  identityKeyHex,
  newAppKey,
  parseWindowMessage,
  sessionNonce,
  sha256,
  utf8,
} from '@hana-id/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mpcNetwork, readJson, simulateMpc } from '../../../core/test/helpers.ts';
import { homeApi } from '../../src/auth/home-api.ts';
import { HOME_EXPORT_END_TEXT, HOME_EXPORT_OFF_TEXT, HOME_EXPORT_SESSION_TTL_MS, HOME_EXPORT_TITLE, HOME_PRK_LIFETIME_MS, homeExportRoute } from '../../src/auth/home-export.ts';
import { type HomePage, coverageText, startHomePage } from '../../src/auth/home-page.ts';
import { EXPORT_CLIPBOARD_CLEAR_MS, EXPORT_CONFIRMATION, EXPORT_SHOW_MS, EXPORT_WARNING } from '../../src/auth/key-reveal.ts';
import type { NearReader } from '../../src/auth/near-rpc.ts';
import { CLIENT_ID, ENV, FakeWindow, type RemoteWindow, type TokenSigner, pageText, remoteWindow, resetDom, tokenSigner } from './helpers.ts';

/** The frozen derivation vectors: the same paths, secrets, addresses and export strings the vault is held to. */
interface Vector {
  path: string;
  sHex: string;
  prkHex: string;
  accounts: { account: number; stellar: { address: string; export: string; seedHex: string }; evm: { address: string; export: string } }[];
}
const V = readJson<{ mpc: { signer: string; mskPreimage: string; networkKey: string }; vectors: Partial<Vector>[] }>('vectors/derivation-v1.json');
const vector = (path: string): Vector => {
  const v = V.vectors.find((x) => x.path === path);
  if (!v) throw new Error(`No vector for ${path}`);
  return v as Vector;
};
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
/** The vectors' MPC network: its master key comes from their own preimage, so its answers are the vectors' secrets. */
const NET = mpcNetwork(BigInt(`0x${hex(sha256(utf8(V.mpc.mskPreimage)))}`) % bls.fields.Fr.ORDER);

const SCOPE = 's1';
const SUB = '110248495921238986420';
const OWN = `${SCOPE}#google#${SUB}#0`;
/** Another identity of the vectors: the account root a linked member's sign-in opens. */
const ROOT_SUB = '987654321';
const ROOT = `${SCOPE}#google#${ROOT_SUB}#0`;
const OWN_CLIENT = 'own-client.apps.googleusercontent.com';
const HOME_ENV = { ...ENV, signer: V.mpc.signer, ckdNetworkKey: V.mpc.networkKey, filesOrigin: 'https://files.hana.test' };
const T0 = 1_800_000_000_000;

const json = (status: number, body: unknown, requestId = 'req_1'): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-request-id': requestId } });
const refusal = (status: number, code: string): Response => json(status, { error: 'internal words', code, requestId: 'req_9' }, 'req_9');
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if (cond()) return;
    await tick();
  }
  throw new Error(`Timed out waiting for ${what}: ${pageText()}`);
}

type View = Record<string, unknown> | undefined;
type IdentityFn = (provider: string, sub: string) => View;
const member: IdentityFn = (p, s) => (p === 'google' && s === SUB ? { key: identityKeyHex(SCOPE, p, s), status: 'member', opened: false, root: { provider: 'google', sub: ROOT_SUB }, effective_at_ms: 1, account_epoch: 1 } : undefined);

interface Opts {
  search?: string;
  /** What `GET /v1/home/apps` lists. */
  scopes?: Record<string, unknown>[];
  /** The path the chain derives for the request (the contract's own resolution): the identity's, or its root's. */
  chainPath?: string;
  identity?: IdentityFn;
  /** The second provider's `get_identity`; null: the env has no second provider. */
  second?: IdentityFn | null;
  /** `scope_for_client`, `get_scope` and `get_config` answers. */
  registry?: { scopeForClient?: unknown; scope?: unknown; config?: unknown; fail?: boolean };
  login?: (body: Record<string, unknown>) => Response | Promise<Response>;
  clipboard?: null;
}

interface H {
  win: FakeWindow;
  page: HomePage;
  children: RemoteWindow[];
  fetches: { url: URL; method: string; header: string | null; body: Uint8Array | null }[];
  logins(): H['fetches'];
  nearCalls: { method: string; args: unknown; on: 'any' | 'primary' | 'second' }[];
  clipboardWrites: string[];
  setFocus(v: boolean): void;
  /** Hana Home's own sign-in, then the app's page (through the list's "View", unless the page opened it itself). */
  toApp(): Promise<void>;
  /** Expand, "Sign in again", the child's hello, and Google's answer for `sub`: false when it was refused before Google. */
  begin(sub?: string, claims?: Record<string, unknown>): Promise<boolean>;
  /** The same, waiting until the wallet is open or refused. */
  open(sub?: string, claims?: Record<string, unknown>): Promise<void>;
  /** The same, up to the wallet being open. */
  unlock(): Promise<void>;
  click(id: string): void;
  /** A user's click: the pointer moves (arming the guard), then presses and clicks. */
  press(id: string): void;
  /** A click with no pointer movement before it. */
  still(id: string): void;
  type(text: string): void;
  reveal(chain: 'stellar' | 'evm'): { secret: HTMLElement; toggle: HTMLButtonElement; copy: HTMLButtonElement };
}

let now = T0;
let guardTime = 0;
let pointerX = 0;
let signer: TokenSigner;
let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];
/** The contents of every buffer at the moment it was overwritten with zeros (hex). */
let zeroed: Set<string>;

const mineScope = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  scopeId: SCOPE,
  mine: true,
  coverage: 'shared',
  googleClientId: CLIENT_ID,
  supportId: 'HANA-AB12-CD34',
  addresses: [
    { chain: 'stellar', address: vector(OWN).accounts[0]!.stellar.address },
    { chain: 'evm', address: vector(OWN).accounts[0]!.evm.address },
  ],
  apps: [{ appId: 'app_one', name: 'Partner App', status: 'active', environment: 'live', origins: ['https://app.example'], logoUrl: null }],
  ...over,
});

function start(o: Opts = {}): H {
  const win = new FakeWindow('/home', o.search ?? '');
  const children: RemoteWindow[] = [];
  const nextChild = () => {
    const c = remoteWindow({ location: { pathname: '/login', search: '?mode=home' } as never });
    children.push(c);
    win.openResult = c;
    return c;
  };
  nextChild();
  const fetches: H['fetches'] = [];
  const nearCalls: H['nearCalls'] = [];
  const clipboardWrites: string[] = [];
  let focus = true;
  let relayResolve: ((v: RelayReadResponse) => void) | null = null;
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body instanceof Uint8Array ? Uint8Array.from(init.body) : null;
    fetches.push({ url, method: init?.method ?? 'GET', header: new Headers(init?.headers).get('x-hana-home'), body });
    if (url.pathname === '/v1/home/config') return json(200, { serverTimeMs: now, signer: HOME_ENV.signer, sharedGoogleClientId: CLIENT_ID, exitGoogleClientId: null });
    if (url.pathname === '/v1/home/apps') return json(200, { scopes: o.scopes ?? [mineScope()], nextCursor: null });
    if (url.pathname === '/v1/home/login') {
      const sent = JSON.parse(new TextDecoder().decode(body as Uint8Array)) as Record<string, unknown>;
      if (o.login) return o.login(sent);
      // The contract's answer: the MPC's key for the path the chain resolves, whatever the page thinks it is.
      const { response } = simulateMpc(sent.pk1 as string, ckdAppId(HOME_ENV.signer, o.chainPath ?? OWN), NET);
      return json(200, { result: response, session: { scope_id: SCOPE, expires_at_ms: sent.expiresAtMs, max_uses: 1, used: 1 }, nearTx: 'tx', requestId: 'req_1' });
    }
    throw new Error(`Unexpected fetch ${url.pathname}`);
  });
  const views = (identity: IdentityFn | undefined, on: 'any' | 'primary' | 'second') => async (method: string, args: unknown): Promise<unknown> => {
    nearCalls.push({ method, args, on });
    const a = args as { provider: string; sub: string; scope_id: string };
    if (o.registry?.fail && method !== 'get_identity') throw new Error('rpc down');
    if (method === 'get_identity') return identity?.(a.provider, a.sub) ?? { key: identityKeyHex(a.scope_id, a.provider, a.sub), status: 'own', opened: true, account_epoch: 0 };
    if (method === 'scope_for_client') return o.registry && 'scopeForClient' in o.registry ? o.registry.scopeForClient : SCOPE;
    if (method === 'get_scope') return o.registry && 'scope' in o.registry ? o.registry.scope : { id: SCOPE, allow_shared: true, clients: [] };
    if (method === 'get_config') return o.registry && 'config' in o.registry ? o.registry.config : { shared_clients: [['google', CLIENT_ID]] };
    return null;
  };
  const first = views(o.identity, 'any');
  const near: NearReader = {
    getSession: vi.fn(async () => null),
    txOutcome: vi.fn(async () => ({ status: 'pending' as const })),
    view: vi.fn(async (_signer: string, method: string, args: unknown) => first(method, args)),
    independent: vi.fn(() => (o.second === null ? null : { primary: views(o.identity, 'primary'), second: views(o.second ?? o.identity, 'second') })),
  };
  const page = startHomePage({
    win,
    env: HOME_ENV,
    api: homeApi(ENV.apiUrl, fetchFn as unknown as typeof fetch),
    relay: {
      readRelay: () =>
        new Promise<RelayReadResponse>((resolve) => {
          relayResolve = resolve;
        }),
    },
    near,
    jwks: async (kid) => (kid === signer.jwk.kid ? signer.jwk : null),
    deviceNow: () => now,
    sleep: async () => {},
    isGesture: () => true,
    clipboard: o.clipboard === null ? null : { writeText: async (t: string) => void clipboardWrites.push(t) },
    hasFocus: () => focus,
    // The guard's clock: 2 s on per read, so its 1 s waits are always over; the arming gesture is still needed.
    guardNow: () => (guardTime += 2000),
  });
  const el = (id: string): HTMLElement => {
    const e = document.getElementById(id);
    if (!e) throw new Error(`No #${id} on the page: ${pageText()}`);
    return e;
  };
  /** Answers the child's hello and relays Google's answer for the nonce the page sent it. */
  const answer = async (claims: Record<string, unknown>, aud: string): Promise<void> => {
    const child = children.at(-1) as RemoteWindow;
    win.message({ v: 1, t: 'hana:auth-hello' }, ENV.authOrigin, child);
    const p = child.received.at(-1) as { nonce: string; relayKey: Uint8Array; relayId: string } | undefined;
    if (!p) throw new Error('Nothing was posted to the child');
    await until(() => relayResolve !== null, 'a relay read');
    const payload: RelayPayload = { idToken: await signer.sign({ iss: 'https://accounts.google.com', aud, sub: SUB, nonce: p.nonce, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 3600, ...claims }) };
    const value = await encryptRelayPayload(p.relayKey, p.relayId, payload);
    const resolve = relayResolve as unknown as (v: RelayReadResponse) => void;
    relayResolve = null;
    resolve({ ...value, serverTimeMs: now });
  };
  const h: H = {
    win,
    page,
    children,
    fetches,
    logins: () => fetches.filter((f) => f.url.pathname === '/v1/home/login'),
    nearCalls,
    clipboardWrites,
    setFocus(v) {
      focus = v;
    },
    click: (id) => el(id).click(),
    press(id) {
      pointerX += 7;
      win.dispatch('pointermove', { pointerType: 'mouse', movementX: 3, movementY: 1, clientX: pointerX, clientY: 10 });
      win.dispatch('pointerdown', { pointerType: 'mouse', clientX: pointerX, clientY: 10 });
      el(id).dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    },
    still: (id) => void el(id).dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })),
    type(text) {
      const input = el('home-export-confirm') as HTMLInputElement;
      input.value = text;
      input.dispatchEvent(new Event('input'));
    },
    async toApp() {
      await page.idle();
      h.click('home-sign-in');
      await until(() => page.awaitingChild, 'the Home sign-in to be prepared');
      await answer({}, CLIENT_ID);
      await page.idle();
      if (page.openScope === null) (document.querySelector('.home-open') as HTMLElement).click();
      expect(page.openScope).toBe(SCOPE);
    },
    async begin(sub = SUB, claims = {}) {
      h.click('home-export-open');
      nextChild();
      h.click('home-export-start');
      await until(() => page.moving.awaitingChild || page.moving.state === 'refused', 'the per-app sign-in to be prepared');
      if (page.moving.state === 'refused') return false;
      await answer({ sub, ...claims }, (o.scopes?.[0]?.googleClientId as string | undefined) ?? CLIENT_ID);
      return true;
    },
    async open(sub = SUB, claims = {}) {
      if (!(await h.begin(sub, claims))) return;
      await until(() => page.moving.state === 'unlocked' || page.moving.state === 'refused', 'the wallet to open or be refused');
      await page.idle();
    },
    async unlock() {
      await h.toApp();
      await h.open();
      expect(page.moving.state, pageText()).toBe('unlocked');
    },
    reveal(chain) {
      h.click(chain === 'stellar' ? 'home-export-stellar' : 'home-export-evm');
      h.type(EXPORT_CONFIRMATION);
      h.press('home-export-continue');
      expect(page.moving.state).toBe('reveal');
      const section = el('home-export');
      return {
        secret: section.querySelector('.secret') as HTMLElement,
        toggle: [...section.querySelectorAll('button')].find((b) => /^(Show|Hide) key$/u.test(b.textContent ?? '')) as HTMLButtonElement,
        copy: [...section.querySelectorAll('button')].find((b) => /^(Copy key|Copied)$/u.test(b.textContent ?? '')) as HTMLButtonElement,
      };
    },
  };
  return h;
}

/** Presses a button that has no id (the reveal's own). */
function pressEl(h: H, b: HTMLElement): void {
  pointerX += 7;
  h.win.dispatch('pointermove', { pointerType: 'mouse', movementX: 3, movementY: 1, clientX: pointerX, clientY: 10 });
  h.win.dispatch('pointerdown', { pointerType: 'mouse', clientX: pointerX, clientY: 10 });
  b.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
}

function advance(ms: number): void {
  now += ms;
  vi.advanceTimersByTime(ms);
}

beforeEach(async () => {
  resetDom();
  window.localStorage.clear();
  now = T0;
  signer ??= await tokenSigner();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
  zeroed = new Set();
  const fill = Uint8Array.prototype.fill;
  vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (this: Uint8Array, ...args: unknown[]) {
    if (args[0] === 0 && args.length === 1 && this.length >= 32 && this.length <= 64) zeroed.add(hex(this));
    return (fill as (...a: unknown[]) => Uint8Array).apply(this, args);
  } as never);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the vectors’ network', () => {
  it('is the one the frozen vectors were made with, so the addresses below are the vault’s', () => {
    expect(NET.networkKey).toBe(V.mpc.networkKey);
    for (const path of [OWN, ROOT]) {
      const { expected } = simulateMpc(newAppKey().publicKey.AppPublicKeyPV.pk1, ckdAppId(V.mpc.signer, path), NET);
      expect(hex(expected)).toBe(vector(path).sHex);
      expect(chainAddress(extractPrk(expected), 'stellar', 0)).toBe(vector(path).accounts[0]!.stellar.address);
    }
  });
});

describe('golden: Hana Home opens the vault’s address', () => {
  it('for an identity’s own path: the vectors’ addresses and export strings, from one derive with key index 0 and one use', async () => {
    const h = start();
    await h.unlock();
    const want = vector(OWN).accounts[0]!;
    expect(document.getElementById('home-export-address-stellar')?.textContent).toBe(want.stellar.address);
    expect(document.getElementById('home-export-address-evm')?.textContent).toBe(want.evm.address);
    expect(document.getElementById('home-export-mismatch')).toBeNull();

    // The one request: /v1/login's fields and the scope, key index 0, one use, at most 15 minutes, no link or label.
    expect(h.logins()).toHaveLength(1);
    const call = h.logins()[0]!;
    const body = JSON.parse(new TextDecoder().decode(call.body as Uint8Array)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['expiresAtMs', 'jwt', 'keyIndex', 'maxUses', 'pk1', 'pk2', 'salt', 'scopeId', 'sessionPublicKey', 'signature']);
    expect([body.keyIndex, body.maxUses, body.scopeId]).toEqual([0, 1, SCOPE]);
    expect(body.expiresAtMs).toBe(T0 + HOME_EXPORT_SESSION_TTL_MS);
    // Signed by the Home key over exactly the bytes sent.
    const header = decodeHomeIdentity(call.header as string);
    if (!header) throw new Error('x-hana-home did not parse');
    const key = await crypto.subtle.importKey('raw', header.key as BufferSource, { name: 'Ed25519' }, false, ['verify']);
    const message = homeMessage({ signer: HOME_ENV.signer, counter: header.counter, method: 'POST', path: '/v1/home/login', body: call.body as Uint8Array });
    expect(await crypto.subtle.verify({ name: 'Ed25519' }, key, header.sig as BufferSource, message as BufferSource)).toBe(true);
    // The own path needs no second provider.
    expect(h.nearCalls.filter((c) => c.on !== 'any')).toEqual([]);

    // The keys: the vectors' export strings, each importing as the address shown.
    const s = h.reveal('stellar');
    pressEl(h, s.toggle);
    expect(s.secret.textContent).toBe(want.stellar.export);
    expect(addressOfExport('stellar', s.secret.textContent as string)).toBe(want.stellar.address);
    h.click('home-export-back');
    const e = h.reveal('evm');
    pressEl(h, e.toggle);
    expect(e.secret.textContent).toBe(want.evm.export);
    expect(addressOfExport('evm', e.secret.textContent as string)).toBe(want.evm.address);
  });

  it('for a linked member: the account root’s address (the vectors’), once both providers confirm the root', async () => {
    const h = start({ identity: member, chainPath: ROOT, scopes: [mineScope({ addresses: [{ chain: 'stellar', address: vector(ROOT).accounts[0]!.stellar.address }] })] });
    await h.unlock();
    const want = vector(ROOT).accounts[0]!;
    expect(document.getElementById('home-export-address-stellar')?.textContent).toBe(want.stellar.address);
    expect(document.getElementById('home-export-address-evm')?.textContent).toBe(want.evm.address);
    expect(want.stellar.address).not.toBe(vector(OWN).accounts[0]!.stellar.address);
    // Both providers were asked about the member and about the root, each on its own.
    for (const on of ['primary', 'second'] as const) {
      expect(h.nearCalls.filter((c) => c.on === on && c.method === 'get_identity').map((c) => (c.args as { sub: string }).sub).sort()).toEqual([SUB, ROOT_SUB].sort());
    }
    const s = h.reveal('stellar');
    pressEl(h, s.toggle);
    expect(s.secret.textContent).toBe(want.stellar.export);
  });

  it('never uses an answer for another path: a page told "own" while the chain derived the root shows nothing', async () => {
    // A lying first provider hides the link; the chain (the API's relay) still derives the root's key.
    const h = start({ chainPath: ROOT });
    await h.toApp();
    await h.open();
    expect(h.page.moving.state).toBe('refused');
    expect(h.page.moving.errorCode).toBe('pairing_failed');
    expect(h.page.moving.holdsSecret).toBe(false);
    expect(document.querySelector('.secret')).toBeNull();
  });

  it('says so when the address on record differs from the wallet’s own, and shows the wallet’s', async () => {
    const h = start({ scopes: [mineScope({ addresses: [{ chain: 'stellar', address: vector(ROOT).accounts[0]!.stellar.address }] })] });
    await h.unlock();
    expect(document.getElementById('home-export-mismatch')?.textContent).toContain('different from this wallet’s');
    expect(document.getElementById('home-export-address-stellar')?.textContent).toBe(vector(OWN).accounts[0]!.stellar.address);
  });

  it('shows the opened wallet’s addresses on the app’s page when Hana had none on record', async () => {
    const h = start({ scopes: [mineScope({ addresses: [] })] });
    await h.toApp();
    expect(document.getElementById('home-no-address')).not.toBeNull();
    await h.open();
    expect(document.getElementById('home-address-stellar')?.textContent).toBe(vector(OWN).accounts[0]!.stellar.address);
    expect(document.getElementById('home-opened-note')).not.toBeNull();
  });
});

describe('nothing starts from the page’s address', () => {
  it('?appId= of the user’s own app opens its page with the section collapsed: no window, no derive, no chain read', async () => {
    const g = start({ search: '?appId=app_one' });
    // toApp presses "View" only when the page didn't open the app itself; here it must have.
    await g.toApp();
    expect(document.getElementById('home-back')).not.toBeNull();
    expect(g.page.openScope).toBe(SCOPE);
    expect(g.page.moving.state).toBe('closed');
    expect(document.getElementById('home-export')?.textContent).toBe(HOME_EXPORT_TITLE);
    expect(document.getElementById('home-export-start')).toBeNull();
    expect(pageText()).not.toContain(EXPORT_WARNING);
    expect(g.win.opened).toHaveLength(1);
    expect(g.logins()).toEqual([]);
    expect(g.nearCalls).toEqual([]);
    expect(g.page.moving.holdsSecret).toBe(false);
  });

  it.each(['?appId=app_one&export=1', '?appId=app_one&chain=stellar', '?export=stellar', '?scopeId=s1', '?move=1'])('%s starts nothing either', async (search) => {
    const h = start({ search });
    await h.toApp();
    expect(h.page.moving.state).toBe('closed');
    expect(h.win.opened).toHaveLength(1);
    expect(h.logins()).toEqual([]);
    expect(h.nearCalls).toEqual([]);
  });

  it('an app reached by a link, with no wallet on record, is never offered: no button starts anything', async () => {
    const other = mineScope({ mine: false, supportId: undefined, addresses: [] });
    const h = start({ search: '?appId=app_one', scopes: [other] });
    await h.toApp();
    h.click('home-export-open');
    expect(document.getElementById('home-export-off')?.textContent).toBe(HOME_EXPORT_OFF_TEXT.link);
    expect(document.getElementById('home-export-start')).toBeNull();
    expect(h.win.opened).toHaveLength(1);
    expect(h.logins()).toEqual([]);
  });

  it('expanding shows the warning and still starts nothing; only "Sign in again" opens the child, in the click', async () => {
    const h = start();
    await h.toApp();
    h.click('home-export-open');
    expect(h.page.moving.state).toBe('intro');
    expect(pageText()).toContain(EXPORT_WARNING);
    expect(h.win.opened).toHaveLength(1);
    expect(h.nearCalls).toEqual([]);
    h.click('home-export-close');
    expect(h.page.moving.state).toBe('closed');
    h.click('home-export-open');
    h.click('home-export-start');
    expect(h.win.opened).toHaveLength(2);
    expect(h.win.opened[1]?.url).toBe(`${ENV.authOrigin}/login?mode=home`);
    expect(h.win.opened[1]?.target).toMatch(/^hana-home-open-[0-9a-f]{32}$/u);
    expect(h.win.opened[1]?.target).not.toBe(h.win.opened[0]?.target);
  });
});

describe('the per-app sign-in', () => {
  it('sends its child a one-use, key-index-0 session for this app and this client, and nothing else', async () => {
    const h = start();
    await h.toApp();
    h.click('home-export-open');
    const child = remoteWindow({ location: { pathname: '/login', search: '?mode=home' } as never });
    h.win.openResult = child;
    h.click('home-export-start');
    await until(() => h.page.moving.awaitingChild, 'the session');
    // A hello from anything but its own child at the sign-in address is not answered.
    h.win.message({ v: 1, t: 'hana:auth-hello' }, ENV.authOrigin, h.children[0]);
    h.win.message({ v: 1, t: 'hana:auth-hello' }, 'https://evil.example', child);
    expect(child.received).toEqual([]);
    h.win.message({ v: 1, t: 'hana:auth-hello' }, ENV.authOrigin, child);
    expect(child.postMessage.mock.calls[0]?.[1]).toBe(ENV.authOrigin);
    const p = parseWindowMessage(child.received[0], ['hana:home-derive-params']);
    if (!p) throw new Error('not home-derive-params');
    expect([p.signer, p.clientId, p.scopeId]).toEqual([HOME_ENV.signer, CLIENT_ID, SCOPE]);
    expect(p.nonce).toBe(sessionNonce({ signer: HOME_ENV.signer, scopeId: SCOPE, sessionPublicKey: p.sessionPublicKey, expiresAtMs: p.expiresAtMs, keyIndex: 0, maxUses: 1, salt: p.salt }));
    expect(p.expiresAtMs).toBe(T0 + HOME_EXPORT_SESSION_TTL_MS);
    // The registry was read by the page itself before the child was answered.
    expect(h.nearCalls.map((c) => c.method).sort()).toEqual(['get_config', 'get_scope']);
    h.click('home-export-cancel');
    expect(child.closed).toBe(true);
    expect(h.page.moving.state).toBe('intro');
  });

  it('uses the app’s own Google client where that is its route, checked on NEAR', async () => {
    const h = start({ scopes: [mineScope({ coverage: 'hana_client', googleClientId: OWN_CLIENT })] });
    await h.toApp();
    h.click('home-export-open');
    const child = remoteWindow({ location: { pathname: '/login', search: '?mode=home' } as never });
    h.win.openResult = child;
    h.click('home-export-start');
    await until(() => h.page.moving.awaitingChild, 'the session');
    expect(h.nearCalls).toEqual([{ method: 'scope_for_client', args: { provider: 'google', aud: OWN_CLIENT }, on: 'any' }]);
    h.win.message({ v: 1, t: 'hana:auth-hello' }, ENV.authOrigin, child);
    expect((child.received[0] as { clientId: string }).clientId).toBe(OWN_CLIENT);
  });

  it.each([
    ['the client is another app’s on NEAR', { scopes: [mineScope({ coverage: 'hana_client', googleClientId: OWN_CLIENT })], registry: { scopeForClient: 's2' } }, 'not_covered'],
    ['shared login is off on NEAR', { registry: { scope: { id: SCOPE, allow_shared: false } } }, 'not_covered'],
    ['the shared client isn’t in force on NEAR', { registry: { config: { shared_clients: [['google', 'other']] } } }, 'not_covered'],
    ['NEAR doesn’t know the app', { registry: { scope: null } }, 'not_covered'],
    ['NEAR can’t be read', { registry: { fail: true } }, 'near_unreadable'],
  ] as [string, Opts, string][])('stops before Google when %s: the child is closed and gets no parameters', async (_, opts, code) => {
    const h = start(opts);
    await h.toApp();
    await h.open();
    expect(h.page.moving.errorCode).toBe(code);
    const child = h.children.at(-1) as RemoteWindow;
    expect(child.closed).toBe(true);
    expect(child.received).toEqual([]);
    expect(h.logins()).toEqual([]);
  });

  it.each([
    ['exit', 'later'],
    ['email', 'later'],
    ['none', 'none'],
    ['unknown', 'unknown'],
  ] as const)('coverage %s offers no sign-in and says why', async (coverage, off) => {
    const h = start({ scopes: [mineScope({ coverage, googleClientId: null })] });
    await h.toApp();
    await h.page.idle();
    h.click('home-export-open');
    expect(document.getElementById('home-export-off')?.textContent).toBe(HOME_EXPORT_OFF_TEXT[off]);
    expect(document.getElementById('home-export-start')).toBeNull();
  });

  it('Hana Home’s own sign-in takes the child’s place: a per-app sign-in that hasn’t finished is dropped', async () => {
    const h = start();
    await h.toApp();
    h.click('home-export-open');
    const child = remoteWindow({ location: { pathname: '/login', search: '?mode=home' } as never });
    h.win.openResult = child;
    h.click('home-export-start');
    await until(() => h.page.moving.awaitingChild, 'the session');
    advance(13 * 60_000 + 1);
    h.click('home-sign-in-again');
    expect(child.closed).toBe(true);
    expect(h.page.moving.state).toBe('intro');
    expect(h.page.moving.awaitingChild).toBe(false);
  });
});

describe('the two NEAR providers (a path that isn’t the identity’s own)', () => {
  it.each([
    ['only the first provider says "member" (a lying RPC)', { identity: member, second: () => undefined } as Opts, 'path_disputed', 'NEAR providers disagree about which wallet this sign-in opens'],
    ['the env has no second provider', { identity: member, second: null } as Opts, 'path_unconfirmed', 'couldn’t confirm on NEAR which wallet this sign-in opens'],
    [
      'the providers name different roots',
      { identity: member, second: ((p, s) => (s === SUB ? { ...member(p, s), root: { provider: 'google', sub: '555' } } : undefined)) as IdentityFn } as Opts,
      'path_disputed',
      'NEAR providers disagree',
    ],
  ])('refuses when %s: nothing relayed, nothing derived', async (_, opts, code, words) => {
    const h = start({ ...opts, chainPath: ROOT });
    await h.toApp();
    await h.open();
    expect(h.page.moving.state).toBe('refused');
    expect(h.page.moving.errorCode).toBe(code);
    expect(document.getElementById('home-export-problem')?.textContent).toContain(words);
    expect(document.getElementById('home-export-problem')?.textContent).toContain(`Code: ${code}`);
    expect(h.logins()).toEqual([]);
    expect(h.page.moving.holdsSecret).toBe(false);
  });

  it('a pending link opens nothing', async () => {
    const h = start({ identity: (p, s) => ({ key: identityKeyHex(SCOPE, p, s), status: 'pending', opened: false, root: { provider: 'google', sub: ROOT_SUB }, effective_at_ms: T0 + 86_400_000, account_epoch: 1 }) });
    await h.toApp();
    await h.open();
    expect(h.page.moving.errorCode).toBe('link_pending');
    expect(h.logins()).toEqual([]);
  });
});

describe('refusals read as Hana’s own sentences', () => {
  it.each([
    [404, 'home_no_wallet', 'There is no wallet for this sign-in in that app.'],
    [429, 'home_busy', 'Hana Home has reached its limit for today. Try again tomorrow.'],
    [429, 'rate_limited', 'This wallet was opened too many times. Wait an hour and try again.'],
    [403, 'home_account_mismatch', 'Sign in as the same account you used in Hana Home.'],
    [409, 'link_pending', 'A sign-in method is still being added to this wallet. Try again once that has finished.'],
    [403, 'shared_login_disabled', 'Hana can’t open this wallet from here. If the app still runs, use the app itself.'],
    [403, 'unregistered_client', 'Hana can’t open this wallet from here. If the app still runs, use the app itself.'],
    [403, 'unknown_scope', 'Hana doesn’t know that app.'],
    [502, 'near_unavailable', 'Hana Home is not reachable right now. Nothing on screen was lost. Try again in a moment.'],
    [503, 'home_directory_unavailable', 'Hana Home is not reachable right now.'],
    [503, 'rate_limiter_unavailable', 'Hana Home is not reachable right now.'],
    [422, 'ckd_failed', 'The key service didn’t produce the key this time. Nothing was shown. Sign in again to retry.'],
    [400, 'nonce_mismatch', 'Google’s answer could not be verified. Sign in again to retry.'],
    [400, 'some_new_code', 'Something went wrong. Try again.'],
  ])('%i %s', async (status, code, sentence) => {
    const h = start({ login: () => refusal(status, code) });
    await h.toApp();
    await h.open();
    expect(h.page.moving.state).toBe('refused');
    expect(h.page.moving.errorCode).toBe(code);
    const text = document.getElementById('home-export-problem')?.textContent ?? '';
    expect(text).toContain(sentence);
    expect(text).toContain(`Code: ${code}`);
    expect(text).toContain('Request: req_9');
    expect(pageText()).not.toContain('internal words');
    // One request, never sent again by the page; nothing held; "Try again" goes back to the start, not to Google.
    expect(h.logins()).toHaveLength(1);
    expect(h.page.moving.holdsSecret).toBe(false);
    const windows = h.win.opened.length;
    h.click('home-export-again');
    expect(h.page.moving.state).toBe('intro');
    expect(h.win.opened).toHaveLength(windows);
  });

  it('a 401 ends Hana Home’s sign-in and says so', async () => {
    const h = start({ login: () => refusal(401, 'invalid_home_identity') });
    await h.toApp();
    await h.open();
    expect(h.page.session).toBe('ended');
    expect(h.page.moving.errorCode).toBe('home_signed_out');
    expect(document.getElementById('home-ended')).not.toBeNull();
    expect(h.logins()).toHaveLength(1);
  });

  it('a request that never got an answer is not sent again: NEAR is asked what happened, then it says unreachable', async () => {
    const h = start({
      login: () => {
        throw new TypeError('network');
      },
    });
    await h.toApp();
    await h.open();
    expect(h.page.moving.errorCode).toBe('api_unavailable');
    expect(h.logins()).toHaveLength(1);
  });

  it('Google signed in as another account: said here, and nothing is sent', async () => {
    const h = start();
    await h.toApp();
    await h.open('another-sub');
    expect(h.page.moving.errorCode).toBe('home_account_mismatch');
    expect(document.getElementById('home-export-problem')?.textContent).toContain('Sign in as the same account you used in Hana Home.');
    expect(h.logins()).toEqual([]);
    expect(h.nearCalls.filter((c) => c.method === 'get_identity')).toEqual([]);
  });

  it('a sign-in Google didn’t freshly ask for is refused', async () => {
    const h = start();
    await h.toApp();
    await h.open(SUB, { auth_time: Math.floor(T0 / 1000) - 3600 });
    expect(h.page.moving.errorCode).toBe('stale_sign_in');
    expect(h.logins()).toEqual([]);
  });

  it('while Hana Home’s own sign-in window is open, a per-app sign-in waits for it: no second window', async () => {
    const h = start();
    await h.toApp();
    advance(13 * 60_000 + 1);
    h.win.openResult = remoteWindow({ location: { pathname: '/login', search: '?mode=home' } as never });
    h.click('home-sign-in-again');
    expect(h.page.renewing).toBe(true);
    const windows = h.win.opened.length;
    h.click('home-export-open');
    h.click('home-export-start');
    expect(h.page.moving.errorCode).toBe('home_signing_in');
    expect(h.win.opened).toHaveLength(windows);
    expect(h.page.renewing).toBe(true);
  });

  it('a blocked pop-up says so', async () => {
    const h = start();
    await h.toApp();
    h.click('home-export-open');
    h.win.openResult = null;
    h.click('home-export-start');
    expect(h.page.moving.errorCode).toBe('popup_blocked');
  });
});

describe('the secret’s life', () => {
  const prkOf = (path: string): string => vector(path).prkHex;

  it('is erased 5 minutes after the derive: zeroed, off the screen, and Show does nothing', async () => {
    const h = start();
    await h.unlock();
    expect(h.page.moving.holdsSecret).toBe(true);
    // The CKD answer's secret was zeroed as soon as the wallet's secret was taken from it.
    expect(zeroed.has(vector(OWN).sHex)).toBe(true);
    expect(zeroed.has(prkOf(OWN))).toBe(false);
    const r = h.reveal('stellar');
    pressEl(h, r.toggle);
    expect(r.secret.textContent).toBe(vector(OWN).accounts[0]!.stellar.export);
    // The chain key lived only inside that Show.
    expect(zeroed.has(vector(OWN).accounts[0]!.stellar.seedHex)).toBe(true);
    advance(HOME_PRK_LIFETIME_MS - 1000);
    expect(h.page.moving.holdsSecret).toBe(true);
    expect(zeroed.has(prkOf(OWN))).toBe(false);
    advance(1000);
    expect(h.page.moving.holdsSecret).toBe(false);
    expect(zeroed.has(prkOf(OWN))).toBe(true);
    expect(h.page.moving.state).toBe('ended');
    expect(document.getElementById('home-export-ended')?.textContent).toBe(HOME_EXPORT_END_TEXT.expired);
    expect(pageText()).not.toContain(vector(OWN).accounts[0]!.stellar.export);
    expect(document.querySelector('.secret')).toBeNull();
    // The old reveal's button is dead, and starting again needs a new sign-in.
    pressEl(h, r.toggle);
    expect(r.secret.textContent).not.toContain('S');
    h.click('home-export-again');
    expect(h.page.moving.state).toBe('intro');
    expect(h.logins()).toHaveLength(1);
  });

  it('is erased by the server clock when the device’s timers ran late (a sleeping laptop)', async () => {
    const h = start();
    await h.unlock();
    now += HOME_PRK_LIFETIME_MS + 1;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(h.page.moving.holdsSecret).toBe(false);
    expect(zeroed.has(prkOf(OWN))).toBe(true);
    expect(h.page.moving.state).toBe('ended');
  });

  it.each([
    ['going back to the list', (h: H) => h.click('home-back'), 'closed'],
    ['signing out', (h: H) => h.click('home-sign-out'), 'closed'],
    ['the page going away (pagehide)', (h: H) => h.win.dispatch('pagehide'), 'closed'],
    ['Lock now', (h: H) => h.click('home-export-lock'), 'ended'],
  ] as const)('is erased on %s', async (_, leave, state) => {
    const h = start();
    await h.unlock();
    const r = h.reveal('evm');
    pressEl(h, r.toggle);
    expect(r.secret.textContent).toBe(vector(OWN).accounts[0]!.evm.export);
    leave(h);
    expect(h.page.moving.holdsSecret).toBe(false);
    expect(zeroed.has(prkOf(OWN))).toBe(true);
    expect(h.page.moving.state).toBe(state);
    expect(r.secret.textContent).toBe('••••••••');
    expect(pageText()).not.toContain(vector(OWN).accounts[0]!.evm.export);
    // No timer of the old wallet is left to fire.
    advance(HOME_PRK_LIFETIME_MS + 1000);
    expect(h.page.moving.state).toBe(state);
  });

  it('coming back to the app’s page starts collapsed again, with nothing kept', async () => {
    const h = start();
    await h.unlock();
    h.click('home-back');
    (document.querySelector('.home-open') as HTMLElement).click();
    expect(h.page.moving.state).toBe('closed');
    expect(document.getElementById('home-export')?.textContent).toBe(HOME_EXPORT_TITLE);
  });

  it('an answer that arrives after the user left opens nothing', async () => {
    let release: (r: Response) => void = () => {};
    let pk1: string | null = null;
    const h = start({
      login: (body) => {
        pk1 = body.pk1 as string;
        return new Promise<Response>((r) => {
          release = r;
        });
      },
    });
    await h.toApp();
    await h.begin();
    await until(() => pk1 !== null, 'the derive to be sent');
    expect(h.page.moving.state).toBe('opening');
    h.click('home-back');
    const { response } = simulateMpc(pk1 as unknown as string, ckdAppId(HOME_ENV.signer, OWN), NET);
    release(json(200, { result: response, session: { scope_id: SCOPE, expires_at_ms: T0 + 1, max_uses: 1, used: 1 }, nearTx: 'tx', requestId: 'req_1' }));
    await h.page.idle();
    expect(h.page.moving.holdsSecret).toBe(false);
    expect(h.page.moving.state).toBe('closed');
    expect(document.getElementById('home-export')).toBeNull();
    // And the same if the user comes back to the app before the answer does.
  });

  it('writes nothing to storage, the address or the console, and its messages carry no secret', async () => {
    const h = start();
    await h.unlock();
    const r = h.reveal('stellar');
    pressEl(h, r.toggle);
    pressEl(h, r.copy);
    await tick();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(h.win.replaced).toEqual([]);
    expect(h.win.location.assigned).toEqual([]);
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
    const want = vector(OWN);
    const secrets = [want.accounts[0]!.stellar.export, want.accounts[0]!.evm.export, want.prkHex, want.sHex, want.accounts[0]!.stellar.seedHex];
    const posted = JSON.stringify(h.children.flatMap((c) => c.received), (_k, v) => (v instanceof Uint8Array ? hex(v) : v));
    const requests = h.fetches.map((f) => `${f.url.href} ${f.header ?? ''} ${f.body ? new TextDecoder().decode(f.body) : ''}`).join('\n');
    for (const s of secrets) {
      expect(posted).not.toContain(s);
      expect(requests).not.toContain(s);
    }
    // The chain key the page derives is the vault's own function of the secret.
    expect(hex(chainPrivateKey(Uint8Array.from(Buffer.from(want.prkHex, 'hex')), 'stellar', 0))).toBe(want.accounts[0]!.stellar.seedHex);
  });
});

describe('the guard and the auto-hide', () => {
  it('Continue needs the typed word and a guarded click; a click carried over does nothing', async () => {
    const h = start();
    await h.unlock();
    h.click('home-export-stellar');
    expect(h.page.moving.state).toBe('confirm');
    expect(pageText()).toContain(EXPORT_WARNING);
    const go = document.getElementById('home-export-continue') as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    h.type(EXPORT_CONFIRMATION);
    // Typed, but no arming gesture yet: a click in place doesn't act.
    h.still('home-export-continue');
    expect(h.page.moving.state).toBe('confirm');
    h.type('export');
    h.press('home-export-continue');
    expect(h.page.moving.state).toBe('confirm');
    h.type(EXPORT_CONFIRMATION);
    h.press('home-export-continue');
    expect(h.page.moving.state).toBe('reveal');
  });

  it('Show key and Copy key need a guarded click each; the key hides after 60 s, on blur, and before printing', async () => {
    const h = start();
    await h.unlock();
    const r = h.reveal('stellar');
    const key = vector(OWN).accounts[0]!.stellar.export;
    expect(r.secret.textContent).toBe('••••••••');
    expect(r.secret.getAttribute('translate')).toBe('no');
    expect(r.secret.closest('[aria-live]')).toBeNull();
    r.toggle.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(r.secret.textContent).toBe('••••••••');
    pressEl(h, r.toggle);
    expect(r.secret.textContent).toBe(key);
    expect(r.toggle.textContent).toBe('Hide key');
    advance(EXPORT_SHOW_MS - 1);
    expect(r.secret.textContent).toBe(key);
    advance(1);
    expect(r.secret.textContent).toBe('••••••••');
    expect(r.toggle.textContent).toBe('Show key');
    expect(h.page.moving.holdsSecret).toBe(true);
    for (const event of ['blur', 'beforeprint']) {
      pressEl(h, r.toggle);
      expect(r.secret.textContent, event).toBe(key);
      h.win.dispatch(event);
      expect(r.secret.textContent, event).toBe('••••••••');
      h.win.dispatch('focus');
    }
    // Hide never waits for the guard.
    pressEl(h, r.toggle);
    r.toggle.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(r.secret.textContent).toBe('••••••••');
  });

  it('Copy key writes the key to the clipboard without putting it in the page, and blanks it 60 s later', async () => {
    const h = start();
    await h.unlock();
    const r = h.reveal('evm');
    const key = vector(OWN).accounts[0]!.evm.export;
    r.copy.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(h.clipboardWrites).toEqual([]);
    pressEl(h, r.copy);
    await tick();
    expect(h.clipboardWrites).toEqual([key]);
    expect(pageText()).not.toContain(key);
    expect(r.copy.textContent).toBe('Copied');
    advance(EXPORT_CLIPBOARD_CLEAR_MS);
    await tick();
    expect(h.clipboardWrites).toEqual([key, '']);
  });

  it('a copied key is blanked when the wallet locks, and the page says so when it can’t copy', async () => {
    const h = start();
    await h.unlock();
    const r = h.reveal('stellar');
    pressEl(h, r.copy);
    await tick();
    h.click('home-export-lock');
    await tick();
    expect(h.clipboardWrites.at(-1)).toBe('');

    resetDom();
    const g = start({ clipboard: null });
    await g.unlock();
    const s = g.reveal('stellar');
    pressEl(g, s.copy);
    expect(document.querySelector('#home-export .copy-status')?.textContent).toContain('Copy isn’t available here');
  });
});

describe('words and source', () => {
  it('the availability sentence mentions the move only where the page offers it', () => {
    expect(coverageText('shared', true, true).detail).toContain('You can also move it to another wallet app');
    expect(coverageText('partner_client', true, true).detail).toContain('To stop depending on it, you can move the wallet');
    for (const [coverage, mine, canMove] of [['shared', true, false], ['exit', true, false], ['shared', false, true], ['none', true, true], ['unknown', true, true]] as const) {
      expect(coverageText(coverage, mine, canMove).detail, `${coverage} ${mine} ${canMove}`).not.toMatch(/move/u);
    }
    expect(coverageText('shared', true, true).badge).toBe('Stays reachable');
  });

  it('the route: shared and the app’s own clients; never for a linked app that isn’t the user’s', () => {
    const s = (over: Record<string, unknown>) => ({ scopeId: SCOPE, mine: true, coverage: 'shared', googleClientId: 'c', supportId: null, addresses: [], apps: [], ...over }) as never;
    expect(homeExportRoute(s({}), null, false)).toEqual({ clientId: 'c', kind: 'shared' });
    expect(homeExportRoute(s({ coverage: 'partner_client' }), null, false)).toEqual({ clientId: 'c', kind: 'own' });
    expect(homeExportRoute(s({ coverage: 'hana_client', googleClientId: null }), null, false)).toBe('none');
    expect(homeExportRoute(s({ mine: false }), null, true)).toBe('link');
    expect(homeExportRoute(s({ mine: true }), null, true)).toEqual({ clientId: 'c', kind: 'shared' });
  });

  it('home-export.ts stores nothing, logs nothing, never touches the URL or the network directly, and posts only its parameters', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'auth', 'home-export.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .replace(/^\s*\/\/.*$/gmu, '');
    for (const banned of [/localStorage/u, /sessionStorage/u, /indexedDB/u, /document\.cookie/u, /\bconsole\./u, /\bfetch\(/u, /XMLHttpRequest/u, /sendBeacon/u, /location\.(?:href|hash|assign|replace)/u, /history\./u, /WebSocket/u, /innerHTML/u]) {
      expect(source, String(banned)).not.toMatch(banned);
    }
    expect([...source.matchAll(/\.postMessage\(([\s\S]*?), env\.authOrigin\)/gu)].map((m) => m[1]!.trim())).toEqual(['p.params']);
    // The export string is made in one place, from a key zeroed in the same call, and handed only to the reveal.
    expect([...source.matchAll(/^.*exportString\(.*$/gmu)].map((m) => m[0].trim())).toEqual(['return exportString(c, key);']);
    expect(source).toMatch(/const key = chainPrivateKey\(prk, c, 0\);\s+try \{\s+return exportString\(c, key\);\s+\} finally \{\s+key\.fill\(0\);/u);
  });
});
