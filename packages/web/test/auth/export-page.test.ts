// @vitest-environment happy-dom
// /export (docs/batch-b-spec.md "Key export", "Tests → Web unit → Export"): refused when framed, without a gesture,
// with a vault reply from the wrong source, with a stale auth_time or on an address mismatch; the child login popup's
// name is random; a fresh login of its own (its own session key, nonce, relay and path); typed confirmation and
// the Show/Hide key toggle and Copy key (D268); no message in either direction carries key material.
import {
  ApiError,
  type AppConfig,
  type LoginBody,
  type RelayPayload,
  type RelayReadResponse,
  addressOfExport,
  chainAddress,
  ckdAppId,
  encryptRelayPayload,
  extractPrk,
  identityKeyHex,
  newAppKey,
  parsePortReply,
  parseWindowMessage,
  sessionNonce,
} from '@hana-id/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthApi } from '../../src/auth/api.ts';
import {
  EXPORT_CHECK_MS,
  EXPORT_CLIPBOARD_CLEAR_MS,
  EXPORT_CONFIRMATION,
  EXPORT_COPY_UNAVAILABLE,
  EXPORT_END_TEXT,
  EXPORT_KEY_LIFETIME_MS,
  EXPORT_SHOW_MS,
  EXPORT_WARNING,
  startExportPage,
} from '../../src/auth/export-page.ts';
import type { NearReader } from '../../src/auth/near-rpc.ts';
import { simulateMpc } from '../../../core/test/helpers.ts';
import { CLIENT_ID, ENV, EVIL, FakeWindow, NET, PARTNER, PK, type RemoteWindow, type TokenSigner, asWindow, emailIssuerSigner, flush, pageText, remoteWindow, resetDom, tokenSigner } from './helpers.ts';

const SCOPE = 's1';
const SUB = '110248495921238986420';
const PATH = `${SCOPE}#google#${SUB}#0`;

/** The address the fixed MPC network gives PATH (S doesn't depend on the ephemeral app key). */
function addressFor(chain: 'stellar' | 'evm' | 'near', path = PATH): string {
  const { expected } = simulateMpc(newAppKey().publicKey.AppPublicKeyPV.pk1, ckdAppId(ENV.signer, path), NET);
  const prk = extractPrk(Uint8Array.from(expected));
  return chainAddress(prk, chain, 0);
}

const appConfig = (over: Partial<AppConfig> = {}): AppConfig => ({
  scopeId: SCOPE,
  signer: ENV.signer,
  google: { clientId: CLIENT_ID, mode: 'shared' },
  name: 'Partner App',
  serverTimeMs: Date.now(),
  requestId: 'r',
  ...over,
});

let signer: TokenSigner;

interface Run {
  win: FakeWindow;
  vault: RemoteWindow;
  child: RemoteWindow;
  api: AuthApi & Record<'getApp' | 'readRelay' | 'login', ReturnType<typeof vi.fn>>;
  page: ReturnType<typeof startExportPage>;
  /** Resolves the pending relay read with this payload, encrypted as the callback would. */
  deliver(claims?: Record<string, unknown> | { error: string }): Promise<void>;
  /** Resolves the relay read with any payload (an email token: batch 8b). */
  deliverPayload(make: (params: Record<string, unknown>) => Promise<RelayPayload>): Promise<void>;
  loginBodies: LoginBody[];
  /** What the injected Clipboard API was asked to write, in order (it is never read). */
  clipboardWrites: string[];
  /** Whether events count as user gestures from now on. */
  setGesture(v: boolean): void;
  /** Whether the window has focus from now on. */
  setFocus(v: boolean): void;
}

function run(
  o: {
    chain?: 'stellar' | 'evm' | 'near';
    address?: string;
    config?: AppConfig;
    loginPath?: string;
    gesture?: boolean;
    sessionExpiresAtMs?: number;
    env?: typeof ENV;
    identity?: (provider: string, sub: string) => Record<string, unknown> | undefined;
    /** The second provider's get_identity (D263), when it differs from the first's; `null`: no second provider. */
    secondIdentity?: ((provider: string, sub: string) => Record<string, unknown> | undefined) | null;
    emailKeys?: { kid: string; n: string; e: string }[];
    /** Raw `get_issuer_keys` / `get_self_issued` answers (W-L2), instead of the ones made from `emailKeys`. */
    rawEmailViews?: { keys?: unknown; policy?: unknown };
    /** The Clipboard API (default: one that records each write); null: the browser has none. */
    clipboard?: { writeText(text: string): Promise<void> } | null;
    /** Batch C11: the context's logoUrl. */
    contextLogo?: string;
  } = {},
): Run {
  const chain = o.chain ?? 'stellar';
  const win = new FakeWindow('/export');
  const vault = remoteWindow();
  const child = remoteWindow();
  win.opener = asWindow(vault);
  win.openResult = child;
  let resolveRead: (v: RelayReadResponse | null) => void = () => {};
  const loginBodies: LoginBody[] = [];
  const api = {
    getApp: vi.fn(async () => o.config ?? appConfig()),
    emailPreview: vi.fn(async () => 'unused@example.com'),
    writeRelay: vi.fn(),
    readRelay: vi.fn(
      () =>
        new Promise<RelayReadResponse | null>((r) => {
          resolveRead = r;
        }),
    ),
    login: vi.fn(async (_pk: string, _parent: string, body: LoginBody) => {
      loginBodies.push(structuredClone(body));
      const { response } = simulateMpc(body.pk1, ckdAppId(ENV.signer, o.loginPath ?? PATH), NET);
      return { result: response, session: { scope_id: SCOPE, expires_at_ms: body.expiresAtMs, max_uses: 1, used: 1 as const }, nearTx: 'tx', requestId: 'r' };
    }),
  };
  // get_identity (batch 7): own unless the test links the identity; the email views for an email re-authentication.
  const views =
    (identity: ((provider: string, sub: string) => Record<string, unknown> | undefined) | undefined) =>
    async (method: string, args: unknown): Promise<unknown> => {
      const a = args as { provider: string; sub: string; scope_id: string; aud: string };
      if (method === 'get_identity') return identity?.(a.provider, a.sub) ?? { key: identityKeyHex(a.scope_id, a.provider, a.sub), status: 'own', opened: true, account_epoch: 0 };
      if (method === 'scope_for_client') return SCOPE;
      if (method === 'get_issuer_keys') return o.rawEmailViews && 'keys' in o.rawEmailViews ? o.rawEmailViews.keys : (o.emailKeys ?? null);
      if (method === 'get_self_issued') {
        if (o.rawEmailViews && 'policy' in o.rawEmailViews) return o.rawEmailViews.policy;
        return o.emailKeys ? { signers: [{ id: 'hana', kids: o.emailKeys.map((k) => k.kid) }], required: 1 } : null;
      }
      return null;
    };
  const first = views(o.identity);
  const second = o.secondIdentity === null ? null : views(o.secondIdentity ?? o.identity);
  const near: NearReader = {
    getSession: vi.fn(),
    txOutcome: vi.fn(),
    view: vi.fn(async (_signer: string, method: string, args: unknown) => first(method, args)),
    independent: vi.fn(() => (second ? { primary: first, second } : null)),
  };
  let gesture = o.gesture ?? true;
  let focus = true;
  const clipboardWrites: string[] = [];
  const clipboard = o.clipboard === undefined ? { writeText: vi.fn(async (t: string) => void clipboardWrites.push(t)) } : o.clipboard;
  const page = startExportPage({
    win,
    env: o.env ?? ENV,
    api,
    near,
    jwks: async (kid) => (kid === signer.jwk.kid ? signer.jwk : null),
    sleep: async () => {},
    isGesture: () => gesture,
    clipboard,
    hasFocus: () => focus,
    // The guard's clock (D430): 2 s on per read, so its 1 s waits are always over; the arming gesture is still needed.
    guardNow: () => (guardTime += 2000),
  });
  current = win;
  const context = {
    v: 1,
    t: 'hana:export-context',
    pk: PK,
    appName: 'Vault name',
    parentOrigin: PARTNER,
    scopeId: SCOPE,
    signer: ENV.signer,
    keyIndex: 0,
    chain,
    address: o.address ?? addressFor(chain),
    ...(o.sessionExpiresAtMs === undefined ? {} : { sessionExpiresAtMs: o.sessionExpiresAtMs }),
    ...(o.contextLogo === undefined ? {} : { logoUrl: o.contextLogo }),
  };
  win.message(context, ENV.vaultOrigin, vault);
  return {
    win,
    vault,
    child,
    api: api as never,
    page,
    loginBodies,
    clipboardWrites,
    setGesture(v) {
      gesture = v;
    },
    setFocus(v) {
      focus = v;
    },
    async deliverPayload(make) {
      const params = parseWindowMessage(child.received[0], ['hana:auth-params']);
      if (!params) throw new Error('no auth-params sent');
      const value = await encryptRelayPayload(params.relayKey, params.relayId, await make(params as unknown as Record<string, unknown>));
      resolveRead({ ...value, serverTimeMs: Date.now() });
    },
    async deliver(claims) {
      const params = parseWindowMessage(child.received[0], ['hana:auth-params']);
      if (!params) throw new Error('no auth-params sent');
      const now = Math.floor(Date.now() / 1000);
      const payload =
        claims && 'error' in claims
          ? { error: claims.error as string }
          : { idToken: await signer.sign({ iss: 'https://accounts.google.com', azp: CLIENT_ID, aud: CLIENT_ID, sub: SUB, iat: now, exp: now + 3600, nonce: params.nonce, ...claims }) };
      const value = await encryptRelayPayload(params.relayKey, params.relayId, payload);
      resolveRead({ ...value, serverTimeMs: Date.now() });
    },
  };
}

