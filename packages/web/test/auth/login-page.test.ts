// @vitest-environment happy-dom
// /login (docs/batch-b-spec.md "Login" steps 3–5, "Tests → Web unit → Login popup"): the sender checks in each opener
// mode, the signer/scope/client/nonce cross-checks, the COOP error, the sessionStorage entry and the Google request.
import { ApiError, type AppConfig, relayIdFor, sessionNonce } from '@hana-id/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthApi } from '../../src/auth/api.ts';
import { HELLO_TIMEOUT_MS, openerMode, startLoginPage } from '../../src/auth/login-page.ts';
import { LOGIN_ENTRY_PREFIX } from '../../src/auth/login-storage.ts';
import { CLIENT_ID, ENV, EVIL, FakeWindow, PARTNER, PK, type RemoteWindow, asWindow, crossOriginWindow, flush, pageText, remoteWindow, resetDom } from './helpers.ts';

const VAULT_FRAME = `hana-vault-${'ab'.repeat(16)}`;
const SCOPE = 's1';

function authParams(over: Record<string, unknown> = {}) {
  const sessionPublicKey = crypto.getRandomValues(new Uint8Array(32));
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const base = { signer: ENV.signer, scopeId: SCOPE, sessionPublicKey, expiresAtMs: 1_900_000_000_000, keyIndex: 0, maxUses: 1, salt };
  return {
    v: 1,
    t: 'hana:auth-params',
    pk: PK,
    appName: 'Vault-side name',
    parentOrigin: PARTNER,
    scopeId: SCOPE,
    signer: ENV.signer,
    clientId: CLIENT_ID,
    mode: 'shared',
    sessionPublicKey,
    expiresAtMs: base.expiresAtMs,
    salt,
    keyIndex: 0,
    maxUses: 1,
    nonce: sessionNonce(base),
    relayId: relayIdFor(crypto.getRandomValues(new Uint8Array(32))),
    relayKey: crypto.getRandomValues(new Uint8Array(32)),
    ...over,
  };
}

const appConfig = (over: Partial<AppConfig> = {}): AppConfig => ({
  scopeId: SCOPE,
  signer: ENV.signer,
  google: { clientId: CLIENT_ID, mode: 'shared' },
  name: 'Partner App',
  serverTimeMs: 1_800_000_000_000,
  requestId: 'r',
  ...over,
});

function fakeApi(config: AppConfig | Error = appConfig()): AuthApi & { getApp: ReturnType<typeof vi.fn> } {
  return {
    getApp: vi.fn(async () => {
      if (config instanceof Error) throw config;
      return config;
    }),
    writeRelay: vi.fn(),
    readRelay: vi.fn(),
    login: vi.fn(),
  } as never;
}

interface Setup {
  win: FakeWindow;
  opener: RemoteWindow;
  vault: RemoteWindow;
  api: ReturnType<typeof fakeApi>;
}

function setup(mode: 'partner' | 'vault' | 'export', api = fakeApi()): Setup & { page: ReturnType<typeof startLoginPage> } {
  const search = mode === 'partner' ? `?v=${VAULT_FRAME}` : mode === 'vault' ? '?from=vault' : '?mode=export';
  const win = new FakeWindow('/login', search);
  const opener = remoteWindow({ location: { pathname: mode === 'export' ? '/export' : '/' } });
  const vault = remoteWindow({ parent: opener });
  opener.frames[VAULT_FRAME] = vault;
  win.opener = asWindow(opener);
  const page = startLoginPage({ win, env: ENV, api, now: () => 1_800_000_000_000 });
  return { win, opener, vault, api, page };
}

/** The window that sends auth-params in each mode, and its origin. */
const preparer = (s: Setup, mode: 'partner' | 'vault' | 'export') =>
  mode === 'partner' ? { source: s.vault, origin: ENV.vaultOrigin } : mode === 'vault' ? { source: s.opener, origin: ENV.vaultOrigin } : { source: s.opener, origin: ENV.authOrigin };

