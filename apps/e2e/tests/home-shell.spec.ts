// Passport Home's shell (D888), in Chromium, Firefox and WebKit: the top bar holds who is signed in, Sign out and the
// sign-in's notice as a row of its own, so the notice covers nothing; anything that moves the move flow's guarded
// buttons starts their guard over; the line a failed copy leaves keeps its space.
//
// - "the move flow's guarded Continue …" (a Google account at 1280 x 720, 390 x 844 and 320 x 568): the API's own derive,
//   the Home sign-in made 4 minutes long by a `GET /v1/home/config` whose server time is 11 minutes behind (its notice
//   at 2, its end at 4, the open wallet's lock after 5). On a desktop a focused Copy sits just under the stuck bar when
//   the notice comes: the page moves down by the bar's growth (no scroll anchoring there), so it stays below the bar
//   and uncovered. On a phone Continue keeps its place in the window (anchoring, or WebKit's scroll by the bar's
//   change). The heading, Back, Continue and a Copy button focused by Tab are each the element at their own centre with
//   the notice up and after the end; the end keeps the warning's height; Continue is off again after each change and
//   after signing in again, then can be armed.
// - "an email account …" (390 and 320 px): the end by the API's 401 (the address masked: the who line keeps its
//   height), a sign-in again by code in the bar (its controls reachable down to 320 x 300; a toast stays in the
//   window at 320 x 568 and 640 x 360), then the notice; the page's clock only moves forward.
// - "one header, no nav, a skip link": the landmarks, and the skip link moving focus without changing the address.
import type { BrowserContext, Page, TestInfo } from '@playwright/test';
import { API_URL, AUTH_ORIGIN, GOOGLE_CLIENT_ID, ISSUER_URL } from '../src/stack.ts';
import { chooseAccount, clickAction, clickClosing, clickUntilTaken, expect, login, newApp, okValue, openPartner, test, waitPersisted } from './fixtures.ts';
import { HOME_CORS, homeTab, routeApps, signIn } from './home-steps.ts';

const MIN = 60_000;
const rand = (): string => crypto.randomUUID().replace(/-/gu, '').slice(0, 10);
/** A fresh Google `sub` (21 digits, as Google's): the test's user is its own, whatever ran on the stack before. */
const newSub = (): string => `1${Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => String(b % 10)).join('')}`;
const listedApp = (appId: string, name: string) => ({ appId, name, status: 'active', environment: 'live', origins: [`https://${name.toLowerCase().replace(/[^a-z]+/gu, '')}.example`], logoUrl: null });

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
async function routeWallet(context: BrowserContext, scopeId: string, appId: string, wallet: { stellar: string; evm: string }, coverage = 'shared', state: { refuse?: boolean } = {}): Promise<void> {
  await routeApps(context, () => state.refuse ? { status: 401, body: { error: 'x', code: 'home_identity_expired', requestId: 'req_e2e' } } : ({
    status: 200,
    body: { scopes: [{ scopeId, mine: true, coverage, googleClientId: coverage === 'email' ? null : GOOGLE_CLIENT_ID, supportId: 'HANA-7K2M-Q9XD', addresses: [{ chain: 'stellar', address: wallet.stellar }, { chain: 'evm', address: wallet.evm }], apps: [listedApp(appId, 'Sodax')] }], nextCursor: null },
  }) as { status: number; body: unknown });
}

/** An element's box in the window. */
const box = (page: Page, selector: string) =>
  page.locator(selector).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height) };
  });

/** Whether the element at `selector`'s centre is that element (or inside it): nothing is drawn over it there; and whether it is in the window (to a pixel of sub-pixel layout). */
const uncovered = (page: Page, selector: string) =>
  page.locator(selector).evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { inView: r.top >= -1 && r.bottom <= window.innerHeight + 1, hit: hit === el || el.contains(hit), what: hit ? `${hit.tagName.toLowerCase()}#${hit.id}` : 'nothing' };
  });

