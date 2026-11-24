// Passport Home's "Ways to sign in" (D874) against the stack: the real Home page, its real NEAR reads of the mocked
// chain's accounts and links, and the sign-in window's own Cancel and Remove, which the section's lines point to (Home
// itself can't cancel or remove a sign-in: home-sign-ins.ts says why). Each test has a scope, a Google account and an
// address of its own. Every page on Journear's sign-in origin (Home and the sign-in windows) fails the test on a
// console error (but the two browser lines `ALLOWED_BROWSER_LINES` names exactly), an uncaught error or a CSP
// violation.
//
// Both NEAR providers are read, each alone, and must agree (D874 as amended); a failed read shows no list.
//
// With HANA_SHOTS_DIR set (Chromium only), the founder's screens are saved there at phone width (390), light:
// `home-sign-ins-one`, `home-sign-ins-several-waiting`, `home-sign-ins-member`, `remove-confirmation` and
// `remove-result` (the sign-in window's own screens the line points to), `home-sign-ins-after-remove`,
// `home-sign-ins-read-failed`, and D875's `home-sign-ins-member-older` and `sign-in-older-line` (the wallet's own
// sign-in, an added one past its first 7 days).
import type { BrowserContext, Page, TestInfo } from '@playwright/test';
import type { GoogleStub } from '../src/google-stub.ts';
import { API_URL, AUTH_ORIGIN, ISSUER_URL, NEAR_RPC, NEAR_RPC_FALLBACK, PARTNER_ORIGIN, VAULT_ORIGIN } from '../src/stack.ts';
import { type App, chooseAccount, clickAction, clickClosing, clickMayClose, actionUnderSentence, clickUntilTaken, closeOf, errorOf, expect, newApp, okValue, openPartner, peek, runAction, seenText, test, waitPersisted, walletDirectory } from './fixtures.ts';
import { HOME_CORS, homeTab, signIn } from './home-steps.ts';

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

const esc = (t: string): string => t.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&');
const RECIPIENTS = `(${[AUTH_ORIGIN, PARTNER_ORIGIN].map(esc).join('|')})`;
/**
 * The two browser lines the sign-in origin's pages are allowed, each named exactly:
 * - D347: the Google callback sends its signals with the vault's origin as the target (only a vault frame may read
 *   them); when its opener is Home or the partner page itself, the browser refuses the delivery and says so (WebKit on
 *   the opener, Firefox on the callback). By design (callback-page.ts), not the page's error.
 * - Firefox's "downloadable font: download failed" for the sign-in origin's own IBM Plex files, when a sign-in window
 *   closes while its fonts load.
 */
const ALLOWED_BROWSER_LINES: readonly RegExp[] = [
  new RegExp(`^Unable to post message to ${esc(VAULT_ORIGIN)}\\. Recipient has origin ${RECIPIENTS}\\.?\\s*$`, 'u'),
  new RegExp(`Failed to execute ‘postMessage’ on ‘DOMWindow’: The target origin provided \\(‘${esc(VAULT_ORIGIN)}’\\) does not match the recipient window’s origin \\(‘${RECIPIENTS}’\\)`, 'u'),
  new RegExp(`downloadable font: download failed \\(font-family: "IBM Plex Sans"[^)]*\\): status=\\d+ source: ${esc(AUTH_ORIGIN)}/assets/files/ibm-plex-sans-\\d+-[A-Z0-9]+\\.woff2`, 'u'),
];

/**
 * Every page of the sign-in origin in this context (Passport Home and the sign-in windows): console errors other than
 * the two browser lines above, uncaught errors, and CSP violations (an init script reports each as a console error, and
 * none is ever allowed). Returns what was seen so far.
 */
