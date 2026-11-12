// Hana Home H10 against the stack: email users (the real issuer's Home route, its outbox, the API's real Home gate and
// `POST /v1/home/login`), and Google through the exit client (the real `/home/callback`, the Google stub registering
// only that redirect for the exit client, the mocked chain listing the exit client and the email exit, as sandbox-dev).
// The relayer key object is stood in for (src/server/api.ts `relayHome`: the mocked chain's path choice and the test
// MPC), so a key read off the page must open the address the partner login got.
//
// With HANA_SHOTS_DIR set (Chromium only) every new screen is saved there as `h10-…`, at desktop and phone width,
// light and dark. No screenshot shows a derived key: none is revealed on a screen that is saved.
//
// SECURITY: a key read off the page stays in the test's memory and is never printed.
import { addressOfExport } from '@hana-id/core';
import type { BrowserContext, Page, TestInfo } from '@playwright/test';
import type { GoogleStub } from '../src/google-stub.ts';
import { API_URL, AUTH_ORIGIN, EXIT_CLIENT_ID, ISSUER_URL } from '../src/stack.ts';
import { chooseAccount, clickAction, clickClosing, clickUntilTaken, expect, guardedClick, login, newApp, okValue, openPartner, test, waitPersisted, walletDirectory } from './fixtures.ts';
import { HOME_CORS, shots, signIn } from './home-steps.ts';

const rand = (): string => crypto.randomUUID().replace(/-/gu, '').slice(0, 10);
const newSub = (): string => `1${Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => String(b % 10)).join('')}`;
const newScope = (browserName: string): string => `h10${browserName}${rand()}`;
/** A fresh address per test and browser (the issuer's per-address limits are real here). */
const address = (info: TestInfo, tag: string): string => `e2e-h10${tag}-${info.project.name}-${rand()}@mail-e2e.example.com`;
const STELLAR_SEED = /^S[A-Z2-7]{55}$/u;

function freshAccounts(google: GoogleStub): string {
  const sub = newSub();
  google.accounts = [{ sub, label: 'H10 user', email: `e2eh10${rand()}@gmail.com`, emailVerified: true }];
  return sub;
}

type Mail = { subject: string; text: string; kind: string };
const mails = async (to: string): Promise<Mail[]> => (await (await fetch(`${ISSUER_URL}/__e2e/outbox?to=${encodeURIComponent(to)}`)).json()) as Mail[];

/** The code of the newest mail to `to` after the first `previous`, and its subject. */
async function codeFor(to: string, previous: number): Promise<{ code: string; subject: string }> {
  await expect.poll(async () => (await mails(to)).length, { timeout: 10_000 }).toBeGreaterThan(previous);
  const last = (await mails(to)).at(-1)!;
  expect(last.kind).toBe('code');
  expect(last.subject).not.toMatch(/\d{6}/u);
  const m = /\b(\d{6})\b/u.exec(last.text);
  if (!m) throw new Error('no code in the mail');
  return { code: m[1] as string, subject: last.subject };
}

/** A partner app's email login through the vault's popup: the chooser, the address, the code. */
async function partnerEmailLogin(page: Page, to: string): Promise<{ stellar: string; evm: string }> {
  const popupP = page.waitForEvent('popup');
  await clickAction(page, 'login', 'login');
  const popup = await popupP;
  await popup.click('#continue-email');
  await popup.waitForURL(/\/login\/email#/u);
  await popup.fill('#email-address', to);
  const before = (await mails(to)).length;
  await clickUntilTaken(popup, '#email-send');
  await expect(popup.locator('#email-code')).toBeVisible();
  await popup.fill('#email-code', (await codeFor(to, before)).code);
  await clickClosing(popup, '#email-verify');
  const wallet = await okValue<{ stellar: string; evm: string }>(page, 'login');
  await waitPersisted(page, wallet.evm);
  return wallet;
}

/** Hana Home's own email sign-in, with the code from the outbox. `shotsAs`: save the address and code screens. */
async function homeEmailSignIn(home: Page, to: string, browserName: string, shotsAs?: string): Promise<void> {
  await home.getByRole('button', { name: 'Continue with email' }).click();
  await expect(home.getByRole('heading', { name: 'Sign in with email' })).toBeVisible();
  await home.fill('#home-email-address', to);
  if (shotsAs) await shots(home, `${shotsAs}-email-entry`, browserName);
  const before = (await mails(to)).length;
  await home.locator('#home-email-send').click();
  await expect(home.locator('#home-email-code')).toBeVisible();
  await expect(home.locator('#home-email-code')).toHaveAttribute('autocomplete', 'one-time-code');
  const { code, subject } = await codeFor(to, before);
  expect(subject).toBe('Your sign-in code for Hana Home');
  if (shotsAs) await shots(home, `${shotsAs}-code-entry`, browserName);
  await home.fill('#home-email-code', code);
  await home.locator('#home-email-verify').click();
  await expect(home.locator('#home-who')).toHaveText(`Signed in as ${to}`);
}

/** `GET /v1/home/config` through the real API, with `patch` applied to its answer. */
async function patchConfig(context: BrowserContext, patch: Record<string, unknown>): Promise<void> {
  await context.route(`${API_URL}/v1/home/config`, async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: HOME_CORS });
    const res = await route.fetch();
    const body = { ...((await res.json()) as Record<string, unknown>), ...patch };
    return route.fulfill({ response: res, body: JSON.stringify(body) });
  });
}

