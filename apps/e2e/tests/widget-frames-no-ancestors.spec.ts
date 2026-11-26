// The widget in a browser that doesn't name the pages around a frame (D934, P11 and P12): Firefox with
// `location.ancestorOrigins` turned off, as Firefox releases before it shipped there (the suite's Firefox, a Nightly
// build, has it on). Firefox only; the same pages as widget-frames.spec.ts.
//
// - P12 holds: the widget opened on its own is refused (the vault reads `window.parent === window.top`, which every
//   browser answers), and a page the app doesn't list can't frame it (the vault page's `frame-ancestors`, every browser).
// - The residual, shown here as it is: the widget framed by a page of its own address at the top is taken, since the
//   browser says only that the page above is one of the app's web addresses, not which.
// - P11 falls back honestly: the windows never name a site the browser didn't; they say so, and name the one page the
//   app lists to check against ("It should be {page}: check your browser's address bar.").
//
// With HANA_SHOTS_DIR=<dir> the framed sign-in and approval windows are saved at 1280 and 390 px, light.
import type { Page } from '@playwright/test';
import { expect, newApp, partnerUrl, test } from './fixtures.ts';
import { PAGE, WIDGET, approvalWindow, finishSignIn, partnerPage, readyOf, signInWindow, widget, widgetApp } from './widget-steps.ts';

const SHOTS = process.env.HANA_SHOTS_DIR;

test.skip(({ browserName }) => browserName !== 'firefox', 'Firefox only: the browser without location.ancestorOrigins');
// The project's own pref (Total Cookie Protection) and ancestorOrigins off.
test.use({ launchOptions: { firefoxUserPrefs: { 'network.cookie.cookieBehavior': 5, 'dom.location.ancestorOrigins.enabled': false } } });

const lines = (popup: Page, sel: string) => popup.locator(`${sel} > p`).allTextContents().then((t) => t.map((x) => x.replace(/\s+/gu, ' ').trim()));
const UNKNOWN = `Your browser didn’t say which site you’re on. It should be ${PAGE}: check your browser’s address bar.`;

async function shoot(popup: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  for (const [w, label] of [
    [1280, 'desktop'],
    [390, 'phone'],
  ] as const) {
    await popup.setViewportSize({ width: w, height: 900 });
    await popup.emulateMedia({ colorScheme: 'light' });
    await popup.screenshot({ path: `${SHOTS}/${name}-${label}.png`, fullPage: true });
  }
}

test('this browser names no ancestor', async ({ page }) => {
  const app = await widgetApp();
  await partnerPage(page, PAGE, partnerUrl(app));
  const f = await widget(page);
  expect(await f.evaluate(() => (location as Location & { ancestorOrigins?: unknown }).ancestorOrigins === undefined)).toBe(true);
});

test('inside the partner’s page it works; the windows say the browser didn’t name the site, and which page to expect', async ({ page }) => {
  const app = await widgetApp();
  await partnerPage(page, PAGE, partnerUrl(app));
  const f = await widget(page);
  expect((await readyOf(f)).ready).toBe('ok');
  const signIn = await signInWindow(page, f);
  expect(await lines(signIn, '.asker-framed')).toEqual(['Signing in to Coffee Club.', `This uses a widget from ${WIDGET}.`, UNKNOWN]);
  await shoot(signIn, 'e2e-firefox-no-ancestors-sign-in');
  await finishSignIn(f, signIn);
  const approval = await approvalWindow(page, f);
  expect(await lines(approval, 'header.app')).toEqual(['From Coffee Club', `This uses a widget from ${WIDGET}.`, UNKNOWN]);
  await shoot(approval, 'e2e-firefox-no-ancestors-approval');
  await approval.getByRole('button', { name: 'Reject', exact: true }).click();
});

test('opened on its own the widget is refused; a page the app doesn’t list can’t frame it', async ({ page }) => {
  const app = await widgetApp();
  await page.goto(partnerUrl(app));
  await page.waitForFunction(() => (window as any).e2e?.ready !== 'pending' && (window as any).e2e?.ready !== undefined, null, { timeout: 15_000 });
  expect(await page.evaluate(() => [(window as any).e2e.readyError, (window as any).e2e.readyErrorReason])).toEqual(['vault_unavailable', 'no_answer']);
  const elsewhere = await newApp({ name: 'Coffee Club', origins: [WIDGET], frameOnly: [WIDGET] });
  await partnerPage(page, PAGE, partnerUrl(elsewhere));
  expect(await readyOf(await widget(page))).toMatchObject({ ready: 'error', error: 'vault_unavailable' });
});

test('the residual: the widget framed by a page of its own address at the top is taken (the browser doesn’t say which page is above)', async ({ page }) => {
  const app = await widgetApp();
  await partnerPage(page, WIDGET, partnerUrl(app));
  const f = await widget(page);
  expect((await readyOf(f)).ready).toBe('ok');
  // The window still never names a site it wasn't told: the person is asked to check the address bar against the page.
  const signIn = await signInWindow(page, f);
  expect(await lines(signIn, '.asker-framed')).toEqual(['Signing in to Coffee Club.', `This uses a widget from ${WIDGET}.`, UNKNOWN]);
  await signIn.close();
});