/** Scrolls so `selector` sits in the window's middle. */
const centre = (page: Page, selector: string) => page.locator(selector).evaluate((el) => el.scrollIntoView({ block: 'center' }));

/**
 * Waits until the page is still: the bar's height and the scroll position read the same twice, 100 ms of real time
 * apart (the page's clock may be Playwright's; this wait is the test's own), so a resize the browser hasn't delivered
 * yet can't move the page under a measurement.
 */
async function settled(page: Page): Promise<void> {
  const read = (): Promise<string> => page.evaluate(() => `${Math.round(document.querySelector('header')?.getBoundingClientRect().height ?? 0)},${Math.round(scrollY)}`);
  let last = await read();
  for (let i = 0; i < 50; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    const now = await read();
    if (now === last) return;
    last = now;
  }
  throw new Error(`the page didn't settle: ${last}`);
}

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
  for (const sel of ['#home-app-title', '#home-back']) expect(await uncovered(home, sel), `${label}: ${sel}`).toMatchObject({ inView: true, hit: true });
  await centre(home, '#home-export-continue');
  expect(await uncovered(home, '#home-export-continue'), `${label}: Continue`).toMatchObject({ inView: true, hit: true });
  // With the page scrolled to its end, Tab moves focus onto the open tab, "Move wallet" (D895), far above: the browser
  // scrolls it into view, below the bar.
  await home.locator('#home-back').focus();
  await home.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  // WebKit's Tab moves only between fields unless the user asks for every control: Option+Tab is that.
  const tab = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
  for (let i = 0; i < 12 && (await home.evaluate(() => document.activeElement?.id)) !== 'home-tab-move'; i += 1) await home.keyboard.press(tab);
  expect(await home.evaluate(() => document.activeElement?.id), `${label}: focus`).toBe('home-tab-move');
  expect(await uncovered(home, '#home-tab-move'), `${label}: the focused tab`).toMatchObject({ inView: true, hit: true });
}

const SIZES = [
  { name: 'desktop', width: 1280, height: 720 },
  { name: 'phone', width: 390, height: 844 },
  { name: 'small phone', width: 320, height: 568 },
] as const;

