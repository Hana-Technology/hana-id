import { describe, expect, it, vi, afterEach } from 'vitest';
import { HANA_CALLERS, checkCaller, isDevEnv, isLoopbackOrigin, originAllowed } from '../src/origins.ts';
import { ORIGIN, appHeaders, call, chain, newKey, seedApp, uid } from './helpers.ts';
import { AUTH, VAULT, hanaHeaders } from './login-helpers.ts';

afterEach(() => vi.restoreAllMocks());

const body = async (res: Response): Promise<Record<string, unknown>> => (await res.json()) as Record<string, unknown>;
const PROD = { ENV_NAME: 'prod' };

describe('isDevEnv', () => {
  it('is local* and sandbox* only, as in packages/env', () => {
    for (const name of ['local', 'local-dev', 'localhost', 'sandbox', 'sandbox-dev', 'sandbox2', 'sandbox-test']) expect(isDevEnv(name), name).toBe(true);
    for (const name of ['prod', 'staging', 'mainnet', 'dev-sandbox', 'my-local', 'test', '']) expect(isDevEnv(name), name).toBe(false);
  });
});

describe('originAllowed', () => {
  const test = { publishable_key: newKey('pk_test_'), origins: [ORIGIN, 'http://localhost:*', 'http://127.0.0.1:8080', 'https://app.localhost'] };
  const live = { ...test, publishable_key: newKey('pk_live_') };

  it('matches listed origins exactly', () => {
    for (const devEnv of [true, false]) {
      expect(originAllowed(test, ORIGIN, devEnv)).toBe(true);
      expect(originAllowed(live, ORIGIN, devEnv)).toBe(true);
      for (const o of [null, '', `${ORIGIN}/`, 'https://WALLET.example.com', 'http://wallet.example.com', 'https://evil.example']) expect(originAllowed(test, o, devEnv), String(o)).toBe(false);
    }
  });

  it('never treats the literal wildcard entry as an origin, for any key or env (APIV-7)', () => {
    for (const devEnv of [true, false]) {
      expect(originAllowed(test, 'http://localhost:*', devEnv)).toBe(false);
      expect(originAllowed(live, 'http://localhost:*', devEnv)).toBe(false);
    }
  });

  it('allows loopback origins, and http://localhost:* by wildcard, only for pk_test_ keys in dev envs', () => {
    for (const o of ['http://localhost:5173', 'http://127.0.0.1:8080', 'https://app.localhost']) {
      expect(originAllowed(test, o, true), o).toBe(true);
      expect(originAllowed(test, o, false), o).toBe(false);
      expect(originAllowed(live, o, true), o).toBe(false);
      expect(originAllowed(live, o, false), o).toBe(false);
    }
    // The wildcard covers http://localhost:<port> only.
    for (const o of ['http://127.0.0.1:5173', 'https://localhost:5173', 'http://localhost.evil.com', 'http://[::1]:3000']) expect(originAllowed(test, o, true), o).toBe(false);
  });

  it('knows loopback hosts as browsers do', () => {
    for (const o of ['http://localhost', 'http://localhost:3000', 'https://a.b.localhost:1', 'http://127.0.0.1', 'http://127.9.8.7:80', 'http://[::1]:8080']) expect(isLoopbackOrigin(o), o).toBe(true);
    for (const o of ['https://localhost.example', 'http://localhost.evil.com', 'https://128.0.0.1', 'https://example.com']) expect(isLoopbackOrigin(o), o).toBe(false);
  });
});

