// Hana Home (`{authOrigin}/home`, docs/hana-home-spec.md): the real page and its sign-in child against the stack.
//
// - "lists the app…": the real Worker's `GET /v1/home/config` and `GET /v1/home/apps`, whose gate checks the token,
//   the nonce and the Home key's signature exactly as a deployed API does, after a partner login put the wallet in the
//   directory.
// - "every screen": the page's states over a routed `GET /v1/home/apps` (the sign-in is still the real one). With
//   HANA_SHOTS_DIR set (Chromium only) it saves each screen there at desktop and phone width, light and dark.
import { API_URL, AUTH_ORIGIN, EVIL_ORIGIN, ISSUER_URL, NEAR_RPC, NEAR_RPC_FALLBACK } from '../src/stack.ts';
import { chooseAccount, expect, login, newApp, openPartner, test, walletDirectory } from './fixtures.ts';
import { HOME_APPS, homeTab, routeApps, shots, signIn } from './home-steps.ts';

const G = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';
const EVM = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';


test('lists the app the user signed in to, with its addresses and Support ID, from the real API', async ({ page, context, google, browserName }) => {
  // Its own scope per browser: the stack's default scope fills with other tests' apps, and the projects share one stack.
  const scopeId = `home${browserName}`;
  const name = 'Home E2E App';
  const app = await newApp({ name, scopeId });
  await openPartner(page, app);
  const addresses = await login(page);
  await expect.poll(async () => (await walletDirectory(addresses.stellar)).length, { timeout: 15_000 }).toBe(1);
  const [user] = await walletDirectory(addresses.stellar);

  const home = await context.newPage();
  const response = await home.goto(`${AUTH_ORIGIN}/home`);
  const csp = response?.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("frame-ancestors 'none'");
  // The API, both NEAR providers (the per-app derive reads NEAR itself, a member's path on each alone), Google's keys and
  // the email issuer (its email sign-in, H10).
  expect(csp).toContain(`connect-src ${new URL(API_URL).origin} ${new URL(NEAR_RPC).origin} ${new URL(NEAR_RPC_FALLBACK).origin} https://www.googleapis.com ${new URL(ISSUER_URL).origin}`);
  // Whoever opened Hana Home keeps no handle on it; the sign-in child Home opens itself still reaches Home (below).
  expect(response?.headers()['cross-origin-opener-policy']).toBe('same-origin-allow-popups');
  await expect(home.getByRole('heading', { name: 'Passport Home' })).toBeVisible();

  const childP = home.waitForEvent('popup');
  await home.getByRole('button', { name: 'Continue with Google' }).click();
  const child = await childP;
  expect(new URL(child.url()).pathname + new URL(child.url()).search).toBe('/login?mode=home');
  await chooseAccount(child);
  // Home's own Google request: openid only, the account chooser, no forced re-sign-in.
  expect(google.requests.at(-1)).toMatchObject({ ok: true });

  await expect(home.getByText('Signed in with Google')).toBeVisible();
  const card = home.locator(`.home-row[data-scope="${scopeId}"]`);
  await expect(card).toContainText(name);
  await expect(card.locator('> .badge')).toHaveText('Safe if the app closes');
  // It is one of the user's own: listed under "Your wallets" (D893), before "Your account" and "Other apps".
  expect(await card.evaluate((el) => el.closest('section')?.id)).toBe('home-mine');
  await card.click();
  await expect(home.getByRole('heading', { level: 1, name: 'Wallet details' })).toBeFocused();
  await expect(home.locator('#home-address-stellar')).toHaveText(addresses.stellar);
  await expect(home.locator('#home-address-evm')).toHaveText(addresses.evm);
  await expect(home.locator('#home-support-id')).toHaveText(`HANA-${user!.supportCode.slice(0, 4)}-${user!.supportCode.slice(4)}`);

  // Memory only: nothing of the sign-in is in the page's storage or its address, and a reload signs out.
  expect(await home.evaluate(() => ({ session: sessionStorage.length, local: localStorage.length, url: location.href }))).toEqual({ session: 0, local: 0, url: `${AUTH_ORIGIN}/home` });
  await home.reload();
  await expect(home.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await expect(home.locator('.home-row')).toHaveCount(0);
});

test('the Home sign-in child stops when Hana Home didn’t open it', async ({ page }) => {
  // Opened by its address, with no Hana Home behind it, the child has nobody to ask and goes nowhere.
  await page.goto(`${AUTH_ORIGIN}/login?mode=home`);
  await expect(page.getByText('block the Journear Passport window')).toBeVisible();
  expect(new URL(page.url()).origin).toBe(AUTH_ORIGIN);
});

// ---- every screen, over a routed list ----

const app = (appId: string, name: string, over: Record<string, unknown> = {}) => ({ appId, name, status: 'active', environment: 'live', origins: [`https://${name.toLowerCase().replace(/[^a-z]+/gu, '')}.example`], logoUrl: null, ...over });
const LIST = {
  scopes: [
    {
      scopeId: 's1',
      mine: true,
      coverage: 'shared',
      googleClientId: 'x',
      supportId: 'HANA-7K2M-Q9XD',
      addresses: [
        { chain: 'stellar', address: G },
        { chain: 'evm', address: EVM },
      ],
      apps: [app('app_sodax1', 'Sodax'), app('app_sodax2', 'Sodax Earn', { status: 'suspended' })],
    },
    { scopeId: 's2', mine: true, coverage: 'exit', googleClientId: 'x', supportId: 'HANA-3F8T-W1NB', addresses: [{ chain: 'evm', address: EVM }], apps: [app('app_lumen1', 'Lumen Pay', { status: 'deleted', origins: [] })] },
    { scopeId: 's3', mine: false, coverage: 'partner_client', googleClientId: 'x', apps: [app('app_orbit1', 'Orbit Swap')] },
    { scopeId: 's4', mine: false, coverage: 'none', googleClientId: null, apps: [app('app_atlas1', 'Atlas Markets', { status: 'deleted' })] },
    { scopeId: 's5', mine: false, coverage: 'unknown', googleClientId: null, apps: [app('app_nova01', 'Nova Earn')] },
    { scopeId: 's6', mine: false, coverage: 'hana_client', googleClientId: 'x', apps: [app('app_long01', 'An app with a very long name that has to wrap onto another line without pushing its badge off the card', { environment: 'test' })] },
  ],
  nextCursor: 's6',
};

test('every screen: signed out, signing in, the list, an app, search, the sign-in’s end, an empty list, an error', async ({ page, context, browserName }) => {
  test.setTimeout(180_000);
  let mode: 'list' | 'empty' | 'error' = 'list';
  const requests: string[] = [];
  await routeApps(context, (url) => {
    requests.push(url.search);
    if (mode === 'error') return { status: 503, body: { error: 'D1 failed', code: 'home_directory_unavailable', requestId: 'req_e2e' } };
    if (mode === 'empty') return { status: 200, body: { scopes: [], nextCursor: null } };
    if (url.searchParams.has('q')) return { status: 200, body: { scopes: [LIST.scopes[2]], nextCursor: null } };
    if (url.searchParams.has('appId')) return { status: 200, body: { scopes: [{ ...LIST.scopes[4], coverage: 'shared', googleClientId: 'x' }], nextCursor: null } };
    if (url.searchParams.has('cursor')) return { status: 200, body: { scopes: [{ scopeId: 's7', mine: false, coverage: 'shared', googleClientId: 'x', apps: [app('app_kite01', 'Kite Wallet')] }], nextCursor: null } };
    return { status: 200, body: LIST };
  });
  await context.clock.install();

  await page.goto(`${AUTH_ORIGIN}/home`);
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await shots(page, '01-signed-out', browserName);

  // Signing in: the child is open on Google's chooser.
  const childP = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  const child = await childP;
  await expect(page.getByText('Finish signing in with Google in the other window.')).toBeVisible();
  await shots(page, '02-signing-in', browserName);
  await chooseAccount(child);

  // The list (D893): the user's wallets first, as rows, then "Your account", then the other apps, each with its badge.
  await expect(page.getByRole('heading', { level: 1, name: 'Your wallets' })).toBeVisible();
  await expect(page).toHaveTitle('Your wallets – Passport Home');
  await expect(page.locator('.home-row[data-scope]')).toHaveCount(6);
  await expect(page.locator('.home-row[data-scope] > .badge')).toHaveText(['Safe if the apps close', 'Safe if the app closes', 'Needs the app', 'Can’t be opened here', 'Not checked yet', 'Safe if the app closes']);
  await shots(page, '03-app-list', browserName);

  // A wallet's page: the row is one button, opened by the keyboard here.
  await page.locator('.home-row[data-scope="s1"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Wallet details' })).toBeFocused();
  await expect(page).toHaveTitle('Wallet details – Passport Home');
  await expect(page.getByRole('group', { name: 'Apps that use this wallet' })).toBeVisible();
  await expect(page.locator('#home-address-stellar')).toHaveText(G);
  await expect(page.getByRole('link', { name: 'View on StellarExpert (test network)' })).toHaveAttribute('href', `https://stellar.expert/explorer/testnet/account/${G}`);
  await shots(page, '04-app-page', browserName);
  await page.getByRole('button', { name: 'Your wallets' }).click();
  // Back on the list, focus is on the row the user opened.
  await expect(page.locator('.home-row[data-scope="s1"]')).toBeFocused();

  // An app Hana can't open (pressed with Space), and one it checks when the page opens (clicked).
  await page.locator('.home-row[data-scope="s4"]').focus();
  await page.keyboard.press('Space');
  // The app's name is a labelled value, never a heading.
  await expect(page.getByRole('heading', { level: 1, name: 'App details' })).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Atlas Markets' })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'App' })).toContainText('Atlas Markets');
  await expect(page.locator('#home-coverage')).toContainText('the sign-in it used is gone');
  await shots(page, '05-app-not-available', browserName);
  await page.getByRole('button', { name: 'Your wallets' }).click();
  await page.locator('.home-row[data-scope="s5"]').click();
  await expect(page.locator('#home-coverage .badge')).toHaveText('Safe if the app closes');
  expect(requests.at(-1)).toBe('?appId=app_nova01');
  await page.getByRole('button', { name: 'Your wallets' }).click();

  // Search (Enter works as the button does), and Show more.
  await page.getByLabel('Find an app by name').fill('Orbit');
  await page.getByLabel('Find an app by name').press('Enter');
  await expect(page.getByRole('heading', { name: 'Results for Orbit' })).toBeVisible();
  await expect(page.locator('#home-results .home-row')).toHaveCount(1);
  await shots(page, '06-search-results', browserName);
  await page.getByRole('button', { name: 'Clear' }).click();
  await page.getByRole('button', { name: 'Show more' }).click();
  await expect(page.locator('.home-row[data-scope]')).toHaveCount(7);

  // Two minutes before the end: the warning. The list is untouched and nothing is fetched.
  const sent = requests.length;
  await context.clock.fastForward(13 * 60_000 + 1000);
  await expect(page.locator('#home-ending')).toContainText('ends in about 2 minutes');
  await expect(page.locator('.home-row[data-scope]')).toHaveCount(7);
  await shots(page, '07-ending-soon', browserName);

  // The end: everything stays, and a click that needs the API sends nothing.
  await context.clock.fastForward(2 * 60_000);
  await expect(page.locator('#home-ended')).toContainText('has ended. Everything on screen stays.');
  await expect(page.locator('.home-row[data-scope]')).toHaveCount(7);
  await page.getByLabel('Find an app by name').fill('Kite');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await context.clock.fastForward(60_000);
  expect(requests.length).toBe(sent);
  await shots(page, '08-ended', browserName);

  // Signing in again as the same account: the screen stays as it was and nothing is fetched by the page itself.
  await signIn(page, 'Sign in again');
  await expect(page.locator('#home-ended')).toHaveCount(0);
  await expect(page.locator('.home-row[data-scope]')).toHaveCount(7);
  await expect(page.getByLabel('Find an app by name')).toHaveValue('Kite');
  expect(requests.length).toBe(sent);

  // A refusal while the list is on screen: the list stays, the problem is said once.
  mode = 'error';
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Passport Home is not reachable right now.');
  await expect(page.getByRole('alert')).toContainText('Error code (for support): home_directory_unavailable');
  await expect(page.getByRole('alert')).toContainText('Request ID (for support): req_e2e');
  await expect(page.locator('.home-row[data-scope]')).toHaveCount(7);
  await shots(page, '09-error-with-list', browserName);

  // Sign out, then an account with no app, then one whose list can't be read.
  await page.getByRole('button', { name: 'Sign out of Passport Home' }).click();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  mode = 'empty';
  await signIn(page);
  await expect(page.locator('#home-empty')).toBeVisible();
  await shots(page, '10-empty-list', browserName);

  await page.getByRole('button', { name: 'Sign out of Passport Home' }).click();
  mode = 'error';
  await signIn(page);
  // D893: the group says its list didn't load, with the refusal and Try again together.
  await expect(page.locator('#home-list-failed')).toContainText('Your wallets didn’t load');
  await expect(page.getByRole('alert')).toContainText('Passport Home is not reachable right now.');
  await expect(page.locator('#home-list-failed').getByRole('button', { name: 'Try again' })).toBeVisible();
  await shots(page, '11-error-no-list', browserName);
  const before = requests.length;
  await context.clock.fastForward(5 * 60_000);
  expect(requests.length).toBe(before);
  mode = 'list';
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('.home-row[data-scope]')).toHaveCount(6);
});

