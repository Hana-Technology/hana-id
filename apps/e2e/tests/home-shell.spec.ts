// Passport Home's shell (D888), in Chromium, Firefox and WebKit: the top bar holds who is signed in, Sign out and the
// sign-in's notice as a row of its own, so the notice covers nothing; anything that changes the layout around the move
// flow starts its guard over; the line a failed copy leaves keeps its space.
//
// - "the move flow's guarded Continue …" (a Google account at 1280 x 720, 390 x 844 and 320 x 568): the API's own derive,
//   the Home sign-in made 4 minutes long by a `GET /v1/home/config` whose server time is 11 minutes behind (its notice
//   at 2, its end at 4, the open wallet's lock after 5). With the notice up: the heading, Back and Continue are each the
//   element at their own centre (nothing covers them), a button focused by Tab is too, Continue is off again (the guard
//   started over), and where the browser anchors scrolling (Chromium, Firefox) Continue stays where it was in the window.
// - "an email account at 390 px …": the same across the notice, the end (the address masked: the who line keeps its
//   height) and a sign-in again by code inside the bar; the code screens usable at 390 x 844, 320 x 568, 640 x 360 and
//   320 x 300 (an open keyboard's height).
// - "one header, no nav, a skip link": the landmarks, and the skip link moving focus without changing the address.
import type { BrowserContext, Page, TestInfo } from '@playwright/test';
import { API_URL, AUTH_ORIGIN, GOOGLE_CLIENT_ID, ISSUER_URL } from '../src/stack.ts';
import { chooseAccount, clickAction, clickClosing, clickUntilTaken, expect, login, newApp, okValue, openPartner, test, waitPersisted } from './fixtures.ts';
import { HOME_CORS, routeApps, signIn } from './home-steps.ts';

const MIN = 60_000;
const rand = (): string => crypto.randomUUID().replace(/-/gu, '').slice(0, 10);
/** A fresh Google `sub` (21 digits, as Google's): the test's user is its own, whatever ran on the stack before. */
const newSub = (): string => `1${Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => String(b % 10)).join('')}`;
const listedApp = (appId: string, name: string) => ({ appId, name, status: 'active', environment: 'live', origins: [`https://${name.toLowerCase().replace(/[^a-z]+/gu, '')}.example`], logoUrl: null });
/** Browsers that keep what is in view in place when something above it changes height (CSS scroll anchoring). */
const ANCHORS = new Set(['chromium', 'firefox']);

type Mail = { subject: string; text: string; kind: string };
const mails = async (to: string): Promise<Mail[]> => (await (await fetch(`${ISSUER_URL}/__e2e/outbox?to=${encodeURIComponent(to)}`)).json()) as Mail[];
async function codeFor(to: string, previous: number): Promise<string> {
  await expect.poll(async () => (await mails(to)).length, { timeout: 10_000 }).toBeGreaterThan(previous);
  const m = /\b(\d{6})\b/u.exec((await mails(to)).at(-1)!.text);
  if (!m) throw new Error('no code in the mail');
  return m[1] as string;
}

/**
 * `GET /v1/home/config` through the real API, its server time set `behindMs` in the past: the Home sign-in made after
 * it ends that much sooner (its 15 minutes count from the config's time).
 */
async function shortSignIn(context: BrowserContext, behindMs: number): Promise<void> {
  await context.route(`${API_URL}/v1/home/config`, async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: HOME_CORS });
    const res = await route.fetch();
    const body = (await res.json()) as { serverTimeMs: number };
    return route.fulfill({ response: res, body: JSON.stringify({ ...body, serverTimeMs: body.serverTimeMs - behindMs }) });
  });
}

/** The listing, routed (its Support ID and addresses fixed), for the wallet a partner login made. */
async function routeWallet(context: BrowserContext, scopeId: string, appId: string, wallet: { stellar: string; evm: string }, coverage = 'shared'): Promise<void> {
  await routeApps(context, () => ({
    status: 200,
    body: { scopes: [{ scopeId, mine: true, coverage, googleClientId: coverage === 'email' ? null : GOOGLE_CLIENT_ID, supportId: 'HANA-7K2M-Q9XD', addresses: [{ chain: 'stellar', address: wallet.stellar }, { chain: 'evm', address: wallet.evm }], apps: [listedApp(appId, 'Sodax')] }], nextCursor: null },
  }));
}

/** An element's box in the window. */
const box = (page: Page, selector: string) =>
  page.locator(selector).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height) };
  });

/** Whether the element at `selector`'s centre is that element (or inside it): nothing is drawn over it there. */
const uncovered = (page: Page, selector: string) =>
  page.locator(selector).evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { inView: r.top >= 0 && r.bottom <= window.innerHeight, hit: hit === el || el.contains(hit), what: hit ? `${hit.tagName.toLowerCase()}#${hit.id}` : 'nothing' };
  });

