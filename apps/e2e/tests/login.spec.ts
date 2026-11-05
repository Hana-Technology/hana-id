// Login through the popup and the relay (docs/batch-b-spec.md "Login"), and the partner-page COOP cases.
import { TOKEN_CLAIM_ALLOW_LIST } from '@hana-id/core';
import { GOOGLE_AUTH_URL, GoogleStub, stackGoogleKey } from '../src/google-stub.ts';
import { API_URL, AUTH_ORIGIN, NEAR_RPC, VAULT_ORIGIN } from '../src/stack.ts';
import {
  LOGIN_ENDPOINT,
  VAULT_FRAME,
  chainView,
  chooseAccount,
  clickAction,
  clickLauncher,
  clickMayClose,
  errorCode,
  errorOf,
  expect,
  login,
  newApp,
  okValue,
  openPartner,
  routeStubs,
  settled,
  status,
  test,
  vaultFrame,
  vaultRecordKeys,
} from './fixtures.ts';

test('one click on the partner button plus the chooser logs in', async ({ page, google, requests }) => {
  const app = await newApp();
  expect(await openPartner(page, app)).toBe('ok');
  expect(await status(page)).toBe('logged_out');

  const popupP = page.waitForEvent('popup');
  await clickAction(page, 'login', 'login');
  const popup = await popupP;
  await chooseAccount(popup);
  const addresses = await okValue<{ stellar: string; evm: string }>(page, 'login');

  expect(addresses.stellar).toMatch(/^G[A-Z2-7]{55}$/u);
  expect(addresses.evm).toMatch(/^0x[0-9a-fA-F]{40}$/u);
  expect(await status(page)).toBe('logged_in');
  // token_first (D270; the stack has an email issuer, so a Google-only app's login records the address): the access
  // token request with the chooser, tokeninfo once, then the silent openid-only ID request for that account; one
  // combined login transaction, no split flow, no derive.
  expect(google.kinds).toEqual(['token_first', 'id']);
  expect(google.requests.map((r) => r.ok && r.request.scope)).toEqual(['openid email', 'openid']);
  expect(google.tokeninfoCalls).toEqual([{ sub: google.accounts[0]!.sub, origin: AUTH_ORIGIN }]);
  expect(requests.count(`${API_URL}/v1/login-relay/`)).toBeGreaterThanOrEqual(2);
  expect(requests.count(LOGIN_ENDPOINT)).toBe(1);
  expect(requests.count(`${API_URL}/v1/derive`)).toBe(0);
  // A clean shared-mode login reads NEAR four times: the vault's registry check of its scope (Q7: get_scope) and of the
  // shared client (D117: get_config), in parallel; the path through `get_identity` (batch 7); and, after the login,
  // the wallet's sign-in methods (`get_account`, for `linkChanged`). Re-syncs are only for failures.
  expect(requests.count(NEAR_RPC)).toBe(4);
});

test('D381: a session key WebCrypto refuses once (WebKit Linux’s Ed25519 OperationError) is asked for again: the popup stays and signs in', async ({ page }) => {
  // WebKitGTK and WPE reject about 1 in 100 Ed25519 generateKey calls. The login's newSessionKey then failed the login
  // at once (api_unavailable), and the SDK closed the popup it had just opened: the WebKit flakes of popup-close and
  // demo specs in CI. Here the vault frame's first Ed25519 key generation fails the same way, in every browser.
  await page.addInitScript((vault) => {
    if (location.origin !== vault) return;
    const subtle = crypto.subtle;
    const real = subtle.generateKey.bind(subtle);
    (window as any).__keygenRefused = 0;
    subtle.generateKey = ((algorithm: AlgorithmIdentifier, ...rest: [boolean, KeyUsage[]]) => {
      const name = typeof algorithm === 'string' ? algorithm : algorithm.name;
      if (name === 'Ed25519' && (window as any).__keygenRefused === 0) {
        (window as any).__keygenRefused += 1;
        return Promise.reject(new DOMException('The operation failed for an operation-specific reason', 'OperationError'));
      }
      return real(algorithm, ...rest);
    }) as typeof subtle.generateKey;
  }, VAULT_ORIGIN);
  await openPartner(page, await newApp());
  const popupP = page.waitForEvent('popup');
  await clickAction(page, 'login', 'login');
  const popup = await popupP;
  await chooseAccount(popup);
  expect((await okValue<{ evm: string }>(page, 'login')).evm).toMatch(/^0x[0-9a-fA-F]{40}$/u);
  expect(await vaultFrame(page).evaluate(() => (window as any).__keygenRefused)).toBe(1);
});