for (const size of SIZES) {
  test(`the move flow’s guarded Continue at ${size.width} x ${size.height}: the notice covers nothing (on a desktop the page moves out from under it; on a phone nothing in view moves), starts the guard over, keeps its height at the end; a failed copy moves nothing; after signing in again Continue can be armed`, async ({ page, context, google, browserName }, info) => {
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
    await home.locator(`.home-row[data-scope="${scopeId}"]`).click();
    await homeTab(home, 'Move wallet');
    await home.locator('#home-export-open').click();
    const childP = home.waitForEvent('popup');
    await home.locator('#home-export-start').click();
    await chooseAccount(await childP);
    await expect(home.locator('#home-export-title')).toHaveText('Your wallet is open', { timeout: 30_000 });
    // NEAR's key: its confirmation is the longest (its three notes), so even on the Move wallet tab alone (D895) the page
    // scrolls far enough to put a control just under the bar.
    await home.locator('#home-export-near').click();
    await expect(home.locator('#home-export-title')).toHaveText('Your NEAR key');
    await home.locator('#home-export-confirm').fill('EXPORT');
    const go = '#home-export-continue';
    const desktop = size.name === 'desktop';
    // What is in view when the notice comes. On a desktop (a stuck bar): the open tab, "Move wallet" (D895: the move flow
    // is a tab of its own, so the addresses' Copy isn't on screen), focused, just under the bar, where a growing bar would
    // cover it if the page didn't move. On a phone: Continue, in the window's middle.
    const watched = desktop ? '#home-tab-move' : go;
    if (desktop) {
      await home.locator(watched).focus();
      await home.locator(watched).evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - (document.querySelector('header')!.getBoundingClientRect().bottom + 16)));
    } else await centre(home, go);
    await arm(home, go);
    await expect(home.locator('#home-ending')).toHaveCount(0);
    const bar0 = await box(home, 'header');
    const before = await box(home, watched);
    if (desktop) expect(before.top - (bar0.top + bar0.height)).toBeLessThanOrEqual(17);

    // The notice: a row of the bar.
    await context.clock.fastForward(2 * MIN + 5_000);
    await expect(home.locator('#home-ending')).toBeVisible();
    expect(await home.locator('#home-banner').evaluate((el) => el.closest('header') !== null && el.closest('#app') === null)).toBe(true);
    // The guard started over: Continue is off until a fresh wait and arming gesture.
    await expect(home.locator(go)).toBeDisabled();
    const withNotice = await box(home, watched);
    const bar1 = await box(home, 'header');
    expect(bar1.height).toBeGreaterThan(bar0.height);
    if (desktop) {
      // The page moved down by the bar's growth, in every browser (no anchoring under a stuck bar): the focused Copy is
      // still below the bar, and it is the element at its own centre.
      expect(Math.abs(withNotice.top - before.top - (bar1.height - bar0.height))).toBeLessThanOrEqual(1);
      expect(withNotice.top).toBeGreaterThanOrEqual(bar1.top + bar1.height);
      expect(await home.evaluate(() => document.activeElement?.id)).toBe('home-tab-move');
    } else {
      // A bar that scrolls with the page: what is in view stays put (Chromium and Firefox anchor scrolling; in WebKit
      // the page scrolls by the bar's change).
      expect(Math.abs(withNotice.top - before.top), 'Continue stays where it was in the window (to a pixel of rounding)').toBeLessThanOrEqual(1);
    }
    expect(await uncovered(home, watched)).toMatchObject({ inView: true, hit: true });
    await nothingCovered(home, `${size.name}, the notice up`, browserName);

    // (D895: a failed copy's line is on the Addresses tab, Continue on Move wallet: they are never on screen together.)

    // The end: the notice's words change, its height doesn't; again nothing is covered.
    await centre(home, go);
    await arm(home, go);
    const beforeEnd = await box(home, go);
    await context.clock.fastForward(2 * MIN);
    await expect(home.locator('#home-ended')).toBeVisible();
    const bar2 = await box(home, 'header');
    expect(bar2.height, 'the end keeps the warning’s height').toBe(bar1.height);
    expect(Math.abs((await box(home, go)).top - beforeEnd.top)).toBeLessThanOrEqual(1);
    await expect(home.locator(go)).toBeVisible();
    await expect(home.locator(go)).toBeDisabled();
    await nothingCovered(home, `${size.name}, ended`, browserName);

    // Signing in again: the notice goes, the bar shrinks; the guard starts over, and Continue can be armed again.
    await centre(home, go);
    await arm(home, go);
    const again = home.waitForEvent('popup');
    await home.locator('#home-sign-in-again').click();
    await chooseAccount(await again);
    await expect(home.locator('#home-ended')).toHaveCount(0);
    await expect(home.locator('#home-banner')).toBeEmpty();
    expect((await box(home, 'header')).height).toBe(bar0.height);
    await expect(home.locator(go)).toBeDisabled();
    await centre(home, go);
    await arm(home, go);

    const measured = { browserName, size: `${size.width}x${size.height}`, watched, bar: [bar0.height, bar1.height, bar2.height], top: [before.top, withNotice.top] };
    info.annotations.push({ type: 'measured', description: JSON.stringify(measured) });
    console.log(`[home-shell] ${JSON.stringify(measured)}`);
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
    // Scrolled to (again, once the window's new size has settled), it is in the window and nothing covers it.
    await expect
      .poll(async () => {
        await home.locator(selector).evaluate((el) => el.scrollIntoView({ block: 'nearest' }));
        return uncovered(home, selector);
      }, { message: `${label} at ${s.width} x ${s.height}`, timeout: 5_000 })
      .toMatchObject({ inView: true, hit: true });
  }
  await home.setViewportSize({ width: 390, height: 844 });
}

