// The shared-wallet line (D912) in the real windows, on the local stack: apps on one scope share one wallet, so the
// sign-in window and the approval window of each say "This wallet is also used on N other apps." under who is asking,
// with the other apps' names behind "See which" (from Journear's own GET /v1/app, the vault's read only). Counted: the
// scope's other apps that are not suspended and have a web address in force. The partner page never learns any of it:
// not from its own GET /v1/app, not from anything the vault or the windows post to it. An app alone sees no change.
//
// With HANA_SHOTS_DIR=<dir> (Chromium) the last test saves both windows at 390 and 1280 px, light and dark, named
// `<label>-<window>-<width>-<scheme>.png` with HANA_SHOTS_LABEL as the label ("after" by default; "before" is the same
// test run on a build without the line, where it saves the same screens and checks nothing about the line), and with
// the names open (`after-<window>-open-…`).
import type { Page } from '@playwright/test';
import { API_URL, PARTNER_ORIGIN } from '../src/stack.ts';
import { chooseAccount, clickAction, clickLauncher, expect, fontsLoaded, newApp, okValue, openPartner, reject, runAction, settled, test } from './fixtures.ts';

const SHOTS = process.env.HANA_SHOTS_DIR;
const LABEL = process.env.HANA_SHOTS_LABEL ?? 'after';
const BEFORE = LABEL === 'before';

/** A scope of its own for this test (scope ids are lowercase letters and digits). */
const freshScope = (): string => `sw${Math.random().toString(36).slice(2, 12)}`;

/**
 * Records, on the partner page only, every message it receives: on its window and on every MessagePort (the SDK's
 * channel to the vault), as JSON. Installed before the page's own scripts.
 */
async function recordPartnerMessages(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (window.top !== window) return;
    const seen: string[] = [];
    (window as unknown as { __seen: string[] }).__seen = seen;
    const record = (data: unknown): void => {
      try {
        seen.push(JSON.stringify(data, (_k, v: unknown) => (v instanceof Uint8Array ? Array.from(v) : v)));
      } catch {
        seen.push(String(data));
      }
    };
    window.addEventListener('message', (e) => record(e.data), true);
    const proto = MessagePort.prototype;
    const onmessage = Object.getOwnPropertyDescriptor(proto, 'onmessage')!;
    Object.defineProperty(proto, 'onmessage', {
      configurable: true,
      get(this: MessagePort) {
        return onmessage.get!.call(this);
      },
      set(this: MessagePort, fn: ((e: MessageEvent) => unknown) | null) {
        onmessage.set!.call(this, fn ? (e: MessageEvent) => (record(e.data), fn.call(this, e)) : null);
      },
    });
    const add = proto.addEventListener;
    proto.addEventListener = function (this: MessagePort, type: string, fn: EventListenerOrEventListenerObject, o?: boolean | AddEventListenerOptions) {
      if (type === 'message') add.call(this, type, (e: Event) => record((e as MessageEvent).data), o);
      return add.call(this, type, fn, o);
    } as typeof proto.addEventListener;
  });
}

const partnerSaw = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { __seen: string[] }).__seen);

/** The sign-in window's chooser for the partner page's login (an app with email sign-in, so the chooser shows). */
async function signInWindow(page: Page): Promise<Page> {
  const popupP = page.waitForEvent('popup');
  await clickAction(page, 'login', 'login');
  const popup = await popupP;
  await expect(popup.locator('#continue-google')).toBeVisible();
  return popup;
}

/** Signs in with Google from the chooser on screen. */
async function finishSignIn(page: Page, popup: Page): Promise<void> {
  await popup.click('#continue-google');
  await chooseAccount(popup);
  await okValue(page, 'login');
}

/** The approval window for a message the partner asks to sign. */
async function approvalWindow(page: Page, name = 'sig'): Promise<Page> {
  await runAction(page, name, 'personalSign', 'Hello from the shared wallet test');
  const popup = await clickLauncher(page, 'Review in Journear Passport');
  await expect(popup.locator('header.app')).toBeVisible();
  return popup;
}

const summary = (popup: Page) => popup.locator('#shared-wallet > summary');

test('two apps on one scope: both windows say the wallet is also used on the other; suspended and address-less apps don’t count', async ({ page }) => {
  const scope = freshScope();
  const me = await newApp({ scopeId: scope, name: 'Coffee Club', loginMethods: 'google,email' });
  await newApp({ scopeId: scope, name: 'Stamp Trail', origins: ['https://stamps.e2e-shared.test'] });
  await newApp({ scopeId: scope, name: 'Closed Shop', origins: ['https://closed.e2e-shared.test'], status: 'suspended' });
  await newApp({ scopeId: scope, name: 'Not Yet Open', origins: [] });
  await openPartner(page, me);

  // The sign-in window: the line right under who is asking, before the buttons.
  const signIn = await signInWindow(page);
  await expect(signIn.locator('p.asker')).toContainText('Signing in to Coffee Club at');
  await expect(summary(signIn)).toHaveText('This wallet is also used on 1 other app. See which');
  expect(await signIn.locator('p.asker + #shared-wallet + .providers').count()).toBe(1);
  // The names are folded until asked for.
  await expect(signIn.locator('.shared-wallet-apps')).toBeHidden();
  await summary(signIn).click();
  await expect(signIn.locator('.shared-wallet-apps li')).toHaveText(['Stamp Trail']);
  await expect(signIn.locator('.shared-wallet-note')).toHaveText('Any of them can ask you to approve payments from this wallet, so check who is asking each time.');
  await expect(signIn.locator('body')).not.toContainText('Closed Shop');
  await expect(signIn.locator('body')).not.toContainText('Not Yet Open');
  await finishSignIn(page, signIn);

  // The approval window: with "From {App}", right under its box, before the account line; the same sentence.
  const approval = await approvalWindow(page);
  await expect(approval.locator('header.app p').first()).toHaveText('From Coffee Club');
  expect(await approval.locator('header.app + #shared-wallet + p.account').count()).toBe(1);
  await expect(summary(approval)).toHaveText('This wallet is also used on 1 other app. See which');
  expect(await approval.locator('header.app #shared-wallet, .partner-labels #shared-wallet').count()).toBe(0);
  await summary(approval).click();
  await expect(approval.locator('.shared-wallet-apps li')).toHaveText(['Stamp Trail']);
  await reject(approval);
  expect((await settled(page, 'sig')).state).toBe('error');
});

