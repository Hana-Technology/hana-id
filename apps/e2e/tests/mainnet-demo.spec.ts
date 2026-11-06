// The mainnet demo exception to D39 (D426, D427) and the key export additions (D428), in the real pages: a test app
// with Hana's demo switch on signs a small Stellar public-network payment through the approval popup, which shows the
// red banner, the request's value and the wallet's balance (read from Hana's pinned Horizon, routed here); a payment
// over the $9.99 cap is refused before any popup, with the launcher saying why; an app without the switch is refused
// as D39 says. The export window's guarded reveal hides the key again after 60 s.
//
// With HANA_SHOTS_DIR set (Chromium only) it also saves the screens for review; a shown key is masked in them.
import { addressOfExport } from '@hana-id/core';
import type { BrowserContext, Locator, Page } from '@playwright/test';
import { approve, chooseAccount, clickLauncher, errorOf, expect, guardedClick, launcher, login, newApp, okValue, openPartner, runAction, test } from './fixtures.ts';

const SHOTS = process.env.HANA_SHOTS_DIR;

async function shot(page: Page, name: string, browserName: string, mask: Locator[] = []): Promise<void> {
  if (!SHOTS || browserName !== 'chromium') return;
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true, mask, animations: 'disabled' });
}

/** Horizon's account answer for the approval popup's balance line (never the real network in a test). */
async function routeHorizon(context: BrowserContext, xlm: string): Promise<void> {
  await context.route('https://horizon.stellar.org/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ balances: [{ asset_type: 'native', balance: xlm }] }) }),
  );
  await context.route('https://mainnet.base.org/**', (route) => route.fulfill({ status: 500, body: 'not in this test' }));
}

test('a demo app signs a small Stellar public-network payment behind the red banner, with the balance warning', async ({ page, browserName }) => {
  await routeHorizon(page.context(), '25.0000000');
  const app = await newApp({ mainnetDemo: true });
  await openPartner(page, app);
  const { stellar } = await login(page);
  // The page learns the exception and its rules from the vault (hana.mainnetDemo).
  const demo = await page.evaluate(() => (window as unknown as { e2e: { hana: { mainnetDemo: unknown } } }).e2e.hana.mainnetDemo);
  expect(demo).toMatchObject({ evmChains: [8453], stellarNetworkPassphrase: 'Public Global Stellar Network ; September 2015', txCapUsd: '9.99' });
  await runAction(page, 'sig', 'stellarSignPubnet', '2');
  const popup = await clickLauncher(page, 'Review in Hana');
  await expect(popup.getByText('Real funds, test custody: these funds may be lost')).toBeVisible();
  await expect(popup.getByText('This request can move about $2.01, fee included. Hana’s limit is $9.99 per transaction.')).toBeVisible();
  await expect(popup.getByText('This wallet holds about $25.00: keep test funds under $10.00 — move the rest out.')).toBeVisible();
  await shot(popup, 'mainnet-1-approval-banner', browserName);
  await approve(popup);
  expect(await okValue(page, 'sig')).toEqual({ signerAddress: stellar });
});

test('over the cap: refused before any popup, and the launcher says why; without the switch, D39 refuses', async ({ page, browserName }) => {
  await routeHorizon(page.context(), '5.0000000');
  const app = await newApp({ mainnetDemo: true });
  await openPartner(page, app);
  await login(page);
  await runAction(page, 'big', 'stellarSignPubnet', '20');
  expect(await errorOf(page, 'big')).toMatchObject({ code: 4100, reason: 'mainnet_demo_over_cap' });
  await expect(launcher(page).getByText('Refused: over Hana’s $9.99 mainnet demo limit per transaction')).toBeVisible();
  await shot(page, 'mainnet-2-cap-refusal', browserName);

  const plain = await newApp();
  await openPartner(page, plain);
  await login(page);
  expect(await page.evaluate(() => (window as unknown as { e2e: { hana: { mainnetDemo: unknown } } }).e2e.hana.mainnetDemo)).toBeNull();
  await runAction(page, 'off', 'stellarSignPubnet', '1');
  expect(await errorOf(page, 'off')).toMatchObject({ code: 4100, reason: 'mainnet_not_allowed' });
});

test('key export: plain warnings, a fresh sign-in, a guarded reveal that hides again after 60 s', async ({ page, browserName }) => {
  await page.clock.install();
  const app = await newApp();
  await openPartner(page, app);
  const addresses = await login(page);
  await runAction(page, 'export', 'exportKey', 'stellar');
  const exportWindow = await clickLauncher(page, 'Export key in Hana');
  await expect(exportWindow.getByText('Anyone with this key controls your funds', { exact: false })).toBeVisible();
  await shot(exportWindow, 'export-1-warnings', browserName);

  const childP = exportWindow.waitForEvent('popup');
  await exportWindow.getByRole('button', { name: 'Sign in with Google to continue' }).click();
  const child = await childP;
  await shot(child, 'export-2-reauth', browserName);
  await chooseAccount(child);

  await exportWindow.getByRole('textbox').fill('EXPORT');
  await shot(exportWindow, 'export-3-confirm', browserName);
  await guardedClick(exportWindow, 'Continue');
  const secret = exportWindow.locator('code.secret');
  await expect(secret).toHaveText('••••••••');
  await guardedClick(exportWindow, 'Show key');
  await expect(secret).toHaveText(/^S[A-Z2-7]{55}$/u);
  expect(addressOfExport('stellar', (await secret.textContent()) ?? '')).toBe(addresses.stellar);
  // The key itself is masked in the saved screen.
  await shot(exportWindow, 'export-4-reveal-masked', browserName, [secret]);
  await exportWindow.clock.fastForward(60_000);
  await expect(secret).toHaveText('••••••••');
  await expect(exportWindow.getByRole('button', { name: 'Show key' })).toBeVisible();
  await shot(exportWindow, 'export-5-auto-hidden', browserName);
});
