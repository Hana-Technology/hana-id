// Hana Home's "Devices and auto-approve" (H9, docs/hana-home-spec.md F5 and "Tests → Playwright"):
//
// - "stopping auto-approve…": the real Worker end to end. A partner tab signs in through the real vault and grants an
//   auto-approve consent; Hana Home, in another tab, lists that device (its label from the vault, its consent's label)
//   through `GET /v1/home/devices`, stops the consent, and the partner tab's next covered request shows the approval
//   screen instead of signing by itself within about 10 seconds (the vault's status read, D465). Then "Sign out this
//   device" ends it: the partner's reload asks to sign in again.
// - "every screen": the section's states over routed answers (the sign-in is still the real one). With HANA_SHOTS_DIR
//   set (Chromium only) each screen is saved there at desktop and phone width, light and dark.
import type { BrowserContext, Page } from '@playwright/test';
import { API_URL, AUTH_ORIGIN, EVM_CHAIN_ID } from '../src/stack.ts';
import { approve, clickAction, closeOf, errorCode, expect, login, newApp, okValue, openPartner, status, test, waitPersisted, waitReady, walletDirectory } from './fixtures.ts';
import { HOME_CORS, routeApps, shots, signIn } from './home-steps.ts';

const DEPOSIT_CONTRACT = '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD';
const AUTO_POLICY = {
  v: 1,
  label: 'Deposits to Example vault',
  maxConsentMs: 3_600_000,
  limits: { perDayCount: 5 },
  evm: {
    chains: [
      {
        chainId: EVM_CHAIN_ID,
        maxValueWei: '100000',
        maxValueWeiPerDay: '1000000',
        maxFeeWei: '100000',
        contracts: [{ address: DEPOSIT_CONTRACT, name: 'Example vault', selectors: [{ selector: '0xb6b55f25', signature: 'deposit(uint256)' }] }],
      },
    ],
  },
};
/** deposit(5) to the listed contract, fully filled (no RPC). */
const depositTx = (nonce: number) => ({
  type: '0x2',
  chainId: `0x${EVM_CHAIN_ID.toString(16)}`,
  nonce: `0x${nonce.toString(16)}`,
  gas: '0x186a0',
  maxFeePerGas: '0x1',
  maxPriorityFeePerGas: '0x1',
  to: DEPOSIT_CONTRACT,
  value: '0x0',
  data: `0xb6b55f25${(5).toString(16).padStart(64, '0')}`,
});

/** One covered request from a click: auto-signed (the popup opens and closes by itself) or shown for approval. */
async function deposit(page: Page, name: string, nonce: number): Promise<Page> {
  const popupP = page.waitForEvent('popup');
  await clickAction(page, name, 'ethSignTx', depositTx(nonce));
  return popupP;
}

