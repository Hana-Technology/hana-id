// A cancel on Google's sign-in screen (D341), end to end on the local stack: under token_first, Cancel on Google's
// screen (the stub's `#deny`, Google's `access_denied`) takes the popup back to Hana's method chooser with "Google
// sign-in was cancelled.", or to case B's own choices when the Google step started there; nothing reaches the vault
// until the user picks again. Google again is a fresh attempt (its own OAuth state) and signs in; closing the window
// on that screen gives the partner `login_cancelled`, never `google_error`.
import type { Page, TestInfo } from '@playwright/test';
import { GOOGLE_AUTH_URL } from '../src/google-stub.ts';
import { ISSUER_URL } from '../src/stack.ts';
import { LOGIN_ENDPOINT, clickAction, clickClosing, clickMayClose, clickUntilTaken, errorOf, expect, newApp, okValue, openPartner, peek, runAction, test, waitPersisted } from './fixtures.ts';

const rand = (): string => crypto.randomUUID().replace(/-/gu, '').slice(0, 10);
/** A fresh Google `sub` (21 digits, as Google's). */
const newSub = (): string => `1${Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => String(b % 10)).join('')}`;
/** A Gmail address, unique per test and browser (no dots: the issuer mails the canonical form). */
const gmail = (info: TestInfo, tag: string): string => `e2egc${tag}${info.project.name}${rand()}@gmail.com`;
const CANCELLED = 'Google sign-in was cancelled.';

/** The partner's login button, then (an app with email) the chooser's Google; the popup at Google's screen. */
async function toGoogle(page: Page, name: string, o: { emailApp: boolean }): Promise<Page> {
  const popupP = page.waitForEvent('popup');
  await clickAction(page, name, 'login');
  const popup = await popupP;
  if (o.emailApp) await popup.click('#continue-google');
  await popup.waitForURL(`${GOOGLE_AUTH_URL}**`);
  return popup;
}

