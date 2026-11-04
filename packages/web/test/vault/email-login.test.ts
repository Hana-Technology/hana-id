// Email login, vault side (build plan batch 8a): the offer in auth-params (only for an app with email, in an env with
// an email issuer), the email token's check against the chain, the `{scope}#email#{sub}#0` path, the email step's
// cancel codes, the progress message, the record check and the export refusal; and the golden Google path.
import { addressesFromCkdSecret, ckdAppId, decryptCkd, newAppKey, toHex } from '@hana-id/core';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LOGIN_PENDING_MS, isOwnLoginPath, loginPath } from '../../src/vault/login.ts';
import { EMAIL_STEP_LIMIT_MS } from '../../src/auth/email-storage.ts';
import {
  Browser,
  EMAIL_ENV,
  EMAIL_SUB,
  ENV,
  FakeWindow,
  type EmailIssuer,
  type Google,
  SCOPE,
  SUB,
  type Tab,
  deliverEmailToken,
  deliverToken,
  emailIssuer,
  enableEmail,
  google,
  login,
  mpcAnswer,
  persisted,
  popupHello,
  readyTab,
  waitLauncher,
} from './harness.ts';

let g: Google;
let issuer: EmailIssuer;
const tabs: Tab[] = [];
beforeAll(async () => {
  [g, issuer] = await Promise.all([google(), emailIssuer()]);
});
afterEach(() => {
  for (const t of tabs.splice(0)) {
    t.close();
    t.browser.timers.dispose();
  }
});

async function tab(browser = new Browser(), o: Parameters<typeof readyTab>[1] = {}): Promise<Tab> {
  const t = await readyTab(browser, { googleJwk: g.jwk, env: EMAIL_ENV, ...o });
  tabs.push(t);
  return t;
}

function emailBrowser(): Browser {
  const b = new Browser();
  enableEmail(b.backend, issuer);
  return b;
}

/** The addresses the fake MPC's key gives for `path` (an independent derivation through core). */
function addressesOf(path: string) {
  const key = newAppKey();
  return addressesFromCkdSecret(decryptCkd(mpcAnswer(key.publicKey.AppPublicKeyPV.pk1, path), key.a, ckdAppId(ENV.signer, path), ENV.ckdNetworkKey));
}

async function emailLogin(t: Tab, params?: Record<string, unknown>, over: Record<string, unknown> = {}) {
  const pending = t.request('hana_login', params);
  const run = await popupHello(t);
  await deliverEmailToken(t, issuer, run, over);
  const reply = await pending;
  await persisted(t);
  return { reply, run };
}

describe('the path (golden)', () => {
  it('an unlinked Google identity gives batch B’s path byte for byte; email its own provider', () => {
    expect(loginPath('s1', 'google', '110248495921238986420', 0)).toBe('s1#google#110248495921238986420#0');
    expect(loginPath(SCOPE, 'google', SUB, 0)).toBe(`${SCOPE}#google#${SUB}#0`);
    expect(loginPath('s1', 'email', 'e1.abc', 0)).toBe('s1#email#e1.abc#0');
    expect(isOwnLoginPath(`${SCOPE}#google#${SUB}#0`, SCOPE)).toBe(true);
    expect(isOwnLoginPath(`${SCOPE}#email#${EMAIL_SUB}#0`, SCOPE)).toBe(true);
    expect(isOwnLoginPath(`other#google#${SUB}#0`, SCOPE)).toBe(false);
    expect(isOwnLoginPath(`${SCOPE}#apple#x#0`, SCOPE)).toBe(false);
    expect(isOwnLoginPath(`${SCOPE}x#google#${SUB}#0`, SCOPE)).toBe(false);
  });

  it('a Google login, with email on, still derives the Google path’s key exactly', async () => {
    const t = await tab(emailBrowser());
    const { reply } = await login(t, g);
    expect((reply.result as { addresses: unknown }).addresses).toEqual(addressesOf(`${SCOPE}#google#${SUB}#0`));
    expect([...t.browser.backend.sessions.values()][0]!.path).toBe(`${SCOPE}#google#${SUB}#0`);
  });
});

