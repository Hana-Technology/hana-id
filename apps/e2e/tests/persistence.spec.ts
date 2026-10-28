// Key persistence across reloads and tabs (docs/batch-b-spec.md "Key persistence"): a reload unlocks with one API call
// and no derive, login or chain call; records are per app and per top-level site; logout ends every tab of the app; a
// 410 means a full login; blocked storage falls back to 'none'.
import { API_URL, NEAR_RPC, PARTNER_ORIGIN, SITE_B_ORIGIN, VAULT_ORIGIN } from '../src/stack.ts';
import {
  LOGIN_ENDPOINT,
  addresses,
  expect,
  login,
  newApp,
  okValue,
  openPartner,
  revokeShares,
  runAction,
  shares,
  status,
  test,
  vaultRecordKeys,
  waitReady,
} from './fixtures.ts';

test('a reload restores the wallet with one unlock: no /v1/derive, no login, no chain RPC, no Google', async ({ page, google, requests }) => {
  const app = await newApp();
  await openPartner(page, app);
  const before = await login(page);
  const googleBefore = google.requests.length;

  const since = requests.mark();
  await page.reload();
  expect(await waitReady(page)).toBe('ok');
  expect(await status(page)).toBe('logged_in');
  expect(await addresses(page)).toEqual(before);
  expect(requests.count(`${API_URL}/v1/vault/unlock`, since)).toBe(1);
  expect(requests.count(`${API_URL}/v1/derive`, since)).toBe(0);
  expect(requests.count(LOGIN_ENDPOINT, since)).toBe(0);
  expect(requests.count(`${API_URL}/v1/login-relay/`, since)).toBe(0);
  expect(requests.count(NEAR_RPC, since)).toBe(0);
  expect(google.requests.length).toBe(googleBefore);
  // The unlock used the share's next counter.
  expect(await shares(app)).toEqual([{ counter: 1, revoked: false, partnerOrigin: PARTNER_ORIGIN }]);
});

test('a second tab unlocks', async ({ context, requests }) => {
  const app = await newApp();
  const a = await context.newPage();
  await openPartner(a, app);
  const first = await login(a);
  const since = requests.mark();
  const b = await context.newPage();
  await openPartner(b, app);
  expect(await status(b)).toBe('logged_in');
  expect(await addresses(b)).toEqual(first);
  expect(requests.count(`${API_URL}/v1/derive`, since)).toBe(0);
  expect(requests.count(LOGIN_ENDPOINT, since)).toBe(0);
});

test('another top-level site sees no record (partitioned storage)', async ({ context, browserName }) => {
  const app = await newApp({ origins: [PARTNER_ORIGIN, SITE_B_ORIGIN] });
  const a = await context.newPage();
  await openPartner(a, app);
  await login(a);
  const keys = await vaultRecordKeys(a);
  expect(keys).toHaveLength(1);
  expect(keys[0]).toContain(app.appId);

  const b = await context.newPage();
  await openPartner(b, app, { origin: SITE_B_ORIGIN });
  expect(await status(b)).toBe('logged_out');
  if (browserName === 'chromium') {
    // Playwright launches Chromium with ThirdPartyStoragePartitioning disabled (microsoft/playwright#32230), unlike
    // Chrome as shipped, so here both sites share one store. The vault still never uses a record pinned to another
    // parent (logged out above, and the record is left alone).
    test.info().annotations.push({ type: 'chromium', description: 'storage partitioning is off in Playwright Chromium; checked the vault refuses the other parent’s record' });
    expect(await vaultRecordKeys(b)).toEqual(keys);
  } else {
    // Not just unused: the vault under the other top-level site can't see the record at all.
    expect(await vaultRecordKeys(b)).toEqual([]);
  }
  // The first site's wallet is untouched.
  await a.reload();
  await waitReady(a);
  expect(await status(a)).toBe('logged_in');
});

test('another app on the same site and scope sees no record', async ({ context }) => {
  const appA = await newApp({ scopeId: 'shared' });
  const appB = await newApp({ scopeId: 'shared' });
  const a = await context.newPage();
  await openPartner(a, appA);
  await login(a);

  const b = await context.newPage();
  await openPartner(b, appB);
  expect(await status(b)).toBe('logged_out');
  // Same partition, so B's vault frame sees A's entry in the store, keyed by A's app id: it reads only its own key.
  const keys = await vaultRecordKeys(b);
  expect(keys.some((k) => k.includes(appB.appId))).toBe(false);
  expect(keys.some((k) => k.includes(appA.appId))).toBe(true);

  // A logout in B touches nothing of A's.
  await runAction(b, 'logout', 'logout');
  await okValue(b, 'logout');
  await a.reload();
  await waitReady(a);
  expect(await status(a)).toBe('logged_in');
});

test("logout wipes every tab of that app, and the record and share", async ({ context }) => {
  const app = await newApp();
  const a = await context.newPage();
  await openPartner(a, app);
  await login(a);
  const b = await context.newPage();
  await openPartner(b, app);
  expect(await status(b)).toBe('logged_in');

  await runAction(a, 'logout', 'logout');
  await okValue(a, 'logout');
  await expect.poll(() => status(b)).toBe('logged_out');
  expect(await b.evaluate(() => (window as any).e2e.events.some((e: { name: string }) => e.name === 'disconnect'))).toBe(true);
  expect(await vaultRecordKeys(a)).toEqual([]);
  expect((await shares(app)).every((s) => s.revoked)).toBe(true);

  await b.reload();
  await waitReady(b);
  expect(await status(b)).toBe('logged_out');
});

test('a 410 from unlock leads to a full login, never a derive', async ({ page, requests }) => {
  const app = await newApp();
  await openPartner(page, app);
  const first = await login(page);
  expect(await revokeShares(app)).toBe(1);

  const since = requests.mark();
  await page.reload();
  await waitReady(page);
  expect(await status(page)).toBe('logged_out');
  expect(requests.count(`${API_URL}/v1/vault/unlock`, since)).toBe(1);
  expect(await vaultRecordKeys(page)).toEqual([]);

  expect(await login(page, { name: 'again' })).toEqual(first);
  expect(requests.count(LOGIN_ENDPOINT, since)).toBe(1);
  expect(requests.count(`${API_URL}/v1/derive`, since)).toBe(0);
});

test("blocked storage falls back to 'none' (storage_unavailable), and a reload needs a new login", async ({ page, context, requests }) => {
  await context.addInitScript(
    ([vault]) => {
      if (location.origin !== vault) return;
      Object.defineProperty(IDBFactory.prototype, 'open', {
        configurable: true,
        value: () => {
          throw new DOMException('The user denied permission to access the database.', 'SecurityError');
        },
      });
    },
    [VAULT_ORIGIN] as const,
  );
  const app = await newApp();
  await openPartner(page, app);
  expect(await page.evaluate(() => (window as any).e2e.warning())).toBe('storage_unavailable');
  expect(await page.evaluate(() => (window as any).e2e.persistence())).toBe('none');

  await login(page);
  expect(await page.evaluate(() => (window as any).e2e.hana.lastLogin.persistence)).toBe('none');
  expect(requests.count(`${API_URL}/v1/vault/shares`)).toBe(0);

  await page.reload();
  await waitReady(page);
  expect(await status(page)).toBe('logged_out');
  expect(requests.count(`${API_URL}/v1/vault/unlock`)).toBe(0);
});
