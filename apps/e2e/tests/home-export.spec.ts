// Hana Home's "Move this wallet to another wallet app" (packages/web home-export.ts, batch H8): the real page, its
// per-app sign-in child and the reveal, against the stack.
//
// - "a wallet made by a partner login…" and "a linked sign-in method…": the Worker's own `POST /v1/home/login` (the
//   Home identity gate, the token and nonce checks, the chain reads, D1's `home_usage`), with only the relayer key
//   object behind it stood in for (src/server/api.ts `relayHome`: the mocked chain and the test MPC). The key the page
//   shows is read off the page and must open the address the partner login got.
// - "every screen…" (two tests): each state of the section, over a routed `GET /v1/home/apps` (and, for the refusals,
//   a routed `POST /v1/home/login`). With HANA_SHOTS_DIR set (Chromium only) each is saved there as `h8-…`, at desktop
//   and phone width, light and dark.
//
// SECURITY: a key read off the page stays in the test's memory and is never printed. No screenshot shows a derived
// key: the box's text is replaced with an obviously fake one of the same length first (`fakeKey`).
import { addressOfExport, identityKeyHex, utf8 } from '@hana-id/core';
import type { BrowserContext, Page, Route, TestInfo } from '@playwright/test';
import type { GoogleStub } from '../src/google-stub.ts';
import { API_URL, AUTH_ORIGIN, GOOGLE_CLIENT_ID, ISSUER_URL, NEAR_RPC, NEAR_RPC_FALLBACK } from '../src/stack.ts';
import { type RequestLog, chainView, chooseAccount, clickAction, clickClosing, clickMayClose, clickUntilTaken, closeOf, expect, guardedClick, login, newApp, okValue, openPartner, runAction, test, waitPersisted, walletDirectory } from './fixtures.ts';
import { HOME_CORS, routeApps, shots, signIn } from './home-steps.ts';

const HOME_LOGIN = `${API_URL}/v1/home/login`;
const HIDDEN = '••••••••';
const STELLAR_SEED = /^S[A-Z2-7]{55}$/u;
const EVM_KEY = /^0x[0-9a-f]{64}$/u;
/** What a screenshot shows in a key's place: the same length, and plainly not a key. */
const FAKE_KEY = { stellar: `S${'FAKEKEY'.repeat(8)}`.slice(0, 56), evm: `0x${'FAKE'.repeat(16)}` } as const;
const G = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';
const EVM = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';

const rand = (): string => crypto.randomUUID().replace(/-/gu, '').slice(0, 10);
/** A fresh Google `sub` (21 digits, as Google's): each test's user is its own, whatever ran on the stack before. */
const newSub = (): string => `1${Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => String(b % 10)).join('')}`;
/** A scope of the test's own (`[a-z0-9]{1,64}`): the stack's default scope fills with other tests' apps. */
const newScope = (browserName: string): string => `h8${browserName}${rand()}`;

/** Two fresh Google accounts for the stub's chooser: the user (0) and somebody else (1). */
function freshAccounts(google: GoogleStub): { sub: string; other: string } {
  const [sub, other] = [newSub(), newSub()];
  google.accounts = [
    { sub, label: 'H8 user', email: `e2eh8${rand()}@gmail.com`, emailVerified: true },
    { sub: other, label: 'H8 somebody else', email: `e2eh8${rand()}@gmail.com`, emailVerified: true },
  ];
  return { sub, other };
}

/** The section's parts. */
const section = (home: Page) => ({
  root: home.locator('#home-export'),
  open: home.locator('#home-export-open'),
  start: home.locator('#home-export-start'),
  title: home.locator('#home-export-title'),
  secret: home.locator('#home-export .secret'),
  problem: home.locator('#home-export-problem'),
});

/** "Sign in again to continue": the child at `/login?mode=home`, then the Google stub's chooser. */
async function signInAgain(home: Page, account = 0): Promise<void> {
  const childP = home.waitForEvent('popup');
  await home.locator('#home-export-start').click();
  const child = await childP;
  expect(new URL(child.url()).pathname + new URL(child.url()).search).toBe('/login?mode=home');
  await chooseAccount(child, account);
}