test('a link to an app that isn’t the user’s lands on their own list, with the app under Hana’s notice', async ({ page, context, browserName }) => {
  const requests: string[] = [];
  const long = 'Hana security notice: your wallet is locked, restore it at hana-restore.example before Friday';
  await routeApps(context, (url) => {
    requests.push(url.search);
    if (url.searchParams.has('appId')) return { status: 200, body: { scopes: [{ scopeId: 's9', mine: false, coverage: 'shared', googleClientId: 'x', apps: [app('app_phish1', long)] }], nextCursor: null } };
    return { status: 200, body: { scopes: LIST.scopes.slice(0, 2), nextCursor: null } };
  });
  // Opened by another site: with Home's opener policy that site keeps no handle on the window.
  await page.goto(`${AUTH_ORIGIN}/home?appId=app_phish1`);
  await signIn(page);
  await expect(page.locator('#home-linked')).toContainText('Journear has no wallet on record for this Google account in it.');
  expect(requests).toEqual(['', '?appId=app_phish1']);
  await expect(page.getByRole('heading')).toHaveText(['Your wallets', 'The app from your link', 'Your account', 'Other apps']);
  await expect(page.locator('#home-linked .home-row-name')).toHaveText('Hana security notice: your wallet is locked, restore it at h…');
  await expect(page.getByText('hana-restore.example')).toHaveCount(0);
  await shots(page, '13-linked-app-not-yours', browserName);
});

