// Passport Home's "Ways to sign in" (D874) against the stack: the real Home page, its real NEAR reads of the mocked
// chain's accounts and links, and the sign-in window's own Cancel and Remove, which the section's lines point to (Home
// itself can't cancel or remove a sign-in: home-sign-ins.ts says why). Each test has a scope, a Google account and an
// address of its own. Every page on Journear's sign-in origin (Home and the sign-in windows) fails the test on a
// console error, an uncaught error or a CSP violation.
//
// With HANA_SHOTS_DIR set (Chromium only), the founder's screens are saved there at phone width (390), light:
// `home-sign-ins-one`, `home-sign-ins-several-waiting`, `home-sign-ins-member`, `remove-confirmation` and
// `remove-result` (the sign-in window's own screens the line points to), `home-sign-ins-after-remove` and
// `home-sign-ins-read-failed`.
import type { BrowserContext, Page, TestInfo } from '@playwright/test';
import type { GoogleStub } from '../src/google-stub.ts';
import { API_URL, AUTH_ORIGIN, ISSUER_URL, NEAR_RPC, NEAR_RPC_FALLBACK } from '../src/stack.ts';
import { type App, clickAction, clickClosing, clickMayClose, clickUntilTaken, closeOf, errorOf, expect, newApp, okValue, openPartner, peek, runAction, test, waitPersisted, walletDirectory } from './fixtures.ts';
import { signIn } from './home-steps.ts';

const SHOTS = process.env.HANA_SHOTS_DIR;
const PHONE = { width: 390, height: 844 };
const rand = (): string => crypto.randomUUID().replace(/-/gu, '').slice(0, 10);
const newSub = (): string => `1${Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => String(b % 10)).join('')}`;
const outside = (info: TestInfo, tag: string): string => `e2e-si${tag}-${info.project.name}-${rand()}@mail-e2e.example.com`;
const newScope = (browserName: string): string => `si${browserName}${rand()}`;

type Mail = { subject: string; text: string; kind: string };
const mails = async (to: string): Promise<Mail[]> => (await (await fetch(`${ISSUER_URL}/__e2e/outbox?to=${encodeURIComponent(to)}`)).json()) as Mail[];
const codeCount = async (to: string): Promise<number> => (await mails(to)).filter((m) => m.kind === 'code').length;
async function codeFor(to: string, previous: number): Promise<string> {
  await expect.poll(() => codeCount(to), { timeout: 10_000 }).toBeGreaterThan(previous);
  const codes = (await mails(to)).filter((m) => m.kind === 'code');
  const m = /\b(\d{6})\b/u.exec(codes[codes.length - 1]!.text);
  if (!m) throw new Error('no code in the mail');
  return m[1] as string;
}

/** Saves `page` at phone width, light (Chromium only, with HANA_SHOTS_DIR). */
async function shot(page: Page, name: string, browserName: string): Promise<void> {
  await page.setViewportSize(PHONE);
  await page.emulateMedia({ colorScheme: 'light' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${name}: no sideways scroll`).toBe(true);
  if (SHOTS && browserName === 'chromium') await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true, animations: 'disabled' });
}

/**
 * The browser's own line when the Google callback's D347 signals (sent with the vault's origin as their target, so
 * only a vault frame can read them) meet an opener that isn't one, as Home's sign-in child is: the browser refusing
 * the delivery, by design (callback-page.ts). Not an error of the page.
 */
const D347_SIGNAL = /^Unable to post message to \S+\. Recipient has origin /u;

/**
 * Passport Home (every `/home` page in this context): console errors and uncaught errors. Every page of the sign-in
 * origin, the sign-in windows included: CSP violations (an init script reports each as a console error) and uncaught
 * errors. (Firefox logs a font download cut off by a window closing, and the D347 refusal above, on the sign-in windows:
 * the browser's lines, not the pages', so their other console lines aren't held here.) Returns what was seen so far.
 */
async function watchAuthPages(context: BrowserContext): Promise<() => string[]> {
  const seen: string[] = [];
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP violation: ${e.effectiveDirective} ${e.blockedURI}`));
  });
  const watch = (p: Page): void => {
    p.on('console', (m) => {
      if (m.type() !== 'error' || !p.url().startsWith(AUTH_ORIGIN)) return;
      const home = new URL(p.url()).pathname === '/home';
      if (m.text().startsWith('CSP violation') || (home && !D347_SIGNAL.test(m.text()))) seen.push(`${p.url()}: ${m.text()}`);
    });
    p.on('pageerror', (e) => {
      if (p.url().startsWith(AUTH_ORIGIN)) seen.push(`${p.url()}: ${e.message}`);
    });
  };
  for (const p of context.pages()) watch(p);
  context.on('page', watch);
  return () => seen;
}

