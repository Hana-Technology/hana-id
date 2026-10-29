// Login, vault side (docs/batch-b-spec.md "Login", "Failure handling"; Tests → Web unit → Vault, Login (vault)).
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { addressesFromCkdSecret, ckdAppId, decryptCkd, newAppKey, sessionNonce, toHex } from '@hana-id/core';
import {
  Browser,
  CLIENT_ID,
  ENV,
  FakeWindow,
  type Google,
  HOUR,
  PARTNER,
  SCOPE,
  START_MS,
  SUB,
  type Tab,
  apiError,
  deliverToken,
  google,
  login,
  makeConfig,
  mpcAnswer,
  popupHello,
  readyTab,
  sleepReal,
} from './harness.ts';

let g: Google;
const tabs: Tab[] = [];
beforeAll(async () => {
  g = await google();
});
afterEach(() => {
  for (const t of tabs.splice(0)) {
    t.close();
    t.browser.timers.dispose();
  }
});

async function tab(browser = new Browser(), o: Parameters<typeof readyTab>[1] = {}): Promise<Tab> {
  const t = await readyTab(browser, { googleJwk: g.jwk, ...o });
  tabs.push(t);
  return t;
}

/** The addresses the fake MPC's key gives for SUB in SCOPE (an independent derivation through core). */
function expectedAddresses(sub = SUB) {
  const key = newAppKey();
  const path = `${SCOPE}#google#${sub}#0`;
  const s = decryptCkd(mpcAnswer(key.publicKey.AppPublicKeyPV.pk1, path), key.a, ckdAppId(ENV.signer, path), ENV.ckdNetworkKey);
  return addressesFromCkdSecret(s);
}

