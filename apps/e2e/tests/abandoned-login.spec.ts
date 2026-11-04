// A login the user never finishes (the bug report "the login popup appears, isn't completed, and after a while the demo
// freezes"): the popup left on Hana's method chooser, on Google's page, on the email address or code step, or closed.
// Each waits the vault's 5-minute limit (LOGIN_PENDING_MS; the page's clock is fast-forwarded past it), then the
// partner's login() rejects `login_timeout` (`data.stage: 'pending'`), the status is back to `logged_out`, and neither
// the vault frame nor the partner page is frozen. The follow-up screens (a link code, a banner), where the freeze was,
// are in linking.spec.ts. A popup closed after it connected isn't seen by the SDK (after `popup_connected` Google's COOP
// can make the handle report closed), so the partner shows "signing in" until the limit or its own cancelLogin().
import type { Page, TestInfo } from '@playwright/test';
import { GOOGLE_AUTH_URL } from '../src/google-stub.ts';
import { ISSUER_URL } from '../src/stack.ts';
import { LOGIN_PENDING_MS, clickAction, errorOf, expect, newApp, openPartner, peek, responsive, runAction, status, test, vaultFrame } from './fixtures.ts';

const address = (info: TestInfo, tag: string): string => `e2e-ab-${tag}-${info.project.name}-${crypto.randomUUID().slice(0, 8)}@mail-e2e.example.com`;
const mailCount = async (to: string): Promise<number> => ((await (await fetch(`${ISSUER_URL}/__e2e/outbox?to=${encodeURIComponent(to)}`)).json()) as unknown[]).length;

/** An app with email login (as the demo app on sandbox-dev), the page's clock installed; returns the login's popup. */
async function startLogin(page: Page, o: { email?: boolean; method?: 'email' } = {}): Promise<Page> {
  await page.clock.install();
  const app = await newApp(o.email === false ? {} : { loginMethods: 'google,email' });
  await openPartner(page, app);
  const popupP = page.waitForEvent('popup');
  if (o.method) await clickAction(page, 'login', 'loginWith', { method: o.method });
  else await clickAction(page, 'login', 'login');
  const popup = await popupP;
  await expect.poll(() => page.evaluate(() => (window as any).e2e.events.some((e: { name: string; data?: { stage?: string } }) => e.name === 'loginProgress' && e.data?.stage === 'popup_connected'))).toBe(true);
  return popup;
}

/** Past the vault's limit: login_timeout, logged out, and every frame still runs. */
async function expectTimedOut(page: Page): Promise<void> {
  expect(await status(page)).toBe('logging_in');
  // Just short of the limit nothing has happened yet.
  await page.clock.fastForward(LOGIN_PENDING_MS - 10_000);
  expect(await peek(page, 'login')).toEqual({ state: 'pending' });
  await page.clock.fastForward(11_000);
  expect(await errorOf(page, 'login', 10_000)).toEqual({ code: 'login_timeout', reason: null });
  expect(await page.evaluate(() => (window as any).e2e.results.login.data)).toEqual({ stage: 'pending' });
  expect(await status(page)).toBe('logged_out');
  expect(await responsive(vaultFrame(page)), 'the vault frame runs').toBe(true);
  expect(await responsive(page.mainFrame()), 'the partner page runs').toBe(true);
  // The vault still answers on its port (logged out: 4100).
  await runAction(page, 'acct', 'account');
  expect((await errorOf(page, 'acct', 5_000)).code).toBe(4100);
}

test('left on Hana’s method chooser: login_timeout at 5 minutes, nothing frozen', async ({ page }) => {
  const popup = await startLogin(page);
  await expect(popup.locator('#continue-google')).toBeVisible();
  await expectTimedOut(page);
});

test('left on Google’s page (an app with email login): login_timeout at 5 minutes, nothing frozen', async ({ page }) => {
  const popup = await startLogin(page);
  await popup.click('#continue-google');
  await popup.waitForURL(`${GOOGLE_AUTH_URL}**`);
  await expectTimedOut(page);
});

test('left on Google’s page (a Google-only app, token_first’s record-only login): login_timeout, nothing frozen', async ({ page }) => {
  const popup = await startLogin(page, { email: false });
  await popup.waitForURL(`${GOOGLE_AUTH_URL}**`);
  await expectTimedOut(page);
});

test('left on the email address step: login_timeout at 5 minutes, nothing frozen', async ({ page }) => {
  const popup = await startLogin(page, { method: 'email' });
  await expect(popup.locator('#email-address')).toBeVisible();
  await expectTimedOut(page);
});

test('left on the email code step: login_timeout at 5 minutes, nothing frozen', async ({ page }, info) => {
  const popup = await startLogin(page, { method: 'email' });
  const to = address(info, 'code');
  await popup.fill('#email-address', to);
  await popup.click('#email-send');
  await expect.poll(() => mailCount(to)).toBeGreaterThan(0);
  await expect(popup.locator('#email-code')).toBeVisible();
  await expectTimedOut(page);
});

test('the popup closed on the chooser: “signing in” until the limit (or cancelLogin), then login_timeout, nothing frozen', async ({ page }) => {
  const popup = await startLogin(page);
  await expect(popup.locator('#continue-google')).toBeVisible();
  await popup.close();
  await expectTimedOut(page);
});

test('the popup closed on Google’s page, then the partner cancels: login_cancelled at once, nothing frozen', async ({ page }) => {
  const popup = await startLogin(page);
  await popup.click('#continue-google');
  await popup.waitForURL(`${GOOGLE_AUTH_URL}**`);
  await popup.close();
  await runAction(page, 'cancel', 'cancelLogin');
  expect((await errorOf(page, 'login', 5_000)).code).toBe('login_cancelled');
  expect(await status(page)).toBe('logged_out');
  expect(await responsive(vaultFrame(page)), 'the vault frame runs').toBe(true);
  expect(await responsive(page.mainFrame()), 'the partner page runs').toBe(true);
});