/** The NEAR view calls a page made, by method. */
function nearViews(page: Page): () => string[] {
  const out: string[] = [];
  const rpc = [new URL(NEAR_RPC).origin, new URL(NEAR_RPC_FALLBACK).origin];
  page.on('request', (r) => {
    if (r.method() !== 'POST' || !rpc.includes(new URL(r.url()).origin)) return;
    const m = /"method_name":"([a-z_]+)"/u.exec(r.postData() ?? '');
    if (m) out.push(m[1] as string);
  });
  return () => out;
}

async function emailCode(popup: Page, to: string): Promise<void> {
  await expect(popup.locator('#email-address')).toBeVisible();
  await popup.fill('#email-address', to);
  const before = await codeCount(to);
  await clickUntilTaken(popup, '#email-send');
  await expect(popup.locator('#email-code')).toBeVisible();
  await popup.fill('#email-code', await codeFor(to, before));
  await clickMayClose(popup, '#email-verify');
}

async function emailLogin(page: Page, to: string, name: string): Promise<{ stellar: string; evm: string }> {
  const popupP = page.waitForEvent('popup');
  await clickAction(page, name, 'loginWith', { method: 'email' });
  const popup = await popupP;
  const closed = closeOf(popup);
  await emailCode(popup, to);
  await closed;
  const w = await okValue<{ stellar: string; evm: string }>(page, name);
  await waitPersisted(page, w.evm);
  return w;
}

async function googleStart(page: Page, name: string): Promise<Page> {
  const popupP = page.waitForEvent('popup');
  await clickAction(page, name, 'login');
  const popup = await popupP;
  await popup.click('#continue-google');
  await popup.waitForURL(/accounts\.google\.com/u);
  await clickMayClose(popup, '#account-0');
  return popup;
}

async function logout(page: Page, name: string): Promise<void> {
  await runAction(page, name, 'logout');
  await okValue(page, name);
}

const linkEvents = (page: Page): Promise<unknown[]> => page.evaluate(() => (window as any).e2e.events.filter((e: { name: string }) => e.name === 'linkChanged').map((e: { data: unknown }) => e.data));

/** A Google wallet in its own app, with the (not Google-hosted) address `to` linked to it, waiting 24 hours (case B). */
async function waitingEmail(page: Page, google: GoogleStub, info: TestInfo, browserName: string, tag: string): Promise<{ app: App; scopeId: string; name: string; sub: string; to: string; wallet: { stellar: string; evm: string } }> {
  const to = outside(info, tag);
  const sub = newSub();
  google.accounts = [{ sub, label: tag.toUpperCase(), email: to, emailVerified: true }];
  const scopeId = newScope(browserName);
  const name = `Sign-ins ${tag}`;
  const app = await newApp({ name, scopeId, loginMethods: 'google,email' });
  await openPartner(page, app);
  const first = await googleStart(page, 'google');
  await closeOf(first);
  const wallet = await okValue<{ stellar: string; evm: string }>(page, 'google');
  await waitPersisted(page, wallet.evm);
  await logout(page, 'out');
  const linkP = page.waitForEvent('popup');
  await clickAction(page, 'link', 'loginWith', { method: 'email' });
  const linking = await linkP;
  await emailCode(linking, to);
  await linking.click('#email-link-google');
  await linking.waitForURL(/accounts\.google\.com/u);
  await linking.click('#account-0');
  expect(await okValue(page, 'link')).toEqual(wallet);
  await clickClosing(linking, '#banner-done');
  await logout(page, 'out2');
  await expect.poll(async () => (await walletDirectory(wallet.stellar)).length, { timeout: 15_000 }).toBeGreaterThan(0);
  return { app, scopeId, name, sub, to, wallet };
}