test('a page on another site that opens Hana Home keeps no handle on it, and Home’s own sign-in still works', async ({ page, context }) => {
  await page.goto(`${EVIL_ORIGIN}/`);
  const homeP = context.waitForEvent('page');
  await page.evaluate((url) => {
    (window as unknown as { opened: Window | null }).opened = window.open(url, 'home');
  }, `${AUTH_ORIGIN}/home`);
  const home = await homeP;
  await expect(home.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  // The opener's handle is cut: it reads as closed, so it can't navigate the window or watch it.
  await expect.poll(() => page.evaluate(() => (window as unknown as { opened: Window | null }).opened?.closed)).toBe(true);
  expect(await home.evaluate(() => window.opener)).toBeNull();
  await signIn(home);
  await expect(home.getByText('Signed in with Google')).toBeVisible();
});

test('a cancelled Google sign-in leaves Hana Home signed out, with a way to try again', async ({ page, browserName }) => {
  await page.goto(`${AUTH_ORIGIN}/home`);
  const childP = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  const child = await childP;
  await child.waitForURL('https://accounts.google.com/**');
  await child.close();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await shots(page, '12-signed-out-after-cancel', browserName);
});

// ---- D893: Back and Forward inside Home ----

test('Back and Forward move between Home’s views at one address; Back from the list leaves Home (D893)', async ({ page, context }) => {
  const requests: string[] = [];
  await routeApps(context, (url) => {
    requests.push(url.search);
    return { status: 200, body: LIST };
  });
  // A page before Home, so that Back from the list has somewhere to go.
  await page.goto(`${EVIL_ORIGIN}/`);
  await page.goto(`${AUTH_ORIGIN}/home`);
  await signIn(page);
  await expect(page.locator('.home-row[data-scope]')).toHaveCount(6);
  const url = page.url();
  const entries = await page.evaluate(() => history.length);
  expect(await page.evaluate(() => history.scrollRestoration)).toBe('manual');

  await page.locator('.home-row[data-scope="s1"]').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Wallet details' })).toBeFocused();
  // One entry, at the same address, holding only the page's opaque marker.
  expect(page.url()).toBe(url);
  expect(await page.evaluate(() => history.length)).toBe(entries + 1);
  const state = await page.evaluate(() => history.state as unknown);
  expect(state).toMatch(/^home:[A-Za-z0-9_-]{16}:1$/u);
  for (const word of ['s1', 'Sodax', G, EVM, 'HANA-']) expect(String(state)).not.toContain(word);

  const sent = requests.length;
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'Your wallets' })).toBeVisible();
  await expect(page.locator('.home-row[data-scope="s1"]')).toBeFocused();
  await expect(page).toHaveTitle('Your wallets – Passport Home');
  expect(page.url()).toBe(url);
  await page.goForward();
  await expect(page.getByRole('heading', { level: 1, name: 'Wallet details' })).toBeFocused();
  await expect(page.locator('#home-address-stellar')).toHaveText(G);
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'Your wallets' })).toBeVisible();

  // "Your wallets" (the way back) returns to the list's own entry: Forward still reaches the view.
  await page.locator('#home-open-devices').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Devices and auto-approve' })).toBeFocused();
  await expect(page).toHaveTitle('Devices and auto-approve – Passport Home');
  await page.getByRole('button', { name: 'Your wallets' }).click();
  await expect(page.locator('#home-open-devices')).toBeFocused();
  await expect.poll(() => page.evaluate(() => history.state as unknown)).toBeNull();
  await page.goForward();
  await expect(page.getByRole('heading', { level: 1, name: 'Devices and auto-approve' })).toBeFocused();
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'Your wallets' })).toBeVisible();
  // Back and Forward never read the list again.
  expect(requests.length).toBe(sent);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });

  // Back from the list leaves Home, as before.
  await page.goBack();
  await expect(page).toHaveURL(`${EVIL_ORIGIN}/`);
});