test('D385: a browser without Ed25519 WebCrypto gets derive_failed (webcrypto_unsupported), not api_unavailable, and no login is sent', async ({ page, requests }) => {
  // Chrome and Edge before 137, Firefox before 129 and Safari before 17 have no Ed25519 in WebCrypto: the vault frame
  // can't make the session key. Before D385 this was api_unavailable ("Could not reach Hana's service").
  await page.addInitScript((vault) => {
    if (location.origin !== vault) return;
    const subtle = crypto.subtle;
    const real = subtle.generateKey.bind(subtle);
    subtle.generateKey = ((algorithm: AlgorithmIdentifier, ...rest: [boolean, KeyUsage[]]) => {
      const name = typeof algorithm === 'string' ? algorithm : algorithm.name;
      if (name === 'Ed25519') return Promise.reject(new DOMException('Unrecognized algorithm name', 'NotSupportedError'));
      return real(algorithm, ...rest);
    }) as typeof subtle.generateKey;
  }, VAULT_ORIGIN);
  await openPartner(page, await newApp());
  await clickAction(page, 'login', 'login');
  const r = await settled(page, 'login');
  expect(r).toMatchObject({ state: 'error', code: 'derive_failed', reason: 'webcrypto_unsupported', data: { reason: 'webcrypto_unsupported', error: 'NotSupportedError' } });
  expect(requests.count(LOGIN_ENDPOINT)).toBe(0);
});

test('the same Google account gets the same addresses on another device, another account other ones', async ({ page, browser }) => {
  const app = await newApp();
  await openPartner(page, app);
  const first = await login(page);

  // Another browser profile ("device"), with its own Google stub key: only the Google account decides the addresses.
  const other = await browser.newContext();
  try {
    await routeStubs(other, new GoogleStub({ key: stackGoogleKey(API_URL) }));
    const page2 = await other.newPage();
    await openPartner(page2, app);
    expect(await login(page2)).toEqual(first);
    await page2.evaluate(() => (window as any).e2e.run('logout', 'logout'));
    await okValue(page2, 'logout');
    const second = await login(page2, { account: 1, name: 'login2' });
    expect(second.stellar).not.toBe(first.stellar);
    expect(second.evm).not.toBe(first.evm);
  } finally {
    await other.close();
  }
});

test('closing the login popup and clicking login again works (supersede)', async ({ page }) => {
  const app = await newApp();
  await openPartner(page, app);

  const firstPopupP = page.waitForEvent('popup');
  await clickAction(page, 'first', 'login');
  const firstPopup = await firstPopupP;
  // Connected and at Google: the SDK no longer watches popup.closed (Google's COOP could make it report closed).
  await firstPopup.waitForURL(/accounts\.google\.com/u);
  await firstPopup.close();

  const addresses = await login(page, { name: 'second' });
  expect(addresses.evm).toMatch(/^0x/u);
  expect(await errorCode(page, 'first')).toBe('login_cancelled');
});

test('two partner tabs logging in at once each complete', async ({ context }) => {
  const app = await newApp();
  const [a, b] = [await context.newPage(), await context.newPage()];
  await openPartner(a, app);
  await openPartner(b, app);

  const popupA = a.waitForEvent('popup');
  await clickAction(a, 'login', 'login');
  const popupB = b.waitForEvent('popup');
  await clickAction(b, 'login', 'login');
  const [pa, pb] = [await popupA, await popupB];
  await Promise.all([chooseAccount(pa), chooseAccount(pb)]);

  const [ra, rb] = [await okValue<{ evm: string }>(a, 'login'), await okValue<{ evm: string }>(b, 'login')];
  expect(ra).toEqual(rb);
});

