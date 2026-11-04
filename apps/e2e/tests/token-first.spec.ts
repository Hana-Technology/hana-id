// token_first (D270, D273), the flow in force since the spike passed (2026-11-04), end to end on the local stack: the
// email scope on Google's one sign-in screen (an access token), tokeninfo from the callback (a CORS POST, routed to the
// stub as Google answers it), the silent openid-only ID request whose token alone goes on chain, D273's one
// interactive retry, and the address in the issuer's user directory (D269: google-record for an app without email
// login, google-match for one with it). Nothing on chain may carry the address (`/__e2e/chain`, `google.issued`).
import type { Page, TestInfo } from '@playwright/test';
import { TOKEN_CLAIM_ALLOW_LIST } from '@hana-id/core';
import { GOOGLE_AUTH_URL } from '../src/google-stub.ts';
import { ISSUER_URL } from '../src/stack.ts';
import { LOGIN_ENDPOINT, type RequestLog, chainView, clickAction, directoryView, expect, newApp, okValue, openPartner, settled, status, test } from './fixtures.ts';

const MATCH = `${ISSUER_URL}/v1/email/google-match`;
const RECORD = `${ISSUER_URL}/v1/email/google-record`;
/** The claims Google sends for `scope=openid` (the spike's set, every account kind). */
const OPENID_CLAIMS = ['aud', 'azp', 'exp', 'iat', 'iss', 'jti', 'nbf', 'nonce', 'sub'];
const rand = (): string => crypto.randomUUID().replace(/-/gu, '').slice(0, 10);
/** A fresh Google `sub` (21 digits, as Google's). */
const newSub = (): string => `1${Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => String(b % 10)).join('')}`;
const gmail = (info: TestInfo, tag: string): string => `e2etf${tag}${info.project.name}${rand()}@gmail.com`;

/** Nothing on chain names the account beyond the allow-list: every token relayed for `sub` is openid-only. */
async function expectOpenidOnlyOnChain(sub: string): Promise<void> {
  const view = await chainView(sub);
  expect(view.relayed.length).toBeGreaterThan(0);
  for (const tx of view.relayed) {
    for (const t of tx.tokens.filter((x) => x.provider === 'google')) {
      expect(t.claims.filter((c) => !TOKEN_CLAIM_ALLOW_LIST.includes(c)), tx.method).toEqual([]);
      expect(t.claims, tx.method).not.toContain('email');
    }
  }
}

/** A Google login through the partner's button: the chooser's first account; resolves with the popup. */
async function googleLogin(page: Page, name: string, o: { emailApp?: boolean } = {}): Promise<Page> {
  const popupP = page.waitForEvent('popup');
  await clickAction(page, name, 'login');
  const popup = await popupP;
  if (o.emailApp) await popup.click('#continue-google');
  await popup.waitForURL(`${GOOGLE_AUTH_URL}**`);
  await popup.click('#account-0');
  return popup;
}

const loginCount = (requests: RequestLog): number => requests.count(LOGIN_ENDPOINT);

