// @vitest-environment happy-dom
// /login (docs/batch-b-spec.md "Login" steps 3–5, "Tests → Web unit → Login popup"): the sender checks in each opener
// mode, the signer and nonce checks, no API call (D77), the COOP error, the sessionStorage entry and the Google request.
import { homeNonce, relayIdFor, sessionNonce } from '@hana-id/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HELLO_TIMEOUT_MS, openerMode, startLoginPage } from '../../src/auth/login-page.ts';
import { LOGIN_ENTRY_PREFIX } from '../../src/auth/login-storage.ts';
import { CLIENT_ID, ENV, EVIL, FakeWindow, PARTNER, PK, type RemoteWindow, asWindow, crossOriginWindow, flush, pageText, remoteWindow, resetDom, vaultAcks } from './helpers.ts';

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

interface Setup {
  win: FakeWindow;
  opener: RemoteWindow;
  vault: RemoteWindow;
  /** Every fetch the page makes (none: D77). */
  fetch: ReturnType<typeof vi.fn>;
}

function setup(mode: 'partner' | 'vault' | 'export'): Setup & { page: ReturnType<typeof startLoginPage> } {
  const search = mode === 'partner' ? `?v=${VAULT_FRAME}` : mode === 'vault' ? '?from=vault' : '?mode=export';
  const win = new FakeWindow('/login', search);
  const opener = remoteWindow({ location: { pathname: mode === 'export' ? '/export' : '/' } });
  const vault = remoteWindow({ parent: opener });
  opener.frames[VAULT_FRAME] = vault;
  win.opener = asWindow(opener);
  // The vault (the partner's vault frame, or the vault's own window) acks the popup's signals (D400).
  vaultAcks(mode === 'partner' ? vault : opener, win);
  const page = startLoginPage({ win, env: ENV, now: () => 1_800_000_000_000 });
  return { win, opener, vault, fetch: fetchSpy, page };
}