test('an email user signs in to Hana Home with a code and sees their app and addresses, from the real issuer and API', async ({ page, context, browserName }, info) => {
  test.setTimeout(150_000);
  const scopeId = newScope(browserName);
  const name = 'Email Home App';
  const app = await newApp({ name, scopeId, loginMethods: 'google,email' });
  await openPartner(page, app);
  const to = address(info, 'list');
  const wallet = await partnerEmailLogin(page, to);
  await expect.poll(async () => (await walletDirectory(wallet.stellar)).length, { timeout: 15_000 }).toBe(1);

  const home = await context.newPage();
  const response = await home.goto(`${AUTH_ORIGIN}/home`);
  // What the auth origin's storage holds already (the partner login's email step keeps a device ticket there).
  const storage = () => home.evaluate(() => ({ session: Object.keys(sessionStorage).sort(), local: Object.keys(localStorage).sort(), url: location.href }));
  const stored = await storage();
  // The issuer joins Hana Home's policy (its email sign-in); nothing else changes.
  expect(response?.headers()['content-security-policy'] ?? '').toContain(new URL(ISSUER_URL).origin);
  await expect(home.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await expect(home.getByRole('button', { name: 'Continue with email' })).toBeVisible();
  await shots(home, 'h10-01-method-choice', browserName);
  let popups = 0;
  home.on('popup', () => {
    popups += 1;
  });
  await homeEmailSignIn(home, to, browserName, 'h10-02');
  // No window: the code screens are on the page.
  expect(popups).toBe(0);
  const card = home.locator(`.home-card[data-scope="${scopeId}"]`);
  await expect(card).toContainText(name);
  await expect(card.locator('.home-card-foot .badge')).toHaveText('Stays reachable');
  await shots(home, 'h10-04-signed-in-list', browserName);
  await card.getByRole('button', { name: `View ${name}` }).click();
  await expect(home.locator('#home-address-stellar')).toHaveText(wallet.stellar);
  await expect(home.locator('#home-address-evm')).toHaveText(wallet.evm);
  // Memory only: Hana Home added nothing to storage (no device ticket either) and nothing to its address.
  expect(await storage()).toEqual({ ...stored, url: `${AUTH_ORIGIN}/home` });

  // Moving the wallet out: a new code to the same address, then the wallet the partner login opened.
  await home.locator('#home-export-open').click();
  await expect(home.locator('#home-export-start')).toHaveText('Continue with a code');
  await shots(home, 'h10-05-move-intro-email', browserName);
  await home.locator('#home-export-start').click();
  await expect(home.locator('#home-export-email-to')).toHaveText(to);
  await shots(home, 'h10-06-move-send-code', browserName);
  const before = (await mails(to)).length;
  await home.locator('#home-export-email-send').click();
  await expect(home.locator('#home-export-email-code')).toBeVisible();
  const { code, subject } = await codeFor(to, before);
  expect(subject).toBe('Your code to open a wallet in Hana Home');
  await shots(home, 'h10-07-move-code-entry', browserName);
  await home.fill('#home-export-email-code', code);
  await home.locator('#home-export-email-verify').click();
  await expect(home.locator('#home-export-title')).toHaveText('Your wallet is open', { timeout: 20_000 });
  await expect(home.locator('#home-export-address-stellar')).toHaveText(wallet.stellar);
  await expect(home.locator('#home-export-address-evm')).toHaveText(wallet.evm);
  await shots(home, 'h10-08-move-open-email', browserName);
  // The key is the address's own (read off the page, never printed).
  await home.locator('#home-export-stellar').click();
  await home.locator('#home-export-confirm').fill('EXPORT');
  await guardedClick(home, 'Continue');
  await home.locator('#home-export .reveal-ack input').check();
  await guardedClick(home, 'Show key');
  await expect(home.locator('#home-export .secret')).toHaveText(STELLAR_SEED);
  expect(addressOfExport('stellar', (await home.locator('#home-export .secret').textContent()) ?? '')).toBe(wallet.stellar);
  await home.locator('#home-export-lock').click();
  expect(popups).toBe(0);
});

test('the email screens’ refusals: a wrong code, a limit, the issuer unreachable, email sign-in off', async ({ context, browserName }, info) => {
  test.setTimeout(90_000);
  const home = await context.newPage();
  if (process.env.H10_DEBUG) {
    home.on('request', (r) => console.log('REQ', r.method(), r.url()));
    home.on('requestfailed', (r) => console.log('FAILED', r.method(), r.url(), r.failure()?.errorText));
    home.on('response', (r) => console.log('RES', r.status(), r.url()));
    home.on('console', (m) => console.log('CONSOLE', m.text()));
  }
  await home.goto(`${AUTH_ORIGIN}/home`);
  const to = address(info, 'errors');
  await home.getByRole('button', { name: 'Continue with email' }).click();
  // An address that isn't one.
  await home.fill('#home-email-address', 'not-an-address');
  await home.locator('#home-email-send').click();
  await expect(home.locator('#home-email-notice')).toHaveText('Enter a valid email address.');
  await shots(home, 'h10-09-invalid-address', browserName);
  // A wrong code, from the real issuer.
  await home.fill('#home-email-address', to);
  const before = (await mails(to)).length;
  await home.locator('#home-email-send').click();
  const { code } = await codeFor(to, before);
  await home.fill('#home-email-code', code === '000000' ? '111111' : '000000');
  await home.locator('#home-email-verify').click();
  await expect(home.locator('#home-email-notice')).toHaveText('That code is wrong. 4 tries left.');
  await shots(home, 'h10-10-wrong-code', browserName);
  await home.getByRole('button', { name: 'Cancel' }).click();

  // A limit, then the issuer unreachable (routed: the real limits need many mails).
  let answer: 'limit' | 'down' | 'off' = 'limit';
  await context.route(`${ISSUER_URL}/v1/email/home/start`, async (route) => {
    const cors = { 'access-control-allow-origin': AUTH_ORIGIN, 'content-type': 'application/json' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST' } });
    if (answer === 'limit') return route.fulfill({ status: 429, headers: { ...cors, 'retry-after': '900' }, body: JSON.stringify({ error: 'x', code: 'rate_limited' }) });
    if (answer === 'down') return route.abort('connectionrefused');
    return route.fulfill({ status: 409, headers: cors, body: JSON.stringify({ error: 'x', code: 'home_email_unavailable' }) });
  });
  await home.getByRole('button', { name: 'Continue with email' }).click();
  await home.fill('#home-email-address', to);
  await home.locator('#home-email-send').click();
  await expect(home.locator('#home-email-notice')).toHaveText('Too many attempts. Try again later.');
  await shots(home, 'h10-11-limit', browserName);
  answer = 'down';
  await home.locator('#home-email-send').click();
  await expect(home.locator('#home-email-notice')).toContainText('can’t be reached right now');
  await expect(home.locator('#home-email-retry')).toBeVisible();
  await shots(home, 'h10-12-unreachable', browserName);
  answer = 'off';
  await home.locator('#home-email-retry').click();
  await expect(home.locator('#home-sign-in-problem')).toContainText('Email sign-in to Passport Home isn’t available right now.');
  await shots(home, 'h10-13-email-off', browserName);
});

test('Google through the exit client: with no shared client in force, Hana Home signs in through /home/callback', async ({ context, google, browserName }) => {
  test.setTimeout(90_000);
  freshAccounts(google);
  await patchConfig(context, { sharedGoogleClientId: null });
  const home = await context.newPage();
  await home.goto(`${AUTH_ORIGIN}/home`);
  await expect(home.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  const before = google.requests.length;
  await signIn(home);
  // The exit client, answered at its only redirect.
  expect(google.requests.slice(before)).toEqual([expect.objectContaining({ ok: true, request: expect.objectContaining({ kind: 'login', clientId: EXIT_CLIENT_ID, redirectUri: `${AUTH_ORIGIN}/home/callback`, maxAge: null }) })]);
  await expect(home.getByText('Signed in with Google')).toBeVisible();
  await shots(home, 'h10-14-exit-signed-in', browserName);
});

test('/home/callback refuses an answer it didn’t start, and the shared client can’t answer there', async ({ page }) => {
  await page.goto(`${AUTH_ORIGIN}/home/callback#id_token=x.y.z&state=${'a'.repeat(43)}`);
  await expect(page.getByText('This sign-in has expired or was already used')).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  // The stub refuses the exit client at /login/callback and any other client at /home/callback, as Google would.
  const { checkAuthRequest } = await import('../src/google-stub.ts');
  const base = { response_type: 'id_token', response_mode: 'fragment', scope: 'openid', nonce: 'n'.repeat(43), state: 'a'.repeat(43), prompt: 'select_account' };
  const url = (q: Record<string, string>) => new URL(`https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ ...base, ...q })}`);
  expect(checkAuthRequest(url({ client_id: EXIT_CLIENT_ID, redirect_uri: `${AUTH_ORIGIN}/login/callback` })).ok).toBe(false);
  expect(checkAuthRequest(url({ client_id: 'e2e-shared.apps.googleusercontent.com', redirect_uri: `${AUTH_ORIGIN}/home/callback` })).ok).toBe(false);
  expect(checkAuthRequest(url({ client_id: EXIT_CLIENT_ID, redirect_uri: `${AUTH_ORIGIN}/home/callback` })).ok).toBe(true);
});

test('export for an app whose coverage is exit: the per-app sign-in goes through the exit client and opens the partner login’s wallet', async ({ page, context, google, browserName }) => {
  test.setTimeout(150_000);
  freshAccounts(google);
  const scopeId = newScope(browserName);
  const name = 'Exit Route App';
  const app = await newApp({ name, scopeId });
  await openPartner(page, app);
  const wallet = await login(page);
  await expect.poll(async () => (await walletDirectory(wallet.stellar)).length, { timeout: 15_000 }).toBe(1);

  // The real list, with this app's coverage made `exit` (its shared login turned off since): the exit client is the one
  // Hana Home must use for it (D490).
  await context.route(`${API_URL}/v1/home/apps**`, async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: HOME_CORS });
    const res = await route.fetch();
    const body = (await res.json()) as { scopes: Record<string, unknown>[] };
    body.scopes = body.scopes.map((s) => (s.scopeId === scopeId ? { ...s, coverage: 'exit', googleClientId: EXIT_CLIENT_ID } : s));
    return route.fulfill({ response: res, body: JSON.stringify(body) });
  });
  const home = await context.newPage();
  await home.goto(`${AUTH_ORIGIN}/home`);
  await signIn(home);
  await home.locator(`.home-card[data-scope="${scopeId}"]`).getByRole('button', { name: `View ${name}` }).click();
  await home.locator('#home-export-open').click();
  await expect(home.locator('#home-export-start')).toHaveText('Sign in again to continue');
  await shots(home, 'h10-15-move-intro-exit', browserName);
  const before = google.requests.length;
  const childP = home.waitForEvent('popup');
  await home.locator('#home-export-start').click();
  await chooseAccount(await childP);
  expect(google.requests.slice(before)).toEqual([expect.objectContaining({ ok: true, request: expect.objectContaining({ clientId: EXIT_CLIENT_ID, redirectUri: `${AUTH_ORIGIN}/home/callback`, maxAge: '0' }) })]);
  await expect(home.locator('#home-export-title')).toHaveText('Your wallet is open', { timeout: 20_000 });
  await expect(home.locator('#home-export-address-stellar')).toHaveText(wallet.stellar);
  await expect(home.locator('#home-export-address-evm')).toHaveText(wallet.evm);
  await shots(home, 'h10-16-move-open-exit', browserName);
});
