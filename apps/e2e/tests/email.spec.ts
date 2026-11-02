// Email login in the Hana popup (build plan batch 8a), end to end on the local stack: the real popup pages, vault and
// SDK, apps/email-issuer's own Worker with the `outbox` stub (src/server/issuer.ts), the API's gate and relay, and the
// mocked chain and MPC. Flows: the chooser → email → code → wallet; a returning login that sends its device ticket;
// a wrong code then the right one; and Google through the chooser gives the Google wallet unchanged.
import type { Page, TestInfo } from '@playwright/test';
import { GoogleStub } from '../src/google-stub.ts';
import { ISSUER_URL } from '../src/stack.ts';
import { LOGIN_ENDPOINT, chooseAccount, clickAction, expect, login, newApp, okValue, openPartner, routeStubs, status, test, waitPersisted } from './fixtures.ts';

/** A fresh address per test and browser (the issuer's per-address limits are real here). */
const address = (info: TestInfo, tag: string): string => `e2e-${tag}-${info.project.name}-${crypto.randomUUID().slice(0, 8)}@mail-e2e.example.com`;

/** The code of the last mail the outbox holds for `to` (read through the stack's control endpoint). */
async function codeFor(to: string, previous = 0): Promise<string> {
  await expect.poll(async () => ((await (await fetch(`${ISSUER_URL}/__e2e/outbox?to=${encodeURIComponent(to)}`)).json()) as unknown[]).length, { timeout: 10_000 }).toBeGreaterThan(previous);
  const mails = (await (await fetch(`${ISSUER_URL}/__e2e/outbox?to=${encodeURIComponent(to)}`)).json()) as { subject: string; text: string; kind: string }[];
  const last = mails[mails.length - 1]!;
  expect(last.kind).toBe('code');
  // The code is never in the subject (lock-screen previews, Q8).
  expect(last.subject).not.toMatch(/\d{6}/u);
  const m = /\b(\d{6})\b/u.exec(last.text);
  if (!m) throw new Error('no code in the mail');
  return m[1] as string;
}

const mailCount = async (to: string): Promise<number> => ((await (await fetch(`${ISSUER_URL}/__e2e/outbox?to=${encodeURIComponent(to)}`)).json()) as unknown[]).length;

/** Address → Send code → the code from the outbox → Continue; the popup closes. */
async function emailStep(popup: Page, to: string, opts: { prefilled?: boolean } = {}): Promise<void> {
  await popup.waitForURL(/\/login\/email#/u);
  if (opts.prefilled) await expect(popup.locator('#email-address')).toHaveValue(to);
  else await popup.fill('#email-address', to);
  const before = await mailCount(to);
  await popup.click('#email-send');
  await expect(popup.locator('#email-code')).toBeVisible();
  await expect(popup.locator('#email-code')).toHaveAttribute('autocomplete', 'one-time-code');
  const code = await codeFor(to, before);
  await popup.fill('#email-code', code);
  const closed = popup.waitForEvent('close', { timeout: 20_000 });
  await popup.click('#email-verify');
  await closed;
}

test('email login through the chooser opens a wallet; no Google request, one login, no link', async ({ page, google, requests }, info) => {
  const app = await newApp({ loginMethods: 'google,email' });
  await openPartner(page, app);
  const to = address(info, 'first');
  const bodies: string[] = [];
  page.context().on('request', (r) => {
    if (r.url() === `${ISSUER_URL}/v1/email/start` && r.method() === 'POST') bodies.push(r.postData() ?? '');
  });

  const popupP = page.waitForEvent('popup');
  await clickAction(page, 'login', 'login');
  const popup = await popupP;
  await expect(popup.locator('#continue-google')).toBeVisible();
  await popup.click('#continue-email');
  await emailStep(popup, to);
  const addresses = await okValue<{ stellar: string; evm: string }>(page, 'login');
  expect(addresses.evm).toMatch(/^0x[0-9a-fA-F]{40}$/u);
  expect(await status(page)).toBe('logged_in');
  expect(google.requests).toHaveLength(0);
  expect(requests.count(LOGIN_ENDPOINT)).toBe(1);
  // The first start carries no device ticket.
  expect(JSON.parse(bodies[0] as string)).not.toHaveProperty('deviceTicket');
});

test('a returning email login sends its device ticket and opens the same wallet', async ({ page }, info) => {
  const app = await newApp({ loginMethods: 'google,email' });
  await openPartner(page, app);
  const to = address(info, 'again');
  const starts: Record<string, unknown>[] = [];
  page.context().on('request', (r) => {
    if (r.url() === `${ISSUER_URL}/v1/email/start` && r.method() === 'POST') starts.push(JSON.parse(r.postData() ?? '{}') as Record<string, unknown>);
  });

  let popupP = page.waitForEvent('popup');
  await clickAction(page, 'first', 'loginWith', { method: 'email', emailHint: to });
  await emailStep(await popupP, to, { prefilled: true });
  const first = await okValue<{ stellar: string; evm: string }>(page, 'first');
  await waitPersisted(page, first.evm);

  await page.evaluate(() => (window as any).e2e.run('logout', 'logout'));
  await okValue(page, 'logout');
  popupP = page.waitForEvent('popup');
  await clickAction(page, 'second', 'loginWith', { method: 'email', emailHint: to });
  await emailStep(await popupP, to, { prefilled: true });
  expect(await okValue(page, 'second')).toEqual(first);
  expect(starts).toHaveLength(2);
  expect(starts[0]).not.toHaveProperty('deviceTicket');
  expect(starts[1]?.deviceTicket).toMatch(/^dt2\.[A-Za-z0-9_-]{75}$/u);
});

test('a wrong code says so and the right one still works', async ({ page }, info) => {
  const app = await newApp({ loginMethods: 'google,email' });
  await openPartner(page, app);
  const to = address(info, 'wrong');
  const popupP = page.waitForEvent('popup');
  await clickAction(page, 'login', 'loginWith', { method: 'email' });
  const popup = await popupP;
  await popup.waitForURL(/\/login\/email#/u);
  await popup.fill('#email-address', to);
  await popup.click('#email-send');
  const code = await codeFor(to);
  await popup.fill('#email-code', code === '000000' ? '111111' : '000000');
  await popup.click('#email-verify');
  await expect(popup.locator('#email-notice')).toContainText('That code is wrong');
  await popup.fill('#email-code', code);
  const closed = popup.waitForEvent('close', { timeout: 20_000 });
  await popup.click('#email-verify');
  await closed;
  expect((await okValue<{ evm: string }>(page, 'login')).evm).toMatch(/^0x/u);
});

test('Google through the chooser is the Google login, unchanged: the same wallet as on a Google-only app', async ({ page, browser, google }) => {
  const emailApp = await newApp({ loginMethods: 'google,email' });
  await openPartner(page, emailApp);
  const popupP = page.waitForEvent('popup');
  await clickAction(page, 'login', 'login');
  const popup = await popupP;
  await popup.click('#continue-google');
  await chooseAccount(popup);
  const viaChooser = await okValue<{ stellar: string; evm: string }>(page, 'login');
  expect(google.requests).toHaveLength(1);
  expect(google.requests[0]?.ok).toBe(true);

  // A Google-only app on the same scope, same Google account: no chooser, the same path, so the same addresses.
  const other = await browser.newContext();
  try {
    await routeStubs(other, new GoogleStub());
    const page2 = await other.newPage();
    const googleApp = await newApp();
    await openPartner(page2, googleApp);
    expect(await login(page2)).toEqual(viaChooser);
  } finally {
    await other.close();
  }
});