describe('the offer', () => {
  const BATCH_B_PARAMS = ['v', 't', 'pk', 'appName', 'parentOrigin', 'scopeId', 'signer', 'clientId', 'mode', 'sessionPublicKey', 'expiresAtMs', 'salt', 'keyIndex', 'maxUses', 'nonce', 'relayId', 'relayKey'];

  it('a Google-only app’s auth-params are batch B’s, key for key, plus (token_first, the default) the record-only keys in an env with an issuer', async () => {
    // token_first (D270): every Google login of an env with an email issuer carries the follow-up key; an app without
    // email login is marked `emailRecord` (google-record, D269), never offered email.
    const t = await tab();
    const { run, reply } = await login(t, g);
    expect(reply.error).toBeUndefined();
    expect(Object.keys(run.params).sort()).toEqual([...BATCH_B_PARAMS, 'followKey', 'emailRecord'].sort());
    expect(run.params.emailRecord).toBe(true);
    // No email issuer in the env: batch B's, whatever the flow.
    for (const flow of ['token_first', 'second_request'] as const) {
      const u = await tab(new Browser(), { env: ENV, options: { googleEmailFlow: flow } });
      expect(Object.keys((await login(u, g)).run.params).sort(), flow).toEqual([...BATCH_B_PARAMS].sort());
    }
    // second_request: batch B's in an env with an issuer too.
    const w = await tab(new Browser(), { options: { googleEmailFlow: 'second_request' } });
    expect(Object.keys((await login(w, g)).run.params).sort()).toEqual([...BATCH_B_PARAMS].sort());
  });

  it('an app with email offers both methods; hana_login’s method and hint ride along', async () => {
    const t = await tab(emailBrowser());
    const pending = t.request('hana_login', { method: 'email', emailHint: 'ada@example.com' });
    const run = await popupHello(t);
    expect(run.params).toMatchObject({ methods: ['google', 'email'], method: 'email', emailHint: 'ada@example.com' });
    await deliverEmailToken(t, issuer, run);
    expect((await pending).error).toBeUndefined();
  });

  it('no offer without an email issuer in the env, or without the scope’s email client in /v1/app', async () => {
    const t = await tab(emailBrowser(), { env: ENV });
    const { run } = await login(t, g);
    expect(run.params).not.toHaveProperty('methods');
    const b = emailBrowser();
    b.backend.app = { ...b.backend.app, loginMethods: ['google'], email: undefined };
    const u = await tab(b);
    expect((await login(u, g)).run.params).not.toHaveProperty('methods');
  });

  it('method email for an app without email: login_method_unavailable, no popup params', async () => {
    const t = await tab();
    expect((await t.request('hana_login', { method: 'email' })).error?.code).toBe('login_method_unavailable');
  });
});

