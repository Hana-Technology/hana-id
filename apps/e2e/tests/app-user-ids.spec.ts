// Per-app User IDs on a shared scope (D919, docs/partner-platform-spec.md piece P6) end to end, on the local stack: one
// person signs in on a scope's app of before, then the scope is marked as shared and two new apps are created on it.
// Every app opens the SAME wallet (the three addresses byte-identical, and equal to the addresses this stack gave the
// same person on the same scope before per-app IDs existed: pinned below, captured on `next` @ e59e9c64), while each new
// app's identity token carries a User ID of its own, the app of before keeps the scope's, and on each page
// `hana.supportId` is the short form of that page's own token `sub`. The wallet directory then lists which apps of the
// shared scope the person used, with each app's IDs; an app on a scope that isn't marked gets today's User ID and no
// such row.
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { GoogleStub, stackGoogleKey } from '../src/google-stub.ts';
import { API_URL } from '../src/stack.ts';
import { type App, expect, login, newApp, okValue, openPartner, routeStubs, runAction, test, walletDirectory } from './fixtures.ts';

const ISSUER = `${API_URL}/v1/identity`;
const jwks = createRemoteJWKSet(new URL(`${ISSUER}/jwks.json`));

/**
 * The addresses the stack derives for the stub's first Google account on scope `p6addr` (key index 0): captured by
 * this file's first test run on `next` @ e59e9c64, before per-app User IDs (D919). Wallets come from the on-chain path
 * (scope, provider, the Google sub, key index) and the MPC's key alone, so they must not move.
 */
const PINNED_SCOPE = 'p6addr';
const PINNED = {
  stellar: 'GAGIRUEL5QEXFDBP3IYCHMHVJWSFLCCIYRXXGXI23BHC7STUTCOSLIU3',
  evm: '0xD70C6bc8bC4a5F71F1661a0645Af985bBa030120',
  near: 'aa93e49f6f9a651662a257d4972942f9ac12553d3f6db240e77d581dddf95f33',
};

/** The Support ID of a `sub`, by an independent build of the partner guide's rule (base64url, 5 bytes, Crockford). */
function supportIdOf(sub: string): string {
  const bytes = Buffer.from(sub.slice(3), 'base64url').subarray(0, 5);
  const n = bytes.reduce((acc, b) => acc * 256n + BigInt(b), 0n);
  const code = Array.from({ length: 8 }, (_, i) => '0123456789ABCDEFGHJKMNPQRSTVWXYZ'[Number((n >> BigInt(35 - 5 * i)) & 31n)]).join('');
  return `HANA-${code.slice(0, 4)}-${code.slice(4)}`;
}

interface Seen {
  addresses: { stellar: string; evm: string; near?: string };
  sub: string;
  aud: string;
  supportId: string;
}

/**
 * Signs the stub's first account in on `app`, in a browser context of its own (a new visitor's tab), and reads the
 * page's identity token (verified as a partner does) and Support ID.
 */
async function signIn(browser: import('@playwright/test').Browser, app: App, name: string): Promise<Seen> {
  const context = await browser.newContext();
  await routeStubs(context, new GoogleStub({ key: stackGoogleKey(API_URL) }));
  try {
    return await signInOn(await context.newPage(), app, name);
  } finally {
    await context.close();
  }
}

async function signInOn(page: import('@playwright/test').Page, app: App, name: string): Promise<Seen> {
  await openPartner(page, app);
  const addresses = (await login(page, { name: `${name}-login` })) as Seen['addresses'];
  await runAction(page, `${name}-token`, 'identityToken');
  const token = (await okValue<string>(page, `${name}-token`))!;
  const { payload } = await jwtVerify(token, jwks, { issuer: ISSUER, audience: app.appId, algorithms: ['ES256'], typ: 'hana-identity+jwt', requiredClaims: ['sub'] });
  const supportId = (await page.evaluate(() => (window as any).e2e.supportId())) as string;
  return { addresses, sub: payload.sub!, aud: payload.aud as string, supportId };
}

test('one wallet on every app of a shared scope, a User ID and Support ID of its own on each new app; the app of before keeps its IDs', async ({ browser }) => {
  const before = await newApp({ scopeId: PINNED_SCOPE, name: 'Before' });
  const first = await signIn(browser, before, 'before');
  // The wallet this person had on this scope before per-app User IDs existed.
  expect(first.addresses).toEqual(PINNED);
  expect(first.supportId).toBe(supportIdOf(first.sub));
  await expect.poll(async () => (await walletDirectory(first.addresses.stellar)).length, { timeout: 15_000 }).toBe(1);
  const [user] = await walletDirectory(first.addresses.stellar);
  // An unmarked scope: today's User ID (the directory's own), and no per-app row.
  expect(user!.userId).toBe(first.sub);
  expect(user!.apps).toEqual([]);

  // Staff mark the scope as shared; two partners' apps are created on it.
  const own1 = await newApp({ scopeId: PINNED_SCOPE, name: 'Own one', sharedScope: true });
  const own2 = await newApp({ scopeId: PINNED_SCOPE, name: 'Own two' });
  const a = await signIn(browser, own1, 'own1');
  const b = await signIn(browser, own2, 'own2');
  const again = await signIn(browser, before, 'again');

  // Address impact: none. The same three addresses on every app, before and after the mark.
  for (const s of [a, b, again]) expect(s.addresses).toEqual(PINNED);
  // The app of before keeps its User ID and Support ID across the mark.
  expect(again.sub).toBe(first.sub);
  expect(again.supportId).toBe(first.supportId);
  // Each new app: its own User ID, different from the other's and from the scope's, in the same u1_ format.
  expect(a.sub).toMatch(/^u1_[A-Za-z0-9_-]{21}[AQgw]$/u);
  expect(b.sub).toMatch(/^u1_[A-Za-z0-9_-]{21}[AQgw]$/u);
  expect(new Set([first.sub, a.sub, b.sub]).size).toBe(3);
  expect([a.aud, b.aud]).toEqual([own1.appId, own2.appId]);
  // hana.supportId on each page is the short form of that page's own token sub (what the partner's backend computes).
  for (const s of [a, b]) expect(s.supportId).toBe(supportIdOf(s.sub));
  expect(new Set([first.supportId, a.supportId, b.supportId]).size).toBe(3);

  // The directory: one person, the scope's User ID unchanged, and the apps of the shared scope they used, with each
  // app's own IDs (the app of before signed in again after the mark, so it has its row with the scope's IDs).
  await expect.poll(async () => (await walletDirectory(PINNED.stellar))[0]?.apps.length, { timeout: 15_000 }).toBe(3);
  const [after] = await walletDirectory(PINNED.stellar);
  expect(after!.userId).toBe(first.sub);
  const code = (id: string) => id.replace(/^HANA-|-/gu, '');
  expect(after!.apps).toEqual(
    [
      { appId: before.appId, appSub: first.sub, supportCode: code(first.supportId) },
      { appId: own1.appId, appSub: a.sub, supportCode: code(a.supportId) },
      { appId: own2.appId, appSub: b.sub, supportCode: code(b.supportId) },
    ].sort((x, y) => (x.appId < y.appId ? -1 : 1)),
  );
});