/** Cancel on Google's screen: the popup is back on Hana's screen, saying so. */
async function cancelAtGoogle(popup: Page): Promise<void> {
  await popup.click('#deny');
  await popup.waitForURL(/\/login\/email#/u);
  await expect(popup.locator('#google-cancelled')).toHaveText(CANCELLED);
  await expect(popup.locator('body')).not.toContainText('google_error');
}

/** The OAuth `state` of each Google request the stub saw, in order. */
const states = (google: { requests: { ok: boolean; request?: { state: string } }[] }): string[] => google.requests.map((r) => (r.ok && r.request ? r.request.state : ''));

for (const [label, emailApp] of [
  ['an app with email login', true],
  ['a Google-only app', false],
] as const) {
  test(`${label}: Cancel at Google goes back to the chooser; Google again signs in`, async ({ page, google, requests }) => {
    const sub = newSub();
    google.accounts = [{ sub, label: 'Cancel', email: `e2egcagain${rand()}@gmail.com`, emailVerified: true }];
    await openPartner(page, await newApp(emailApp ? { loginMethods: 'google,email' } : {}));
    const popup = await toGoogle(page, 'login', { emailApp });
    await cancelAtGoogle(popup);
    // The chooser again: Google, and email when the app offers it.
    await expect(popup.locator('#continue-google')).toBeVisible();
    await expect(popup.locator('#continue-email')).toHaveCount(emailApp ? 1 : 0);
    // The vault didn't end the login: the partner's login() is still waiting.
    expect(await peek(page, 'login')).toEqual({ state: 'pending' });
    expect(requests.count(LOGIN_ENDPOINT)).toBe(0);

    await popup.click('#continue-google');
    await popup.waitForURL(`${GOOGLE_AUTH_URL}**`);
    await clickClosing(popup, '#account-0');
    expect((await okValue<{ evm: string }>(page, 'login')).evm).toMatch(/^0x/u);
    expect(requests.count(LOGIN_ENDPOINT)).toBe(1);
    // Two first requests (the cancelled one, the fresh one), each under its own state; the ID request reuses the fresh one's.
    expect(google.kinds).toEqual(['token_first', 'token_first', 'id']);
    const [cancelled, fresh, id] = states(google);
    expect(fresh).not.toBe(cancelled);
    expect(id).toBe(fresh);
  });

  test(`${label}: Cancel at Google, then closing the window: the partner gets login_cancelled`, async ({ page, google, requests }) => {
    google.accounts = [{ sub: newSub(), label: 'Close', email: `e2egcclose${rand()}@gmail.com`, emailVerified: true }];
    await openPartner(page, await newApp(emailApp ? { loginMethods: 'google,email' } : {}));
    const popup = await toGoogle(page, 'login', { emailApp });
    await cancelAtGoogle(popup);
    await popup.close();
    expect((await errorOf(page, 'login', 10_000)).code).toBe('login_cancelled');
    expect(requests.count(LOGIN_ENDPOINT)).toBe(0);
  });
}

test('D348: `hana.login({method: google})` in an app with email login: Cancel at Google comes back to Google only', async ({ page, google, requests }) => {
  google.accounts = [{ sub: newSub(), label: 'OnlyGoogle', email: `e2egconly${rand()}@gmail.com`, emailVerified: true }];
  await openPartner(page, await newApp({ loginMethods: 'google,email' }));
  const popupP = page.waitForEvent('popup');
  await clickAction(page, 'login', 'loginWith', { method: 'google' });
  const popup = await popupP;
  await popup.waitForURL(`${GOOGLE_AUTH_URL}**`);
  await cancelAtGoogle(popup);
  await expect(popup.locator('#continue-google')).toBeVisible();
  await expect(popup.locator('#continue-email')).toHaveCount(0);
  await popup.click('#continue-google');
  await popup.waitForURL(`${GOOGLE_AUTH_URL}**`);
  await clickClosing(popup, '#account-0');
  expect((await okValue<{ evm: string }>(page, 'login')).evm).toMatch(/^0x/u);
  expect(requests.count(LOGIN_ENDPOINT)).toBe(1);
});

test('an app with email login: Cancel at Google, then email from the chooser signs in with email', async ({ page, google }, info) => {
  google.accounts = [{ sub: newSub(), label: 'ThenEmail', email: `e2egcmail${rand()}@gmail.com`, emailVerified: true }];
  await openPartner(page, await newApp({ loginMethods: 'google,email' }));
  const popup = await toGoogle(page, 'login', { emailApp: true });
  await cancelAtGoogle(popup);
  await popup.click('#continue-email');
  const to = gmail(info, 'mail');
  await emailCode(popup, to);
  expect((await okValue<{ evm: string }>(page, 'login')).evm).toMatch(/^0x/u);
});

// ---- case B ----

type Mail = { text: string; kind: string };
const mails = async (to: string): Promise<Mail[]> => (await (await fetch(`${ISSUER_URL}/__e2e/outbox?to=${encodeURIComponent(to)}`)).json()) as Mail[];
const codeCount = async (to: string): Promise<number> => (await mails(to)).filter((m) => m.kind === 'code').length;

/** The address screen: `to`, Send code, then the newest code. */
async function emailCode(popup: Page, to: string): Promise<void> {
  await expect(popup.locator('#email-address')).toBeVisible();
  await popup.fill('#email-address', to);
  const before = await codeCount(to);
  await clickUntilTaken(popup, '#email-send');
  await expect(popup.locator('#email-code')).toBeVisible();
  await expect.poll(() => codeCount(to), { timeout: 10_000 }).toBeGreaterThan(before);
  const codes = (await mails(to)).filter((m) => m.kind === 'code');
  const code = /\b(\d{6})\b/u.exec(codes[codes.length - 1]!.text)?.[1];
  if (!code) throw new Error('no code in the mail');
  await popup.fill('#email-code', code);
  // An email login's popup closes once it relays; case B's shows its screen.
  await clickMayClose(popup, '#email-verify');
}

test('case B: Cancel at Google goes back to case B’s own choices; Link and continue then opens the Google wallet', async ({ page, google }, info) => {
  const to = gmail(info, 'b');
  google.accounts = [{ sub: newSub(), label: 'B', email: to, emailVerified: true }];
  await openPartner(page, await newApp({ loginMethods: 'google,email' }));
  // A Google wallet for that Gmail address (google-match keeps the hint).
  const first = await toGoogle(page, 'google', { emailApp: true });
  await clickClosing(first, '#account-0');
  const wallet = await okValue<{ stellar: string; evm: string }>(page, 'google');
  await waitPersisted(page, wallet.evm);
  await runAction(page, 'out', 'logout');
  await okValue(page, 'out');

  // The same address by email: case B. Its Google step, cancelled at Google.
  const popupP = page.waitForEvent('popup');
  await clickAction(page, 'email', 'loginWith', { method: 'email' });
  const popup = await popupP;
  await emailCode(popup, to);
  await expect(popup.locator('#email-link-google')).toBeVisible();
  await popup.click('#email-link-google');
  await popup.waitForURL(`${GOOGLE_AUTH_URL}**`);
  await cancelAtGoogle(popup);
  // Case B's screen again, not the chooser: Link and continue, Sign in with Google, Cancel.
  await expect(popup.locator('#email-link-google')).toBeVisible();
  await expect(popup.locator('#email-google')).toBeVisible();
  await expect(popup.locator('#continue-email')).toHaveCount(0);
  expect(await peek(page, 'email')).toEqual({ state: 'pending' });

  await popup.click('#email-link-google');
  await popup.waitForURL(`${GOOGLE_AUTH_URL}**`);
  await popup.click('#account-0');
  expect(await okValue(page, 'email')).toEqual(wallet);
  await expect(popup.locator('#link-banners')).toContainText('email sign-in now opens this wallet too');
  await clickClosing(popup, '#banner-done');
});

test('case B: Cancel at Google, then the screen’s Cancel: login_cancelled', async ({ page, google }, info) => {
  const to = gmail(info, 'bc');
  google.accounts = [{ sub: newSub(), label: 'BC', email: to, emailVerified: true }];
  await openPartner(page, await newApp({ loginMethods: 'google,email' }));
  const first = await toGoogle(page, 'google', { emailApp: true });
  await clickClosing(first, '#account-0');
  await waitPersisted(page, (await okValue<{ evm: string }>(page, 'google')).evm);
  await runAction(page, 'out', 'logout');
  await okValue(page, 'out');

  const popupP = page.waitForEvent('popup');
  await clickAction(page, 'email', 'loginWith', { method: 'email' });
  const popup = await popupP;
  await emailCode(popup, to);
  await popup.click('#email-google');
  await popup.waitForURL(`${GOOGLE_AUTH_URL}**`);
  await cancelAtGoogle(popup);
  await clickClosing(popup, '#email-cancel', 10_000);
  expect((await errorOf(page, 'email', 10_000)).code).toBe('login_cancelled');
});