test('after the sign-in ends Back and Forward show what is on screen and read nothing; after Sign out they show nothing of the account (D893)', async ({ page, context }) => {
  const requests: string[] = [];
  await routeApps(context, (url) => {
    requests.push(url.search);
    return { status: 200, body: LIST };
  });
  await context.clock.install();
  await page.goto(`${AUTH_ORIGIN}/home`);
  await signIn(page);
  await page.locator('.home-row[data-scope="s1"]').click();
  await expect(page.locator('#home-address-stellar')).toHaveText(G);
  await context.clock.fastForward(15 * 60_000 + 1000);
  await expect(page.locator('#home-ended')).toBeVisible();
  const sent = requests.length;
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'Your wallets' })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('heading', { level: 1, name: 'Wallet details' })).toBeVisible();
  await expect(page.locator('#home-ended')).toBeVisible();
  expect(requests.length).toBe(sent);

  // Sign out: the page goes back to its first entry; Forward and Back then show the signed-out page only.
  await page.getByRole('button', { name: 'Sign out of Passport Home' }).click();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => history.state as unknown)).toBeNull();
  await page.goForward();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await expect(page.locator('.home-row')).toHaveCount(0);
  await expect(page.locator('#home-address-stellar')).toHaveCount(0);
  expect(await page.content()).not.toContain(G);
  await page.goBack();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  expect(await page.content()).not.toContain(G);
  expect(requests.length).toBe(sent);
});

// ---- PR 116's review (D893) ----

test('a link’s wallet never pulls the person out of a view opened while the list loaded (the list 3 s late)', async ({ page, context }) => {
  let late = true;
  await routeApps(context, () => ({ status: 200, body: { scopes: [LIST.scopes[0]], nextCursor: null } }));
  // Registered after routeApps, so it runs first: the first list is 3 s late.
  await context.route(`${HOME_APPS}**`, async (route) => {
    if (late && route.request().method() === 'GET') {
      late = false;
      await new Promise((r) => setTimeout(r, 3_000));
    }
    return route.fallback();
  });
  await page.goto(`${AUTH_ORIGIN}/home?appId=app_sodax1`);
  const listed = page.waitForResponse((r) => r.url().startsWith(HOME_APPS) && r.request().method() === 'GET');
  await signIn(page);
  await page.locator('#home-open-devices').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Devices and auto-approve' })).toBeFocused();
  // The list arrives: the page stays on Devices, with one entry over the list.
  await listed;
  await expect(page.locator('#home-loading')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: 'Devices and auto-approve' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Wallet details' })).toHaveCount(0);
  expect(await page.evaluate(() => history.state as unknown)).toMatch(/^home:[A-Za-z0-9_-]{16}:1$/u);
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'Your wallets' })).toBeVisible();
  await expect(page.locator('.home-row[data-scope="s1"]')).toBeVisible();
});

