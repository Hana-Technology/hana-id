// The thin auth-origin Worker (docs/batch-c-spec.md "Tests: Topology and config"): it serves only GET /start and GET
// /callback on its own host, forwarding each request unchanged to the console's AuthHandler; every other path, method
// or host is 404 with no script and never reaches the console; every response has the auth origin's headers, whatever
// the console sent; and its config has no secret, D1 or Hyperdrive.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Manifest } from '@hana-id/env';
import { BUILD_PATH, BUILD_VAR } from '@hana-id/env/build-id';
import { describe, expect, it } from 'vitest';
import { AUTH_ORIGIN_CSP as CONSOLE_AUTH_ORIGIN_CSP } from '../../console/src/auth-flow.ts';
import { TEST_MANIFEST } from '../../console/scripts/gen-wrangler.ts';
import { main, wranglerConfig } from '../scripts/gen-wrangler.ts';
import worker, { AUTH_ORIGIN_CSP, AUTH_ORIGIN_HEADERS, type Env } from '../src/index.ts';

const AUTH = 'https://console-auth.test';

function fakeConsole(answer: () => Response | Promise<Response> = () => new Response(null, { status: 303, headers: { location: 'https://accounts.google.com/x', 'content-security-policy': "default-src *", 'cache-control': 'public' } })) {
  const seen: Request[] = [];
  const env: Env = {
    AUTH_ORIGIN: AUTH,
    CONSOLE: {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(input instanceof Request ? input : new Request(input, init));
        return answer();
      },
      connect: () => {
        throw new Error('unused');
      },
    } as unknown as Fetcher,
  };
  return { env, seen };
}

const call = (env: Env, url: string, init: RequestInit = {}) => worker.fetch(new Request(url, init) as Request<unknown, IncomingRequestCfProperties>, env);

function expectAuthHeaders(res: Response) {
  for (const [k, v] of Object.entries(AUTH_ORIGIN_HEADERS)) expect(res.headers.get(k), k).toBe(v);
}

