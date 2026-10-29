// Login through the popup and the relay (docs/batch-b-spec.md "Login"), and the partner-page COOP cases.
import { GoogleStub } from '../src/google-stub.ts';
import { API_URL, NEAR_RPC } from '../src/stack.ts';
import { LOGIN_ENDPOINT, VAULT_FRAME, chooseAccount, clickAction, clickLauncher, errorCode, expect, login, newApp, okValue, openPartner, routeStubs, status, test } from './fixtures.ts';

test('one click on the partner button plus the chooser logs in', async ({ page, google, requests }) => {
  const app = await newApp();
  expect(await openPartner(page, app)).toBe('ok');
  expect(await status(page)).toBe('logged_out');

  const popupP = page.waitForEvent('popup');
  await clickAction(page, 'login', 'login');
  const popup = await popupP;
  await chooseAccount(popup);
  const addresses = await okValue<{ stellar: string; evm: string }>(page, 'login');

  expect(addresses.stellar).toMatch(/^G[A-Z2-7]{55}$/u);
  expect(addresses.evm).toMatch(/^0x[0-9a-fA-F]{40}$/u);
  expect(await status(page)).toBe('logged_in');
  // The openid-only implicit request, once; one combined login transaction, no split flow, no derive.
  expect(google.requests).toHaveLength(1);
  expect(google.requests[0]?.ok).toBe(true);
  expect(requests.count(`${API_URL}/v1/login-relay/`)).toBeGreaterThanOrEqual(2);
  expect(requests.count(LOGIN_ENDPOINT)).toBe(1);
  expect(requests.count(`${API_URL}/v1/derive`)).toBe(0);
  // A clean login reads NEAR once: the vault's registry check of its scope (Q7). Re-syncs are only for failures.
  expect(requests.count(NEAR_RPC)).toBe(1);
});

test('the same Google account gets the same addresses on another device, another account other ones', async ({ page, browser }) => {
  const app = await newApp();
  await openPartner(page, app);
  const first = await login(page);

  // Another browser profile ("device"), with its own Google stub key: only the Google account decides the addresses.
  const other = await browser.newContext();
  try {
    await routeStubs(other, new GoogleStub());
    const page2 = await other.newPage();
    await openPartner(page2, app);
    expect(await login(page2)).toEqual(first);
    await page2.evaluate(() => (window as any).e2e.run('logout', 'logout'));
    await okValue(page2, 'logout');
    const second = await login(page2, { account: 1, name: 'login2' });
    expect(second.stellar).not.toBe(first.stellar);
    expect(second.evm).not.toBe(first.evm);
  } finally {
    await other.close();
  }
});

test('closing the login popup and clicking login again works (supersede)', async ({ page }) => {
  const app = await newApp();
  await openPartner(page, app);

  const firstPopupP = page.waitForEvent('popup');
  await clickAction(page, 'first', 'login');
  const firstPopup = await firstPopupP;
  // Connected and at Google: the SDK no longer watches popup.closed (Google's COOP could make it report closed).
  await firstPopup.waitForURL(/accounts\.google\.com/u);
  await firstPopup.close();

  const addresses = await login(page, { name: 'second' });
  expect(addresses.evm).toMatch(/^0x/u);
  expect(await errorCode(page, 'first')).toBe('login_cancelled');
});

test('two partner tabs logging in at once each complete', async ({ context }) => {
  const app = await newApp();
  const [a, b] = [await context.newPage(), await context.newPage()];
  await openPartner(a, app);
  await openPartner(b, app);

  const popupA = a.waitForEvent('popup');
  await clickAction(a, 'login', 'login');
  const popupB = b.waitForEvent('popup');
  await clickAction(b, 'login', 'login');
  const [pa, pb] = [await popupA, await popupB];
  await Promise.all([chooseAccount(pa), chooseAccount(pb)]);

  const [ra, rb] = [await okValue<{ evm: string }>(a, 'login'), await okValue<{ evm: string }>(b, 'login')];
  expect(ra).toEqual(rb);
});