/** The typed confirmation and Continue, behind the guard. */
async function confirm(home: Page): Promise<void> {
  await expect(home.locator('#home-export-continue')).toBeDisabled();
  await home.locator('#home-export-confirm').fill('EXPORT');
  await guardedClick(home, 'Continue');
}

/** Puts a fake key of the same length in the box (after the test read the real one), for a screenshot. */
async function fakeKey(home: Page, chain: 'stellar' | 'evm'): Promise<void> {
  await section(home).secret.evaluate((el, text) => {
    el.textContent = text;
  }, FAKE_KEY[chain]);
  await expect(section(home).secret).toHaveText(FAKE_KEY[chain]);
}

/** No private key of either form anywhere in the page: its text, its markup, its form fields. */
async function expectNoKey(home: Page, ...known: string[]): Promise<void> {
  const { text, html, fields } = await home.evaluate(() => ({
    text: document.body.innerText,
    html: document.documentElement.outerHTML,
    fields: Array.from(document.querySelectorAll('input, textarea'), (f) => (f as HTMLInputElement).value).join('\n'),
  }));
  for (const where of [text, html, fields]) {
    expect(where).not.toMatch(/\bS[A-Z2-7]{55}\b/u);
    expect(where).not.toMatch(/\b0x[0-9a-f]{64}\b/u);
    for (const k of known) expect(where.includes(k)).toBe(false);
  }
}

const homeLogins = (requests: RequestLog, since = 0): number => requests.count(HOME_LOGIN, since);

