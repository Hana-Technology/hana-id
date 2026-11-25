// Passport Home on a wallet several partners' apps share (D925; docs/partner-platform-spec.md B6, D913 question 10),
// against the real API on the stack: a person signs in on a partner app made after its scope was marked as shared, then
// opens Home. The wallet's page says that the company behind these apps can see which of them the person uses, and
// labels its Support ID (the person's code for the whole scope, which the partner's page doesn't show) as Journear's
// own; a wallet of an ordinary scope keeps the usual words.
//
// With HANA_SHOTS_DIR set (Chromium only), the shared wallet's page is saved there at 1280 and 390 px, light and dark.
import { AUTH_ORIGIN } from '../src/stack.ts';
import { chooseAccount, expect, login, newApp, openPartner, test, walletDirectory } from './fixtures.ts';
import { shots } from './home-steps.ts';

const SEEN = 'The company behind these apps can see which of them you use with this wallet.';
const SUPPORT_LINE = 'Give this only to Journear support, not to an app’s support team. If an app’s support team asks for your Support ID, give them the one that app shows you.';

async function openHome(context: import('@playwright/test').BrowserContext) {
  const home = await context.newPage();
  await home.goto(`${AUTH_ORIGIN}/home`);
  const childP = home.waitForEvent('popup');
  await home.getByRole('button', { name: 'Continue with Google' }).click();
  await chooseAccount(await childP);
  await expect(home.getByText('Signed in with Google')).toBeVisible();
  return home;
}

test('a shared wallet: the line about the company behind its apps, and the Support ID labelled as Journear’s own', async ({ page, context, browserName }) => {
  // A scope of this run's own: an app of before, then the mark, then a partner's app made after it.
  const scopeId = `hs${browserName.slice(0, 2)}${Date.now().toString(36)}`;
  await newApp({ name: 'Coffee Club', scopeId });
  const app = await newApp({ name: 'Stamp Rally', scopeId, sharedScope: true });
  await openPartner(page, app);
  const addresses = await login(page);
  // The partner's page shows the app's own Support ID.
  const pageSupportId = (await page.evaluate(() => (window as any).e2e.supportId())) as string;
  await expect.poll(async () => (await walletDirectory(addresses.stellar)).length, { timeout: 15_000 }).toBe(1);
  const [user] = await walletDirectory(addresses.stellar);
  const scopeCode = `HANA-${user!.supportCode.slice(0, 4)}-${user!.supportCode.slice(4)}`;
  expect(pageSupportId).not.toBe(scopeCode);

  const home = await openHome(context);
  await home.locator(`.home-row[data-scope="${scopeId}"]`).click();
  await expect(home.getByRole('heading', { level: 1, name: 'Wallet details' })).toBeFocused();
  await expect(home.locator('#home-shared-seen')).toHaveText(SEEN);
  // Home shows the person's code for the whole scope (what Journear and the network look up), labelled as Journear's.
  await expect(home.locator('#home-support-id')).toHaveText(scopeCode);
  await expect(home.getByRole('heading', { level: 2, name: 'Journear Support ID' })).toBeVisible();
  await expect(home.locator('#home-support-line')).toHaveText(SUPPORT_LINE);
  await shots(home, 'after-home-shared-wallet', browserName);
});

test('an ordinary wallet: no such line, the usual Support ID words', async ({ page, context, browserName }) => {
  const scopeId = `ho${browserName.slice(0, 2)}${Date.now().toString(36)}`;
  const app = await newApp({ name: 'Plain Wallet', scopeId });
  await openPartner(page, app);
  const addresses = await login(page);
  await expect.poll(async () => (await walletDirectory(addresses.stellar)).length, { timeout: 15_000 }).toBeGreaterThan(0);
  const home = await openHome(context);
  await home.locator(`.home-row[data-scope="${scopeId}"]`).click();
  await expect(home.getByRole('heading', { level: 1, name: 'Wallet details' })).toBeFocused();
  await expect(home.locator('#home-shared-seen')).toHaveCount(0);
  await expect(home.getByRole('heading', { level: 2, name: 'Support ID', exact: true })).toBeVisible();
  await expect(home.locator('#home-support-line')).toHaveText('Give this to the app’s support team if you need help. It doesn’t reveal your email or your Google account.');
});
