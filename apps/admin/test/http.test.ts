// The admin Worker's front door (docs/batch-c-spec.md "Hana admin console", "Response headers", "Tests: Admin and
// email", "Headers", "Topology and config"): the Access JWT check on every /api/* request (missing, malformed, wrong
// aud or iss, expired, not yet valid, unknown kid, empty sub, a service token, an email not on the staff list, a
// missing config, unreachable certs), host dispatch, CSRF, and the headers on every kind of response.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.ts';
import { adminCsp } from '../src/headers.ts';
import { ADMIN, CSRF, STAFF_EMAIL, STAFF_SUB, adminRequest, envWith, json, rsaSigner, staffJwt, stubNetwork } from './helpers.ts';

beforeEach(async () => {
  await stubNetwork();
});
afterEach(() => vi.restoreAllMocks());

const code = async (res: Response) => (await json<{ error: { code: string } }>(res)).error.code;

describe('the Access check on /api/*', () => {
  it('accepts a staff token: the actor is the Access sub and the lowercased email', async () => {
    const res = await adminRequest('/api/me', { jwt: await staffJwt({ email: 'Staff@Hana.Example' }) });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ email: STAFF_EMAIL, sub: STAFF_SUB, env: 'sandbox-test' });
  });

  it('answers the Access token’s exp in GET /api/me (the SPA’s expiry warning), never the token itself', async () => {
    const exp = Math.floor(Date.now() / 1000) + 1234;
    const jwt = await staffJwt({ exp });
    const res = await adminRequest('/api/me', { jwt });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.accessExp).toBe(exp);
    expect(Object.keys(body).sort()).toEqual(['accessExp', 'consoleOrigin', 'email', 'env', 'renewUrl', 'scopeRegistration', 'sub']);
    // The Register a scope panel's manifest values (D651): the test manifest's owner is an account, no council.
    expect(body.scopeRegistration).toEqual({ ownerKind: 'account', owner: 'owner.test.near', councilMembers: [], devCouncilKeys: false, sharedClientIds: [] });
    // Renew: the team's Access login for this application (public values), back to /signed-in.
    expect(body.renewUrl).toMatch(/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com\/cdn-cgi\/access\/login\/[^/?]+\?kid=[0-9a-f]{64}&redirect_url=%2Fsigned-in$/u);
    const text = JSON.stringify(body);
    for (const part of jwt.split('.')) expect(text).not.toContain(part);
  });

  it('refuses a missing, malformed or tampered token with 401', async () => {
    expect((await adminRequest('/api/me', { jwt: null })).status).toBe(401);
    const bad = await adminRequest('/api/me', { jwt: 'not.a.jwt' });
    expect(bad.status).toBe(401);
    expect(await code(bad)).toBe('unauthenticated');
    const good = await staffJwt();
    const [h, , s] = good.split('.');
    const forged = `${h}.${btoa(JSON.stringify({ ...JSON.parse(atob(good.split('.')[1]!.replace(/-/gu, '+').replace(/_/gu, '/'))), email: 'other@hana.example' })).replace(/=+$/u, '').replace(/\+/gu, '-').replace(/\//gu, '_')}.${s}`;
    expect((await adminRequest('/api/me', { jwt: forged })).status).toBe(401);
  });

  it('refuses a wrong audience, a wrong issuer, an expired or not-yet-valid token', async () => {
    const now = Math.floor(Date.now() / 1000);
    for (const over of [{ aud: ['cd'.repeat(32)] }, { iss: 'https://evil.cloudflareaccess.com' }, { exp: now - 120 }, { nbf: now + 3600 }]) {
      const res = await adminRequest('/api/me', { jwt: await staffJwt(over) });
      expect(res.status, JSON.stringify(over)).toBe(401);
      expect(await code(res)).toBe('unauthenticated');
    }
  });

  it('refuses an unknown kid, an empty sub, a service token and a non-app token', async () => {
    const other = await rsaSigner('some-other-kid');
    expect((await adminRequest('/api/me', { jwt: await staffJwt({}, other) })).status).toBe(401);
    expect((await adminRequest('/api/me', { jwt: await staffJwt({ sub: '' }) })).status).toBe(401);
    // A service token: Access sets no sub and no email (common_name instead).
    expect((await adminRequest('/api/me', { jwt: await staffJwt({ sub: '', email: undefined, common_name: 'svc.access' }) })).status).toBe(401);
    expect((await adminRequest('/api/me', { jwt: await staffJwt({ type: 'org' }) })).status).toBe(401);
  });

  it('refuses a valid identity whose email is not on the staff list with 403, and every route alike', async () => {
    const jwt = await staffJwt({ email: 'someone@hana.example' });
    for (const [path, method] of [['/api/me', 'GET'], ['/api/orgs', 'GET'], ['/api/invites', 'POST'], ['/api/nope', 'GET']] as const) {
      const res = await adminRequest(path, { jwt, method, ...(method === 'POST' ? { body: {} } : {}) });
      expect(res.status, path).toBe(403);
      expect(await code(res)).toBe('not_staff');
    }
  });

  it('fails closed with 503 when the certs are unreachable or the Access config is missing', async () => {
    vi.restoreAllMocks();
    await stubNetwork({ certsDown: true });
    const res = await adminRequest('/api/me');
    expect(res.status).toBe(503);
    expect(await code(res)).toBe('access_unavailable');
    vi.restoreAllMocks();
    await stubNetwork();
    const jwt = await staffJwt();
    const req = () => new Request(`${ADMIN}/api/me`, { headers: { 'cf-access-jwt-assertion': jwt } });
    for (const over of [{ ACCESS_AUD: 'UNSET' }, { STAFF_EMAILS: '[]' }, { STAFF_EMAILS: 'not json' }, { STAFF_EMAILS: '["Staff@hana.example"]' }]) {
      const r = await worker.fetch(req(), envWith(over));
      expect(r.status, JSON.stringify(over)).toBe(503);
    }
  });

  it('never trusts a cookie or another header for the identity', async () => {
    const jwt = await staffJwt();
    const res = await adminRequest('/api/me', { jwt: null, headers: { cookie: `CF_Authorization=${jwt}`, authorization: `Bearer ${jwt}` } });
    expect(res.status).toBe(401);
  });
});