describe('console-auth', () => {
  it('forwards GET /start and GET /callback unchanged (URL, query, cookies) to AuthHandler', async () => {
    const { env, seen } = fakeConsole();
    for (const path of ['/start?f=abc', '/callback?code=c&state=s']) {
      const res = await call(env, `${AUTH}${path}`, { headers: { cookie: '__Host-hana_af=v', 'cf-connecting-ip': '203.0.113.9' } });
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('https://accounts.google.com/x');
      expectAuthHeaders(res);
    }
    expect(seen.map((r) => r.url)).toEqual([`${AUTH}/start?f=abc`, `${AUTH}/callback?code=c&state=s`]);
    for (const r of seen) {
      expect(r.method).toBe('GET');
      expect(r.headers.get('cookie')).toBe('__Host-hana_af=v');
      expect(r.headers.get('cf-connecting-ip')).toBe('203.0.113.9');
    }
  });

  it('serves nothing else: other paths, methods and hosts are 404 with no script, and the console is never called', async () => {
    const { env, seen } = fakeConsole();
    const cases: [string, RequestInit][] = [
      [`${AUTH}/`, {}],
      [`${AUTH}/index.html`, {}],
      [`${AUTH}/start/x`, {}],
      [`${AUTH}/login/callback`, {}],
      [`${AUTH}/api/me`, {}],
      [`${AUTH}/start`, { method: 'POST', body: '{}' }],
      [`${AUTH}/callback`, { method: 'HEAD' }],
      ['https://console.test/start?f=x', {}],
      ['https://evil.example/callback?code=c&state=s', {}],
    ];
    for (const [url, init] of cases) {
      const res = await call(env, url, init);
      expect(res.status, url).toBe(404);
      expect(res.headers.get('content-type'), url).toMatch(/^text\/plain/u);
      if (init.method !== 'HEAD') expect(await res.text(), url).not.toMatch(/<script/iu);
      expectAuthHeaders(res);
    }
    expect(seen).toEqual([]);
  });

  it('GET /.well-known/hana-build answers the build id (D406) as JSON under the auth origin’s headers, without the console', async () => {
    const { env, seen } = fakeConsole();
    for (const [HANA_BUILD, build] of [['0485faa1c2d3-dirty', '0485faa1c2d3-dirty'], ['0485faa1c2d3', '0485faa1c2d3'], [undefined, null], ['', null], ['latest', null]] as const) {
      const res = await call({ ...env, ...(HANA_BUILD === undefined ? {} : { HANA_BUILD }) }, `${AUTH}${BUILD_PATH}`);
      expect(res.status, String(HANA_BUILD)).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
      expectAuthHeaders(res);
      expect(res.headers.has('set-cookie')).toBe(false);
      expect(await res.json()).toEqual({ build });
    }
    const head = await call({ ...env, HANA_BUILD: '0485faa1c2d3' }, `${AUTH}${BUILD_PATH}`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expectAuthHeaders(head);
    expect(seen).toEqual([]);
  });

  it('the build path is 404 for another method, another host or a near-miss path, as everything else is', async () => {
    const { env, seen } = fakeConsole();
    const withBuild = { ...env, HANA_BUILD: '0485faa1c2d3' };
    for (const [url, init] of [
      [`${AUTH}${BUILD_PATH}`, { method: 'POST', body: '{}' }],
      ['https://evil.example/.well-known/hana-build', {}],
      [`${AUTH}${BUILD_PATH}/`, {}],
      [`${AUTH}${BUILD_PATH}.json`, {}],
    ] as [string, RequestInit][]) {
      const res = await call(withBuild, url, init);
      expect(res.status, `${init.method ?? 'GET'} ${url}`).toBe(404);
      expect(await res.text()).toBe('Not found');
      expectAuthHeaders(res);
    }
    expect(seen).toEqual([]);
  });

  it("sets its headers over the console's answer, and answers 503 (no Location) when the binding fails", async () => {
    const { env } = fakeConsole(() => {
      throw new Error('binding down');
    });
    const res = await call(env, `${AUTH}/callback?code=c&state=s`);
    expect(res.status).toBe(503);
    expect(res.headers.get('location')).toBeNull();
    expectAuthHeaders(res);
  });

  it("uses the console's auth-origin CSP: nothing allowed, no framing, no form posts", () => {
    expect(AUTH_ORIGIN_CSP).toBe(CONSOLE_AUTH_ORIGIN_CSP);
    expect(AUTH_ORIGIN_CSP).toBe("default-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'");
  });
});

describe('its config', () => {
  it('binds only CONSOLE → AuthHandler, with AUTH_ORIGIN; no secret, D1, Hyperdrive, R2 or assets', () => {
    const c = wranglerConfig(TEST_MANIFEST);
    expect(c).toMatchObject({
      name: 'hana-id-console-auth-test',
      main: 'src/index.ts',
      vars: { AUTH_ORIGIN: 'https://console-auth.test' },
      services: [{ binding: 'CONSOLE', service: 'hana-id-console-test', entrypoint: 'AuthHandler' }],
      observability: { enabled: true, logs: { invocation_logs: false } },
      preview_urls: false,
    });
    expect(Object.keys(c).sort()).toEqual(['$schema', 'compatibility_date', 'main', 'name', 'observability', 'preview_urls', 'routes', 'services', 'vars', 'workers_dev'].sort());
    expect(JSON.stringify(c)).not.toMatch(/d1_databases|hyperdrive|r2_buckets|assets|SECRET|ratelimits/iu);
    // Only a deploy stamps the build id (D406), so a config generated before a pull can't carry an old one.
    expect(Object.keys(c.vars as Record<string, string>)).not.toContain(BUILD_VAR);
  });

  it('its route: a Custom Domain on a Hana host; its own workers.dev name in a dev env; never workers.dev in production', () => {
    expect(wranglerConfig(TEST_MANIFEST)).toMatchObject({ workers_dev: false, routes: [{ pattern: 'console-auth.test', custom_domain: true }] });
    const dev = { ...TEST_MANIFEST, console: { ...TEST_MANIFEST.console!, authOrigin: 'https://hana-id-console-auth-test.acct.workers.dev' } } as Manifest;
    const devConfig = wranglerConfig(dev);
    expect(devConfig).toMatchObject({ workers_dev: true, preview_urls: false });
    expect(devConfig.routes).toBeUndefined();
    const wrongName = { ...dev, console: { ...dev.console!, authOrigin: 'https://other-worker.acct.workers.dev' } } as Manifest;
    expect(() => wranglerConfig(wrongName)).toThrow(/Worker's own/u);
    expect(() => wranglerConfig({ ...dev, name: 'staging' } as Manifest)).toThrow(/workers\.dev hostnames are for local\*\/sandbox\* envs only/u);
  });

  it('writes wrangler.jsonc from the manifest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'console-auth-gen-'));
    try {
      main(['sandbox-test'], { dir, loadManifest: () => TEST_MANIFEST });
      const text = readFileSync(join(dir, 'wrangler.jsonc'), 'utf8');
      expect(text).toMatch(/^\/\/ Generated by apps\/console-auth/u);
      expect(JSON.parse(text.slice(text.indexOf('\n') + 1))).toEqual(wranglerConfig(TEST_MANIFEST));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
