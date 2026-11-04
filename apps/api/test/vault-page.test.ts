import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.ts';
import { MAX_APP_ORIGINS } from '../src/vault/origins.ts';
import { jsonForHtml } from '../src/vault/page.ts';
import { ORIGIN, call, chain, forgeKeyEnvironment, newKey, seedApp, uid } from './helpers.ts';
import { HOUR, VAULT, autoApprovePolicy, setSettings } from './vault-helpers.ts';

afterEach(() => vi.restoreAllMocks());

const DEV = { ENV_NAME: 'sandbox-test' };
/** The test bindings are a dev env (vitest.config.ts); the production rules need another name. */
const PROD = { ENV_NAME: 'prod' };
const BASE = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'";

async function page(query: string, opts: { method?: string; env?: Partial<typeof env>; host?: string; path?: string } = {}): Promise<Response> {
  const request = new Request(`${opts.host ?? VAULT}${opts.path ?? '/vault'}${query}`, { method: opts.method ?? 'GET' });
  const ctx = createExecutionContext();
  const res = await worker.fetch(request as Request<unknown, IncomingRequestCfProperties>, opts.env ? { ...env, ...opts.env } : env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const vaultPage = (key: string, opts: Parameters<typeof page>[1] = {}): Promise<Response> => page(`?pk=${encodeURIComponent(key)}`, opts);

/** The inlined config, read the way the vault script reads it. */
function inlinedConfig(html: string): Record<string, unknown> | null {
  const m = /<script type="application\/json" id="hana-config">([^<]*)<\/script>/u.exec(html);
  return m ? (JSON.parse(m[1]!) as Record<string, unknown>) : null;
}

const csp = (res: Response): string => res.headers.get('content-security-policy') ?? '';
const frameAncestors = (res: Response): string => /frame-ancestors ([^;]*)/u.exec(csp(res))?.[1] ?? '';

describe('GET {vaultOrigin}/vault', () => {
  it('serves the page with the D1 config inlined as JSON, and no chain RPC', async () => {
    const near = chain();
    const app = await seedApp({ origins: [ORIGIN, 'https://b.example.com'] });
    const before = Date.now();
    const res = await vaultPage(app.key);
    expect(res.status).toBe(200);
    const html = await res.text();
    const config = inlinedConfig(html);
    expect(config).toEqual({
      v: 1,
      appId: app.id,
      appName: `Test ${app.id}`,
      scopeId: app.scope,
      origins: ['https://b.example.com', ORIGIN].sort(),
      settings: { persistence: 'session', sessionTtlMs: 12 * HOUR, idleTtlMs: 2 * HOUR, rawSign: 'off', autoApprovePolicy: null },
      publishableKey: app.key,
      serverTimeMs: expect.any(Number),
    });
    expect(config!.serverTimeMs as number).toBeGreaterThanOrEqual(before);
    expect(config!.serverTimeMs as number).toBeLessThanOrEqual(Date.now());
    // The signer is a pinned constant in the bundle, never served.
    expect(html).not.toContain(env.SIGNER_ACCOUNT);
    expect(html).not.toMatch(/signer/iu);
    // The only executable script is the static bundle, from 'self'.
    expect(html.match(/<script/gu)).toHaveLength(2);
    expect(html).toContain('<script type="module" src="/vault.js"></script>');
    expect(near.rpcMethods).toEqual([]);
    expect(near.viewCalls).toEqual([]);
  });

  it('adds rpcFallback to connect-src when the env sets it (the vault reads from it when rpc fails)', async () => {
    const app = await seedApp();
    const saved = env.NEAR_RPC_FALLBACK;
    try {
      env.NEAR_RPC_FALLBACK = 'https://rpc.fallback.test/v1';
      expect(csp(await vaultPage(app.key))).toBe(`${BASE}; frame-ancestors ${ORIGIN}; connect-src https://api.test https://rpc.test.invalid https://rpc.fallback.test https://www.googleapis.com`);
      env.NEAR_RPC_FALLBACK = 'not a url';
      expect((await vaultPage(app.key)).status).toBe(503);
    } finally {
      env.NEAR_RPC_FALLBACK = saved;
    }
  });

  it('adds the email issuer to connect-src when the env has one (the vault calls google-match, batch 8b)', async () => {
    const app = await seedApp();
    const saved = env.EMAIL_ISSUER_URL;
    try {
      env.EMAIL_ISSUER_URL = 'https://issuer.test';
      expect(csp(await vaultPage(app.key))).toBe(`${BASE}; frame-ancestors ${ORIGIN}; connect-src https://api.test https://rpc.test.invalid https://www.googleapis.com https://issuer.test`);
      // Routed under apiUrl (production's zone route): nothing to add.
      env.EMAIL_ISSUER_URL = 'https://api.test';
      expect(csp(await vaultPage(app.key))).toBe(`${BASE}; frame-ancestors ${ORIGIN}; connect-src https://api.test https://rpc.test.invalid https://www.googleapis.com`);
      env.EMAIL_ISSUER_URL = 'not a url';
      expect((await vaultPage(app.key)).status).toBe(503);
    } finally {
      env.EMAIL_ISSUER_URL = saved;
    }
  });

  it('sends the full CSP and the other headers', async () => {
    const app = await seedApp();
    const res = await vaultPage(app.key);
    expect(csp(res)).toBe(`${BASE}; frame-ancestors ${ORIGIN}; connect-src https://api.test https://rpc.test.invalid https://www.googleapis.com`);
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cross-origin-opener-policy')).toBeNull();
    expect(res.headers.get('x-request-id')).toBeTruthy();
    const head = await vaultPage(app.key, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(csp(head)).toBe(csp(res));
    expect((await vaultPage(app.key, { method: 'POST' })).status).toBe(405);
  });

  it('frame-ancestors per pk', async () => {
    const a = await seedApp({ origins: ['https://a.example.com'] });
    const b = await seedApp({ origins: ['https://b1.example.com', 'https://b2.example.com'] });
    const none = await seedApp({ origins: [] });
    expect(frameAncestors(await vaultPage(a.key))).toBe('https://a.example.com');
    expect(frameAncestors(await vaultPage(b.key))).toBe('https://b1.example.com https://b2.example.com');
    expect(frameAncestors(await vaultPage(none.key))).toBe("'none'");
  });

  it('loopback origins only for pk_test_ in dev envs, in frame-ancestors and the inlined origins', async () => {
    const origins = [ORIGIN, 'http://localhost:*', 'http://127.0.0.1:8080', 'http://[::1]:3000', 'http://app.localhost:5173'];
    const test = await seedApp({ origins });
    const live = await seedApp({ key: newKey('pk_live_'), origins });
    const sorted = [...origins].sort();
    expect(frameAncestors(await vaultPage(test.key, { env: DEV }))).toBe(sorted.join(' '));
    expect(inlinedConfig(await (await vaultPage(test.key, { env: { ENV_NAME: 'local-dev' } })).text())!.origins).toEqual(sorted);
    for (const res of [await vaultPage(test.key, { env: PROD }), await vaultPage(live.key, { env: DEV }), await vaultPage(live.key, { env: PROD })]) {
      const fresh = res.clone();
      expect(frameAncestors(res)).toBe(ORIGIN);
      expect(inlinedConfig(await fresh.text())!.origins).toEqual([ORIGIN]);
    }
  });

  it('drops origins that are not bare http(s) origins rather than put them in a header', async () => {
    const app = await seedApp({ origins: [ORIGIN, "https://x.example.com; script-src 'unsafe-inline'", 'https://y.example.com/path', 'javascript:alert(1)', 'https://Z.example.com'] });
    const res = await vaultPage(app.key);
    expect(frameAncestors(res)).toBe(ORIGIN);
    expect(csp(res)).not.toContain('unsafe-inline');
  });

  it('serves up to 20 origins; an app over the cap gets 403', async () => {
    const list = (n: number) => Array.from({ length: n }, (_, i) => `https://o${i}.${uid()}.example.com`);
    const full = await seedApp({ origins: list(MAX_APP_ORIGINS) });
    const res = await vaultPage(full.key);
    expect(res.status).toBe(200);
    expect(frameAncestors(res).split(' ')).toHaveLength(MAX_APP_ORIGINS);
    const over = await seedApp({ origins: list(MAX_APP_ORIGINS + 1) });
    const refused = await vaultPage(over.key);
    expect(refused.status).toBe(403);
    expect(inlinedConfig(await refused.text())).toBeNull();
  });

  it('403 without a config script for an unknown, malformed, suspended or scope-conflicting app', async () => {
    const suspended = await seedApp({ status: 'suspended' });
    const conflicted = await forgeKeyEnvironment(await seedApp());
    for (const res of [await vaultPage(newKey()), await vaultPage('pk_test_x'), await page(''), await vaultPage(suspended.key), await vaultPage(conflicted.key)]) {
      expect(res.status).toBe(403);
      expect(csp(res)).toBe(`${BASE}; frame-ancestors 'none'`);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const html = await res.text();
      expect(html).not.toContain('hana-config');
      expect(html).not.toContain('<script');
    }
  });

  it('503 without a config script when D1 fails', async () => {
    const failing = { prepare: () => ({ bind: () => ({ first: () => Promise.reject(new Error('D1 down')), all: () => Promise.reject(new Error('D1 down')) }) }) } as unknown as D1Database;
    const res = await vaultPage(newKey(), { env: { DB: failing } });
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('hana-config');
    // A missing API_URL is a misconfiguration: 503 too.
    const app = await seedApp();
    expect((await vaultPage(app.key, { env: { API_URL: undefined } })).status).toBe(503);
  });

  it('is only served on the vault origin', async () => {
    const app = await seedApp();
    expect((await page(`?pk=${app.key}`, { host: 'https://api.test' })).status).toBe(404);
    expect((await page(`?pk=${app.key}`, { host: 'https://auth.test' })).status).toBe(404);
    expect((await call(`/vault?pk=${app.key}`)).status).toBe(404);
    expect((await page(`?pk=${app.key}`, { path: '/vault/' })).status).toBe(404);
    expect((await vaultPage(app.key, { env: { VAULT_ORIGIN: undefined } })).status).toBe(404);
  });

  it('the Hana page origins serve nothing of the API: 404 with page headers, while the API host still answers', async () => {
    const app = await seedApp();
    const near = chain();
    for (const host of [VAULT, 'https://auth.test']) {
      for (const [path, method] of [
        ['/v1/health', 'GET'],
        ['/v1/app', 'GET'],
        ['/v1/vault/unlock', 'POST'],
        ['/v1/sessions', 'POST'],
        ['/v1/owner-actions', 'POST'],
        ['/v1/login-relay/' + 'A'.repeat(43), 'GET'],
        ['/nope', 'GET'],
      ] as const) {
        const res = await page('', { host, path, method });
        expect(res.status).toBe(404);
        expect(res.headers.get('access-control-allow-origin')).toBeNull();
        expect(csp(res)).toBe(`${BASE}; frame-ancestors 'none'`);
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
      }
    }
    expect((await page('', { host: 'https://auth.test', path: '/vault', method: 'HEAD' })).status).toBe(404);
    expect(near.rpcMethods).toEqual([]);
    // The same paths on the API's own host.
    expect((await call('/v1/health')).status).toBe(200);
    expect((await call('/v1/app', { headers: { 'x-hana-key': app.key, origin: ORIGIN } })).status).not.toBe(404);
    expect((await call('/v1/vault/unlock', { headers: { 'x-hana-key': app.key, origin: VAULT, 'x-hana-parent-origin': ORIGIN }, body: {} })).status).toBe(400);
  });

  it('an app name of </script><base href=//x> stays inside the JSON', async () => {
    const app = await seedApp();
    const name = '</script><base href=//x> &    <!--';
    await env.DB.prepare('UPDATE apps SET name = ?1 WHERE id = ?2').bind(name, app.id).run();
    const html = await (await vaultPage(app.key)).text();
    expect(html).not.toContain('<base');
    expect(html).not.toContain('<!--');
    expect(html).not.toContain(' ');
    expect(html).not.toContain(' ');
    expect(html.match(/<\/script>/gu)).toHaveLength(2);
    expect(inlinedConfig(html)!.appName).toBe(name);
    expect(jsonForHtml({ s: '<>&  ' })).toBe('{"s":"\\u003c\\u003e\\u0026\\u2028\\u2029"}');
  });
});

describe('delayed settings on the vault page', () => {
  it('raw_sign uses the pending value only from raw_sign_effective_at', async () => {
    const app = await seedApp();
    const rawSign = async () => ((inlinedConfig(await (await vaultPage(app.key)).text())!.settings as Record<string, unknown>).rawSign);
    await setSettings(app.id, { raw_sign_pending: 'approval', raw_sign_effective_at: Date.now() + HOUR });
    expect(await rawSign()).toBe('off');
    await setSettings(app.id, { raw_sign_effective_at: Date.now() - 1 });
    expect(await rawSign()).toBe('approval');
    await setSettings(app.id, { raw_sign: 'approval', raw_sign_pending: null, raw_sign_effective_at: null });
    expect(await rawSign()).toBe('approval');
  });

  it('an auto-approve policy is served only from auto_approve_effective_at; the policy in force until then', async () => {
    const app = await seedApp();
    const policy = async () => (inlinedConfig(await (await vaultPage(app.key)).text())!.settings as Record<string, unknown>).autoApprovePolicy;
    const v1 = autoApprovePolicy('Swaps </script>', 5);
    const v2 = autoApprovePolicy('Wider', 50);
    await setSettings(app.id, { auto_approve_pending: JSON.stringify(v1), auto_approve_effective_at: Date.now() + HOUR });
    expect(await policy()).toBeNull();
    await setSettings(app.id, { auto_approve_effective_at: Date.now() - 1 });
    expect(await policy()).toEqual(v1);
    await setSettings(app.id, { auto_approve_policy: JSON.stringify(v1), auto_approve_pending: JSON.stringify(v2), auto_approve_effective_at: Date.now() + HOUR });
    expect(await policy()).toEqual(v1);
    // Removal (policy and pending cleared) is immediate.
    await setSettings(app.id, { auto_approve_policy: null, auto_approve_pending: null, auto_approve_effective_at: null });
    expect(await policy()).toBeNull();
  });

  it('a stored policy that is not a JSON object is never served', async () => {
    const app = await seedApp();
    for (const text of ['[1]', '"x"', '1', 'null']) {
      await setSettings(app.id, { auto_approve_policy: text });
      expect((inlinedConfig(await (await vaultPage(app.key)).text())!.settings as Record<string, unknown>).autoApprovePolicy).toBeNull();
    }
  });

  it('a stored policy is served only if @hana-id/core validates it, and served normalized', async () => {
    const app = await seedApp();
    const served = async (stored: unknown) => {
      await setSettings(app.id, { auto_approve_policy: JSON.stringify(stored) });
      return (inlinedConfig(await (await vaultPage(app.key)).text())!.settings as Record<string, unknown>).autoApprovePolicy;
    };
    const valid = autoApprovePolicy('Approvals');
    const errors = vi.spyOn(console, 'error');
    // A bare D1 edit can't get past the validator: a missing field, an unknown key, approve with addressArgs 'any'.
    const { maxConsentMs: _, ...noConsent } = valid;
    expect(await served(noConsent)).toBeNull();
    expect(await served({ ...valid, raw: true })).toBeNull();
    const any = autoApprovePolicy('Any');
    any.evm.chains[0]!.contracts[0]!.selectors[0]!.addressArgs = 'any';
    expect(await served(any)).toBeNull();
    expect(errors.mock.calls.map(([line]) => JSON.parse(String(line)).event)).toEqual(Array(3).fill('auto_approve_policy_invalid'));
    // The log line names the problem, never the policy body.
    expect(String(errors.mock.calls[2]![0])).toContain("can't have addressArgs 'any'");
    // Duplicate keys are refused (strict parse), not resolved last-wins.
    await setSettings(app.id, { auto_approve_policy: JSON.stringify(valid).replace('"label":"Approvals"', '"label":"Approvals","label":"Other"') });
    expect((inlinedConfig(await (await vaultPage(app.key)).text())!.settings as Record<string, unknown>).autoApprovePolicy).toBeNull();
    // Served in the validator's normalized form: EIP-55 addresses, lowercase selectors.
    const loose = autoApprovePolicy('Approvals');
    const entry = loose.evm.chains[0]!.contracts[0]!;
    entry.address = entry.address.toLowerCase();
    entry.selectors[0]!.selector = '0x095EA7B3';
    expect(await served(loose)).toEqual(valid);
  });

  it('a policy whose maxConsentMs exceeds the app’s session_ttl_ms is not served', async () => {
    const app = await seedApp();
    await setSettings(app.id, { session_ttl_ms: 2 * HOUR, idle_ttl_ms: HOUR });
    const page = async () => (inlinedConfig(await (await vaultPage(app.key)).text())!.settings as Record<string, unknown>).autoApprovePolicy;
    await setSettings(app.id, { auto_approve_policy: JSON.stringify({ ...autoApprovePolicy('Short'), maxConsentMs: 2 * HOUR }) });
    expect(await page()).toMatchObject({ maxConsentMs: 2 * HOUR });
    await setSettings(app.id, { auto_approve_policy: JSON.stringify({ ...autoApprovePolicy('Long'), maxConsentMs: 2 * HOUR + 1 }) });
    expect(await page()).toBeNull();
  });

  it('serves persistence and the TTLs as stored', async () => {
    const app = await seedApp();
    await setSettings(app.id, { persistence: 'none', session_ttl_ms: HOUR, idle_ttl_ms: 15 * 60_000 });
    expect(inlinedConfig(await (await vaultPage(app.key)).text())!.settings).toMatchObject({ persistence: 'none', sessionTtlMs: HOUR, idleTtlMs: 15 * 60_000 });
  });
});
