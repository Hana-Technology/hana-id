// Automatic linking between Google and email in the Hana popup (build plan batch 8b), end to end on the local stack:
// the real popup pages, vault and SDK, apps/email-issuer's own Worker (google-match, the `outbox` stub), Google's
// server-side answers for the issuer (src/server/google-backend.ts) and the browser's Google stub (src/google-stub.ts,
// the second, silent request for the email scope, proofs), and the mocked chain's accounts and links. One person, one
// wallet: every case opens the wallet that already exists (D119, D122). Each test has its own Google account and
// address (links are per scope, and the stack's apps share scope `e2e`).
import type { Page, TestInfo } from '@playwright/test';
import { ISSUER_URL } from '../src/stack.ts';
import { addressOfExport } from '@hana-id/core';
import { type App, chooseAccount, clickAction, clickLauncher, errorOf, expect, newApp, okValue, openPartner, runAction, test, waitPersisted } from './fixtures.ts';

const MATCH = `${ISSUER_URL}/v1/email/google-match`;
const rand = (): string => crypto.randomUUID().replace(/-/gu, '').slice(0, 10);
/** A fresh Google `sub` (21 digits, as Google's). */
const newSub = (): string => `1${Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => String(b % 10)).join('')}`;
/** A Gmail address (Google-hosted) or one on another domain (not hosted), unique per test and browser. */
/** (No dots: the issuer mails a Gmail address in its canonical form, which drops them.) */
const gmail = (info: TestInfo, tag: string): string => `e2e${tag}${info.project.name}${rand()}@gmail.com`;
const outside = (info: TestInfo, tag: string): string => `e2e-${tag}-${info.project.name}-${rand()}@mail-e2e.example.com`;

type Mail = { subject: string; text: string; kind: string };
const mails = async (to: string): Promise<Mail[]> => (await (await fetch(`${ISSUER_URL}/__e2e/outbox?to=${encodeURIComponent(to)}`)).json()) as Mail[];

/** The code of the newest code mail for `to` after `previous` mails. */
async function codeFor(to: string, previous: number): Promise<string> {
  await expect.poll(async () => (await mails(to)).filter((m) => m.kind === 'code').length, { timeout: 10_000 }).toBeGreaterThan(previous);
  const codes = (await mails(to)).filter((m) => m.kind === 'code');
  const m = /\b(\d{6})\b/u.exec(codes[codes.length - 1]!.text);
  if (!m) throw new Error('no code in the mail');
  return m[1] as string;
}
const codeCount = async (to: string): Promise<number> => (await mails(to)).filter((m) => m.kind === 'code').length;

/** The code screen: the newest code for `to`, typed in, Continue. */
async function enterCode(popup: Page, to: string, before: number): Promise<void> {
  await expect(popup.locator('#email-code')).toBeVisible();
  await popup.fill('#email-code', await codeFor(to, before));
  await popup.click('#email-verify');
}

/** The address screen: `to`, Send code, then the code. */
async function emailCode(popup: Page, to: string): Promise<void> {
  await expect(popup.locator('#email-address')).toBeVisible();
  await popup.fill('#email-address', to);
  const before = await codeCount(to);
  await popup.click('#email-send');
  await enterCode(popup, to, before);
}

