// The hosted demo's gas-free check-in card (apps/demo src/gas-free-card.ts, D867), end to end on the stack: the demo's
// build carries the env's sponsorship block (src/build.ts DEMO_CONFIG `evmSponsor`), the stack's API sponsors the demo's
// app for exactly `checkIn()` to Journear's pinned check-in (src/stack.ts E2E_DEMO_SPONSOR_TARGETS), the vault shows its
// one approval window and sends, the real relayer object broadcasts, and the mocked chain runs the check-in and counts
// it (src/server/partner.ts MockEvm). The demo's app is shared by every test and browser (DEMO_PK), so each test signs
// in with a Google account of its own: an EVM account of its own, whose first check-in carries the one-time setup.
//
// Covered: the first check-in (the setup note) and the second (none), with the count; a rejection (quiet); the day's
// budget used up (prepare's answer, the refusal in the SDK's words); paused (the status answer: the note, the button
// off); and no card at all when the app isn't sponsored. The three answers that aren't the stack's own are changed in
// this test's browser context only (Playwright routes), so no other test or browser sees them.
//
// With HANA_SHOTS_DIR=<dir> (Chromium only) it saves the card idle, the approval window (first time), in progress, done
// and a refusal, at phone width (390) and on desktop, light theme.
import { type Page, type Route } from '@playwright/test';
import { DEMO_CHECK_IN } from '@hana-id/core';
import { API_URL, DEMO_ORIGIN, EVM_CHAIN_ID } from '../src/stack.ts';
import { DEMO_APP, approve, chooseAccount, expect, newApp, reject, test } from './fixtures.ts';
import { expectPlainWindow } from './plain-checks.ts';

const SHOTS = process.env.HANA_SHOTS_DIR;
const VIEWPORTS = { phone: { width: 390, height: 844 }, desktop: { width: 1100, height: 1000 } } as const;
const POPUP = { phone: { width: 390, height: 760 }, desktop: { width: 420, height: 680 } } as const;
const CHECK_IN = (DEMO_CHECK_IN[EVM_CHAIN_ID] as { address: string }).address;
const SETUP = 'One-time setup: this also turns on free network fees for your account on the local test network. Your address stays the same and you still approve every action.';
const DONE = 'Done. You checked in. The network fee was paid for you: you paid nothing.';
const APPROVING = 'Approve the check-in in the Journear Passport window.';
const FINISHING = 'Checking you in. This takes a few seconds. If you haven’t approved it yet, go back to the Journear Passport window.';

function freshAccount(): { sub: string; label: string; email: string; emailVerified: boolean } {
  const digits = Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => String(b % 10)).join('');
  return { sub: `1${digits}`, label: 'Gas-free demo', email: `e2egasfree${digits.slice(0, 10)}@gmail.com`, emailVerified: true };
}

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

const sponsorRoute = (path: string) => (url: URL) => url.origin === new URL(API_URL).origin && url.pathname === `/v1/evm/sponsor/${path}`;

/** The API's real answer to a sponsorship route, with `patch` merged into its JSON (this browser context only). */
async function patched(route: Route, patch: Record<string, unknown>): Promise<void> {
  if (route.request().method() === 'OPTIONS') return route.fallback();
  const response = await route.fetch();
  const body = (await response.json()) as Record<string, unknown>;
  await route.fulfill({ response, json: { ...body, ...patch } });
}

async function recordCspViolations(page: Page): Promise<void> {
  await page.addInitScript((origin) => {
    if (location.origin !== origin) return;
    const seen: string[] = [];
    (window as any).__cspViolations = seen;
    document.addEventListener('securitypolicyviolation', (e) => seen.push(`${e.effectiveDirective} ${e.blockedURI}`));
  }, DEMO_ORIGIN);
}

/** Opens the demo and signs in with a Google account of the test's own; waits for the sponsorship answer. */
async function signedIn(page: Page): Promise<void> {
  await newApp(DEMO_APP);
  await recordCspViolations(page);
  await page.setViewportSize(VIEWPORTS.desktop);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(`${DEMO_ORIGIN}/`);
  await expect(page.locator('#status')).toHaveText('Signed out.');
  const status = page.waitForResponse((r) => sponsorRoute('status')(new URL(r.url())) && r.request().method() === 'GET');
  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Sign in with Google' }).click();
  await chooseAccount(await popup);
  await expect(page.locator('#status')).toContainText('Signed in');
  expect((await status).status()).toBe(200);
}