/** A toast that worked (the copy), with the email code screens in the bar: it is in the window, below what is left of the bar. */
async function toastInView(home: Page, s: { width: number; height: number }): Promise<Record<string, number>> {
  await home.setViewportSize(s);
  // D895: the addresses' Copy is on the Addresses tab.
  await homeTab(home, 'Addresses');
  await home.evaluate(() => {
    const ok = { writeText: () => Promise.resolve() };
    if (navigator.clipboard) Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: ok.writeText });
    else Object.defineProperty(navigator, 'clipboard', { configurable: true, value: ok });
  });
  await home.locator('#home-copy-evm').click();
  const toast = home.locator('.home-toasts .jp-toast').last();
  await expect(toast).toBeVisible();
  const r = await toast.evaluate((el) => {
    const t = el.getBoundingClientRect();
    const bar = document.querySelector('header')!.getBoundingClientRect();
    return { top: Math.round(t.top), bottom: Math.round(t.bottom), window: window.innerHeight, barHeight: Math.round(bar.height), barBottom: Math.round(bar.bottom) };
  });
  expect(r.top, `the toast at ${s.width} x ${s.height}`).toBeGreaterThanOrEqual(0);
  expect(r.bottom, `the toast at ${s.width} x ${s.height}`).toBeLessThanOrEqual(r.window);
  expect(r.top).toBeGreaterThanOrEqual(Math.max(0, r.barBottom));
  return r;
}

