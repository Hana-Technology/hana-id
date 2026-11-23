// The hosted demo (apps/demo): its built page, served by its own Worker handler with its real CSP and headers, logs in
// through the vault, signs, reports timings and diagnostics, and shows plain messages for the failures a reviewer can
// hit. The page is configured at build time like the deployed one (src/build.ts DEMO_CONFIG), so its app has a fixed
// key (DEMO_PK) that every test and browser shares; each test still runs in its own browser context.
import { type Page } from '@playwright/test';
import { routeNearRelayer } from '../src/near-relay.ts';
import { DEMO_ORIGIN, DEMO_PK, E2E_GUESTBOOK, VAULT_ORIGIN } from '../src/stack.ts';
import { expectPlainWindow } from './plain-checks.ts';
import { DEMO_APP, LOGIN_ENDPOINT, LOGIN_PENDING_MS, VAULT_FRAME, approve, chooseAccount, clickLauncher, expect, newApp, responsive, test, vaultFrame, walletDirectory } from './fixtures.ts';

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
  await newApp(DEMO_APP);
  await recordCspViolations(page);
  const res = await page.goto(`${DEMO_ORIGIN}/`);
  expect(res?.status()).toBe(200);
  await expect(page.locator('#status')).toHaveText('Signed out.');
}

async function loginOnDemo(page: Page): Promise<void> {
  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Sign in with Google' }).click();
  await chooseAccount(await popup);
  await expect(page.locator('#status')).toContainText('Signed in');
}

test('the demo logs in, shows addresses and timings, signs, and copies safe diagnostics, under its own CSP', async ({ page, requests }) => {
  await openDemo(page);
  const res = await page.request.get(`${DEMO_ORIGIN}/`);
  const csp = res.headers()['content-security-policy'] ?? '';
  expect(csp).toContain(`frame-src ${VAULT_ORIGIN};`);
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toContain('unsafe-');
  expect(res.headers()).toMatchObject({ 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cross-origin-opener-policy': 'same-origin-allow-popups' });
  await expect(page.getByText('This demo uses test networks only (Stellar, EVM and NEAR), so nothing here holds real money.')).toBeVisible();

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
  await expect(page.frameLocator(VAULT_FRAME).getByRole('button', { name: 'Review in Journear Passport' })).toHaveCount(0);
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

  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.locator('#status')).toHaveText('Signed out.');
  await expect(page.locator('#wallet')).toBeHidden();
  expect(await cspViolations(page)).toEqual([]);
});

/** A Google account of the stub's never used before (a new sub, so a new wallet and NEAR account). */
function freshAccount(): { sub: string; label: string; email: string; emailVerified: boolean } {
  const digits = Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => String(b % 10)).join('');
  return { sub: `1${digits}`, label: 'NEAR demo', email: `e2enear${digits.slice(0, 10)}@gmail.com`, emailVerified: true };
}

// Hana's NEAR relayer, mocked at the network layer (src/near-relay.ts, shared with the hand-test browser, D880; the
// stack runs no relay account; apps/api's test/near-demo-page.test.ts drives the page's own bytes and the SDK's requests
// through the real routes instead).

test('the demo writes to the NEAR guestbook with zero NEAR: activate, approve the relayed delegate action, see the message', async ({ page, google }, testInfo) => {
  // A Google account of its own, so a NEAR account of its own: the stack's chain and guestbook are shared by every
  // browser and test, and two writers on one account would take each other's nonces.
  google.accounts = [freshAccount()];
  const text = `gm from the e2e stack (${testInfo.project.name} ${testInfo.repeatEachIndex})`;
  const relayer = await routeNearRelayer(page, ['demo']);
  await openDemo(page);
  await expect(page.locator('#near')).toBeHidden();
  await loginOnDemo(page);
  await expect(page.locator('#near')).toBeVisible();
  const account = (await page.locator('#near-account-full').textContent()) ?? '';
  expect(account).toMatch(/^[0-9a-f]{64}$/u);
  await expect(page.locator('#near-balance')).toHaveText(/^Not on NEAR’s test network yet/u);
  // Typing activates a new account before the click (the relayer's zero-value transfer).
  await page.locator('#near-text').fill(text);
  await expect(page.locator('#near-balance')).toHaveText('Balance: 0 NEAR. The guestbook write needs none.');

  const approvalP = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Write to the guestbook (no NEAR needed)' }).click();
  const approval = await approvalP;
  // The click opened the approval itself: no "Review in Journear Passport" button.
  await expect(page.frameLocator(VAULT_FRAME).getByRole('button', { name: 'Review in Journear Passport' })).toHaveCount(0);
  await expect(page.locator('#near-stage')).toHaveText('Waiting for your approval in the Journear Passport window…');
  // D808: the plain summary leads; the request's kind heading is in the details.
  // D885: the demo guestbook's write is a reviewed call: plain words, the contract named as checked by Journear.
  await expect(approval.locator('h2.summary-headline')).toHaveText(/wants to add a message to the demo guestbook$/u);
  await expect(approval.locator('p.summary-line').last()).toHaveText(`It uses Journear demo guestbook (${E2E_GUESTBOOK}, checked by Journear).`);
  // The user's words, quoted; the raw method stays in the folded details.
  await expect(approval.locator('div.summary-quote')).toHaveText(text);
  await expect(approval.locator('details.request-details')).toContainText('add_message');
  await expect(approval.getByText(E2E_GUESTBOOK).first()).toBeVisible();
  await expect(approval.locator('.warning-box')).toHaveCount(0);
  await expectPlainWindow(approval);
  await approve(approval);

  await expect(page.locator('#near-done-text')).toHaveText('Written to the guestbook on NEAR’s test network. Your NEAR account was created for it. Journear paid the network fee, so it cost you nothing.');
  expect(relayer.guestbook).toEqual([text]);
  const first = page.locator('#near-messages li', { hasText: text });
  await expect(first.locator('.text')).toHaveText(text);
  await expect(first.locator('.you')).toHaveText('you');
  await expect(first.locator('.author')).toHaveAttribute('title', account);
  // The vault recorded the NEAR account in the stack's real wallet directory, which the mocked relayer consulted.
  await expect.poll(async () => (await walletDirectory(account)).some((u) => u.wallets.some((w) => w.chain === 'near' && w.address === account))).toBe(true);
  expect(relayer.problems).toEqual([]);
  expect(await cspViolations(page)).toEqual([]);
});

