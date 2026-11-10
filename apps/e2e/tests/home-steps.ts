// Steps the Hana Home specs share (home.spec.ts, home-export.spec.ts): the sign-in through the child, a routed
// `GET /v1/home/apps`, and the screenshots of a screen at desktop and phone width, light and dark.
import type { BrowserContext, Page } from '@playwright/test';
import { API_URL, AUTH_ORIGIN } from '../src/stack.ts';
import { chooseAccount, expect } from './fixtures.ts';

/** Where the screenshots go (Chromium only); unset, `shots` only checks the layout's width. */
const SHOTS = process.env.HANA_SHOTS_DIR;
export const HOME_APPS = `${API_URL}/v1/home/apps`;

const VARIANTS = [
  { name: 'desktop-light', width: 1280, height: 800, scheme: 'light' },
  { name: 'desktop-dark', width: 1280, height: 800, scheme: 'dark' },
  { name: 'phone-light', width: 390, height: 844, scheme: 'light' },
  { name: 'phone-dark', width: 390, height: 844, scheme: 'dark' },
] as const;

/** Saves the screen in each size and colour scheme, and checks in each that nothing spills past the window's width. */
export async function shots(page: Page, name: string, browserName: string): Promise<void> {
  for (const v of VARIANTS) {
    await page.setViewportSize({ width: v.width, height: v.height });
    await page.emulateMedia({ colorScheme: v.scheme });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${name} ${v.name}: no sideways scroll`).toBe(true);
    if (SHOTS && browserName === 'chromium') await page.screenshot({ path: `${SHOTS}/${name}-${v.name}.png`, fullPage: true, animations: 'disabled' });
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: 'light' });
}

/** The click, the child at `/login?mode=home`, the Google stub's chooser. */
export async function signIn(page: Page, button = 'Continue with Google', account = 0): Promise<void> {
  const childP = page.waitForEvent('popup');
  await page.getByRole('button', { name: button }).click();
  const child = await childP;
  await chooseAccount(child, account);
}

/** What the API's answers to the auth origin carry. */
export const HOME_CORS = { 'access-control-allow-origin': AUTH_ORIGIN, 'access-control-allow-headers': 'content-type, x-hana-home', 'access-control-allow-methods': 'GET, POST, OPTIONS', vary: 'Origin' };

/** Answers `GET /v1/home/apps` (and its preflight) from `answer`, as the API would to the auth origin. */
export async function routeApps(context: BrowserContext, answer: (url: URL) => { status: number; body: unknown }): Promise<void> {
  await context.route(`${HOME_APPS}**`, async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: HOME_CORS });
    // Every listing request carries the signed header, and never a cookie.
    expect(route.request().headers()['x-hana-home']).toMatch(/^[A-Za-z0-9_-]{200,}$/u);
    const { status, body } = answer(new URL(route.request().url()));
    return route.fulfill({ status, headers: { ...HOME_CORS, 'content-type': 'application/json', 'cache-control': 'no-store', 'x-request-id': 'req_e2e' }, body: JSON.stringify(body) });
  });
}