for (const size of [
  { width: 390, height: 844 },
  { width: 320, height: 568 },
] as const) {
  test(`an email account at ${size.width} px: the end (the address masked), a sign-in again by code in the bar, then the notice, cover nothing and move nothing in view; the code screens are usable down to 320 x 300; a toast stays in the window`, async ({ page, context, browserName }, info: TestInfo) => {
    test.setTimeout(240_000);
    const scopeId = `shellmail${browserName}${rand()}`;
    const app = await newApp({ name: 'Sodax', scopeId, loginMethods: 'google,email' });
    await openPartner(page, app);
    // A long address, so the who line wraps on a phone.
    const to = `e2e-shell-a-rather-long-mailbox-name-${info.project.name}-${rand()}@mail-e2e.example.com`;
    const wallet = await partnerEmailLogin(page, to);
    await page.goto('about:blank');
    const api: { refuse?: boolean } = {};
    await routeWallet(context, scopeId, app.appId, wallet, 'email', api);
    // The page's clock only ever moves forward here (no setSystemTime back): the guard's waits stay true.
    await context.clock.install();
    const home = await context.newPage();
    await home.setViewportSize(size);
    await home.goto(`${AUTH_ORIGIN}/home`);
    await home.getByRole('button', { name: 'Continue with email' }).click();
    await home.fill('#home-email-address', to);
    let sent = (await mails(to)).length;
    await home.locator('#home-email-send').click();
    await home.fill('#home-email-code', await codeFor(to, sent));
    await home.locator('#home-email-verify').click();
    await expect(home.locator('#home-who')).toHaveText(`Signed in as ${to}`);
    const who = () => box(home, '#home-who');
    const bar = () => box(home, 'header');
    const m: Record<string, unknown> = { whoSignedIn: (await who()).height, barSignedIn: (await bar()).height };
    expect(m.whoSignedIn as number, 'the long address wraps').toBeGreaterThan(20);

    // The end, by the API's 401 on a search (the front page's Search button in view): the address masked, the who line
    // keeps its height, what is in view stays put.
    api.refuse = true;
    await home.getByLabel('Find an app by name').fill('Sodax');
    const search = '#home-search-go';
    await centre(home, search);
    const searchTop = (await box(home, search)).top;
    await home.locator(search).click();
    await expect(home.locator('#home-ended')).toBeVisible();
    await settled(home);
    await expect(home.locator('#home-who')).toContainText('•••@mail-e2e.example.com');
    m.whoEnded = (await who()).height;
    m.barEnded = (await bar()).height;
    m.searchTop = [searchTop, (await box(home, search)).top];
    expect(m.whoEnded).toBe(m.whoSignedIn);
    expect(Math.abs((await box(home, search)).top - searchTop), 'Search stays where it was in the window').toBeLessThanOrEqual(1);
    expect(await uncovered(home, search)).toMatchObject({ inView: true, hit: true });
    api.refuse = false;
    await home.locator(`.home-row[data-scope="${scopeId}"]`).click();
    await homeTab(home, 'Move wallet');
    await home.evaluate(() => window.scrollTo(0, 0));
    for (const sel of ['#home-app-title', '#home-back']) expect(await uncovered(home, sel), sel).toMatchObject({ inView: true, hit: true });

    // Signing in again by code, in the bar: its screens are usable at every size; a toast stays in the window.
    await home.locator('#home-sign-in-again').click();
    await expect(home.locator('#home-email-send')).toBeVisible();
    // Its title is no heading: the view's h1 (D893: "Wallet details") is the first heading.
    expect(await home.evaluate(() => document.querySelector('h1, h2, h3, h4')?.id)).toBe('home-app-title');
    await reachable(home, '#home-email-send', 'Send code');
    sent = (await mails(to)).length;
    await home.locator('#home-email-send').click();
    await expect(home.locator('#home-email-code')).toBeVisible();
    await reachable(home, '#home-email-code', 'the code field');
    await reachable(home, '#home-email-verify', 'Verify');
    m.toast320 = await toastInView(home, { width: 320, height: 568 });
    m.toast640 = await toastInView(home, { width: 640, height: 360 });
    await home.setViewportSize(size);
    await home.fill('#home-email-code', await codeFor(to, sent));
    await home.locator('#home-email-verify').click();
    await expect(home.locator('#home-ended')).toHaveCount(0);
    await expect(home.locator('#home-who')).toHaveText(`Signed in as ${to}`);
    m.whoAgain = (await who()).height;
    m.barAgain = (await bar()).height;
    expect(m.whoAgain).toBe(m.whoSignedIn);
    expect(m.barAgain).toBe(m.barSignedIn);

    // The notice (the email sign-in's token lasts 10 minutes: it comes at 8), with a button of the Security tab in view
    // (D895: its three tools make the longest panel, so the page scrolls; the Move wallet tab alone is shorter than the
    // window here, and at the page's top the page moves by the bar's change, D888).
    const target = '#home-app-profile-show';
    await homeTab(home, 'Security');
    await settled(home);
    await centre(home, target);
    // In view before the notice comes: "stays where it was" below then means something.
    expect(await uncovered(home, target), 'the button is in view before the notice').toMatchObject({ inView: true, hit: true });
    const targetTop = (await box(home, target)).top;
    await context.clock.fastForward(8 * MIN + 5_000);
    await expect(home.locator('#home-ending')).toBeVisible();
    await settled(home);
    m.barWithNotice = (await bar()).height;
    m.targetTop = [targetTop, (await box(home, target)).top];
    expect(Math.abs((await box(home, target)).top - targetTop), 'the button stays where it was in the window').toBeLessThanOrEqual(1);
    expect(await uncovered(home, target)).toMatchObject({ inView: true, hit: true });
    info.annotations.push({ type: 'measured', description: JSON.stringify({ browserName, size, ...m }) });
    console.log(`[home-shell] ${browserName} email ${size.width}: ${JSON.stringify(m)}`);
  });
}

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
  // D893: named apart from "Sign out this device": its words stay "Sign out", its name and tooltip say what it ends.
  await expect(account.getByRole('button', { name: 'Sign out of Passport Home', exact: true })).toBeVisible();
  await expect(account.locator('#home-sign-out')).toHaveText('Sign out');
  await expect(account.locator('#home-sign-out')).toHaveAttribute('title', 'Sign out of Passport Home');
  expect(await account.evaluate((el) => el.closest('header') !== null && el.closest('#app') === null)).toBe(true);
  expect(page.url()).toBe(`${AUTH_ORIGIN}/home`);
});