async function watchAuthPages(context: BrowserContext): Promise<() => string[]> {
  const seen: string[] = [];
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP violation: ${e.effectiveDirective} ${e.blockedURI}`));
  });
  const watch = (p: Page): void => {
    p.on('console', (m) => {
      if (m.type() !== 'error' || !p.url().startsWith(AUTH_ORIGIN)) return;
      const t = m.text();
      if (t.includes('CSP violation') || !ALLOWED_BROWSER_LINES.some((r) => r.test(t))) seen.push(`${p.url()}: ${t}`);
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
  await home.locator(`.home-row[data-scope="${scopeId}"]`).click();
  await homeTab(home, 'Security');
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
  // Both providers, each alone (D874 as amended).
  expect(views().sort()).toEqual(['get_account', 'get_account', 'get_identity', 'get_identity']);
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
  expect(views()).toHaveLength(4);
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
  // D902: a wallet on the shared Google client, viewed by its Google sign-in: Home's own Cancel this link (tested below).
  await expect(waiting.locator('.home-sign-in-risk p')).toHaveText(['Don’t recognise it? If you’re not sure, cancel it.', 'Cancel this link']);
  await expect(waiting.getByRole('button', { name: 'Cancel this link for the email address', exact: true })).toBeVisible();
  // The other sign-in's address is never on the page.
  expect(await home.locator('#home-sign-ins').textContent()).not.toContain('@');
  expect(await sectionButtons(home)).toEqual(['Cancel this link', 'Show again']);
  await shot(home, 'home-sign-ins-several-waiting', browserName);

  // Where the line points: a sign-in to the app with this Google account, and its banner's Cancel this link.
  const popup = await googleStart(page, 'g2');
  // D887: under its sentence, "Don't recognise it?" and a small outlined button whose name starts with its words and
  // says whose link it cancels.
  await expect(popup.getByRole('button', { name: 'Cancel this link for the email address', exact: true })).toHaveClass('jp-btn jp-btn-secondary jp-btn-sm');
  await expect.poll(() => seenText(popup.locator('#banner-cancel-0'))).toBe('Cancel this link');
  await expect.poll(() => seenText(popup.locator('#link-banners li[data-status="pending"] .banner-action'))).toBe('Don’t recognise it?Cancel this link');
  await actionUnderSentence(popup, popup.locator('#link-banners li[data-status="pending"] .banner-what'), popup.locator('#banner-cancel-0'));
  // D881: no confirmation for a cancel; the window says what became of it.
  await popup.getByRole('button', { name: 'Cancel this link for the email address', exact: true }).click();
  await expect(popup.locator('h1')).toHaveText('Link cancelled');
  await clickClosing(popup, '#link-change-close');
  await expect.poll(() => linkEvents(page)).toContainEqual({ provider: 'email', status: 'removed', effectiveAtMs: null });
  expect(google.requests.filter((r) => r.ok && r.request.kind === 'proof').map((r) => r.ok && r.request.loginHint)).toEqual([sub]);

  // Home, read again: one sign-in.
  await home.bringToFront();
  await home.locator('#home-sign-ins-again').click();
  await expect(signInRows(home)).toHaveCount(1);
  await expect(signInRows(home).first()).toHaveAttribute('data-role', 'first');
  expect(views()).toHaveLength(8);
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
  await expect(member).toContainText('Don’t recognise it? Sign in to this app the way you signed in here, and choose “Remove it”. If you’re not sure, remove it.');
  await expect(member).not.toContainText('before');
  await expect(home.locator('#home-sign-ins-sign-out-first')).toHaveText('If you’re already signed in to this app, sign out of it first.');
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

test('D875: an added sign-in past its first 7 days: Home says where Remove is; the wallet’s own sign-in shows it as one quiet line until Done in this browser, and removes it there', async ({ page, context, google, browserName }, info) => {
  test.setTimeout(240_000);
  const problems = await watchAuthPages(context);
  const { scopeId, name, sub } = await waitingEmail(page, google, info, browserName, 'o');
  // The link took effect 8 days ago (the stack's test hook).
  const DAY = 24 * 3_600_000;
  expect((await (await fetch(`${API_URL}/__e2e/links/age`, { method: 'POST', body: JSON.stringify({ rootSub: sub, ageMs: 8 * DAY }) })).json()) as unknown).toEqual({ moved: 1 });

  const home = await context.newPage();
  await home.goto(`${AUTH_ORIGIN}/home`);
  await signIn(home);
  await openApp(home, scopeId, name);
  await home.locator('#home-sign-ins-show').click();
  await expect(signInRows(home)).toHaveCount(2);
  const member = home.locator('#home-sign-ins-list > li[data-role="member"]');
  await expect(member).toContainText('Opens this wallet since');
  await expect(member.locator('.home-sign-in-how')).toHaveText(
    'Don’t recognise it? Sign in to this app the way you signed in here, and choose “Remove it”. If you’re not sure, remove it.Once you press “Done” in the sign-in window, that browser stops offering to remove it. Not offered? Try signing in in a private window.',
  );
  await expect(member.locator('.home-sign-in-risk')).toHaveCount(0);
  await expect(home.locator('#home-sign-ins')).not.toContainText('Nothing can remove it');
  await expect(home.locator('#home-sign-ins-sign-out-first')).toHaveText('If you’re already signed in to this app, sign out of it first.');
  await shot(home, 'home-sign-ins-member-older', browserName);

  // Where the line points: a sign-in with this Google account. The app has its wallet at once; the window shows one
  // plain line, and under it "Didn't add it?" and a small outlined Remove it (D887).
  const popup = await googleStart(page, 'old1');
  await expect(popup.locator('#link-older .older-link-text')).toContainText('An email address also opens this wallet, since');
  await expect(popup.getByRole('button', { name: 'Remove it (the email address)', exact: true })).toBeVisible();
  await expect.poll(() => seenText(popup.locator('#link-older .older-link .banner-action'))).toBe('Don’t recognise it?Remove it');
  await expect.poll(() => seenText(popup.locator('#banner-unlink-0'))).toBe('Remove it');
  await expect(popup.locator('#banner-unlink-0')).toHaveClass('jp-btn jp-btn-secondary jp-btn-sm');
  await expect(popup.locator('#banner-unlink-0')).toHaveAccessibleDescription(/^An email address also opens this wallet, since /u);
  await actionUnderSentence(popup, popup.locator('#link-older .older-link-text'), popup.locator('#banner-unlink-0'));
  await expect(popup.locator('#link-banners')).toHaveCount(0);
  await expect(popup.locator('#link-older')).toContainText('After you press Done, this browser won’t show this again. Passport Home lists the ways to sign in to your wallet.');
  // No delay for the app: its sign-in has finished while the window still shows the line.
  await expect.poll(() => peek(page, 'old1')).toMatchObject({ state: 'ok' });
  await shot(popup, 'sign-in-older-line', browserName);
  await clickClosing(popup, '#banner-done');
  await logout(page, 'out-old1');

  // Done used it up in this browser: the next sign-in's window closes by itself, as with nothing to show.
  const second = await googleStart(page, 'old2');
  await closeOf(second);
  await okValue(page, 'old2');
  await logout(page, 'out-old2');

  // A private window keeps nothing: as there, the line is shown again (this browser's memory of it cleared), and
  // its Remove removes the email.
  await home.evaluate(() => {
    for (const k of Object.keys(localStorage)) if (k.startsWith('hana.ol.')) localStorage.removeItem(k);
  });
  const third = await googleStart(page, 'old3');
  await expect.poll(() => seenText(third.locator('#banner-unlink-0'))).toBe('Remove it');
  // D881: Remove asks first, then says what became of it.
  await third.getByRole('button', { name: 'Remove it (the email address)', exact: true }).click();
  await expect(third.locator('h1')).toHaveText('Remove the email address from this wallet?');
  await shot(third, 'sign-in-remove-confirm', browserName);
  await third.click('#banner-remove-confirm');
  await expect(third.locator('h1')).toHaveText('The email address was removed');
  await expect(third.locator('#link-change-what')).toHaveText('The email address no longer opens this wallet. Removing it didn’t move any money.');
  await shot(third, 'sign-in-removed', browserName);
  await clickClosing(third, '#link-change-close');
  await expect.poll(() => linkEvents(page)).toContainEqual({ provider: 'email', status: 'removed', effectiveAtMs: null });
  expect(google.requests.filter((r) => r.ok && r.request.kind === 'proof').map((r) => r.ok && r.request.loginHint)).toEqual([sub]);

  await home.bringToFront();
  await home.locator('#home-sign-ins-again').click();
  await expect(signInRows(home)).toHaveCount(1);
  await expect(signInRows(home).first()).toHaveAttribute('data-role', 'first');
  expect(problems()).toEqual([]);
});

test('a failed read (both providers, or only one) says so plainly with Try again, shows no list, and Try again reads it', async ({ page, context, browserName }, info) => {
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
  await expect(problem).toContainText('Passport Home couldn’t confirm the ways to sign in, so it shows none. Nothing was changed. Try again in a moment.');
  await expect(problem).toContainText('Error code (for support): sign_ins_unreadable');
  await expect(signInRows(home)).toHaveCount(0);
  expect(await sectionButtons(home)).toEqual(['Try again']);
  await shot(home, 'home-sign-ins-read-failed', browserName);
  await home.unroute(match, down);
  // Only the second provider down: still no list (never one provider's word).
  const second = (u: URL): boolean => u.origin === new URL(NEAR_RPC_FALLBACK).origin;
  await home.route(second, down);
  await home.locator('#home-sign-ins-retry').click();
  await expect(problem).toContainText('Error code (for support): sign_ins_unreadable');
  await expect(signInRows(home)).toHaveCount(0);
  await home.unroute(second, down);
  await home.locator('#home-sign-ins-retry').click();
  await expect(signInRows(home)).toHaveCount(1);
  expect(problems()).toEqual([]);
});

/** Where the waiting row sends the person in the D898 test: an https web address on Journear's record of the app. */
const CANCEL_HERE = 'https://cancel-here.example';
/** Before and after screenshots of D898 option A (Chromium only). */
const WAITING_SHOTS = process.env.HANA_WAITING_SHOTS_DIR;

test('D898 option A: a waiting link has “Open {App} to cancel it”, which opens exactly the app’s web address on record in a new tab with no opener', async ({ page, context, google, browserName }, info) => {
  test.setTimeout(180_000);
  const problems = await watchAuthPages(context);
  const { scopeId, name } = await waitingEmail(page, google, info, browserName, 'a');
  // Journear's record of the app, as the API answers it, with an https web address in place of the local stack's http one.
  await context.route(`${API_URL}/v1/home/apps**`, async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { scopes?: { scopeId: string; apps: { origins: string[] }[] }[] };
    // D902: a wallet on its own Google client (not the shared one), so Home can't cancel it itself and option A applies.
    for (const s of (body.scopes ?? []) as { scopeId: string; coverage?: string; apps: { origins: string[] }[] }[]) if (s.scopeId === scopeId) {
      s.coverage = 'hana_client';
      for (const a of s.apps) a.origins = [CANCEL_HERE];
    }
    await route.fulfill({ response: res, json: body });
  });
  const opened: string[] = [];
  await context.route(`${CANCEL_HERE}/**`, async (route) => {
    opened.push(route.request().url());
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>App</title><p>The app</p>' });
  });

  const home = await context.newPage();
  await home.goto(`${AUTH_ORIGIN}/home`);
  await signIn(home);
  await openApp(home, scopeId, name);
  await home.locator('#home-sign-ins-show').click();
  const waiting = home.locator('#home-sign-ins-list > li[data-role="waiting"]');
  const link = waiting.getByRole('link', { name: `Open ${name} to cancel it (opens in a new tab)`, exact: true });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', CANCEL_HERE);
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAccessibleDescription(`Opens ${CANCEL_HERE} in a new tab.`);
  await expect(waiting.locator('.home-sign-in-risk p')).toHaveText([
    'Don’t recognise it? If you’re not sure, cancel it.',
    `Open ${name} to cancel it (opens in a new tab)`,
    `Opens ${CANCEL_HERE} in a new tab.`,
    'There, sign in the way you signed in here, and choose “Cancel this link”.',
  ]);
  // The summary line still says one is waiting; the section still says to sign out of the app first.
  await expect(home.locator('#home-sign-ins-waiting-line')).toHaveText('1 more starts opening it soon. Check it below.');
  await expect(home.locator('#home-sign-ins-sign-out-first')).toBeVisible();

  // At every width, light and dark: no sideways scroll, the link inside its box, at least 44 px tall on a phone.
  for (const width of [320, 360, 390, 430, 1280]) {
    for (const scheme of ['light', 'dark'] as const) {
      await home.setViewportSize({ width, height: 900 });
      await home.emulateMedia({ colorScheme: scheme });
      expect(await home.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${width} ${scheme}: no sideways scroll`).toBe(true);
      const box = await link.boundingBox();
      const card = await waiting.locator('.home-sign-in-risk').boundingBox();
      expect(box && card && box.x >= card.x && box.x + box.width <= card.x + card.width + 0.5, `${width}: the link inside its box`).toBe(true);
      if (width <= 640) expect(box!.height, `${width}: 44 px`).toBeGreaterThanOrEqual(43.5);
      if (WAITING_SHOTS && browserName === 'chromium' && (width === 390 || width === 1280)) {
        await waiting.scrollIntoViewIfNeeded();
        await home.screenshot({ path: `${WAITING_SHOTS}/waiting-open-to-cancel-w${width}${scheme === 'dark' ? '-dark' : ''}.png`, fullPage: true, animations: 'disabled' });
      }
    }
  }
  await home.setViewportSize({ width: 1280, height: 800 });
  await home.emulateMedia({ colorScheme: 'light' });

  // The keyboard reaches it, with the focus ring.
  await link.focus();
  await expect(link).toBeFocused();

  // Opens a new tab at exactly the recorded address, with no opener and no referrer.
  const tabP = context.waitForEvent('page');
  await link.click();
  const tab = await tabP;
  await tab.waitForLoadState();
  expect(tab.url()).toBe(`${CANCEL_HERE}/`);
  expect(opened).toEqual([`${CANCEL_HERE}/`]);
  expect(await tab.evaluate(() => window.opener)).toBeNull();
  expect(await tab.evaluate(() => document.referrer)).toBe('');
  await tab.close();
  // Home is where it was.
  await expect(link).toBeVisible();
  expect(problems()).toEqual([]);
});

// ---- D902 (D898 option B): Home's own "Cancel this link", for a wallet on the shared Google client ----

/** Screens of D902 at phone (390) and desktop (1280) width, light (Chromium only, with HANA_CANCEL_SHOTS_DIR). */
const CANCEL_SHOTS = process.env.HANA_CANCEL_SHOTS_DIR;
async function cancelShot(page: Page, name: string, browserName: string): Promise<void> {
  for (const [label, size] of [['phone', PHONE], ['desktop', { width: 1280, height: 800 }]] as const) {
    await page.setViewportSize(size);
    await page.emulateMedia({ colorScheme: 'light' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${name} ${label}: no sideways scroll`).toBe(true);
    if (CANCEL_SHOTS && browserName === 'chromium') {
      await page.locator('#home-sign-ins').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${CANCEL_SHOTS}/${name}-${label}.png`, fullPage: true, animations: 'disabled' });
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 });
}