test('rows: a screen reader’s name and description; the placeholders stand still and the spinners pulse with reduced motion', async ({ page, context }) => {
  let hold: ((v: unknown) => void) | null = null;
  await routeApps(context, () => ({ status: 200, body: LIST }));
  await context.route(`${HOME_APPS}**`, async (route) => {
    if (hold === null && route.request().method() === 'GET') await new Promise((r) => (hold = r));
    return route.fallback();
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${AUTH_ORIGIN}/home`);
  await signIn(page);
  await expect(page.locator('#home-loading')).toBeVisible();
  expect(await page.locator('.home-skeleton-line').first().evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  // D905 as amended by D906: the brand's own rule as the page ships it. The loading spinners (a button's, a login
  // provider's, an icon field's) fade slowly instead of turning, for ever: opacity only, no transform. Nothing else
  // keeps moving: a radio's dot and the loading placeholder (`.jp-skel`, the other one that repeats) run once, at once.
  const motion = () =>
    page.evaluate(() => {
      const button = document.createElement('button');
      button.className = 'jp-btn';
      const spin = button.appendChild(document.createElement('span'));
      spin.className = 'spin';
      const provider = document.createElement('button');
      provider.className = 'jp-provider';
      const providerSpin = provider.appendChild(document.createElement('span'));
      providerSpin.className = 'spin';
      const field = document.createElement('div');
      field.className = 'jp-iconfield';
      const fieldSpin = field.appendChild(document.createElement('span'));
      fieldSpin.className = 'spin';
      const check = document.createElement('label');
      check.className = 'jp-check';
      const radio = check.appendChild(document.createElement('input'));
      radio.type = 'radio';
      radio.checked = true;
      const skel = document.createElement('div');
      skel.className = 'jp-skel';
      document.body.append(button, provider, field, check, skel);
      const of = (el: Element) => {
        const s = getComputedStyle(el);
        const keyframes = el.getAnimations().flatMap((a) => (a.effect as KeyframeEffect).getKeyframes());
        const props = [...new Set(keyframes.flatMap((k) => Object.keys(k).filter((p) => !['offset', 'computedOffset', 'easing', 'composite'].includes(p))))].sort();
        return { name: s.animationName, count: s.animationIterationCount, seconds: parseFloat(s.animationDuration), easing: s.animationTimingFunction, props };
      };
      const out = { spins: [of(spin), of(providerSpin), of(fieldSpin)], skel: of(skel), dot: parseFloat(getComputedStyle(radio, '::after').animationDuration) };
      button.remove();
      provider.remove();
      field.remove();
      check.remove();
      skel.remove();
      return out;
    });
  const reduced = await motion();
  for (const s of reduced.spins) expect(s).toEqual({ name: 'jp-spin-pulse', count: 'infinite', seconds: 2, easing: 'ease-in-out', props: ['opacity'] });
  expect(reduced.dot).toBeLessThan(0.001);
  expect([reduced.skel.name, reduced.skel.count]).toEqual(['jp-sk', '1']);
  expect(reduced.skel.seconds).toBeLessThan(0.001);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  expect(await page.locator('.home-skeleton-line').first().evaluate((el) => getComputedStyle(el).animationName)).not.toBe('none');
  for (const s of (await motion()).spins) expect(s).toMatchObject({ name: 'jp-spin', count: 'infinite', seconds: 0.7, props: ['transform'] });
  (hold as unknown as (v: unknown) => void)(null);
  const s1 = page.locator('.home-row[data-scope="s1"]');
  await expect(s1).toHaveAccessibleName('Sodax, Sodax Earn (Paused), Safe if the apps close');
  await expect(s1).toHaveAccessibleDescription('https://sodax.example and 1 more website');
  await expect(page.locator('.home-row[data-scope="s2"]')).toHaveAccessibleName('Lumen Pay (Closed), Safe if the app closes');
  await expect(page.locator('#home-open-devices')).toHaveAccessibleName('Devices and auto-approve');
  await expect(page.locator('#home-open-devices')).toHaveAccessibleDescription('Where you’re signed in to your apps, and what may sign without asking');
});

// ---- D895: a wallet's tabs, and the phone's "Sign in again" chip ----

test('a wallet’s tabs: roles and names, the keyboard, a history entry only for “Move wallet” (D901), and no sideways scroll on a phone (D895)', async ({ page, context }) => {
  const requests: string[] = [];
  await routeApps(context, (url) => {
    requests.push(url.search);
    return { status: 200, body: LIST };
  });
  await page.goto(`${AUTH_ORIGIN}/home`);
  await signIn(page);
  await page.locator('.home-row[data-scope="s1"]').click();
  const list = page.getByRole('tablist', { name: 'This wallet' });
  await expect(list.getByRole('tab')).toHaveText(['Addresses', 'Security', 'Move wallet']);
  await expect(page.getByRole('tab', { name: 'Addresses' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'Addresses' })).toBeVisible();
  await expect(page.getByRole('tabpanel', { name: 'Security' })).toBeHidden();
  const sent = requests.length;
  // The entries with the wallet's open (D901: the tabs add one only for "Move wallet").
  const entries = await page.evaluate(() => history.length);
  // The keyboard: Tab reaches the open tab; the arrows move between tabs without opening one; Enter opens it.
  await page.getByRole('tab', { name: 'Addresses' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Security' })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Addresses' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { name: 'Security' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'Security' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Ways to sign in' })).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Space');
  await expect(page.getByRole('tab', { name: 'Move wallet' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { level: 2, name: 'Move this wallet to another wallet app' })).toBeVisible();
  // D901: Security replaced what the wallet's entry shows; only "Move wallet" added one, at the same address. Back from
  // it: the tab the person came from; Back again: the list.
  expect(await page.evaluate(() => history.state as unknown)).toMatch(/^home:[A-Za-z0-9_-]{16}:2$/u);
  expect(await page.evaluate(() => history.length)).toBe(entries + 1);
  expect(page.url()).toBe(`${AUTH_ORIGIN}/home`);
  await page.goBack();
  await expect(page.getByRole('tab', { name: 'Security' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'Security' })).toBeFocused();
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'Your wallets' })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('tab', { name: 'Security' })).toHaveAttribute('aria-selected', 'true');
  // Addresses ↔ Security, many times: no entry; then "Move wallet" and another tab, many times: still one entry over
  // the wallet's (the other tab goes back to it).
  for (let i = 0; i < 6; i++) {
    await homeTab(page, 'Addresses');
    await homeTab(page, 'Security');
  }
  for (let i = 0; i < 4; i++) {
    await homeTab(page, 'Move wallet');
    await homeTab(page, i % 2 === 0 ? 'Addresses' : 'Security');
    await expect.poll(() => page.evaluate(() => history.state as unknown)).toMatch(/^home:[A-Za-z0-9_-]{16}:1$/u);
  }
  expect(await page.evaluate(() => history.length)).toBe(entries + 1);
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'Your wallets' })).toBeVisible();
  expect(page.url()).toBe(`${AUTH_ORIGIN}/home`);
  expect(requests.length).toBe(sent);
  // Phones: the three tabs fit, nothing scrolls sideways.
  await page.locator('.home-row[data-scope="s1"]').click();
  for (const width of [320, 360, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    for (const name of ['Addresses', 'Security', 'Move wallet'] as const) {
      await homeTab(page, name);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${width} ${name}`).toBe(true);
      const box = await page.getByRole('tab', { name }).boundingBox();
      expect(box && box.x >= 0 && box.x + box.width <= width, `${width} ${name}`).toBe(true);
    }
  }
  // PR 122's review: Back from further down the page brings the tab list into view, with focus on the tab (D901: Back
  // from "Move wallet", the one tab with an entry of its own; its intro opened makes the page long).
  await page.setViewportSize({ width: 390, height: 360 });
  await homeTab(page, 'Addresses');
  await homeTab(page, 'Move wallet');
  await page.locator('#home-export-open').click();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(page.getByRole('tab', { name: 'Move wallet' })).not.toBeInViewport();
  await page.goBack();
  await expect(page.getByRole('tab', { name: 'Addresses' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'Addresses' })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Addresses' })).toBeInViewport();
  // And the tab stop: arrows to "Move wallet" without opening it, Tab out, Shift+Tab back: the open tab has focus.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Move wallet' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('tab', { name: 'Move wallet' })).not.toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('tab', { name: 'Addresses' })).toBeFocused();
});