/** The window that sends auth-params in each mode, and its origin. */
const preparer = (s: Setup, mode: 'partner' | 'vault' | 'export') =>
  mode === 'partner' ? { source: s.vault, origin: ENV.vaultOrigin } : mode === 'vault' ? { source: s.opener, origin: ENV.vaultOrigin } : { source: s.opener, origin: ENV.authOrigin };

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  resetDom();
  vi.useFakeTimers();
  fetchSpy = vi.fn(async () => {
    throw new Error('The login popup must not fetch');
  });
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('opener modes', () => {
  it('reads exactly one of the three link forms', () => {
    expect(openerMode(`?v=${VAULT_FRAME}`)).toEqual({ mode: 'partner', vaultFrame: VAULT_FRAME });
    expect(openerMode('?from=vault')).toEqual({ mode: 'vault' });
    expect(openerMode('?mode=export')).toEqual({ mode: 'export' });
    expect(openerMode('?mode=home')).toEqual({ mode: 'home' });
    for (const bad of ['', '?v=hana-vault-xyz', '?v=other', `?v=${VAULT_FRAME}&from=vault`, '?from=partner', '?mode=login', '?mode=home&mode=export', '?mode=home&v=1', '?mode=Home', `?v=${VAULT_FRAME}&v=${VAULT_FRAME}`]) expect(openerMode(bad)).toBeNull();
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

  it('partner mode: checks the vault’s message without an API call, stores the relayKey under the state and goes to Google', async () => {
    const s = setup('partner');
    const params = authParams();
    const relayKey = Uint8Array.from(params.relayKey);
    s.win.message(params, ENV.vaultOrigin, s.vault);
    const state = await s.page.done;
    expect(state.stage).toBe('redirecting');
    // D77: the vault's authenticated message is the app's config; the page fetches nothing (and its CSP has no
    // connect-src).
    expect(s.fetch).not.toHaveBeenCalled();

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
    // The in-memory copy from the message is zeroed; the name and origin shown are the vault's.
    expect(params.relayKey.every((b) => b === 0)).toBe(true);
    expect(pageText()).toContain('Signing in to Vault-side name at https://partner.example');
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
      expect(s.win.sessionStorage.length).toBe(0);
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
      expect(s.win.sessionStorage.length).toBe(0);
      expect(s.page.state.stage).toBe('connecting');
    });
  });

  it('partner mode refuses a frame named like the vault whose parent is not the opener', async () => {
    const s = setup('partner');
    const impostor = remoteWindow({ parent: remoteWindow() });
    s.opener.frames[VAULT_FRAME] = impostor;
    s.win.message(authParams(), ENV.vaultOrigin, impostor);
    await flush();
    expect(s.page.state.stage).toBe('connecting');
    expect(s.win.sessionStorage.length).toBe(0);
  });

  it('export mode refuses a non-/export opener, including a cross-origin one', async () => {
    const s = setup('export');
    s.opener.location.pathname = '/approve';
    s.win.message(authParams(), ENV.authOrigin, s.opener);
    await flush();
    expect(s.page.state.stage).toBe('connecting');

    const win = new FakeWindow('/login', '?mode=export');
    const cross = crossOriginWindow();
    win.opener = asWindow(cross);
    const page = startLoginPage({ win, env: ENV });
    win.message(authParams(), ENV.authOrigin, cross);
    await flush();
    expect(page.state.stage).toBe('connecting');
    expect(win.sessionStorage.length).toBe(0);
  });

  it('accepts only the first valid reply', async () => {
    const s = setup('vault');
    s.win.message(authParams(), ENV.vaultOrigin, s.opener);
    s.win.message(authParams(), ENV.vaultOrigin, s.opener);
    await s.page.done;
    expect(s.win.sessionStorage.length).toBe(1);
    expect(s.win.location.assigned).toHaveLength(1);
  });

  it.each([
    ['the vault names another signer', authParams({ signer: 'evil-signer.testnet' })],
    ['the nonce does not commit to the session', authParams({ nonce: 'x'.repeat(43) })],
    ['the nonce commits to another expiry', authParams({ expiresAtMs: 1_900_000_000_001 })],
    ['the nonce commits to another scope', authParams({ scopeId: 's2' })],
  ])('refuses (config_mismatch) when %s, with no Google redirect and nothing stored', async (_, params) => {
    const s = setup('vault');
    s.win.message(params, ENV.vaultOrigin, s.opener);
    expect(await s.page.done).toEqual({ stage: 'error', code: 'config_mismatch' });
    expect(s.win.location.assigned).toEqual([]);
    expect(s.win.sessionStorage.length).toBe(0);
    expect((params.relayKey as Uint8Array).every((b) => b === 0)).toBe(true);
  });

  it.each(['partner', 'vault', 'export'] as const)('%s mode goes to Google with the preparer’s client, with no API call', async (mode) => {
    const s = setup(mode);
    const { source, origin } = preparer(s, mode);
    s.win.message(authParams({ clientId: 'own-client.apps.googleusercontent.com', mode: 'own' }), origin, source);
    expect((await s.page.done).stage).toBe('redirecting');
    expect(new URL(s.win.location.assigned[0] as string).searchParams.get('client_id')).toBe('own-client.apps.googleusercontent.com');
    expect(s.fetch).not.toHaveBeenCalled();
  });

  it('shows the COOP error when window.opener is null, and posts nothing', async () => {
    const win = new FakeWindow('/login', `?v=${VAULT_FRAME}`);
    const page = startLoginPage({ win, env: ENV });
    expect(await page.done).toEqual({ stage: 'error', code: 'coop_blocks_popup' });
    expect(pageText()).toContain('This site’s settings block the Hana sign-in window (COOP)');
    expect(win.listenerCount('message')).toBe(0);
  });

  it('refuses a malformed link and a framed page', async () => {
    const bad = new FakeWindow('/login', '?v=nope');
    bad.opener = asWindow(remoteWindow());
    expect((await startLoginPage({ win: bad, env: ENV }).done).stage).toBe('error');
    const framed = new FakeWindow('/login', '?from=vault');
    framed.opener = asWindow(remoteWindow());
    framed.top = {};
    expect((await startLoginPage({ win: framed, env: ENV }).done).stage).toBe('error');
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
    const s = setup('vault');
    s.win.message(authParams({ appName: '<img src=x onerror=alert(1)>' }), ENV.vaultOrigin, s.opener);
    await s.page.done;
    expect(document.querySelector('img')).toBeNull();
    expect(pageText()).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('timings (pk_test_ apps)', () => {
  it('stores its check as authCheck with the relay key; a duration only', async () => {
    const s = setup('partner');
    const params = authParams();
    s.win.message(params, ENV.vaultOrigin, s.vault);
    await s.page.done;
    const entry = JSON.parse(s.win.sessionStorage.getItem(LOGIN_ENTRY_PREFIX + params.relayId) as string) as Record<string, unknown>;
    expect(Object.keys(entry.t as object)).toEqual(['authCheck']);
    expect((entry.t as { authCheck: number }).authCheck).toBeGreaterThanOrEqual(0);
  });

  it('a pk_live_ app stores no timings', async () => {
    const s = setup('partner');
    const params = authParams({ pk: 'pk_live_1111111111111111' });
    s.win.message(params, ENV.vaultOrigin, s.vault);
    expect((await s.page.done).stage).toBe('redirecting');
    const entry = JSON.parse(s.win.sessionStorage.getItem(LOGIN_ENTRY_PREFIX + params.relayId) as string) as Record<string, unknown>;
    expect(entry).not.toHaveProperty('t');
  });
});

// Hana Home's sign-in child (docs/hana-home-spec.md "Pages and packages"; H1's review): only a same-origin opener at
// /home may supply the nonce, and the nonce must be the Home nonce of the message's own key.
describe('/login?mode=home', () => {
  function homeParams(over: Record<string, unknown> = {}) {
    const homePublicKey = crypto.getRandomValues(new Uint8Array(32));
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const expiresAtMs = 1_800_000_900_000;
    return {
      v: 1,
      t: 'hana:home-params',
      signer: ENV.signer,
      clientId: CLIENT_ID,
      homePublicKey,
      expiresAtMs,
      salt,
      nonce: homeNonce({ signer: ENV.signer, homePublicKey, expiresAtMs, salt }),
      relayId: relayIdFor(crypto.getRandomValues(new Uint8Array(32))),
      relayKey: crypto.getRandomValues(new Uint8Array(32)),
      ...over,
    };
  }

  function home(pathname = '/home') {
    const win = new FakeWindow('/login', '?mode=home');
    const opener = remoteWindow({ location: { pathname } });
    win.opener = asWindow(opener);
    const page = startLoginPage({ win, env: ENV, now: () => 1_800_000_000_000 });
    return { win, opener, page };
  }

  it('says hello to its opener on the auth origin only', () => {
    const s = home();
    expect(s.opener.postMessage).toHaveBeenCalledWith({ v: 1, t: 'hana:auth-hello' }, ENV.authOrigin);
    for (const call of s.opener.postMessage.mock.calls) expect(call[1]).toBe(ENV.authOrigin);
  });

  it('takes the Home page’s message, stores the relay key under the state and goes to Google with the Home nonce', async () => {
    const s = home();
    const params = homeParams();
    const relayKey = Uint8Array.from(params.relayKey);
    s.win.message(params, ENV.authOrigin, s.opener);
    const state = await s.page.done;
    expect(state.stage).toBe('redirecting');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(s.win.location.assigned).toHaveLength(1);
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
    // The callback's entry, exactly a plain login's: the relay key and nothing of a follow-up.
    const entry = JSON.parse(s.win.sessionStorage.getItem(LOGIN_ENTRY_PREFIX + params.relayId) as string) as Record<string, unknown>;
    expect(Object.keys(entry).sort()).toEqual(['createdAt', 'relayKey', 'v']);
    expect(Buffer.from(entry.relayKey as string, 'base64url')).toEqual(Buffer.from(relayKey));
    expect(s.win.sessionStorage.length).toBe(1);
    expect(params.relayKey.every((b) => b === 0)).toBe(true);
    expect(pageText()).toContain('Signing in to Hana Home');
  });

  it.each([
    ['an opener on another page of the auth origin', '/export'],
    ['an opener at the site root', '/'],
    ['an opener at a path that only starts like it', '/home/x'],
    ['an opener at /login', '/login'],
  ])('refuses %s', async (_, pathname) => {
    const s = home(pathname);
    s.win.message(homeParams(), ENV.authOrigin, s.opener);
    await flush();
    expect(s.page.state.stage).toBe('connecting');
    expect(s.win.sessionStorage.length).toBe(0);
    expect(s.win.location.assigned).toEqual([]);
  });

  it('refuses a cross-origin opener, another origin, and another window', async () => {
    const win = new FakeWindow('/login', '?mode=home');
    const cross = crossOriginWindow();
    win.opener = asWindow(cross);
    const page = startLoginPage({ win, env: ENV });
    win.message(homeParams(), ENV.authOrigin, cross);
    await flush();
    expect(page.state.stage).toBe('connecting');

    const s = home();
    s.win.message(homeParams(), ENV.vaultOrigin, s.opener);
    s.win.message(homeParams(), EVIL, s.opener);
    s.win.message(homeParams(), PARTNER, s.opener);
    s.win.message(homeParams(), ENV.authOrigin, remoteWindow({ location: { pathname: '/home' } }));
    s.win.message(homeParams(), ENV.authOrigin, null);
    await flush();
    expect(s.page.state.stage).toBe('connecting');
    expect(s.win.sessionStorage.length).toBe(0);
    expect(s.win.location.assigned).toEqual([]);
  });

  it('takes no session message in this mode, even from /home', async () => {
    const s = home();
    s.win.message(authParams(), ENV.authOrigin, s.opener);
    await flush();
    expect(s.page.state.stage).toBe('connecting');
    expect(s.win.sessionStorage.length).toBe(0);
  });

  it.each(['partner', 'vault', 'export'] as const)('%s mode takes no Home message, so no other opener can supply a Home nonce', async (mode) => {
    const s = setup(mode);
    const { source, origin } = preparer(s, mode);
    s.win.message(homeParams(), origin, source);
    await flush();
    expect(s.page.state.stage).toBe('connecting');
    expect(s.win.sessionStorage.length).toBe(0);
    expect(s.win.location.assigned).toEqual([]);
  });

  it.each([
    ['another signer', () => homeParams({ signer: 'evil-signer.testnet' })],
    ['a nonce that commits to nothing', () => homeParams({ nonce: 'x'.repeat(43) })],
    ['a nonce for another end', () => homeParams({ expiresAtMs: 1_800_000_900_001 })],
    ['a nonce for another key', () => homeParams({ homePublicKey: new Uint8Array(32) })],
    [
      'a session nonce',
      () => {
        const p = homeParams();
        return { ...p, nonce: sessionNonce({ signer: ENV.signer, scopeId: SCOPE, sessionPublicKey: p.homePublicKey, expiresAtMs: p.expiresAtMs, keyIndex: 0, maxUses: 1, salt: p.salt }) };
      },
    ],
  ])('stops (config_mismatch) on %s: nothing stored, no Google request', async (_, make) => {
    const s = home();
    const params = make();
    s.win.message(params, ENV.authOrigin, s.opener);
    expect(await s.page.done).toEqual({ stage: 'error', code: 'config_mismatch' });
    expect(s.win.location.assigned).toEqual([]);
    expect(s.win.sessionStorage.length).toBe(0);
    expect((params.relayKey as Uint8Array).every((b) => b === 0)).toBe(true);
  });

  // Hana Home opening one app's wallet (H8): a session of one use and key index 0, and Google asked to sign in again.
  function deriveParams(over: Record<string, unknown> = {}, nonceOver: { keyIndex?: number; maxUses?: number; scopeId?: string } = {}) {
    const sessionPublicKey = crypto.getRandomValues(new Uint8Array(32));
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const expiresAtMs = 1_800_000_900_000;
    return {
      v: 1,
      t: 'hana:home-derive-params',
      signer: ENV.signer,
      clientId: CLIENT_ID,
      scopeId: SCOPE,
      sessionPublicKey,
      expiresAtMs,
      salt,
      nonce: sessionNonce({ signer: ENV.signer, scopeId: nonceOver.scopeId ?? SCOPE, sessionPublicKey, expiresAtMs, keyIndex: nonceOver.keyIndex ?? 0, maxUses: nonceOver.maxUses ?? 1, salt }),
      relayId: relayIdFor(crypto.getRandomValues(new Uint8Array(32))),
      relayKey: crypto.getRandomValues(new Uint8Array(32)),
      ...over,
    };
  }

  it('takes Hana Home’s per-app message and goes to Google with the session nonce and max_age=0', async () => {
    const s = home();
    const params = deriveParams();
    s.win.message(params, ENV.authOrigin, s.opener);
    expect((await s.page.done).stage).toBe('redirecting');
    expect(fetchSpy).not.toHaveBeenCalled();
    const url = new URL(s.win.location.assigned[0] as string);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT_ID,
      redirect_uri: `${ENV.authOrigin}/login/callback`,
      response_type: 'id_token',
      response_mode: 'fragment',
      scope: 'openid',
      nonce: params.nonce,
      state: params.relayId,
      prompt: 'select_account',
      max_age: '0',
    });
    // No account id rides in the address, and the entry is a plain login's.
    expect(url.searchParams.has('login_hint')).toBe(false);
    const entry = JSON.parse(s.win.sessionStorage.getItem(LOGIN_ENTRY_PREFIX + params.relayId) as string) as Record<string, unknown>;
    expect(Object.keys(entry).sort()).toEqual(['createdAt', 'relayKey', 'v']);
    expect(s.win.sessionStorage.length).toBe(1);
    expect(params.relayKey.every((b) => b === 0)).toBe(true);
    expect(pageText()).toContain('Choose your Google account again');
  });

  it.each([
    ['another signer', () => deriveParams({ signer: 'evil-signer.testnet' })],
    ['a nonce that commits to nothing', () => deriveParams({ nonce: 'x'.repeat(43) })],
    ['a nonce for another scope', () => deriveParams({}, { scopeId: 's2' })],
    ['a nonce for another key index', () => deriveParams({}, { keyIndex: 1 })],
    ['a nonce for more than one use', () => deriveParams({}, { maxUses: 2 })],
    ['a nonce for another end', () => deriveParams({ expiresAtMs: 1_800_000_900_001 })],
    [
      'a Home nonce',
      () => {
        const p = deriveParams();
        return { ...p, nonce: homeNonce({ signer: ENV.signer, homePublicKey: p.sessionPublicKey, expiresAtMs: p.expiresAtMs, salt: p.salt }) };
      },
    ],
  ])('stops the per-app sign-in (config_mismatch) on %s: nothing stored, no Google request', async (_, make) => {
    const s = home();
    const params = make();
    s.win.message(params, ENV.authOrigin, s.opener);
    expect(await s.page.done).toEqual({ stage: 'error', code: 'config_mismatch' });
    expect(s.win.location.assigned).toEqual([]);
    expect(s.win.sessionStorage.length).toBe(0);
    expect((params.relayKey as Uint8Array).every((b) => b === 0)).toBe(true);
  });

  it('takes the per-app message only from /home: not from another page, origin or window, and not in another mode', async () => {
    for (const pathname of ['/export', '/', '/home/x', '/login']) {
      const s = home(pathname);
      s.win.message(deriveParams(), ENV.authOrigin, s.opener);
      await flush();
      expect(s.page.state.stage, pathname).toBe('connecting');
      expect(s.win.location.assigned).toEqual([]);
    }
    const s = home();
    s.win.message(deriveParams(), ENV.vaultOrigin, s.opener);
    s.win.message(deriveParams(), EVIL, s.opener);
    s.win.message(deriveParams(), ENV.authOrigin, remoteWindow({ location: { pathname: '/home' } }));
    await flush();
    expect(s.page.state.stage).toBe('connecting');
    for (const mode of ['partner', 'vault', 'export'] as const) {
      const o = setup(mode);
      const { source, origin } = preparer(o, mode);
      o.win.message(deriveParams(), origin, source);
      await flush();
      expect(o.page.state.stage, mode).toBe('connecting');
      expect(o.win.sessionStorage.length).toBe(0);
      expect(o.win.location.assigned).toEqual([]);
    }
  });

  it('accepts only the first valid message, and times out with Home’s own words', async () => {
    const s = home();
    s.win.message(homeParams(), ENV.authOrigin, s.opener);
    s.win.message(homeParams(), ENV.authOrigin, s.opener);
    await s.page.done;
    expect(s.win.location.assigned).toHaveLength(1);

    const t = home();
    vi.advanceTimersByTime(HELLO_TIMEOUT_MS + 1);
    expect(await t.page.done).toEqual({ stage: 'error', code: 'login_timeout' });
    expect(pageText()).toContain('Hana Home did not answer');
  });
});
