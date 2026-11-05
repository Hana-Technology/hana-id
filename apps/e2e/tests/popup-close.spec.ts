// D347: closing the login popup at any point ends the partner's login() with `login_cancelled` (`data.reason:
// 'popup_closed'`) within a few seconds, instead of the 5-minute `login_timeout`: on the chooser, on Google's page, on
// the email code step and on a follow-up screen. A navigation to Google and back is never a close, and neither is a
// popup that is merely slow. A close right on arrival at Google (taken for a possible COOP switch) ends the login at
// D385's deadline (90 s), not the 5-minute limit; the page's clock is fast-forwarded to it.
import type { Page, TestInfo } from '@playwright/test';
import { GOOGLE_AUTH_URL } from '../src/google-stub.ts';
import { ISSUER_URL } from '../src/stack.ts';
import { EARLY_CLOSE_DEADLINE_MS, LOGIN_ENDPOINT, LOGIN_PENDING_MS, clickAction, clickClosing, clickMayClose, closeOf, errorOf, expect, newApp, okValue, openPartner, peek, runAction, status, test, waitPersisted } from './fixtures.ts';

const rand = (): string => crypto.randomUUID().replace(/-/gu, '').slice(0, 10);
const newSub = (): string => `1${Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => String(b % 10)).join('')}`;
const outside = (info: TestInfo, tag: string): string => `e2e-pc-${tag}-${info.project.name}-${rand()}@mail-e2e.example.com`;
/** "Within a few seconds": the watch reads the window every 250 ms and allows 1 s of grace. */
const QUICK_MS = 5_000;
/** A close this soon after the popup left for Google is taken for an IdP's COOP switch (vault/login.ts POPUP_WATCH). */
const SEVER_WINDOW_MS = 8_000;
/** A quick close: the user closes this soon after Google's page appears, inside the COOP window. */
const QUICK_CLOSE_MS = 2_000;

type Mail = { text: string; kind: string };
const mails = async (to: string): Promise<Mail[]> => (await (await fetch(`${ISSUER_URL}/__e2e/outbox?to=${encodeURIComponent(to)}`)).json()) as Mail[];
const codeCount = async (to: string): Promise<number> => (await mails(to)).filter((m) => m.kind === 'code').length;

async function sendCode(popup: Page, to: string): Promise<number> {
  await expect(popup.locator('#email-address')).toBeVisible();
  await popup.fill('#email-address', to);
  const before = await codeCount(to);
  await popup.click('#email-send');
  await expect(popup.locator('#email-code')).toBeVisible();
  return before;
}

async function typeCode(popup: Page, to: string, before: number): Promise<void> {
  await expect.poll(() => codeCount(to), { timeout: 10_000 }).toBeGreaterThan(before);
  const codes = (await mails(to)).filter((m) => m.kind === 'code');
  const code = /\b(\d{6})\b/u.exec(codes[codes.length - 1]!.text)?.[1];
  if (!code) throw new Error('no code in the mail');
  await popup.fill('#email-code', code);
  await clickMayClose(popup, '#email-verify');
}

async function openLogin(page: Page, name: string, options?: Record<string, unknown>): Promise<Page> {
  const popupP = page.waitForEvent('popup');
  if (options) await clickAction(page, name, 'loginWith', options);
  else await clickAction(page, name, 'login');
  return popupP;
}

/** The partner's login() ended with login_cancelled because the window closed, within `QUICK_MS` of the close. */
async function cancelledByClose(page: Page, name: string, closedAt: number): Promise<void> {
  expect(await errorOf(page, name, QUICK_MS)).toEqual({ code: 'login_cancelled', reason: 'popup_closed' });
  expect(Date.now() - closedAt).toBeLessThan(QUICK_MS);
}

test('closed on the chooser: login_cancelled within seconds', async ({ page, requests }) => {
  await openPartner(page, await newApp({ loginMethods: 'google,email' }));
  const popup = await openLogin(page, 'login');
  await expect(popup.locator('#continue-google')).toBeVisible();
  await popup.close();
  await cancelledByClose(page, 'login', Date.now());
  expect(requests.count(LOGIN_ENDPOINT)).toBe(0);
});

test('closed on Google’s page: login_cancelled within seconds', async ({ page, google, requests }) => {
  google.accounts = [{ sub: newSub(), label: 'AtGoogle', email: `e2epcg${rand()}@gmail.com`, emailVerified: true }];
  await openPartner(page, await newApp());
  const popup = await openLogin(page, 'login');
  await popup.waitForURL(`${GOOGLE_AUTH_URL}**`);
  // The user reads Google's page for a while (a close right on arrival may be an IdP's COOP switch: the case below).
  await popup.waitForTimeout(SEVER_WINDOW_MS + 500);
  expect(await peek(page, 'login')).toEqual({ state: 'pending' });
  await popup.close();
  await cancelledByClose(page, 'login', Date.now());
  expect(requests.count(LOGIN_ENDPOINT)).toBe(0);
});

test('closed on the email code step: login_cancelled within seconds', async ({ page }, info) => {
  await openPartner(page, await newApp({ loginMethods: 'google,email' }));
  const popup = await openLogin(page, 'login', { method: 'email' });
  await sendCode(popup, outside(info, 'code'));
  await popup.close();
  await cancelledByClose(page, 'login', Date.now());
});