/** Scrolls so `selector` sits in the window's middle. */
const centre = (page: Page, selector: string) => page.locator(selector).evaluate((el) => el.scrollIntoView({ block: 'center' }));

/** The guard armed: a second's wait, then the mouse moves (as fixtures' guardedClick, without the click). */
async function arm(page: Page, selector: string): Promise<void> {
  await page.waitForTimeout(1_100);
  await page.mouse.move(5, 5);
  await page.mouse.move(40, 40, { steps: 3 });
  await expect(page.locator(selector)).toBeEnabled();
}

/** Nothing covers the heading, Back and (scrolled to it) Continue; a button that Tab brings into view isn't covered. */
async function nothingCovered(home: Page, label: string, browserName: string): Promise<void> {
  await home.evaluate(() => window.scrollTo(0, 0));
  for (const sel of ['#home-title', '#home-back']) expect(await uncovered(home, sel), `${label}: ${sel}`).toMatchObject({ inView: true, hit: true });
  await centre(home, '#home-export-continue');
  expect(await uncovered(home, '#home-export-continue'), `${label}: Continue`).toMatchObject({ inView: true, hit: true });
  // With the page scrolled to its end, Tab moves focus onto the first address's Copy, far above: the browser scrolls it
  // into view, below the bar.
  await home.locator('#home-back').focus();
  await home.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  // WebKit's Tab moves only between fields unless the user asks for every control: Option+Tab is that.
  const tab = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
  for (let i = 0; i < 12 && (await home.evaluate(() => document.activeElement?.id)) !== 'home-copy-stellar'; i += 1) await home.keyboard.press(tab);
  expect(await home.evaluate(() => document.activeElement?.id), `${label}: focus`).toBe('home-copy-stellar');
  expect(await uncovered(home, '#home-copy-stellar'), `${label}: the focused Copy`).toMatchObject({ inView: true, hit: true });
}

const SIZES = [
  { name: 'desktop', width: 1280, height: 720 },
  { name: 'phone', width: 390, height: 844 },
  { name: 'small phone', width: 320, height: 568 },
] as const;

for (const size of SIZES) {
  test(`the move flow’s guarded Continue at ${size.width} x ${size.height}: the notice covers nothing, starts the guard over and, where scrolling is anchored, moves nothing in view; a failed copy moves nothing`, async ({ page, context, google, browserName }, info) => {
    test.setTimeout(180_000);
    google.accounts = [{ sub: newSub(), label: 'Shell user', email: `e2eshell${rand()}@gmail.com`, emailVerified: true }];
    const scopeId = `shell${browserName}${rand()}`;
    const app = await newApp({ name: 'Sodax', scopeId });
    await openPartner(page, app);
    const wallet = await login(page);
    await page.goto('about:blank');
    await routeWallet(context, scopeId, app.appId, wallet);
    await shortSignIn(context, 11 * MIN);
    await context.clock.install();
    const home = await context.newPage();
    await home.setViewportSize({ width: size.width, height: size.height });
    await home.goto(`${AUTH_ORIGIN}/home`);
    await signIn(home);
    await home.getByRole('button', { name: 'View Sodax', exact: true }).click();
    await home.locator('#home-export-open').click();
    const childP = home.waitForEvent('popup');
    await home.locator('#home-export-start').click();
    await chooseAccount(await childP);
    await expect(home.locator('#home-export-title')).toHaveText('Your wallet is open', { timeout: 30_000 });
    await home.locator('#home-export-stellar').click();
    await expect(home.locator('#home-export-title')).toHaveText('Your Stellar key');
    await home.locator('#home-export-confirm').fill('EXPORT');
    const go = '#home-export-continue';
    await centre(home, go);
    await arm(home, go);
    await expect(home.locator('#home-ending')).toHaveCount(0);
    const bar0 = await box(home, 'header');
    const before = await box(home, go);

    // The notice: a row of the bar.
    await context.clock.fastForward(2 * MIN + 5_000);
    await expect(home.locator('#home-ending')).toBeVisible();
    expect(await home.locator('#home-banner').evaluate((el) => el.closest('header') !== null && el.closest('#app') === null)).toBe(true);
    // The guard started over: Continue is off until a fresh wait and arming gesture.
    await expect(home.locator(go)).toBeDisabled();
    const withNotice = await box(home, go);
    const bar1 = await box(home, 'header');
    expect(bar1.height).toBeGreaterThan(bar0.height);
    if (ANCHORS.has(browserName)) expect(Math.abs(withNotice.top - before.top), 'Continue stays where it was in the window (to a pixel of rounding)').toBeLessThanOrEqual(1);
    // Without anchoring (WebKit) Continue moved down with the page; wherever it is, nothing covers it.
    await centre(home, go);
    expect(await uncovered(home, go)).toMatchObject({ inView: true, hit: true });
    await nothingCovered(home, `${size.name}, the notice up`, browserName);

    // A copy that fails: its line keeps its space, so Continue's place in the page doesn't change.
    const docY = () => home.locator(go).evaluate((el) => Math.round(el.getBoundingClientRect().top + window.scrollY));
    const yBefore = await docY();
    await home.evaluate(() => {
      const clip = navigator.clipboard as Clipboard | undefined;
      if (clip) Object.defineProperty(clip, 'writeText', { configurable: true, value: () => Promise.reject(new Error('blocked by the test')) });
    });
    await home.locator('#home-copy-stellar').click();
    await expect(home.locator('#home-copied')).toContainText('copy it yourself');
    expect(await docY()).toBe(yBefore);

    // The end: the notice changes; again nothing is covered.
    await centre(home, go);
    await arm(home, go);
    await context.clock.fastForward(2 * MIN);
    await expect(home.locator('#home-ended')).toBeVisible();
    await expect(home.locator(go)).toBeVisible();
    await expect(home.locator(go)).toBeDisabled();
    await nothingCovered(home, `${size.name}, ended`, browserName);

    info.annotations.push({ type: 'measured', description: JSON.stringify({ browserName, size, barBefore: bar0.height, barWithNotice: bar1.height, continueTopBefore: before.top, continueTopWithNotice: withNotice.top }) });
    console.log(`[home-shell] ${browserName} ${size.width}x${size.height}: bar ${bar0.height} -> ${bar1.height} px; Continue top ${before.top} -> ${withNotice.top}`);
  });
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
  await popup.fill('#email-code', await codeFor(to, before));
  await clickClosing(popup, '#email-verify');
  const wallet = await okValue<{ stellar: string; evm: string }>(page, 'login');
  await waitPersisted(page, wallet.evm);
  return wallet;
}