for (const width of [320, 360, 390, 430] as const) {
  test(`the phone’s “Sign in again” chip at ${width} px: shown once the ending notice is out of view and kept, the last control clear of it, never on Move wallet (D895)`, async ({ page, context }) => {
    await page.setViewportSize({ width, height: 740 });
    await routeApps(context, () => ({ status: 200, body: LIST }));
    await context.clock.install();
    await page.goto(`${AUTH_ORIGIN}/home`);
    await signIn(page);
    const chip = page.locator('#home-again-chip');
    await expect(chip).toBeHidden();
    await context.clock.fastForward(13 * 60_000 + 5_000);
    await expect(page.locator('#home-ending')).toBeAttached();
    /** Sweeps the page (top to end, 60 px steps): out of the notice's view, the chip is there at every step. */
    const sweep = async (label: string): Promise<void> => {
      const max = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
      const bannerBottom = async () => page.locator('#home-banner').evaluate((el) => el.getBoundingClientRect().bottom);
      let seen = 0;
      for (let y = 0; y <= max + 60; y += 60) {
        await page.evaluate((to) => window.scrollTo(0, to), Math.min(y, max));
        if ((await bannerBottom()) > 0) {
          await expect(chip, `${label} y=${y}: the notice in view`).toBeHidden();
          continue;
        }
        await expect(chip, `${label} y=${y}`).toBeVisible();
        seen += 1;
      }
      expect(seen, `${label}: the chip shows mid-page`).toBeGreaterThan(1);
      // At the page's end, the last control is clear of the chip, above it.
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await expect(chip).toBeVisible();
      const clear = await page.evaluate(() => {
        const c = (document.getElementById('home-again-chip') as HTMLElement).getBoundingClientRect();
        const all = [...document.querySelectorAll('#app button, #app a[href], #app input')].map((el) => el.getBoundingClientRect()).filter((b) => b.width > 0 && b.height > 0);
        const last = all.reduce((a, b) => (b.bottom > a.bottom ? b : a));
        return c.top - last.bottom;
      });
      // 16 px, to the sub-pixel (the chip's top isn't a whole pixel).
      expect(clear, `${label}: the last control is above the chip`).toBeGreaterThanOrEqual(15);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${label}: no sideways scroll`).toBe(true);
      const box = await chip.boundingBox();
      expect(box && box.x >= 0 && box.x + box.width <= width && box.y + box.height <= 740, `${label}: the chip is in the window`).toBe(true);
    };
    await sweep('the list');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator('.home-row[data-scope="s1"]').click();
    await sweep('Addresses');
    await homeTab(page, 'Security');
    await sweep('Security');
    await expect(chip).toHaveAccessibleName(/^Sign in again/u);
    await expect(chip).toHaveAccessibleDescription('Your sign-in to Passport Home ends soon.');
    // Move wallet: never, at any scroll position and on its screens.
    await homeTab(page, 'Move wallet');
    for (const step of ['closed', 'intro'] as const) {
      if (step === 'intro') await page.locator('#home-export-open').click();
      const max = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
      for (let y = 0; y <= max + 60; y += 60) {
        await page.evaluate((to) => window.scrollTo(0, to), Math.min(y, max));
        await expect(chip, `Move wallet (${step}) y=${y}`).toBeHidden();
      }
    }
    // Back to Security: it shows again; pressed, the notice comes into view with focus on its "Sign in again".
    await homeTab(page, 'Security');
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect(chip).toBeVisible();
    await chip.click();
    await expect(page.locator('#home-sign-in-again')).toBeFocused();
    await expect(page.locator('#home-banner')).toBeInViewport();
    await expect(chip).toBeHidden();
    await expect(page.getByRole('tab', { name: 'Security' })).toHaveAttribute('aria-selected', 'true');
    expect(await chip.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  });
}

test('the chip never shows on a desktop, and a 390 px phone at 200 % zoom (195 px wide) keeps the tabs and the chip in the window (D895)', async ({ page, context }) => {
  await routeApps(context, () => ({ status: 200, body: LIST }));
  await context.clock.install();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${AUTH_ORIGIN}/home`);
  await signIn(page);
  await page.locator('.home-row[data-scope="s1"]').click();
  await homeTab(page, 'Security');
  await context.clock.fastForward(13 * 60_000 + 5_000);
  await expect(page.locator('#home-ending')).toBeAttached();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(page.locator('#home-again-chip')).toBeHidden();
  // 200 % zoom of a 390 px phone: a 195 px wide layout.
  await page.setViewportSize({ width: 195, height: 422 });
  await page.evaluate(() => window.scrollTo(0, 0));
  // The tab list stays inside the window (the page's own bar is checked at this width by D897's test below).
  const list = await page.locator('.home-tabs').boundingBox();
  expect(list && list.x >= 0 && list.x + list.width <= 195, 'the tab list is within the window').toBe(true);
  for (const name of ['Addresses', 'Security', 'Move wallet'] as const) {
    const tab = page.getByRole('tab', { name });
    await tab.focus();
    const box = await tab.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 195 + 1, `${name} reachable within the window`).toBe(true);
  }
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const chip = page.locator('#home-again-chip');
  await expect(chip).toBeVisible();
  const c = await chip.boundingBox();
  expect(c && c.x >= 0 && c.x + c.width <= 195 && c.y + c.height <= 422, 'the chip is in the window').toBe(true);
});

// ---- D897: polish across Home (the list, a wallet's tabs, "Your account"'s views) ----

/** Every view of Home, opened from the front page: the name it is checked under, and how to get there. */
const VIEWS: readonly { name: string; open: (page: import('@playwright/test').Page) => Promise<void> }[] = [
  { name: 'front', open: async () => {} },
  { name: 'addresses', open: async (page) => page.locator('.home-row[data-scope="s1"]').click() },
  { name: 'security', open: async (page) => { await page.locator('.home-row[data-scope="s1"]').click(); await homeTab(page, 'Security'); await expect(page.locator('#home-app-devices-summary')).toHaveText(/./u); } },
  { name: 'move', open: async (page) => { await page.locator('.home-row[data-scope="s1"]').click(); await homeTab(page, 'Move wallet'); } },
  { name: 'devices', open: async (page) => { await page.locator('#home-open-devices').click(); await expect(page.locator('#home-devices [role="status"]')).toHaveCount(0); } },
  { name: 'name', open: async (page) => { await page.locator('#home-open-profile').click(); await expect(page.locator('#home-profile')).not.toContainText('Loading your name…'); } },
];