test('stopping auto-approve in Hana Home stops auto-signing in the open partner tab within about 10 s; signing the device out ends it', async ({ page, context, browserName }) => {
  test.setTimeout(240_000);
  const scopeId = `homedev${browserName}`;
  const app = await newApp({ name: 'Devices E2E', scopeId, settings: { autoApprovePolicy: AUTO_POLICY } });
  await openPartner(page, app);
  const addresses = await login(page);
  await waitPersisted(page, addresses.evm);
  await expect.poll(async () => (await walletDirectory(addresses.stellar)).length, { timeout: 15_000 }).toBe(1);

  // The partner tab: Allow, then a covered request signs by itself.
  const consentP = page.waitForEvent('popup');
  await clickAction(page, 'consent', 'requestAutoApprove');
  const consent = await consentP;
  await approve(consent, 'Allow');
  expect(await okValue(page, 'consent')).toMatchObject({ granted: true });
  await consent.close();
  await page.waitForTimeout(800); // the vault polls its window every 0.5 s
  await closeOf(await deposit(page, 'auto1', 0), 10_000);
  expect(await okValue(page, 'auto1')).toMatchObject({ valid: true });

  // Hana Home, in another tab of the same browser: the device, its label and its consent.
  const home = await context.newPage();
  await home.goto(`${AUTH_ORIGIN}/home`);
  await signIn(home);
  await expect(home.getByRole('heading', { name: 'Devices and auto-approve' })).toBeVisible();
  const devicesRead = home.waitForResponse((r) => r.url() === `${API_URL}/v1/home/devices` && r.request().method() === 'GET');
  await home.locator('#home-devices-show').click();
  expect((await devicesRead).status()).toBe(200);
  const group = home.locator(`#home-devices .home-devices-group[data-scope="${scopeId}"]`);
  const item = group.locator('.home-device');
  await expect(item).toHaveCount(1);
  await expect(group.locator('.home-devices-apps')).toContainText('Devices E2E');
  // The vault's own word for the browser: a family and a system, nothing finer.
  await expect(item.locator('.home-device-name strong')).toHaveText(/^(Chrome|Safari|Firefox|Edge) on (Windows|macOS|Linux)$/u);
  await expect(item.locator('.home-device-name .origin')).toHaveText(new URL(page.url()).origin);
  await expect(item.locator('.home-policy-label')).toHaveText('Deposits to Example vault');

  // Stop auto-approving: asked first, then one request.
  await item.getByRole('button', { name: 'Stop auto-approving' }).click();
  await expect(home.locator('.home-confirm')).toContainText('Automatic signing stops within about 10 seconds.');
  const stopped = home.waitForResponse((r) => r.url() === `${API_URL}/v1/home/consents/revoke` && r.request().method() === 'POST');
  await home.locator('.home-confirm').getByRole('button', { name: 'Stop auto-approving' }).click();
  expect((await stopped).status()).toBe(200);
  const stoppedAt = Date.now();
  await expect(group.locator('.home-devices-note')).toContainText('Auto-approve stopped.');
  await expect(item).toContainText('Auto-approve is off');

  // The partner tab's next covered request, once its last status read is 10 s old: the approval screen, not a signature.
  await page.bringToFront();
  await page.waitForTimeout(Math.max(0, stoppedAt + 10_500 - Date.now()));
  const shown = await deposit(page, 'after', 1);
  await expect(shown.getByRole('button', { name: 'Approve', exact: true })).toBeVisible({ timeout: 10_000 });
  expect(Date.now() - stoppedAt).toBeLessThan(25_000);
  await shown.getByRole('button', { name: 'Reject', exact: true }).click();
  expect(await errorCode(page, 'after')).toBe(4001);

  // Sign out this device: gone from Home, and the partner's next load asks to sign in again.
  await home.bringToFront();
  await item.getByRole('button', { name: 'Sign out this device' }).click();
  await expect(home.locator('.home-confirm')).toContainText('Whoever has that device can still approve and sign in a tab of the app that is already open there');
  const signedOut = home.waitForResponse((r) => r.url() === `${API_URL}/v1/home/shares/revoke` && r.request().method() === 'POST');
  await home.locator('.home-confirm').getByRole('button', { name: 'Sign out', exact: true }).click();
  expect((await signedOut).status()).toBe(200);
  await expect(group.locator('.home-devices-note')).toContainText('Signed out.');
  await expect(item).toHaveCount(0);
  const outAt = Date.now();
  // The open partner tab ends by itself at its next periodic read (an app with a policy reads every minute), no reload,
  // no request.
  await page.bringToFront();
  await expect.poll(() => status(page), { timeout: 75_000, intervals: [1000] }).toBe('logged_out');
  expect(Date.now() - outAt).toBeLessThan(75_000);
  // And a reload stays signed out.
  await page.reload();
  await waitReady(page);
  expect(await status(page)).toBe('logged_out');
});

// ---- every screen, over routed answers ----

const ID = (n: number): string => `${String(n).padStart(2, '0')}${'Qx7'.repeat(6)}AB`;
const HOUR = 3_600_000;

/** Answers `GET /v1/home/devices` and the three stops (and their preflights) as the API would to the auth origin. */
async function routeDevices(context: BrowserContext, answer: (method: string, url: URL, body: unknown) => { status: number; body: unknown }): Promise<void> {
  await context.route(new RegExp(`^${API_URL.replace(/[.]/gu, '\\.')}/v1/home/(devices|consents/revoke|shares/revoke|email-sharing/revoke)`, 'u'), async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: HOME_CORS });
    expect(req.headers()['x-hana-home']).toMatch(/^[A-Za-z0-9_-]{200,}$/u);
    const { status: code, body } = answer(req.method(), new URL(req.url()), req.postData() ? JSON.parse(req.postData() as string) : null);
    return route.fulfill({ status: code, headers: { ...HOME_CORS, 'content-type': 'application/json', 'cache-control': 'no-store', 'x-request-id': 'req_e2e' }, body: JSON.stringify(body) });
  });
}

