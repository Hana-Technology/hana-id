// The hosted demo (apps/demo): its built page, served by its own Worker handler with its real CSP and headers, logs in
// through the vault, signs, reports timings and diagnostics, and shows plain messages for the failures a reviewer can
// hit. The page is configured at build time like the deployed one (src/build.ts DEMO_CONFIG), so its app has a fixed
// key (DEMO_PK) that every test and browser shares; each test still runs in its own browser context.
import { type Page } from '@playwright/test';
import { DEMO_ORIGIN, DEMO_PK, VAULT_ORIGIN } from '../src/stack.ts';
import { LOGIN_ENDPOINT, LOGIN_PENDING_MS, VAULT_FRAME, approve, chooseAccount, clickLauncher, expect, newApp, responsive, test, vaultFrame } from './fixtures.ts';

/** Records every CSP violation on the demo's own document (the page CSP must allow everything the page does). */
async function recordCspViolations(page: Page): Promise<void> {
  await page.addInitScript((origin) => {
    if (location.origin !== origin) return;
    const seen: string[] = [];
    (window as any).__cspViolations = seen;
    document.addEventListener('securitypolicyviolation', (e) => seen.push(`${e.effectiveDirective} ${e.blockedURI}`));
  }, DEMO_ORIGIN);
}

const cspViolations = (page: Page): Promise<string[]> => page.evaluate(() => (window as any).__cspViolations as string[]);

async function openDemo(page: Page): Promise<void> {
  await newApp({ name: 'Hana ID demo', origins: [DEMO_ORIGIN], publishableKey: DEMO_PK });
  await recordCspViolations(page);
  const res = await page.goto(`${DEMO_ORIGIN}/`);
  expect(res?.status()).toBe(200);
  await expect(page.locator('#status')).toHaveText('Logged out.');
}

async function loginOnDemo(page: Page): Promise<void> {
  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Log in with Google' }).click();
  await chooseAccount(await popup);
  await expect(page.locator('#status')).toContainText('Logged in');
}