/** One sign-in with long dates (another year) and an auto-approve, so an open card is as wide as it gets. */
const LONG_DEVICE = () => {
  const n = Date.now();
  return {
    shareId: `01${'Qx7'.repeat(6)}AB`,
    appId: 'app_sodax1',
    partnerOrigin: 'https://sodax.example',
    label: 'Chrome on macOS',
    signedInAtMs: new Date(new Date(n).getFullYear() - 1, 0, 2, 23, 45).getTime(),
    lastUsedAtMs: new Date(new Date(n).getFullYear() - 1, 11, 22, 22, 45).getTime(),
    idleUntilMs: n + 40 * 86_400_000,
    expiresAtMs: n + 400 * 86_400_000,
    consent: { consentId: `11${'Qx7'.repeat(6)}AB`, label: 'Swaps up to 50 USDC a day on Base, to Sodax’s own contracts', grantedAtMs: n - 60_000, expiresAtMs: n + 380 * 86_400_000 },
  };
};

/** Devices answered as the API would for the routed wallets (the real API doesn't know `s1`): none, or one long card. */
async function routeNoDevices(context: import('@playwright/test').BrowserContext, withDevice = false): Promise<void> {
  await context.route(new RegExp(`^${API_URL.replace(/[.]/gu, '\\.')}/v1/home/devices`, 'u'), async (route) => {
    const req = route.request();
    const cors = { 'access-control-allow-origin': AUTH_ORIGIN, 'access-control-allow-headers': 'content-type, x-hana-home', 'access-control-allow-methods': 'GET, POST, OPTIONS', vary: 'Origin' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const scopeId = new URL(req.url()).searchParams.get('scopeId');
    const scopes = scopeId ? [{ scopeId, apps: [{ appId: 'app_sodax1', name: 'Sodax', status: 'active' }], devices: withDevice ? [LONG_DEVICE()] : [], consents: [], email: [], more: false, canStop: true }] : [];
    return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ scopes, nextCursor: null }) });
  });
}

/** Back to the front page from any view (one press of the way back). */
async function toFront(page: import('@playwright/test').Page): Promise<void> {
  const back = page.locator('#home-back');
  if (await back.isVisible()) await back.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Your wallets' })).toBeVisible();
}

test('D897: at 195 px (a 390 px phone at 200 % zoom) no view scrolls sideways, the top bar included', async ({ page, context }) => {
  await routeApps(context, () => ({ status: 200, body: LIST }));
  await routeNoDevices(context);
  await page.setViewportSize({ width: 195, height: 422 });
  await page.goto(`${AUTH_ORIGIN}/home`);
  await signIn(page);
  for (const view of VIEWS) {
    await view.open(page);
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      const wide = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, window: window.innerWidth, wider: [...document.querySelectorAll('.home-top > *, .home-top #home-sign-out')].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 0.5).map((el) => el.id || el.className) }));
      expect(wide.page, `${view.name}: no sideways scroll`).toBeLessThanOrEqual(wide.window);
      expect(wide.wider, `${view.name}: the top bar within the window`).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: 'light' });
    await toFront(page);
  }
  await expect(page.locator('#home-sign-out')).toBeVisible();
});

test('D897: at 195 px an open device card with long dates (another year) and an auto-approve stays in the window', async ({ page, context }) => {
  await routeApps(context, () => ({ status: 200, body: LIST }));
  await routeNoDevices(context, true);
  await page.setViewportSize({ width: 195, height: 422 });
  await page.goto(`${AUTH_ORIGIN}/home`);
  await signIn(page);
  await page.locator('.home-row[data-scope="s1"]').click();
  await homeTab(page, 'Security');
  await page.locator('#home-app-devices-show').click();
  await expect(page.locator('#home-app-devices .home-device')).toHaveCount(1);
  await expect(page.locator('#home-app-devices .home-device-facts')).toContainText(/on [A-Z][a-z]{2} \d{1,2}, \d{4} at/u);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const w = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, window: window.innerWidth }));
    expect(w.page, `${scheme}: no sideways scroll with the card open`).toBeLessThanOrEqual(w.window);
  }
});

for (const width of [320, 360, 390, 430] as const) {
  test(`D897: at ${width} px every control on every view is at least 44 px tall (links inside a sentence aside), an open confirmation included`, async ({ page, context }) => {
    await routeApps(context, () => ({ status: 200, body: LIST }));
    await routeNoDevices(context, true);
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${AUTH_ORIGIN}/home`);
    await signIn(page);
    const stops = { name: 'security, a stop’s confirmation open', open: async (p: import('@playwright/test').Page) => {
      await p.locator('.home-row[data-scope="s1"]').click();
      await homeTab(p, 'Security');
      await p.locator('#home-app-devices-show').click();
      await p.getByRole('button', { name: 'Sign out this device' }).click();
      await expect(p.locator('.home-confirm-more summary').first()).toBeVisible();
    } };
    for (const view of [...VIEWS, stops]) {
      await view.open(page);
      const small = await page.evaluate(() =>
        [...document.querySelectorAll('button, a[href], [role="tab"], input:not([type="hidden"]), summary, select')]
          .filter((el) => {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0 || el.closest('.sr-only, [hidden]') || getComputedStyle(el).visibility === 'hidden') return false;
            // A link inside a sentence is exempt (WCAG 2.5.8's inline exception), as is the skip link (off screen until focused).
            if (el.tagName === 'A' && getComputedStyle(el).display === 'inline') return false;
            return el.id !== 'home-skip' && !el.classList.contains('home-skip');
          })
          // A tap area around a compact control (Sign out keeps the bar small) counts as its height.
          .filter((el) => {
            const h = el.getBoundingClientRect().height;
            const pad = getComputedStyle(el, '::before');
            const area = pad.content !== 'none' && pad.position === 'absolute' ? h - parseFloat(pad.top) - parseFloat(pad.bottom) : h;
            return Math.max(h, area) < 43.5;
          })
          .map((el) => `${el.tagName.toLowerCase()}#${el.id}.${[...el.classList].join('.')} ${Math.round(el.getBoundingClientRect().height)}px "${(el.textContent ?? '').trim().slice(0, 30)}"`),
      );
      expect(small, `${view.name} at ${width} px`).toEqual([]);
      await toFront(page);
    }
  });
}