/** An email login to `to` (the popup opens on the email step, `method: 'email'`); resolves with the wallet. */
async function emailLogin(page: Page, to: string, name: string): Promise<{ stellar: string; evm: string }> {
  const popupP = page.waitForEvent('popup');
  await clickAction(page, name, 'loginWith', { method: 'email' });
  const popup = await popupP;
  await popup.waitForURL(/\/login\/email#/u);
  const closed = popup.waitForEvent('close', { timeout: 20_000 });
  await emailCode(popup, to);
  await closed;
  const w = await okValue<{ stellar: string; evm: string }>(page, name);
  await waitPersisted(page, w.evm);
  return w;
}

/** A Google login through the chooser (`#continue-google`, the stub's account 0); returns the popup, still open or not. */
async function googleStart(page: Page, name: string): Promise<Page> {
  const popupP = page.waitForEvent('popup');
  await clickAction(page, name, 'login');
  const popup = await popupP;
  await popup.click('#continue-google');
  await popup.waitForURL(/accounts\.google\.com/u);
  await popup.click('#account-0');
  return popup;
}

async function logout(page: Page, name: string): Promise<void> {
  await runAction(page, name, 'logout');
  await okValue(page, name);
}

const linkEvents = (page: Page): Promise<unknown[]> => page.evaluate(() => (window as any).e2e.events.filter((e: { name: string }) => e.name === 'linkChanged').map((e: { data: unknown }) => e.data));

async function emailApp(page: Page): Promise<App> {
  const app = await newApp({ loginMethods: 'google,email' });
  await openPartner(page, app);
  return app;
}

test('case C: a Google login of an app with email asks google-match first, then opens the Google wallet', async ({ page, google, requests }, info) => {
  google.accounts = [{ sub: newSub(), label: 'C', email: gmail(info, 'c'), emailVerified: true }];
  await emailApp(page);
  const popup = await googleStart(page, 'login');
  await popup.waitForEvent('close', { timeout: 20_000 });
  expect((await okValue<{ evm: string }>(page, 'login')).evm).toMatch(/^0x/u);
  expect(requests.count(MATCH)).toBe(1);
  // The login's own request stayed openid-only; the email scope came in a second, silent one (two-request mode).
  expect(google.requests.map((r) => r.ok && r.request.kind)).toEqual(['login', 'access']);
  expect(await linkEvents(page)).toEqual([]);
});

test('case A, Google-hosted: an email wallet, then Google with that Gmail address opens it silently', async ({ page, google }, info) => {
  const to = gmail(info, 'a');
  google.accounts = [{ sub: newSub(), label: 'A', email: to, emailVerified: true }];
  await emailApp(page);
  const wallet = await emailLogin(page, to, 'email');
  await logout(page, 'out');

  const popup = await googleStart(page, 'google');
  // No screen to decide on: the login opens the email wallet; the popup's banner says so.
  expect(await okValue(page, 'google')).toEqual(wallet);
  await expect(popup.locator('#link-banners')).toContainText('Your Google sign-in now opens this wallet too');
  const closed = popup.waitForEvent('close');
  await popup.click('#banner-done');
  await closed;
  await expect.poll(() => linkEvents(page)).toContainEqual(expect.objectContaining({ provider: 'google', status: 'active' }));
  // A link notice went to the address.
  await expect.poll(async () => (await mails(to)).some((m) => m.kind === 'link_notice')).toBe(true);
});

test('case A, not hosted: “Link and continue” sends a code to the address first, then opens the email wallet', async ({ page, google }, info) => {
  const to = outside(info, 'an');
  google.accounts = [{ sub: newSub(), label: 'AN', email: to, emailVerified: true }];
  await emailApp(page);
  const wallet = await emailLogin(page, to, 'email');
  await logout(page, 'out');

  const popup = await googleStart(page, 'google');
  await expect(popup.locator('#link-continue')).toBeVisible();
  await expect(popup.getByText(/^e…@mail-e2e\.example\.com$/u)).toBeVisible();
  const before = await codeCount(to);
  await popup.click('#link-continue');
  await enterCode(popup, to, before);
  expect(await okValue(page, 'google')).toEqual(wallet);
  await expect(popup.locator('#link-banners')).toContainText('Your Google sign-in now opens this wallet too');
  await popup.click('#banner-done');

  // Linked: the next Google login opens the email wallet with no screen at all.
  await logout(page, 'out2');
  const again = await googleStart(page, 'again');
  await again.waitForEvent('close', { timeout: 20_000 });
  expect(await okValue(page, 'again')).toEqual(wallet);
});

test('case A, not hosted: “Sign in with email” instead is an email login to that wallet, and links nothing', async ({ page, google }, info) => {
  const to = outside(info, 'ae');
  google.accounts = [{ sub: newSub(), label: 'AE', email: to, emailVerified: true }];
  await emailApp(page);
  const wallet = await emailLogin(page, to, 'email');
  await logout(page, 'out');

  const popup = await googleStart(page, 'google');
  await popup.click('#link-use-email');
  const closed = popup.waitForEvent('close', { timeout: 20_000 });
  await emailCode(popup, to);
  await closed;
  expect(await okValue(page, 'google')).toEqual(wallet);
  expect(await runAccount(page, 'acct')).toEqual({ methods: [{ provider: 'email', status: 'active', effectiveAtMs: null, root: true }] });
});

async function runAccount(page: Page, name: string): Promise<unknown> {
  await runAction(page, name, 'account');
  return okValue(page, name);
}

test('case B, Google-hosted: a Google wallet, then the same Gmail by email: “Link and continue” joins it at once', async ({ page, google }, info) => {
  const to = gmail(info, 'b');
  google.accounts = [{ sub: newSub(), label: 'B', email: to, emailVerified: true }];
  await emailApp(page);
  // The Google login writes the hint (google-match).
  const first = await googleStart(page, 'google');
  await first.waitForEvent('close', { timeout: 20_000 });
  const wallet = await okValue<{ stellar: string; evm: string }>(page, 'google');
  await waitPersisted(page, wallet.evm);
  await logout(page, 'out');

  const popupP = page.waitForEvent('popup');
  await clickAction(page, 'email', 'loginWith', { method: 'email' });
  const popup = await popupP;
  await emailCode(popup, to);
  // This email belongs to the Google wallet: "Link and continue" (continue with Google) or "Sign in with Google".
  await expect(popup.locator('#email-google')).toBeVisible();
  await popup.click('#email-link-google');
  await popup.waitForURL(/accounts\.google\.com/u);
  await popup.click('#account-0');
  expect(await okValue(page, 'email')).toEqual(wallet);
  await expect(popup.locator('#link-banners')).toContainText('email sign-in now opens this wallet too');
  await popup.click('#banner-done');
  await expect.poll(() => linkEvents(page)).toContainEqual(expect.objectContaining({ provider: 'email', status: 'active' }));

  // From now on the email alone opens the Google wallet.
  await logout(page, 'out2');
  expect(await emailLogin(page, to, 'again')).toEqual(wallet);
});

test('case B, not hosted: the email joins pending 24 h; the partner sees it; it can’t log in yet; Cancel removes it', async ({ page, google }, info) => {
  const to = outside(info, 'bn');
  const sub = newSub();
  google.accounts = [{ sub, label: 'BN', email: to, emailVerified: true }];
  await emailApp(page);
  const first = await googleStart(page, 'google');
  await first.waitForEvent('close', { timeout: 20_000 });
  const wallet = await okValue<{ stellar: string; evm: string }>(page, 'google');
  await waitPersisted(page, wallet.evm);
  await logout(page, 'out');

  const popupP = page.waitForEvent('popup');
  await clickAction(page, 'email', 'loginWith', { method: 'email' });
  const popup = await popupP;
  await emailCode(popup, to);
  await popup.click('#email-link-google');
  await popup.waitForURL(/accounts\.google\.com/u);
  await popup.click('#account-0');
  // The login opens the Google wallet at once; the email waits.
  expect(await okValue(page, 'email')).toEqual(wallet);
  const banner = popup.locator('#link-banners li[data-status="pending"]');
  await expect(banner).toContainText('will be able to open this wallet from');
  await expect(popup.locator('#banner-cancel-0')).toHaveText('Cancel this link');
  await expect.poll(() => linkEvents(page)).toContainEqual(expect.objectContaining({ provider: 'email', status: 'pending' }));
  const methods = (await runAccount(page, 'acct')) as { methods: { provider: string; status: string; effectiveAtMs: number | null; root: boolean }[] };
  expect(methods.methods).toEqual([
    { provider: 'google', status: 'active', effectiveAtMs: null, root: true },
    { provider: 'email', status: 'pending', effectiveAtMs: expect.any(Number), root: false },
  ]);
  expect(methods.methods[1]!.effectiveAtMs! - Date.now()).toBeGreaterThan(23 * 3_600_000);

  // The banner's Cancel: a fresh Google sign-in of this account (the stub answers for it at once), then cancel_link.
  const closed = popup.waitForEvent('close', { timeout: 20_000 });
  await popup.click('#banner-cancel-0');
  await closed;
  await expect.poll(() => linkEvents(page)).toContainEqual({ provider: 'email', status: 'removed', effectiveAtMs: null });
  expect(google.requests.filter((r) => r.ok && r.request.kind === 'proof').map((r) => r.ok && r.request.loginHint)).toEqual([sub]);
  expect(await runAccount(page, 'acct2')).toEqual({ methods: [{ provider: 'google', status: 'active', effectiveAtMs: null, root: true }] });
});

test('case B, not hosted: while the link is pending, an email login of that address is refused (link_pending)', async ({ page, google }, info) => {
  const to = outside(info, 'bp');
  google.accounts = [{ sub: newSub(), label: 'BP', email: to, emailVerified: true }];
  await emailApp(page);
  const first = await googleStart(page, 'google');
  await first.waitForEvent('close', { timeout: 20_000 });
  const wallet = await okValue<{ stellar: string; evm: string }>(page, 'google');
  await waitPersisted(page, wallet.evm);
  await logout(page, 'out');
  const popupP = page.waitForEvent('popup');
  await clickAction(page, 'email', 'loginWith', { method: 'email' });
  const popup = await popupP;
  await emailCode(popup, to);
  await popup.click('#email-link-google');
  await popup.waitForURL(/accounts\.google\.com/u);
  await popup.click('#account-0');
  expect(await okValue(page, 'email')).toEqual(wallet);
  await popup.click('#banner-done');
  await logout(page, 'out2');

  const p2 = page.waitForEvent('popup');
  await clickAction(page, 'pending', 'loginWith', { method: 'email' });
  const second = await p2;
  await emailCode(second, to);
  expect((await errorOf(page, 'pending')).code).toBe('link_pending');
  await expect(second.getByText(/It can open the wallet from/u)).toBeVisible();
});

test('an email wallet’s key export: the export window’s child popup takes an email code, and the key is that wallet’s', async ({ page }, info) => {
  const to = outside(info, 'x');
  await emailApp(page);
  const wallet = await emailLogin(page, to, 'email');

  await runAction(page, 'export', 'exportKey', 'evm');
  const exportWindow = await clickLauncher(page, 'Export key in Hana');
  expect(await okValue(page, 'export')).toBeNull();
  const childP = exportWindow.waitForEvent('popup');
  await exportWindow.getByRole('button', { name: 'Sign in again to continue' }).click();
  const child = await childP;
  await child.click('#continue-email');
  await child.waitForURL(/\/login\/email#/u);
  const closed = child.waitForEvent('close', { timeout: 20_000 });
  await emailCode(child, to);
  await closed;

  await exportWindow.getByRole('textbox').fill('EXPORT');
  await exportWindow.getByRole('button', { name: 'Continue' }).click();
  const hold = exportWindow.getByRole('button', { name: 'Hold to show the key' });
  const secret = exportWindow.locator('code.secret');
  await hold.hover();
  await exportWindow.mouse.down();
  const shown = (await secret.textContent()) ?? '';
  await exportWindow.mouse.up();
  expect(addressOfExport('evm', shown)).toBe(wallet.evm);
});

test('a Google login on a Google-only app is unchanged: no google-match, no second Google request', async ({ page, google, requests }) => {
  const app = await newApp();
  await openPartner(page, app);
  const popupP = page.waitForEvent('popup');
  await clickAction(page, 'login', 'login');
  await chooseAccount(await popupP);
  await okValue(page, 'login');
  expect(requests.count(MATCH)).toBe(0);
  expect(google.requests).toHaveLength(1);
});
