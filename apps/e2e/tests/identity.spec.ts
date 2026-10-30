// The partner identity token end to end (docs/identity-token-spec.md "Tests" → Playwright): a login, then
// hana.getIdentityToken() in the page, verified the way the partner guide does it (jose, ES256 pinned, the stack's JWKS,
// iss and aud); a reload keeps `sid`, a new login changes it (the same `sub`); a logout stops tokens.
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { API_URL } from '../src/stack.ts';
import { type App, expect, login, newApp, okValue, openPartner, runAction, test, waitReady } from './fixtures.ts';

const ISSUER = `${API_URL}/v1/identity`;
const jwks = createRemoteJWKSet(new URL(`${ISSUER}/jwks.json`));

async function tokenIn(page: import('@playwright/test').Page, name: string, maxAgeMs?: number): Promise<string | null> {
  await runAction(page, name, 'identityToken', ...(maxAgeMs === undefined ? [] : [maxAgeMs]));
  return okValue<string | null>(page, name);
}

async function verified(token: string, app: App) {
  const { payload, protectedHeader } = await jwtVerify(token, jwks, { issuer: ISSUER, audience: app.appId, algorithms: ['ES256'], typ: 'hana-identity+jwt', requiredClaims: ['sub', 'sid', 'iat', 'exp', 'wallets'] });
  return { payload, protectedHeader };
}

test('a logged-in page gets a token its backend verifies with jose against the JWKS', async ({ page, requests }) => {
  const app = await newApp();
  await openPartner(page, app);
  expect(await tokenIn(page, 'before')).toBeNull();
  const addresses = await login(page);
  // Lazy: the login itself mints nothing.
  expect(requests.count(`${API_URL}/v1/identity/token`)).toBe(0);
  const token = (await tokenIn(page, 'first'))!;
  const { payload, protectedHeader } = await verified(token, app);
  expect(protectedHeader).toMatchObject({ alg: 'ES256', typ: 'hana-identity+jwt' });
  expect(payload.sub).toMatch(/^u1_[A-Za-z0-9_-]{22}$/u);
  expect(payload.sid).toMatch(/^s1_[A-Za-z0-9_-]{22}$/u);
  expect(payload.wallets).toEqual([
    { chain: 'stellar', address: addresses.stellar },
    { chain: 'evm', address: addresses.evm },
  ]);
  expect(payload.login_methods).toEqual(['google']);
  expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(3600);
  // The page's event, and the cache: a second call mints nothing.
  expect(await page.evaluate(() => (window as any).e2e.events.filter((e: { name: string }) => e.name === 'identityTokenChanged').map((e: { data: unknown }) => e.data))).toEqual([token]);
  expect(await tokenIn(page, 'second')).toBe(token);
  expect(requests.count(`${API_URL}/v1/identity/token`)).toBe(1);
  // A token for this app fails for another app's audience.
  await expect(jwtVerify(token, jwks, { issuer: ISSUER, audience: 'app_someone_else', algorithms: ['ES256'] })).rejects.toThrow();
});

test('a reload keeps sid; logout stops tokens; a new login brings a new sid for the same sub', async ({ page }) => {
  const app = await newApp();
  await openPartner(page, app);
  await login(page);
  const first = (await verified((await tokenIn(page, 't1'))!, app)).payload;

  await page.reload();
  expect(await waitReady(page)).toBe('ok');
  const reloaded = (await verified((await tokenIn(page, 't2', 30_000))!, app)).payload;
  expect(reloaded.sid).toBe(first.sid);
  expect(reloaded.sub).toBe(first.sub);

  await runAction(page, 'logout', 'logout');
  await okValue(page, 'logout');
  expect(await tokenIn(page, 't3')).toBeNull();

  await login(page);
  const again = (await verified((await tokenIn(page, 't4'))!, app)).payload;
  expect(again.sub).toBe(first.sub);
  expect(again.sid).not.toBe(first.sid);
});

test('the JWKS and discovery document are public, cacheable and hold no private member', async () => {
  const res = await fetch(`${ISSUER}/jwks.json`);
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('public, max-age=600');
  expect(res.headers.get('access-control-allow-origin')).toBe('*');
  const text = await res.text();
  expect(text).not.toContain('"d"');
  expect((JSON.parse(text) as { keys: unknown[] }).keys).toHaveLength(2);
  const discovery = (await (await fetch(`${ISSUER}/.well-known/openid-configuration`)).json()) as { issuer: string; jwks_uri: string };
  expect(discovery).toMatchObject({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks.json` });
});