test('D897: the focus ring shows on every control the keyboard reaches, in both themes', async ({ page, context, browserName }) => {
  // WebKit, as Safari, reaches links and buttons with Option-Tab.
  const tab = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
  await routeApps(context, () => ({ status: 200, body: LIST }));
  await routeNoDevices(context);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${AUTH_ORIGIN}/home`);
  await signIn(page);
  for (const view of VIEWS) {
    await view.open(page);
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      // From the page's start: the skip link is the first stop.
      await page.evaluate(() => {
        (document.activeElement as HTMLElement | null)?.blur();
        window.scrollTo(0, 0);
        (document.querySelector('.home-skip') as HTMLElement).focus();
      });
      const seen = new Set<string>();
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press(tab);
        const ring = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el || el === document.body) return null;
          const cs = getComputedStyle(el);
          const bg = getComputedStyle(document.body).backgroundColor;
          return {
            what: `${el.tagName.toLowerCase()}#${el.id}.${[...el.classList].join('.')} "${(el.textContent ?? '').trim().slice(0, 24)}"`,
            visible: el.matches(':focus-visible'),
            ring: (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2 && cs.outlineColor !== bg && cs.outlineColor !== 'rgba(0, 0, 0, 0)') || /rgb/u.test(cs.boxShadow),
          };
        });
        if (!ring || seen.has(ring.what)) break;
        seen.add(ring.what);
        if (ring.visible) expect(ring.ring, `${view.name} ${scheme}: ${ring.what}`).toBe(true);
      }
      // Sign out and the way back at least (the name view may show only its sentence when the read is slow).
      expect(seen.size, `${view.name} ${scheme}: the keyboard reaches its controls`).toBeGreaterThanOrEqual(view.name === 'front' ? 4 : 2);
    }
    await page.emulateMedia({ colorScheme: 'light' });
    await toFront(page);
  }
});

test('D897: a wallet’s head at 1280 px: the apps start under their label; the answer’s “No.” is read, not shown', async ({ page, context }) => {
  await routeApps(context, () => ({ status: 200, body: LIST }));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${AUTH_ORIGIN}/home`);
  await signIn(page);
  await page.locator('.home-row[data-scope="s1"]').click();
  const label = await page.locator('#home-app-label').boundingBox();
  const first = await page.locator('.home-app-all > .home-app').first().boundingBox();
  expect(label && first && first.y >= label.y + label.height - 1, 'the first app under the label').toBe(true);
  const text = page.locator('#home-coverage .home-coverage-text');
  await expect(text).toHaveText('If these apps shut down, you can still sign in to this wallet through Journear.');
  // The question and its answer word are screen-reader-only, before the badge, clipped to nothing on screen.
  const sr = page.locator('#home-coverage > .sr-only');
  await expect(sr).toHaveText('Does this wallet need these apps? No.');
  expect(await sr.evaluate((el) => { const r = el.getBoundingClientRect(); return r.width <= 1 && r.height <= 1; })).toBe(true);
  await expect(page.locator('#home-coverage .jp-badge')).toHaveText('Safe if the apps close');
});

// ---- D922: a wallet used on more apps than one answer carries ----

test('a wallet used on more apps than the list carries: the row counts them, the page shows them all', async ({ page, context, browserName }) => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => app(`app_net${String(i + 1).padStart(3, '0')}`, `Network partner ${i + 1}`));
  const requests: string[] = [];
  await routeApps(context, (url) => {
    requests.push(url.search);
    // The list carries 10 of the wallet's 24 apps and the counts; the full answer ("Show all apps", `all=1`) every one.
    if (url.searchParams.get('scopeId') === 's1' && url.searchParams.get('all') === '1') return { status: 200, body: { scopes: [{ ...LIST.scopes[0], apps: many(24), appsTotal: 24, appsOpen: 24 }], nextCursor: null } };
    return { status: 200, body: { scopes: [{ ...LIST.scopes[0], apps: many(10), appsTotal: 24, appsOpen: 24 }, LIST.scopes[2]], nextCursor: null } };
  });
  await page.goto(`${AUTH_ORIGIN}/home`);
  await signIn(page);
  const row = page.locator('.home-row[data-scope="s1"]');
  await expect(row.locator('.home-row-name')).toHaveCount(10);
  await expect(row.locator('.home-row-more')).toHaveText('and 14 more apps');
  await shots(page, '20-more-apps-row', browserName);
  await row.click();
  await expect(page.locator('.home-app-all .home-app')).toHaveCount(10);
  await expect(page.locator('#home-more-apps')).toHaveText('This wallet is also used on 14 more apps.');
  await shots(page, '21-more-apps-page', browserName);
  await page.getByRole('button', { name: 'Show all apps' }).click();
  await expect(page.locator('.home-app-all .home-app')).toHaveCount(24);
  await expect(page.locator('#home-more-apps')).toHaveCount(0);
  await expect(page.locator('.home-app-all .home-app').nth(10)).toBeFocused();
  expect(requests.at(-1)).toBe('?scopeId=s1&all=1');
  await shots(page, '22-more-apps-all', browserName);
  // Back on the list, the row still names 10 and counts the rest.
  await page.locator('#home-back').click();
  await expect(row.locator('.home-row-name')).toHaveCount(10);
  await expect(row.locator('.home-row-more')).toHaveText('and 14 more apps');
});
