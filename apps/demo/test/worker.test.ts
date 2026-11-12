import { describe, expect, it } from 'vitest';
import { NON_PAGE_CSP, pageCsp } from '../src/csp.ts';
import { type AssetsBinding, type DemoWorkerEnv, handleDemo } from '../worker/index.ts';
import { CONFIG } from './fixtures.ts';

const ORIGIN = 'https://hana-id-demo-sandbox-dev.tingtc.workers.dev';
const CSP = pageCsp(CONFIG);

const FILES: Record<string, [string, string]> = {
  '/index.html': ['text/html; charset=utf-8', '<!doctype html><title>demo</title>'],
  '/other.html': ['text/html; charset=utf-8', '<!doctype html><title>other</title>'],
  '/assets/index-DTeOmnGk.js': ['text/javascript', 'console.log(1)'],
  '/favicon.svg': ['image/svg+xml', '<svg/>'],
  '/assets/ibm-plex-sans-400-B3kQ8vYp.woff2': ['font/woff2', 'wOF2'],
  '/sneaky': ['text/html', '<script>alert(1)</script>'],
};

/** The static-assets binding over FILES; it may answer with a cookie, which must never reach the browser. */
const assets: AssetsBinding & { seen: string[] } = {
  seen: [],
  async fetch(request) {
    const path = new URL(request.url).pathname;
    this.seen.push(path);
    const f = FILES[path];
    if (!f) return new Response('nope', { status: 404 });
    if (request.headers.get('if-none-match') === '"etag"') return new Response(null, { status: 304, headers: { etag: '"etag"' } });
    return new Response(f[1], { status: 200, headers: { 'content-type': f[0], etag: '"etag"', 'set-cookie': 'a=b' } });
  },
};

const env: DemoWorkerEnv = { DEMO_ORIGIN: ORIGIN, CSP, ASSETS: assets };
const get = (path: string, init: RequestInit = {}, e: DemoWorkerEnv = env) => handleDemo(new Request(`${ORIGIN}${path}`, init), e);

function expectSecurityHeaders(res: Response, csp: string): void {
  expect(res.headers.get('content-security-policy')).toBe(csp);
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  expect(res.headers.get('x-frame-options')).toBe('DENY');
  expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin-allow-popups');
  expect(res.headers.get('set-cookie')).toBeNull();
  expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
}

describe('handleDemo', () => {
  it('serves the page on / with the page CSP', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toContain('<title>demo</title>');
    expectSecurityHeaders(res, CSP);
  });

  it('serves assets with the non-page CSP, hashed bundles as immutable, and 304s', async () => {
    const js = await get('/assets/index-DTeOmnGk.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toBe('text/javascript');
    expect(js.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expectSecurityHeaders(js, NON_PAGE_CSP);
    // Hana's fonts (D426): hashed by Vite like the bundles, so immutable too.
    const font = await get('/assets/ibm-plex-sans-400-B3kQ8vYp.woff2');
    expect(font.headers.get('content-type')).toBe('font/woff2');
    expect(font.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expectSecurityHeaders(font, NON_PAGE_CSP);
    const icon = await get('/favicon.svg');
    expect(icon.headers.get('cache-control')).toBe('public, max-age=300');
    expectSecurityHeaders(icon, NON_PAGE_CSP);
    const again = await get('/favicon.svg', { headers: { 'if-none-match': '"etag"' } });
    expect(again.status).toBe(304);
    expectSecurityHeaders(again, NON_PAGE_CSP);
  });

  it('never serves HTML except on /: not by file name, not as an asset', async () => {
    for (const path of ['/index.html', '/other.html', '/INDEX.HTML', '/sneaky', '/missing']) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expectSecurityHeaders(res, NON_PAGE_CSP);
    }
  });

  it('answers HEAD without a body, and refuses other methods', async () => {
    const head = await get('/', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expectSecurityHeaders(head, CSP);
    const post = await get('/', { method: 'POST', body: 'x' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
    expectSecurityHeaders(post, NON_PAGE_CSP);
  });

  it('answers only on its own origin (no preview or other hostname)', async () => {
    const res = await handleDemo(new Request('https://abc123-hana-id-demo-sandbox-dev.tingtc.workers.dev/'), env);
    expect(res.status).toBe(404);
    expectSecurityHeaders(res, NON_PAGE_CSP);
  });

  it('serves nothing without its CSP or origin, and 503 when the page is missing from the build', async () => {
    for (const e of [{ ASSETS: assets }, { ...env, CSP: '' }, { ...env, DEMO_ORIGIN: undefined }]) {
      const res = await get('/', {}, e);
      expect(res.status).toBe(503);
      expectSecurityHeaders(res, NON_PAGE_CSP);
    }
    const empty: AssetsBinding = { fetch: async () => new Response('nope', { status: 404 }) };
    expect((await get('/', {}, { ...env, ASSETS: empty })).status).toBe(503);
  });
});