/** At each size, the control is reachable: scrolled to, it is in the window and nothing covers it. */
async function reachable(home: Page, selector: string, label: string): Promise<void> {
  for (const s of [
    { width: 390, height: 844 },
    { width: 320, height: 568 },
    { width: 640, height: 360 },
    { width: 320, height: 300 },
  ]) {
    await home.setViewportSize(s);
    await home.locator(selector).evaluate((el) => el.scrollIntoView({ block: 'nearest' }));
    expect(await uncovered(home, selector), `${label} at ${s.width} x ${s.height}`).toMatchObject({ inView: true, hit: true });
  }
  await home.setViewportSize({ width: 390, height: 844 });
}

test('an email account at 390 px: the notice, the end (the address masked) and a sign-in again by code in the bar cover nothing and, where scrolling is anchored, move nothing in view; the code screens are usable down to 320 x 300', async ({ page, context, browserName }, info: TestInfo) => {
  test.setTimeout(240_000);
  const scopeId = `shellmail${browserName}${rand()}`;
  const app = await newApp({ name: 'Sodax', scopeId, loginMethods: 'google,email' });
  await openPartner(page, app);
  // A long address, so the who line wraps on a phone.
  const to = `e2e-shell-a-rather-long-mailbox-name-${info.project.name}-${rand()}@mail-e2e.example.com`;
  const wallet = await partnerEmailLogin(page, to);
  await page.goto('about:blank');
  await routeWallet(context, scopeId, app.appId, wallet, 'email');
  await context.clock.install();
  const home = await context.newPage();
  await home.setViewportSize({ width: 390, height: 844 });
  await home.goto(`${AUTH_ORIGIN}/home`);
  await home.getByRole('button', { name: 'Continue with email' }).click();
  await home.fill('#home-email-address', to);
  let sent = (await mails(to)).length;
  await home.locator('#home-email-send').click();
  await home.fill('#home-email-code', await codeFor(to, sent));
  await home.locator('#home-email-verify').click();
  await expect(home.locator('#home-who')).toHaveText(`Signed in as ${to}`);
  await home.getByRole('button', { name: 'View Sodax', exact: true }).click();
  // What the user is about to press, far down the page: the move flow's button (its guarded steps are the Google
  // tests'; an email sign-in's own 10 minutes outlast an open wallet's 5).
  const target = '#home-export-open';
  const who = () => box(home, '#home-who');
  const bar = () => box(home, 'header');
  await centre(home, target);
  const m: Record<string, unknown> = { whoSignedIn: (await who()).height, barSignedIn: (await bar()).height, targetTop: (await box(home, target)).top };

  // The notice: the email sign-in's token lasts 10 minutes, so it comes at 8.
  await context.clock.fastForward(8 * MIN + 5_000);
  await expect(home.locator('#home-ending')).toBeVisible();
  m.barWithNotice = (await bar()).height;
  m.targetTopWithNotice = (await box(home, target)).top;
  if (ANCHORS.has(browserName)) expect(Math.abs((m.targetTopWithNotice as number) - (m.targetTop as number))).toBeLessThanOrEqual(1);
  await centre(home, target);
  expect(await uncovered(home, target)).toMatchObject({ inView: true, hit: true });

  // The end: the address masked, the who line keeps its height.
  const topBeforeEnd = (await box(home, target)).top;
  await context.clock.fastForward(2 * MIN);
  await expect(home.locator('#home-ended')).toBeVisible();
  await expect(home.locator('#home-who')).toContainText('•••@mail-e2e.example.com');
  m.whoEnded = (await who()).height;
  m.barEnded = (await bar()).height;
  m.targetTopEnded = (await box(home, target)).top;
  expect(m.whoEnded).toBe(m.whoSignedIn);
  if (ANCHORS.has(browserName)) expect(Math.abs((m.targetTopEnded as number) - topBeforeEnd)).toBeLessThanOrEqual(1);
  expect(await uncovered(home, target)).toMatchObject({ inView: true, hit: true });
  await home.evaluate(() => window.scrollTo(0, 0));
  for (const sel of ['#home-title', '#home-back']) expect(await uncovered(home, sel), sel).toMatchObject({ inView: true, hit: true });

  // Signing in again by code, in the bar (the page's clock back to the issuer's, which the fast-forward ran ahead of):
  // its screens are usable at every size.
  await context.clock.setSystemTime(Date.now());
  await home.locator('#home-sign-in-again').click();
  await expect(home.locator('#home-email-send')).toBeVisible();
  // Its title is no heading: the page's h1 is the first heading.
  expect(await home.evaluate(() => document.querySelector('h1, h2, h3, h4')?.id)).toBe('home-title');
  await reachable(home, '#home-email-send', 'Send code');
  sent = (await mails(to)).length;
  await home.locator('#home-email-send').click();
  await expect(home.locator('#home-email-code')).toBeVisible();
  await reachable(home, '#home-email-code', 'the code field');
  await reachable(home, '#home-email-verify', 'Verify');
  await home.fill('#home-email-code', await codeFor(to, sent));
  await home.locator('#home-email-verify').click();
  await expect(home.locator('#home-ended')).toHaveCount(0);
  await expect(home.locator('#home-who')).toHaveText(`Signed in as ${to}`);
  m.whoAgain = (await who()).height;
  m.barAgain = (await bar()).height;
  expect(m.whoAgain).toBe(m.whoSignedIn);
  expect(m.barAgain).toBe(m.barSignedIn);
  await centre(home, target);
  expect(await uncovered(home, target)).toMatchObject({ inView: true, hit: true });
  info.annotations.push({ type: 'measured', description: JSON.stringify({ browserName, ...m }) });
  console.log(`[home-shell] ${browserName} email 390: ${JSON.stringify(m)}`);
});