async function homeEmailSignIn(home: Page, to: string): Promise<void> {
  await home.getByRole('button', { name: 'Continue with email' }).click();
  await home.fill('#home-email-address', to);
  const before = await codeCount(to);
  await home.locator('#home-email-send').click();
  await expect(home.locator('#home-email-code')).toBeVisible();
  await home.fill('#home-email-code', await codeFor(to, before));
  await home.locator('#home-email-verify').click();
  await expect(home.locator('#home-who')).toHaveText(`Signed in as ${to}`);
}

async function openApp(home: Page, scopeId: string, name: string): Promise<void> {
  await home.locator(`.home-card[data-scope="${scopeId}"]`).getByRole('button', { name: `View ${name}` }).click();
  await expect(home.locator('#home-sign-ins-title')).toHaveText('Ways to sign in');
}

const signInRows = (home: Page) => home.locator('#home-sign-ins-list > li');
const sectionButtons = async (home: Page): Promise<string[]> => home.locator('#home-sign-ins button').allTextContents();

test('an email-only wallet: Home reads nothing until asked, then shows one sign-in, the address in full, and nothing to remove', async ({ page, context, browserName }, info) => {
  test.setTimeout(150_000);
  const problems = await watchAuthPages(context);
  const scopeId = newScope(browserName);
  const name = 'Sign-ins one';
  const app = await newApp({ name, scopeId, loginMethods: 'google,email' });
  await openPartner(page, app);
  const to = outside(info, 'one');
  const wallet = await emailLogin(page, to, 'login');
  await expect.poll(async () => (await walletDirectory(wallet.stellar)).length, { timeout: 15_000 }).toBe(1);

  const home = await context.newPage();
  const views = nearViews(home);
  await home.goto(`${AUTH_ORIGIN}/home`);
  await homeEmailSignIn(home, to);
  await openApp(home, scopeId, name);
  expect(views()).toEqual([]);
  expect(await sectionButtons(home)).toEqual(['Show ways to sign in']);
  await home.locator('#home-sign-ins-show').click();
  await expect(signInRows(home)).toHaveCount(1);
  expect(views()).toEqual(['get_identity', 'get_account']);
  const only = signInRows(home).first();
  await expect(only).toHaveAttribute('data-role', 'first');
  await expect(only).toHaveAttribute('data-you', 'true');
  await expect(only).toContainText(to);
  await expect(only).toContainText('You’re signed in with this now');
  await expect(only).toContainText('The wallet was made with this sign-in, so it can’t be removed.');
  expect(await sectionButtons(home)).toEqual(['Show again']);
  await shot(home, 'home-sign-ins-one', browserName);
  // Back to the list and in again: shown from memory, nothing read.
  await home.locator('#home-back').click();
  await openApp(home, scopeId, name);
  await expect(signInRows(home)).toHaveCount(1);
  expect(views()).toHaveLength(2);
  // Nothing in storage or the address (D619, D553).
  expect(await home.evaluate(() => location.href)).toBe(`${AUTH_ORIGIN}/home`);
  expect(problems()).toEqual([]);
});