async function shots(page: Page, name: string, browserName: string): Promise<void> {
  if (!SHOTS || browserName !== 'chromium') return;
  for (const [vp, size] of Object.entries(VIEWPORTS)) {
    await page.setViewportSize(size);
    // In the middle of the screen, clear of the sticky top bar.
    await page.locator('#gas-free').evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await page.locator('#gas-free').screenshot({ path: `${SHOTS}/card-${name}-${vp}.png`, animations: 'disabled' });
  }
  await page.setViewportSize(VIEWPORTS.desktop);
}

async function windowShots(popup: Page, name: string, browserName: string): Promise<void> {
  if (!SHOTS || browserName !== 'chromium') return;
  // As the user sees it once Approve is armed (the guard waits 1 s and a moving pointer).
  await popup.waitForTimeout(1_100);
  await popup.mouse.move(5, 5);
  await popup.mouse.move(40, 40, { steps: 3 });
  for (const [vp, size] of Object.entries(POPUP)) {
    await popup.setViewportSize(size);
    await popup.screenshot({ path: `${SHOTS}/window-${name}-${vp}.png`, fullPage: true, animations: 'disabled' });
  }
}

/** "Check in" in a real click: Journear Passport's window opens in it (D99). */
async function checkInWindow(page: Page): Promise<Page> {
  const popupP = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Check in', exact: true }).click();
  const popup = await popupP;
  await expect(popup.locator('h2.summary-headline')).toHaveText('Journear demo wants to check you in');
  await expect(popup.locator('.summary-failed')).toHaveCount(0);
  await expectPlainWindow(popup);
  return popup;
}

/** The window closed as a user would after it answered (the vault keeps an idle one a moment for the next request). */
async function closeWindow(page: Page, popup: Page): Promise<void> {
  if (!popup.isClosed()) await popup.close();
  await page.waitForTimeout(700);
}

const card = (page: Page) => page.locator('#gas-free');

test('the first check-in carries the one-time setup, the second doesn’t; both done, counted, free (D831, D854, D867)', async ({ page, google, browserName }) => {
  test.setTimeout(120_000);
  google.accounts = [freshAccount()];
  // Each send is held until the test lets it through, so the card's "in progress" can be seen.
  let sending = gate();
  const sends: string[] = [];
  await page.context().route(sponsorRoute('send'), async (route) => {
    if (route.request().method() === 'POST') {
      sends.push(route.request().postData() ?? '');
      await sending.wait;
    }
    await route.fallback();
  });
  await signedIn(page);

  // The card, after the addresses, ready.
  await expect(card(page)).toBeVisible();
  await expect(card(page).locator('h2')).toHaveText('Try an action with no network fee');
  await expect(page.locator('#wallet + #gas-free')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Check in', exact: true })).toBeEnabled();
  await expect(page.locator('#gas-free-count')).toBeHidden();
  await shots(page, 'idle', browserName);

  // First: the setup note, no red box, the network fee none.
  let popup = await checkInWindow(page);
  await expect(page.locator('#gas-free-stage')).toHaveText(APPROVING);
  await expect(popup.locator('.warning-box p.risk-lead.account-setup')).toHaveText(SETUP);
  await expect(popup.locator('.danger-box')).toHaveCount(0);
  await expect(popup.getByText('This is Journear’s demo check-in. It doesn’t move any money or tokens.')).toBeVisible();
  await windowShots(popup, 'first-time', browserName);
  await approve(popup);
  await expect.poll(() => sends.length, { timeout: 15_000 }).toBe(1);
  // The user comes back to the page while it goes through.
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('#gas-free-stage')).toHaveText(FINISHING);
  await expect(page.getByRole('button', { name: 'Check in', exact: true })).toBeDisabled();
  await shots(page, 'in-progress', browserName);
  sending.open();
  await expect(page.locator('#gas-free-done-text')).toHaveText(DONE);
  await expect(page.locator('#gas-free-stage')).toBeHidden();
  // The stack's chain has no explorer: no link.
  await expect(page.locator('#gas-free-link')).toBeHidden();
  // The count, read from the check-in program on the mocked chain.
  await expect(page.locator('#gas-free-count')).toHaveText('You’ve checked in once so far.');
  await shots(page, 'done', browserName);
  await closeWindow(page, popup);

  // Second: no setup note, no box at all.
  sending = gate();
  sending.open();
  popup = await checkInWindow(page);
  await expect(popup.locator('.risk-box')).toHaveCount(0);
  await expect(popup.locator('.account-setup')).toHaveCount(0);
  await approve(popup);
  await expect(page.locator('#gas-free-count')).toHaveText('You’ve checked in 2 times so far.');
  await expect(page.locator('#gas-free-done-text')).toHaveText(DONE);
  await expect(page.locator('#gas-free-error')).toBeHidden();
  await closeWindow(page, popup);

  // Exactly the pinned check-in was sent, both times.
  expect(sends).toHaveLength(2);
  for (const body of sends) {
    const { calls } = JSON.parse(body) as { calls: { to: string; value: string; data: string }[] };
    expect(calls.map((c) => ({ ...c, to: c.to.toLowerCase() }))).toEqual([{ to: CHECK_IN.toLowerCase(), value: '0', data: '0x183ff085' }]);
  }
  expect(await page.evaluate(() => (window as any).__cspViolations)).toEqual([]);
});

