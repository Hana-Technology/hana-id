// Passport Home's shell (D888): the top bar holds who is signed in, Sign out and the sign-in's notice, outside the
// page's content, so nothing in the page moves when the notice appears or changes; the line a failed copy leaves keeps
// its space. Chromium only (layout measurements and Tab order); the other Home specs run in all three browsers.
//
// - "the guarded Continue …": the move flow's guarded step (D878's "never moves under a pointer") with the real API's
//   derive; its position in the document is measured before and after the notice appears, after the copy line
//   appears, and after the sign-in ends.
// - "one header, a nav and a skip link": the landmarks, and the skip link moving focus into the page without changing
//   its address (D555).
import type { BrowserContext, Page } from '@playwright/test';
import { API_URL, AUTH_ORIGIN, GOOGLE_CLIENT_ID } from '../src/stack.ts';
import { chooseAccount, expect, login, newApp, openPartner, test } from './fixtures.ts';
import { HOME_CORS, routeApps, signIn } from './home-steps.ts';

const MIN = 60_000;
const rand = (): string => crypto.randomUUID().replace(/-/gu, '').slice(0, 10);
/** A fresh Google `sub` (21 digits, as Google's): the test's user is its own, whatever ran on the stack before. */
const newSub = (): string => `1${Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => String(b % 10)).join('')}`;
const listedApp = (appId: string, name: string) => ({ appId, name, status: 'active', environment: 'live', origins: [`https://${name.toLowerCase().replace(/[^a-z]+/gu, '')}.example`], logoUrl: null });

/**
 * `GET /v1/home/config` through the real API, its server time set `behindMs` in the past: the sign-in made after it
 * ends that much sooner (its 15 minutes count from the config's time), so the notice comes before the open wallet's
 * own 5 minutes are up.
 */
async function shortSignIn(context: BrowserContext, behindMs: number): Promise<void> {
  await context.route(`${API_URL}/v1/home/config`, async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: HOME_CORS });
    const res = await route.fetch();
    const body = (await res.json()) as { serverTimeMs: number };
    return route.fulfill({ response: res, body: JSON.stringify({ ...body, serverTimeMs: body.serverTimeMs - behindMs }) });
  });
}

/** Where an element is in the document (not the window): scrolling doesn't change it; a layout shift does. */
const place = (page: Page, selector: string) =>
  page.locator(selector).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + window.scrollX), y: Math.round(r.top + window.scrollY), width: Math.round(r.width), height: Math.round(r.height) };
  });