describe('an email login', () => {
  it('verifies the token on chain, derives `{scope}#email#{sub}#0` and never sends a linkJwt', async () => {
    const t = await tab(emailBrowser());
    const { reply } = await emailLogin(t);
    expect(reply.error).toBeUndefined();
    const path = `${SCOPE}#email#${EMAIL_SUB}#0`;
    expect((reply.result as { addresses: unknown }).addresses).toEqual(addressesOf(path));
    const body = t.browser.backend.calls.find((c) => c.path === '/v1/login')!.body as Record<string, unknown>;
    expect((body.jwt as string).startsWith('{"payload":')).toBe(true);
    expect(body).not.toHaveProperty('linkJwt');
    expect(body).not.toHaveProperty('linkImmediate');
    // The vault read the email keys and policy, and the scope's email client, from its own RPC.
    const views = t.browser.backend.rpcCalls.map((c) => c.params.method_name);
    expect(views).toEqual(expect.arrayContaining(['get_issuer_keys', 'get_self_issued', 'scope_for_client']));
  });

  it('a reload unlocks the email session from its record (the record check takes #email#)', async () => {
    const browser = emailBrowser();
    const t = await tab(browser);
    const { reply } = await emailLogin(t);
    const addresses = (reply.result as { addresses: unknown }).addresses;
    const second = await tab(browser);
    expect(await second.ready()).toMatchObject({ status: 'logged_in', addresses });
  });

  it('starts key export for an email wallet like a Google one (D246 lifted by batch 8b): the launcher opens /export', async () => {
    const t = await tab(emailBrowser());
    await emailLogin(t);
    void t.request('hana_export', { chain: 'stellar' });
    await waitLauncher(t, 'Export key in Hana');
    t.launcher.click();
    expect(t.opened.at(-1)?.url).toBe(`${ENV.authOrigin}/export`);
  });

  it.each([
    ['another issuer', { iss: 'https://evil.test/v1/email' }, 'token_invalid'],
    ['another scope', { aud: 'email:other' }, 'token_invalid'],
    ['another session', { nonce: 'n'.repeat(43) }, 'token_invalid'],
    ['an expired token', { exp: 1_700_000_000 }, 'token_invalid'],
    ['an address claim', { email: 'ada@example.com' }, 'token_invalid'],
  ])('refuses %s before any chain call', async (_, over, code) => {
    const t = await tab(emailBrowser());
    const { reply } = await emailLogin(t, undefined, over);
    expect(reply.error?.code).toBe(code);
    expect(t.browser.backend.count('/v1/login')).toBe(0);
  });

  it('a key the chain doesn’t hold yet is a “try again later”, an email token in a Google-only login is refused', async () => {
    const b = emailBrowser();
    b.backend.emailKeys = [];
    const t = await tab(b);
    expect((await emailLogin(t)).reply.error?.code).toBe('api_unavailable');
    const u = await tab();
    expect((await emailLogin(u)).reply.error?.code).toBe('token_invalid');
    expect(u.browser.backend.count('/v1/login')).toBe(0);
  });

  it.each([
    ['link_pending', 409, 'link_pending'],
    ['identity_linked', 409, 'login_method_unavailable'],
    ['token_stale', 401, 'token_invalid'],
    ['login_method_disabled', 403, 'login_method_unavailable'],
  ])('the API’s %s refusal ends the login with %s (batch 6’s final codes)', async (code, status, expected) => {
    const b = emailBrowser();
    b.backend.overrides.set('/v1/login', () => new Response(JSON.stringify({ error: 'refused', code, requestId: 'rq' }), { status }));
    const t = await tab(b);
    const { reply } = await emailLogin(t);
    expect(reply.error?.code).toBe(expected);
    if (code === 'identity_linked') expect(reply.error?.data).toMatchObject({ reason: 'identity_linked' });
  });

  it('the scope’s email client must be this scope on chain', async () => {
    const b = emailBrowser();
    b.backend.clientScopes.set(`email|email:${SCOPE}`, 'other');
    const t = await tab(b);
    expect((await emailLogin(t)).reply.error).toMatchObject({ code: 'config_mismatch', data: { reason: 'scope_mismatch' } });
  });

  it.each([
    ['email_cancelled', 'login_cancelled'],
    ['email_code_invalid', 'code_invalid'],
    ['email_challenge_expired', 'challenge_expired'],
    ['email_rate_limited', 'rate_limited'],
  ])('the email step’s cancel %s ends the login with %s (D245)', async (error, code) => {
    const t = await tab(emailBrowser());
    const pending = t.request('hana_login');
    const run = await popupHello(t);
    await t.browser.backend.writeRelay(run.params.relayId as string, run.params.relayKey as Uint8Array, { error });
    expect((await pending).error?.code).toBe(code);
  });

  it('in a Google-only login an email_ error is Google’s answer (google_error)', async () => {
    const t = await tab();
    const pending = t.request('hana_login');
    const run = await popupHello(t);
    await t.browser.backend.writeRelay(run.params.relayId as string, run.params.relayKey as Uint8Array, { error: 'email_code_invalid' });
    expect((await pending).error).toMatchObject({ code: 'google_error', data: { error: 'email_code_invalid' } });
  });
});

describe('hana:auth-progress', () => {
  it('reports email_code only from the popup whose hello it answered, only when email is offered', async () => {
    const t = await tab(emailBrowser());
    const pending = t.request('hana_login');
    const run = await popupHello(t);
    const progress = { v: 1, t: 'hana:auth-progress', stage: 'email_code' };
    t.dispatch({ data: progress, origin: ENV.authOrigin, source: new FakeWindow(`${ENV.authOrigin}/login/email`, 'other', '', t.parent) });
    t.dispatch({ data: progress, origin: 'https://evil.test', source: run.popup });
    t.dispatch({ data: progress, origin: ENV.authOrigin, source: run.popup });
    await deliverEmailToken(t, issuer, run);
    await pending;
    const stages = t.events.filter((e) => e.event === 'loginProgress').map((e) => (e.data as { stage: string }).stage);
    expect(stages.filter((s) => s === 'email_code')).toHaveLength(1);
    expect(stages.indexOf('email_code')).toBeLessThan(stages.indexOf('token'));

    // A Google-only app (token_first's record-only login, and second_request's batch B login): email isn't offered,
    // so the popup's email_code is ignored.
    for (const flow of ['token_first', 'second_request'] as const) {
      const u = await tab(new Browser(), { options: { googleEmailFlow: flow } });
      const p2 = u.request('hana_login');
      const run2 = await popupHello(u);
      u.dispatch({ data: progress, origin: ENV.authOrigin, source: run2.popup });
      await deliverToken(u, g, run2);
      expect((await p2).error, flow).toBeUndefined();
      expect(u.events.some((e) => e.event === 'loginProgress' && (e.data as { stage: string }).stage === 'email_code'), flow).toBe(false);
    }
  });
});

