// D347: closing the login popup at any point ends the partner's login() with `login_cancelled` (`data.reason:
// 'popup_closed'`) within a few seconds, instead of the 5-minute `login_timeout`: on the chooser, on Google's page, on
// the email code step and on a follow-up screen. A navigation to Google and back is never a close, and neither is a
// popup that is merely slow.
import type { Page, TestInfo } from '@playwright/test';
import { GOOGLE_AUTH_URL } from '../src/google-stub.ts';
import { ISSUER_URL } from '../src/stack.ts';
import { LOGIN_ENDPOINT, clickAction, errorOf, expect, newApp, okValue, openPartner, peek, runAction, test, waitPersisted } from './fixtures.ts';

const rand = (): string => crypto.randomUUID().replace(/-/gu, '').slice(0, 10);
const newSub = (): string => `1${Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => String(b % 10)).join('')}`;
const outside = (info: TestInfo, tag: string): string => `e2e-pc-${tag}-${info.project.name}-${rand()}@mail-e2e.example.com`;
/** "Within a few seconds": the watch reads the window every 250 ms and allows 1 s of grace. */
const QUICK_MS = 5_000;
/** A close this soon after the popup left for Google is taken for an IdP's COOP switch (vault/login.ts POPUP_WATCH). */
const SEVER_WINDOW_MS = 8_000;

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
  await popup.click('#email-verify');
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
  // The user reads Google's page for a while (a close right on arrival is taken for an IdP's COOP switch).
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
  const firstClosed = first.waitForEvent('close', { timeout: 20_000 });
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
  const closed = popup.waitForEvent('close', { timeout: 20_000 });
  await popup.click('#account-0');
  await closed;
  expect((await okValue<{ evm: string }>(page, 'login')).evm).toMatch(/^0x/u);
});