test("a blocked popup falls back to the vault's \"Sign in with Hana\" launcher", async ({ page }) => {
  const app = await newApp();
  await openPartner(page, app, { blockPopups: true });
  await clickAction(page, 'login', 'login');
  const popup = await clickLauncher(page, 'Sign in with Hana');
  // Opened by the vault itself (vault mode), from its own click.
  expect(new URL(popup.url()).search).toBe('?from=vault');
  await chooseAccount(popup);
  expect((await okValue<{ stellar: string }>(page, 'login')).stellar).toMatch(/^G/u);
  await expect(page.locator(VAULT_FRAME)).toBeHidden();
});

test('Google #error ends the login with google_error', async ({ page }) => {
  const app = await newApp();
  await openPartner(page, app);
  const popupP = page.waitForEvent('popup');
  await clickAction(page, 'login', 'login');
  const popup = await popupP;
  await popup.waitForURL(/accounts\.google\.com/u);
  await popup.click('#deny');
  expect(await errorCode(page, 'login')).toBe('google_error');
  expect(await status(page)).toBe('logged_out');
});

test.describe('partner COOP', () => {
  test('same-origin gives coop_blocks_popup', async ({ page }) => {
    const app = await newApp();
    await openPartner(page, app, { coop: 'same-origin' });
    const popupP = page.waitForEvent('popup');
    await clickAction(page, 'login', 'login');
    const popup = await popupP;
    expect(await errorCode(page, 'login')).toBe('coop_blocks_popup');
    // The popup, cut off from its opener, says why (unless the SDK already closed it).
    if (!popup.isClosed()) await expect(popup.getByRole('heading')).toContainText(/COOP/u);
  });

  test('same-origin-allow-popups works', async ({ page }) => {
    const app = await newApp();
    await openPartner(page, app, { coop: 'same-origin-allow-popups' });
    const addresses = await login(page);
    expect(addresses.stellar).toMatch(/^G/u);
  });
});

test('an IdP that enforces COOP same-origin still completes through the relay', async ({ page, google, browserName }) => {
  // The popup switches browsing context groups at Google and again at the callback: the opener is gone, and the
  // relayKey must survive in the popup's sessionStorage.
  google.coop = 'same-origin';
  const app = await newApp();
  await openPartner(page, app);
  const popupP = page.waitForEvent('popup');
  await clickAction(page, 'login', 'login');
  const popup = await popupP;
  await popup.waitForURL(/accounts\.google\.com/u);
  const severed = await popup.evaluate(() => window.opener === null);
  if (browserName === 'webkit') {
    // Playwright's WebKit doesn't apply COOP to a route-fulfilled response (it does to served ones: see the partner
    // COOP cases), so there this case checks the relay path without the browsing-context switch.
    test.info().annotations.push({ type: 'webkit', description: `COOP on the stub ${severed ? 'applied' : 'not applied'}` });
  } else {
    expect(severed).toBe(true);
  }
  await popup.click('#account-0');
  const addresses = await okValue<{ stellar: string }>(page, 'login');
  expect(addresses.stellar).toMatch(/^G/u);
});

test('the callback closes itself right after its relay POST, and the token still arrives', async ({ page }) => {
  const app = await newApp();
  await openPartner(page, app);
  const popupP = page.waitForEvent('popup');
  await clickAction(page, 'login', 'login');
  const popup = await popupP;
  const order: string[] = [];
  popup.on('response', (r) => {
    if (r.url().includes('/v1/login-relay/') && r.request().method() === 'POST') order.push(`relay ${r.status()}`);
  });
  popup.on('close', () => order.push('closed'));
  await chooseAccount(popup);
  expect(order).toEqual(['relay 204', 'closed']);
  expect((await okValue<{ evm: string }>(page, 'login')).evm).toMatch(/^0x/u);
});