test('one header, no nav, and a skip link that moves focus into the page without changing its address', async ({ page, context }) => {
  await routeApps(context, () => ({ status: 200, body: { scopes: [], nextCursor: null } }));
  await page.goto(`${AUTH_ORIGIN}/home`);
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();

  // The skip link: first in the page, shown when it has focus (WebKit's Tab skips links unless the user asks, so the
  // link is focused directly); Enter moves focus to the page's content and leaves the address as it was.
  const skip = page.getByRole('link', { name: 'Skip to content' });
  expect(await page.evaluate(() => document.body.firstElementChild?.textContent)).toBe('Skip to content');
  await skip.focus();
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press('Enter');
  await expect(page.locator('main#app')).toBeFocused();
  expect(page.url()).toBe(`${AUTH_ORIGIN}/home`);

  await signIn(page);
  await expect(page.locator('#home-empty')).toBeVisible();
  await expect(page.locator('header')).toHaveCount(1);
  await expect(page.getByRole('banner')).toHaveCount(1);
  await expect(page.getByRole('main')).toHaveCount(1);
  // Who is signed in and Sign out: in the header, outside the page's content; no nav (they are no navigation).
  await expect(page.getByRole('navigation')).toHaveCount(0);
  const account = page.locator('#home-account');
  await expect(account).toContainText('Signed in with Google');
  await expect(account.getByRole('button', { name: 'Sign out' })).toBeVisible();
  expect(await account.evaluate((el) => el.closest('header') !== null && el.closest('#app') === null)).toBe(true);
  expect(page.url()).toBe(`${AUTH_ORIGIN}/home`);
});
