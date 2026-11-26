// The widget-in-a-partner's-page steps the widget-frames specs share (D934): the app, the partner's page framing the
// widget (the stack's /shop, src/server/partner.ts), the widget's frame and its handshake, and the sign-in and
// approval windows opened from it.
import type { Frame, Page } from '@playwright/test';
import { PARTNER_ORIGIN, SITE_B_ORIGIN } from '../src/stack.ts';
import { type App, VAULT_FRAME, chooseAccount, expect, newApp } from './fixtures.ts';
export const WIDGET = PARTNER_ORIGIN;
export const PAGE = SITE_B_ORIGIN;

/** The widget's app: the partner's page and the widget, the widget frame-only (email on, so the chooser shows). */
export const widgetApp = (o: { frameOnly?: boolean } = {}): Promise<App> =>
  newApp({ name: 'Coffee Club', origins: [PAGE, WIDGET], ...(o.frameOnly === false ? {} : { frameOnly: [WIDGET] }), loginMethods: 'google,email' });

/** The partner's page on `origin` (the stack's /shop, src/server/partner.ts) framing the widget as `mode` says. */
export async function partnerPage(page: Page, origin: string, widgetUrl: string, mode: 'plain' | 'sandbox' | 'srcdoc' | 'data' = 'plain'): Promise<void> {
  await page.goto(`${origin}/shop?${new URLSearchParams({ widget: widgetUrl, mode }).toString()}`);
}

/** The frame the partner test app (the widget) runs in, once its handshake ended. */
export async function widget(page: Page): Promise<Frame> {
  let f: Frame | undefined;
  await expect.poll(() => (f = page.frames().find((x) => x !== page.mainFrame() && x.url().startsWith(`${WIDGET}/?pk=`))) !== undefined, { timeout: 15_000 }).toBe(true);
  await f!.waitForFunction(() => (window as any).e2e?.ready !== 'pending' && (window as any).e2e?.ready !== undefined, null, { timeout: 15_000 });
  return f!;
}

/** The widget's handshake outcome after 8 s: 'ok', 'error', or 'none' (its page never said; no frame, or stuck). */
export async function neverReady(page: Page): Promise<string> {
  await page.waitForTimeout(8_000);
  const f = page.frames().find((x) => x !== page.mainFrame() && x.url().startsWith(`${WIDGET}/?pk=`));
  if (!f) return 'none';
  return f.evaluate(() => String((window as any).e2e?.ready ?? 'none')).catch(() => 'none');
}

export const readyOf = (f: Frame): Promise<{ ready: string; error?: string; reason?: string }> =>
  f.evaluate(() => ({ ready: (window as any).e2e.ready, error: (window as any).e2e.readyError, reason: (window as any).e2e.readyErrorReason }));

/** The widget's vault frame (its launcher). */
const launcherIn = (page: Page) => page.frameLocator('#widget').frameLocator(VAULT_FRAME);
void VAULT_FRAME;

/** The sign-in window's chooser, opened from the widget inside a click. */
export async function signInWindow(page: Page, f: Frame): Promise<Page> {
  const popupP = page.waitForEvent('popup');
  await f.evaluate(() => (window as any).e2e.arm('login', 'login'));
  await f.click('#act');
  const popup = await popupP;
  await expect(popup.locator('#continue-google')).toBeVisible();
  return popup;
}

export async function finishSignIn(f: Frame, popup: Page): Promise<void> {
  await popup.click('#continue-google');
  await chooseAccount(popup);
  await f.waitForFunction(() => (window as any).e2e.results.login && (window as any).e2e.results.login.state !== 'pending', null, { timeout: 30_000 });
  expect(await f.evaluate(() => (window as any).e2e.results.login.state)).toBe('ok');
}

/** The approval window for a message the widget asks to sign (through the vault's launcher). */
export async function approvalWindow(page: Page, f: Frame): Promise<Page> {
  await f.evaluate(() => (window as any).e2e.run('sig', 'personalSign', 'Hello from the widget'));
  const button = launcherIn(page).getByRole('button', { name: 'Review in Journear Passport' });
  await expect(button).toBeVisible();
  const popupP = page.waitForEvent('popup');
  await button.click();
  const popup = await popupP;
  await expect(popup.locator('header.app')).toBeVisible();
  return popup;
}