const CANCEL_ROUTE = `${API_URL}/v1/home/link/cancel`;
/** The POSTs Home made to its cancel route. */
function cancelPosts(page: Page): () => number {
  let n = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url() === CANCEL_ROUTE) n += 1;
  });
  return () => n;
}

test('D902: Cancel this link in Home: asks first, a fresh Google sign-in of the same account, one request, Link cancelled; the line and the row change without a reload; NEAR agrees', async ({ page, context, google, browserName }, info) => {
  test.setTimeout(180_000);
  const problems = await watchAuthPages(context);
  const { scopeId, name } = await waitingEmail(page, google, info, browserName, 'b');

  const home = await context.newPage();
  const posts = cancelPosts(home);
  await home.goto(`${AUTH_ORIGIN}/home`);
  await signIn(home);
  await openApp(home, scopeId, name);
  await home.locator('#home-sign-ins-show').click();
  await expect(signInRows(home)).toHaveCount(2);
  await expect(home.locator('#home-sign-ins-waiting-line')).toHaveText('1 more starts opening it soon. Check it below.');
  const waiting = home.locator('#home-sign-ins-list > li[data-role="waiting"]');
  const offer = waiting.getByRole('button', { name: 'Cancel this link for the email address', exact: true });
  await expect(offer).toHaveText('Cancel this link');
  await expect(offer).toHaveClass(/jp-btn-secondary jp-btn-sm/u);
  // Nothing sends the person to the app any more for this row.
  await expect(home.locator('#home-sign-ins-sign-out-first')).toHaveCount(0);
  await expect(home.locator('#home-sign-ins-read-only')).toContainText('Passport Home can cancel a link that is still waiting, but can’t remove a sign-in yet.');
  await home.setViewportSize(PHONE);
  expect((await offer.boundingBox())!.height, 'the button is 44 px tall on a phone').toBeGreaterThanOrEqual(43.5);
  await cancelShot(home, 'cancel-offer', browserName);

  // 1. It asks first.
  await offer.click();
  const panel = home.locator('.home-sign-in-cancel');
  await expect(panel).toHaveAttribute('data-stage', 'confirm');
  await expect(home.locator('#home-sign-in-cancel-title')).toHaveText('Cancel this link?');
  await expect(panel).toContainText('The email address will never open this wallet. You can’t undo this: it can only be added again, and then it waits again.');
  await cancelShot(home, 'cancel-confirm', browserName);
  // Go back changes nothing.
  await home.locator('#home-sign-in-cancel-back').click();
  await expect(panel).toHaveCount(0);
  await offer.click();

  // The request is held until the "Cancelling the link" screen is seen (then sent on, unchanged).
  let release: () => void = () => undefined;
  const held = new Promise<void>((r) => {
    release = r;
  });
  await home.route(CANCEL_ROUTE, async (route) => {
    if (route.request().method() === 'POST') await held;
    await route.continue();
  });

  // 2. Cancel the link: the child in the click, Google's chooser (shared client, max_age=0), the same account.
  const childP = home.waitForEvent('popup');
  await home.locator('#home-sign-in-cancel-go').click();
  const child = await childP;
  await child.waitForURL(/accounts\.google\.com/u);
  await expect(home.locator('#home-sign-in-cancel-title')).toHaveText('Sign in with Google to confirm it’s you');
  await cancelShot(home, 'cancel-signing-in', browserName);
  const login = google.requests.at(-1)!;
  expect(login.ok && [login.request.kind, login.request.maxAge]).toEqual(['login', '0']);
  await chooseAccount(child, 0);
  await expect(home.locator('#home-sign-in-cancel-title')).toHaveText('Cancelling the link');
  await expect(panel).toContainText('This takes a few seconds…');
  await cancelShot(home, 'cancel-working', browserName);
  release();

  // 3. Link cancelled; the line and the row at once.
  await expect(home.locator('#home-sign-in-cancel-title')).toHaveText('Link cancelled', { timeout: 30_000 });
  await expect(home.locator('#home-sign-in-cancel-what')).toHaveText('The email address won’t open this wallet.');
  await expect(panel).toContainText('Devices signed in to this wallet will be asked to sign in again.');
  await expect(home.locator('#home-sign-ins-summary')).toHaveText('1 sign-in opens this wallet.');
  await expect(home.locator('#home-sign-ins-waiting-line')).toHaveCount(0);
  await expect(home.locator('#home-sign-ins-list > li[data-role="cancelled"]')).toHaveCount(1);
  await cancelShot(home, 'cancel-done', browserName);
  await home.locator('#home-sign-in-cancel-close').click();
  await expect(signInRows(home)).toHaveCount(1);
  expect(posts()).toBe(1);
  // NEAR agrees: read again, one sign-in.
  await home.locator('#home-sign-ins-again').click();
  await expect(signInRows(home)).toHaveCount(1);
  await expect(signInRows(home).first()).toHaveAttribute('data-role', 'first');
  expect(posts()).toBe(1);
  expect(await home.evaluate(() => location.href)).toBe(`${AUTH_ORIGIN}/home`);
  expect(problems()).toEqual([]);
});