describe('checkCaller', () => {
  const env = { ENV_NAME: 'sandbox-x', VAULT_ORIGIN: VAULT, AUTH_ORIGIN: AUTH };
  const app = { publishable_key: newKey('pk_test_'), origins: [ORIGIN] };
  const headers = (h: Record<string, string>): Headers => new Headers(h);

  it('a Hana page acts for its parent; CORS echoes the page even when the parent is refused', () => {
    expect(checkCaller(env, app, '/v1/login', headers({ origin: VAULT, 'x-hana-parent-origin': ORIGIN }))).toEqual({ ok: true, cors: VAULT, page: 'vault', parentOrigin: ORIGIN });
    expect(checkCaller(env, app, '/v1/login', headers({ origin: VAULT, 'x-hana-parent-origin': 'https://evil.example' }))).toEqual({ ok: false, cors: VAULT, page: 'vault', parentOrigin: 'https://evil.example' });
    expect(checkCaller(env, app, '/v1/login', headers({ origin: AUTH }))).toMatchObject({ ok: false, cors: AUTH, parentOrigin: null });
  });

  it('a Hana page on an endpoint it doesn’t call is just an unlisted origin', () => {
    expect(checkCaller(env, app, '/v1/derive', headers({ origin: AUTH, 'x-hana-parent-origin': ORIGIN }))).toEqual({ ok: false, cors: null, page: null, parentOrigin: null });
    expect(checkCaller(env, app, '/v1/unknown', headers({ origin: VAULT, 'x-hana-parent-origin': ORIGIN }))).toMatchObject({ ok: false, cors: null });
  });

  it('unset Hana origins match nothing', () => {
    const bare = { ENV_NAME: 'sandbox-x', VAULT_ORIGIN: '', AUTH_ORIGIN: undefined };
    expect(checkCaller(bare, app, '/v1/login', headers({ origin: '', 'x-hana-parent-origin': ORIGIN }))).toMatchObject({ ok: false, page: null });
  });
});

describe('Origin × x-hana-parent-origin matrix (appGate)', () => {
  // Each endpoint as called with an empty body: past the gate it stops at validation (or, for GET /v1/app, answers).
  const ENDPOINTS = [
    { path: '/v1/app', method: 'GET' },
    { path: '/v1/login', method: 'POST' },
    { path: '/v1/sessions', method: 'POST' },
    { path: '/v1/derive', method: 'POST' },
    { path: '/v1/sessions/revoke', method: 'POST' },
  ] as const;
  const send = (path: string, method: string, headers: Record<string, string>, bindings?: Record<string, string>): Promise<Response> =>
    call(path, { method, headers, ...(method === 'POST' ? { body: {} } : {}), env: bindings });
  /** True when the request got past the origin check. */
  const passed = async (res: Response): Promise<boolean> => !(res.status === 403 && (await body(res)).code === 'origin_not_allowed');

  it('Hana origins: allowed, wildcard-matched, unlisted or missing parent, on each endpoint', async () => {
    chain({});
    const app = await seedApp({ origins: [ORIGIN, 'http://localhost:*'] });
    const parents: [string | null, boolean][] = [
      [ORIGIN, true],
      ['http://localhost:5173', true],
      ['https://unlisted.example', false],
      [null, false],
    ];
    for (const { path, method } of ENDPOINTS) {
      for (const [page, origin] of [['vault', VAULT], ['auth', AUTH]] as const) {
        const callsIt = HANA_CALLERS[path]!.includes(page);
        for (const [parent, listed] of parents) {
          const res = await send(path, method, hanaHeaders(app, origin, parent));
          expect(await passed(res), `${page} ${path} parent=${parent}`).toBe(callsIt && listed);
          expect(res.headers.get('access-control-allow-origin'), `${page} ${path}`).toBe(callsIt ? origin : null);
        }
      }
    }
    expect(HANA_CALLERS).toEqual({
      '/v1/app': ['vault', 'auth'],
      '/v1/login': ['vault', 'auth'],
      '/v1/sessions': ['vault'],
      '/v1/derive': ['vault'],
      '/v1/sessions/revoke': ['vault'],
    });
  });

  it('a wildcard-matched loopback parent counts only in dev envs', async () => {
    chain({});
    const app = await seedApp({ origins: ['http://localhost:*'] });
    expect(await passed(await send('/v1/login', 'POST', hanaHeaders(app, VAULT, 'http://localhost:5173')))).toBe(true);
    expect(await passed(await send('/v1/login', 'POST', hanaHeaders(app, VAULT, 'http://localhost:5173'), PROD))).toBe(false);
  });

  it('partner origins: GET /v1/app for both key types in every env; the session endpoints only for pk_test_ in dev envs', async () => {
    chain({});
    const test = await seedApp();
    const live = await seedApp({ key: newKey('pk_live_') });
    for (const { path, method } of ENDPOINTS) {
      for (const [app, isTest] of [[test, true], [live, false]] as const) {
        for (const dev of [true, false]) {
          const res = await send(path, method, appHeaders(app), dev ? undefined : PROD);
          const want = path === '/v1/app' || (path !== '/v1/login' && isTest && dev);
          expect(await passed(res), `${path} ${isTest ? 'pk_test_' : 'pk_live_'} ${dev ? 'dev' : 'prod'}`).toBe(want);
          expect(res.headers.get('access-control-allow-origin')).toBe(want ? ORIGIN : null);
        }
      }
    }
  });

  it('loopback partner origins are refused outside dev envs, for test keys too', async () => {
    chain({});
    const app = await seedApp({ origins: ['http://localhost:*', 'http://127.0.0.1:3000'] });
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:3000']) {
      expect(await passed(await send('/v1/sessions', 'POST', appHeaders(app, origin)))).toBe(true);
      expect(await passed(await send('/v1/app', 'GET', appHeaders(app, origin), PROD))).toBe(false);
    }
  });

  it('scope_conflict: a pk_test_ app on a scope a pk_live_ app uses is refused everywhere', async () => {
    chain({});
    const scope = `s${uid()}`;
    const testApp = await seedApp({ scope });
    const before = await send('/v1/sessions', 'POST', appHeaders(testApp));
    expect([before.status, (await body(before)).code]).toEqual([400, 'bad_request']);
    const liveApp = await seedApp({ scope, key: newKey('pk_live_') });
    for (const { path, method } of ENDPOINTS) {
      const res = await send(path, method, path === '/v1/app' ? appHeaders(testApp) : hanaHeaders(testApp));
      expect([res.status, (await body(res)).code], path).toEqual([403, 'scope_conflict']);
    }
    // The live app itself is unaffected, and so is a test app on another scope.
    expect(await body(await send('/v1/login', 'POST', hanaHeaders(liveApp)))).toMatchObject({ code: 'bad_request' });
    const other = await seedApp();
    expect(await body(await send('/v1/login', 'POST', hanaHeaders(other)))).toMatchObject({ code: 'bad_request' });
  });
});