test("a blocked popup falls back to the vault's \"Sign in with Hana\" launcher", async ({ page }) => {
  const app = await newApp();
  await openPartner(page, app, { blockPopups: true });
  await clickAction(page, 'login', 'login');
  const popup = await clickLauncher(page, 'Sign in with Hana');
  // Opened by the vault itself (vault mode), from its own click.
  expect(new URL(popup.url()).search).toBe('?from=vault');
  await chooseAccount(popup);
  expect((await okValue<{ stellar: string }>(page, 'login')).stellar).toMatch(/^G/u);
  await expect(page.locator(VAULT_FRAME)).toBeHidden();
});

test('a Google #error other than a cancel ends the login with google_error (a cancel goes back to the chooser: google-cancel.spec.ts, D341)', async ({ page, google }) => {
  const app = await newApp();
  await openPartner(page, app);
  const popupP = page.waitForEvent('popup');
  await clickAction(page, 'login', 'login');
  const popup = await popupP;
  await popup.waitForURL(/accounts\.google\.com/u);
  // Google answers its sign-in screen with a failure of its own (not the user's Cancel).
  const first = google.requests[0];
  if (!first?.ok) throw new Error('no Google request');
  await popup.goto(`${AUTH_ORIGIN}/login/callback#error=server_error&state=${first.request.state}`);
  expect(await errorOf(page, 'login')).toMatchObject({ code: 'google_error' });
  expect(await settled(page, 'login')).toMatchObject({ data: { error: 'server_error' } });
  expect(await status(page)).toBe('logged_out');
});

test.describe('partner COOP', () => {
  test('same-origin gives coop_blocks_popup', async ({ page }) => {
    const app = await newApp();
    await openPartner(page, app, { coop: 'same-origin' });
    const popupP = page.waitForEvent('popup');
    await clickAction(page, 'login', 'login');
    const popup = await popupP;
    expect(await errorCode(page, 'login')).toBe('coop_blocks_popup');
    // The popup, cut off from its opener, says why (unless the SDK already closed it).
    if (!popup.isClosed()) await expect(popup.getByRole('heading')).toContainText(/COOP/u);
  });

  test('same-origin-allow-popups works', async ({ page }) => {
    const app = await newApp();
    await openPartner(page, app, { coop: 'same-origin-allow-popups' });
    const addresses = await login(page);
    expect(addresses.stellar).toMatch(/^G/u);
  });
});

test('an IdP that enforces COOP same-origin still completes through the relay', async ({ page, google, browserName }) => {
  // The popup switches browsing context groups at Google and again at the callback: the opener is gone, and the
  // relayKey must survive in the popup's sessionStorage.
  google.coop = 'same-origin';
  const app = await newApp();
  await openPartner(page, app);
  const popupP = page.waitForEvent('popup');
  await clickAction(page, 'login', 'login');
  // A COOP switch can replace the popup's page (Playwright closes the old Page and opens a new one), so follow
  // whichever page reaches Google.
  const first = await popupP;
  const replaced = page
    .context()
    .waitForEvent('page')
    .then(async (p) => (await p.waitForURL(/accounts\.google\.com/u), p));
  const popup = await Promise.any([first.waitForURL(/accounts\.google\.com/u).then(() => first), replaced]);
  const severed = await popup.evaluate(() => window.opener === null);
  if (browserName === 'webkit') {
    // Playwright's WebKit doesn't apply COOP to a route-fulfilled response (it does to served ones: see the partner
    // COOP cases), so there this case checks the relay path without the browsing-context switch.
    test.info().annotations.push({ type: 'webkit', description: `COOP on the stub ${severed ? 'applied' : 'not applied'}` });
  } else {
    expect(severed).toBe(true);
  }
  await clickMayClose(popup, '#account-0');
  const addresses = await okValue<{ stellar: string }>(page, 'login');
  expect(addresses.stellar).toMatch(/^G/u);
});