test('the demo logs in, shows addresses and timings, signs, and copies safe diagnostics, under its own CSP', async ({ page, requests }) => {
  await openDemo(page);
  const res = await page.request.get(`${DEMO_ORIGIN}/`);
  const csp = res.headers()['content-security-policy'] ?? '';
  expect(csp).toContain(`frame-src ${VAULT_ORIGIN};`);
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toContain('unsafe-');
  expect(res.headers()).toMatchObject({ 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cross-origin-opener-policy': 'same-origin-allow-popups' });
  await expect(page.getByText('Testnet demo — test networks only, nothing here holds real funds.')).toBeVisible();

  await loginOnDemo(page);
  await expect(page.locator('#stellar-address')).toHaveText(/^G[A-Z2-7]{55}$/u);
  await expect(page.locator('#evm-address')).toHaveText(/^0x[0-9a-fA-F]{40}$/u);
  await expect(page.locator('#status')).toContainText('persistence: session');
  expect(requests.count(LOGIN_ENDPOINT)).toBe(1);

  await page.getByText('Login timings').click();
  const cells = page.locator('#timings tr').first().locator('td');
  await expect(cells).toHaveCount(9);
  await expect(cells.nth(1)).toHaveText('google'); // the method
  await expect(cells.nth(4)).toHaveText(/^\d+$/u); // sign-in: the `google` stage
  await expect(cells.nth(6)).toHaveText(/^\d+$/u); // the chain stage, from the vault (a pk_test_ app)

  // personal_sign: the click opens the approval popup itself, with no launcher (D99); then a Stellar message and the
  // test transaction in the same popup, which waits for follow-ups.
  const approvalP = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Sign a message (EVM personal_sign)' }).click();
  const approval = await approvalP;
  expect(new URL(approval.url()).searchParams.get('from')).toBe('partner');
  await approve(approval);
  await expect(page.frameLocator(VAULT_FRAME).getByRole('button', { name: 'Review in Hana' })).toHaveCount(0);
  await expect(page.locator('#results li').first()).toContainText('EVM personal_sign: signed');
  await expect(page.locator('#results li').first().locator('code')).toHaveText(/^0x[0-9a-f]{130}$/u);

  await page.getByRole('button', { name: 'Sign a message (Stellar)' }).click();
  await approve(approval);
  await expect(page.locator('#results li').first()).toContainText('Stellar message: signed');

  await page.getByRole('button', { name: 'Sign a test transaction (Local test chain)' }).click();
  await approve(approval);
  await expect(page.locator('#results li').first()).toContainText('Local test chain transaction (0 to yourself, not broadcast): signed');
  await expect(page.locator('#results li').first().locator('code')).toHaveText(/^0x02[0-9a-f]+$/u);

  await page.getByRole('button', { name: 'Copy diagnostics' }).click();
  const text = (await page.locator('#diagnostics').textContent()) ?? '';
  const d = JSON.parse(text) as Record<string, unknown>;
  expect(d).toMatchObject({ environment: 'local-e2e', appKey: `${DEMO_PK.slice(0, 12)}…`, status: 'logged_in', pageOrigin: DEMO_ORIGIN, vaultOrigin: VAULT_ORIGIN });
  expect((d.logins as unknown[]).length).toBe(1);
  expect(text).not.toContain(DEMO_PK);
  expect(text).not.toMatch(/eyJ|0x[0-9a-f]{64}/u);

  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page.locator('#status')).toHaveText('Logged out.');
  await expect(page.locator('#wallet')).toBeHidden();
  expect(await cspViolations(page)).toEqual([]);
});

test('the demo explains a blocked popup, then signs in through the Hana button', async ({ page }) => {
  await page.addInitScript((origin) => {
    // What a popup blocker does: the SDK falls back to the vault's "Sign in with Hana" launcher.
    if (location.origin === origin) window.open = () => null;
  }, DEMO_ORIGIN);
  await openDemo(page);
  await page.getByRole('button', { name: 'Log in with Google' }).click();
  await expect(page.locator('#notice')).toHaveText('Click “Sign in with Hana” on the Hana button at the bottom right of the page to continue.');
  const popup = await clickLauncher(page, 'Sign in with Hana');
  await chooseAccount(popup);
  await expect(page.locator('#status')).toContainText('Logged in');
  await expect(page.locator('#notice')).toBeHidden();
  expect(await cspViolations(page)).toEqual([]);
});

test('the demo shows plain messages for a cancelled sign-in, and for one cancelled at Google then closed', async ({ page }) => {
  await openDemo(page);
  const first = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Log in with Google' }).click();
  await (await first).waitForURL(/accounts\.google\.com/u);
  await page.getByRole('button', { name: 'Cancel sign-in' }).click();
  await expect(page.getByRole('alert')).toHaveText('Sign-in cancelled.');

  const second = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Log in with Google' }).click();
  const popup = await second;
  await popup.waitForURL(/accounts\.google\.com/u);
  // Cancel at Google: the popup goes back to Hana's chooser (D341); closing it there is a cancelled sign-in.
  await popup.click('#deny');
  await expect(popup.locator('#google-cancelled')).toHaveText('Google sign-in was cancelled.');
  await popup.close();
  await expect(page.getByRole('alert')).toHaveText('Sign-in cancelled.');
  await expect(page.locator('#status')).toHaveText('Logged out.');
});

test('an unfinished sign-in: “Signing in…” with Cancel until the vault’s 5 minutes, then a plain message; the page never freezes', async ({ page }) => {
  await page.clock.install();
  await openDemo(page);
  const opened = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Log in with Google' }).click();
  const popup = await opened;
  await popup.waitForURL(/accounts\.google\.com/u);
  // Left open on Google's page without finishing: the page keeps showing the sign-in with its Cancel until the vault's
  // limit. (A popup closed there ends sooner, with login_cancelled: popup-close.spec.ts, D347 and D398.)
  await expect(page.locator('#status')).toHaveText('Signing in…');
  await expect(page.getByRole('button', { name: 'Cancel sign-in' })).toBeVisible();
  await page.clock.fastForward(LOGIN_PENDING_MS + 1_000);
  await expect(page.getByRole('alert')).toHaveText('The sign-in wasn’t finished within 5 minutes, so it stopped. Log in again when you’re ready.');
  await expect(page.locator('#status')).toHaveText('Logged out.');
  await expect(page.getByRole('button', { name: 'Log in with Google' })).toBeEnabled();
  expect(await responsive(page.mainFrame()), 'the demo page runs').toBe(true);
  expect(await responsive(vaultFrame(page)), 'the vault frame runs').toBe(true);
});