const button = (label: RegExp) => [...document.querySelectorAll('button')].find((b) => label.test(b.textContent ?? '')) ?? null;
/** The guard's clock and the window of the run in progress (the guarded buttons need a moving pointer first, D430). */
let guardTime = 0;
let current: { dispatch(type: string, event?: Record<string, unknown>): void } | null = null;
let pointerX = 0;
/** A user's click: the pointer moves (arming the guard), then presses and clicks on the button. */
const click = (b: Element | null) => {
  if (!b) return;
  pointerX += 7;
  current?.dispatch('pointermove', { pointerType: 'mouse', movementX: 3, movementY: 1, clientX: pointerX, clientY: 10 });
  current?.dispatch('pointerdown', { pointerType: 'mouse', clientX: pointerX, clientY: 10 });
  b.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
};
/** A click with no pointer movement before it (a press carried over from another window, or a coached Enter). */
const stillClick = (b: Element | null) => b?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));

/** The reveal step's controls (D268). */
function revealControls(): { toggle: HTMLButtonElement; copy: HTMLButtonElement; secret: HTMLElement; status: HTMLElement } {
  return {
    toggle: button(/^(Show|Hide) key$/u) as HTMLButtonElement,
    copy: button(/^(Copy key|Copied)$/u) as HTMLButtonElement,
    secret: document.querySelector('.secret') as HTMLElement,
    status: document.querySelector('.copy-status') as HTMLElement,
  };
}

/** Confirm screen → typed confirmation → Continue: the reveal step. */
function continueToReveal(): ReturnType<typeof revealControls> {
  const input = document.querySelector('input') as HTMLInputElement;
  input.value = EXPORT_CONFIRMATION;
  input.dispatchEvent(new Event('input'));
  click(button(/Continue/u));
  return revealControls();
}

/** Context accepted → click → child hello → auth-params sent. */
async function signIn(r: Run): Promise<void> {
  await vi.waitFor(() => expect(r.page.state).toBe('ready'));
  click(button(/Sign in with Google/u));
  await vi.waitFor(() => expect(r.win.opened).toHaveLength(1));
  // The window opens the child before any await and answers its (repeated) hello once its session is ready.
  expect(r.win.opened).toHaveLength(1);
  await vi.waitFor(() => {
    r.win.message({ v: 1, t: 'hana:auth-hello' }, ENV.authOrigin, r.child);
    expect(r.child.received).toHaveLength(1);
  });
}

beforeEach(async () => {
  resetDom();
  signer ??= await tokenSigner();
});

describe('/export: the app’s logo (batch C11)', () => {
  const FILES = 'https://files.hana.test';
  const logo = (n: string) => `${FILES}/logos/app_abc/${n.repeat(64)}.png`;
  const FILES_ENV = { ...ENV, filesOrigin: FILES };
  const ready = (r: Run) => vi.waitFor(() => expect(r.page.state).toBe('ready'));

  it('shows its own GET /v1/app’s logo beside the name and hands it to the sign-in child', async () => {
    const r = run({ env: FILES_ENV, config: appConfig({ logoUrl: logo('a') }), contextLogo: logo('b') });
    await ready(r);
    expect(document.querySelector('img.app-logo')?.getAttribute('src')).toBe(logo('a'));
    await signIn(r);
    expect(parseWindowMessage(r.child.received[0], ['hana:auth-params'])?.logoUrl).toBe(logo('a'));
  });

  it('a GET /v1/app answer of null means no logo; an older API (no field) leaves the vault’s', async () => {
    const none = run({ env: FILES_ENV, config: appConfig({ logoUrl: null }), contextLogo: logo('b') });
    await ready(none);
    expect(document.querySelector('img')).toBeNull();
    await signIn(none);
    expect(none.child.received[0]).not.toHaveProperty('logoUrl');
    resetDom();
    const older = run({ env: FILES_ENV, contextLogo: logo('b') });
    await ready(older);
    expect(document.querySelector('img.app-logo')?.getAttribute('src')).toBe(logo('b'));
  });

  it('never a logo off the build’s files origin, or in a build without one', async () => {
    const other = run({ env: FILES_ENV, config: appConfig({ logoUrl: `https://cdn.partner.example/logos/app_abc/${'c'.repeat(64)}.png` }) });
    await ready(other);
    expect(document.querySelector('img')).toBeNull();
    await signIn(other);
    expect(other.child.received[0]).not.toHaveProperty('logoUrl');
    resetDom();
    const noFiles = run({ config: appConfig({ logoUrl: logo('a') }) });
    await ready(noFiles);
    expect(document.querySelector('img')).toBeNull();
  });
});