test('a waiting link shows as waiting with where to cancel it; cancelled there (the sign-in window’s Cancel this link), Home shows one sign-in again', async ({ page, context, google, browserName }, info) => {
  test.setTimeout(180_000);
  const problems = await watchAuthPages(context);
  const { scopeId, name, sub } = await waitingEmail(page, google, info, browserName, 'w');

  const home = await context.newPage();
  const views = nearViews(home);
  await home.goto(`${AUTH_ORIGIN}/home`);
  await signIn(home);
  await openApp(home, scopeId, name);
  await home.locator('#home-sign-ins-show').click();
  await expect(signInRows(home)).toHaveCount(2);
  expect(await signInRows(home).evaluateAll((els) => els.map((e) => [e.getAttribute('data-kind'), e.getAttribute('data-role'), e.getAttribute('data-you')]))).toEqual([
    ['google', 'first', 'true'],
    ['email', 'waiting', 'false'],
  ]);
  const waiting = home.locator('#home-sign-ins-list > li[data-role="waiting"]');
  await expect(waiting).toContainText('Another email address');
  await expect(waiting).toContainText('Waiting');
  await expect(waiting).toContainText('Starts opening this wallet on');
  await expect(waiting.locator('.home-sign-in-risk')).toContainText('Didn’t add it? Sign in to this app the way you signed in here, and choose Cancel this link.');
  // The other sign-in's address is never on the page.
  expect(await home.locator('#home-sign-ins').textContent()).not.toContain('@');
  expect(await sectionButtons(home)).toEqual(['Show again']);
  await shot(home, 'home-sign-ins-several-waiting', browserName);

  // Where the line points: a sign-in to the app with this Google account, and its banner's Cancel this link.
  const popup = await googleStart(page, 'g2');
  await expect(popup.locator('#banner-cancel-0')).toHaveText('Cancel this link');
  await clickClosing(popup, '#banner-cancel-0');
  await expect.poll(() => linkEvents(page)).toContainEqual({ provider: 'email', status: 'removed', effectiveAtMs: null });
  expect(google.requests.filter((r) => r.ok && r.request.kind === 'proof').map((r) => r.ok && r.request.loginHint)).toEqual([sub]);

  // Home, read again: one sign-in.
  await home.bringToFront();
  await home.locator('#home-sign-ins-again').click();
  await expect(signInRows(home)).toHaveCount(1);
  await expect(signInRows(home).first()).toHaveAttribute('data-role', 'first');
  expect(views()).toEqual(['get_identity', 'get_account', 'get_identity', 'get_account']);
  expect(problems()).toEqual([]);
});

test('a link that took effect: listed with where to remove it; removed from its own sign-in (D865), Home shows one, and that email then opens a new, empty wallet', async ({ page, context, google, browserName }, info) => {
  test.setTimeout(240_000);
  const problems = await watchAuthPages(context);
  const { scopeId, name, sub, to, wallet } = await waitingEmail(page, google, info, browserName, 'r');
  // The waiting period ends (the stack's test hook, as tests/linking.spec.ts does).
  expect((await (await fetch(`${API_URL}/__e2e/links/expire`, { method: 'POST', body: JSON.stringify({ rootSub: sub }) })).json()) as unknown).toEqual({ moved: 1 });

  const home = await context.newPage();
  await home.goto(`${AUTH_ORIGIN}/home`);
  await signIn(home);
  await openApp(home, scopeId, name);
  await home.locator('#home-sign-ins-show').click();
  await expect(signInRows(home)).toHaveCount(2);
  const member = home.locator('#home-sign-ins-list > li[data-role="member"]');
  await expect(member).toContainText('Another email address');
  await expect(member).toContainText('Opens this wallet since');
  await expect(member).toContainText('Added at a sign-in, after a code was sent to this email address.');
  await expect(member).toContainText('Didn’t add it? Sign in to this app the way you signed in here, before');
  expect(await sectionButtons(home)).toEqual(['Show again']);
  await shot(home, 'home-sign-ins-member', browserName);

  // The email's own sign-in asks first (D865); Remove, its confirmation, one more code.
  const p = page.waitForEvent('popup');
  await clickAction(page, 'member', 'loginWith', { method: 'email' });
  const popup = await p;
  await emailCode(popup, to);
  await expect(popup.locator('#member-link')).toBeVisible();
  expect(await peek(page, 'member')).toMatchObject({ state: 'pending' });
  await popup.click('#member-remove');
  await expect(popup.locator('h1')).toHaveText('Remove this email from that wallet?');
  await shot(popup, 'remove-confirmation', browserName);
  const before = await codeCount(to);
  await popup.click('#member-remove-confirm');
  expect(await errorOf(page, 'member')).toEqual({ code: 'login_cancelled', reason: 'link_remove' });
  await popup.fill('#email-code', await codeFor(to, before));
  await popup.click('#email-verify');
  await expect(popup.locator('#member-removed')).toHaveAttribute('data-outcome', 'removed');
  await shot(popup, 'remove-result', browserName);
  await clickClosing(popup, '#member-removed-close');

  // Home, read again: one sign-in.
  await home.bringToFront();
  await home.locator('#home-sign-ins-again').click();
  await expect(signInRows(home)).toHaveCount(1);
  await expect(signInRows(home).first()).toHaveAttribute('data-kind', 'google');
  await shot(home, 'home-sign-ins-after-remove', browserName);

  // That email now opens a new, empty wallet of its own, and Home, signed in with it, shows it alone.
  const own = await emailLogin(page, to, 'after');
  expect(own.evm).not.toBe(wallet.evm);
  expect(own.stellar).not.toBe(wallet.stellar);
  await expect.poll(async () => (await walletDirectory(own.stellar)).length, { timeout: 15_000 }).toBe(1);
  const home2 = await context.newPage();
  await home2.goto(`${AUTH_ORIGIN}/home`);
  await homeEmailSignIn(home2, to);
  await openApp(home2, scopeId, name);
  await expect(home2.locator('#home-address-stellar')).toHaveText(own.stellar);
  await home2.locator('#home-sign-ins-show').click();
  await expect(signInRows(home2)).toHaveCount(1);
  await expect(signInRows(home2).first()).toHaveAttribute('data-kind', 'email');
  await expect(signInRows(home2).first()).toHaveAttribute('data-you', 'true');
  expect(problems()).toEqual([]);
});

