// The shared-wallet line (D912) in the real windows, on the local stack: apps on one scope share one wallet, so the
// sign-in window and the approval window of each say "This wallet is also used on N other apps." under who is asking,
// with the other apps' names (quoted, as their own words) behind "See which" (from Journear's own GET /v1/app, the
// vault's read only). Counted: the scope's other apps that are not suspended, have had a sign-in (`launched` here: the
// stack's mocked /v1/login doesn't record one) and have a web address in force. The partner page never learns any of
// it: not from its own GET /v1/app, not from anything the vault or the windows post to it (the approval and consent
// windows and a rejected request's error included). An app alone sees no change. When the vault's reads are refused
// (PR 141's review: a page using up GET /v1/app), a new tab uses the answer the vault origin kept, and with nothing kept
// the windows say "This wallet may also be used on other apps." (the stack doesn't enforce rate limits, so the refusal
// is routed in the browser; the per-IP windows themselves are tested in apps/api).
//
// With HANA_SHOTS_DIR=<dir> (Chromium) the last test saves both windows at 390 and 1280 px, light and dark, named
// `<label>-<window>-<width>-<scheme>.png` with HANA_SHOTS_LABEL as the label ("after" by default; "before" is the same
// test run on a build without the line, where it saves the same screens and checks nothing about the line), and with
// the names open (`after-<window>-open-…`).
import type { BrowserContext, Page } from '@playwright/test';
import { API_URL, PARTNER_ORIGIN, VAULT_ORIGIN } from '../src/stack.ts';
import { chooseAccount, clickAction, clickLauncher, expect, fontsLoaded, newApp, okValue, openPartner, reject, runAction, settled, test, vaultFrame } from './fixtures.ts';

const SHOTS = process.env.HANA_SHOTS_DIR;