describe('host dispatch, CSRF and the SPA', () => {
  it('answers 404 for any other host, with no script and the headers', async () => {
    for (const host of ['https://console.test', 'https://admin.test.evil.example', 'http://admin.test']) {
      const res = await adminRequest('/api/me', { host });
      expect(res.status, host).toBe(404);
      expect(await res.text()).toBe('Not found');
      expect(res.headers.get('content-security-policy')).toBe(adminCsp('https://files.test'));
    }
  });

  it('serves the SPA without a JWT (Access guards it at the edge), GET and HEAD only, with its fallback', async () => {
    const page = await adminRequest('/', { jwt: null });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<script src="/app.js" defer></script>');
    const deep = await adminRequest('/orgs/org_abc/apps/app_x', { jwt: null });
    expect(deep.status).toBe(200);
    expect(await deep.text()).toContain('Hana ID admin');
    const js = await adminRequest('/app.js', { jwt: null });
    expect(js.status).toBe(200);
    expect(await js.text()).toContain('textContent');
    expect((await adminRequest('/', { jwt: null, method: 'POST', body: {} })).status).toBe(405);
  });

  it('needs every CSRF check on a non-GET /api/* request', async () => {
    const without = async (h: string, value?: string) => {
      const headers: Record<string, string> = { ...CSRF };
      if (value === undefined) delete headers[h];
      else headers[h] = value;
      return adminRequest('/api/orgs/org_none/freeze', { method: 'POST', body: { frozen: true }, csrf: false, headers });
    };
    for (const [h, v] of [['sec-fetch-site', undefined], ['sec-fetch-site', 'cross-site'], ['origin', undefined], ['origin', 'https://console.test'], ['x-hana-admin', undefined], ['content-type', 'text/plain']] as const) {
      const res = await without(h, v);
      expect(res.status, `${h}=${v}`).toBe(403);
      expect(await code(res)).toBe('csrf');
    }
    // All four: past CSRF, to the route (an unknown org).
    expect((await adminRequest('/api/orgs/org_none12345/freeze', { body: { frozen: true } })).status).toBe(404);
  });

  it('answers 404 for an unknown /api path and 405 with allow for a wrong method', async () => {
    expect((await adminRequest('/api/no-such-route', { body: {} })).status).toBe(404);
    const res = await adminRequest('/api/orgs', { method: 'DELETE', body: {} });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
    expect((await adminRequest('/api/orgs/org_x/freeze', { body: '[1]' })).status).toBe(400);
    expect((await adminRequest('/api/orgs/org_x/freeze', { body: '{' })).status).toBe(400);
    expect((await adminRequest('/api/orgs/org_x/freeze', { body: JSON.stringify({ pad: 'x'.repeat(70_000) }) })).status).toBe(413);
  });
});

describe('response headers', () => {
  const expected = {
    'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: https://files.test; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
    'strict-transport-security': 'max-age=63072000; includeSubDomains',
  };

  it('are on assets, JSON answers, refusals and errors; /api/* is no-store; nothing sets a cookie', async () => {
    const cases: [string, Response, boolean][] = [
      ['asset', await adminRequest('/app.css', { jwt: null }), false],
      ['font', await adminRequest('/fonts/Montserrat-400.woff2', { jwt: null }), false],
      ['page', await adminRequest('/', { jwt: null }), false],
      ['json', await adminRequest('/api/me'), true],
      ['401', await adminRequest('/api/me', { jwt: null }), true],
      ['403 csrf', await adminRequest('/api/orgs/org_x/freeze', { method: 'POST', body: {}, csrf: false }), true],
      ['404 api', await adminRequest('/api/nope'), true],
    ];
    for (const [name, res, api] of cases) {
      for (const [k, v] of Object.entries(expected)) expect(res.headers.get(k), `${name} ${k}`).toBe(v);
      expect(res.headers.get('set-cookie'), name).toBeNull();
      if (api) expect(res.headers.get('cache-control'), name).toBe('no-store');
    }
  });

  it('serves the brand fonts from its own assets as fonts (D426), with no Access sign-in needed, like the SPA', async () => {
    const font = await adminRequest('/fonts/Montserrat-400.woff2', { jwt: null });
    expect(font.status).toBe(200);
    expect(font.headers.get('content-type')).toBe('font/woff2');
    expect(new TextDecoder().decode(new Uint8Array(await font.arrayBuffer()).slice(0, 4))).toBe('wOF2');
    const licence = await adminRequest('/fonts/OFL.txt', { jwt: null });
    expect(licence.status).toBe(200);
    expect(await licence.text()).toContain('SIL OPEN FONT LICENSE Version 1.1');
  });

  it('a thrown error is a 500 with the headers', async () => {
    const broken = envWith({ ASSETS: { fetch: () => Promise.reject(new Error('boom')) } as unknown as Fetcher });
    const res = await worker.fetch(new Request(`${ADMIN}/`), broken);
    expect(res.status).toBe(500);
    expect(res.headers.get('content-security-policy')).toBe(expected['content-security-policy']);
    void env;
  });
});