test('the partner page never learns which other apps share the wallet: not from GET /v1/app, not from any message', async ({ page }) => {
  const scope = freshScope();
  const me = await newApp({ scopeId: scope, name: 'Coffee Club', loginMethods: 'google,email' });
  const secret = `Hidden Partner ${Math.random().toString(36).slice(2, 8)}`;
  await newApp({ scopeId: scope, name: secret, origins: ['https://hidden.e2e-shared.test'] });
  await recordPartnerMessages(page);
  await openPartner(page, me);

  // Its own read of the app's config (the partner page may call GET /v1/app): no field, no name.
  const own = await page.evaluate(
    async ({ api, pk }) => {
      const res = await fetch(`${api}/v1/app`, { headers: { 'x-hana-key': pk } });
      return { status: res.status, text: await res.text() };
    },
    { api: API_URL, pk: me.pk },
  );
  expect(own.status).toBe(200);
  expect(own.text).not.toContain('otherApps');
  expect(own.text).not.toContain(secret);

  // The windows show it (so it was there to leak)...
  const signIn = await signInWindow(page);
  await summary(signIn).click();
  await expect(signIn.locator('.shared-wallet-apps li')).toHaveText([secret]);
  await finishSignIn(page, signIn);
  const approval = await approvalWindow(page);
  await summary(approval).click();
  await expect(approval.locator('.shared-wallet-apps li')).toHaveText([secret]);
  await reject(approval);
  await settled(page, 'sig');

  // ...and nothing the partner page received, on its window or its port to the vault, carries it.
  const seen = await partnerSaw(page);
  // The recorder works: the vault's events reached it (its `ready`, the login's answer).
  expect(seen.some((m) => m.includes('"ready"'))).toBe(true);
  expect(seen.length).toBeGreaterThan(3);
  for (const m of seen) {
    expect(m).not.toContain(secret);
    expect(m).not.toContain('otherApps');
    expect(m).not.toContain('also used on');
  }
  // Nor its own page.
  await expect(page.locator('body')).not.toContainText(secret);
});

test('an app alone on its scope: no line in either window, the screens as before', async ({ page }) => {
  const me = await newApp({ scopeId: freshScope(), name: 'Coffee Club', loginMethods: 'google,email' });
  // Another scope's app never counts.
  await newApp({ scopeId: freshScope(), name: 'Stamp Trail', origins: ['https://stamps.e2e-shared.test'] });
  await openPartner(page, me);
  const signIn = await signInWindow(page);
  expect(await signIn.locator('.shared-wallet').count()).toBe(0);
  await expect(signIn.locator('body')).not.toContainText('also used');
  // Who is asking, then the buttons, as before.
  expect(await signIn.locator('section.panel > *').evaluateAll((els) => els.map((e) => `${e.tagName}${e.className ? `.${e.className}` : ''}`))).toEqual(['H1', 'P.asker', 'DIV.providers']);
  await finishSignIn(page, signIn);
  const approval = await approvalWindow(page);
  expect(await approval.locator('.shared-wallet').count()).toBe(0);
  await expect(approval.locator('body')).not.toContainText('also used');
  expect(await approval.locator('header.app + p.account').count()).toBe(1);
  await reject(approval);
});

// ---- the Tech Lead's screenshots ----

const SIZES = [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
] as const;

async function shots(popup: Page, name: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await popup.emulateMedia({ colorScheme: scheme });
    for (const size of SIZES) {
      await popup.setViewportSize(size);
      await fontsLoaded(popup);
      await popup.screenshot({ path: `${SHOTS}/${name}-${size.width}-${scheme}.png`, fullPage: true, animations: 'disabled' });
    }
  }
  await popup.emulateMedia({ colorScheme: 'light' });
}

test('the screenshots (HANA_SHOTS_DIR, Chromium)', async ({ page, browserName }) => {
  test.skip(!SHOTS || browserName !== 'chromium', 'HANA_SHOTS_DIR, Chromium only');
  test.setTimeout(180_000);
  const scope = freshScope();
  const me = await newApp({ scopeId: scope, name: 'Coffee Club', loginMethods: 'google,email' });
  for (const [name, host] of [
    ['Stamp Trail', 'stamps'],
    ['Kite Pay', 'kite'],
  ] as const)
    await newApp({ scopeId: scope, name, origins: [`https://${host}.e2e-shared.test`] });
  await openPartner(page, me);
  expect(PARTNER_ORIGIN).toMatch(/^http:\/\/localhost:/u);

  const signIn = await signInWindow(page);
  await shots(signIn, `${LABEL}-sign-in`);
  if (!BEFORE) {
    await expect(summary(signIn)).toHaveText('This wallet is also used on 2 other apps. See which');
    await summary(signIn).click();
    await shots(signIn, `${LABEL}-sign-in-open`);
  }
  await finishSignIn(page, signIn);

  const approval = await approvalWindow(page);
  await shots(approval, `${LABEL}-approval`);
  if (!BEFORE) {
    await summary(approval).click();
    await shots(approval, `${LABEL}-approval-open`);
  }
  await reject(approval);
});
