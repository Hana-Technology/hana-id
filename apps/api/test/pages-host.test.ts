// The thin Workers of the two Hana page origins (src/pages/host.ts), with fake asset and API bindings, and the vault
// Worker in front of the real API Worker.
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import apiWorker from '../src/index.ts';
import authWorker from '../src/pages/auth-worker.ts';
import { AUTH_PAGE_PATHS, type AuthHostEnv, type VaultHostEnv } from '../src/pages/host.ts';
import vaultWorker from '../src/pages/vault-worker.ts';
import { ORIGIN, chain, seedApp } from './helpers.ts';

afterEach(() => vi.restoreAllMocks());

const VAULT = 'https://vault.test';
const AUTH = 'https://auth.test';
const BASE = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'";

/** A static-assets binding over an in-memory file map, recording every path asked for. */
function assets(files: Record<string, { body: string; type: string; headers?: Record<string, string> }>): Fetcher & { paths: string[] } {
  const paths: string[] = [];
  const fetcher = {
    paths,
    fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      const { pathname } = new URL(request.url);
      paths.push(pathname);
      const file = files[pathname];
      if (!file) return new Response('missing', { status: 404 });
      const etag = `"${pathname}"`;
      if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag } });
      const headers = { 'content-type': file.type, etag, 'cache-control': 'public, max-age=0, must-revalidate', ...file.headers };
      return new Response(request.method === 'HEAD' ? null : file.body, { headers });
    },
    connect: () => {
      throw new Error('not used');
    },
  };
  return fetcher as unknown as Fetcher & { paths: string[] };
}

const PAGE_FILES = {
  '/login.html': { body: '<!doctype html><title>login</title>', type: 'text/html; charset=utf-8' },
  '/login/callback.html': { body: '<!doctype html><title>callback</title>', type: 'text/html; charset=utf-8' },
  // A build's own header (here COOP) must not reach the page: the auth pages send no COOP.
  '/approve.html': { body: '<!doctype html><title>approve</title>', type: 'text/html; charset=utf-8', headers: { 'cross-origin-opener-policy': 'same-origin' } },
  '/export.html': { body: '<!doctype html><title>export</title>', type: 'text/html; charset=utf-8' },
  '/login.js': { body: 'export {}', type: 'text/javascript' },
  '/style.css': { body: 'body{}', type: 'text/css' },
};

function authEnv(overrides: Partial<AuthHostEnv> = {}): AuthHostEnv & { ASSETS: Fetcher & { paths: string[] } } {
  return { AUTH_ORIGIN: AUTH, API_URL: 'https://api.test/', NEAR_RPC: 'https://rpc.test/path', ASSETS: assets(PAGE_FILES), ...overrides } as AuthHostEnv & {
    ASSETS: Fetcher & { paths: string[] };
  };
}

/** A fake API Worker: records what it receives and answers like vault/page.ts. */
function apiBinding(handler?: (request: Request) => Promise<Response>): Fetcher & { requests: Request[] } {
  const requests: Request[] = [];
  const fetcher = {
    requests,
    fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      requests.push(request);
      if (handler) return handler(request);
      return new Response('<!doctype html><script type="application/json" id="hana-config">{}</script>', {
        headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': `${BASE}; frame-ancestors https://partner.example`, 'x-request-id': 'r1' },
      });
    },
    connect: () => {
      throw new Error('not used');
    },
  };
  return fetcher as unknown as Fetcher & { requests: Request[] };
}

function vaultEnv(overrides: Partial<VaultHostEnv> = {}): VaultHostEnv & { API: Fetcher & { requests: Request[] }; ASSETS: Fetcher & { paths: string[] } } {
  return {
    VAULT_ORIGIN: VAULT,
    ASSETS: assets({ '/vault.js': { body: 'export {}', type: 'text/javascript' }, '/vault.html': { body: '<!doctype html>', type: 'text/html' } }),
    API: apiBinding(),
    ...overrides,
  } as VaultHostEnv & { API: Fetcher & { requests: Request[] }; ASSETS: Fetcher & { paths: string[] } };
}

type Handler<E> = { fetch: (request: Request, env: E) => Response | Promise<Response> };
const call = <E>(worker: unknown, env: E, url: string, init?: RequestInit): Promise<Response> => Promise.resolve((worker as Handler<E>).fetch(new Request(url, init), env));

const csp = (res: Response): string => res.headers.get('content-security-policy') ?? '';

function expectPageBasics(res: Response): void {
  expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(csp(res).startsWith(`${BASE}; `)).toBe(true);
}

