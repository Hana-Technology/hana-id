// Email login, vault side (build plan batch 8a): the offer in auth-params (only for an app with email, in an env with
// an email issuer), the email token's check against the chain, the `{scope}#email#{sub}#0` path, the email step's
// cancel codes, the progress message, the record check and the export refusal; and the golden Google path.
import { addressesFromCkdSecret, ckdAppId, decryptCkd, newAppKey } from '@hana-id/core';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { isOwnLoginPath, loginPath } from '../../src/vault/login.ts';
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
  it('a Google-only app’s auth-params are batch B’s, key for key', async () => {
    const t = await tab();
    const { run } = await login(t, g);
    expect(Object.keys(run.params).sort()).toEqual(
      ['v', 't', 'pk', 'appName', 'parentOrigin', 'scopeId', 'signer', 'clientId', 'mode', 'sessionPublicKey', 'expiresAtMs', 'salt', 'keyIndex', 'maxUses', 'nonce', 'relayId', 'relayKey'].sort(),
    );
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

  it('refuses key export for an email wallet (later, D246)', async () => {
    const t = await tab(emailBrowser());
    await emailLogin(t);
    const r = await t.request('hana_export', { chain: 'stellar' });
    expect(r.error).toMatchObject({ code: 4200, data: { reason: 'email_export' } });
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

    const u = await tab();
    const p2 = u.request('hana_login');
    const run2 = await popupHello(u);
    u.dispatch({ data: progress, origin: ENV.authOrigin, source: run2.popup });
    await deliverToken(u, g, run2);
    expect((await p2).error).toBeUndefined();
    expect(u.events.some((e) => e.event === 'loginProgress' && (e.data as { stage: string }).stage === 'email_code')).toBe(false);
  });
});