const homeApp = (appId: string, name: string) => ({ appId, name, status: 'active', environment: 'live', origins: [`https://${name.toLowerCase().replace(/[^a-z]+/gu, '')}.example`], logoUrl: null });
const LIST = {
  scopes: [
    { scopeId: 's1', mine: true, coverage: 'shared', googleClientId: 'x', supportId: 'HANA-7K2M-Q9XD', addresses: [], apps: [homeApp('app_sodax1', 'Sodax'), homeApp('app_sodax2', 'Sodax Earn')] },
    { scopeId: 's2', mine: true, coverage: 'shared', googleClientId: 'x', supportId: 'HANA-3F8T-W1NB', addresses: [], apps: [homeApp('app_lumen1', 'Lumen Pay')] },
  ],
  nextCursor: null,
};

function devicesFixture(now: number) {
  const dev = (n: number, over: Record<string, unknown>) => ({
    shareId: ID(n),
    appId: 'app_sodax1',
    partnerOrigin: 'https://sodax.example',
    label: 'Chrome on macOS',
    signedInAtMs: now - 3 * HOUR,
    lastUsedAtMs: now - 20 * 60_000,
    idleUntilMs: now + 100 * 60_000,
    expiresAtMs: now + 9 * HOUR,
    consent: null,
    ...over,
  });
  return {
    s1: {
      scopeId: 's1',
      apps: [
        { appId: 'app_sodax1', name: 'Sodax', status: 'active' },
        { appId: 'app_sodax2', name: 'Sodax Earn', status: 'active' },
      ],
      devices: [
        dev(1, { consent: { consentId: ID(11), label: 'Swaps up to 50 USDC a day on Base, to Sodax’s own contracts', grantedAtMs: now - 2 * HOUR, expiresAtMs: now + HOUR } }),
        dev(2, { label: 'Safari on iOS', partnerOrigin: 'https://earn.sodax.example', appId: 'app_sodax2', lastUsedAtMs: null, signedInAtMs: now - 26 * 60_000, idleUntilMs: now + 94 * 60_000 }),
        dev(3, { label: null, signedInAtMs: now - 8 * HOUR, lastUsedAtMs: now - 7 * HOUR, idleUntilMs: now + 4 * HOUR, expiresAtMs: now + 4 * HOUR }),
      ],
      consents: [],
      email: [{ appId: 'app_sodax1', addresses: ['ada.lovelace@example.com'] }],
      more: false,
      canStop: true,
    },
    s2: {
      scopeId: 's2',
      apps: [{ appId: 'app_lumen1', name: 'Lumen Pay', status: 'active' }],
      devices: [],
      consents: [{ consentId: ID(21), appId: 'app_lumen1', partnerOrigin: 'https://lumenpay.example', label: 'Payments under 10 XLM', grantedAtMs: now - 10 * 60_000, expiresAtMs: now + 50 * 60_000 }],
      email: [],
      more: false,
      canStop: true,
    },
  };
}