describe('preflight', () => {
  const preflight = (path: string, origin: string, bindings?: Record<string, string>): Promise<Response> =>
    call(path, {
      method: 'OPTIONS',
      headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type, x-hana-key, x-hana-parent-origin, x-hana-relay-key' },
      env: bindings,
    });

  it('allows the two Hana origins (no app needed), with x-hana-parent-origin and x-hana-relay-key', async () => {
    for (const path of ['/v1/app', '/v1/login', '/v1/sessions', '/v1/derive', '/v1/sessions/revoke']) {
      for (const origin of [VAULT, AUTH]) {
        const res = await preflight(path, origin);
        expect(res.status, `${path} ${origin}`).toBe(204);
        expect(res.headers.get('access-control-allow-origin')).toBe(origin);
        const allowed = res.headers.get('access-control-allow-headers') ?? '';
        for (const h of ['content-type', 'x-hana-key', 'x-hana-parent-origin', 'x-hana-relay-key']) expect(allowed).toContain(h);
      }
    }
  });

  it('allows loopback origins only through pk_test_ apps in dev envs', async () => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    await seedApp({ origins: ['http://localhost:*'] });
    expect((await preflight('/v1/sessions', `http://localhost:${port}`)).status).toBe(204);
    expect((await preflight('/v1/sessions', `http://localhost:${port}`, PROD)).status).toBe(403);
    const other = `https://${uid()}.example.com`;
    await seedApp({ origins: [other] });
    expect((await preflight('/v1/app', other, PROD)).status).toBe(204);
  });
});