test('a wallet made by a partner login is opened in Hana Home and its Stellar key is the address’s own, from the real API', async ({ page, context, google, requests, browserName }) => {
  test.setTimeout(120_000);
  const { sub } = freshAccounts(google);
  const scopeId = newScope(browserName);
  const name = 'Move E2E App';
  const app = await newApp({ name, scopeId });
  await openPartner(page, app);
  const wallet = await login(page);
  await expect.poll(async () => (await walletDirectory(wallet.stellar)).length, { timeout: 15_000 }).toBe(1);

  // From the list: the section is last on the app's page, collapsed, and nothing has started.
  const home = await context.newPage();
  let popups = 0;
  home.on('popup', () => {
    popups += 1;
  });
  await home.goto(`${AUTH_ORIGIN}/home`);
  await signIn(home);
  await home.locator(`.home-card[data-scope="${scopeId}"]`).getByRole('button', { name: `View ${name}` }).click();
  const s = section(home);
  // Collapsed: the section's heading, its sentence and one button, as the devices section.
  await expect(s.title).toHaveText('Move this wallet to another wallet app');
  await expect(s.open).toHaveText('Show how to move it');
  expect(await home.locator('#home-app-extras').evaluate((el) => el.parentElement?.lastElementChild === el && el.lastElementChild?.id === 'home-export')).toBe(true);
  await expect(s.start).toHaveCount(0);

  // A link naming the app opens its page, and no more: still collapsed, no window opened, nothing sent.
  await home.goto(`${AUTH_ORIGIN}/home?appId=${app.appId}`);
  popups = 0;
  await signIn(home);
  await expect(home.locator('#home-address-stellar')).toHaveText(wallet.stellar);
  await expect(s.open).toBeVisible();
  await expect(s.root.locator('button')).toHaveCount(1);
  await home.waitForTimeout(1_000);
  // The one window was Hana Home's own sign-in.
  expect(popups).toBe(1);
  expect(homeLogins(requests)).toBe(0);
  // A link can come from anyone, so the wallet of the app it named isn't moved out in that page load, the user's own
  // included: the section says to come back without the link, and offers no sign-in.
  await s.open.click();
  await expect(home.locator('#home-export-off')).toContainText('open Hana Home yourself, without the link');
  await expect(s.start).toHaveCount(0);
  await shots(home, 'h8-06b-not-offered-own-app-from-link', browserName);
  expect(popups).toBe(1);
  expect(homeLogins(requests)).toBe(0);

  // Without the link: from the user's own list.
  await home.goto(`${AUTH_ORIGIN}/home`);
  popups = 0;
  await signIn(home);
  await home.locator(`.home-card[data-scope="${scopeId}"]`).getByRole('button', { name: `View ${name}` }).click();

  // Expanded: the warning, and still nothing sent until the click.
  await s.open.click();
  await expect(s.title).toHaveText('Move this wallet to another wallet app');
  await expect(s.root.locator('.warn')).toContainText('Anyone with this key controls your funds');
  expect(popups).toBe(1);
  expect(homeLogins(requests)).toBe(0);

  // The per-app sign-in: Google is asked for a fresh one, for the same account.
  const loginsBefore = google.requests.length;
  await signInAgain(home);
  expect(google.requests.length).toBe(loginsBefore + 1);
  expect(google.requests.at(-1)).toMatchObject({ ok: true, request: { kind: 'login', maxAge: '0', clientId: GOOGLE_CLIENT_ID } });
  await expect(s.title).toHaveText('Your wallet is open', { timeout: 20_000 });
  // The addresses are worked out in the page from the derived key: the wallet the partner login opened.
  await expect(home.locator('#home-export-address-stellar')).toHaveText(wallet.stellar);
  await expect(home.locator('#home-export-address-evm')).toHaveText(wallet.evm);
  await expect(home.locator('#home-export-mismatch')).toHaveCount(0);
  // One derive, relayed once, for this user.
  expect(homeLogins(requests)).toBe(1);
  expect((await chainView(sub)).relayed.filter((t) => t.method === 'create_session_and_derive')).toHaveLength(2);
  await expectNoKey(home);

  // Stellar: EXPORT, Continue and Show key each wait for the guard (1 s and a moving pointer).
  await home.locator('#home-export-stellar').click();
  await expect(s.title).toHaveText('Your Stellar key');
  await confirm(home);
  await expect(s.secret).toHaveText(HIDDEN);
  await expectNoKey(home);
  await expect(home.getByRole('button', { name: 'Show key', exact: true })).toBeDisabled();
  await guardedClick(home, 'Show key');
  await expect(s.secret).toHaveText(STELLAR_SEED);
  const seed = (await s.secret.textContent()) ?? '';
  expect(addressOfExport('stellar', seed)).toBe(wallet.stellar);

  // The window losing focus hides it.
  await home.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(s.secret).toHaveText(HIDDEN);
  await expect(home.getByRole('button', { name: 'Show key', exact: true })).toBeVisible();
  await expectNoKey(home, seed);

  // Shown again, then "Lock now": the box is gone and nothing of the key is left in the page.
  await home.evaluate(() => window.dispatchEvent(new Event('focus')));
  await guardedClick(home, 'Show key');
  await expect(s.secret).toHaveText(seed);
  await home.locator('#home-export-lock').click();
  await expect(s.title).toHaveText('Wallet locked');
  await expect(home.locator('#home-export-ended')).toHaveText('Your key was erased from this page.');
  await expect(s.secret).toHaveCount(0);
  await expectNoKey(home, seed);
  // Nothing was stored, and nothing more was sent.
  expect(await home.evaluate(() => ({ session: sessionStorage.length, local: localStorage.length }))).toEqual({ session: 0, local: 0 });
  expect(homeLogins(requests)).toBe(1);
});

// ---- a linked sign-in method ----

type Mail = { subject: string; text: string; kind: string };
const mails = async (to: string): Promise<Mail[]> => (await (await fetch(`${ISSUER_URL}/__e2e/outbox?to=${encodeURIComponent(to)}`)).json()) as Mail[];

