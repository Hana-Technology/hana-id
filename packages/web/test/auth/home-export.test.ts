// @vitest-environment happy-dom
// Hana Home's "Move this wallet to another wallet app" (home-export.ts, on /home): the address Home opens is the
// vault's (the frozen derivation vectors, for an identity's own path and for a linked member's root); the secret is
// erased at 5 minutes and on leaving; a path only one NEAR provider gives is refused; each refusal reads as its own
// sentence; the guard and the 60 s auto-hide; and nothing is opened, relayed or derived from the page's address alone.
import { bls12_381 as bls } from '@noble/curves/bls12-381';
import {
  ApiError,
  type RelayPayload,
  type RelayReadResponse,
  addressOfExport,
  chainAddress,
  chainPrivateKey,
  ckdAppId,
  deriveAddresses,
  HOME_EMAIL_AUDIENCE,
  base64UrlEncode,
  decodeHomeIdentity,
  encryptRelayPayload,
  homeNonce,
  extractPrk,
  homeMessage,
  identityKeyHex,
  newAppKey,
  parseWindowMessage,
  sessionNonce,
  deriveWalletAddresses,
  sha256,
  utf8,
} from '@hana-id/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mpcNetwork, readJson, simulateMpc } from '../../../core/test/helpers.ts';
import { maskedAddress } from '../../src/auth/dom.ts';
import { homeApi } from '../../src/auth/home-api.ts';
import type { HomeEmailApi, HomeIdentityCommitment, HomeSessionCommitment } from '../../src/auth/home-email.ts';
import { HOME_EXPORT_ABOUT, HOME_EXPORT_END_TEXT, HOME_EXPORT_OFF_TEXT, HOME_EXPORT_OPEN, HOME_EXPORT_SESSION_TTL_MS, HOME_EXPORT_TITLE, HOME_PRK_LIFETIME_MS, homeExportRoute } from '../../src/auth/home-export.ts';
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
/**
 * Waits for `cond` by real time, not by a count of ticks: keys, nonces and the decrypt are real WebCrypto work, which on
 * a busy machine (verify runs four packages at once) can take more than a few hundred ticks. `Date` isn't faked here.
 */
const UNTIL_MS = 10_000;
/** The section collapsed: its heading, its sentence and the one button that opens it, nothing else. */
function expectCollapsed(): void {
  const root = document.getElementById('home-export')!;
  expect(root.querySelector('#home-export-title')?.textContent).toBe(HOME_EXPORT_TITLE);
  expect(root.querySelector('#home-export-about')?.textContent).toBe(HOME_EXPORT_ABOUT);
  expect([...root.querySelectorAll('button')].map((b) => [b.id, b.textContent])).toEqual([['home-export-open', HOME_EXPORT_OPEN]]);
  expect(root.textContent).toBe(`${HOME_EXPORT_TITLE}${HOME_EXPORT_ABOUT}${HOME_EXPORT_OPEN}`);
}

async function until(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + UNTIL_MS;
  while (Date.now() < deadline) {
    if (cond()) return;
    await tick();
  }
  if (cond()) return;
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
  /** `get_session` and the transaction's outcome, as the page reads them from NEAR after an answer it never got. */
  session?: () => unknown;
  tx?: (hash: string) => unknown;
  clipboard?: null;
  /** H10: Hana Home's exit Google client in `/v1/home/config`; `shared: false` names no shared client. */
  exit?: string;
  shared?: false;
  /** H10: email sign-in open, with this fake issuer's answers (`EmailIssuer`). */
  email?: EmailIssuer;
}

/** A fake issuer Home route (home-email.ts's API): it records the starts and answers tokens of its `sub` for their nonces. */
interface EmailIssuer extends HomeEmailApi {
  starts: { email: string; kind: 'identity' | 'derive'; commitment: HomeIdentityCommitment | HomeSessionCommitment; identity?: string }[];
  /** The tokens `verify` answered, in order. */
  tokens: string[];
  /** The `sub` the next token carries. */
  sub: string;
  /** The audience the next derive token carries (the scope's email client by default). */
  deriveAud?: string;
  /** Answers `verify` with this instead of a token. */
  refuse?: Error;
}

const ESUB = `e1.${'A'.repeat(43)}`;
const EMAIL_ISS = 'https://issuer.hana.test/v1/email';
/** An email token in the issuer's JWS JSON form; the page reads its claims only (the API checks the signature). */
const emailJws = (claims: Record<string, unknown>): string => JSON.stringify({ payload: base64UrlEncode(utf8(JSON.stringify(claims))), signatures: [{ protected: 'e30', signature: 'c2ln' }] });

