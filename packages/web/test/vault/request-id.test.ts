// D405: the Hana API's request ID in the vault's port errors. An error that came from an API answer (a refusal, or a
// recovery that gave up after one) carries that answer's `requestId` as `data.requestId`, only in its exact shape and
// only for an SDK whose hello names API_REQUEST_ID_SDK_MIN or later; an error that never reached the API (a check in the
// vault, a cancel, a network failure) carries none, and an older SDK gets exactly the error shapes it knows.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { API_REQUEST_ID_SDK_MIN } from '@hana-id/core';
import { Browser, type Google, type Tab, apiError, google, login, makeConfig, popupHello, readyTab } from './harness.ts';

const NEW_SDK = API_REQUEST_ID_SDK_MIN;
/** As apps/api makes them: a cf-ray, or a random UUID. */
const RAY = '8d1f2c3a4b5e6f70-SIN';
const UUID = '3f2a9c1e-7b4d-4e8f-9a6b-0c1d2e3f4a5b';

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
  const t = await readyTab(browser, { googleJwk: g.jwk, sdk: NEW_SDK, ...o });
  tabs.push(t);
  return t;
}

/** A refusal with this request ID (the harness's own is `rq`, which isn't one). */
const refusal = (status: number, code: string, requestId: unknown, extra: Record<string, unknown> = {}) => apiError(status, code, { ...extra, requestId });

describe('an error from an API answer carries its request ID', () => {
  it('GET /v1/app refused at a login: no_google_client with data.requestId', async () => {
    const browser = new Browser();
    browser.backend.overrides.set('/v1/app', () => refusal(409, 'no_google_client', RAY));
    const t = await tab(browser);
    expect((await t.request('hana_login')).error).toEqual({ code: 'no_google_client', message: 'This app has no usable Google client', data: { requestId: RAY } });
  });

  it('/v1/login refused: the code’s own data stays beside the request ID', async () => {
    const browser = new Browser();
    browser.backend.overrides.set('/v1/login', () => refusal(401, 'invalid_token', UUID));
    const t = await tab(browser);
    expect((await login(t, g)).reply.error).toEqual({ code: 'token_invalid', message: 'The Google token was refused', data: { api: '401 invalid_token', requestId: UUID } });
  });

  it('a not-executed /v1/login resent once and refused again: api_unavailable with the second answer’s ID', async () => {
    const browser = new Browser();
    let n = 0;
    browser.backend.overrides.set('/v1/login', () => refusal(503, 'relayer_busy', `${RAY.slice(0, -4)}-AM${++n}`, { nearTx: null }));
    const t = await tab(browser);
    const { reply } = await login(t, g);
    expect(browser.backend.count('/v1/login')).toBe(2);
    expect(reply.error).toMatchObject({ code: 'api_unavailable', data: { requestId: `${RAY.slice(0, -4)}-AM2` } });
  });

  it('a recovery that gave up after a refusal: session_consumed with the refusal’s ID', async () => {
    const browser = new Browser();
    browser.backend.overrides.set('/v1/login', (call) => {
      browser.backend.createSession(call.body as Record<string, unknown>, true);
      return refusal(422, 'contract_rejected', UUID, { reason: 'session_key_in_use', nearTx: null });
    });
    const t = await tab(browser);
    const { reply } = await login(t, g);
    expect(reply.error).toMatchObject({ code: 'session_consumed', data: { requestId: UUID } });
  });

  it('the split flow: /v1/sessions refused, and a refused /v1/derive after a good /v1/sessions', async () => {
    const browser = new Browser();
    browser.backend.overrides.set('/v1/sessions', () => refusal(401, 'invalid_token', RAY));
    const t = await tab(browser, { loginFlow: 'split' });
    expect((await login(t, g)).reply.error).toMatchObject({ code: 'token_invalid', data: { requestId: RAY } });

    const b2 = new Browser();
    b2.backend.overrides.set('/v1/derive', () => refusal(409, 'bad_counter', UUID));
    const t2 = await tab(b2, { loginFlow: 'split' });
    expect((await login(t2, g)).reply.error).toEqual({ code: 'derive_failed', message: 'The key derivation was refused', data: { api: '409 bad_counter', requestId: UUID } });
  });

  it('hana_identityToken refused: session_ended, rate_limited and identity_unavailable each with the ID', async () => {
    const browser = new Browser();
    const t = await tab(browser);
    await login(t, g);
    browser.backend.overrides.set('/v1/identity/token', () => refusal(429, 'rate_limited', RAY));
    expect((await t.request('hana_identityToken')).error).toEqual({ code: 'rate_limited', message: 'Too many identity token requests, try again later', data: { requestId: RAY } });
    browser.backend.overrides.set('/v1/identity/token', () => refusal(503, 'identity_signer_unavailable', UUID));
    expect((await t.request('hana_identityToken')).error).toMatchObject({ code: 'identity_unavailable', data: { api: '503 identity_signer_unavailable', requestId: UUID } });
    // The share revoked (D695): the reason beside the ID.
    browser.backend.overrides.set('/v1/identity/token', () => refusal(410, 'session_ended', RAY, { reason: 'share_revoked' }));
    expect((await t.request('hana_identityToken')).error).toEqual({ code: 'session_ended', message: 'The Hana session has ended', data: { reason: 'signed_out', requestId: RAY } });
  });

  it('hana_revokeOtherDevices on a share the API says is gone: 4900 with the ID', async () => {
    const browser = new Browser();
    const t = await tab(browser);
    await login(t, g);
    browser.backend.overrides.set('/v1/vault/revoke-all', () => refusal(410, 'share_revoked', UUID));
    expect((await t.request('hana_revokeOtherDevices')).error).toEqual({ code: 4900, message: 'This session was revoked', data: { reason: 'signed_out', requestId: UUID } });
  });

  it('hana_revokeOtherDevices on a share the API says expired: 4900 with the ID and no reason (D695: not a sign-out)', async () => {
    const browser = new Browser();
    const t = await tab(browser);
    await login(t, g);
    browser.backend.overrides.set('/v1/vault/revoke-all', () => refusal(410, 'share_expired', UUID));
    expect((await t.request('hana_revokeOtherDevices')).error).toEqual({ code: 4900, message: 'This session was revoked', data: { requestId: UUID } });
  });

  it('the login relay’s read refused (410): token_invalid with the ID', async () => {
    const browser = new Browser();
    const t = await tab(browser);
    const pending = t.request('hana_login');
    const run = await popupHello(t);
    browser.backend.overrides.set(`/v1/login-relay/${run.params.relayId as string}`, () => refusal(410, 'relay_gone', RAY));
    expect((await pending).error).toEqual({ code: 'token_invalid', message: 'The sign-in answer is gone', data: { requestId: RAY } });
  });
});

