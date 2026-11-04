// Origin and source refusals (docs/batch-b-spec.md "Security model → Threats", "Tests → Playwright"): the vault is
// framed only by the app's origins, and nothing from a foreign site (evil.e2e.test, served by a route) gets login
// parameters, starts a Google request, or answers an approval.
import { type Page } from '@playwright/test';
import { approvalDigest, parseWindowMessage, relayIdFor, sessionNonce } from '@hana-id/core';
import { AUTH_ORIGIN, E2E_ENV, EVIL_ORIGIN, GOOGLE_CLIENT_ID, PARTNER_ORIGIN, SITE_B_ORIGIN, VAULT_ORIGIN } from '../src/stack.ts';
import {
  approve,
  chooseAccount,
  clickAction,
  clickLauncher,
  expect,
  newApp,
  okValue,
  openPartner,
  peek,
  recordApproveRequests,
  runAction,
  login,
  test,
} from './fixtures.ts';

/** Opens the foreign site from the partner page, so it holds the partner window as its `opener` (a link the user followed). */
async function openEvil(page: Page): Promise<Page> {
  const evilP = page.waitForEvent('popup');
  expect(await page.evaluate((url) => (window as any).e2e.openWindow(url), `${EVIL_ORIGIN}/`)).toBe(true);
  const evil = await evilP;
  await evil.waitForLoadState();
  return evil;
}

/** What the foreign page's window received (origin and message type only). */
const received = (evil: Page): Promise<{ origin: string; t: unknown }[]> => evil.evaluate(() => (window as any).received);