function emailIssuer(sub = ESUB): EmailIssuer {
  const issuer: EmailIssuer = {
    starts: [],
    tokens: [],
    sub,
    async start(email: string, kind: 'identity' | 'derive', commitment: HomeIdentityCommitment | HomeSessionCommitment, identity?: string) {
      issuer.starts.push({ email, kind, commitment, ...(identity !== undefined ? { identity } : {}) });
      return { challengeId: 'C'.repeat(43), expiresAtMs: now + 600_000, resendAfterMs: now + 30_000 };
    },
    async resend() {
      return { challengeId: 'C'.repeat(43), expiresAtMs: now + 600_000, resendAfterMs: now + 30_000 };
    },
    async verify() {
      if (issuer.refuse) throw issuer.refuse;
      const last = issuer.starts.at(-1)!;
      const exp = Math.floor(now / 1000) + 600;
      if (last.kind === 'identity') {
        const c = last.commitment as HomeIdentityCommitment;
        const t = emailJws({ iss: EMAIL_ISS, aud: HOME_EMAIL_AUDIENCE, sub: issuer.sub, iat: exp - 600, exp, nonce: homeNonce({ signer: HOME_ENV.signer, homePublicKey: c.homePublicKey, expiresAtMs: c.expiresAtMs, salt: c.salt }), jti: 'j' });
        issuer.tokens.push(t);
        return t;
      }
      const c = last.commitment as HomeSessionCommitment;
      const nonce = sessionNonce({ signer: HOME_ENV.signer, scopeId: c.scopeId, sessionPublicKey: c.sessionPublicKey, expiresAtMs: c.expiresAtMs, keyIndex: 0, maxUses: 1, salt: c.salt });
      return emailJws({ iss: EMAIL_ISS, aud: issuer.deriveAud ?? `email:${c.scopeId}`, sub: issuer.sub, iat: exp - 600, exp, nonce, jti: 'j' });
    },
  } as EmailIssuer;
  return issuer;
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
  /** H10: Hana Home's own sign-in with an email code, then the app's page. */
  toAppByEmail(address?: string): Promise<void>;
  /** H10: expand, "Continue with a code", "Send code", the code: waiting until the wallet is open or refused. */
  openByEmail(): Promise<void>;
  /** Submits the form that holds element `id` (a real user's Enter or button press). */
  submit(id: string): void;
  /** Answers the newest child's hello and relays Google's answer, a token of `aud` for the nonce the page sent. */
  answer(claims: Record<string, unknown>, aud: string): Promise<void>;
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
    if (url.pathname === '/v1/home/config') return json(200, { serverTimeMs: now, signer: HOME_ENV.signer, sharedGoogleClientId: o.shared === false ? null : CLIENT_ID, exitGoogleClientId: o.exit ?? null, emailSignIn: o.email !== undefined });
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
    getSession: vi.fn(async () => (o.session?.() ?? null) as never),
    txOutcome: vi.fn(async (hash: string) => (o.tx?.(hash) ?? { status: 'pending' as const }) as never),
    view: vi.fn(async (_signer: string, method: string, args: unknown) => first(method, args)),
    independent: vi.fn(() => (o.second === null ? null : { primary: views(o.identity, 'primary'), second: views(o.second ?? o.identity, 'second') })),
  };
  const page = startHomePage({
    win,
    env: o.email ? { ...HOME_ENV, emailIssuerUrl: 'https://issuer.hana.test', emailIss: EMAIL_ISS } : HOME_ENV,
    email: o.email ?? null,
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
    answer: (claims, aud) => answer(claims, aud),
    submit(id) {
      const form = el(id).closest('form');
      if (!form) throw new Error(`#${id} is in no form`);
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    },
    async toAppByEmail(address = 'user@example.com') {
      await page.idle();
      h.click('home-sign-in-email');
      (el('home-email-address') as HTMLInputElement).value = address;
      h.submit('home-email-address');
      await until(() => document.getElementById('home-email-code') !== null, 'the code screen');
      (el('home-email-code') as HTMLInputElement).value = '123456';
      h.submit('home-email-code');
      await until(() => page.stage === 'signed_in', 'the email sign-in');
      await page.idle();
      if (page.openScope === null) (document.querySelector('.home-open') as HTMLElement).click();
      expect(page.openScope).toBe(SCOPE);
    },
    async openByEmail() {
      // Read through a function: the state changes under the awaits below.
      const refused = (): boolean => (page.moving.state as string) === 'refused';
      h.click('home-export-open');
      h.click('home-export-start');
      await until(() => document.getElementById('home-export-email-send') !== null || refused(), 'the code screen');
      if (refused()) return;
      h.click('home-export-email-send');
      await until(() => document.getElementById('home-export-email-code') !== null || refused(), 'the code to be sent');
      if (refused()) return;
      (el('home-export-email-code') as HTMLInputElement).value = '654321';
      h.submit('home-export-email-code');
      await until(() => page.moving.state === 'unlocked' || page.moving.state === 'refused', 'the wallet to open or be refused');
      await page.idle();
    },
    reveal(chain) {
      h.click(chain === 'stellar' ? 'home-export-stellar' : 'home-export-evm');
      h.type(EXPORT_CONFIRMATION);
      h.press('home-export-continue');
      expect(page.moving.state).toBe('reveal');
      const section = el('home-export');
      // The export pattern's checkbox (D765): the user ticks it before Show key and Copy key act.
      const box = section.querySelector('.reveal-ack input[type="checkbox"]') as HTMLInputElement;
      box.checked = true;
      box.dispatchEvent(new Event('change'));
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

  it('a NEAR account on record is checked against the wallet’s own NEAR account, never its EVM address (D755)', async () => {
    const own = vector(OWN);
    const near = deriveWalletAddresses(Uint8Array.from(Buffer.from(own.prkHex, 'hex'))).near;
    const records = [
      { chain: 'stellar', address: own.accounts[0]!.stellar.address },
      { chain: 'evm', address: own.accounts[0]!.evm.address },
    ];
    // The record's NEAR account is the wallet's: the move goes on, no mismatch.
    const same = start({ scopes: [mineScope({ addresses: [...records, { chain: 'near', address: near }] })] });
    await same.unlock();
    expect(same.page.moving.state).not.toBe('refused');
    expect(document.getElementById('home-export-mismatch')).toBeNull();
    // Another NEAR account on record is a difference, said as for the other chains.
    resetDom();
    const other = start({ scopes: [mineScope({ addresses: [...records, { chain: 'near', address: 'ab'.repeat(32) }] })] });
    await other.unlock();
    expect(document.getElementById('home-export-mismatch')?.textContent).toContain('different from this wallet’s');
  });

  it('on a linked member’s path a different address on record stops the move: nothing is shown or kept', async () => {
    // Two lying providers could name a root whose owner can forge an answer for it; the record is the last check.
    const h = start({ identity: member, chainPath: ROOT });
    await h.toApp();
    await h.open();
    expect(h.page.moving.state).toBe('refused');
    expect(h.page.moving.errorCode).toBe('address_mismatch');
    expect(document.getElementById('home-export-problem')?.textContent).toContain('is not the one Journear has on record for you in this app, so nothing is shown');
    expect(h.page.moving.holdsSecret).toBe(false);
    expect(zeroed.has(vector(ROOT).prkHex)).toBe(true);
    expect(document.getElementById('home-export-addresses')).toBeNull();
    expect(pageText()).not.toContain(vector(ROOT).accounts[0]!.stellar.address);
  });

  // An answer the API never delivered, read back from NEAR by its transaction: the RPC's word, not the API's.
  const recovered = (record: string) => {
    let pk1 = '';
    return start({
      scopes: [mineScope({ addresses: [{ chain: 'stellar', address: record }] })],
      login: (body) => {
        pk1 = body.pk1 as string;
        return json(504, { error: 'internal words', code: 'timeout', nearTx: '4'.repeat(44), requestId: 'req_9' }, 'req_9');
      },
      tx: () => ({ status: 'success', result: simulateMpc(pk1, ckdAppId(HOME_ENV.signer, OWN), NET).response }),
    });
  };

  it('an outcome recovered from NEAR by its transaction opens the wallet when it is the one on record', async () => {
    const h = recovered(vector(OWN).accounts[0]!.stellar.address);
    await h.unlock();
    expect(document.getElementById('home-export-address-stellar')?.textContent).toBe(vector(OWN).accounts[0]!.stellar.address);
    expect(h.logins()).toHaveLength(1);
  });

  it('an outcome recovered from NEAR that differs from the record stops the move, even on the own path', async () => {
    const h = recovered(vector(ROOT).accounts[0]!.stellar.address);
    await h.toApp();
    await h.open();
    expect(h.page.moving.errorCode).toBe('address_mismatch');
    expect(h.page.moving.holdsSecret).toBe(false);
    expect(zeroed.has(vector(OWN).prkHex)).toBe(true);
    expect(h.logins()).toHaveLength(1);
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
    expectCollapsed();
    expect(document.getElementById('home-export-start')).toBeNull();
    expect(pageText()).not.toContain(EXPORT_WARNING);
    expect(g.win.opened).toHaveLength(1);
    expect(g.logins()).toEqual([]);
    expect(g.nearCalls).toEqual([]);
    expect(g.page.moving.holdsSecret).toBe(false);
    // A link can come from anyone: the wallet of the app it named, the user's own included, isn't moved out in this
    // page load. The addresses stay visible; the section says to come back without the link.
    expect(document.getElementById('home-address-stellar')?.textContent).toBe(vector(OWN).accounts[0]!.stellar.address);
    expect(document.getElementById('home-coverage')?.textContent).not.toMatch(/move/u);
    g.click('home-export-open');
    expect(document.getElementById('home-export-off')?.textContent).toBe(HOME_EXPORT_OFF_TEXT.link);
    expect(HOME_EXPORT_OFF_TEXT.link).toContain('open Passport Home yourself, without the link');
    expect(document.getElementById('home-export-start')).toBeNull();
    expect(pageText()).not.toContain(EXPORT_WARNING);
    // Going back to the list and opening the same app again changes nothing, nor does signing in again.
    g.click('home-back');
    (document.querySelector('.home-open') as HTMLElement).click();
    g.click('home-export-open');
    expect(document.getElementById('home-export-start')).toBeNull();
    expect(g.win.opened).toHaveLength(1);
    expect(g.logins()).toEqual([]);
    expect(g.nearCalls).toEqual([]);
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
    // No exit client in Hana Home's settings, and an email coverage for a Google account: nothing to sign in with.
    ['exit', 'none'],
    ['email', 'none'],
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
    ['only the first provider says "member" (a lying RPC)', { identity: member, second: () => undefined } as Opts, 'path_disputed', 'Journear’s checks disagree about which wallet this sign-in opens'],
    ['the env has no second provider', { identity: member, second: null } as Opts, 'path_unconfirmed', 'couldn’t confirm which wallet this sign-in opens'],
    [
      'the providers name different roots',
      { identity: member, second: ((p, s) => (s === SUB ? { ...member(p, s), root: { provider: 'google', sub: '555' } } : undefined)) as IdentityFn } as Opts,
      'path_disputed',
      'Journear’s checks disagree',
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
    [429, 'home_busy', 'Passport Home has reached its limit for today. Try again tomorrow.'],
    [429, 'rate_limited', 'This wallet was opened too many times. Try again later.'],
    [403, 'home_account_mismatch', 'Sign in as the same account you used in Passport Home.'],
    [409, 'link_pending', 'A sign-in method is still being added to this wallet. Try again once that has finished.'],
    [403, 'shared_login_disabled', 'Journear can’t open this wallet from here. If the app still runs, use the app itself.'],
    [403, 'unregistered_client', 'Journear can’t open this wallet from here. If the app still runs, use the app itself.'],
    [403, 'unknown_scope', 'Journear doesn’t know that app.'],
    [502, 'near_unavailable', 'Passport Home is not reachable right now. Nothing on screen was lost. Try again in a moment.'],
    [503, 'home_directory_unavailable', 'Passport Home is not reachable right now.'],
    [503, 'rate_limiter_unavailable', 'Passport Home is not reachable right now.'],
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

  it.each([
    [59, 'Try again in about 1 minute.'],
    [1800, 'Try again in about 30 minutes.'],
    [3600, 'Try again in about 60 minutes.'],
    [3601, 'Try again in about 2 hours.'],
    [50_000, 'Try again in about 14 hours.'],
  ])('a limit says how long the API asked to wait (retry-after %i s), hourly or daily', async (seconds, words) => {
    const h = start({ login: () => new Response(JSON.stringify({ error: 'internal words', code: 'rate_limited', requestId: 'req_9' }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': String(seconds) } }) });
    await h.toApp();
    await h.open();
    expect(document.getElementById('home-export-problem')?.textContent).toContain(`This wallet was opened too many times. ${words}`);
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

  it('a derive that ran but whose answer was lost: the one-use session is spent, nothing is shown, and it says so', async () => {
    const h = start({
      login: () => {
        throw new TypeError('network');
      },
      session: () => ({ scope_id: SCOPE, path: OWN, expires_at_ms: T0 + HOME_EXPORT_SESSION_TTL_MS, max_uses: 1, used: 1 }),
    });
    await h.toApp();
    await h.open();
    expect(h.page.moving.errorCode).toBe('derive_failed');
    expect(document.getElementById('home-export-problem')?.textContent).toContain('Nothing was shown. Sign in again to retry.');
    expect(h.logins()).toHaveLength(1);
    expect(h.page.moving.holdsSecret).toBe(false);
  });

  it('Google signed in as another account: said here, and nothing is sent', async () => {
    const h = start();
    await h.toApp();
    await h.open('another-sub');
    expect(h.page.moving.errorCode).toBe('home_account_mismatch');
    expect(document.getElementById('home-export-problem')?.textContent).toContain('Sign in as the same account you used in Passport Home.');
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

  it('is erased when the tab is frozen (a frozen tab runs no timers, so the 5 minutes could pass unseen)', async () => {
    const h = start();
    await h.unlock();
    const r = h.reveal('stellar');
    pressEl(h, r.toggle);
    document.dispatchEvent(new Event('freeze'));
    expect(h.page.moving.holdsSecret).toBe(false);
    expect(zeroed.has(prkOf(OWN))).toBe(true);
    expect(h.page.moving.state).toBe('ended');
    expect(r.secret.textContent).toBe('••••••••');
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

  it('collapsed, the section has the devices section’s shape; Close collapses it and gives focus back to its button', async () => {
    const h = start();
    await h.toApp();
    expectCollapsed();
    const root = document.getElementById('home-export')!;
    expect(root.getAttribute('aria-labelledby')).toBe('home-export-title');
    // A secondary button, not the primary (the devices section's shape).
    expect(root.querySelector('#home-export-open')?.className).toBe('jp-btn jp-btn-secondary');
    expect(document.getElementById('home-export-start')).toBeNull();
    h.click('home-export-open');
    expect(document.activeElement?.id).toBe('home-export-title');
    expect(document.getElementById('home-export-start')).not.toBeNull();
    h.click('home-export-close');
    expectCollapsed();
    expect(document.activeElement?.id).toBe('home-export-open');
  });

  it('coming back to the app’s page starts collapsed again, with nothing kept', async () => {
    const h = start();
    await h.unlock();
    h.click('home-back');
    (document.querySelector('.home-open') as HTMLElement).click();
    expect(h.page.moving.state).toBe('closed');
    expectCollapsed();
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

  it('the export pattern (D765): three steps, and Show key (the only danger button) waits for the user to tick the box', async () => {
    const h = start();
    await h.toApp();
    const steps = () => [...document.querySelectorAll('#home-export .export-steps > [role="listitem"]')].map((s) => `${s.textContent}:${s.className || '-'}`);
    // Collapsed: no steps yet; expanded, the first step.
    expect(steps()).toEqual([]);
    h.click('home-export-open');
    expect(steps()).toEqual(['Verify:now', 'Understand:-', 'Export:-']);
    h.click('home-export-close');
    await h.open();
    expect(h.page.moving.state).toBe('unlocked');
    expect(steps()).toEqual(['Verify:done', 'Understand:now', 'Export:-']);
    h.click('home-export-stellar');
    expect(steps()).toEqual(['Verify:done', 'Understand:now', 'Export:-']);
    expect(document.querySelector('#home-export .reveal-ack')).toBeNull();
    expect(document.querySelector('#home-export .jp-btn-danger')).toBeNull();
    h.type(EXPORT_CONFIRMATION);
    h.press('home-export-continue');
    expect(h.page.moving.state).toBe('reveal');
    expect(steps()).toEqual(['Verify:done', 'Understand:done', 'Export:now']);
    const section = document.getElementById('home-export')!;
    expect(section.querySelector('[aria-current="step"]')?.textContent).toBe('Export');
    const toggle = [...section.querySelectorAll('button')].find((b) => b.textContent === 'Show key') as HTMLButtonElement;
    const box = section.querySelector('.reveal-ack input[type="checkbox"]') as HTMLInputElement;
    const secret = section.querySelector('.secret') as HTMLElement;
    expect([...section.querySelectorAll('.jp-btn-danger')]).toEqual([toggle]);
    // Unticked: even a guarded click shows nothing.
    pressEl(h, toggle);
    expect(secret.textContent).toBe('••••••••');
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    pressEl(h, toggle);
    expect(secret.textContent).toBe(vector(OWN).accounts[0]!.stellar.export);
    // Unticking hides it again.
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    expect(secret.textContent).toBe('••••••••');
    expect(toggle.disabled).toBe(true);
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
    expect(homeExportRoute(s({ mine: true }), null, true)).toBe('link');
  });

  it('home-export.ts stores nothing, logs nothing, never touches the URL or the network directly, and posts only its parameters', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'auth', 'home-export.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .replace(/^\s*\/\/.*$/gmu, '');
    for (const banned of [/localStorage/u, /sessionStorage/u, /indexedDB/u, /document\.cookie/u, /\bconsole\./u, /\bfetch\(/u, /XMLHttpRequest/u, /sendBeacon/u, /location\.(?:href|hash|assign|replace)/u, /history\./u, /WebSocket/u, /innerHTML/u]) {
      expect(source, String(banned)).not.toMatch(banned);
    }
    expect([...source.matchAll(/\.postMessage\(([\s\S]*?), env\.authOrigin\)/gu)].map((m) => m[1]!.trim())).toEqual(['r.params']);
    // The export string is made in one place, from a key zeroed in the same call, and handed only to the reveal.
    expect([...source.matchAll(/^.*exportString\(.*$/gmu)].map((m) => m[0].trim())).toEqual(['return exportString(c, key);']);
    expect(source).toMatch(/const key = chainPrivateKey\(prk, c, 0\);\s+try \{\s+return exportString\(c, key\);\s+\} finally \{\s+key\.fill\(0\);/u);
  });
});

// ---- H10: the exit client and email ----

const EXIT = 'hana-exit.apps.googleusercontent.com';
/** A wallet's addresses for `path`, as the vault works them out from the MPC's answer (core's own derivation). */
const addressesOf = (path: string) => deriveAddresses(extractPrk(simulateMpc(newAppKey().publicKey.AppPublicKeyPV.pk1, ckdAppId(HOME_ENV.signer, path), NET).expected), 0);

describe('H10: Google through the exit client (D490, D491)', () => {
  it('Hana Home’s own sign-in uses the exit client when no shared client is in force (D550’s open point)', async () => {
    const h = start({ shared: false, exit: EXIT });
    await h.page.idle();
    expect(h.page.stage).toBe('signed_out');
    h.click('home-sign-in');
    await until(() => h.page.awaitingChild, 'the Home sign-in to be prepared');
    await h.answer({}, EXIT);
    const sent = h.children.at(-1)!.received.at(-1) as Record<string, unknown>;
    expect(parseWindowMessage(sent, ['hana:home-params'])).not.toBeNull();
    expect(sent).toMatchObject({ clientId: EXIT, exit: true });
    await h.page.idle();
    expect(h.page.stage).toBe('signed_in');
  });

  it('with a shared client in force, the shared client: no exit flag', async () => {
    const h = start({ exit: EXIT });
    await h.toApp();
    const sent = h.children[0]!.received.at(-1) as Record<string, unknown>;
    expect(sent.clientId).toBe(CLIENT_ID);
    expect('exit' in sent).toBe(false);
  });

  it('coverage exit: the per-app sign-in names the exit client, checks it on NEAR, and opens the vectors’ address', async () => {
    const h = start({ exit: EXIT, scopes: [mineScope({ coverage: 'exit', googleClientId: EXIT })], registry: { config: { shared_clients: [['google', CLIENT_ID]], exit_clients: [['google', EXIT]], pending_exit_clients: [] } } });
    await h.unlock();
    const sent = h.children.at(-1)!.received.at(-1) as Record<string, unknown>;
    expect(parseWindowMessage(sent, ['hana:home-derive-params'])).not.toBeNull();
    expect(sent).toMatchObject({ clientId: EXIT, exit: true, scopeId: SCOPE });
    const want = vector(OWN).accounts[0]!;
    expect(document.getElementById('home-export-address-stellar')?.textContent).toBe(want.stellar.address);
    expect(document.getElementById('home-export-address-evm')?.textContent).toBe(want.evm.address);
    expect(h.logins()).toHaveLength(1);
  });

  it.each([
    ['not on the exit list', { shared_clients: [], exit_clients: [] }],
    ['still pending', { shared_clients: [], exit_clients: [], pending_exit_clients: [{ provider: 'google', aud: EXIT, effective_at_ms: T0 + 60_000 }] }],
    ['on an older contract', { shared_clients: [] }],
  ])('coverage exit with the exit client %s on NEAR: refused before Google, nothing posted', async (_, config) => {
    const h = start({ exit: EXIT, scopes: [mineScope({ coverage: 'exit', googleClientId: EXIT })], registry: { config } });
    await h.toApp();
    await h.open();
    expect(h.page.moving.errorCode).toBe('not_covered');
    expect(h.children.at(-1)!.received).toEqual([]);
    expect(h.logins()).toEqual([]);
  });

  it('coverage exit with no exit client in Hana Home’s settings, or another client named: no sign-in offered', async () => {
    for (const [exit, named] of [
      [undefined, EXIT],
      [EXIT, 'other.apps.googleusercontent.com'],
    ] as const) {
      resetDom();
      const h = start({ ...(exit ? { exit } : {}), scopes: [mineScope({ coverage: 'exit', googleClientId: named })] });
      await h.toApp();
      h.click('home-export-open');
      expect(document.getElementById('home-export-off')?.textContent).toBe(HOME_EXPORT_OFF_TEXT.none);
    }
  });
});

describe('H10: email users (D463)', () => {
  it('signs in with an email code: no child window, a token for this key, “Signed in with email”, nothing stored', async () => {
    const issuer = emailIssuer();
    const h = start({ email: issuer });
    await h.page.idle();
    // Both methods offered.
    expect(document.getElementById('home-sign-in')?.textContent).toBe('Continue with Google');
    expect(document.getElementById('home-sign-in-email')?.textContent).toBe('Continue with email');
    await h.toAppByEmail('User@Example.com');
    expect(h.win.opened).toEqual([]);
    expect(issuer.starts).toHaveLength(1);
    expect(issuer.starts[0]).toMatchObject({ email: 'User@Example.com', kind: 'identity' });
    expect(document.getElementById('home-who')?.textContent).toBe('Signed in as User@Example.com');
    // The listing request carries the email token as the Home identity.
    const apps = h.fetches.find((f) => f.url.pathname === '/v1/home/apps')!;
    const header = decodeHomeIdentity(apps.header as string)!;
    expect(header.jwt.startsWith('{')).toBe(true);
    const c = issuer.starts[0]!.commitment as HomeIdentityCommitment;
    expect(header.key).toEqual(c.homePublicKey);
    expect(header.expiresAtMs).toBe(c.expiresAtMs);
    // Memory only.
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it('the header names the address signed in with: as text, in memory only, gone on sign-out and replaced on another account', async () => {
    const issuer = emailIssuer();
    const h = start({ email: issuer });
    await h.toAppByEmail('ada.lovelace@mail.example.com');
    const who = () => document.getElementById('home-who');
    expect(who()?.textContent).toBe('Signed in as ada.lovelace@mail.example.com');
    // The address wraps at its own break points: before `@` and each `.`, its text the address exactly.
    const addr = document.getElementById('home-who-address')!;
    expect(addr.tagName).toBe('STRONG');
    expect(addr.querySelectorAll('wbr')).toHaveLength(4);
    expect(addr.textContent).toBe('ada.lovelace@mail.example.com');
    expect(window.localStorage.length + window.sessionStorage.length).toBe(0);
    expect(window.location.href).not.toContain('lovelace');
    // Sign out: the header and the address are gone.
    h.click('home-sign-out');
    expect(h.page.stage).toBe('signed_out');
    expect(who()).toBeNull();
    expect(pageText()).not.toContain('lovelace');
    // Another account: only its own address.
    issuer.sub = `e1.${'B'.repeat(43)}`;
    await h.toAppByEmail('grace@example.org');
    expect(who()?.textContent).toBe('Signed in as grace@example.org');
    expect(pageText()).not.toContain('lovelace');
  });

  it('once the sign-in ends the header masks the address; signing in again shows it in full; the code still goes to it', async () => {
    const issuer = emailIssuer();
    const h = start({ email: issuer });
    await h.toAppByEmail('ada.lovelace@mail.example.com');
    const who = () => document.getElementById('home-who')?.textContent;
    advance(8 * 60_000 + 1);
    // Ending: still the full address.
    expect(h.page.session).toBe('ending');
    expect(who()).toBe('Signed in as ada.lovelace@mail.example.com');
    advance(2 * 60_000);
    expect(h.page.session).toBe('ended');
    expect(who()).toBe('Signed in as a•••@mail.example.com');
    expect(pageText()).not.toContain('lovelace');
    // "Sign in again" still sends the code to the full address, kept in memory.
    h.click('home-sign-in-again');
    expect(document.getElementById('home-email-to')?.textContent).toBe('ada.lovelace@mail.example.com');
    h.click('home-email-send');
    await until(() => document.getElementById('home-email-code') !== null, 'the code screen');
    expect(issuer.starts.at(-1)!.email).toBe('ada.lovelace@mail.example.com');
    (document.getElementById('home-email-code') as HTMLInputElement).value = '123456';
    h.submit('home-email-code');
    await until(() => h.page.session === 'active', 'the new sign-in');
    expect(who()).toBe('Signed in as ada.lovelace@mail.example.com');
    // Ended again, then signed out: nothing of it is left.
    advance(10 * 60_000 + 1);
    expect(who()).toBe('Signed in as a•••@mail.example.com');
    h.click('home-sign-out');
    expect(document.getElementById('home-who')).toBeNull();
    expect(pageText()).not.toContain('mail.example.com');
    // Another account after an ended one: its own address, in full.
    issuer.sub = `e1.${'C'.repeat(43)}`;
    await h.toAppByEmail('grace@example.org');
    expect(who()).toBe('Signed in as grace@example.org');
  });

  it('maskedAddress: first character, •••, the domain in full; never markup, never a hidden character', () => {
    expect(maskedAddress('ada@example.com')).toBe('a•••@example.com');
    expect(maskedAddress('a@example.com')).toBe('a•••@example.com');
    expect(maskedAddress('@example.com')).toBe('•••@example.com');
    expect(maskedAddress('no-at-sign')).toBe('•••');
    // The last `@` splits (a quoted local part may hold one).
    expect(maskedAddress('"a@b"@example.com')).toBe('"•••@example.com');
    // A whole code point, never half a surrogate pair; a bidi, format or space first character is hidden too.
    expect(maskedAddress('\u{1F600}x@example.com')).toBe('\u{1F600}•••@example.com');
    expect(maskedAddress('‮moc@example.com')).toBe('•••@example.com');
    expect(maskedAddress('​x@example.com')).toBe('•••@example.com');
    expect(maskedAddress(' x@example.com')).toBe('•••@example.com');
    const long = `${'l'.repeat(64)}@${'sub.'.repeat(40)}example.com`;
    expect(maskedAddress(long)).toBe(`l•••@${'sub.'.repeat(40)}example.com`);
    // Text only: what it returns is placed as a text node; tags stay characters.
    expect(maskedAddress('<img src=x onerror=1>@x.com')).toBe('<•••@x.com');
  });

  it('a hostile-looking address renders as text: no markup, no link, bidi isolated', async () => {
    const issuer = emailIssuer();
    const h = start({ email: issuer });
    const hostile = '<img/src=x/onerror=alert(1)>"\u202emoc.live@x"<a/href=javascript:1>@example.com';
    await h.toAppByEmail(hostile);
    const addr = document.getElementById('home-who-address')!;
    expect(addr.textContent).toBe(hostile);
    expect(addr.querySelectorAll('*:not(wbr)')).toHaveLength(0);
    expect(document.querySelector('.home-head img, .home-head a')).toBeNull();
    // auth.css isolates `.mail-address` (bidi), so the override can't reorder the text around it.
    expect(addr.className).toBe('mail-address');
  });

  it('a Google account keeps “Signed in with Google”: the page has no address for it', async () => {
    const h = start({ email: emailIssuer() });
    await h.toApp();
    expect(document.getElementById('home-who')?.textContent).toBe('Signed in with Google');
    expect(document.getElementById('home-who-address')).toBeNull();
  });

  it('the code screen’s parts sit in one form whose gaps set the rhythm: field, buttons, then the links line', async () => {
    const issuer = emailIssuer();
    const h = start({ email: issuer });
    await h.page.idle();
    h.click('home-sign-in-email');
    const step = document.getElementById('home-email')!;
    expect(step.classList.contains('email-step')).toBe(true);
    expect(step.classList.contains('home-email-step')).toBe(true);
    expect(document.getElementById('home-email-address')!.closest('form')?.classList.contains('email-form')).toBe(true);
    (document.getElementById('home-email-address') as HTMLInputElement).value = 'user@example.com';
    h.submit('home-email-address');
    await until(() => document.getElementById('home-email-code') !== null, 'the code screen');
    const form = document.getElementById('home-email-code')!.closest('form')!;
    expect(form.classList.contains('email-form')).toBe(true);
    expect([...form.children].map((c) => `${c.tagName.toLowerCase()}${c.className ? `.${c.className.replace(/ /gu, '.')}` : ''}`)).toEqual(['p', 'div.jp-field', 'div.actions.start', 'p.muted.links']);
  });

  it.each([
    ['another key’s nonce', { nonce: 'N'.repeat(43) }],
    ['a scope’s audience', { aud: 'email:s1' }],
    ['another issuer', { iss: 'https://evil.example/v1/email' }],
    ['an expired token', { exp: Math.floor(T0 / 1000) - 1 }],
    ['a sub not of the issuer’s form', { sub: '110248495921238986420' }],
  ])('refuses the sign-in for %s: no request is sent', async (_, over) => {
    const issuer = emailIssuer();
    const verify = issuer.verify.bind(issuer);
    issuer.verify = async (id, code) => {
      const t = JSON.parse(await verify(id, code)) as { payload: string };
      const claims = JSON.parse(Buffer.from(t.payload, 'base64url').toString('utf8')) as Record<string, unknown>;
      return emailJws({ ...claims, ...over });
    };
    const h = start({ email: issuer });
    await h.page.idle();
    h.click('home-sign-in-email');
    (document.getElementById('home-email-address') as HTMLInputElement).value = 'user@example.com';
    h.submit('home-email-address');
    await until(() => document.getElementById('home-email-code') !== null, 'the code screen');
    (document.getElementById('home-email-code') as HTMLInputElement).value = '123456';
    h.submit('home-email-code');
    await until(() => h.page.errorCode !== null, 'the refusal');
    expect(h.page.stage).toBe('signed_out');
    expect(h.page.errorCode).toBe('email_token_invalid');
    expect(h.fetches.filter((f) => f.url.pathname === '/v1/home/apps')).toEqual([]);
  });

  it('the issuer’s limits and refusals read as the email step’s sentences; the email route off ends the attempt', async () => {
    const issuer = emailIssuer();
    const h = start({ email: issuer });
    await h.page.idle();
    h.click('home-sign-in-email');
    const send = async (fn: () => Promise<never>) => {
      // The page makes the sign-in's key (real WebCrypto) before it calls the issuer: wait for the call, not for ticks.
      let called = false;
      issuer.start = (async () => {
        called = true;
        return fn();
      }) as unknown as HomeEmailApi['start'];
      (document.getElementById('home-email-address') as HTMLInputElement).value = 'user@example.com';
      h.submit('home-email-address');
      await until(() => called, 'the issuer call');
      for (let i = 0; i < 5; i++) await tick();
    };
    await send(async () => {
      throw new ApiError(429, 'rate_limited', 'x', null, null);
    });
    expect(document.getElementById('home-email-notice')?.textContent).toContain('Too many attempts. Try again later.');
    await send(async () => {
      throw new ApiError(400, 'email_domain_not_allowed', 'x', null, null);
    });
    expect(document.getElementById('home-email-notice')?.textContent).toContain('Addresses on this domain can’t be used to sign in.');
    await send(async () => {
      throw new TypeError('network');
    });
    expect(document.getElementById('home-email-notice')?.textContent).toContain('A code may already be on its way');
    expect(document.getElementById('home-email-retry')).not.toBeNull();
    await send(async () => {
      throw new ApiError(409, 'home_email_unavailable', 'x', null, null);
    });
    expect(h.page.stage).toBe('signed_out');
    expect(h.page.errorCode).toBe('home_email_unavailable');
  });

  it('a wrong code says how many tries are left; none left goes back to the address', async () => {
    const issuer = emailIssuer();
    const h = start({ email: issuer });
    await h.page.idle();
    h.click('home-sign-in-email');
    (document.getElementById('home-email-address') as HTMLInputElement).value = 'user@example.com';
    h.submit('home-email-address');
    await until(() => document.getElementById('home-email-code') !== null, 'the code screen');
    let left = 1;
    issuer.verify = async () => {
      throw new ApiError(400, 'code_invalid', 'x', null, null, { data: { attemptsLeft: left-- } });
    };
    (document.getElementById('home-email-code') as HTMLInputElement).value = '111111';
    h.submit('home-email-code');
    await until(() => document.getElementById('home-email-notice') !== null, 'the notice');
    expect(document.getElementById('home-email-notice')?.textContent).toContain('That code is wrong. 1 try left.');
    (document.getElementById('home-email-code') as HTMLInputElement).value = '111111';
    h.submit('home-email-code');
    await until(() => document.getElementById('home-email-address') !== null, 'the address screen');
    expect(document.getElementById('home-email-notice')?.textContent).toContain('no tries left');
  });

  it('signing in again with email: a new code to the same address and a new key; the same account keeps the screen', async () => {
    const issuer = emailIssuer();
    const h = start({ email: issuer });
    await h.toAppByEmail();
    advance(13 * 60_000 + 1);
    h.click('home-sign-in-again');
    // The address is the sign-in's own: no field, one button.
    expect(document.getElementById('home-email-address')).toBeNull();
    expect(document.getElementById('home-email-to')?.textContent).toBe('user@example.com');
    const listed = h.fetches.filter((f) => f.url.pathname === '/v1/home/apps').length;
    h.click('home-email-send');
    await until(() => document.getElementById('home-email-code') !== null, 'the code screen');
    (document.getElementById('home-email-code') as HTMLInputElement).value = '123456';
    h.submit('home-email-code');
    await until(() => h.page.session === 'active', 'the new sign-in');
    expect(issuer.starts).toHaveLength(2);
    expect(issuer.starts[1]!.email).toBe('user@example.com');
    expect((issuer.starts[1]!.commitment as HomeIdentityCommitment).homePublicKey).not.toEqual((issuer.starts[0]!.commitment as HomeIdentityCommitment).homePublicKey);
    // The same method and id: the screen stays, nothing fetched.
    expect(h.page.openScope).toBe(SCOPE);
    expect(h.fetches.filter((f) => f.url.pathname === '/v1/home/apps').length).toBe(listed);
  });

  it('signing in again as another email account clears the screen and loads that account’s list', async () => {
    const issuer = emailIssuer();
    const h = start({ email: issuer });
    await h.toAppByEmail();
    advance(13 * 60_000 + 1);
    h.click('home-sign-in-again');
    issuer.sub = `e1.${'Z'.repeat(43)}`;
    h.click('home-email-send');
    await until(() => document.getElementById('home-email-code') !== null, 'the code screen');
    (document.getElementById('home-email-code') as HTMLInputElement).value = '123456';
    h.submit('home-email-code');
    await until(() => h.page.openScope === null, 'the screen to start over');
    await h.page.idle();
    expect(h.fetches.filter((f) => f.url.pathname === '/v1/home/apps')).toHaveLength(2);
  });

  it('opening a wallet by email: the code goes to the sign-in’s address; a linked member reaches its root (the vectors’ address)', async () => {
    const issuer = emailIssuer();
    const emailMember: IdentityFn = (p, s) => (p === 'email' && s === ESUB ? { key: identityKeyHex(SCOPE, p, s), status: 'member', opened: false, root: { provider: 'google', sub: ROOT_SUB }, effective_at_ms: 1, account_epoch: 1 } : undefined);
    const h = start({
      email: issuer,
      identity: emailMember,
      chainPath: ROOT,
      scopes: [mineScope({ coverage: 'email', googleClientId: null, addresses: [{ chain: 'stellar', address: vector(ROOT).accounts[0]!.stellar.address }] })],
      registry: { scope: { id: SCOPE, allow_shared: false, clients: [['email', `email:${SCOPE}`]] }, config: { shared_clients: [], exit_clients: [] } },
    });
    await h.toAppByEmail();
    await h.openByEmail();
    expect(h.page.moving.state, pageText()).toBe('unlocked');
    expect(h.win.opened).toEqual([]);
    expect(issuer.starts.map((x) => [x.kind, x.email])).toEqual([
      ['identity', 'user@example.com'],
      ['derive', 'user@example.com'],
    ]);
    const c = issuer.starts[1]!.commitment as HomeSessionCommitment;
    expect(c.scopeId).toBe(SCOPE);
    // The per-app code is asked for with Hana Home's own sign-in token; the sign-in's own code with none.
    expect(issuer.starts[1]!.identity).toBe(issuer.tokens[0]);
    expect(issuer.starts[0]!.identity).toBeUndefined();
    const want = vector(ROOT).accounts[0]!;
    expect(document.getElementById('home-export-address-stellar')?.textContent).toBe(want.stellar.address);
    expect(document.getElementById('home-export-address-evm')?.textContent).toBe(want.evm.address);
    // One derive, key index 0, one use, the email token of this session.
    const body = JSON.parse(new TextDecoder().decode(h.logins()[0]!.body as Uint8Array)) as Record<string, unknown>;
    expect([body.keyIndex, body.maxUses, body.scopeId]).toEqual([0, 1, SCOPE]);
    expect((body.jwt as string).startsWith('{')).toBe(true);
    // The root's path was confirmed on both providers.
    for (const on of ['primary', 'second'] as const) expect(h.nearCalls.some((x) => x.on === on && x.method === 'get_identity')).toBe(true);
  });

  it('the email exit: a scope that dropped its email client opens the identity’s own path with the exit token', async () => {
    const issuer = emailIssuer();
    issuer.deriveAud = HOME_EMAIL_AUDIENCE;
    const path = `${SCOPE}#email#${ESUB}#0`;
    const h = start({
      email: issuer,
      chainPath: path,
      scopes: [mineScope({ coverage: 'exit', googleClientId: null, addresses: [] })],
      registry: { scope: { id: SCOPE, allow_shared: false, clients: [['google', OWN_CLIENT]] }, config: { shared_clients: [], exit_clients: [['email', HOME_EMAIL_AUDIENCE]] } },
    });
    await h.toAppByEmail();
    await h.openByEmail();
    expect(h.page.moving.state, pageText()).toBe('unlocked');
    const want = addressesOf(path);
    expect(document.getElementById('home-export-address-stellar')?.textContent).toBe(want.stellar);
    expect(document.getElementById('home-export-address-evm')?.textContent).toBe(want.evm);
  });

  it.each([
    ['the scope has neither its email client nor the email exit on NEAR', { scope: { id: SCOPE, allow_shared: true, clients: [] }, config: { shared_clients: [], exit_clients: [] } }],
    ['the scope isn’t registered', { scope: null, config: { shared_clients: [] } }],
  ])('refuses before a code is sent when %s', async (_, registry) => {
    const issuer = emailIssuer();
    const h = start({ email: issuer, scopes: [mineScope({ coverage: 'email', googleClientId: null })], registry });
    await h.toAppByEmail();
    await h.openByEmail();
    expect(h.page.moving.errorCode).toBe('not_covered');
    expect(issuer.starts).toHaveLength(1);
    expect(h.logins()).toEqual([]);
  });

  it('a per-app token that isn’t this session’s, or is another account’s, is refused before anything is sent', async () => {
    for (const [over, code] of [
      [{ deriveAud: 'email:other' }, 'email_token_invalid'],
      [{ sub: `e1.${'B'.repeat(43)}` }, 'home_account_mismatch'],
    ] as const) {
      resetDom();
      const issuer = emailIssuer();
      const h = start({ email: issuer, scopes: [mineScope({ coverage: 'email', googleClientId: null })], registry: { scope: { id: SCOPE, allow_shared: false, clients: [['email', `email:${SCOPE}`]] }, config: { shared_clients: [] } } });
      await h.toAppByEmail();
      Object.assign(issuer, over);
      await h.openByEmail();
      expect(h.page.moving.errorCode).toBe(code);
      expect(h.logins()).toEqual([]);
    }
  });

  it('the route for an email account: the email codes for coverage email or exit, nothing else', () => {
    expect(homeExportRoute(mineScope({ coverage: 'email' }) as never, null, false, 'email', false)).toBe('none');
    expect(homeExportRoute(mineScope({ coverage: 'exit' }) as never, null, false, 'email', true)).toEqual({ kind: 'email' });
    expect(homeExportRoute(mineScope({ coverage: 'email' }) as never, null, false, 'email', true)).toEqual({ kind: 'email' });
    expect(homeExportRoute(mineScope({ coverage: 'shared' }) as never, null, false, 'email', true)).toBe('none');
    expect(homeExportRoute(mineScope({ coverage: 'email' }) as never, null, true, 'email', true)).toBe('link');
  });
});

describe('H10 review: the issuer refuses the Home sign-in behind a per-app code', () => {
  it('home_identity_invalid ends Hana Home’s sign-in and says so; nothing is derived', async () => {
    const issuer = emailIssuer();
    const h = start({ email: issuer, scopes: [mineScope({ coverage: 'email', googleClientId: null })], registry: { scope: { id: SCOPE, allow_shared: false, clients: [['email', `email:${SCOPE}`]] }, config: { shared_clients: [] } } });
    await h.toAppByEmail();
    issuer.start = (async () => {
      throw new ApiError(401, 'home_identity_invalid', 'x', null, null);
    }) as unknown as HomeEmailApi['start'];
    await h.openByEmail();
    expect(h.page.moving.errorCode).toBe('home_signed_out');
    expect(h.page.session).toBe('ended');
    expect(h.logins()).toEqual([]);
  });
});

describe('H10: an email sign-in ends with its token', () => {
  it('the warning and the end follow the email token’s 10 minutes, not the identity’s 15', async () => {
    const h = start({ email: emailIssuer() });
    await h.page.idle();
    // The first screen promises no number of minutes: the methods differ.
    expect(pageText()).toContain('You stay signed in for a short time');
    expect(pageText()).not.toContain('15 minutes');
    await h.toAppByEmail();
    expect(h.page.session).toBe('active');
    advance(8 * 60_000 + 1);
    expect(h.page.session).toBe('ending');
    expect(document.getElementById('home-ending')?.textContent).toContain('ends in about 2 minutes');
    advance(2 * 60_000);
    expect(h.page.session).toBe('ended');
    expect(document.getElementById('home-ended')).not.toBeNull();
  });

  it('a Google sign-in still lasts its 15 minutes (its token outlives them)', async () => {
    const h = start();
    await h.toApp();
    advance(10 * 60_000 + 1);
    expect(h.page.session).toBe('active');
    advance(3 * 60_000);
    expect(h.page.session).toBe('ending');
  });
});