describe('only a request ID, and only from the API', () => {
  for (const bad of ['rq', 'short12', 'a'.repeat(65), 'has_underscore_1', `${RAY} `, `${RAY}\n`, 'eyJhbGciOi.eyJzdWIi.sig', 42, null, { id: RAY }, [RAY]]) {
    it(`a requestId of ${JSON.stringify(bad)} from the API is dropped; the error is otherwise the same`, async () => {
      const browser = new Browser();
      browser.backend.overrides.set('/v1/app', () => refusal(409, 'no_google_client', bad));
      const t = await tab(browser);
      expect((await t.request('hana_login')).error).toEqual({ code: 'no_google_client', message: 'This app has no usable Google client' });
    });
  }

  it('nothing but the request ID crosses from the API body (its message, other fields stay out)', async () => {
    const browser = new Browser();
    browser.backend.overrides.set('/v1/app', () => refusal(409, 'no_google_client', RAY, { error: 'secret-ish detail', extra: 'x', data: { claim: 'email' } }));
    const t = await tab(browser);
    const { error } = await t.request('hana_login');
    expect(error).toEqual({ code: 'no_google_client', message: 'This app has no usable Google client', data: { requestId: RAY } });
  });

  it('a network failure never reached an answer: no request ID', async () => {
    const browser = new Browser();
    browser.backend.overrides.set('/v1/app', () => Promise.reject(new TypeError('Failed to fetch')));
    const t = await tab(browser);
    expect((await t.request('hana_login')).error).toEqual({ code: 'api_unavailable', message: 'Could not read the app configuration' });

    const b2 = new Browser();
    const t2 = await tab(b2);
    await login(t2, g);
    b2.backend.overrides.set('/v1/identity/token', () => Promise.reject(new TypeError('Failed to fetch')));
    expect((await t2.request('hana_identityToken')).error).toEqual({ code: 'identity_unavailable', message: 'Identity tokens are unavailable, try again later' });
  });

  it('a check in the vault and a cancel: no request ID, even after an API refusal earlier in the tab', async () => {
    const browser = new Browser();
    const t = await tab(browser, { config: makeConfig({ settings: { persistence: 'none' } }) });
    expect((await t.request('hana_revokeOtherDevices')).error).toEqual({ code: 4100, message: 'Not logged in' });
    await login(t, g);
    browser.backend.overrides.set('/v1/identity/token', () => refusal(429, 'rate_limited', RAY));
    expect((await t.request('hana_identityToken')).error).toMatchObject({ data: { requestId: RAY } });
    expect((await t.request('hana_revokeOtherDevices')).error).toEqual({ code: 4100, message: 'This app does not keep the wallet across reloads', data: { reason: 'persistence_off' } });
    const pending = t.request('hana_login');
    await popupHello(t);
    await t.request('hana_cancelLogin');
    expect((await pending).error).toEqual({ code: 'login_cancelled', message: 'The sign-in was cancelled' });
  });
});

describe('an SDK before the field', () => {
  for (const sdk of ['0.1.0', '0.0.0', '0.2.0-rc.1', 'dev']) {
    it(`sdk ${sdk}: the same refusals answer exactly the old error shapes`, async () => {
      const browser = new Browser();
      browser.backend.overrides.set('/v1/app', () => refusal(409, 'no_google_client', RAY));
      const t = await tab(browser, { sdk });
      expect((await t.request('hana_login')).error).toEqual({ code: 'no_google_client', message: 'This app has no usable Google client' });

      const b2 = new Browser();
      b2.backend.overrides.set('/v1/login', () => refusal(401, 'invalid_token', UUID));
      const t2 = await tab(b2, { sdk });
      expect((await login(t2, g)).reply.error).toEqual({ code: 'token_invalid', message: 'The Google token was refused', data: { api: '401 invalid_token' } });
    });
  }

  it('a later SDK (1.0.0) gets it too', async () => {
    const browser = new Browser();
    browser.backend.overrides.set('/v1/app', () => refusal(409, 'no_google_client', RAY));
    const t = await tab(browser, { sdk: '1.0.0' });
    expect((await t.request('hana_login')).error?.data).toEqual({ requestId: RAY });
  });
});