describe('/export resolves the path through get_identity (batch 7) and takes an email code (batch 8b, D246 lifted)', () => {
  const E_SUB = `e1.${'Q'.repeat(43)}`;
  const E_PATH = `${SCOPE}#email#${E_SUB}#0`;
  const EMAIL_ENV = { ...ENV, emailIssuerUrl: 'https://issuer.hana.test', emailIss: 'https://issuer.hana.test/v1/email' };
  const emailApp = () => appConfig({ loginMethods: ['google', 'email'], email: { aud: `email:${SCOPE}` } } as Partial<AppConfig>);

  async function signInAgain(r: Run): Promise<void> {
    await vi.waitFor(() => expect(r.page.state).toBe('ready'));
    click(button(/Sign in again/u));
    await vi.waitFor(() => {
      r.win.message({ v: 1, t: 'hana:auth-hello' }, ENV.authOrigin, r.child);
      expect(r.child.received).toHaveLength(1);
    });
  }

  it('a Google member of an email wallet exports the account root’s key (the shared wallet)', async () => {
    const r = run({
      address: addressFor('stellar', E_PATH),
      loginPath: E_PATH,
      identity: (p, s) => (p === 'google' ? { key: identityKeyHex(SCOPE, p, s), status: 'member', opened: false, root: { provider: 'email', sub: E_SUB }, effective_at_ms: 1, account_epoch: 1 } : undefined),
    });
    await signIn(r);
    await r.deliver();
    expect(await r.page.settled).toBe('confirm');
  });

  it('D263: a member view only one provider gives (a lying RPC) exports nothing, before any login', async () => {
    const member = (p: string, s: string) => (p === 'google' ? { key: identityKeyHex(SCOPE, p, s), status: 'member', opened: false, root: { provider: 'email', sub: E_SUB }, effective_at_ms: 1, account_epoch: 1 } : undefined);
    // The second provider says own (it disagrees), or the env has none (unconfirmed): never the root's path.
    const honestOwn = () => undefined;
    for (const secondIdentity of [honestOwn, null]) {
      const r = run({ address: addressFor('stellar', E_PATH), loginPath: E_PATH, identity: member, secondIdentity });
      await signIn(r);
      await r.deliver();
      expect(await r.page.settled).toBe('error');
      expect(r.page.errorCode).toBe('api_unavailable');
      expect(r.api.login).not.toHaveBeenCalled();
    }
  });

  it('a pending member exports nothing (link_pending), before any login', async () => {
    const r = run({ identity: (p, s) => ({ key: identityKeyHex(SCOPE, p, s), status: 'pending', opened: false, root: { provider: 'email', sub: E_SUB }, effective_at_ms: 9, account_epoch: 1 }) });
    await signIn(r);
    await r.deliver();
    expect(await r.page.settled).toBe('error');
    expect(r.page.errorCode).toBe('link_pending');
    expect(r.api.login).not.toHaveBeenCalled();
  });

  it('W-L2: the email keys and signer policy are parsed strictly: one malformed entry refuses, never a policy of the rest', async () => {
    const issuer = await emailIssuerSigner();
    const bad = [
      { policy: { signers: [{ id: 'hana', kids: [issuer.chainKey.kid] }, { id: 5, kids: [] }], required: 1 } },
      { policy: { signers: [{ id: 'hana', kids: [issuer.chainKey.kid] }], required: '1' } },
      { keys: [issuer.chainKey, { kid: 'x' }] },
    ];
    for (const rawEmailViews of bad) {
      const r = run({ env: EMAIL_ENV, config: emailApp(), address: addressFor('stellar', E_PATH), loginPath: E_PATH, emailKeys: [issuer.chainKey], rawEmailViews });
      await signInAgain(r);
      await r.deliverPayload(async (p) => {
        const now = Math.floor(Date.now() / 1000);
        return { idToken: await issuer.token({ iss: EMAIL_ENV.emailIss, aud: `email:${SCOPE}`, sub: E_SUB, iat: now, exp: now + 600, nonce: p.nonce, jti: 'j' }) };
      });
      expect(await r.page.settled, JSON.stringify(rawEmailViews)).toBe('error');
      expect(r.page.errorCode).toBe('api_unavailable');
      expect(r.api.login).not.toHaveBeenCalled();
    }
  });

  it('an app with email: the child offers both methods; an email code over this window’s own session exports the email wallet', async () => {
    const issuer = await emailIssuerSigner();
    const r = run({ env: EMAIL_ENV, config: emailApp(), address: addressFor('stellar', E_PATH), loginPath: E_PATH, emailKeys: [issuer.chainKey] });
    await signInAgain(r);
    const params = parseWindowMessage(r.child.received[0], ['hana:auth-params']);
    expect(params?.methods).toEqual(['google', 'email']);
    await r.deliverPayload(async (p) => {
      const now = Math.floor(Date.now() / 1000);
      return { idToken: await issuer.token({ iss: EMAIL_ENV.emailIss, aud: `email:${SCOPE}`, sub: E_SUB, iat: now, exp: now + 600, nonce: p.nonce, jti: 'j' }) };
    });
    expect(await r.page.settled).toBe('confirm');
    expect(r.loginBodies[0]?.jwt.startsWith('{"payload":')).toBe(true);
  });

  it('an email token for another session (or without the chain’s key) is refused', async () => {
    const issuer = await emailIssuerSigner();
    const r = run({ env: EMAIL_ENV, config: emailApp(), loginPath: E_PATH, emailKeys: [issuer.chainKey] });
    await signInAgain(r);
    await r.deliverPayload(async () => {
      const now = Math.floor(Date.now() / 1000);
      return { idToken: await issuer.token({ iss: EMAIL_ENV.emailIss, aud: `email:${SCOPE}`, sub: E_SUB, iat: now, exp: now + 600, nonce: 'n'.repeat(43), jti: 'j' }) };
    });
    expect(await r.page.settled).toBe('error');
    expect(r.page.errorCode).toBe('token_invalid');
    expect(r.api.login).not.toHaveBeenCalled();
  });
});

describe('/export: what the user is told and what the API hears (D430)', () => {
  it('warns plainly on the first and the confirm screen: funds, no recovery, never into a website', async () => {
    expect(EXPORT_WARNING).toContain('Anyone with this key controls your funds');
    expect(EXPORT_WARNING).toContain('Hana can’t recover it');
    expect(EXPORT_WARNING).toContain('Never paste it into a website');
    const r = run();
    await vi.waitFor(() => expect(r.page.state).toBe('ready'));
    expect(pageText()).toContain(EXPORT_WARNING);
    await signIn(r);
    await r.deliver();
    expect(await r.page.settled).toBe('confirm');
    expect(pageText()).toContain(EXPORT_WARNING);
  });

  it('names the chain in its login body (exportChain), and nothing else is added', async () => {
    for (const chain of ['stellar', 'evm'] as const) {
      const r = run({ chain, address: addressFor(chain) });
      await signIn(r);
      await r.deliver();
      expect(await r.page.settled).toBe('confirm');
      expect(Object.keys(r.loginBodies[0] as object).sort()).toEqual(['expiresAtMs', 'exportChain', 'jwt', 'keyIndex', 'maxUses', 'pk1', 'pk2', 'salt', 'sessionPublicKey', 'signature']);
      expect((r.loginBodies[0] as { exportChain: string }).exportChain).toBe(chain);
      resetDom();
    }
  });
});

