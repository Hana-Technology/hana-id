import { describe, expect, it } from 'vitest';
import { NON_PAGE_CSP, pageCsp } from '../src/csp.ts';
import { type AssetsBinding, type StampsWorkerEnv, handleStamps } from '../worker/index.ts';
import { CONFIG, NEAR_ACCOUNT } from './fixtures.ts';

const ORIGIN = 'https://hana-id-stamps-sandbox-dev.tingtc.workers.dev';
const CSP = pageCsp(CONFIG);

const FILES: Record<string, [string, string]> = {
  '/index.html': ['text/html; charset=utf-8', '<!doctype html><title>stamps</title>'],
  '/other.html': ['text/html; charset=utf-8', '<!doctype html><title>other</title>'],
  '/assets/index-DTeOmnGk.js': ['text/javascript', 'console.log(1)'],
  '/favicon.svg': ['image/svg+xml', '<svg/>'],
  '/sneaky': ['text/html', '<script>alert(1)</script>'],
};

/** The static-assets binding over FILES; it may answer with a cookie, which must never reach the browser. */
const assets: AssetsBinding = {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const f = FILES[path];
    if (!f) return new Response('nope', { status: 404 });
    if (request.headers.get('if-none-match') === '"etag"') return new Response(null, { status: 304, headers: { etag: '"etag"' } });
    return new Response(f[1], { status: 200, headers: { 'content-type': f[0], etag: '"etag"', 'set-cookie': 'a=b' } });
  },
};

const env: StampsWorkerEnv = { STAMPS_ORIGIN: ORIGIN, CSP, ASSETS: assets };
const get = (path: string, init: RequestInit = {}, e: StampsWorkerEnv = env) => handleStamps(new Request(`${ORIGIN}${path}`, init), e);

function expectSecurityHeaders(res: Response, csp: string): void {
  expect(res.headers.get('content-security-policy')).toBe(csp);
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  expect(res.headers.get('x-frame-options')).toBe('DENY');
  expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin-allow-popups');
  expect(res.headers.get('set-cookie')).toBeNull();
}

describe('handleStamps', () => {
  it('serves the page on / and on a valid /p/<account_id>, with the page CSP', async () => {
    for (const path of ['/', `/p/${NEAR_ACCOUNT}`, '/p/alice.testnet']) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(await res.text()).toContain('<title>stamps</title>');
      expectSecurityHeaders(res, CSP);
    }
  });

  it('404 for a passport path with an invalid id', async () => {
    for (const path of ['/p/', '/p/alice.near', `/p/${NEAR_ACCOUNT}/`, '/p/ALICE.testnet', '/p/a%2Fb.testnet']) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expectSecurityHeaders(res, NON_PAGE_CSP);
    }
  });

  it('serves assets with the non-page CSP, hashed bundles as immutable, and 304s', async () => {
    const js = await get('/assets/index-DTeOmnGk.js');
    expect(js.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expectSecurityHeaders(js, NON_PAGE_CSP);
    const again = await get('/favicon.svg', { headers: { 'if-none-match': '"etag"' } });
    expect(again.status).toBe(304);
    expectSecurityHeaders(again, NON_PAGE_CSP);
  });

  it('never serves HTML except on its routes', async () => {
    for (const path of ['/index.html', '/other.html', '/INDEX.HTML', '/sneaky', '/missing']) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expectSecurityHeaders(res, NON_PAGE_CSP);
    }
  });

  it('HEAD without a body, other methods refused, other hostnames 404, nothing without its vars', async () => {
    const head = await get('/', { method: 'HEAD' });
    expect([head.status, await head.text()]).toEqual([200, '']);
    const post = await get('/', { method: 'POST', body: 'x' });
    expect(post.status).toBe(405);
    expect((await handleStamps(new Request('https://abc-hana-id-stamps-sandbox-dev.tingtc.workers.dev/'), env)).status).toBe(404);
    for (const e of [{ ASSETS: assets }, { ...env, CSP: '' }, { ...env, STAMPS_ORIGIN: undefined }]) expect((await get('/', {}, e)).status).toBe(503);
    expect((await get('/', {}, { ...env, ASSETS: { fetch: async () => new Response('nope', { status: 404 }) } })).status).toBe(503);
  });
});