beforeEach(() => {
  resetDom();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('opener modes', () => {
  it('reads exactly one of the three link forms', () => {
    expect(openerMode(`?v=${VAULT_FRAME}`)).toEqual({ mode: 'partner', vaultFrame: VAULT_FRAME });
    expect(openerMode('?from=vault')).toEqual({ mode: 'vault' });
    expect(openerMode('?mode=export')).toEqual({ mode: 'export' });
    for (const bad of ['', '?v=hana-vault-xyz', '?v=other', `?v=${VAULT_FRAME}&from=vault`, '?from=partner', '?mode=login', `?v=${VAULT_FRAME}&v=${VAULT_FRAME}`]) expect(openerMode(bad)).toBeNull();
  });
});

describe('/login', () => {
  it.each(['partner', 'vault', 'export'] as const)('%s mode: posts auth-hello to the preparer every 100 ms, with its origin as targetOrigin', (mode) => {
    const s = setup(mode);
    const target = mode === 'partner' ? s.vault : s.opener;
    const origin = mode === 'export' ? ENV.authOrigin : ENV.vaultOrigin;
    expect(target.postMessage).toHaveBeenCalledWith({ v: 1, t: 'hana:auth-hello' }, origin);
    vi.advanceTimersByTime(350);
    expect(target.postMessage).toHaveBeenCalledTimes(4);
    if (mode === 'partner') expect(s.opener.postMessage).not.toHaveBeenCalled();
  });

  it('partner mode: checks the vault against GET /v1/app, stores the relayKey under the state and goes to Google', async () => {
    const s = setup('partner');
    const params = authParams();
    const relayKey = Uint8Array.from(params.relayKey);
    s.win.message(params, ENV.vaultOrigin, s.vault);
    const state = await s.page.done;
    expect(state.stage).toBe('redirecting');
    expect(s.api.getApp).toHaveBeenCalledWith(PK, PARTNER);

    const url = new URL(s.win.location.assigned[0] as string);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT_ID,
      redirect_uri: `${ENV.authOrigin}/login/callback`,
      response_type: 'id_token',
      response_mode: 'fragment',
      scope: 'openid',
      nonce: params.nonce,
      state: params.relayId,
      prompt: 'select_account',
    });
    const entry = JSON.parse(s.win.sessionStorage.getItem(LOGIN_ENTRY_PREFIX + params.relayId) as string) as Record<string, unknown>;
    expect(entry).toMatchObject({ v: 1, createdAt: 1_800_000_000_000 });
    expect(entry.relayKey).toBe(Buffer.from(relayKey).toString('base64url'));
    // The in-memory copy from the message is zeroed; the name shown is the API's.
    expect(params.relayKey.every((b) => b === 0)).toBe(true);
    expect(pageText()).toContain('Signing in to Partner App at https://partner.example');
    // The hello loop stopped.
    const sent = s.vault.postMessage.mock.calls.length;
    vi.advanceTimersByTime(1000);
    expect(s.vault.postMessage.mock.calls.length).toBe(sent);
  });

  it('export mode adds max_age=0', async () => {
    const s = setup('export');
    s.win.message(authParams(), ENV.authOrigin, s.opener);
    await s.page.done;
    expect(new URL(s.win.location.assigned[0] as string).searchParams.get('max_age')).toBe('0');
  });

  describe.each(['partner', 'vault', 'export'] as const)('%s mode refuses a reply', (mode) => {
    it('from the wrong origin', async () => {
      const s = setup(mode);
      const { source, origin } = preparer(s, mode);
      for (const o of [EVIL, mode === 'export' ? ENV.vaultOrigin : ENV.authOrigin, PARTNER]) s.win.message(authParams(), o, source);
      await flush();
      expect(s.api.getApp).not.toHaveBeenCalled();
      expect(s.page.state.stage).toBe('connecting');
      // The real preparer is still accepted afterwards.
      s.win.message(authParams(), origin, source);
      expect((await s.page.done).stage).toBe('redirecting');
    });

    it('from the wrong source', async () => {
      const s = setup(mode);
      const { origin } = preparer(s, mode);
      const others: unknown[] = [remoteWindow(), null, s.win];
      if (mode === 'partner') others.push(s.opener, remoteWindow({ parent: remoteWindow() }));
      else others.push(s.vault);
      for (const src of others) s.win.message(authParams(), origin, src);
      await flush();
      expect(s.api.getApp).not.toHaveBeenCalled();
      expect(s.page.state.stage).toBe('connecting');
    });
  });

  it('partner mode refuses a frame named like the vault whose parent is not the opener', async () => {
    const s = setup('partner');
    const impostor = remoteWindow({ parent: remoteWindow() });
    s.opener.frames[VAULT_FRAME] = impostor;
    s.win.message(authParams(), ENV.vaultOrigin, impostor);
    await flush();
    expect(s.api.getApp).not.toHaveBeenCalled();
  });

  it('export mode refuses a non-/export opener, including a cross-origin one', async () => {
    const s = setup('export');
    s.opener.location.pathname = '/approve';
    s.win.message(authParams(), ENV.authOrigin, s.opener);
    await flush();
    expect(s.api.getApp).not.toHaveBeenCalled();

    const win = new FakeWindow('/login', '?mode=export');
    const cross = crossOriginWindow();
    win.opener = asWindow(cross);
    const api = fakeApi();
    startLoginPage({ win, env: ENV, api });
    win.message(authParams(), ENV.authOrigin, cross);
    await flush();
    expect(api.getApp).not.toHaveBeenCalled();
  });

  it('accepts only the first valid reply', async () => {
    const s = setup('vault');
    s.win.message(authParams(), ENV.vaultOrigin, s.opener);
    s.win.message(authParams(), ENV.vaultOrigin, s.opener);
    await s.page.done;
    expect(s.api.getApp).toHaveBeenCalledTimes(1);
    expect(s.win.location.assigned).toHaveLength(1);
  });

  it.each([
    ['the vault names another signer', authParams({ signer: 'evil-signer.testnet' }), appConfig()],
    ['the API names another signer', authParams(), appConfig({ signer: 'evil-signer.testnet' })],
    ['the API has another scope', authParams(), appConfig({ scopeId: 's2' })],
    ['the API has another client', authParams(), appConfig({ google: { clientId: 'other.apps.googleusercontent.com', mode: 'shared' } })],
    ['the nonce does not commit to the session', authParams({ nonce: 'x'.repeat(43) }), appConfig()],
    ['the nonce commits to another expiry', authParams({ expiresAtMs: 1_900_000_000_001 }), appConfig()],
  ])('refuses (config_mismatch) when %s, with no Google redirect and nothing stored', async (_, params, config) => {
    const s = setup('vault', fakeApi(config));
    s.win.message(params, ENV.vaultOrigin, s.opener);
    expect(await s.page.done).toEqual({ stage: 'error', code: 'config_mismatch' });
    expect(s.win.location.assigned).toEqual([]);
    expect(s.win.sessionStorage.length).toBe(0);
    expect((params.relayKey as Uint8Array).every((b) => b === 0)).toBe(true);
  });

  it('maps a GET /v1/app failure (409 no_google_client) to its code', async () => {
    const s = setup('vault', fakeApi(new ApiError(409, 'no_google_client', 'none', null, null)));
    s.win.message(authParams(), ENV.vaultOrigin, s.opener);
    expect(await s.page.done).toEqual({ stage: 'error', code: 'no_google_client' });
    expect(pageText()).toContain('no Google sign-in');
  });

  it('shows the COOP error when window.opener is null, and posts nothing', async () => {
    const win = new FakeWindow('/login', `?v=${VAULT_FRAME}`);
    const page = startLoginPage({ win, env: ENV, api: fakeApi() });
    expect(await page.done).toEqual({ stage: 'error', code: 'coop_blocks_popup' });
    expect(pageText()).toContain('This site’s settings block the Hana sign-in window (COOP)');
    expect(win.listenerCount('message')).toBe(0);
  });

  it('refuses a malformed link and a framed page', async () => {
    const bad = new FakeWindow('/login', '?v=nope');
    bad.opener = asWindow(remoteWindow());
    expect((await startLoginPage({ win: bad, env: ENV, api: fakeApi() }).done).stage).toBe('error');
    const framed = new FakeWindow('/login', '?from=vault');
    framed.opener = asWindow(remoteWindow());
    framed.top = {};
    expect((await startLoginPage({ win: framed, env: ENV, api: fakeApi() }).done).stage).toBe('error');
    expect(framed.listenerCount('message')).toBe(0);
  });

  it('gives up with login_timeout after 15 s without a valid reply', async () => {
    const s = setup('partner');
    vi.advanceTimersByTime(HELLO_TIMEOUT_MS);
    expect(await s.page.done).toEqual({ stage: 'error', code: 'login_timeout' });
    const sent = s.vault.postMessage.mock.calls.length;
    vi.advanceTimersByTime(1000);
    expect(s.vault.postMessage.mock.calls.length).toBe(sent);
  });

  it('deletes hana.login.* entries older than 10 min when it stores its own', async () => {
    const s = setup('vault');
    s.win.sessionStorage.setItem(`${LOGIN_ENTRY_PREFIX}${'o'.repeat(43)}`, JSON.stringify({ v: 1, createdAt: 1_800_000_000_000 - 11 * 60_000, relayKey: 'x' }));
    s.win.sessionStorage.setItem(`${LOGIN_ENTRY_PREFIX}${'f'.repeat(43)}`, JSON.stringify({ v: 1, createdAt: 1_800_000_000_000 - 60_000, relayKey: 'y' }));
    s.win.sessionStorage.setItem('other', '1');
    const params = authParams();
    s.win.message(params, ENV.vaultOrigin, s.opener);
    await s.page.done;
    expect(s.win.sessionStorage.getItem(`${LOGIN_ENTRY_PREFIX}${'o'.repeat(43)}`)).toBeNull();
    expect(s.win.sessionStorage.getItem(`${LOGIN_ENTRY_PREFIX}${'f'.repeat(43)}`)).not.toBeNull();
    expect(s.win.sessionStorage.getItem('other')).toBe('1');
    expect(s.win.sessionStorage.getItem(LOGIN_ENTRY_PREFIX + params.relayId)).not.toBeNull();
  });

  it('shows partner strings as text, never markup', async () => {
    const s = setup('vault', fakeApi(appConfig({ name: '<img src=x onerror=alert(1)>' })));
    s.win.message(authParams(), ENV.vaultOrigin, s.opener);
    await s.page.done;
    expect(document.querySelector('img')).toBeNull();
    expect(pageText()).toContain('<img src=x onerror=alert(1)>');
  });
});
