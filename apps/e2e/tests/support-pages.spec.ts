// The support pages (D866), end to end on the local stack, in every browser: the staff unlock and unsuppress mails,
// their pages on the sign-in site, and the sign-in after. Staff calls and bounces go through the issuer's real staff
// routes and SendGrid webhook (src/server/issuer.ts `/__e2e/staff`, `/__e2e/bounce`).
//
// - Unlock: wrong codes from many requesters reach the address's daily ceiling, so the sign-in window refuses it; staff
//   unlock mails a link; the page does nothing until its button is pressed (the token is useless before); the press;
//   then the sign-in window sends the kept token with `start` and signs in. The browser signed in once before, so it
//   also holds a device ticket and sends both: the unlock decides (the review of PR 88).
// - Confirm: a bounce stops code mail to the address (the window still says a code was sent: start answers alike);
//   staff unsuppress mails a link; the press; codes arrive again and the sign-in works.
//
// With HANA_SHOTS_DIR=<dir> (Chromium) it also saves the pages at phone width (before the press, after it, expired)
// and the two mails, for the founder.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { AUTH_ORIGIN, ISSUER_URL } from '../src/stack.ts';
import { clickAction, clickClosing, clickUntilTaken, closeOf, expect, newApp, okValue, openPartner, test } from './fixtures.ts';

const SHOTS = process.env.HANA_SHOTS_DIR;
const PHONE = { width: 390, height: 844 } as const;

interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
  kind: string;
}

/** An exempt provider's domain (no per-domain cap), a fresh mailbox per test and browser. */
const address = (info: TestInfo, tag: string): string => `e2e${tag}${info.project.name}${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}@gmail.com`;

const outbox = async (to: string): Promise<Mail[]> => (await (await fetch(`${ISSUER_URL}/__e2e/outbox?to=${encodeURIComponent(to)}`)).json()) as Mail[];
const control = async (path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const r = await fetch(`${ISSUER_URL}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(r.status, path).toBe(200);
  return (await r.json()) as Record<string, unknown>;
};

/** The issuer's browser routes, called as the sign-in site would (its Origin), from the test itself. */
const issuer = (path: string, body: unknown): Promise<Response> =>
  fetch(`${ISSUER_URL}/v1/email/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: AUTH_ORIGIN }, body: JSON.stringify(body) });
const commitment = () => ({
  scopeId: 'e2e',
  sessionPublicKey: Array.from(crypto.getRandomValues(new Uint8Array(32))),
  expiresAtMs: Date.now() + 3_600_000,
  keyIndex: 0,
  maxUses: 10,
  salt: Array.from(crypto.getRandomValues(new Uint8Array(16))),
});

/**
 * Wrong codes until the address's daily ceiling is reached (every request comes from another address in this stack,
 * so no requester lock: the mailbox-wide ceiling, the dev envs' 100 checks, D340): after it nobody can get a code.
 */
async function lockOut(pk: string, to: string): Promise<void> {
  const base = (await outbox(to)).filter((m) => m.kind === 'code').length;
  for (let i = 0; i < 40; i++) {
    const s = await issuer('start', { pk, email: to, purpose: 'session', commitment: commitment() });
    if (s.status === 429) return;
    expect(s.status).toBe(202);
    const { challengeId } = (await s.json()) as { challengeId: string };
    await expect.poll(async () => (await outbox(to)).filter((m) => m.kind === 'code').length).toBeGreaterThan(base + i);
    const code = /\b(\d{6})\b/u.exec((await outbox(to)).filter((m) => m.kind === 'code').at(-1)!.text)![1]!;
    for (let k = 0; k < 5; k++) {
      const v = await issuer('verify', { challengeId, code: code === '000000' ? '111111' : '000000' });
      if (v.status === 429) return;
    }
  }
  throw new Error('the address never locked');
}