describe('login (vault side)', () => {
  it('logs in through the popup and the relay, and derives the addresses of its own path', async () => {
    const t = await tab();
    const { reply, run } = await login(t, g);
    expect(reply.error).toBeUndefined();
    const result = reply.result as Record<string, unknown>;
    expect(result.addresses).toEqual(expectedAddresses());
    expect(result.persistence).toBe('session');
    expect(result.expiresAtMs).toBe(START_MS + 12 * HOUR);
    expect(result.timings).toBeTypeOf('object');
    // auth-params: the pinned SIGNER and inlined scope, the nonce over them, relayId = b64url(sha256(relayReadKey)).
    const p = run.params;
    expect(p).toMatchObject({ pk: makeConfig().publishableKey, appName: 'Partner', parentOrigin: PARTNER, scopeId: SCOPE, signer: ENV.signer, clientId: CLIENT_ID, mode: 'shared', keyIndex: 0, maxUses: 1 });
    expect(run.popup.posted[0]!.targetOrigin).toBe(ENV.authOrigin);
    expect(p.nonce).toBe(
      sessionNonce({ signer: ENV.signer, scopeId: SCOPE, sessionPublicKey: p.sessionPublicKey as Uint8Array, expiresAtMs: p.expiresAtMs as number, keyIndex: 0, maxUses: 1, salt: p.salt as Uint8Array }),
    );
    expect(p.relayId).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    // One /v1/login, with the vault's own session key, salt and the counter-1 signature.
    const loginCall = t.browser.backend.calls.find((c) => c.path === '/v1/login')!;
    expect(loginCall.headers['x-hana-key']).toBe(makeConfig().publishableKey);
    expect(loginCall.headers['x-hana-parent-origin']).toBe(PARTNER);
    expect(loginCall.body).toMatchObject({ sessionPublicKey: Array.from(p.sessionPublicKey as Uint8Array), keyIndex: 0, maxUses: 1, expiresAtMs: p.expiresAtMs });
    expect((loginCall.body as { signature: number[] }).signature).toHaveLength(64);
    // Progress and accountsChanged.
    expect(t.events.filter((e) => e.event === 'loginProgress').map((e) => (e.data as { stage: string }).stage)).toEqual(['popup_connected', 'google', 'token', 'chain', 'done']);
    expect(await t.waitEvent('accountsChanged')).toEqual({ addresses: expectedAddresses() });
    expect((await t.request('hana_status')).result).toMatchObject({ status: 'logged_in', addresses: expectedAddresses(), persistence: 'session' });
    expect((await t.request('eth_accounts')).result).toEqual([expectedAddresses().evm]);
    expect((await t.request('stellar_getAddress')).result).toEqual({ address: expectedAddresses().stellar });
  });

  it('uses max_uses 2 in "none" mode and creates no share', async () => {
    const t = await tab(new Browser(), { config: makeConfig({ settings: { persistence: 'none' } }) });
    const { reply, run } = await login(t, g);
    expect(run.params.maxUses).toBe(2);
    expect((reply.result as { persistence: string }).persistence).toBe('none');
    expect(t.browser.backend.count('/v1/vault/shares')).toBe(0);
  });

  it('omits timings for pk_live_ apps', async () => {
    const t = await tab(new Browser(), { config: makeConfig({ publishableKey: 'pk_live_1111111111111111111111' }) });
    const { reply } = await login(t, g);
    expect(reply.result).not.toHaveProperty('timings');
  });

  describe('auth-hello', () => {
    it('answers only from authOrigin and only a popup whose opener is the partner page (partner mode)', async () => {
      const t = await tab();
      const pending = t.request('hana_login');
      const foreign = new FakeWindow('x', 'x', '', new FakeWindow());
      const noOpener = new FakeWindow('x', 'x', '', null);
      const good = new FakeWindow('x', 'x', '', t.parent);
      await sleepReal(50);
      t.dispatch({ data: { v: 1, t: 'hana:auth-hello' }, origin: ENV.authOrigin, source: foreign });
      t.dispatch({ data: { v: 1, t: 'hana:auth-hello' }, origin: ENV.authOrigin, source: noOpener });
      t.dispatch({ data: { v: 1, t: 'hana:auth-hello' }, origin: 'https://evil.test', source: good });
      t.dispatch({ data: { v: 1, t: 'hana:auth-hello', extra: 1 }, origin: ENV.authOrigin, source: good });
      t.dispatch({ data: { v: 1, t: 'hana:auth-hello' }, origin: ENV.vaultOrigin, source: good });
      await sleepReal(20);
      expect(foreign.posted).toHaveLength(0);
      expect(noOpener.posted).toHaveLength(0);
      expect(good.posted).toHaveLength(0);
      const run = await popupHello(t, good);
      // Once only: a second hello (or another popup) gets nothing.
      const other = new FakeWindow('y', 'y', '', t.parent);
      t.dispatch({ data: { v: 1, t: 'hana:auth-hello' }, origin: ENV.authOrigin, source: other });
      t.dispatch({ data: { v: 1, t: 'hana:auth-hello' }, origin: ENV.authOrigin, source: good });
      await sleepReal(20);
      expect(other.posted).toHaveLength(0);
      expect(good.posted.filter((p) => p.message.t === 'hana:auth-params')).toHaveLength(1);
      await deliverToken(t, g, run);
      expect((await pending).result).toHaveProperty('addresses');
    });

    it('answers nothing while no login is pending', async () => {
      const t = await tab();
      const popup = new FakeWindow('x', 'x', '', t.parent);
      t.dispatch({ data: { v: 1, t: 'hana:auth-hello' }, origin: ENV.authOrigin, source: popup });
      await sleepReal(30);
      expect(popup.posted).toHaveLength(0);
    });

    it('vault mode (popup blocked): shows the launcher, opens /login?from=vault, and answers only that window', async () => {
      const t = await tab();
      const pending = t.request('hana_login', { popupBlocked: true });
      await t.waitEvent('ui');
      expect(t.events.find((e) => e.event === 'ui')!.data).toEqual({ launcher: 'show', label: 'Sign in with Hana' });
      // A popup the partner page opened is not the launcher's.
      const partnerPopup = new FakeWindow('x', 'x', '', t.parent);
      t.dispatch({ data: { v: 1, t: 'hana:auth-hello' }, origin: ENV.authOrigin, source: partnerPopup });
      t.launcher.click();
      const opened = t.opened.at(-1)!;
      expect(opened.url).toBe(`${ENV.authOrigin}/login?from=vault`);
      expect(opened.name).toMatch(/^hana-login-[0-9a-f]{32}$/u);
      expect(opened.features).toBe('popup,width=480,height=640');
      const run = await popupHello(t, opened);
      expect(partnerPopup.posted).toHaveLength(0);
      await deliverToken(t, g, run);
      expect((await pending).result).toHaveProperty('addresses');
      expect(t.launcher.label).toBeNull();
    });

    it('vault mode: hana_cancelLogin ends the blocked login with popup_blocked', async () => {
      const t = await tab();
      const pending = t.request('hana_login', { popupBlocked: true });
      await t.waitEvent('ui');
      expect((await t.request('hana_cancelLogin')).result).toBeNull();
      expect((await pending).error?.code).toBe('popup_blocked');
    });
  });

  it('a GET /v1/app with another signer or scope gives config_mismatch, with no auth-params and no derive', async () => {
    for (const app of [{ signer: 'evil-signer.testnet' }, { scopeId: 'other' }]) {
      const browser = new Browser();
      browser.backend.app = { ...browser.backend.app, ...app };
      const t = await tab(browser);
      const pending = t.request('hana_login');
      const popup = new FakeWindow('x', 'x', '', t.parent);
      for (let i = 0; i < 5; i++) {
        t.dispatch({ data: { v: 1, t: 'hana:auth-hello' }, origin: ENV.authOrigin, source: popup });
        await sleepReal(5);
      }
      expect((await pending).error?.code).toBe('config_mismatch');
      expect(popup.posted).toHaveLength(0);
      expect(browser.backend.count('/v1/login')).toBe(0);
      expect(browser.backend.count('/v1/derive')).toBe(0);
    }
  });

  it('409 no_google_client gives no_google_client', async () => {
    const browser = new Browser();
    browser.backend.overrides.set('/v1/app', () => apiError(409, 'no_google_client'));
    const t = await tab(browser);
    expect((await t.request('hana_login')).error?.code).toBe('no_google_client');
  });

  describe('the relayed token', () => {
    it('refuses a relay payload it cannot decrypt (token_invalid)', async () => {
      const t = await tab();
      const pending = t.request('hana_login');
      const run = await popupHello(t);
      // Encrypted under another key: the API (or anyone without relayKey) can't put a token in the slot.
      await t.browser.backend.writeRelay(run.params.relayId as string, new Uint8Array(32).fill(7), { idToken: await g.token({}) });
      expect((await pending).error?.code).toBe('token_invalid');
      expect(t.browser.backend.count('/v1/login')).toBe(0);
    });

    it('turns a Google #error into google_error', async () => {
      const t = await tab();
      const pending = t.request('hana_login');
      const run = await popupHello(t);
      await t.browser.backend.writeRelay(run.params.relayId as string, run.params.relayKey as Uint8Array, { error: 'access_denied' });
      const reply = await pending;
      expect(reply.error).toMatchObject({ code: 'google_error', data: { error: 'access_denied' } });
    });

    it.each([
      ['a wrong nonce', { nonce: 'n'.repeat(43) }, 'token_invalid'],
      ['a wrong aud', { aud: 'other.apps.googleusercontent.com' }, 'token_invalid'],
      ['a wrong iss', { iss: 'https://evil.example' }, 'token_invalid'],
      ['an expired token', { exp: Math.floor(START_MS / 1000) - 120 }, 'token_invalid'],
      ['an iat in the future', { iat: Math.floor(START_MS / 1000) + 120 }, 'token_invalid'],
      ['an email claim', { email: 'a@b.c' }, 'token_has_pii'],
      ['an hd claim', { hd: 'corp.example' }, 'token_has_pii'],
      ['a sub with #', { sub: 'a#b' }, 'token_invalid'],
    ])('refuses %s, before any chain call', async (_, over, code) => {
      const t = await tab();
      const pending = t.request('hana_login');
      const run = await popupHello(t);
      await deliverToken(t, g, run, over);
      const reply = await pending;
      expect(reply.error?.code).toBe(code);
      if (code === 'token_has_pii') expect(reply.error?.data).toEqual({ claim: Object.keys(over)[0] });
      expect(t.browser.backend.count('/v1/login')).toBe(0);
    });

    it('refuses a token signed by an unknown key', async () => {
      const t = await tab(new Browser(), { googleJwk: { ...g.jwk, kid: 'other' } });
      const pending = t.request('hana_login');
      const run = await popupHello(t);
      await deliverToken(t, g, run);
      expect((await pending).error?.code).toBe('token_invalid');
    });
  });

  it('never uses a path, session or counter from the API: an API result for another path fails the pairing check', async () => {
    const browser = new Browser();
    browser.backend.overrides.set('/v1/login', (call) => {
      const body = call.body as Record<string, unknown>;
      // A compromised API answers with the CKD of an attacker's path, and claims a session for it.
      const result = mpcAnswer(body.pk1 as string, `${SCOPE}#google#attacker#0`);
      return new Response(JSON.stringify({ result, session: { scope_id: SCOPE, expires_at_ms: body.expiresAtMs, max_uses: 1, used: 1, path: `${SCOPE}#google#attacker#0` }, nearTx: 'tx', requestId: 'rq' }), { status: 200 });
    });
    const t = await tab(browser);
    expect((await login(t, g)).reply.error?.code).toBe('pairing_failed');
  });

  describe('failure handling', () => {
    it('session_exists with uses left: re-syncs from NEAR and derives with the next counter', async () => {
      const browser = new Browser();
      // Someone front-ran create_session with the vault's key ('none' mode: max_uses 2).
      browser.backend.overrides.set('/v1/login', (call) => {
        browser.backend.createSession({ ...(call.body as object), maxUses: 2 } as Record<string, unknown>, false);
        return apiError(409, 'session_exists');
      });
      const t = await tab(browser, { config: makeConfig({ settings: { persistence: 'none' } }) });
      const { reply } = await login(t, g);
      expect(reply.result).toMatchObject({ addresses: expectedAddresses() });
      const derive = browser.backend.calls.find((c) => c.path === '/v1/derive')!;
      expect((derive.body as { counter: number }).counter).toBe(1);
      expect(browser.backend.rpcCalls.some((c) => c.method === 'query' && c.params.finality === 'optimistic' && c.params.method_name === 'get_session' && c.params.account_id === ENV.signer)).toBe(true);
    });

    it('session_key_in_use with every use spent and no known tx: session_consumed and a "Continue signing in" launcher', async () => {
      const browser = new Browser();
      browser.backend.overrides.set('/v1/login', (call) => {
        // A replay of the whole combined call landed first (the attacker's tx): used = max_uses = 1.
        browser.backend.createSession(call.body as Record<string, unknown>, true);
        return apiError(422, 'contract_rejected', { reason: 'session_key_in_use', nearTx: null });
      });
      const t = await tab(browser);
      const { reply } = await login(t, g);
      expect(reply.error?.code).toBe('session_consumed');
      expect(browser.backend.count('/v1/derive')).toBe(0);
      expect(t.launcher.label).toBe('Continue signing in');
      // Its click starts a fresh login (new session key) in vault mode; the result arrives as accountsChanged.
      browser.backend.overrides.delete('/v1/login');
      t.launcher.click();
      const popup = t.opened.at(-1)!;
      expect(popup.url).toBe(`${ENV.authOrigin}/login?from=vault`);
      const run = await popupHello(t, popup);
      const firstLogin = browser.backend.calls.find((c) => c.path === '/v1/login')!.body as { sessionPublicKey: number[] };
      expect(toHex(run.params.sessionPublicKey as Uint8Array)).not.toBe(toHex(Uint8Array.from(firstLogin.sessionPublicKey)));
      await deliverToken(t, g, run);
      expect(await t.waitEvent('accountsChanged')).toEqual({ addresses: expectedAddresses() });
    });

    it('session_exists with every use spent but a known tx of ours: polls it (sender RELAYER) for the result', async () => {
      const browser = new Browser();
      let first = true;
      browser.backend.overrides.set('/v1/login', (call) => {
        if (!first) return undefined;
        first = false;
        // Our first attempt landed but the answer was lost: 504 with its nearTx.
        const r = browser.backend.createSession(call.body as Record<string, unknown>, true);
        if (r.ok) browser.backend.txs.set('tx-ours', r.result);
        return apiError(504, 'timeout', { nearTx: 'tx-ours' });
      });
      const t = await tab(browser);
      const { reply } = await login(t, g);
      expect(reply.result).toMatchObject({ addresses: expectedAddresses() });
      const poll = browser.backend.rpcCalls.find((c) => c.method === 'EXPERIMENTAL_tx_status')!;
      expect(poll.params).toEqual({ tx_hash: 'tx-ours', sender_account_id: ENV.relayer, wait_until: 'EXECUTED_OPTIMISTIC' });
      expect(browser.backend.count('/v1/login')).toBe(1);
    });

    it('timeout whose tx never settles: re-syncs; no session → resends the same body once', async () => {
      const browser = new Browser();
      let n = 0;
      browser.backend.overrides.set('/v1/login', () => (++n === 1 ? apiError(504, 'timeout', { nearTx: 'tx-lost' }) : undefined));
      browser.backend.txs.set('tx-lost', 'failure');
      const t = await tab(browser);
      const { reply } = await login(t, g);
      expect(reply.result).toHaveProperty('addresses');
      const bodies = browser.backend.calls.filter((c) => c.path === '/v1/login').map((c) => JSON.stringify(c.body));
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toBe(bodies[1]);
    });

    it('near_error with a tx: re-sync finds the session with a use left → derive', async () => {
      const browser = new Browser();
      browser.backend.overrides.set('/v1/login', (call) => {
        browser.backend.createSession({ ...(call.body as object), maxUses: 2 } as Record<string, unknown>, false);
        return apiError(502, 'near_error', { nearTx: 'tx-x' });
      });
      browser.backend.txs.set('tx-x', 'failure');
      const t = await tab(browser, { config: makeConfig({ settings: { persistence: 'none' } }) });
      expect((await login(t, g)).reply.result).toHaveProperty('addresses');
      expect(browser.backend.count('/v1/derive')).toBe(1);
    });

    it.each(['method_not_allowed', 'near_unavailable', 'near_rejected', 'relayer_busy', 'relayer_unconfigured'])('%s (not executed) resends once, then api_unavailable', async (code) => {
      const browser = new Browser();
      browser.backend.overrides.set('/v1/login', () => apiError(code === 'method_not_allowed' ? 400 : 503, code, { nearTx: null }));
      const t = await tab(browser);
      expect((await login(t, g)).reply.error?.code).toBe('api_unavailable');
      expect(browser.backend.count('/v1/login')).toBe(2);
    });

    it('a not-executed code followed by success resends the same body', async () => {
      const browser = new Browser();
      let n = 0;
      browser.backend.overrides.set('/v1/login', () => (++n === 1 ? apiError(503, 'relayer_busy') : undefined));
      const t = await tab(browser);
      expect((await login(t, g)).reply.result).toHaveProperty('addresses');
      expect(browser.backend.count('/v1/login')).toBe(2);
    });

    it('relayer_unavailable without a tx: waits, re-syncs, and resends when no session landed', async () => {
      const browser = new Browser();
      let n = 0;
      browser.backend.overrides.set('/v1/login', () => (++n === 1 ? apiError(503, 'relayer_unavailable') : undefined));
      const t = await tab(browser);
      expect((await login(t, g)).reply.result).toHaveProperty('addresses');
      expect(browser.backend.rpcCalls.some((c) => c.method === 'query')).toBe(true);
      expect(browser.backend.count('/v1/login')).toBe(2);
    });

    it('ckd_failed: a new login in "session" mode; a counter-2 derive in "none" mode', async () => {
      const fails = (browser: Browser) =>
        browser.backend.overrides.set('/v1/login', (call) => {
          browser.backend.createSession({ ...(call.body as object) } as Record<string, unknown>, false).ok &&
            (browser.backend.sessions.values().next().value!.used = 1);
          return apiError(422, 'ckd_failed', { session: { used: 1 }, nearTx: 'tx-f' });
        });
      const b1 = new Browser();
      fails(b1);
      const t1 = await tab(b1);
      expect((await login(t1, g)).reply.error?.code).toBe('ckd_failed');
      expect(b1.backend.count('/v1/derive')).toBe(0);

      const b2 = new Browser();
      fails(b2);
      const t2 = await tab(b2, { config: makeConfig({ settings: { persistence: 'none' } }) });
      expect((await login(t2, g)).reply.result).toHaveProperty('addresses');
      expect((b2.backend.calls.find((c) => c.path === '/v1/derive')!.body as { counter: number }).counter).toBe(2);
    });

    it('a re-synced session with another path or scope fails derive_failed', async () => {
      const browser = new Browser();
      browser.backend.overrides.set('/v1/login', (call) => {
        browser.backend.createSession({ ...(call.body as object), maxUses: 2 } as Record<string, unknown>, false);
        for (const s of browser.backend.sessions.values()) s.path = `${SCOPE}#google#someone-else#0`;
        return apiError(409, 'session_exists');
      });
      const t = await tab(browser, { config: makeConfig({ settings: { persistence: 'none' } }) });
      expect((await login(t, g)).reply.error?.code).toBe('derive_failed');
      expect(browser.backend.count('/v1/derive')).toBe(0);
    });

    it.each([
      [400, 'token_has_pii', 'token_has_pii'],
      [401, 'invalid_token', 'token_invalid'],
      [403, 'app_suspended', 'app_suspended'],
      [403, 'origin_not_allowed', 'origin_not_allowed'],
      [429, 'rate_limited', 'rate_limited'],
      [503, 'issuer_keys_unavailable', 'api_unavailable'],
      [422, 'contract_rejected', 'derive_failed'],
    ])('%i %s maps to %s', async (status, code, mapped) => {
      const browser = new Browser();
      browser.backend.overrides.set('/v1/login', () => apiError(status, code, code === 'token_has_pii' ? { data: { claim: 'email' } } : {}));
      const t = await tab(browser);
      const reply = (await login(t, g)).reply;
      expect(reply.error?.code).toBe(mapped);
      if (code === 'token_has_pii') expect(reply.error?.data).toEqual({ claim: 'email' });
    });
  });

  describe('pending logins', () => {
    it('a second hana_login supersedes the first (login_cancelled), and a late relay write for the old relayId is ignored', async () => {
      const t = await tab();
      const first = t.request('hana_login');
      const run1 = await popupHello(t);
      const second = t.request('hana_login');
      expect((await first).error?.code).toBe('login_cancelled');
      const run2 = await popupHello(t, new FakeWindow('p2', 'p2', '', t.parent));
      expect(run2.params.relayId).not.toBe(run1.params.relayId);
      // The old slot is never read again.
      await deliverToken(t, g, run1);
      await sleepReal(60);
      expect(t.browser.backend.relay.get(run1.params.relayId as string)).not.toBe('consumed');
      await deliverToken(t, g, run2);
      expect((await second).result).toHaveProperty('addresses');
      expect(t.browser.backend.count('/v1/login')).toBe(1);
    });

    it('hana_cancelLogin ends a pending login with login_cancelled', async () => {
      const t = await tab();
      const pending = t.request('hana_login');
      await popupHello(t);
      expect((await t.request('hana_cancelLogin')).result).toBeNull();
      expect((await pending).error?.code).toBe('login_cancelled');
    });

    it('the 5 min pending limit gives login_timeout (stage pending)', async () => {
      const t = await tab();
      const pending = t.request('hana_login');
      await popupHello(t);
      t.browser.timers.advance(5 * 60_000);
      expect((await pending).error).toMatchObject({ code: 'login_timeout', data: { stage: 'pending' } });
    });

    it('busy applies only to export: two hana_login calls never give busy', async () => {
      const t = await tab();
      const a = t.request('hana_login');
      const b = t.request('hana_login');
      const codes = [(await a).error?.code];
      await t.request('hana_cancelLogin');
      codes.push((await b).error?.code);
      expect(codes).not.toContain('busy');
    });
  });

  describe('the server-corrected clock', () => {
    it.each([
      ['2 min slow', -2 * 60_000],
      ['3 h fast', 3 * HOUR],
      ['3 h slow', -3 * HOUR],
    ])('with the device clock %s, a fresh token is accepted and expiresAtMs stays within the contract bound', async (_, skew) => {
      const browser = new Browser();
      // The device clock is off; the server's (and Google's) is START_MS.
      browser.timers.now = START_MS + skew;
      const t = await tab(browser);
      const pending = t.request('hana_login');
      const run = await popupHello(t);
      await deliverToken(t, g, run, {}, START_MS);
      const reply = await pending;
      expect(reply.error).toBeUndefined();
      const exp = (reply.result as { expiresAtMs: number }).expiresAtMs;
      expect(exp).toBe(START_MS + 12 * HOUR);
      expect(exp).toBeLessThanOrEqual(START_MS + 24 * HOUR);
    });

    it('caps the session at 24 h − 10 min whatever the setting says', async () => {
      const t = await tab(new Browser(), { config: makeConfig({ settings: { sessionTtlMs: 23 * HOUR + 50 * 60_000 } }) });
      const { reply } = await login(t, g);
      expect((reply.result as { expiresAtMs: number }).expiresAtMs).toBe(START_MS + 24 * HOUR - 10 * 60_000);
    });
  });

  it('the split fallback: /v1/sessions then /v1/derive with counter 1', async () => {
    const t = await tab(new Browser(), { loginFlow: 'split' });
    const { reply } = await login(t, g);
    expect(reply.result).toMatchObject({ addresses: expectedAddresses() });
    expect(t.browser.backend.count('/v1/sessions')).toBe(1);
    expect((t.browser.backend.calls.find((c) => c.path === '/v1/derive')!.body as { counter: number }).counter).toBe(1);
    expect(t.browser.backend.count('/v1/login')).toBe(0);
  });
});