test('D902: another Google account at the check is never sent: Nothing changed, the link still waits, the row as it was', async ({ page, context, google, browserName }, info) => {
  test.setTimeout(180_000);
  const problems = await watchAuthPages(context);
  const { scopeId, name } = await waitingEmail(page, google, info, browserName, 'm');
  google.accounts = [...google.accounts, { sub: newSub(), label: 'OTHER', email: outside(info, 'other'), emailVerified: true }];

  const home = await context.newPage();
  const posts = cancelPosts(home);
  await home.goto(`${AUTH_ORIGIN}/home`);
  await signIn(home);
  await openApp(home, scopeId, name);
  await home.locator('#home-sign-ins-show').click();
  const waiting = home.locator('#home-sign-ins-list > li[data-role="waiting"]');
  await waiting.getByRole('button', { name: 'Cancel this link for the email address', exact: true }).click();
  const childP = home.waitForEvent('popup');
  await home.locator('#home-sign-in-cancel-go').click();
  await chooseAccount(await childP, 1);
  await expect(home.locator('#home-sign-in-cancel-title')).toHaveText('Nothing changed', { timeout: 30_000 });
  const panel = home.locator('.home-sign-in-cancel');
  await expect(panel).toContainText('The link is still waiting.');
  await expect(panel).toContainText('If you picked a different Google account, try again with the one you signed in with here.');
  await expect(panel).toContainText('Error code (for support): home_account_mismatch');
  await cancelShot(home, 'cancel-nothing-changed', browserName);
  expect(posts()).toBe(0);
  await home.locator('#home-sign-in-cancel-close').click();
  await expect(waiting).toHaveAttribute('data-role', 'waiting');
  await expect(home.locator('#home-sign-ins-waiting-line')).toBeVisible();
  // NEAR agrees: still two, one waiting.
  await home.locator('#home-sign-ins-again').click();
  await expect(home.locator('#home-sign-ins-list > li[data-role="waiting"]')).toHaveCount(1);
  expect(problems()).toEqual([]);
});

