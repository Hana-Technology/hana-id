// No Hana response sets a cookie (docs/security.md, "Hana origins host nothing else"): the API, the vault page and
// both page Workers, on success and error paths alike. A cookie on a Hana origin would be state the design never
// accounts for (and, on the auth domain, could reach other Hana sites). The Playwright suite checks the same on every
// response of every flow (apps/e2e/tests/fixtures.ts `noCookies`); packages/web/test/no-cookies.test.ts checks that no
// source sets one.
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.ts';
import authWorker from '../src/pages/auth-worker.ts';
import { AUTH_PAGE_PATHS, type AuthHostEnv, type VaultHostEnv } from '../src/pages/host.ts';
import vaultWorker from '../src/pages/vault-worker.ts';
import { ORIGIN, appHeaders, call, chain, seedApp, sessionBody, uid } from './helpers.ts';
import { AUTH, VAULT, hanaHeaders, loginBody, withCombinedCall } from './login-helpers.ts';

afterEach(() => vi.restoreAllMocks());

const noCookie = (res: Response, what: string): void => {
  expect(res.headers.get('set-cookie'), what).toBeNull();
  expect(res.headers.getSetCookie(), what).toEqual([]);
};

async function at(url: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(url, init) as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe('no Set-Cookie', () => {
  it('from the API: every endpoint, on success and on error, and preflights', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = await seedApp();
    const aud = `${uid()}.apps.googleusercontent.com`;
    withCombinedCall(chain({ [aud]: app.scope }));
    const responses: [string, Response][] = [
      ['health', await call('/v1/health')],
      ['app (partner)', await call('/v1/app', { method: 'GET', headers: appHeaders(app) })],
      ['app (vault)', await call('/v1/app', { method: 'GET', headers: hanaHeaders(app) })],
      ['app (unknown key)', await call('/v1/app', { method: 'GET', headers: { 'x-hana-key': 'pk_test_1111111111111111111111', origin: ORIGIN } })],
      ['login', await call('/v1/login', { headers: hanaHeaders(app), body: await loginBody(app.scope, aud) })],
      ['login (export)', await call('/v1/login', { headers: hanaHeaders(app, AUTH), body: await loginBody(app.scope, aud) })],
      ['login (bad body)', await call('/v1/login', { headers: hanaHeaders(app), body: {} })],
      ['sessions', await call('/v1/sessions', { headers: appHeaders(app), body: await sessionBody(app.scope, aud) })],
      ['derive (bad body)', await call('/v1/derive', { headers: appHeaders(app), body: {} })],
      ['revoke (bad body)', await call('/v1/sessions/revoke', { headers: appHeaders(app), body: {} })],
      ['vault shares (bad body)', await call('/v1/vault/shares', { headers: hanaHeaders(app), body: {} })],
      ['vault unlock (bad body)', await call('/v1/vault/unlock', { headers: hanaHeaders(app), body: {} })],
      ['vault touch (bad body)', await call('/v1/vault/touch', { headers: hanaHeaders(app), body: {} })],
      ['vault revoke (bad body)', await call('/v1/vault/revoke', { headers: hanaHeaders(app), body: {} })],
      ['vault revoke-all (bad body)', await call('/v1/vault/revoke-all', { headers: hanaHeaders(app), body: {} })],
      ['relay write', await call(`/v1/login-relay/${'A'.repeat(43)}`, { headers: { origin: AUTH }, body: { iv: 'x', ct: 'y' } })],
      ['relay read', await call(`/v1/login-relay/${'A'.repeat(43)}?wait=0`, { method: 'GET', headers: { origin: VAULT, 'x-hana-relay-key': 'A'.repeat(43) } })],
      ['owner actions (bad body)', await call('/v1/owner-actions', { body: {} })],
      ['unknown path', await call('/v1/nope')],
      ['wrong method', await call('/v1/sessions')],
      ['preflight (partner)', await call('/v1/sessions', { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'POST' } })],
      ['preflight (vault)', await call('/v1/vault/unlock', { method: 'OPTIONS', headers: { origin: VAULT, 'access-control-request-method': 'POST' } })],
    ];
    for (const [what, res] of responses) noCookie(res, what);
    // The sweep reached real handlers, not only the router.
    expect(responses.find(([w]) => w === 'login')![1].status).toBe(200);
    expect(responses.find(([w]) => w === 'app (partner)')![1].status).toBe(200);
  });

  it('from the vault page the API renders, and from any other path on a Hana origin', async () => {
    const app = await seedApp();
    for (const [what, url] of [
      ['vault page', `${VAULT}/vault?pk=${encodeURIComponent(app.key)}`],
      ['vault page (unknown app)', `${VAULT}/vault?pk=pk_test_1111111111111111111111`],
      ['vault page (no key)', `${VAULT}/vault`],
      ['other path on the vault origin', `${VAULT}/v1/app`],
      ['any path on the auth origin', `${AUTH}/login`],
    ] as const) {
      const res = await at(url);
      noCookie(res, what);
      if (what === 'vault page') expect(res.status).toBe(200);
    }
  });

  it('from both page Workers: every page, an asset, a missing path and a wrong method', async () => {
    const files: Record<string, string> = {
      '/login.html': '<!doctype html>',
      '/login/callback.html': '<!doctype html>',
      '/approve.html': '<!doctype html>',
      '/export.html': '<!doctype html>',
      '/vault.js': 'export {}',
    };
    // Bindings that would set a cookie if a Worker passed their headers through: none may reach the browser.
    const cookieHeaders = { 'set-cookie': 'sid=1; Path=/' };
    const assets = {
      fetch: async (input: RequestInfo | URL) => {
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
        const body = files[path];
        return body === undefined ? new Response('missing', { status: 404, headers: cookieHeaders }) : new Response(body, { headers: { 'content-type': path.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8', ...cookieHeaders } });
      },
      connect: () => {
        throw new Error('not used');
      },
    } as unknown as Fetcher;
    const api = { fetch: async () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html; charset=utf-8', ...cookieHeaders } }), connect: assets.connect } as unknown as Fetcher;
    const authEnv: AuthHostEnv = { AUTH_ORIGIN: AUTH, API_URL: 'https://api.test', NEAR_RPC: 'https://rpc.test', ASSETS: assets };
    const vaultEnv: VaultHostEnv = { VAULT_ORIGIN: VAULT, ASSETS: assets, API: api };
    type W<E> = { fetch: (r: Request, e: E) => Response | Promise<Response> };
    for (const path of [...AUTH_PAGE_PATHS, '/vault.js', '/missing']) noCookie(await (authWorker as unknown as W<AuthHostEnv>).fetch(new Request(`${AUTH}${path}`), authEnv), `auth ${path}`);
    noCookie(await (authWorker as unknown as W<AuthHostEnv>).fetch(new Request(`${AUTH}/login`, { method: 'POST' }), authEnv), 'auth POST');
    for (const path of ['/vault?pk=pk_test_1111111111111111111111', '/vault.js', '/missing']) noCookie(await (vaultWorker as unknown as W<VaultHostEnv>).fetch(new Request(`${VAULT}${path}`), vaultEnv), `vault ${path}`);
  });
});