test('the demo writes to the guestbook when clicked before Hana recorded the NEAR account: it waits and retries', async ({ page, google }, testInfo) => {
  google.accounts = [freshAccount()];
  const text = `before the record (${testInfo.project.name} ${testInfo.repeatEachIndex})`;
  // The first two answers say the account isn't recorded yet (409 near_account_unrecorded), as right after a login.
  const relayer = await routeNearRelayer(page, ['demo'], { unrecorded: 2 });
  await openDemo(page);
  await loginOnDemo(page);
  await expect(page.locator('#near')).toBeVisible();
  // The text set without focus or typing, so nothing was prepared before the click.
  await page.locator('#near-text').evaluate((el, t) => ((el as HTMLInputElement).value = t), text);
  const approvalP = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Write to the guestbook (no NEAR needed)' }).click();
  const approval = await approvalP;
  // D808: the plain summary leads; the request's kind heading is in the details.
  // D885: the demo guestbook's write is a reviewed call: plain words, the contract named as checked by Journear.
  await expect(approval.locator('h2.summary-headline')).toHaveText(/wants to add a message to the demo guestbook$/u);
  await expect(approval.locator('p.summary-line').last()).toHaveText(`It uses Journear demo guestbook (${E2E_GUESTBOOK}, checked by Journear).`);
  await approve(approval);
  await expect(page.locator('#near-done')).toBeVisible();
  expect(relayer.refused.length).toBeGreaterThanOrEqual(2);
  expect(relayer.guestbook).toEqual([text]);
  await expect(page.locator('#near-messages li', { hasText: text }).locator('.you')).toHaveText('you');
  await expect(page.locator('#near-error')).toBeHidden();
  expect(relayer.problems).toEqual([]);
});

test('the demo explains a blocked popup, then signs in through the Hana button', async ({ page }) => {
  await page.addInitScript((origin) => {
    // What a popup blocker does: the SDK falls back to the vault's "Sign in with Journear Passport" launcher.
    if (location.origin === origin) window.open = () => null;
  }, DEMO_ORIGIN);
  await openDemo(page);
  await page.getByRole('button', { name: 'Sign in with Google' }).click();
  await expect(page.locator('#notice')).toHaveText('Click “Sign in with Journear Passport” on the Journear button at the bottom right of the page to continue.');
  const popup = await clickLauncher(page, 'Sign in with Journear Passport');
  await chooseAccount(popup);
  await expect(page.locator('#status')).toContainText('Signed in');
  await expect(page.locator('#notice')).toBeHidden();
  expect(await cspViolations(page)).toEqual([]);
});

test('the demo shows plain messages for a cancelled sign-in, and for one cancelled at Google then closed', async ({ page }) => {
  await openDemo(page);
  const first = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Sign in with Google' }).click();
  await (await first).waitForURL(/accounts\.google\.com/u);
  await page.getByRole('button', { name: 'Cancel sign-in' }).click();
  await expect(page.getByRole('alert')).toHaveText('Sign-in cancelled.');

  const second = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Sign in with Google' }).click();
  const popup = await second;
  await popup.waitForURL(/accounts\.google\.com/u);
  // Cancel at Google: the popup goes back to Hana's chooser (D341); closing it there is a cancelled sign-in.
  await popup.click('#deny');
  await expect(popup.locator('#google-cancelled')).toHaveText('Google sign-in was cancelled.');
  await popup.close();
  await expect(page.getByRole('alert')).toHaveText('Sign-in cancelled.');
  await expect(page.locator('#status')).toHaveText('Signed out.');
});

test('an unfinished sign-in: “Signing in…” with Cancel until the vault’s 5 minutes, then a plain message; the page never freezes', async ({ page }) => {
  await page.clock.install();
  await openDemo(page);
  const opened = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Sign in with Google' }).click();
  const popup = await opened;
  await popup.waitForURL(/accounts\.google\.com/u);
  // Left open on Google's page without finishing: the page keeps showing the sign-in with its Cancel until the vault's
  // limit. (A popup closed there ends sooner, with login_cancelled: popup-close.spec.ts, D347 and D398.)
  await expect(page.locator('#status')).toHaveText('Signing in…');
  await expect(page.getByRole('button', { name: 'Cancel sign-in' })).toBeVisible();
  await page.clock.fastForward(LOGIN_PENDING_MS + 1_000);
  await expect(page.getByRole('alert')).toHaveText('The sign-in wasn’t finished within 5 minutes, so it stopped. Sign in again when you’re ready.');
  await expect(page.locator('#status')).toHaveText('Signed out.');
  await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeEnabled();
  expect(await responsive(page.mainFrame()), 'the demo page runs').toBe(true);
  expect(await responsive(vaultFrame(page)), 'the vault frame runs').toBe(true);
});