/** An email login to `to` from the partner page (as tests/linking.spec.ts): the address, the mailed code, the wallet. */
async function emailLogin(page: Page, to: string): Promise<{ stellar: string; evm: string }> {
  const popupP = page.waitForEvent('popup');
  await clickAction(page, 'email', 'loginWith', { method: 'email' });
  const popup = await popupP;
  await popup.waitForURL(/\/login\/email#/u);
  const closed = closeOf(popup);
  await expect(popup.locator('#email-address')).toBeVisible();
  await popup.fill('#email-address', to);
  await clickUntilTaken(popup, '#email-send');
  await expect.poll(async () => (await mails(to)).filter((m) => m.kind === 'code').length, { timeout: 10_000 }).toBeGreaterThan(0);
  const code = /\b(\d{6})\b/u.exec((await mails(to)).filter((m) => m.kind === 'code').at(-1)?.text ?? '')?.[1] ?? '';
  await expect(popup.locator('#email-code')).toBeVisible();
  await popup.fill('#email-code', code);
  await clickMayClose(popup, '#email-verify');
  await closed;
  const w = await okValue<{ stellar: string; evm: string }>(page, 'email');
  await waitPersisted(page, w.evm);
  return w;
}

test('a linked sign-in method: Google, a member of an email wallet, opens that wallet in Hana Home, confirmed on both NEAR providers', async ({ page, context, google, requests }, info: TestInfo) => {
  test.setTimeout(120_000);
  // Case A, Google-hosted (tests/linking.spec.ts): the email wallet first, then Google with that Gmail joins it as a
  // member. Google's path is then the email root's, which Hana Home confirms on `rpc` and `rpcFallback`, each alone.
  const to = `e2eh8m${info.project.name}${rand()}@gmail.com`;
  const sub = newSub();
  google.accounts = [{ sub, label: 'H8 member', email: to, emailVerified: true }];
  const scopeId = newScope(info.project.name);
  const name = `Move Linked ${rand()}`;
  // `launched`: the stack's mocked /v1/login writes neither the app's first login nor a member's directory row (the
  // Worker's own does both), so here Hana Home knows the app but has no wallet on record for the Google sign-in. The
  // user finds the app by its name, and the derive itself finds the wallet.
  const app = await newApp({ name, scopeId, loginMethods: 'google,email', launched: true });
  await openPartner(page, app);
  const wallet = await emailLogin(page, to);
  await runAction(page, 'out', 'logout');
  await okValue(page, 'out');
  const popupP = page.waitForEvent('popup');
  await clickAction(page, 'google', 'login');
  const popup = await popupP;
  await popup.click('#continue-google');
  await popup.waitForURL(/accounts\.google\.com/u);
  await clickMayClose(popup, '#account-0');
  expect(await okValue(page, 'google')).toEqual(wallet);
  await clickClosing(popup, '#banner-done');
  await waitPersisted(page, wallet.evm);

  const home = await context.newPage();
  const identityReads: { rpc: string; provider: unknown }[] = [];
  home.on('response', (res) => {
    const rpc = [NEAR_RPC, NEAR_RPC_FALLBACK].find((o) => res.url() === o || res.url().startsWith(`${o}/`));
    if (!rpc || res.request().method() !== 'POST') return;
    const params = (res.request().postDataJSON() as { params?: { method_name?: string; args_base64?: string } } | null)?.params;
    if (params?.method_name !== 'get_identity') return;
    identityReads.push({ rpc, provider: (JSON.parse(Buffer.from(params.args_base64 ?? '', 'base64').toString('utf8')) as { provider?: unknown }).provider });
  });
  await home.goto(`${AUTH_ORIGIN}/home`);
  await signIn(home);
  await home.getByLabel('App name').fill(name);
  await home.getByLabel('App name').press('Enter');
  await home.locator(`#home-results .home-card[data-scope="${scopeId}"]`).getByRole('button', { name: `View ${name}` }).click();
  await expect(home.locator('#home-no-address')).toBeVisible();
  const s = section(home);
  await s.open.click();
  await expect(s.root).toContainText('Hana has no wallet on record for you in this app. If you had one, sign in again and Hana Home will look for it.');
  await signInAgain(home);
  expect(google.requests.at(-1)).toMatchObject({ ok: true, request: { kind: 'login', maxAge: '0' } });
  await expect(s.title).toHaveText('Your wallet is open', { timeout: 20_000 });
  // The wallet is the account root's (the email wallet), not one of Google's own; the app's page now shows it too.
  await expect(home.locator('#home-export-address-stellar')).toHaveText(wallet.stellar);
  await expect(home.locator('#home-export-address-evm')).toHaveText(wallet.evm);
  await expect(home.locator('#home-opened-note')).toBeVisible();
  await expect(home.locator('#home-address-stellar')).toHaveText(wallet.stellar);
  expect(homeLogins(requests)).toBe(1);
  // Both providers answered the member's `get_identity` and the root's (the root is an email identity).
  for (const rpc of [NEAR_RPC, NEAR_RPC_FALLBACK]) {
    const seen = identityReads.filter((r) => r.rpc === rpc).map((r) => r.provider);
    expect(seen, rpc).toContain('google');
    expect(seen, rpc).toContain('email');
  }

  await home.locator('#home-export-evm').click();
  await confirm(home);
  await guardedClick(home, 'Show key');
  await expect(s.secret).toHaveText(EVM_KEY);
  const key = (await s.secret.textContent()) ?? '';
  expect(addressOfExport('evm', key)).toBe(wallet.evm);
  await home.locator('#home-export-lock').click();
  await expect(s.secret).toHaveCount(0);
  await expectNoKey(home, key);

  // The derive recorded the member (the Worker's own directory write): Hana Home now lists the app as the user's own.
  await home.reload();
  await signIn(home);
  const card = home.locator(`.home-card[data-scope="${scopeId}"]`);
  await expect(card).toBeVisible();
  expect(await card.evaluate((el) => el.closest('ul')?.previousElementSibling?.textContent)).toBe('Your apps');
});

// ---- every screen ----

const listedApp = (appId: string, name: string, over: Record<string, unknown> = {}) => ({ appId, name, status: 'active', environment: 'live', origins: [`https://${name.toLowerCase().replace(/[^a-z]+/gu, '')}.example`], logoUrl: null, ...over });

/** Holds `POST /v1/home/login` at the browser until `release()`, then lets it through to the API. */
async function holdHomeLogin(context: BrowserContext): Promise<{ hold(): void; release(): void }> {
  let gate: Promise<void> | null = null;
  let open: () => void = () => undefined;
  await context.route(HOME_LOGIN, async (route) => {
    if (route.request().method() === 'POST' && gate) await gate;
    await route.continue();
  });
  return {
    hold() {
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
    },
    release() {
      gate = null;
      open();
    },
  };
}

test('every screen of an opened wallet: opening, open, a wrong address on record, the confirmation, the key hidden and shown, hidden after 60 s, locked, erased after 5 minutes', async ({ page, context, google, browserName }) => {
  test.setTimeout(300_000);
  freshAccounts(google);
  const scopeId = newScope(browserName);
  const app = await newApp({ name: 'Sodax', scopeId });
  await openPartner(page, app);
  const wallet = await login(page);
  await page.goto('about:blank');

  // The listing is routed (so its addresses can be wrong on purpose); the derive is the API's own.
  let onRecord: { stellar: string; evm: string } = wallet;
  await routeApps(context, () => ({
    status: 200,
    body: {
      scopes: [
        {
          scopeId,
          mine: true,
          coverage: 'shared',
          googleClientId: GOOGLE_CLIENT_ID,
          supportId: 'HANA-7K2M-Q9XD',
          addresses: [
            { chain: 'stellar', address: onRecord.stellar },
            { chain: 'evm', address: onRecord.evm },
          ],
          apps: [listedApp(app.appId, 'Sodax')],
        },
      ],
      nextCursor: null,
    },
  }));
  const derive = await holdHomeLogin(context);
  await context.clock.install();
  const home = await context.newPage();
  const s = section(home);
  const openApp = async (): Promise<void> => {
    await home.goto(`${AUTH_ORIGIN}/home`);
    await signIn(home);
    await home.getByRole('button', { name: 'View Sodax', exact: true }).click();
    await s.open.click();
  };

  // Opening: Google answered, the one derive is on its way.
  await openApp();
  derive.hold();
  await signInAgain(home);
  await expect(s.title).toHaveText('Opening your wallet');
  await shots(home, 'h8-10-opening', browserName);
  derive.release();
  await expect(s.title).toHaveText('Your wallet is open', { timeout: 20_000 });
  await expect(home.locator('#home-export-address-stellar')).toHaveText(wallet.stellar);
  await expect(home.locator('#home-export-mismatch')).toHaveCount(0);
  await shots(home, 'h8-11-wallet-open', browserName);

  // The confirmation: Continue waits for the word and for the guard.
  await home.locator('#home-export-stellar').click();
  await expect(s.title).toHaveText('Your Stellar key');
  await expect(home.locator('#home-export-continue')).toBeDisabled();
  await shots(home, 'h8-13-confirm-continue-disabled', browserName);
  await home.locator('#home-export-confirm').fill('EXPORT');
  await home.waitForTimeout(1_100);
  await home.mouse.move(5, 5);
  await home.mouse.move(40, 40, { steps: 3 });
  await expect(home.locator('#home-export-continue')).toBeEnabled();
  await shots(home, 'h8-14-confirm-continue-enabled', browserName);
  await guardedClick(home, 'Continue');

  // The reveal: dots, then the key (a fake one in its place for the picture).
  await expect(s.secret).toHaveText(HIDDEN);
  await shots(home, 'h8-15-key-hidden', browserName);
  await guardedClick(home, 'Show key');
  await expect(s.secret).toHaveText(STELLAR_SEED);
  expect(addressOfExport('stellar', (await s.secret.textContent()) ?? '')).toBe(wallet.stellar);
  await fakeKey(home, 'stellar');
  await shots(home, 'h8-16-key-shown-stellar', browserName);
  await expect(home.getByRole('button', { name: 'Hide key', exact: true })).toBeVisible();

  // Locked by the user.
  await home.locator('#home-export-lock').click();
  await expect(home.locator('#home-export-ended')).toHaveText('Your key was erased from this page.');
  await shots(home, 'h8-19-locked-by-user', browserName);

  // A recorded address that isn't the wallet's own: said above the wallet's addresses.
  onRecord = { stellar: G, evm: EVM };
  await openApp();
  await signInAgain(home);
  await expect(s.title).toHaveText('Your wallet is open', { timeout: 20_000 });
  await expect(home.locator('#home-export-mismatch')).toContainText('different from this wallet’s');
  await expect(home.locator('#home-export-address-evm')).toHaveText(wallet.evm);
  await shots(home, 'h8-12-wallet-open-address-mismatch', browserName);

  // The EVM key, then the two timers: a shown key hides after 60 seconds, and the wallet locks 5 minutes after the derive.
  await home.locator('#home-export-evm').click();
  await confirm(home);
  await guardedClick(home, 'Show key');
  await expect(s.secret).toHaveText(EVM_KEY);
  expect(addressOfExport('evm', (await s.secret.textContent()) ?? '')).toBe(wallet.evm);
  await fakeKey(home, 'evm');
  await shots(home, 'h8-17-key-shown-evm', browserName);
  await context.clock.fastForward(60_000);
  await expect(s.secret).toHaveText(HIDDEN);
  await expect(home.getByRole('button', { name: 'Show key', exact: true })).toBeVisible();
  await shots(home, 'h8-18-key-hidden-after-60s', browserName);
  await context.clock.fastForward(5 * 60_000);
  await expect(s.title).toHaveText('Wallet locked');
  await expect(home.locator('#home-export-ended')).toContainText('kept for 5 minutes only');
  await expect(s.secret).toHaveCount(0);
  await shots(home, 'h8-20-erased-after-5-minutes', browserName);
  await expectNoKey(home);
});

/** The API's refusals of a Home derive that the page words on its own (home-problems.ts). */
const REFUSALS: readonly { status: number; code: string; says: string }[] = [
  { status: 404, code: 'home_no_wallet', says: 'There is no wallet for this sign-in in that app.' },
  { status: 429, code: 'home_busy', says: 'Hana Home has reached its limit for today.' },
  { status: 429, code: 'rate_limited', says: 'This wallet was opened too many times.' },
  { status: 403, code: 'home_account_mismatch', says: 'Sign in as the same account you used in Hana Home.' },
  { status: 409, code: 'link_pending', says: 'A sign-in method is still being added to this wallet.' },
  { status: 403, code: 'shared_login_disabled', says: 'Hana can’t open this wallet from here.' },
  { status: 502, code: 'near_unavailable', says: 'Hana Home is not reachable right now.' },
  { status: 422, code: 'ckd_failed', says: 'The key service didn’t produce the key this time.' },
];

test('every screen before a wallet opens: collapsed, the warning, where it can’t be offered, signing in, each refusal, NEAR providers that disagree', async ({ page, context, google, requests, browserName }) => {
  test.setTimeout(300_000);
  const { sub } = freshAccounts(google);
  const scopeId = newScope(browserName);
  const scopes = {
    sodax: { scopeId, mine: true, coverage: 'shared', googleClientId: GOOGLE_CLIENT_ID, supportId: 'HANA-7K2M-Q9XD', addresses: [{ chain: 'stellar', address: G }, { chain: 'evm', address: EVM }], apps: [listedApp('app_sodax1', 'Sodax')] },
    exit: { scopeId: `${scopeId}x`, mine: true, coverage: 'exit', googleClientId: 'x', supportId: 'HANA-3F8T-W1NB', addresses: [{ chain: 'evm', address: EVM }], apps: [listedApp('app_lumen1', 'Lumen Pay', { status: 'deleted', origins: [] })] },
    none: { scopeId: `${scopeId}n`, mine: false, coverage: 'none', googleClientId: null, apps: [listedApp('app_atlas1', 'Atlas Markets', { status: 'deleted' })] },
    unknown: { scopeId: `${scopeId}u`, mine: false, coverage: 'unknown', googleClientId: null, apps: [listedApp('app_nova01', 'Nova Earn')] },
    link: { scopeId: `${scopeId}l`, mine: false, coverage: 'shared', googleClientId: GOOGLE_CLIENT_ID, apps: [listedApp('app_orbit1', 'Orbit Swap')] },
  };
  await routeApps(context, (url) => {
    const appId = url.searchParams.get('appId');
    if (appId === 'app_orbit1') return { status: 200, body: { scopes: [scopes.link], nextCursor: null } };
    if (appId === 'app_nova01') return { status: 200, body: { scopes: [scopes.unknown], nextCursor: null } };
    return { status: 200, body: { scopes: [scopes.sodax, scopes.exit, scopes.none, scopes.unknown], nextCursor: null } };
  });
  // The derive is answered here, one refusal at a time.
  let refusal: (typeof REFUSALS)[number] | null = null;
  await context.route(HOME_LOGIN, async (route: Route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: HOME_CORS });
    const r = refusal ?? { status: 500, code: 'unexpected' };
    return route.fulfill({ status: r.status, headers: { ...HOME_CORS, 'content-type': 'application/json', 'cache-control': 'no-store', 'x-request-id': 'req_shot' }, body: JSON.stringify({ error: 'x', code: r.code, requestId: 'req_shot' }) });
  });

  // Arrived by a partner's link to an app that isn't the user's.
  const home = page;
  const s = section(home);
  await home.goto(`${AUTH_ORIGIN}/home?appId=app_orbit1`);
  await signIn(home);
  await expect(home.locator('#home-linked')).toBeVisible();
  const view = async (name: string): Promise<void> => {
    await home.getByRole('button', { name: `View ${name}`, exact: true }).click();
    await expect(home.getByRole('heading', { name: 'App details' })).toBeVisible();
    await expect(s.open).toBeVisible();
  };
  const back = (): Promise<void> => home.getByRole('button', { name: 'Back to all apps' }).click();

  // Where the move can't be offered: one sentence, and no way to start it.
  const off: readonly [string, string, string][] = [
    // Coverage `exit` naming a client that isn't Hana Home's exit client in force (H10 offers the move through that one).
    ['Lumen Pay', 'h8-03-not-offered-exit-login', 'Hana can’t open this wallet from here.'],
    ['Atlas Markets', 'h8-04-not-offered-out-of-reach', 'Hana can’t open this wallet from here.'],
    ['Nova Earn', 'h8-05-not-offered-not-checked', 'Hana hasn’t checked this app yet.'],
    ['Orbit Swap', 'h8-06-not-offered-app-from-link', 'You came to this app through a link'],
  ];
  for (const [name, shot, says] of off) {
    await view(name);
    await s.open.click();
    await expect(home.locator('#home-export-off')).toContainText(says);
    await expect(s.start).toHaveCount(0);
    await shots(home, shot, browserName);
    await home.locator('#home-export-close').click();
    await expect(s.open).toBeVisible();
    await back();
  }

  // The user's own app: collapsed, last on the page; then the warning.
  await view('Sodax');
  await shots(home, 'h8-01-entry-collapsed', browserName);
  await s.open.click();
  await expect(s.start).toHaveText('Sign in again to continue');
  await shots(home, 'h8-02-intro-warning', browserName);

  // Signing in: the child is on Google's chooser. Cancel closes it and sends nothing.
  const childP = home.waitForEvent('popup');
  await s.start.click();
  const child = await childP;
  await child.waitForURL('https://accounts.google.com/**');
  await expect(s.title).toHaveText('Choose your Google account again');
  await shots(home, 'h8-07-signing-in', browserName);
  const closed = closeOf(child);
  await home.locator('#home-export-cancel').click();
  await closed;
  await expect(s.start).toBeVisible();

  // Each refusal of the derive: Hana's own sentence for the code, the code and the request id; never the API's words.
  for (const r of REFUSALS) {
    refusal = r;
    const before = homeLogins(requests);
    await signInAgain(home);
    await expect(s.problem).toContainText(`Code: ${r.code}`, { timeout: 30_000 });
    await expect(s.problem).toContainText(r.says);
    await expect(s.problem).toContainText('Request: req_shot');
    await expect(s.problem).not.toContainText('error');
    // Sent once: the page never repeats a derive.
    expect(homeLogins(requests)).toBe(before + 1);
    await shots(home, `h8-21-refused-${r.code.replace(/_/gu, '-')}`, browserName);
    await home.locator('#home-export-again').click();
    await expect(s.start).toBeVisible();
  }

  // Google signed in as somebody else: stopped in the page, before anything is sent.
  refusal = null;
  const sent = homeLogins(requests);
  await signInAgain(home, 1);
  await expect(s.problem).toContainText('Code: home_account_mismatch');
  await expect(s.problem).toContainText('Sign in as the same account you used in Hana Home.');
  await expect(s.problem).not.toContainText('Request:');
  await shots(home, 'h8-22-refused-other-google-account', browserName);
  await home.locator('#home-export-again').click();

  // A NEAR provider that says this sign-in opens somebody else's wallet. The other provider disagrees: nothing opens.
  // Then the other provider can't be reached: nothing opens either.
  let second: 'answers' | 'unreachable' = 'answers';
  const memberView = { key: identityKeyHex(scopeId, 'google', sub), status: 'member', opened: false, root: { provider: 'google', sub: newSub() }, effective_at_ms: 1, account_epoch: 1 };
  const isIdentityRead = (route: Route): boolean => {
    if (route.request().method() !== 'POST') return false;
    const params = (route.request().postDataJSON() as { params?: { method_name?: string; args_base64?: string } } | null)?.params;
    return params?.method_name === 'get_identity' && (JSON.parse(Buffer.from(params.args_base64 ?? '', 'base64').toString('utf8')) as { sub?: unknown }).sub === sub;
  };
  await home.route((url) => url.origin === new URL(NEAR_RPC).origin, async (route) => {
    if (!isIdentityRead(route)) return route.fallback();
    const id = (route.request().postDataJSON() as { id?: unknown }).id ?? null;
    const result = { result: Array.from(utf8(JSON.stringify(memberView))), logs: [], block_height: 1, block_hash: '11111111111111111111111111111111' };
    return route.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': AUTH_ORIGIN }, body: JSON.stringify({ jsonrpc: '2.0', id, result }) });
  });
  await home.route((url) => url.origin === new URL(NEAR_RPC_FALLBACK).origin, async (route) => (second === 'unreachable' && isIdentityRead(route) ? route.abort('connectionrefused') : route.fallback()));
  await signInAgain(home);
  await expect(s.problem).toContainText('Code: path_disputed');
  await expect(s.problem).toContainText('NEAR providers disagree about which wallet this sign-in opens');
  await shots(home, 'h8-23-refused-near-providers-disagree', browserName);
  await home.locator('#home-export-again').click();
  second = 'unreachable';
  await signInAgain(home);
  await expect(s.problem).toContainText('Code: path_unconfirmed');
  await shots(home, 'h8-24-refused-near-path-unconfirmed', browserName);
  // Neither sent a derive.
  expect(homeLogins(requests)).toBe(sent);
  await home.locator('#home-export-close').click();
  await expect(s.open).toBeVisible();
});
