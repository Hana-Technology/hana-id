// @vitest-environment happy-dom
// /export (docs/batch-b-spec.md "Key export", "Tests → Web unit → Export"): refused when framed, without a gesture,
// with a vault reply from the wrong source, with a stale auth_time or on an address mismatch; the child login popup's
// name is random; a fresh login of its own (its own session key, nonce, relay and path); typed confirmation and
// hold-to-reveal; no message in either direction carries key material.
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
  parseWindowMessage,
  sessionNonce,
} from '@hana-id/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthApi } from '../../src/auth/api.ts';
import { EXPORT_CHECK_MS, EXPORT_CONFIRMATION, EXPORT_END_TEXT, EXPORT_KEY_LIFETIME_MS, startExportPage } from '../../src/auth/export-page.ts';
import type { NearReader } from '../../src/auth/near-rpc.ts';
import { simulateMpc } from '../../../core/test/helpers.ts';
import { CLIENT_ID, ENV, EVIL, FakeWindow, NET, PARTNER, PK, type RemoteWindow, type TokenSigner, asWindow, emailIssuerSigner, flush, pageText, remoteWindow, resetDom, tokenSigner } from './helpers.ts';

const SCOPE = 's1';
const SUB = '110248495921238986420';
const PATH = `${SCOPE}#google#${SUB}#0`;

/** The address the fixed MPC network gives PATH (S doesn't depend on the ephemeral app key). */
function addressFor(chain: 'stellar' | 'evm', path = PATH): string {
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
}

function run(
  o: {
    chain?: 'stellar' | 'evm';
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
  const page = startExportPage({ win, env: o.env ?? ENV, api, near, jwks: async (kid) => (kid === signer.jwk.kid ? signer.jwk : null), sleep: async () => {}, isGesture: () => o.gesture ?? true });
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
  };
  win.message(context, ENV.vaultOrigin, vault);
  return {
    win,
    vault,
    child,
    api: api as never,
    page,
    loginBodies,
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
const click = (b: Element | null) => b?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

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

describe('/export', () => {
  it('says hello to the vault and checks its context against GET /v1/app', async () => {
    const r = run();
    expect(r.vault.postMessage).toHaveBeenCalledWith({ v: 1, t: 'hana:export-hello' }, ENV.vaultOrigin);
    await vi.waitFor(() => expect(r.page.state).toBe('ready'));
    expect(r.api.getApp).toHaveBeenCalledWith(PK, PARTNER);
    expect(pageText()).toContain('Export your Stellar key');
    expect(pageText()).toContain('Partner App');
  });

  it('exports the key after a fresh login of its own, a typed confirmation and only while the button is held', async () => {
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
    expect(cont.disabled).toBe(false);
    click(cont);
    expect(r.page.state).toBe('reveal');

    // Hold to reveal.
    const hold = button(/Hold to show/u) as HTMLButtonElement;
    const secret = document.querySelector('.secret') as HTMLElement;
    expect(secret.textContent).toBe('••••••••');
    hold.dispatchEvent(new Event('pointerdown'));
    const shown = secret.textContent as string;
    expect(shown).toMatch(/^S[A-Z2-7]{55}$/u);
    expect(addressOfExport('stellar', shown)).toBe(address);
    hold.dispatchEvent(new Event('pointerup'));
    expect(secret.textContent).toBe('••••••••');
    hold.dispatchEvent(new Event('pointerdown'));
    hold.dispatchEvent(new Event('pointerleave'));
    expect(secret.textContent).toBe('••••••••');

    // No message to the vault or the child carries the key, and only auth-params carries a secret (relayKey).
    const all = JSON.stringify([...r.vault.received, ...r.child.received], (_, v) => (v instanceof Uint8Array ? Array.from(v) : v));
    expect(all).not.toContain(shown);
    expect(r.vault.received).toEqual([{ v: 1, t: 'hana:export-hello' }]);
    expect(r.child.received).toHaveLength(1);

    // Closing the window zeroes the key: holding the button shows nothing any more.
    r.win.dispatch('pagehide');
    hold.dispatchEvent(new Event('pointerdown'));
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
    (button(/Hold to show/u) as HTMLButtonElement).dispatchEvent(new Event('pointerdown'));
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
    function toReveal(): { hold: HTMLButtonElement; secret: HTMLElement } {
      const input = document.querySelector('input') as HTMLInputElement;
      input.value = EXPORT_CONFIRMATION;
      input.dispatchEvent(new Event('input'));
      click(button(/Continue/u));
      return { hold: button(/Hold to show/u) as HTMLButtonElement, secret: document.querySelector('.secret') as HTMLElement };
    }
    const ended = (r: Run, reason: string) => {
      expect(r.page.state).toBe('ended');
      expect(r.page.endReason).toBe(reason);
      expect(pageText()).toContain('Export ended');
      expect(document.querySelector('.secret')).toBeNull();
      expect(button(/Hold to show|Continue|Try again|Sign in/u)).toBeNull();
    };

    it('still reveals just before 5 min; at 5 min the key and the screen are erased, with no way back', async () => {
      const r = await toConfirm();
      const { hold, secret } = toReveal();
      vi.advanceTimersByTime(EXPORT_KEY_LIFETIME_MS - 2_000);
      hold.dispatchEvent(new Event('pointerdown'));
      expect(secret.textContent).toMatch(/^S[A-Z2-7]{55}$/u);
      vi.advanceTimersByTime(2_000);
      ended(r, 'expired');
      expect(pageText()).toContain(EXPORT_END_TEXT.expired);
      // The old button can't bring it back.
      hold.dispatchEvent(new Event('pointerdown'));
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
      const { hold, secret } = toReveal();
      const evil = remoteWindow();
      r.win.message({ v: 1, t: 'hana:export-end' }, EVIL, r.vault);
      r.win.message({ v: 1, t: 'hana:export-end' }, ENV.vaultOrigin, evil);
      r.win.message({ v: 1, t: 'hana:export-end', extra: 1 }, ENV.vaultOrigin, r.vault);
      expect(r.page.state).toBe('reveal');
      r.win.message({ v: 1, t: 'hana:export-end' }, ENV.vaultOrigin, r.vault);
      ended(r, 'session_ended');
      hold.dispatchEvent(new Event('pointerdown'));
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
      const r = await toConfirm({ sessionExpiresAtMs: Date.now() + 2 * 60_000 });
      vi.advanceTimersByTime(2 * 60_000 - 1_000);
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