test('a failed read says so plainly with Try again, changes nothing, and Try again reads the list', async ({ page, context, browserName }, info) => {
  test.setTimeout(150_000);
  const problems = await watchAuthPages(context);
  const scopeId = newScope(browserName);
  const name = 'Sign-ins failed';
  const app = await newApp({ name, scopeId, loginMethods: 'google,email' });
  await openPartner(page, app);
  const to = outside(info, 'fail');
  const wallet = await emailLogin(page, to, 'login');
  await expect.poll(async () => (await walletDirectory(wallet.stellar)).length, { timeout: 15_000 }).toBe(1);

  const home = await context.newPage();
  await home.goto(`${AUTH_ORIGIN}/home`);
  await homeEmailSignIn(home, to);
  await openApp(home, scopeId, name);
  // Both NEAR providers answer the views with an error (as a provider that is down would, with a JSON-RPC error).
  const rpc = [new URL(NEAR_RPC).origin, new URL(NEAR_RPC_FALLBACK).origin];
  const down = async (route: import('@playwright/test').Route): Promise<void> => {
    const r = route.request();
    if (r.method() !== 'POST' || !/"method_name":"get_(identity|account)"/u.test(r.postData() ?? '')) return route.continue();
    const res = await route.fetch();
    return route.fulfill({ response: res, body: JSON.stringify({ jsonrpc: '2.0', id: 'hana-auth', error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN' }, message: 'down' } }) });
  };
  const match = (u: URL): boolean => rpc.includes(u.origin);
  await home.route(match, down);
  await home.locator('#home-sign-ins-show').click();
  const problem = home.locator('#home-sign-ins-problem');
  await expect(problem).toContainText('Passport Home couldn’t check the ways to sign in. Nothing was changed. Try again in a moment.');
  await expect(problem).toContainText('Error code (for support): sign_ins_unreadable');
  await expect(signInRows(home)).toHaveCount(0);
  expect(await sectionButtons(home)).toEqual(['Try again']);
  await shot(home, 'home-sign-ins-read-failed', browserName);
  await home.unroute(match, down);
  await home.locator('#home-sign-ins-retry').click();
  await expect(signInRows(home)).toHaveCount(1);
  expect(problems()).toEqual([]);
});