/** A policy for the consent window (any valid one: the window is what matters here). */
const POLICY = {
  v: 1,
  label: 'Deposits',
  maxConsentMs: 3_600_000,
  limits: { perDayCount: 3 },
  evm: {
    chains: [
      {
        chainId: 8453,
        maxValueWei: '1000',
        maxValueWeiPerDay: '3000',
        maxFeeWei: '1000',
        contracts: [{ address: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD', name: 'Example vault', selectors: [{ selector: '0xb6b55f25', signature: 'deposit(uint256)', addressArgs: 'self-or-listed' }] }],
      },
    ],
  },
};
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

/**
 * Each listed name's quotation marks hug it (PR 141's screenshots showed “ Stamp Trail ” with gaps): the list item holds
 * only the name's box, the box one text node, and both marks are drawn inside the box (inside one of its line fragments
 * when a long name wraps), never outside its border with the box's padding between them and the name.
 */
async function marksHugNames(popup: Page): Promise<void> {
  const off = await popup.evaluate(() => {
    const out: string[] = [];
    const boxes = [...document.querySelectorAll('.shared-wallet-apps li:not(.shared-wallet-more)')].map((li) => {
      if (li.childNodes.length !== 1) out.push(`item not the box alone: ${li.textContent}`);
      return li.firstElementChild;
    });
    if (boxes.length === 0) out.push('no names');
    for (const box of boxes) {
      const text = box?.firstChild;
      if (!box || !box.classList.contains('partner-words') || box.childNodes.length !== 1 || !(text instanceof Text)) {
        out.push(`box not one text node: ${box?.textContent}`);
        continue;
      }
      const frags = [...box.getClientRects()];
      for (const [at, mark] of [
        [0, '“'],
        [text.data.length - 1, '”'],
      ] as const) {
        if (text.data[at] !== mark) out.push(`${mark} missing: ${text.data}`);
        const range = document.createRange();
        range.setStart(text, at);
        range.setEnd(text, at + 1);
        const g = range.getBoundingClientRect();
        const inside = frags.some((f) => g.left >= f.left - 1 && g.right <= f.right + 1 && g.top >= f.top - 1 && g.bottom <= f.bottom + 1);
        if (!inside) out.push(`${mark} outside the box: ${text.data}`);
      }
    }
    return out;
  });
  expect(off).toEqual([]);
}

test('two apps on one scope: both windows say the wallet is also used on the other; suspended, address-less and never-signed-in apps don’t count', async ({ page }) => {
  const scope = freshScope();
  const me = await newApp({ scopeId: scope, name: 'Coffee Club', loginMethods: 'google,email' });
  await newApp({ scopeId: scope, name: 'Stamp Trail', origins: ['https://stamps.e2e-shared.test'], launched: true });
  await newApp({ scopeId: scope, name: 'Closed Shop', origins: ['https://closed.e2e-shared.test'], status: 'suspended', launched: true });
  await newApp({ scopeId: scope, name: 'Not Yet Open', origins: [], launched: true });
  await newApp({ scopeId: scope, name: 'Unreleased Beta', origins: ['https://beta.e2e-shared.test'] });
  await openPartner(page, me);

  // The sign-in window: the line right under who is asking, before the buttons.
  const signIn = await signInWindow(page);
  await expect(signIn.locator('p.asker')).toContainText('Signing in to Coffee Club at');
  await expect(summary(signIn)).toHaveText('This wallet is also used on 1 other app. See which');
  expect(await signIn.locator('p.asker + #shared-wallet + .providers').count()).toBe(1);
  // The names are folded until asked for.
  await expect(signIn.locator('.shared-wallet-apps')).toBeHidden();
  await summary(signIn).click();
  await expect(signIn.locator('.shared-wallet-apps li')).toHaveText(['“Stamp Trail”']);
  await expect(signIn.locator('.shared-wallet-apps li .partner-words')).toHaveText(['“Stamp Trail”']);
  await marksHugNames(signIn);
  await expect(signIn.locator('.shared-wallet-note')).toHaveText('Any of them can ask you to approve payments from this wallet, so check who is asking each time.');
  await expect(signIn.locator('body')).not.toContainText('Closed Shop');
  await expect(signIn.locator('body')).not.toContainText('Not Yet Open');
  await expect(signIn.locator('body')).not.toContainText('Unreleased Beta');
  await finishSignIn(page, signIn);

  // The approval window: with "From {App}", right under its box, before the account line; the same sentence.
  const approval = await approvalWindow(page);
  await expect(approval.locator('header.app p').first()).toHaveText('From Coffee Club');
  expect(await approval.locator('header.app + #shared-wallet + p.account').count()).toBe(1);
  await expect(summary(approval)).toHaveText('This wallet is also used on 1 other app. See which');
  expect(await approval.locator('header.app #shared-wallet, .partner-labels #shared-wallet').count()).toBe(0);
  await summary(approval).click();
  await expect(approval.locator('.shared-wallet-apps li')).toHaveText(['“Stamp Trail”']);
  await marksHugNames(approval);
  await reject(approval);
  expect((await settled(page, 'sig')).state).toBe('error');
});

test('the partner page never learns which other apps share the wallet: not from GET /v1/app, not from any message', async ({ page }) => {
  const scope = freshScope();
  const me = await newApp({ scopeId: scope, name: 'Coffee Club', loginMethods: 'google,email', settings: { autoApprovePolicy: POLICY } });
  const secret = `Hidden Partner ${Math.random().toString(36).slice(2, 8)}`;
  await newApp({ scopeId: scope, name: secret, origins: ['https://hidden.e2e-shared.test'], launched: true });
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
  await expect(signIn.locator('.shared-wallet-apps li .partner-words')).toHaveText([`“${secret}”`]);
  await finishSignIn(page, signIn);
  const approval = await approvalWindow(page);
  await summary(approval).click();
  await expect(approval.locator('.shared-wallet-apps li .partner-words')).toHaveText([`“${secret}”`]);
  // Reject: the partner page gets the request's error (4001) on its port.
  await reject(approval);
  expect((await settled(page, 'sig')).state).toBe('error');
  // The consent window for automatic approvals shows it too (in the same window, still open after the answer); declined.
  await runAction(page, 'consent', 'requestAutoApprove');
  const consent = approval;
  await expect(consent.getByRole('heading', { name: 'Allow automatic approvals?' })).toBeVisible();
  await summary(consent).click();
  await expect(consent.locator('.shared-wallet-apps li .partner-words')).toHaveText([`“${secret}”`]);
  await consent.getByRole('button', { name: 'Don’t allow' }).click();
  await settled(page, 'consent');

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
  await newApp({ scopeId: freshScope(), name: 'Stamp Trail', origins: ['https://stamps.e2e-shared.test'], launched: true });
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

/** Refuses every GET /v1/app the vault makes in this browser context (429), as if a partner page had used them up. */
async function refuseVaultReads(context: BrowserContext): Promise<void> {
  await context.route(`${API_URL}/v1/app**`, (route) =>
    route.request().headers()['origin'] === VAULT_ORIGIN
      ? route.fulfill({ status: 429, headers: { 'access-control-allow-origin': VAULT_ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ error: 'Rate limit exceeded', code: 'rate_limited', requestId: 'rq_e2e' }) })
      : route.continue(),
  );
}

test('PR 141’s review: with the vault’s reads refused, a new tab uses the kept answer; with nothing kept, the “may” line', async ({ page, context }) => {
  const scope = freshScope();
  const me = await newApp({ scopeId: scope, name: 'Coffee Club', loginMethods: 'google,email' });
  await newApp({ scopeId: scope, name: 'Stamp Trail', origins: ['https://stamps.e2e-shared.test'], launched: true });
  await openPartner(page, me);
  const signIn = await signInWindow(page);
  await finishSignIn(page, signIn);

  // Every read of the vault's from now on is refused.
  await refuseVaultReads(context);
  // A new tab of the same browser: its vault unlocks from storage and knows the line from the answer it kept.
  const tab2 = await context.newPage();
  await openPartner(tab2, me);
  const kept = await approvalWindow(tab2, 'kept');
  await expect(summary(kept)).toHaveText('This wallet is also used on 1 other app. See which');
  await summary(kept).click();
  await expect(kept.locator('.shared-wallet-apps li .partner-words')).toHaveText(['“Stamp Trail”']);
  await reject(kept);
  await settled(tab2, 'kept');

  // Nothing kept (the vault origin's storage cleared) and still refused: the windows say the wallet may be shared.
  await vaultFrame(tab2).evaluate(() => localStorage.clear());
  const tab3 = await context.newPage();
  await openPartner(tab3, me);
  const unknown = await approvalWindow(tab3, 'unknown');
  await expect(unknown.locator('header.app + p#shared-wallet.shared-wallet-unknown')).toHaveText('This wallet may also be used on other apps.');
  if (SHOTS && test.info().project.name === 'chromium') await shots(unknown, `${LABEL}-approval-unknown`);
  await reject(unknown);
  await settled(tab3, 'unknown');
});

test('long, right-to-left and mixed-script names: the quotation marks stay inside each name’s box, wrapped or not, at 390 and 1280 px', async ({ page }) => {
  const scope = freshScope();
  const me = await newApp({ scopeId: scope, name: 'Coffee Club', loginMethods: 'google,email' });
  const names = [
    // Longer than the window shows (cut to 60 characters and "…"), and wider than the list at 390 px: it wraps.
    'The Extraordinarily Long Named Neighbourhood Loyalty Rewards Programme For Testing',
    'مقهى النجمة',
    'Café 東京 Pay مقهى',
  ];
  for (const [i, name] of names.entries()) await newApp({ scopeId: scope, name, origins: [`https://n${i}.e2e-shared.test`], launched: true });
  await openPartner(page, me);
  const signIn = await signInWindow(page);
  await summary(signIn).click();
  await expect(signIn.locator('.shared-wallet-apps li')).toHaveCount(3);
  for (const size of SIZES) {
    await signIn.setViewportSize(size);
    await marksHugNames(signIn);
  }
  // The long name does wrap at 390 px (so the check above covered a wrapped box).
  await signIn.setViewportSize(SIZES[0]);
  const lines = await signIn.locator('.shared-wallet-apps .partner-words', { hasText: 'Extraordinarily' }).evaluate((el) => el.getClientRects().length);
  expect(lines).toBeGreaterThan(1);
  if (SHOTS && test.info().project.name === 'chromium') await shots(signIn, `${LABEL}-sign-in-long-names-open`);
  await finishSignIn(page, signIn);
  const approval = await approvalWindow(page);
  await summary(approval).click();
  for (const size of SIZES) {
    await approval.setViewportSize(size);
    await marksHugNames(approval);
  }
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

test('the screenshots (HANA_SHOTS_DIR, Chromium)', async ({ page, browser, browserName }) => {
  test.skip(!SHOTS || browserName !== 'chromium', 'HANA_SHOTS_DIR, Chromium only');
  test.setTimeout(180_000);
  const scope = freshScope();
  const me = await newApp({ scopeId: scope, name: 'Coffee Club', loginMethods: 'google,email' });
  for (const [name, host] of [
    ['Stamp Trail', 'stamps'],
    ['Kite Pay', 'kite'],
  ] as const)
    await newApp({ scopeId: scope, name, origins: [`https://${host}.e2e-shared.test`], launched: true });
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

  if (BEFORE) return;
  // The sign-in window's “may” line: a browser whose vault reads come back without the field (no answer) and keeps none.
  const other = await browser.newContext();
  try {
    await other.route(`${API_URL}/v1/app**`, async (route) => {
      if (route.request().headers()['origin'] !== VAULT_ORIGIN) return route.continue();
      const res = await route.fetch();
      const body = (await res.json()) as Record<string, unknown>;
      delete body.otherApps;
      return route.fulfill({ response: res, json: body });
    });
    const p2 = await other.newPage();
    await openPartner(p2, me);
    const unknownSignIn = await signInWindow(p2);
    await expect(unknownSignIn.locator('p.asker + p#shared-wallet.shared-wallet-unknown')).toHaveText('This wallet may also be used on other apps.');
    await shots(unknownSignIn, `${LABEL}-sign-in-unknown`);
    await unknownSignIn.close();
  } finally {
    await other.close();
  }
});