test.describe('embedding', () => {
  test('a site the app does not list cannot embed its vault (frame-ancestors): vault_unavailable', async ({ page, requests }) => {
    const app = await newApp({ origins: [SITE_B_ORIGIN] });
    expect(await openPartner(page, app)).toBe('error');
    expect(await page.evaluate(() => (window as any).e2e.readyError)).toBe('vault_unavailable');
    // The vault document was refused, so its script never ran; the SDK tried a second frame once (no answer), then
    // reported it.
    expect(requests.count(`${VAULT_ORIGIN}/vault?`)).toBe(2);
    expect(await page.evaluate(() => (window as any).e2e.readyErrorReason)).toBe('no_answer');
    expect(requests.count(`${VAULT_ORIGIN}/vault.js`)).toBe(0);
  });

  test('a suspended app gets no vault: vault_unavailable', async ({ page, requests }) => {
    const app = await newApp({ status: 'suspended' });
    expect(await openPartner(page, app)).toBe('error');
    expect(await page.evaluate(() => (window as any).e2e.readyError)).toBe('vault_unavailable');
    expect(requests.count(`${VAULT_ORIGIN}/vault.js`)).toBe(0);
  });

  test('the vault page opened top-level does nothing', async ({ page, requests }) => {
    const app = await newApp();
    await page.goto(`${VAULT_ORIGIN}/vault?pk=${app.pk}`);
    await page.waitForTimeout(500);
    expect(requests.count(`${VAULT_ORIGIN}/vault.js`)).toBe(1);
    expect(requests.count(/\/v1\//u)).toBe(0);
  });
});

test('a forged auth-hello from a foreign site gets no auth-params', async ({ page }) => {
  const app = await newApp();
  await openPartner(page, app, { blockPopups: true });
  const evil = await openEvil(page);
  // A pending login waiting on the launcher: the next auth-hello the vault accepts would get the parameters.
  await clickAction(page, 'login', 'login');
  await expect(page.frameLocator('iframe[name^="hana-vault-"]').getByRole('button', { name: 'Sign in with Hana' })).toBeVisible();
  await evil.evaluate(async () => {
    for (let i = 0; i < 15; i++) {
      for (let f = 0; f < window.opener.frames.length; f++) window.opener.frames[f].postMessage({ v: 1, t: 'hana:auth-hello' }, '*');
      await new Promise((r) => setTimeout(r, 100));
    }
  });
  await page.waitForTimeout(300);
  expect((await received(evil)).filter((m) => m.t === 'hana:auth-params')).toEqual([]);

  // The pending login is intact: the launcher still finishes it.
  const popup = await clickLauncher(page, 'Sign in with Hana');
  expect(new URL(popup.url()).search).toBe('?from=vault');
  await chooseAccount(popup);
  expect((await okValue<{ evm: string }>(page, 'login')).evm).toMatch(/^0x/u);
});

test('forged auth-params from a foreign site are refused by the login popup (no Google request)', async ({ context, google }) => {
  const app = await newApp();
  const evil = await context.newPage();
  await evil.goto(`${EVIL_ORIGIN}/`);
  // Parameters the API would accept for the partner's app, with a nonce the attacker chose: only the popup's
  // origin and source checks stand between them and a Google request.
  const sessionPublicKey = crypto.getRandomValues(new Uint8Array(32));
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const readKey = crypto.getRandomValues(new Uint8Array(32));
  const expiresAtMs = Date.now() + 3_600_000;
  const nonce = sessionNonce({ signer: E2E_ENV.signer, scopeId: 'e2e', sessionPublicKey, expiresAtMs, keyIndex: 0, maxUses: 1, salt });
  const params = {
    v: 1,
    t: 'hana:auth-params',
    pk: app.pk,
    appName: 'E2E Partner',
    parentOrigin: PARTNER_ORIGIN,
    scopeId: 'e2e',
    signer: E2E_ENV.signer,
    clientId: GOOGLE_CLIENT_ID,
    mode: 'shared',
    sessionPublicKey: Array.from(sessionPublicKey),
    expiresAtMs,
    salt: Array.from(salt),
    keyIndex: 0,
    maxUses: 1,
    nonce,
    relayId: relayIdFor(readKey),
    relayKey: Array.from(crypto.getRandomValues(new Uint8Array(32))),
  };
  // Well-formed, so the popup's schema check passes and only its sender check can refuse it.
  const asSent = { ...params, sessionPublicKey, salt, relayKey: Uint8Array.from(params.relayKey) };
  expect(parseWindowMessage(asSent, ['hana:auth-params'])).not.toBeNull();

  for (const query of ['?from=vault', `?v=hana-vault-${'ab'.repeat(16)}`]) {
    const popupP = evil.waitForEvent('popup');
    await evil.evaluate((url) => {
      (window as any).child = window.open(url, '_blank', 'popup');
    }, `${AUTH_ORIGIN}/login${query}`);
    const popup = await popupP;
    await popup.waitForLoadState();
    // The popup is the foreign page's child, so the foreign page can post to it directly, as the vault would.
    await evil.evaluate(async (p: any) => {
      const msg = { ...p, sessionPublicKey: Uint8Array.from(p.sessionPublicKey), salt: Uint8Array.from(p.salt), relayKey: Uint8Array.from(p.relayKey) };
      for (let i = 0; i < 10; i++) {
        (window as any).child.postMessage(msg, '*');
        await new Promise((r) => setTimeout(r, 100));
      }
    }, params);
    await popup.waitForTimeout(500);
    expect(new URL(popup.url()).origin).toBe(AUTH_ORIGIN);
    expect(new URL(popup.url()).pathname).toBe('/login');
    await popup.close();
  }
  expect(google.requests).toEqual([]);
});

test("a login popup opened by a foreign page can't reach the partner's vault", async ({ page, google }) => {
  const app = await newApp();
  await openPartner(page, app, { blockPopups: true });
  const frameName = await page.evaluate(() => (window as any).e2e.vaultFrameName() as string);
  const evil = await openEvil(page);
  await clickAction(page, 'login', 'login');
  await expect(page.frameLocator('iframe[name^="hana-vault-"]').getByRole('button', { name: 'Sign in with Hana' })).toBeVisible();

  // The foreign page opens Hana's login popup naming the partner's vault frame: the popup looks for it among its own
  // opener's (the foreign page's) frames, finds nothing, and never gets parameters.
  const popupP = evil.waitForEvent('popup');
  await evil.evaluate((url) => void window.open(url, '_blank', 'popup'), `${AUTH_ORIGIN}/login?v=${frameName}`);
  const popup = await popupP;
  await popup.waitForTimeout(1_500);
  expect(new URL(popup.url()).pathname).toBe('/login');
  expect(google.requests).toEqual([]);
  expect(await peek(page, 'login')).toEqual({ state: 'pending' });
  await popup.close();

  const legit = await clickLauncher(page, 'Sign in with Hana');
  await chooseAccount(legit);
  expect((await okValue<{ stellar: string }>(page, 'login')).stellar).toMatch(/^G/u);
});

test('a forged approval from a foreign site produces no signature, even with the right id and digest', async ({ page, context }) => {
  await recordApproveRequests(context);
  const app = await newApp();
  await openPartner(page, app);
  await login(page);
  const evil = await openEvil(page);
  await runAction(page, 'sig', 'personalSign', 'forged?');
  const popup = await clickLauncher(page, 'Review in Hana');
  // The answer the real popup would send, sent by the foreign page to the vault frame.
  const req = await popup.waitForFunction(() => (window as any).__approveRequests?.at(-1)).then((h) =>
    h.evaluate((m: any) => ({ id: m.id, kind: m.kind, chain: m.chain, address: m.address, parentOrigin: m.parentOrigin, context: m.context, bytes: Array.from(m.bytes as Uint8Array) })),
  );
  const digest = Array.from(approvalDigest({ ...req, bytes: Uint8Array.from(req.bytes) } as Parameters<typeof approvalDigest>[0]));
  await evil.evaluate(
    async ([id, d]) => {
      const msg = { v: 1, t: 'hana:approve-result', id, approved: true, digest: Uint8Array.from(d as number[]) };
      for (let i = 0; i < 5; i++) {
        for (let f = 0; f < window.opener.frames.length; f++) window.opener.frames[f].postMessage(msg, '*');
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    [req.id, digest] as const,
  );
  await page.waitForTimeout(500);
  expect(await peek(page, 'sig')).toEqual({ state: 'pending' });
  // Still answerable by the real popup.
  await approve(popup);
  expect(await okValue(page, 'sig')).toMatchObject({ valid: true });
  expect((await received(evil)).length).toBe(0);
});
