// The files Worker (src/index.ts; docs/batch-c-spec.md "Other app settings, name and logo", "Response headers", Tests
// "Settings, keys, logos" and "Host dispatch"): only GET and HEAD of the logo path on FILES_ORIGIN; an object that isn't
// a logo the console wrote is a 404; exactly the spec's headers on a logo.
import { SELF, env } from 'cloudflare:test';
import { BUILD_PATH } from '@hana-id/env/build-id';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAIL_LOGO_PATH, MAIL_LOGO_SHA256 } from '@hana-id/brand/mail-logo';
import worker, { LOGO_HEADERS, LOGO_MAX_BYTES, PNG_SIGNATURE } from '../src/index.ts';

const ORIGIN = env.FILES_ORIGIN;

afterEach(() => vi.restoreAllMocks());

let seq = 0;
/** PNG-signed bytes, distinct per call. */
function pngBytes(size = 64): Uint8Array {
  seq += 1;
  const b = new Uint8Array(size);
  b.set(PNG_SIGNATURE);
  new DataView(b.buffer).setUint32(8, seq);
  return b;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Stores `bytes` under its content-addressed key, as the console does; returns the key. */
async function seed(bytes: Uint8Array, o: { appId?: string; contentType?: string | null; key?: string } = {}): Promise<string> {
  const key = o.key ?? `logos/${o.appId ?? 'app_abc123'}/${await sha256Hex(bytes)}.png`;
  await env.LOGOS.put(key, bytes, o.contentType === null ? {} : { httpMetadata: { contentType: o.contentType ?? 'image/png' } });
  return key;
}

const get = (path: string, init?: RequestInit, origin = ORIGIN) => SELF.fetch(`${origin}${path}`, init);

describe('GET /logos/<app id>/<sha256>.png', () => {
  it('serves a logo with exactly the spec’s headers and its bytes', async () => {
    const bytes = pngBytes();
    const key = await seed(bytes);
    const res = await get(`/${key}`);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    const headers = Object.fromEntries(res.headers);
    expect(headers).toEqual({ ...LOGO_HEADERS, 'content-length': String(bytes.length) });
    expect(LOGO_HEADERS).toEqual({
      'content-type': 'image/png',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cross-origin-resource-policy': 'cross-origin',
      'content-disposition': 'inline; filename="logo.png"',
      'cache-control': 'public, max-age=31536000, immutable',
      'referrer-policy': 'no-referrer',
    });
    // No cookie, ever.
    expect(res.headers.has('set-cookie')).toBe(false);
  });

  it('HEAD: the same status and headers, no body', async () => {
    const key = await seed(pngBytes());
    const res = await get(`/${key}`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(await res.text()).toBe('');
  });

  it('ignores a query string (it can’t name another object)', async () => {
    const key = await seed(pngBytes());
    expect((await get(`/${key}?v=2`)).status).toBe(200);
  });

  it('404s a missing object', async () => {
    const res = await get(`/logos/app_abc123/${'0'.repeat(64)}.png`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('refuses a non-PNG object: another stored type, no type, no PNG signature, a hash that doesn’t match, too large', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const html = new TextEncoder().encode('<!doctype html><script>alert(1)</script>');
    const cases: [string, string][] = [
      ['image/svg+xml type', await seed(pngBytes(), { contentType: 'image/svg+xml' })],
      ['text/html type', await seed(pngBytes(), { contentType: 'text/html' })],
      ['no stored type', await seed(pngBytes(), { contentType: null })],
      ['SVG bytes typed as PNG', await seed(svg)],
      ['HTML bytes typed as PNG', await seed(html)],
      ['a truncated signature', await seed(PNG_SIGNATURE.slice(0, 5))],
      ['an empty object', await seed(new Uint8Array(0))],
      ['bytes another key names', await seed(pngBytes(), { key: `logos/app_abc123/${'1'.repeat(64)}.png` })],
      ['over the 128 KiB cap', await seed(pngBytes(LOGO_MAX_BYTES + 1))],
    ];
    for (const [what, key] of cases) {
      const res = await get(`/${key}`);
      expect(res.status, what).toBe(404);
      expect(res.headers.get('content-type'), what).toBe('text/plain; charset=utf-8');
      expect(await res.text(), what).toBe('Not found\n');
    }
    // Each refusal is logged with a code only (never a key).
    expect(warn).toHaveBeenCalledTimes(cases.length);
    for (const [line] of warn.mock.calls) expect(String(line)).not.toMatch(/logos\//u);
    // The cap itself is served.
    expect((await get(`/${await seed(pngBytes(LOGO_MAX_BYTES))}`)).status).toBe(200);
  });

  it('serves only the logo path pattern (host dispatch): every other path is 404 without reading the bucket', async () => {
    const key = await seed(pngBytes());
    const hexKey = key.split('/')[2]!;
    const spy = vi.fn((k: string) => env.LOGOS.get(k));
    const spied = { ...env, LOGOS: { get: spy } as unknown as R2Bucket };
    for (const path of [
      '/',
      '/logos',
      `/logos/app_abc123/${hexKey}`.replace('.png', ''),
      `/logos/app_abc123/${hexKey.toUpperCase().replace('.PNG', '.png')}`,
      `/logos/app_abc123/${hexKey}/`,
      `/logos/app_abc123/${hexKey.replace('.png', '.svg')}`,
      `/logos/app_abc123//${hexKey}`,
      `/logos/abc123/${hexKey}`,
      `/logos/app_abc123/x/${hexKey}`,
      `/statements/org_x/2026-10/1.csv`,
      `/logos/app_abc123/${'0'.repeat(63)}.png`,
      `/LOGOS/app_abc123/${hexKey}`,
      `/logos/app_abc123/%2e%2e/${hexKey}`,
      `/${key}.html`,
      '/favicon.ico',
    ]) {
      const res = await worker.fetch(new Request(`${ORIGIN}${path}`), spied);
      expect(res.status, path).toBe(404);
      expect((await get(path)).status, path).toBe(404);
    }
    expect(spy).not.toHaveBeenCalled();
    // The same binding does serve the real path.
    expect((await worker.fetch(new Request(`${ORIGIN}/${key}`), spied)).status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('answers only on FILES_ORIGIN: another host (a workers.dev or preview URL) is 404', async () => {
    const key = await seed(pngBytes());
    for (const origin of ['https://hana-id-files-test.example.workers.dev', 'http://files.test', 'https://files.test:8443', 'https://other.test']) {
      expect((await get(`/${key}`, undefined, origin)).status, origin).toBe(404);
    }
  });

  it('allows only GET and HEAD', async () => {
    const key = await seed(pngBytes());
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const res = await get(`/${key}`, { method });
      expect(res.status, method).toBe(405);
      expect(res.headers.get('allow')).toBe('GET, HEAD');
    }
    // A write method never changes the bucket.
    expect(await env.LOGOS.head(key)).not.toBeNull();
  });

  it('503 when R2 fails, without a body that names anything', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = { ...env, LOGOS: { get: () => Promise.reject(new Error('r2 down')) } as unknown as R2Bucket };
    const res = await worker.fetch(new Request(`${ORIGIN}/logos/app_abc123/${'0'.repeat(64)}.png`), broken);
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe('GET /.well-known/hana-build (D406)', () => {
  const url = `${ORIGIN}${BUILD_PATH}`;

  it('answers the deployed build id as uncached JSON that runs nothing, without reading the bucket', async () => {
    const spy = vi.fn((k: string) => env.LOGOS.get(k));
    for (const [HANA_BUILD, build] of [['0485faa1c2d3-dirty', '0485faa1c2d3-dirty'], ['0485faa1c2d3', '0485faa1c2d3'], [undefined, null], ['', null], ['latest', null]] as const) {
      const res = await worker.fetch(new Request(url), { ...env, LOGOS: { get: spy } as unknown as R2Bucket, ...(HANA_BUILD === undefined ? {} : { HANA_BUILD }) });
      expect(res.status, String(HANA_BUILD)).toBe(200);
      expect(Object.fromEntries(res.headers)).toEqual({
        'content-type': 'application/json; charset=utf-8',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      });
      expect(await res.json()).toEqual({ build });
    }
    expect(spy).not.toHaveBeenCalled();
    // The test config, like a generated one, sets no HANA_BUILD (only `run deploy` does): unstamped.
    expect(await (await get(BUILD_PATH)).json()).toEqual({ build: null });
  });

  it('HEAD has no body; another method is 405, another host or a near-miss path 404', async () => {
    const stamped = { ...env, HANA_BUILD: '0485faa1c2d3' };
    const head = await worker.fetch(new Request(url, { method: 'HEAD' }), stamped);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect((await worker.fetch(new Request(url, { method: 'POST' }), stamped)).status).toBe(405);
    expect((await worker.fetch(new Request(`https://other.test${BUILD_PATH}`), stamped)).status).toBe(404);
    for (const path of [`${BUILD_PATH}/`, `${BUILD_PATH}.json`, '/.well-known/hana-builds']) expect((await worker.fetch(new Request(`${ORIGIN}${path}`), stamped)).status, path).toBe(404);
  });
});

describe('GET the mail logo (D685)', () => {
  const sha = async (b: ArrayBuffer): Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('');

  it('serves the built-in PNG at its hashed path: the logo headers, no cookie, a year’s caching, cross-origin CORP', async () => {
    const res = await get(MAIL_LOGO_PATH);
    expect(res.status).toBe(200);
    const bytes = await res.arrayBuffer();
    expect(await sha(bytes)).toBe(MAIL_LOGO_SHA256);
    expect(MAIL_LOGO_PATH).toBe(`/brand/journear-mail-logo-${MAIL_LOGO_SHA256.slice(0, 16)}.png`);
    expect([...new Uint8Array(bytes, 0, 8)]).toEqual([...PNG_SIGNATURE]);
    expect(Object.fromEntries(res.headers)).toEqual({ ...LOGO_HEADERS, 'content-disposition': 'inline; filename="journear-passport.png"', 'content-length': String(bytes.byteLength) });
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(res.headers.has('set-cookie')).toBe(false);
    const h = await get(MAIL_LOGO_PATH, { method: 'HEAD' });
    expect(h.status).toBe(200);
    expect(await h.text()).toBe('');
  });

  it('logs nothing and reads no bucket, whatever the request carries; a query string changes nothing', async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'info'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'debug')];
    const r2 = vi.spyOn(env.LOGOS, 'get');
    const plain = await (await worker.fetch(new Request(`${ORIGIN}${MAIL_LOGO_PATH}`), env)).arrayBuffer();
    const res = await worker.fetch(
      new Request(`${ORIGIN}${MAIL_LOGO_PATH}?r=recipient@example.com&m=123`, { headers: { 'user-agent': 'GoogleImageProxy', 'cf-connecting-ip': '203.0.113.9', referer: 'https://mail.example/' } }),
      env,
    );
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(plain));
    for (const l of logs) expect(l).not.toHaveBeenCalled();
    expect(r2).not.toHaveBeenCalled();
    // Only on FILES_ORIGIN, GET and HEAD.
    expect((await get(MAIL_LOGO_PATH, undefined, 'https://other.test')).status).toBe(404);
    expect((await get(MAIL_LOGO_PATH, { method: 'POST' })).status).toBe(405);
  });
});
