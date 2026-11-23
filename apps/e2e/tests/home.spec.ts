// Hana Home (`{authOrigin}/home`, docs/hana-home-spec.md): the real page and its sign-in child against the stack.
//
// - "lists the app…": the real Worker's `GET /v1/home/config` and `GET /v1/home/apps`, whose gate checks the token,
//   the nonce and the Home key's signature exactly as a deployed API does, after a partner login put the wallet in the
//   directory.
// - "every screen": the page's states over a routed `GET /v1/home/apps` (the sign-in is still the real one). With
//   HANA_SHOTS_DIR set (Chromium only) it saves each screen there at desktop and phone width, light and dark.
import { API_URL, AUTH_ORIGIN, EVIL_ORIGIN, ISSUER_URL, NEAR_RPC, NEAR_RPC_FALLBACK } from '../src/stack.ts';
import { chooseAccount, expect, login, newApp, openPartner, test, walletDirectory } from './fixtures.ts';
import { routeApps, shots, signIn } from './home-steps.ts';

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
  await expect(page.locator('.home-row[data-scope] > .badge')).toHaveText(['Safe if the app closes', 'Safe if the app closes', 'Needs the app', 'Can’t be opened here', 'Not checked yet', 'Safe if the app closes']);
  await shots(page, '03-app-list', browserName);

  // A wallet's page: the row is one button, opened by the keyboard here.
  await page.locator('.home-row[data-scope="s1"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Wallet details' })).toBeFocused();
  await expect(page).toHaveTitle('Wallet details – Passport Home');
  await expect(page.getByRole('heading', { name: 'Apps that use this wallet' })).toBeVisible();
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