test('D902: an answer nobody can read: It may not have been cancelled, and Show again reads NEAR, where the link still waits', async ({ page, context, google, browserName }, info) => {
  test.setTimeout(180_000);
  const problems = await watchAuthPages(context);
  const { scopeId, name } = await waitingEmail(page, google, info, browserName, 'u');

  const home = await context.newPage();
  await home.goto(`${AUTH_ORIGIN}/home`);
  await signIn(home);
  await openApp(home, scopeId, name);
  await home.locator('#home-sign-ins-show').click();
  // The API's answer is lost on the way (a gateway timeout instead of its JSON): nobody can say what happened.
  await home.route(CANCEL_ROUTE, async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: HOME_CORS });
    return route.fulfill({ status: 504, headers: { ...HOME_CORS, 'content-type': 'application/json' }, body: JSON.stringify({ error: 'Timed out', code: 'timeout' }) });
  });
  await home.locator('#home-sign-ins-list > li[data-role="waiting"]').getByRole('button', { name: 'Cancel this link for the email address', exact: true }).click();
  const childP = home.waitForEvent('popup');
  await home.locator('#home-sign-in-cancel-go').click();
  await chooseAccount(await childP, 0);
  await expect(home.locator('#home-sign-in-cancel-title')).toHaveText('It may not have been cancelled', { timeout: 30_000 });
  await expect(home.locator('.home-sign-in-cancel')).toContainText('Something went wrong, so we can’t tell whether the link was cancelled. Choose “Show again” to check.');
  await expect(home.locator('.home-sign-in-cancel')).toContainText('Error code (for support): timeout');
  // The row is not dropped on a guess.
  await expect(home.locator('#home-sign-ins-waiting-line')).toBeVisible();
  await cancelShot(home, 'cancel-unknown', browserName);
  await home.locator('#home-sign-in-cancel-again').click();
  await expect(home.locator('#home-sign-ins-list > li[data-role="waiting"]')).toHaveCount(1);
  await expect(home.locator('.home-sign-in-cancel')).toHaveCount(0);
  // The one line the routed 504 itself makes the browser print (the resource load), and nothing else.
  expect(problems().filter((p) => !p.endsWith('Failed to load resource: the server responded with a status of 504 (Gateway Timeout)'))).toEqual([]);
});