test('a rejection in the window is quiet: one plain line, no error, ready again', async ({ page, google }) => {
  google.accounts = [freshAccount()];
  await signedIn(page);
  const popup = await checkInWindow(page);
  await reject(popup);
  await expect(page.locator('#gas-free-quiet')).toHaveText('You rejected this in Journear Passport, or closed it. Nothing was approved.');
  await expect(page.locator('#gas-free-error')).toBeHidden();
  await expect(page.locator('#gas-free-done')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Check in', exact: true })).toBeEnabled();
});

test('the day’s free network fees used up: the SDK’s own sentence in the card, nothing sent', async ({ page, google, browserName }) => {
  google.accounts = [freshAccount()];
  let sends = 0;
  await page.context().route(sponsorRoute('prepare'), (route) => patched(route, { allowed: false, reason: 'budget_exhausted' }));
  await page.context().route(sponsorRoute('send'), async (route) => {
    if (route.request().method() === 'POST') sends += 1;
    await route.fallback();
  });
  await signedIn(page);
  const popupP = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Check in', exact: true }).click();
  const popup = await popupP;
  await expect(page.locator('#gas-free-error-text')).toHaveText('Journear’s free network fees for this app are used up for today. Try again tomorrow.');
  await expect(page.locator('#gas-free-error')).toBeVisible();
  await expect(page.locator('#gas-free-done')).toBeHidden();
  // The window the click opened closes: no Approve was ever shown.
  await popup.waitForEvent('close', { timeout: 10_000 }).catch(() => undefined);
  expect(popup.isClosed()).toBe(true);
  expect(sends).toBe(0);
  await shots(page, 'refused-budget', browserName);
});

test('paused: the card says so in the SDK’s words, with the button off', async ({ page, google, browserName }) => {
  google.accounts = [freshAccount()];
  await page.context().route(sponsorRoute('status'), (route) => patched(route, { available: false, reason: 'paused' }));
  await signedIn(page);
  await expect(card(page)).toBeVisible();
  await expect(page.locator('#gas-free-note-text')).toHaveText('Free network fees are paused right now. Try again later.');
  await expect(page.getByRole('button', { name: 'Check in', exact: true })).toBeDisabled();
  await shots(page, 'paused', browserName);
});

test('the app not sponsored: no card at all, the rest of the page as before', async ({ page, google }) => {
  google.accounts = [freshAccount()];
  await page.context().route(sponsorRoute('status'), (route) => patched(route, { available: false, reason: 'app_not_sponsored' }));
  await signedIn(page);
  await expect(page.locator('#near')).toBeVisible();
  await expect(page.locator('#signing')).toBeVisible();
  // Give the page a moment past the answer: the card never comes.
  await page.waitForTimeout(500);
  await expect(card(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Check in', exact: true })).toHaveCount(0);
});