/** The link in the last mail of `kind` to `to`, and its token (the fragment). */
async function linkIn(to: string, kind: 'unlock' | 'confirm'): Promise<{ url: string; token: string; mail: Mail }> {
  await expect.poll(async () => (await outbox(to)).some((m) => m.kind === kind)).toBe(true);
  const mail = (await outbox(to)).filter((m) => m.kind === kind).at(-1)!;
  const url = new RegExp(`${AUTH_ORIGIN.replace(/[.]/gu, '\\.')}/email/${kind}#[A-Za-z0-9._-]+`, 'u').exec(mail.text)![0];
  return { url, token: new URL(url).hash.slice(1), mail };
}

/** The email sign-in window up to its first answer: the address, then Send code. */
async function openEmail(page: Page, name: string, to: string): Promise<Page> {
  const popupP = page.waitForEvent('popup');
  await clickAction(page, name, 'loginWith', { method: 'email' });
  const popup = await popupP;
  await popup.waitForURL(/\/login\/email#/u);
  await popup.fill('#email-address', to);
  await clickUntilTaken(popup, '#email-send');
  return popup;
}

async function codeStep(popup: Page, to: string, before: number): Promise<void> {
  await expect(popup.locator('#email-code')).toBeVisible();
  await expect.poll(async () => (await outbox(to)).filter((m) => m.kind === 'code').length, { timeout: 10_000 }).toBeGreaterThan(before);
  const code = /\b(\d{6})\b/u.exec((await outbox(to)).filter((m) => m.kind === 'code').at(-1)!.text)![1]!;
  await popup.fill('#email-code', code);
  await clickClosing(popup, '#email-verify');
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  // The window's rise (320 ms) has ended.
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

/** A mail's designed part, rendered at phone width, as a mail app would show it. */
async function mailShot(page: Page, mail: Mail, name: string): Promise<void> {
  if (!SHOTS) return;
  const p = await page.context().newPage();
  await p.setViewportSize(PHONE);
  await p.setContent(mail.html);
  await shot(p, name);
  await p.close();
}

const shoot = (info: TestInfo): boolean => !!SHOTS && info.project.name === 'chromium';

test('unlock: a locked address, the staff mail, the page’s one button, and the sign-in works again', async ({ page }, info) => {
  test.setTimeout(120_000);
  const app = await newApp({ loginMethods: 'google,email' });
  await openPartner(page, app);
  const to = address(info, 'unlock');
  // The common case (review of PR 88): this browser signed in with the address before, so it holds a device ticket.
  const first = await openEmail(page, 'first', to);
  await codeStep(first, to, 0);
  await okValue(page, 'first');
  await page.evaluate(() => (window as any).e2e.run('logout', 'logout'));
  await okValue(page, 'logout');
  await lockOut(app.pk, to);

  // The ticket still lets this browser get a code; the owner's own wrong codes use its slot up, then the window
  // refuses the address.
  const locked = await openEmail(page, 'locked', to);
  await expect(locked.locator('#email-code')).toBeVisible();
  const code = /\b(\d{6})\b/u.exec((await outbox(to)).filter((m) => m.kind === 'code').at(-1)!.text)![1]!;
  let refused = false;
  for (let i = 0; i < 6 && !refused; i++) {
    await locked.fill('#email-code', code === '000000' ? '111111' : '000000');
    const answer = locked.waitForResponse((r) => r.url() === `${ISSUER_URL}/v1/email/verify`);
    await locked.click('#email-verify');
    refused = (await answer).status() === 429;
  }
  expect(refused).toBe(true);
  await expect(locked.locator('#app')).toContainText('Too many attempts. Try again later.');
  await locked.close();
  await closeOf(locked);
  // A new attempt with the ticket is refused too.
  const again = await openEmail(page, 'again', to);
  await expect(again.locator('#app')).toContainText('Too many attempts. Try again later.');
  await again.close();
  await closeOf(again);

  // Staff: the unlock mail goes to the address itself; staff get a plain note, never the token.
  const staff = await control('/__e2e/staff', { action: 'unlock', email: to, ticket: 'E2E-UNLOCK' });
  expect(staff.mailed).toBe(true);
  expect(staff.note).toContain('press “Unlock my email”');
  const { url, token, mail } = await linkIn(to, 'unlock');
  expect(JSON.stringify(staff)).not.toContain(token);

  // The page: one button, and nothing happens on load (the token can't be used before the press).
  const support = await page.context().newPage();
  const pressed: string[] = [];
  support.on('request', (r) => {
    if (r.method() !== 'GET') pressed.push(`${r.method()} ${r.url()}`);
  });
  if (shoot(info)) await support.setViewportSize(PHONE);
  await support.goto(url);
  await expect(support.locator('h1')).toHaveText('Unlock sign-in with your email');
  // The token left the address bar at once.
  expect(new URL(support.url()).hash).toBe('');
  await expect(support.locator('button')).toHaveCount(1);
  await expect(support.locator('#support-press')).toHaveText('Unlock my email');
  expect(pressed).toEqual([]);
  expect((await issuer('start', { pk: app.pk, email: to, purpose: 'session', commitment: commitment(), unlockToken: token })).status).toBe(429);
  await shot(support, 'unlock-1-before');

  // The press (a double click is one request).
  await support.dblclick('#support-press');
  await expect(support.locator('.support-done')).toContainText('Your email is unlocked. You can sign in again.');
  await expect(support.locator('.support-email')).toHaveText(`Email: ${to}`);
  await expect(support.locator('button')).toHaveCount(0);
  expect(pressed).toEqual([`POST ${ISSUER_URL}/v1/email/unlock`]);
  await shot(support, 'unlock-2-done');

  // Back in the app: the sign-in window sends the kept unlock and signs in.
  const starts: Record<string, unknown>[] = [];
  page.context().on('request', (r) => {
    if (r.url() === `${ISSUER_URL}/v1/email/start` && r.method() === 'POST') starts.push(JSON.parse(r.postData() ?? '{}') as Record<string, unknown>);
  });
  const before = (await outbox(to)).filter((m) => m.kind === 'code').length;
  const popup = await openEmail(page, 'after', to);
  await codeStep(popup, to, before);
  expect((await okValue<{ evm: string }>(page, 'after')).evm).toMatch(/^0x[0-9a-fA-F]{40}$/u);
  // The window sent both the device ticket and the unlock; the unlock decided.
  expect(starts.at(-1)?.unlockToken).toBe(token);
  expect(starts.at(-1)?.deviceTicket).toMatch(/^dt2\./u);
  // Used: the link says so, and the kept token is gone from the browser.
  // Opened again from the email (a new load: the page itself has dropped the token from its address).
  await support.goto('about:blank');
  await support.goto(url);
  await support.click('#support-press');
  await expect(support.locator('.support-used')).toContainText('This link was already used to sign in.');
  expect(await support.evaluate(() => localStorage.getItem('hana.ug'))).toBeNull();
  await mailShot(page, mail, 'unlock-mail');

  if (shoot(info)) {
    // The expired screen, as the page shows the issuer's answer for a link past its 24 hours.
    const old = await page.context().newPage();
    await old.setViewportSize(PHONE);
    await old.route(`${ISSUER_URL}/v1/email/unlock`, (r) =>
      r.fulfill({ status: 410, contentType: 'application/json', headers: { 'access-control-allow-origin': AUTH_ORIGIN }, body: JSON.stringify({ code: 'link_expired', error: 'The link expired' }) }),
    );
    await old.goto(url);
    await old.click('#support-press');
    await expect(old.locator('.support-expired')).toBeVisible();
    await shot(old, 'unlock-3-expired');
  }
});

test('confirm: a bounced address gets no codes; the staff mail, the page’s one button, and codes arrive again', async ({ page }, info) => {
  test.setTimeout(120_000);
  const app = await newApp({ loginMethods: 'google,email' });
  await openPartner(page, app);
  const to = address(info, 'confirm');
  await control('/__e2e/bounce', { email: to });

  // The window can't tell (start answers alike for every address), but no code is sent.
  const quiet = await openEmail(page, 'quiet', to);
  await expect(quiet.locator('#email-code')).toBeVisible();
  await quiet.waitForTimeout(1500);
  expect((await outbox(to)).filter((m) => m.kind === 'code')).toHaveLength(0);
  await quiet.close();
  await closeOf(quiet);

  const staff = await control('/__e2e/staff', { action: 'unsuppress', email: to, ticket: 'E2E-CONFIRM' });
  expect(staff.mailed).toBe(true);
  expect(staff.note).toContain('press “Yes, this is my email”');
  const { url, mail } = await linkIn(to, 'confirm');

  const support = await page.context().newPage();
  const pressed: string[] = [];
  support.on('request', (r) => {
    if (r.method() !== 'GET') pressed.push(`${r.method()} ${r.url()}`);
  });
  if (shoot(info)) await support.setViewportSize(PHONE);
  await support.goto(url);
  await expect(support.locator('h1')).toHaveText('Confirm your email');
  await expect(support.locator('#support-press')).toHaveText('Yes, this is my email');
  // Nothing on load: still no code.
  const still = await openEmail(page, 'still', to);
  await expect(still.locator('#email-code')).toBeVisible();
  await still.waitForTimeout(1000);
  expect((await outbox(to)).filter((m) => m.kind === 'code')).toHaveLength(0);
  await still.close();
  await closeOf(still);
  expect(pressed).toEqual([]);
  await shot(support, 'confirm-1-before');

  await support.dblclick('#support-press');
  await expect(support.locator('.support-done')).toContainText('Thanks: this email is confirmed. We’ll send sign-in codes to it again.');
  await expect(support.locator('.support-email')).toHaveText(`Email: ${to}`);
  expect(pressed).toEqual([`POST ${ISSUER_URL}/v1/email/confirm`]);
  await shot(support, 'confirm-2-done');

  const popup = await openEmail(page, 'after', to);
  await codeStep(popup, to, 0);
  expect((await okValue<{ evm: string }>(page, 'after')).evm).toMatch(/^0x[0-9a-fA-F]{40}$/u);
  // Opened again from the email (a new load: the page itself has dropped the token from its address).
  await support.goto('about:blank');
  await support.goto(url);
  await support.click('#support-press');
  await expect(support.locator('.support-used')).toContainText('This link was already used');
  await mailShot(page, mail, 'confirm-mail');

  if (shoot(info)) {
    const old = await page.context().newPage();
    await old.setViewportSize(PHONE);
    await old.route(`${ISSUER_URL}/v1/email/confirm`, (r) =>
      r.fulfill({ status: 410, contentType: 'application/json', headers: { 'access-control-allow-origin': AUTH_ORIGIN }, body: JSON.stringify({ code: 'link_expired', error: 'The link expired' }) }),
    );
    await old.goto(url);
    await old.click('#support-press');
    await expect(old.locator('.support-expired')).toBeVisible();
    await shot(old, 'confirm-3-expired');
  }
});

test('a link with no token, or another page’s, is not valid at once and sends nothing', async ({ page }) => {
  const sent: string[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'GET') sent.push(r.url());
  });
  for (const u of [`${AUTH_ORIGIN}/email/unlock`, `${AUTH_ORIGIN}/email/confirm#ug1.${'A'.repeat(43)}`, `${AUTH_ORIGIN}/email/unlock#<img src=x>`]) {
    await page.goto(u);
    await expect(page.locator('.support-invalid')).toContainText('This link isn’t valid.');
    await expect(page.locator('img')).toHaveCount(0);
  }
  expect(sent).toEqual([]);
});