const stagesOf = (t: Tab) => t.events.filter((e) => e.event === 'loginProgress').map((e) => (e.data as { stage: string }).stage);

describe('google progress (only on the Google path)', () => {
  it('with email offered, `google` comes from the popup, once; `method: google` reports it itself and goes to google-match', async () => {
    const t = await tab(emailBrowser());
    const pending = t.request('hana_login');
    const run = await popupHello(t);
    await t.waitEvent('loginProgress');
    expect(stagesOf(t)).toEqual(['popup_connected']);
    const google = { v: 1, t: 'hana:auth-progress', stage: 'google' };
    t.dispatch({ data: google, origin: ENV.authOrigin, source: run.popup });
    t.dispatch({ data: google, origin: ENV.authOrigin, source: run.popup });
    await deliverToken(t, g, run);
    expect((await pending).error).toBeUndefined();
    expect(stagesOf(t).filter((s) => s === 'google')).toHaveLength(1);

    const u = await tab(emailBrowser());
    const p2 = u.request('hana_login', { method: 'google' });
    const run2 = await popupHello(u);
    await deliverToken(u, g, run2);
    expect((await p2).error).toBeUndefined();
    expect(stagesOf(u)).toContain('google');
    // Batch 8b: a Google login of an app with email may carry a link token, so the email keys are read too, and the
    // Google token goes to google-match first.
    const views = u.browser.backend.rpcCalls.map((c) => c.params.method_name);
    expect(views).toContain('get_issuer_keys');
    expect(u.browser.backend.matchCalls).toHaveLength(1);
  });

  it('a Google-only app reports `google` at connect, as before (token_first’s record-only login and second_request)', async () => {
    for (const flow of ['token_first', 'second_request'] as const) {
      const t = await tab(new Browser(), { options: { googleEmailFlow: flow } });
      await login(t, g);
      expect(stagesOf(t), flow).toEqual(['popup_connected', 'google', 'token', 'chain', 'done']);
    }
  });
});

describe('relay errors and the account root (L2, L6)', () => {
  it('email_unavailable ends the login with login_method_unavailable; inherited names are Google errors', async () => {
    for (const [error, code] of [
      ['email_unavailable', 'login_method_unavailable'],
      ['__proto__', 'google_error'],
      ['constructor', 'google_error'],
    ] as const) {
      const t = await tab(emailBrowser());
      const pending = t.request('hana_login');
      const run = await popupHello(t);
      await t.browser.backend.writeRelay(run.params.relayId as string, run.params.relayKey as Uint8Array, { error });
      expect((await pending).error?.code, error).toBe(code);
    }
  });

  it('a chain session on an account root’s path (a linked identity) is refused: derive_failed, never another key', async () => {
    const b = emailBrowser();
    const root = `${SCOPE}#google#${SUB}#0`;
    b.backend.overrides.set('/v1/login', (call) => {
      const body = call.body as { sessionPublicKey: number[]; expiresAtMs: number };
      b.backend.sessions.set(toHex(Uint8Array.from(body.sessionPublicKey)), { path: root, scope_id: SCOPE, expires_at_ms: body.expiresAtMs, max_uses: 1, used: 0 });
      return new Response(JSON.stringify({ error: 'exists', code: 'session_exists', requestId: 'rq' }), { status: 409 });
    });
    const t = await tab(b);
    expect((await emailLogin(t)).reply.error?.code).toBe('derive_failed');
    expect(t.browser.backend.count('/v1/derive')).toBe(0);
  });

  it('a CKD answer for the account root’s path fails the pairing check', async () => {
    const b = emailBrowser();
    b.backend.overrides.set('/v1/login', (call) => {
      const body = call.body as { pk1: string; expiresAtMs: number };
      const result = mpcAnswer(body.pk1, `${SCOPE}#google#${SUB}#0`);
      return new Response(JSON.stringify({ result, session: { scope_id: SCOPE, expires_at_ms: body.expiresAtMs, max_uses: 1, used: 1 }, nearTx: 'tx', requestId: 'rq' }), { status: 200 });
    });
    const t = await tab(b);
    expect((await emailLogin(t)).reply.error?.code).toBe('pairing_failed');
  });
});

describe('the email step’s deadline', () => {
  it('ends before the vault’s pending limit, allowing for the popup’s 15 s connect window', () => {
    expect(EMAIL_STEP_LIMIT_MS).toBe(LOGIN_PENDING_MS - 15_000);
  });
});