test('closed on a follow-up screen (case A’s “This email already has a wallet”): login_cancelled within seconds', async ({ page, google }, info) => {
  const to = outside(info, 'a');
  google.accounts = [{ sub: newSub(), label: 'A', email: to, emailVerified: true }];
  await openPartner(page, await newApp({ loginMethods: 'google,email' }));
  // An email wallet for that address first.
  const first = await openLogin(page, 'email', { method: 'email' });
  const firstClosed = closeOf(first);
  await typeCode(first, to, await sendCode(first, to));
  await firstClosed;
  await waitPersisted(page, (await okValue<{ evm: string }>(page, 'email')).evm);
  await runAction(page, 'out', 'logout');
  await okValue(page, 'out');
  // Google with that address: back from Google, the vault's screen waits for the user, who closes the window.
  const popup = await openLogin(page, 'google');
  await popup.click('#continue-google');
  await popup.waitForURL(`${GOOGLE_AUTH_URL}**`);
  await popup.click('#account-0');
  await expect(popup.locator('#link-continue')).toBeVisible({ timeout: 15_000 });
  await popup.close();
  await cancelledByClose(page, 'google', Date.now());
});

test('to Google and back, slowly, is never a close: the login signs in', async ({ page, google }) => {
  google.accounts = [{ sub: newSub(), label: 'Slow', email: `e2epcslow${rand()}@gmail.com`, emailVerified: true }];
  await openPartner(page, await newApp({ loginMethods: 'google,email' }));
  const popup = await openLogin(page, 'login');
  await popup.waitForTimeout(1_500);
  await popup.click('#continue-google');
  await popup.waitForURL(`${GOOGLE_AUTH_URL}**`);
  // Past the COOP window on Google's page, then the account: no false cancel on the way back either.
  await popup.waitForTimeout(SEVER_WINDOW_MS + 500);
  expect(await peek(page, 'login')).toEqual({ state: 'pending' });
  await clickClosing(popup, '#account-0');
  expect((await okValue<{ evm: string }>(page, 'login')).evm).toMatch(/^0x/u);
});

test('closed within 8 s on Google’s page: login_cancelled after the deadline, not the 5-minute limit', async ({ page, google, requests, browserName }) => {
  // Chromium drops the popup's `google` signal when the page navigates in the same task as its postMessage (seen on
  // 2026-11-05: never delivered from the chooser's click, now and then from the Google-only path), so there the vault
  // never opens the COOP window and a quick close is a plain close (login_cancelled within seconds). To fix separately.
  test.fixme(browserName === 'chromium', 'Chromium drops the `google` signal posted just before a navigation');
  google.accounts = [{ sub: newSub(), label: 'Quick', email: `e2epcquick${rand()}@gmail.com`, emailVerified: true }];
  await page.clock.install();
  // An app with email login: the partner hears `loginProgress` `google` only when the vault took the popup's own
  // `google` signal, which is what opens the COOP window.
  await openPartner(page, await newApp({ loginMethods: 'google,email' }));
  const popup = await openLogin(page, 'login');
  await popup.click('#continue-google');
  await popup.waitForURL(`${GOOGLE_AUTH_URL}**`);
  await expect.poll(() => page.evaluate(() => (window as any).e2e.events.some((e: { name: string; data?: { stage?: string } }) => e.name === 'loginProgress' && e.data?.stage === 'google'))).toBe(true);
  // A user's quick close, a couple of seconds after Google's page appears (well inside the COOP window): the vault's
  // handle reads closed as it would after a COOP switch, so it waits for an answer.
  await popup.waitForTimeout(QUICK_CLOSE_MS);
  await popup.close();
  const closedAt = await page.evaluate(() => Date.now());
  await page.waitForTimeout(QUICK_MS);
  expect(await peek(page, 'login')).toEqual({ state: 'pending' });
  // Just short of the deadline nothing has happened yet; just past it, the login is cancelled.
  await page.clock.fastForward(EARLY_CLOSE_DEADLINE_MS - QUICK_MS - 5_000);
  expect(await peek(page, 'login')).toEqual({ state: 'pending' });
  await page.clock.fastForward(10_000);
  expect(await errorOf(page, 'login', QUICK_MS)).toEqual({ code: 'login_cancelled', reason: 'popup_closed' });
  const endedAt = await page.evaluate(() => Date.now());
  expect(endedAt - closedAt).toBeGreaterThanOrEqual(EARLY_CLOSE_DEADLINE_MS);
  expect(endedAt - closedAt).toBeLessThan(LOGIN_PENDING_MS);
  expect(await status(page)).toBe('logged_out');
  expect(requests.count(LOGIN_ENDPOINT)).toBe(0);
});

test('an IdP that enforces COOP: the switch on arrival is no cancel, and the account in time signs in', async ({ page, google, browserName }) => {
  test.skip(browserName === 'webkit', 'Playwright’s WebKit applies no COOP to a route-fulfilled response (login.spec.ts)');
  google.accounts = [{ sub: newSub(), label: 'Coop', email: `e2epccoop${rand()}@gmail.com`, emailVerified: true }];
  google.coop = 'same-origin';
  await openPartner(page, await newApp());
  const popupP = page.waitForEvent('popup');
  await clickAction(page, 'login', 'login');
  // The switch can replace the popup's Page (login.spec.ts): follow whichever page reaches Google.
  const first = await popupP;
  const replaced = page
    .context()
    .waitForEvent('page')
    .then(async (p) => (await p.waitForURL(/accounts\.google\.com/u), p));
  const popup = await Promise.any([first.waitForURL(/accounts\.google\.com/u).then(() => first), replaced]);
  expect(await popup.evaluate(() => window.opener === null)).toBe(true);
  // Past the watch's seconds: the vault's handle reads closed, and the login still waits.
  await popup.waitForTimeout(QUICK_MS);
  expect(await peek(page, 'login')).toEqual({ state: 'pending' });
  await clickMayClose(popup, '#account-0');
  expect((await okValue<{ evm: string }>(page, 'login')).evm).toMatch(/^0x/u);
});