describe('auth origin Worker', () => {
  it('serves each page from <route>.html with its full CSP and headers, and no COOP', async () => {
    const expected: Record<string, string> = {
      '/login': `${BASE}; frame-ancestors 'none'; connect-src https://api.test`,
      '/login/callback': `${BASE}; frame-ancestors 'none'; connect-src https://api.test`,
      '/approve': `${BASE}; frame-ancestors 'none'`,
      '/export': `${BASE}; frame-ancestors 'none'; connect-src https://api.test https://rpc.test https://www.googleapis.com`,
    };
    expect(Object.keys(expected)).toEqual([...AUTH_PAGE_PATHS]);
    for (const path of AUTH_PAGE_PATHS) {
      const env = authEnv();
      const res = await call(authWorker, env, `${AUTH}${path}?x=1`);
      expect(res.status).toBe(200);
      expectPageBasics(res);
      expect(csp(res)).toBe(expected[path]);
      // No COOP header (unsafe-none), even when the build's file carried one; no cross-origin CORP on a top-level page.
      expect(res.headers.get('cross-origin-opener-policy')).toBeNull();
      expect(res.headers.get('cross-origin-resource-policy')).toBeNull();
      expect(res.headers.get('etag')).toBeNull();
      expect(await res.text()).toBe(PAGE_FILES[`${path}.html` as keyof typeof PAGE_FILES].body);
      expect(env.ASSETS.paths).toEqual([`${path}.html`]);
    }
  });

  it('HEAD gives the page headers and no body', async () => {
    const res = await call(authWorker, authEnv(), `${AUTH}/login`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expectPageBasics(res);
    expect(await res.text()).toBe('');
  });

  it('never serves an HTML file under its own name, or a route with a trailing slash', async () => {
    for (const path of ['/login.html', '/login/callback.html', '/APPROVE.HTML', '/export.html', '/login/', '/']) {
      const env = authEnv();
      const res = await call(authWorker, env, `${AUTH}${path}`);
      expect(res.status, path).toBe(404);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(csp(res)).toContain("frame-ancestors 'none'");
    }
  });

  it('refuses an asset the binding serves as HTML under another name', async () => {
    const env = authEnv({ ASSETS: assets({ '/page': { body: '<!doctype html>', type: 'text/html' } }) });
    expect((await call(authWorker, env, `${AUTH}/page`)).status).toBe(404);
  });

  it('serves scripts and styles as the binding has them, plus nosniff, no-referrer and same-origin CORP', async () => {
    const env = authEnv();
    const res = await call(authWorker, env, `${AUTH}/login.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/javascript');
    expect(res.headers.get('etag')).toBe('"/login.js"');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(await res.text()).toBe('export {}');
    // A revalidation keeps working.
    const again = await call(authWorker, env, `${AUTH}/login.js`, { headers: { 'if-none-match': '"/login.js"' } });
    expect(again.status).toBe(304);
    expect((await call(authWorker, env, `${AUTH}/style.css`)).headers.get('content-type')).toBe('text/css');
  });

  it('404s an unknown path, without a body on HEAD', async () => {
    expect((await call(authWorker, authEnv(), `${AUTH}/nope.js`)).status).toBe(404);
    const head = await call(authWorker, authEnv(), `${AUTH}/nope.js`, { method: 'HEAD' });
    expect(head.status).toBe(404);
    expect(await head.text()).toBe('');
  });

  it('answers only on AUTH_ORIGIN (not a preview URL or another host)', async () => {
    for (const url of ['https://abc123-auth.example.workers.dev/login', 'http://auth.test/login', 'https://auth.test:8443/login', `${VAULT}/login`]) {
      const env = authEnv();
      const res = await call(authWorker, env, url);
      expect(res.status, url).toBe(404);
      expect(env.ASSETS.paths).toEqual([]);
    }
  });

  it('allows only GET and HEAD', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      const res = await call(authWorker, authEnv(), `${AUTH}/login`, { method });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('GET, HEAD');
    }
  });

  it('503 when a page file is missing from the build, or the CSP origins are misconfigured', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const missing = await call(authWorker, authEnv({ ASSETS: assets({}) }), `${AUTH}/approve`);
    expect(missing.status).toBe(503);
    expect(csp(missing)).toBe(`${BASE}; frame-ancestors 'none'`);
    for (const bad of [{ API_URL: 'not a url' }, { NEAR_RPC: '' }]) {
      const res = await call(authWorker, authEnv(bad), `${AUTH}/login`);
      expect(res.status).toBe(503);
      expect(csp(res)).not.toContain('connect-src');
    }
    expect(errors).toHaveBeenCalledTimes(3);
  });
});

describe('vault origin Worker', () => {
  it('forwards GET /vault to the API Worker unchanged and returns its response as is', async () => {
    const env = vaultEnv();
    const res = await call(vaultWorker, env, `${VAULT}/vault?pk=pk_test_abc`);
    expect(res.status).toBe(200);
    expect(csp(res)).toBe(`${BASE}; frame-ancestors https://partner.example`);
    expect(res.headers.get('x-request-id')).toBe('r1');
    expect(await res.text()).toContain('id="hana-config"');
    expect(env.API.requests).toHaveLength(1);
    // The API sees the vault origin in the URL (vault/page.ts serves /vault only there) and the query untouched.
    expect(env.API.requests[0]!.url).toBe(`${VAULT}/vault?pk=pk_test_abc`);
    expect(env.API.requests[0]!.method).toBe('GET');
    expect(env.ASSETS.paths).toEqual([]);
  });

  it('forwards HEAD /vault too', async () => {
    const env = vaultEnv();
    await call(vaultWorker, env, `${VAULT}/vault?pk=pk_test_abc`, { method: 'HEAD' });
    expect(env.API.requests.map((r) => r.method)).toEqual(['HEAD']);
  });

  it('keeps the API status (403 unknown app) and serves a 503 page with no config when the API is unreachable', async () => {
    const env = vaultEnv({ API: apiBinding(async () => new Response('<!doctype html>', { status: 403 })) });
    expect((await call(vaultWorker, env, `${VAULT}/vault?pk=pk_test_x`)).status).toBe(403);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const down = vaultEnv({ API: apiBinding(async () => Promise.reject(new Error('service binding failed'))) });
    const res = await call(vaultWorker, down, `${VAULT}/vault?pk=pk_test_x`);
    expect(res.status).toBe(503);
    expectPageBasics(res);
    expect(csp(res)).toBe(`${BASE}; frame-ancestors 'none'`);
    expect(await res.text()).not.toContain('hana-config');
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it('serves the vault bundle as a static asset', async () => {
    const env = vaultEnv();
    const res = await call(vaultWorker, env, `${VAULT}/vault.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/javascript');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(env.API.requests).toEqual([]);
  });

  it('never forwards anything but /vault to the API (so the vault origin is not the API)', async () => {
    for (const path of ['/v1/app', '/v1/vault/unlock', '/v1/login', '/v1/login-relay/x', '/vault/', '/vault.html', '/', '/Vault']) {
      const env = vaultEnv();
      const res = await call(vaultWorker, env, `${VAULT}${path}`);
      expect(res.status, path).toBe(404);
      expect(env.API.requests).toEqual([]);
    }
  });

  it('refuses other methods, even on /vault, without reaching the API', async () => {
    for (const method of ['POST', 'OPTIONS', 'DELETE']) {
      const env = vaultEnv();
      const res = await call(vaultWorker, env, `${VAULT}/vault?pk=pk_test_abc`, { method });
      expect(res.status).toBe(405);
      expect(env.API.requests).toEqual([]);
    }
  });

  it('answers only on VAULT_ORIGIN', async () => {
    for (const url of ['https://abc123-vault.example.workers.dev/vault?pk=pk_test_abc', `${AUTH}/vault?pk=pk_test_abc`, 'http://vault.test/vault.js']) {
      const env = vaultEnv();
      expect((await call(vaultWorker, env, url)).status, url).toBe(404);
      expect(env.API.requests).toEqual([]);
      expect(env.ASSETS.paths).toEqual([]);
    }
  });

  it('through the real API Worker: the vault page is rendered from D1 for the vault origin', async () => {
    expect(env.VAULT_ORIGIN).toBe(VAULT);
    const near = chain();
    const app = await seedApp({ origins: [ORIGIN] });
    // The service binding: the API Worker's own fetch handler, with the test bindings.
    const api = apiBinding(async (request) => {
      const ctx = createExecutionContext();
      const res = await apiWorker.fetch(request as Request<unknown, IncomingRequestCfProperties>, env, ctx);
      await waitOnExecutionContext(ctx);
      return res;
    });
    const res = await call(vaultWorker, vaultEnv({ API: api }), `${VAULT}/vault?pk=${app.key}`);
    expect(res.status).toBe(200);
    expect(csp(res)).toContain(`frame-ancestors ${ORIGIN};`);
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    const html = await res.text();
    expect(html).toContain('<script type="application/json" id="hana-config">');
    expect(html).toContain(`"publishableKey":"${app.key}"`);
    expect(html).toContain('<script type="module" src="/vault.js"></script>');
    // D1 only: rendering reads no chain.
    expect(near.rpcMethods).toEqual([]);
    const unknown = await call(vaultWorker, vaultEnv({ API: api }), `${VAULT}/vault?pk=pk_test_${'1'.repeat(24)}`);
    expect(unknown.status).toBe(403);
    expect(await unknown.text()).not.toContain('hana-config');
  });
});