test('a Google-only app: one chooser, tokeninfo, the silent openid ID token on chain; google-record puts the address in the directory', async ({ page, google, requests }, info) => {
  const sub = newSub();
  const email = gmail(info, 'rec');
  google.accounts = [{ sub, label: 'Rec', email, emailVerified: true }];
  const app = await newApp();
  await openPartner(page, app);
  const popup = await googleLogin(page, 'login');
  await popup.waitForEvent('close', { timeout: 20_000 });
  expect((await okValue<{ evm: string }>(page, 'login')).evm).toMatch(/^0x/u);

  // Google's one sign-in screen asked for `openid email` as an access token (no ID token, no nonce); tokeninfo named
  // the account; the silent ID request for it was openid only, with the login's nonce.
  expect(google.kinds).toEqual(['token_first', 'id']);
  const [first, id] = google.requests.map((r) => (r.ok ? r.request : null));
  expect(first).toMatchObject({ kind: 'token_first', scope: 'openid email', nonce: '' });
  expect(id).toMatchObject({ kind: 'id', scope: 'openid', loginHint: sub, silent: true });
  expect(id?.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(google.tokeninfoCalls.map((c) => c.sub)).toEqual([sub]);
  // The only ID token Google issued is the spike's openid set: no email, no hd.
  expect(google.issued.filter((t) => t.sub === sub).map((t) => [...t.claims].sort())).toEqual([OPENID_CLAIMS]);

  // One login transaction, openid only; no google-match (email login is off), one google-record.
  expect(loginCount(requests)).toBe(1);
  await expectOpenidOnlyOnChain(sub);
  expect(requests.count(MATCH)).toBe(0);
  await expect.poll(() => requests.count(RECORD)).toBe(1);

  // The directory (Hana staff only): userinfo's verified address, Google-hosted, and the app it logged in to.
  await expect.poll(async () => (await directoryView(sub)).identities.length, { timeout: 10_000 }).toBe(1);
  const dir = await directoryView(sub);
  expect(dir.identities).toEqual([{ provider: 'google', sub, email, email_verified: 1, hosted: 1 }]);
  expect(dir.apps).toEqual([{ provider: 'google', sub, app_id: app.appId, scope_id: 'e2e' }]);
});

test('an app with email login: google-match gets the access token, writes the directory, and the chain still sees openid only', async ({ page, google, requests }) => {
  const sub = newSub();
  const email = `grace-tf-${rand()}@workspace-e2e.example.com`;
  google.accounts = [{ sub, label: 'Workspace', email, emailVerified: true, hd: 'workspace-e2e.example.com' }];
  const app = await newApp({ loginMethods: 'google,email' });
  await openPartner(page, app);
  const popup = await googleLogin(page, 'login', { emailApp: true });
  await popup.waitForEvent('close', { timeout: 20_000 });
  expect((await okValue<{ evm: string }>(page, 'login')).evm).toMatch(/^0x/u);
  // No Hana explainer, no second Google screen (D264 amended by D270): the login finished with no other click.
  expect(google.kinds).toEqual(['token_first', 'id']);
  expect(requests.count(MATCH)).toBe(1);
  expect(requests.count(RECORD)).toBe(0);
  // Workspace's `hd` stays in userinfo (the directory), never in the ID token (as the spike saw).
  expect(google.issued.filter((t) => t.sub === sub).map((t) => [...t.claims].sort())).toEqual([OPENID_CLAIMS]);
  await expectOpenidOnlyOnChain(sub);
  await expect.poll(async () => (await directoryView(sub)).identities.length, { timeout: 10_000 }).toBe(1);
  const dir = await directoryView(sub);
  expect(dir.identities).toEqual([{ provider: 'google', sub, email, email_verified: 1, hosted: 1 }]);
  expect(dir.apps).toEqual([{ provider: 'google', sub, app_id: app.appId, scope_id: 'e2e' }]);
});

test('D273: a silent ID request Google answers with interaction_required is asked once more interactively, openid only, for the same account', async ({ page, google, requests }) => {
  const sub = newSub();
  google.accounts = [{ sub, label: 'Retry', email: `e2etfretry${rand()}@gmail.com`, emailVerified: true, silentIdError: 'interaction_required' }];
  const app = await newApp();
  await openPartner(page, app);
  const popup = await googleLogin(page, 'login');
  // No Hana screen before the retry (nothing new is asked): the popup closes with no other click.
  await popup.waitForEvent('close', { timeout: 20_000 });
  expect((await okValue<{ evm: string }>(page, 'login')).evm).toMatch(/^0x/u);
  expect(google.kinds).toEqual(['token_first', 'id', 'proof']);
  const retry = google.requests[2]?.ok ? google.requests[2].request : null;
  expect(retry).toMatchObject({ scope: 'openid', loginHint: sub });
  expect(retry?.nonce).toBe(google.requests[1]?.ok ? google.requests[1].request.nonce : 'missing');
  expect(loginCount(requests)).toBe(1);
  await expectOpenidOnlyOnChain(sub);
});

test('tokeninfo unreadable from the browser (no CORS): an app with email login ends tokeninfo_unavailable, nothing on chain', async ({ page, google, requests }) => {
  const sub = newSub();
  google.accounts = [{ sub, label: 'NoCors', email: `e2etfnocors${rand()}@gmail.com`, emailVerified: true }];
  google.tokeninfoCors = false;
  const app = await newApp({ loginMethods: 'google,email' });
  await openPartner(page, app);
  const popup = await googleLogin(page, 'login', { emailApp: true });
  await expect(popup.locator('body')).toContainText('Code: tokeninfo_unavailable');
  expect(await settled(page, 'login')).toMatchObject({ state: 'error', code: 'google_error', data: { error: 'tokeninfo_unavailable' } });
  expect(await status(page)).toBe('logged_out');
  // Never a request without the hint: only Google's first screen was asked.
  expect(google.kinds).toEqual(['token_first']);
  expect(loginCount(requests)).toBe(0);
  expect(requests.count(MATCH)).toBe(0);
  expect(await chainView(sub)).toEqual({ relayed: [], sessions: 0 });
  expect((await directoryView(sub)).identities).toEqual([]);
});

test('tokeninfo unreadable, a Google-only app: batch B’s openid login with the chooser instead, nothing recorded', async ({ page, google, requests }) => {
  const sub = newSub();
  google.accounts = [{ sub, label: 'NoCorsRec', email: `e2etfnocorsrec${rand()}@gmail.com`, emailVerified: true }];
  google.tokeninfoCors = false;
  const app = await newApp();
  await openPartner(page, app);
  const popup = await googleLogin(page, 'login');
  // The record-only fallback: the access token is dropped and Google's chooser comes back for the openid login.
  await popup.waitForURL(/response_type=id_token/u);
  await popup.click('#account-0');
  await popup.waitForEvent('close', { timeout: 20_000 });
  expect((await okValue<{ evm: string }>(page, 'login')).evm).toMatch(/^0x/u);
  expect(google.kinds).toEqual(['token_first', 'login']);
  expect(loginCount(requests)).toBe(1);
  await expectOpenidOnlyOnChain(sub);
  expect(requests.count(RECORD)).toBe(0);
  expect((await directoryView(sub)).identities).toEqual([]);
});