test('every screen: devices with their auto-approve and email sharing, each confirmation, after stopping, empty, errors', async ({ page, context, browserName }) => {
  test.setTimeout(240_000);
  const now = Date.now();
  let data = devicesFixture(now);
  let mode: 'list' | 'empty' | 'error' | 'unconfirmed' = 'list';
  let stopAnswer: { status: number; body: unknown } | null = null;
  const stops: { path: string; body: unknown }[] = [];
  await routeApps(context, () => ({ status: 200, body: LIST }));
  await routeDevices(context, (method, url, body) => {
    if (method === 'POST') {
      stops.push({ path: url.pathname, body });
      if (stopAnswer) return stopAnswer;
      const b = body as Record<string, string>;
      if (b.shareId) data = { ...data, s1: { ...data.s1, devices: data.s1.devices.filter((x) => x.shareId !== b.shareId) } };
      if (url.pathname.endsWith('/email-sharing/revoke')) return { status: 200, body: { state: 'declined', revoked: 1 } };
      return { status: 200, body: { revoked: true } };
    }
    if (mode === 'error') return { status: 503, body: { error: 'D1 failed', code: 'home_directory_unavailable', requestId: 'req_e2e' } };
    // A linked account NEAR couldn't confirm (D661): its devices, no stop, no addresses.
    if (mode === 'unconfirmed') return { status: 200, body: { scopes: [{ ...data.s1, email: null, canStop: false }], nextCursor: null } };
    const scope = url.searchParams.get('scopeId');
    if (mode === 'empty') return { status: 200, body: { scopes: scope ? [{ scopeId: scope, apps: [], devices: [], consents: [], email: [], more: false, canStop: true }] : [], nextCursor: null } };
    if (scope === 's1') return { status: 200, body: { scopes: [data.s1], nextCursor: null } };
    if (scope === 's2') return { status: 200, body: { scopes: [data.s2], nextCursor: null } };
    return { status: 200, body: { scopes: [data.s1, data.s2], nextCursor: null } };
  });

  await context.clock.install();
  await page.goto(`${AUTH_ORIGIN}/home`);
  await signIn(page);
  const section = page.locator('#home-devices');
  await expect(section.getByRole('heading', { name: 'Devices and auto-approve' })).toBeVisible();
  await section.scrollIntoViewIfNeeded();
  await shots(page, 'h9-01-front-closed', browserName);

  // Several devices in two apps: labels, origins, times, a consent with the app's own words, an open tab, email shared.
  await page.locator('#home-devices-show').click();
  await expect(section.locator('.home-device')).toHaveCount(4);
  await expect(section.locator('.home-device-name strong')).toHaveText(['Chrome on macOS', 'Safari on iOS', 'A browser (not named)', 'A tab (may be closed)']);
  await expect(section.locator('.home-policy-label').first()).toHaveText('Swaps up to 50 USDC a day on Base, to Sodax’s own contracts');
  await expect(section.locator('.home-email')).toContainText('ada.lovelace@example.com');
  // Partner names are values in the neutral box, never headings.
  await expect(page.getByRole('heading', { name: 'Sodax' })).toHaveCount(0);
  await shots(page, 'h9-02-devices-list', browserName);

  // Each confirmation.
  await section.locator(`#home-stop-consent-front-${ID(11)}`).click();
  await expect(section.locator('.home-confirm')).toContainText('Stop auto-approving on this device?');
  await shots(page, 'h9-03-confirm-stop-auto-approve', browserName);
  await section.locator(`#home-stop-consent-front-${ID(11)}-confirm-cancel`).click();
  await section.locator(`#home-stop-share-front-${ID(1)}`).click();
  await expect(section.locator('.home-confirm')).toContainText('Sign out this device?');
  await shots(page, 'h9-04-confirm-sign-out', browserName);
  await section.locator(`#home-stop-share-front-${ID(1)}-confirm-cancel`).click();
  await section.locator('#home-stop-email-front-s1-app_sodax1').click();
  await expect(section.locator('.home-confirm')).toContainText('Stop sharing your email with this app?');
  await shots(page, 'h9-05-confirm-stop-email', browserName);
  await section.locator('#home-stop-email-front-s1-app_sodax1-confirm-cancel').click();
  expect(stops).toEqual([]);

  // After stopping: auto-approve, then the device, then email sharing.
  await section.locator(`#home-stop-consent-front-${ID(11)}`).click();
  await section.locator(`#home-stop-consent-front-${ID(11)}-confirm-go`).click();
  await expect(section.locator('#home-devices-note-front-s1')).toContainText('Auto-approve stopped.');
  await shots(page, 'h9-06-after-stop-auto-approve', browserName);
  await section.locator(`#home-stop-share-front-${ID(1)}`).click();
  await section.locator(`#home-stop-share-front-${ID(1)}-confirm-go`).click();
  await expect(section.locator('#home-devices-note-front-s1')).toContainText('Signed out.');
  await expect(section.locator('.home-device')).toHaveCount(3);
  await section.locator('#home-stop-email-front-s1-app_sodax1').click();
  await section.locator('#home-stop-email-front-s1-app_sodax1-confirm-go').click();
  await expect(section.locator('#home-devices-note-front-s1')).toContainText('Your email is no longer shared with this app.');
  await expect(section.locator('.home-email')).toHaveCount(0);
  await shots(page, 'h9-07-after-sign-out-and-stop-email', browserName);
  expect(stops.map((s) => s.path)).toEqual(['/v1/home/consents/revoke', '/v1/home/shares/revoke', '/v1/home/email-sharing/revoke']);

  // A refused stop: Hana's sentence, the code and the request id; the device stays.
  stopAnswer = { status: 404, body: { error: 'Unknown device', code: 'unknown_share', requestId: 'req_e2e' } };
  await section.locator(`#home-stop-share-front-${ID(2)}`).click();
  await section.locator(`#home-stop-share-front-${ID(2)}-confirm-go`).click();
  await expect(section.locator('#home-devices-problem-front')).toContainText('Hana Home couldn’t find that device among yours');
  await expect(section.locator('#home-devices-problem-front')).toContainText('Code: unknown_share');
  await shots(page, 'h9-08-stop-refused', browserName);
  stopAnswer = null;

  // An app's page: its own devices, its email sharing on, and below them the move.
  data = devicesFixture(now);
  await page.getByRole('button', { name: 'View Sodax', exact: true }).click();
  await page.locator('#home-app-devices-show').click();
  const appSection = page.locator('#home-app-devices');
  await expect(appSection.locator('.home-device')).toHaveCount(3);
  await expect(appSection.locator('.home-device-app')).toHaveText(['Sodax', 'Sodax Earn', 'Sodax']);
  await appSection.scrollIntoViewIfNeeded();
  await shots(page, 'h9-09-app-page-devices-email-on', browserName);
  await page.getByRole('button', { name: 'Back to all apps' }).click();

  // An app with email sharing off and only an open tab's auto-approve.
  await page.getByRole('button', { name: 'View Lumen Pay', exact: true }).click();
  await page.locator('#home-app-devices-show').click();
  await expect(page.locator('#home-email-none')).toHaveText('You aren’t sharing your email address with this app.');
  await expect(page.locator('#home-app-devices')).toContainText('A tab (may be closed) on https://lumenpay.example');
  await page.locator('#home-app-devices').scrollIntoViewIfNeeded();
  await shots(page, 'h9-10-app-page-tab-consent-email-off', browserName);
  await page.getByRole('button', { name: 'Back to all apps' }).click();

  // Nothing signed in anywhere.
  mode = 'empty';
  await page.locator('#home-devices-refresh').click();
  await expect(page.locator('#home-devices-empty')).toContainText('No device is signed in to your apps with Hana right now');
  await shots(page, 'h9-11-front-empty', browserName);
  await page.getByRole('button', { name: 'View Lumen Pay', exact: true }).click();
  await page.locator('#home-app-devices-show').click();
  await expect(page.locator('#home-app-devices-empty')).toBeVisible();
  await shots(page, 'h9-12-app-page-empty', browserName);
  await page.getByRole('button', { name: 'Back to all apps' }).click();

  // A linked account Hana couldn't confirm on NEAR: the devices, no stop, no addresses, and why.
  mode = 'unconfirmed';
  await page.locator('#home-devices-refresh').click();
  await expect(page.locator('#home-devices-unconfirmed-front-s1')).toContainText('couldn’t check on NEAR');
  await expect(page.locator('#home-devices button[id^="home-stop-"]')).toHaveCount(0);
  await shots(page, 'h9-15-account-unconfirmed', browserName);

  // The list can't be read.
  mode = 'error';
  await page.locator('#home-devices-refresh').click();
  await expect(page.locator('#home-devices-problem-front')).toContainText('Hana Home is not reachable right now.');
  await shots(page, 'h9-13-list-error', browserName);

  // The sign-in's end: what is on screen stays, a stop sends nothing.
  mode = 'list';
  await context.clock.fastForward(16 * 60_000);
  await expect(page.locator('#home-ended')).toBeVisible();
  const before = stops.length;
  await page.locator('#home-devices-refresh').click();
  await expect(page.locator('#home-devices-problem-front')).toContainText('Your sign-in to Hana Home has ended.');
  expect(stops.length).toBe(before);
  await shots(page, 'h9-14-signed-out-click', browserName);
});

test('`/home?view=devices` opens the devices section after sign-in, with one read', async ({ page, context }) => {
  const reads: string[] = [];
  await routeApps(context, () => ({ status: 200, body: LIST }));
  await routeDevices(context, (_m, url) => {
    reads.push(url.search);
    return { status: 200, body: { scopes: [devicesFixture(Date.now()).s1], nextCursor: null } };
  });
  await page.goto(`${AUTH_ORIGIN}/home?view=devices`);
  await signIn(page);
  await expect(page.locator('#home-devices .home-device')).toHaveCount(3);
  expect(reads).toEqual(['']);
  await expect(page.locator('#home-devices-title')).toBeFocused();
});