test('the guarded Continue in the move flow doesn’t move when the sign-in’s notice appears, when a copy fails, or when the sign-in ends', async ({ page, context, google, browserName }, info) => {
  test.skip(browserName !== 'chromium', 'a layout measurement: Chromium only');
  test.setTimeout(180_000);
  const [sub, other] = [newSub(), newSub()];
  google.accounts = [
    { sub, label: 'Shell user', email: `e2eshell${rand()}@gmail.com`, emailVerified: true },
    { sub: other, label: 'Shell somebody else', email: `e2eshell${rand()}@gmail.com`, emailVerified: true },
  ];
  const scopeId = `shell${rand()}`;
  const app = await newApp({ name: 'Sodax', scopeId });
  await openPartner(page, app);
  const wallet = await login(page);
  await page.goto('about:blank');

  await routeApps(context, () => ({
    status: 200,
    body: {
      scopes: [
        {
          scopeId,
          mine: true,
          coverage: 'shared',
          googleClientId: GOOGLE_CLIENT_ID,
          supportId: 'HANA-7K2M-Q9XD',
          addresses: [
            { chain: 'stellar', address: wallet.stellar },
            { chain: 'evm', address: wallet.evm },
          ],
          apps: [listedApp(app.appId, 'Sodax')],
        },
      ],
      nextCursor: null,
    },
  }));
  // The Home sign-in lasts 4 minutes from here: its notice at 2, its end at 4, the open wallet's lock after 5.
  await shortSignIn(context, 11 * MIN);
  await context.clock.install();
  const home = await context.newPage();
  await home.goto(`${AUTH_ORIGIN}/home`);
  await signIn(home);
  await home.getByRole('button', { name: 'View Sodax', exact: true }).click();
  await home.locator('#home-export-open').click();
  const childP = home.waitForEvent('popup');
  await home.locator('#home-export-start').click();
  await chooseAccount(await childP);
  await expect(home.locator('#home-export-title')).toHaveText('Your wallet is open', { timeout: 30_000 });
  await home.locator('#home-export-stellar').click();
  await expect(home.locator('#home-export-title')).toHaveText('Your Stellar key');
  await home.locator('#home-export-confirm').fill('EXPORT');
  const continueButton = '#home-export-continue';

  // Before: no notice yet.
  await expect(home.locator('#home-ending')).toHaveCount(0);
  await expect(home.locator('#home-ended')).toHaveCount(0);
  const before = await place(home, continueButton);

  // The notice: two minutes before the end.
  await context.clock.fastForward(2 * MIN + 5_000);
  await expect(home.locator('#home-ending')).toBeVisible();
  await expect(home.locator('#home-ending')).toContainText('ends in about');
  // It is in the top bar, outside the page's content.
  expect.soft(await home.locator('#home-banner').evaluate((el) => el.closest('#app') === null && el.closest('header') !== null)).toBe(true);
  const withNotice = await place(home, continueButton);

  // A copy that fails: its line keeps its space.
  await home.evaluate(() => {
    const clip = navigator.clipboard as Clipboard | undefined;
    if (clip) Object.defineProperty(clip, 'writeText', { configurable: true, value: () => Promise.reject(new Error('blocked by the test')) });
  });
  await home.locator('#home-copy-stellar').click();
  await expect(home.locator('#home-copied')).toContainText('copy it yourself');
  const withCopyLine = await place(home, continueButton);

  // The end of the sign-in: the notice changes to the ended one.
  await context.clock.fastForward(2 * MIN);
  await expect(home.locator('#home-ended')).toBeVisible();
  await expect(home.locator(continueButton)).toBeVisible();
  const afterEnd = await place(home, continueButton);

  const measured = { before, withNotice, withCopyLine, afterEnd };
  info.annotations.push({ type: 'continue-position', description: JSON.stringify(measured) });
  console.log(`[home-shell] Continue at ${JSON.stringify(measured)}`);
  expect.soft(withNotice).toEqual(before);
  expect.soft(withCopyLine).toEqual(before);
  expect.soft(afterEnd).toEqual(before);
});

test('one header, a nav and a skip link that moves focus into the page without changing its address', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'Tab reaches links only by a setting in WebKit; the landmarks are the same markup everywhere');
  await routeApps(context, () => ({ status: 200, body: { scopes: [], nextCursor: null } }));
  await page.goto(`${AUTH_ORIGIN}/home`);
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();

  // The skip link: the first thing Tab reaches, shown when it has focus; Enter moves focus to the page's content.
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press('Enter');
  await expect(page.locator('main#app')).toBeFocused();
  expect(page.url()).toBe(`${AUTH_ORIGIN}/home`);

  await signIn(page);
  await expect(page.locator('#home-empty')).toBeVisible();
  await expect(page.locator('header')).toHaveCount(1);
  await expect(page.getByRole('banner')).toHaveCount(1);
  await expect(page.getByRole('main')).toHaveCount(1);
  const nav = page.getByRole('navigation');
  await expect(nav).toHaveCount(1);
  // Who is signed in and Sign out are in the top bar, outside the page's content.
  await expect(nav).toContainText('Signed in with Google');
  await expect(nav.getByRole('button', { name: 'Sign out' })).toBeVisible();
  expect(await nav.evaluate((el) => el.closest('header') !== null && el.closest('#app') === null)).toBe(true);
  expect(page.url()).toBe(`${AUTH_ORIGIN}/home`);
});