test('the callback closes itself right after its relay POST, and the token still arrives', async ({ page }) => {
  const app = await newApp();
  await openPartner(page, app);
  const popupP = page.waitForEvent('popup');
  await clickAction(page, 'login', 'login');
  const popup = await popupP;
  const order: string[] = [];
  popup.on('response', (r) => {
    if (r.url().includes('/v1/login-relay/') && r.request().method() === 'POST') order.push(`relay ${r.status()}`);
  });
  popup.on('close', () => order.push('closed'));
  await chooseAccount(popup);
  // token_first's record-only login: the access token to follow-up slot 1, then the ID token to the login's slot,
  // then the window closes (no follow-up mode in an app without email login).
  expect(order).toEqual(['relay 204', 'relay 204', 'closed']);
  expect((await okValue<{ evm: string }>(page, 'login')).evm).toMatch(/^0x/u);
});

test('a Google ID token that carries the email is refused (token_has_pii): no /v1/login, nothing relayed to the chain', async ({ page, google, requests }) => {
  // The token goes on chain (the contract verifies it there), so an address in it would be public for good. Google
  // here leaks `email` and `email_verified` into the openid-only login's token (src/google-stub.ts emailInIdToken).
  const sub = `1${Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => String(b % 10)).join('')}`;
  google.accounts = [{ sub, label: 'Leaky', email: `leak${sub.slice(-8)}@gmail.com`, emailVerified: true, emailInIdToken: true }];
  const app = await newApp();
  await openPartner(page, app);
  const popupP = page.waitForEvent('popup');
  await clickAction(page, 'login', 'login');
  const popup = await popupP;
  await popup.waitForURL(`${GOOGLE_AUTH_URL}**`);
  await popup.click('#account-0');
  // The callback refuses the token before relaying it (D273): it relays only `{error: 'token_has_pii', claim}` and
  // stays open to say why.
  await expect(popup.locator('body')).toContainText('Code: token_has_pii');

  // The SDK's error, naming the first claim outside the allow-list (as the vault's own refusal does).
  const r = await settled(page, 'login');
  expect(r).toMatchObject({ state: 'error', code: 'token_has_pii', data: { claim: 'email' } });
  // Refused before any API call (D405): no request ID to name.
  expect(r.state === 'error' && r.data).not.toHaveProperty('requestId');
  expect(await status(page)).toBe('logged_out');
  // The premise: the token Google sent really carried the address.
  expect(google.issued.filter((t) => t.sub === sub).map((t) => t.claims)).toEqual([expect.arrayContaining(['email', 'email_verified'])]);
  // Only the popup's refusal crossed the end-to-end encrypted relay; the vault never asked the API to relay anything on chain.
  expect(requests.count(`${API_URL}/v1/login-relay/`)).toBeGreaterThanOrEqual(2);
  expect(requests.count(LOGIN_ENDPOINT)).toBe(0);
  expect(requests.count(`${API_URL}/v1/derive`)).toBe(0);
  // Nothing reached the chain: no relayed transaction with this account's token, no session on its path, no record.
  expect(await chainView(sub)).toEqual({ relayed: [], sessions: 0 });
  // Nor did any Google token with a claim outside the allow-list, in any test so far.
  const leaked = (await chainView()).relayed.flatMap((t) => t.tokens).filter((t) => t.provider === 'google' && t.claims.some((c) => !TOKEN_CLAIM_ALLOW_LIST.includes(c)));
  expect(leaked).toEqual([]);
  expect(await vaultRecordKeys(page)).toEqual([]);

  // The same account once Google sends the openid claims only: the login goes through, and its one transaction is
  // what the chain double records (so the empty view above is a real observation, not a blind spot).
  await popup.close();
  google.accounts = [{ ...google.accounts[0]!, emailInIdToken: false }];
  await login(page, { name: 'clean' });
  expect(requests.count(LOGIN_ENDPOINT)).toBe(1);
  const after = await chainView(sub);
  expect(after.relayed).toEqual([{ method: 'create_session_and_derive', tokens: [{ provider: 'google', sub, claims: expect.not.arrayContaining(['email']) }] }]);
  expect(after.sessions).toBe(1);
});
