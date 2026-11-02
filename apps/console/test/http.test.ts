// The console Worker's fetch (docs/batch-c-spec.md "Static assets", "Response headers", "Sessions" CSRF): host
// dispatch, the security headers on every response (assets included, since the Worker runs first), the CSRF checks on
// every non-GET request, the session-less routes only, and the per-IP limit of the link routes.
import { describe, expect, it } from 'vitest';
import { consoleCsp } from '../src/headers.ts';
import { CSRF, ORIGIN, post, request } from './helpers.ts';

const EXPECTED = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: https://files.test; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
};

function expectSecurityHeaders(res: Response): void {
  for (const [k, v] of Object.entries(EXPECTED)) expect(res.headers.get(k), k).toBe(v);
  expect(res.headers.get('set-cookie')).toBeNull();
}

describe('headers', () => {
  it('the CSP is the spec’s, with the files origin as the only other image source', () => {
    expect(consoleCsp('https://files.test')).toBe(EXPECTED['content-security-policy']);
  });

  it('on the SPA’s assets: index, an unknown SPA path (single-page fallback), HEAD', async () => {
    for (const path of ['/', '/apps/app_x', '/cancel/gc_abc', '/invite']) {
      const res = await request(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type'), path).toMatch(/^text\/html/u);
      expectSecurityHeaders(res);
      const html = await res.text();
      expect(html).toContain('Hana ID console');
      expect(html).not.toMatch(/<script/u);
    }
    const head = await request('/', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expectSecurityHeaders(head);
  });

  it('on API answers and errors, with no-store', async () => {
    for (const [path, init, status] of [
      ['/api/me', {}, 404],
      ['/api/orgs/org_x/apps', {}, 404],
      ['/api/cancel', {}, 405],
      ['/api/cancel', { method: 'POST', headers: {} }, 403],
    ] as const) {
      const res = await request(path, init);
      expect(res.status, path).toBe(status);
      expectSecurityHeaders(res);
      expect(res.headers.get('cache-control'), path).toBe('no-store');
      expect(res.headers.get('content-type')).toMatch(/^application\/json/u);
      expect(await res.json()).toMatchObject({ error: { code: expect.any(String), message: expect.any(String) } });
    }
  });
});

describe('host dispatch', () => {
  it('answers 404 for any host but console.origin, with the headers and nothing else', async () => {
    for (const host of ['https://console-auth.test', 'https://admin.test', 'https://evil.example', 'http://console.test', 'https://console.test:8443']) {
      for (const path of ['/', '/api/cancel', '/index.html']) {
        const res = await request(path, { host });
        expect(res.status, `${host}${path}`).toBe(404);
        expectSecurityHeaders(res);
        expect(await res.text()).toBe('Not found');
      }
    }
  });

  it('never runs a write for another host, even with every CSRF header', async () => {
    const res = await request('/api/owner-grants/cancel', { host: 'https://evil.example', method: 'POST', headers: { ...CSRF, origin: 'https://evil.example' }, body: { grantId: 'og_x', token: 'A'.repeat(43) } });
    expect(res.status).toBe(404);
  });
});

describe('CSRF: every non-GET request needs all four checks', () => {
  const body = { grantId: 'og_doesnotexist', token: 'A'.repeat(43) };
  const missing: [string, Record<string, string>][] = [
    ['no Sec-Fetch-Site', { 'sec-fetch-site': '' }],
    ['Sec-Fetch-Site cross-site', { 'sec-fetch-site': 'cross-site' }],
    ['Sec-Fetch-Site same-site', { 'sec-fetch-site': 'same-site' }],
    ['no Origin', { origin: '' }],
    ['another Origin', { origin: 'https://evil.example' }],
    ['the auth origin', { origin: 'https://console-auth.test' }],
    ['Origin with a path', { origin: `${ORIGIN}/` }],
    ['Origin "null"', { origin: 'null' }],
    ['no x-hana-console', { 'x-hana-console': '' }],
    ['x-hana-console other than 1', { 'x-hana-console': 'true' }],
    ['a form body', { 'content-type': 'application/x-www-form-urlencoded' }],
    ['text/plain', { 'content-type': 'text/plain' }],
    ['multipart', { 'content-type': 'multipart/form-data; boundary=x' }],
    ['no content-type', { 'content-type': '' }],
  ];

  for (const [label, override] of missing) {
    it(`403 csrf: ${label}`, async () => {
      const headers: Record<string, string> = { ...CSRF };
      for (const [k, v] of Object.entries(override)) {
        if (v === '') delete headers[k];
        else headers[k] = v;
      }
      const res = await request('/api/owner-grants/cancel', { method: 'POST', headers, body });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: { code: 'csrf', message: expect.any(String) } });
    });
  }

  it('applies to every method and path, not only the API', async () => {
    for (const [method, path] of [['PUT', '/api/cancel'], ['DELETE', '/api/owner-grants/cancel'], ['PATCH', '/'], ['POST', '/'], ['POST', '/api/unknown']] as const) {
      const res = await request(path, { method, body: '{}' });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });

  it('with all four, the request reaches its route (charset allowed, case-insensitive media type)', async () => {
    for (const ct of ['application/json', 'application/json; charset=utf-8', 'Application/JSON']) {
      const res = await post('/api/owner-grants/cancel', body, { headers: { 'content-type': ct } });
      expect(res.status, ct).toBe(403);
      expect(await res.json()).toMatchObject({ error: { code: 'forbidden' } });
    }
  });

  it('a CSRF-valid write to a non-API path or an unknown route is still refused', async () => {
    expect((await post('/', {})).status).toBe(405);
    expect((await post('/api/unknown', {})).status).toBe(404);
  });

  it('GET and HEAD need none of them', async () => {
    expect((await request('/')).status).toBe(200);
    expect((await request('/api/me')).status).toBe(404);
  });
});

describe('the link routes’ per-IP limit (10 a minute)', () => {
  it('refuses the 11th request from one IP with 429 and retry-after, and not another IP', async () => {
    const ip = '192.0.2.77';
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await post('/api/owner-grants/cancel', { grantId: 'og_x', token: 'A'.repeat(43) }, { ip })).status);
    expect(statuses.slice(0, 10).every((s) => s === 403)).toBe(true);
    expect(statuses[10]).toBe(429);
    const over = await post('/api/cancel', { changeId: 'gc_x', token: 'A'.repeat(43) }, { ip });
    expect(over.status).toBe(429);
    expect(over.headers.get('retry-after')).toBe('60');
    expect((await post('/api/owner-grants/cancel', { grantId: 'og_x', token: 'A'.repeat(43) }, { ip: '192.0.2.78' })).status).toBe(403);
  });

  it('counts an IPv6 /64 as one requester', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await post('/api/owner-grants/cancel', { grantId: 'og_x', token: 'A'.repeat(43) }, { ip: `2001:db8:77:1::${i + 1}` })).status);
    expect(statuses[10]).toBe(429);
  });

  it('refuses an oversized body', async () => {
    const res = await post('/api/owner-grants/cancel', { grantId: 'og_x', token: 'A'.repeat(43), pad: 'x'.repeat(5000) });
    expect(res.status).toBe(413);
  });
});