describe('/export: the key never leaves this window (source check, D430)', () => {
  // The page's own source (vitest runs from packages/web; this file's URL isn't a file: one under happy-dom).
  const codeOf = (file: string): string =>
    readFileSync(join(process.cwd(), 'src', 'auth', file), 'utf8')
      // Comments say what the code must not do; only the code counts here.
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .replace(/^\s*\/\/.*$/gmu, '');
  const source = codeOf('export-page.ts');
  /** The reveal the window shares with Hana Home: where the key's text reaches the screen and the clipboard. */
  const reveal = codeOf('key-reveal.ts');

  it('stores nothing, logs nothing, and never touches the URL or the network directly', () => {
    for (const banned of [/localStorage/u, /sessionStorage/u, /indexedDB/u, /document\.cookie/u, /\bconsole\./u, /\bfetch\(/u, /XMLHttpRequest/u, /sendBeacon/u, /location\.(?:href|hash|search|assign|replace)/u, /history\.(?:pushState|replaceState)/u, /WebSocket/u]) {
      expect(source, String(banned)).not.toMatch(banned);
      expect(reveal, `key-reveal.ts ${String(banned)}`).not.toMatch(banned);
    }
    expect(reveal).not.toMatch(/postMessage/u);
  });

  it('posts only its hello and the child’s auth-params, and the key string goes only to the screen and the clipboard', () => {
    // Each postMessage call's message: everything up to its target origin argument (`, env.…Origin)`).
    const posts = [...source.matchAll(/\.postMessage\(([\s\S]*?), env\.(?:authOrigin|vaultOrigin)\)/gu)].map((m) => m[1]!.trim());
    expect(posts).toEqual(['pending.params', "{ v: 1, t: 'hana:export-hello' }"]);
    // exportString(…) is the key's text: shown (textContent), copied (writeText) or checked against the address.
    const uses = [...source.matchAll(/^.*exportString\(.*$/gmu)].map((m) => m[0].trim());
    expect(uses.filter((l) => !l.startsWith('import '))).toEqual([
      'address = addressOfExport(ctx.chain, exportString(ctx.chain, chainKey));',
      'const r = keyReveal({ d, win, guard, isGesture, clipboard, hasFocus, ready: () => key !== null && !check(), secret: () => (key ? exportString(ctx.chain, key) : null) });',
    ]);
    // In the shared reveal the string is asked for twice (Show, Copy) and goes to one text node or the clipboard's write.
    expect([...reveal.matchAll(/^.*deps\.secret\(\).*$/gmu)].map((m) => m[0].trim())).toEqual(['const text = deps.secret();', 'const text = deps.secret();']);
    expect([...reveal.matchAll(/^.*\btext\b.*$/gmu)].map((m) => m[0].trim()).filter((l) => !l.startsWith('const text = ') && !l.startsWith('if (text === null)'))).toEqual([
      'writeText(text: string): Promise<void>;',
      'out.textContent = text;',
      'write = c.writeText(text);',
    ]);
    // The login body (to the API) is built from the session's public values and the Google token, never the key.
    const body = /const body: LoginBody = \{([\s\S]*?)\};/u.exec(source)?.[1] ?? '';
    expect(body).not.toMatch(/\bkey\b|chainKey|prk|exportString/u);
  });

  it('no message to or from the partner page can carry a key: hana_export answers null, and the export messages carry public fields only', () => {
    expect(parsePortReply({ v: 1, id: 'r1', result: null }, 'hana_export')).not.toBeNull();
    for (const r of [{ key: 'S…' }, 'S…', [1, 2], {}]) expect(parsePortReply({ v: 1, id: 'r1', result: r }, 'hana_export'), JSON.stringify(r)).toBeNull();
    const context = { v: 1, t: 'hana:export-context', pk: PK, appName: 'A', parentOrigin: PARTNER, scopeId: SCOPE, signer: ENV.signer, keyIndex: 0, chain: 'stellar', address: addressFor('stellar') };
    expect(parseWindowMessage(context, ['hana:export-context'])).not.toBeNull();
    for (const extra of ['key', 'secret', 'seed', 'privateKey', 'prk']) expect(parseWindowMessage({ ...context, [extra]: 'x' }, ['hana:export-context']), extra).toBeNull();
    expect(parseWindowMessage({ v: 1, t: 'hana:export-end', key: 'x' }, ['hana:export-end'])).toBeNull();
    expect(parseWindowMessage({ v: 1, t: 'hana:export-hello', key: 'x' }, ['hana:export-hello'])).toBeNull();
  });
});

describe('/export', () => {
  it('says hello to the vault and checks its context against GET /v1/app', async () => {
    const r = run();
    expect(r.vault.postMessage).toHaveBeenCalledWith({ v: 1, t: 'hana:export-hello' }, ENV.vaultOrigin);
    await vi.waitFor(() => expect(r.page.state).toBe('ready'));
    expect(r.api.getApp).toHaveBeenCalledWith(PK, PARTNER);
    expect(pageText()).toContain('Export your Stellar key');
    expect(pageText()).toContain('Partner App');
  });

  it('exports the key after a fresh login of its own and a typed confirmation, shown only while Show key is on', async () => {
    const address = addressFor('stellar');
    const r = run({ address });
    await signIn(r);
    const opened = r.win.opened[0];
    expect(opened?.url).toBe(`${ENV.authOrigin}/login?mode=export`);
    expect(opened?.target).toMatch(/^hana-login-[0-9a-f]{32}$/u);
    expect(opened?.features).toBe('popup,width=480,height=640');

    // auth-params to the child, on authOrigin, with this window's own max_uses = 1 session and a nonce that commits to it.
    expect(r.child.postMessage.mock.calls[0]?.[1]).toBe(ENV.authOrigin);
    const params = parseWindowMessage(r.child.received[0], ['hana:auth-params']);
    expect(params).not.toBeNull();
    expect(params).toMatchObject({ pk: PK, parentOrigin: PARTNER, scopeId: SCOPE, signer: ENV.signer, clientId: CLIENT_ID, keyIndex: 0, maxUses: 1 });
    expect(params?.nonce).toBe(
      sessionNonce({ signer: ENV.signer, scopeId: SCOPE, sessionPublicKey: params!.sessionPublicKey, expiresAtMs: params!.expiresAtMs, keyIndex: 0, maxUses: 1, salt: params!.salt }),
    );

    await r.deliver();
    expect(await r.page.settled).toBe('confirm');
    expect(r.api.readRelay.mock.calls[0]?.[0]).toBe(params?.relayId);
    expect(r.loginBodies[0]).toMatchObject({ maxUses: 1, keyIndex: 0, expiresAtMs: params?.expiresAtMs });
    expect(r.child.closed).toBe(true);

    // Typed confirmation.
    const cont = button(/Continue/u) as HTMLButtonElement;
    const input = document.querySelector('input') as HTMLInputElement;
    expect(cont.disabled).toBe(true);
    input.value = 'export';
    input.dispatchEvent(new Event('input'));
    expect(cont.disabled).toBe(true);
    input.value = EXPORT_CONFIRMATION;
    input.dispatchEvent(new Event('input'));
    // Typed, but the guard (D430) waits for the pointer to move in this window first.
    expect(cont.disabled).toBe(true);
    stillClick(cont);
    expect(r.page.state).toBe('confirm');
    r.win.dispatch('pointermove', { pointerType: 'mouse', movementX: 2, movementY: 0, clientX: 1, clientY: 1 });
    expect(cont.disabled).toBe(false);
    click(cont);
    expect(r.page.state).toBe('reveal');

    // Show key / Hide key (D268): a click shows it, selectable, and a second click hides it.
    const { toggle, secret } = revealControls();
    expect(secret.textContent).toBe('••••••••');
    expect(secret.hasAttribute('data-shown')).toBe(false);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    click(toggle);
    const shown = secret.textContent as string;
    expect(shown).toMatch(/^S[A-Z2-7]{55}$/u);
    expect(addressOfExport('stellar', shown)).toBe(address);
    expect(secret.hasAttribute('data-shown')).toBe(true);
    expect(toggle.textContent).toBe('Hide key');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    // Releasing or leaving the button no longer hides it: the user can select and copy it.
    for (const t of ['pointerup', 'pointerleave', 'pointercancel', 'blur', 'keyup']) toggle.dispatchEvent(new Event(t));
    expect(secret.textContent).toBe(shown);
    click(toggle);
    expect(secret.textContent).toBe('••••••••');
    expect(secret.hasAttribute('data-shown')).toBe(false);
    expect(toggle.textContent).toBe('Show key');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    // No message to the vault or the child carries the key, and only auth-params carries a secret (relayKey).
    const all = JSON.stringify([...r.vault.received, ...r.child.received], (_, v) => (v instanceof Uint8Array ? Array.from(v) : v));
    expect(all).not.toContain(shown);
    expect(r.vault.received).toEqual([{ v: 1, t: 'hana:export-hello' }]);
    expect(r.child.received).toHaveLength(1);

    // Closing the window zeroes the key and takes it off the screen: the toggle shows nothing any more.
    click(toggle);
    expect(secret.textContent).toBe(shown);
    r.win.dispatch('pagehide');
    expect(secret.textContent).toBe('••••••••');
    click(toggle);
    expect(secret.textContent).toBe('••••••••');
  });

  it('exports an EVM key as 0x + 64 lowercase hex', async () => {
    const address = addressFor('evm');
    const r = run({ chain: 'evm', address });
    await signIn(r);
    await r.deliver();
    expect(await r.page.settled).toBe('confirm');
    const input = document.querySelector('input') as HTMLInputElement;
    input.value = EXPORT_CONFIRMATION;
    input.dispatchEvent(new Event('input'));
    click(button(/Continue/u));
    click(revealControls().toggle);
    const shown = document.querySelector('.secret')?.textContent as string;
    expect(shown).toMatch(/^0x[0-9a-f]{64}$/u);
    expect(addressOfExport('evm', shown)).toBe(address);
  });

  it('refuses on an address mismatch and shows nothing', async () => {
    const r = run({ address: addressFor('stellar', `${SCOPE}#google#someone-else#0`) });
    await signIn(r);
    await r.deliver();
    expect(await r.page.settled).toBe('error');
    expect(r.page.errorCode).toBe('address_mismatch');
    expect(document.querySelector('.secret')).toBeNull();
  });

  it('refuses a CKD answer for another path (pairing check against its own path)', async () => {
    const r = run({ loginPath: `${SCOPE}#google#attacker#0` });
    await signIn(r);
    await r.deliver();
    expect(await r.page.settled).toBe('error');
    expect(r.page.errorCode).toBe('pairing_failed');
  });

  it('refuses an auth_time older than 5 min, and accepts a fresh one', async () => {
    const stale = run();
    await signIn(stale);
    await stale.deliver({ auth_time: Math.floor(Date.now() / 1000) - 6 * 60 });
    expect(await stale.page.settled).toBe('error');
    expect(stale.page.errorCode).toBe('token_invalid');
    expect(stale.api.login).not.toHaveBeenCalled();

    resetDom();
    const fresh = run();
    await signIn(fresh);
    await fresh.deliver({ auth_time: Math.floor(Date.now() / 1000) - 30 });
    expect(await fresh.page.settled).toBe('confirm');
  });

  it.each([
    ['a wrong nonce', { nonce: 'x'.repeat(43) }, 'token_invalid'],
    ['a wrong audience', { aud: 'other.apps.googleusercontent.com' }, 'token_invalid'],
    ['an email claim', { email: 'a@b.example' }, 'token_has_pii'],
  ])('refuses a token with %s before /v1/login', async (_, claims, codeExpected) => {
    const r = run();
    await signIn(r);
    await r.deliver(claims);
    expect(await r.page.settled).toBe('error');
    expect(r.page.errorCode).toBe(codeExpected);
    expect(r.api.login).not.toHaveBeenCalled();
  });

  it('Google #error gives google_error', async () => {
    const r = run();
    await signIn(r);
    await r.deliver({ error: 'access_denied' });
    expect(await r.page.settled).toBe('error');
    expect(r.page.errorCode).toBe('google_error');
  });

  it('refuses to run framed', () => {
    const win = new FakeWindow('/export');
    const vault = remoteWindow();
    win.opener = asWindow(vault);
    win.top = {};
    const page = startExportPage({ win, env: ENV, api: {} as AuthApi, near: {} as NearReader });
    expect(page.state).toBe('error');
    expect(vault.postMessage).not.toHaveBeenCalled();
    expect(win.listenerCount('message')).toBe(0);
  });

  it('refuses to start without a user gesture', async () => {
    const r = run({ gesture: false });
    await vi.waitFor(() => expect(r.page.state).toBe('ready'));
    click(button(/Sign in with Google/u));
    await flush();
    expect(r.win.opened).toEqual([]);
  });

  it('ignores a vault reply from the wrong source or origin', async () => {
    const win = new FakeWindow('/export');
    const vault = remoteWindow();
    win.opener = asWindow(vault);
    const api = { getApp: vi.fn(async () => appConfig()) } as unknown as AuthApi;
    const page = startExportPage({ win, env: ENV, api, near: {} as NearReader });
    const context = { v: 1, t: 'hana:export-context', pk: PK, appName: 'A', parentOrigin: PARTNER, scopeId: SCOPE, signer: ENV.signer, keyIndex: 0, chain: 'evm', address: addressFor('evm') };
    win.message(context, ENV.vaultOrigin, remoteWindow());
    win.message(context, EVIL, vault);
    win.message(context, ENV.authOrigin, vault);
    await flush();
    expect(page.state).toBe('connecting');
    expect(api.getApp).not.toHaveBeenCalled();
  });

  it.each([
    ['the vault names another signer', { signerInContext: 'evil-signer.testnet' }, appConfig()],
    ['the API names another signer', {}, appConfig({ signer: 'evil-signer.testnet' })],
    ['the API has another scope', {}, appConfig({ scopeId: 's2' })],
  ])('refuses (config_mismatch) when %s', async (_, o, config) => {
    const win = new FakeWindow('/export');
    const vault = remoteWindow();
    win.opener = asWindow(vault);
    const page = startExportPage({ win, env: ENV, api: { getApp: vi.fn(async () => config) } as unknown as AuthApi, near: {} as NearReader });
    const signerName = (o as { signerInContext?: string }).signerInContext ?? ENV.signer;
    win.message({ v: 1, t: 'hana:export-context', pk: PK, appName: 'A', parentOrigin: PARTNER, scopeId: SCOPE, signer: signerName, keyIndex: 0, chain: 'evm', address: addressFor('evm') }, ENV.vaultOrigin, vault);
    await vi.waitFor(() => expect(page.state).toBe('error'));
    expect(page.errorCode).toBe('config_mismatch');
  });

  it('answers auth-hello only from the child it opened, on authOrigin', async () => {
    const r = run();
    await vi.waitFor(() => expect(r.page.state).toBe('ready'));
    click(button(/Sign in with Google/u));
    await vi.waitFor(() => expect(r.page.awaitingChild).toBe(true));
    r.win.message({ v: 1, t: 'hana:auth-hello' }, ENV.authOrigin, remoteWindow());
    r.win.message({ v: 1, t: 'hana:auth-hello' }, ENV.vaultOrigin, r.child);
    r.win.message({ v: 1, t: 'hana:auth-hello' }, EVIL, r.child);
    await flush();
    expect(r.child.postMessage).not.toHaveBeenCalled();
    r.win.message({ v: 1, t: 'hana:auth-hello' }, ENV.authOrigin, r.child);
    r.win.message({ v: 1, t: 'hana:auth-hello' }, ENV.authOrigin, r.child);
    expect(r.child.postMessage).toHaveBeenCalledTimes(1);
  });

  it('gives each child login popup a random name, and offers a retry when the popup is blocked', async () => {
    const names = new Set<string>();
    for (let i = 0; i < 3; i++) {
      resetDom();
      const r = run();
      r.win.openResult = null;
      await vi.waitFor(() => expect(r.page.state).toBe('ready'));
      click(button(/Sign in with Google/u));
      await vi.waitFor(() => expect(r.win.opened).toHaveLength(1));
      expect(pageText()).toContain('blocked');
      r.win.openResult = r.child;
      click(button(/Try again/u));
      await vi.waitFor(() => expect(r.win.opened).toHaveLength(2));
      for (const o of r.win.opened) names.add(o.target);
    }
    expect(names.size).toBe(6);
    for (const n of names) expect(n).toMatch(/^hana-login-[0-9a-f]{32}$/u);
  });

  describe('D385: a browser that can’t make the export’s session key says so', () => {
    afterEach(() => vi.restoreAllMocks());
    it.each([
      ['NotSupportedError', 1, 'Update it, or use another browser.'],
      ['OperationError', 4, 'couldn’t create the key the sign-in needs. Try again.'],
    ] as const)('%s: derive_failed with its own text (asked %i time(s)), no sign-in params', async (name, calls, text) => {
      const spy = vi.spyOn(crypto.subtle, 'generateKey').mockImplementation((() => Promise.reject(new DOMException('a platform message', name))) as typeof crypto.subtle.generateKey);
      const r = run();
      await vi.waitFor(() => expect(r.page.state).toBe('ready'));
      click(button(/Sign in with Google/u));
      await vi.waitFor(() => expect(r.page.state).toBe('error'));
      expect(r.page.errorCode).toBe('derive_failed');
      expect(pageText()).toContain(text);
      expect(pageText()).not.toContain('platform message');
      expect(spy).toHaveBeenCalledTimes(calls);
      r.win.message({ v: 1, t: 'hana:auth-hello' }, ENV.authOrigin, r.child);
      expect(r.child.postMessage).not.toHaveBeenCalled();
    });
  });

  it('opens the child popup synchronously in the click, before any await', async () => {
    const r = run();
    await vi.waitFor(() => expect(r.page.state).toBe('ready'));
    click(button(/Sign in with Google/u));
    expect(r.win.opened).toHaveLength(1);
  });

  it('offers a new attempt when the child popup is closed before it connects', async () => {
    const r = run();
    await vi.waitFor(() => expect(r.page.state).toBe('ready'));
    click(button(/Sign in with Google/u));
    await vi.waitFor(() => expect(r.page.awaitingChild).toBe(true));
    r.child.closed = true;
    await vi.waitFor(() => expect(r.page.state).toBe('ready'), { timeout: 3000 });
    expect(pageText()).toContain('closed before it finished');
    // A late hello from the closed child is not answered.
    r.win.message({ v: 1, t: 'hana:auth-hello' }, ENV.authOrigin, r.child);
    expect(r.child.postMessage).not.toHaveBeenCalled();
    const fresh = remoteWindow();
    r.win.openResult = fresh;
    click(button(/Try again/u));
    expect(r.win.opened).toHaveLength(2);
    expect(r.win.opened[1]?.target).not.toBe(r.win.opened[0]?.target);
  });

  describe('the key is erased 5 min after it is derived, or when the session ends (AUTH-1, D111)', () => {
    beforeEach(() => {
      // Fake timers and clock that also follow real time, so the login's crypto and awaits run as usual.
      vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    async function toConfirm(o: Parameters<typeof run>[0] = {}): Promise<Run> {
      const r = run(o);
      await signIn(r);
      await r.deliver();
      expect(await r.page.settled).toBe('confirm');
      return r;
    }
    const ended = (r: Run, reason: string) => {
      expect(r.page.state).toBe('ended');
      expect(r.page.endReason).toBe(reason);
      expect(pageText()).toContain('Export ended');
      expect(document.querySelector('.secret')).toBeNull();
      expect(button(/Show key|Hide key|Copy key|Copied|Continue|Try again|Sign in/u)).toBeNull();
    };

    it('still reveals just before 5 min; at 5 min the key and the screen are erased, with no way back', async () => {
      const r = await toConfirm();
      const { toggle, secret } = continueToReveal();
      vi.advanceTimersByTime(EXPORT_KEY_LIFETIME_MS - 2_000);
      click(toggle);
      expect(secret.textContent).toMatch(/^S[A-Z2-7]{55}$/u);
      vi.advanceTimersByTime(2_000);
      ended(r, 'expired');
      expect(pageText()).toContain(EXPORT_END_TEXT.expired);
      // The old button can't bring it back.
      click(toggle);
      expect(secret.textContent).toBe('••••••••');
      expect(pageText()).not.toMatch(/S[A-Z2-7]{55}/u);
    });

    it('ends in the confirm step too', async () => {
      const r = await toConfirm();
      vi.advanceTimersByTime(EXPORT_KEY_LIFETIME_MS);
      ended(r, 'expired');
    });

    it('a device clock set back doesn’t extend the deadline', async () => {
      const r = await toConfirm();
      vi.setSystemTime(Date.now() - 60 * 60_000);
      vi.advanceTimersByTime(EXPORT_KEY_LIFETIME_MS);
      ended(r, 'expired');
    });

    it('hana:export-end from the vault erases it at once; the same message from anyone else is ignored', async () => {
      const r = await toConfirm();
      const { toggle, secret } = continueToReveal();
      const evil = remoteWindow();
      r.win.message({ v: 1, t: 'hana:export-end' }, EVIL, r.vault);
      r.win.message({ v: 1, t: 'hana:export-end' }, ENV.vaultOrigin, evil);
      r.win.message({ v: 1, t: 'hana:export-end', extra: 1 }, ENV.vaultOrigin, r.vault);
      expect(r.page.state).toBe('reveal');
      r.win.message({ v: 1, t: 'hana:export-end' }, ENV.vaultOrigin, r.vault);
      ended(r, 'session_ended');
      click(toggle);
      expect(secret.textContent).toBe('••••••••');
    });

    it('hana:export-end before the sign-in finishes ends the export; a late login shows no key', async () => {
      const r = run();
      await signIn(r);
      r.win.message({ v: 1, t: 'hana:export-end' }, ENV.vaultOrigin, r.vault);
      ended(r, 'session_ended');
      expect(r.child.closed).toBe(true);
      await r.deliver();
      await vi.advanceTimersByTimeAsync(50);
      expect(r.page.state).toBe('ended');
      expect(r.api.login).not.toHaveBeenCalled();
    });

    it('never outlives the session: a session ending in 2 min ends the export at 2 min', async () => {
      const expiresAtMs = Date.now() + 2 * 60_000;
      const r = await toConfirm({ sessionExpiresAtMs: expiresAtMs });
      // The fake clock follows real time (shouldAdvanceTime) through the sign-in's real crypto: to a second before the end.
      vi.advanceTimersByTime(expiresAtMs - Date.now() - 1_000);
      expect(r.page.state).toBe('confirm');
      vi.advanceTimersByTime(1_000);
      ended(r, 'session_ended');
    });

    it('a session that already ended gets no sign-in', async () => {
      const r = run({ sessionExpiresAtMs: Date.now() - 1 });
      await vi.waitFor(() => expect(r.page.state).toBe('ended'));
      ended(r, 'session_ended');
    });

    it('the vault frame going away ends it within a second', async () => {
      const r = await toConfirm();
      r.vault.closed = true;
      vi.advanceTimersByTime(EXPORT_CHECK_MS);
      ended(r, 'vault_gone');
    });
  });

  describe('Show key, Copy key and the clipboard (D268)', () => {
    const STELLAR_KEY = /^S[A-Z2-7]{55}$/u;
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    });
    afterEach(() => {
      vi.useRealTimers();
      delete (document as unknown as Record<string, unknown>).visibilityState;
    });

    async function toReveal(o: Parameters<typeof run>[0] = {}): Promise<{ r: Run } & ReturnType<typeof revealControls>> {
      const r = run(o);
      await signIn(r);
      await r.deliver();
      expect(await r.page.settled).toBe('confirm');
      return { r, ...continueToReveal() };
    }
    const setVisibility = (v: 'hidden' | 'visible') => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });
      document.dispatchEvent(new Event('visibilitychange'));
    };

    it('says the copy is the user’s to look after, and keeps the erase sentence', async () => {
      await toReveal();
      expect(pageText()).toContain('A copied key stays in your clipboard until you copy something else');
      expect(pageText()).toContain('the copy is yours to look after');
      expect(pageText()).toContain('A shown key hides again after 60 seconds. Close this window when you are done: the key is erased when it closes, 5 minutes after you signed in, or when your session in the app ends.');
    });

    it('window blur, a hidden tab and pagehide hide a shown key; the tab coming back doesn’t show it again', async () => {
      const { r, toggle, secret } = await toReveal();
      click(toggle);
      expect(secret.textContent).toMatch(STELLAR_KEY);
      r.win.dispatch('blur');
      expect(secret.textContent).toBe('••••••••');
      expect(secret.hasAttribute('data-shown')).toBe(false);
      expect(toggle.textContent).toBe('Show key');
      // Showing it again needs the window back in focus, then the guard re-armed (D430).
      click(toggle);
      expect(secret.textContent).toBe('••••••••');
      r.win.dispatch('focus');

      click(toggle);
      expect(secret.textContent).toMatch(STELLAR_KEY);
      setVisibility('hidden');
      expect(secret.textContent).toBe('••••••••');
      setVisibility('visible');
      expect(secret.textContent).toBe('••••••••');
      expect(r.page.state).toBe('reveal');
      r.win.dispatch('focus');

      // One click shows it again (the toggle went back to "Show key").
      click(toggle);
      expect(secret.textContent).toMatch(STELLAR_KEY);
      r.win.dispatch('pagehide');
      expect(secret.textContent).toBe('••••••••');
      expect(r.page.state).toBe('closed');
    });

    it('hides a shown key again 60 s after Show (D430); Show shows it again, until the 5 min erase', async () => {
      expect(EXPORT_SHOW_MS).toBe(60_000);
      const { r, toggle, secret } = await toReveal();
      click(toggle);
      expect(secret.textContent).toMatch(STELLAR_KEY);
      vi.advanceTimersByTime(EXPORT_SHOW_MS - 1);
      expect(secret.textContent).toMatch(STELLAR_KEY);
      vi.advanceTimersByTime(1);
      expect(secret.textContent).toBe('••••••••');
      expect(secret.hasAttribute('data-shown')).toBe(false);
      expect(toggle.textContent).toBe('Show key');
      expect(r.page.state).toBe('reveal');
      // Hide and show again restarts the 60 s.
      click(toggle);
      vi.advanceTimersByTime(30_000);
      click(toggle);
      click(toggle);
      vi.advanceTimersByTime(EXPORT_SHOW_MS - 1);
      expect(secret.textContent).toMatch(STELLAR_KEY);
      vi.advanceTimersByTime(1);
      expect(secret.textContent).toBe('••••••••');
    });

    it('Continue, Show key and Copy key act only once the guard is armed: a click with no pointer movement first does nothing (D430)', async () => {
      const r = run();
      await signIn(r);
      await r.deliver();
      expect(await r.page.settled).toBe('confirm');
      const input = document.querySelector('input') as HTMLInputElement;
      input.value = EXPORT_CONFIRMATION;
      input.dispatchEvent(new Event('input'));
      const cont = button(/Continue/u) as HTMLButtonElement;
      expect(cont.disabled).toBe(true);
      stillClick(cont);
      expect(r.page.state).toBe('confirm');
      // A keyboard user: Tab arms it (Enter never does), and Enter on Continue then acts after its focus dwell.
      r.win.dispatch('keydown', { key: 'Enter', repeat: false });
      expect(cont.disabled).toBe(true);
      r.win.dispatch('keydown', { key: 'Tab', repeat: false });
      expect(cont.disabled).toBe(false);
      click(cont);
      expect(r.page.state).toBe('reveal');
      const { toggle, copy, secret } = revealControls();
      // The reveal screen starts over: the click that confirmed (or a second one) can't land on Show or Copy.
      expect(toggle.disabled).toBe(true);
      expect(copy.disabled).toBe(true);
      stillClick(toggle);
      stillClick(copy);
      expect(secret.textContent).toBe('••••••••');
      expect(r.clipboardWrites).toEqual([]);
      click(toggle);
      expect(secret.textContent).toMatch(STELLAR_KEY);
    });

    it('synthetic (non-gesture) clicks neither show the key nor copy it', async () => {
      const { r, toggle, copy, secret } = await toReveal();
      r.setGesture(false);
      click(toggle);
      expect(secret.textContent).toBe('••••••••');
      click(copy);
      await flush();
      expect(r.clipboardWrites).toEqual([]);
      // A shown key can't be hidden or copied by a script's click either: the user's own click still works.
      r.setGesture(true);
      click(toggle);
      r.setGesture(false);
      click(toggle);
      expect(secret.textContent).toMatch(STELLAR_KEY);
      click(copy);
      await flush();
      expect(r.clipboardWrites).toEqual([]);
    });

    it('Copy key writes the export string whether or not it is shown, never puts it on the page, and says Copied for 2 s', async () => {
      const address = addressFor('stellar');
      const readText = vi.fn();
      const writes: string[] = [];
      const clipboard = { writeText: vi.fn(async (t: string) => void writes.push(t)), readText };
      const { copy, secret, status, toggle } = await toReveal({ address, clipboard });
      click(copy);
      expect(clipboard.writeText).toHaveBeenCalledTimes(1); // inside the click, before any await
      await flush();
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatch(STELLAR_KEY);
      expect(addressOfExport('stellar', writes[0] as string)).toBe(address);
      // Hidden: the key went to the clipboard only, not into the page.
      expect(secret.textContent).toBe('••••••••');
      expect(pageText()).not.toContain(writes[0]);
      expect(copy.textContent).toBe('Copied');
      expect(status.textContent).toBe('');
      vi.advanceTimersByTime(1_999);
      expect(copy.textContent).toBe('Copied');
      vi.advanceTimersByTime(1);
      expect(copy.textContent).toBe('Copy key');

      // Shown: the same string.
      click(toggle);
      click(copy);
      await flush();
      expect(writes[1]).toBe(writes[0]);
      expect(secret.textContent).toBe(writes[0]);
      // It never reads the clipboard (that would need a permission prompt).
      expect(readText).not.toHaveBeenCalled();
    });

    it('copies a NEAR key as ed25519: + base58(seed ‖ public key), the form near-cli imports (D724)', async () => {
      const address = addressFor('near');
      const { r, copy } = await toReveal({ chain: 'near', address });
      expect(pageText()).toContain('Your NEAR key');
      click(copy);
      await flush();
      expect(r.clipboardWrites[0]).toMatch(/^ed25519:[1-9A-HJ-NP-Za-km-z]{80,90}$/u);
      expect(addressOfExport('near', r.clipboardWrites[0] as string)).toBe(address);
      // The API takes exportChain 'stellar' or 'evm' only today: a NEAR export sends none (its event has no chain).
      expect(Object.keys(r.loginBodies[0] as object)).not.toContain('exportChain');
    });

    it('copies an EVM key as 0x + 64 lowercase hex', async () => {
      const address = addressFor('evm');
      const { r, copy } = await toReveal({ chain: 'evm', address });
      click(copy);
      await flush();
      expect(r.clipboardWrites[0]).toMatch(/^0x[0-9a-f]{64}$/u);
      expect(addressOfExport('evm', r.clipboardWrites[0] as string)).toBe(address);
    });

    it('says how to copy by hand when the Clipboard API is missing, refuses or throws; no execCommand fallback', async () => {
      const execCommand = vi.fn(() => true);
      (document as unknown as { execCommand: unknown }).execCommand = execCommand;
      const cases: (null | { writeText(t: string): Promise<void> })[] = [
        null,
        { writeText: async () => Promise.reject(new DOMException('denied', 'NotAllowedError')) },
        {
          writeText: () => {
            throw new TypeError('no');
          },
        },
      ];
      for (const clipboard of cases) {
        resetDom();
        const { r, copy, status, toggle, secret } = await toReveal({ clipboard });
        click(copy);
        await flush();
        expect(status.textContent).toBe(EXPORT_COPY_UNAVAILABLE);
        expect(copy.textContent).toBe('Copy key');
        // Copy by hand still works: the key can be shown and selected.
        click(toggle);
        expect(secret.textContent).toMatch(STELLAR_KEY);
        expect(secret.hasAttribute('data-shown')).toBe(true);
        expect(status.textContent).not.toContain(secret.textContent as string);
        // Nothing was copied, so there is nothing to blank.
        vi.advanceTimersByTime(EXPORT_CLIPBOARD_CLEAR_MS);
        r.win.dispatch('pagehide');
      }
      expect(execCommand).not.toHaveBeenCalled();
      delete (document as unknown as Record<string, unknown>).execCommand;
    });

    it('a copy that succeeds after a failure clears the message', async () => {
      let refuse = true;
      const writes: string[] = [];
      const { copy, status } = await toReveal({ clipboard: { writeText: async (t) => (refuse ? Promise.reject(new Error('no')) : void writes.push(t)) } });
      click(copy);
      await flush();
      expect(status.textContent).toBe(EXPORT_COPY_UNAVAILABLE);
      refuse = false;
      click(copy);
      await flush();
      expect(status.textContent).toBe('');
      expect(copy.textContent).toBe('Copied');
      expect(writes).toHaveLength(1);
    });

    it('blanks the clipboard 60 s after the last copy while the window has focus', async () => {
      const { r, copy } = await toReveal();
      click(copy);
      await flush();
      vi.advanceTimersByTime(30_000);
      // A second copy restarts the 60 s.
      click(copy);
      await flush();
      vi.advanceTimersByTime(EXPORT_CLIPBOARD_CLEAR_MS - 1);
      expect(r.clipboardWrites.filter((w) => w === '')).toHaveLength(0);
      vi.advanceTimersByTime(1);
      await flush();
      expect(r.clipboardWrites.at(-1)).toBe('');
      expect(r.clipboardWrites).toHaveLength(3);
      // Blanked once: the erase doesn't write over the clipboard again.
      r.win.message({ v: 1, t: 'hana:export-end' }, ENV.vaultOrigin, r.vault);
      await flush();
      expect(r.clipboardWrites).toHaveLength(3);
    });

    it('without focus at 60 s it doesn’t try (the browser would refuse); the erase blanks it if the window has focus then', async () => {
      const { r, copy } = await toReveal();
      click(copy);
      await flush();
      r.setFocus(false);
      vi.advanceTimersByTime(EXPORT_CLIPBOARD_CLEAR_MS);
      await flush();
      expect(r.clipboardWrites).toHaveLength(1);
      // Not on the next focus either: by then the clipboard may hold something else the user copied.
      r.setFocus(true);
      r.win.dispatch('focus');
      await flush();
      expect(r.clipboardWrites).toHaveLength(1);
      vi.advanceTimersByTime(EXPORT_KEY_LIFETIME_MS);
      await flush();
      expect(r.page.endReason).toBe('expired');
      expect(r.clipboardWrites).toEqual([expect.stringMatching(STELLAR_KEY), '']);
    });

    it('the erase (session end) blanks the clipboard at once, and the old buttons show and copy nothing after it', async () => {
      const { r, copy, toggle, secret } = await toReveal();
      click(copy);
      await flush();
      r.win.message({ v: 1, t: 'hana:export-end' }, ENV.vaultOrigin, r.vault);
      await flush();
      expect(r.page.state).toBe('ended');
      expect(r.clipboardWrites).toEqual([expect.stringMatching(STELLAR_KEY), '']);
      click(toggle);
      click(copy);
      await flush();
      expect(secret.textContent).toBe('••••••••');
      expect(r.clipboardWrites).toHaveLength(2);
      // The 60 s timer was cancelled with the erase.
      vi.advanceTimersByTime(EXPORT_CLIPBOARD_CLEAR_MS);
      await flush();
      expect(r.clipboardWrites).toHaveLength(2);
    });

    it('the erase without focus leaves the clipboard alone; an erase with nothing copied writes nothing', async () => {
      const first = await toReveal();
      click(first.copy);
      await flush();
      first.r.setFocus(false);
      first.r.win.message({ v: 1, t: 'hana:export-end' }, ENV.vaultOrigin, first.r.vault);
      await flush();
      expect(first.r.clipboardWrites).toHaveLength(1);

      resetDom();
      const second = await toReveal();
      second.r.win.message({ v: 1, t: 'hana:export-end' }, ENV.vaultOrigin, second.r.vault);
      await flush();
      expect(second.r.page.state).toBe('ended');
      expect(second.r.clipboardWrites).toEqual([]);
    });

    it('pagehide blanks the clipboard (while focused) and zeroes the key', async () => {
      const { r, copy } = await toReveal();
      click(copy);
      await flush();
      r.win.dispatch('pagehide');
      await flush();
      expect(r.clipboardWrites).toEqual([expect.stringMatching(STELLAR_KEY), '']);
      expect(r.page.state).toBe('closed');
      click(copy);
      await flush();
      expect(r.clipboardWrites).toHaveLength(2);
    });

    it('a copy that lands after the erase is blanked straight away', async () => {
      let land: () => void = () => {};
      const writes: string[] = [];
      const { r, copy } = await toReveal({
        clipboard: {
          writeText: (t) =>
            t === ''
              ? (writes.push(t), Promise.resolve())
              : new Promise<void>((res) => {
                  land = () => {
                    writes.push(t);
                    res();
                  };
                }),
        },
      });
      click(copy);
      r.win.message({ v: 1, t: 'hana:export-end' }, ENV.vaultOrigin, r.vault);
      expect(writes).toEqual([]);
      land();
      await flush();
      expect(writes).toEqual([expect.stringMatching(STELLAR_KEY), '']);
      expect(pageText()).not.toMatch(/S[A-Z2-7]{55}/u);
      expect(pageText()).not.toContain('Copied');
    });
  });

  it('the revealed key is not in a live region and is marked translate="no" (AUTH-6, AUTH-4)', async () => {
    const r = run();
    await signIn(r);
    await r.deliver();
    expect(await r.page.settled).toBe('confirm');
    const input = document.querySelector('input') as HTMLInputElement;
    input.value = EXPORT_CONFIRMATION;
    input.dispatchEvent(new Event('input'));
    click(button(/Continue/u));
    const secret = document.querySelector('.secret') as HTMLElement;
    expect(secret.hasAttribute('aria-live')).toBe(false);
    expect(secret.closest('[aria-live]')).toBeNull();
    // The copy status is a live region of its own, beside the key, never around it.
    expect(secret.closest('[role="status"], [role="alert"], [role="log"]')).toBeNull();
    expect(secret.getAttribute('translate')).toBe('no');
  });

  it('a relay that answers 410 ends the export', async () => {
    const r = run();
    r.api.readRelay.mockImplementation(async () => {
      throw new ApiError(410, 'relay_gone', 'gone', null, null);
    });
    await signIn(r);
    expect(await r.page.settled).toBe('error');
    expect(r.page.errorCode).toBe('token_invalid');
  });
});
