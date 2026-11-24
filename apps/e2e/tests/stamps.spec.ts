// The stamps site (apps/stamps, D798–D802): its built page, served by its own Worker handler with its real CSP and
// headers, signs in by email through the vault, collects Arrival, Sponsored, Postcard and Signature (each approved in
// the Journear Passport window, each a NEAR call the mocked relayer delivers to the stamps contract on the mocked
// testnet, which verifies the signature stamp's NEP-413 proof with ed25519 as the contract does), then shows them on
// the public passport. Nothing of another chain is ever on the page. The page is configured at build time like the
// deployed one (src/build.ts STAMPS_CONFIG), so its app has a fixed key (STAMPS_PK).
import { type Page, type TestInfo } from '@playwright/test';
import { REVIEWED_STAMP_TITLES, type ReviewedStampId } from '@hana-id/core';
import { routeNearRelayer } from '../src/near-relay.ts';
import { E2E_STAMPS, ISSUER_URL, NEAR_RPC, NEAR_RPC_FALLBACK, STAMPS_ORIGIN, VAULT_ORIGIN } from '../src/stack.ts';
import { expectPlainWindow } from './plain-checks.ts';
import { DEMO_APP, STAMPS_APP, approve, clickClosing, clickUntilTaken, expect, newApp, test } from './fixtures.ts';

/** Records every CSP violation on the site's own document (the page CSP must allow everything the page does). */
async function recordCspViolations(page: Page): Promise<void> {
  await page.addInitScript((origin) => {
    if (location.origin !== origin) return;
    const seen: string[] = [];
    (window as any).__cspViolations = seen;
    document.addEventListener('securitypolicyviolation', (e) => seen.push(`${e.effectiveDirective} ${e.blockedURI}`));
  }, STAMPS_ORIGIN);
}

const cspViolations = (page: Page): Promise<string[]> => page.evaluate(() => (window as any).__cspViolations as string[]);

/**
 * Records every status the Signature slot shows and every notice text (D807), so a test can say the SDK's launcher
 * fallback was never needed: the slot never asked for a click to continue and no notice pointed at the launcher.
 */
async function recordSlotStates(page: Page): Promise<void> {
  await page.addInitScript((origin) => {
    if (location.origin !== origin) return;
    const seen: string[] = [];
    (window as any).__seen = seen;
    const note = () => {
      const sig = document.querySelector('[data-stamp="signature"]');
      if (sig) seen.push(`signature:${sig.getAttribute('data-status')}`);
      const n = document.querySelector('[data-role="notice"]');
      if (n && !n.hasAttribute('hidden')) seen.push(`notice:${n.textContent ?? ''}`);
    };
    new MutationObserver(note).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  }, STAMPS_ORIGIN);
}

const seenStates = (page: Page): Promise<string[]> => page.evaluate(() => (window as any).__seen as string[]);

/** Signs in by email on the stamps page (the window opens from the click) and returns the account. */
async function signIn(page: Page, info: TestInfo): Promise<string> {
  const loginP = page.waitForEvent('popup');
  await page.locator('[data-action="sign-in"]').click();
  await emailLogin(await loginP, address(info));
  await expect(page.locator('[data-mode="mine"]')).toBeVisible();
  const share = (await page.locator('[data-role="share"]').getAttribute('href')) ?? '';
  return share.slice(`${STAMPS_ORIGIN}/p/`.length);
}

/** A fresh address per test and browser (the issuer's per-address limits are real here). */
const address = (info: TestInfo): string => `e2e-stamps-${info.project.name}-${crypto.randomUUID().slice(0, 8)}@mail-e2e.example.com`;

async function codeFor(to: string, previous: number): Promise<string> {
  const mails = async () => (await (await fetch(`${ISSUER_URL}/__e2e/outbox?to=${encodeURIComponent(to)}`)).json()) as { text: string; kind: string }[];
  await expect.poll(async () => (await mails()).length, { timeout: 10_000 }).toBeGreaterThan(previous);
  const last = (await mails()).at(-1)!;
  const m = /\b(\d{6})\b/u.exec(last.text);
  if (!m) throw new Error('no code in the mail');
  return m[1]!;
}

/** D912: the stamps site's app shares the stack's `e2e` scope with the hosted demo's (and the specs' own apps). */
const SHARED_LINE = /^This wallet is also used on \d+ other apps?\. See which$/u;

/**
 * The popup's chooser → email → address → code → Continue; the popup closes. On the way, the sign-in window says the
 * wallet is also used on other apps (D912), on the chooser and on the email step, right under who is asking.
 */
async function emailLogin(popup: Page, to: string): Promise<void> {
  await expect(popup.locator('#continue-email')).toBeVisible();
  await expect(popup.locator('p.asker + #shared-wallet > summary')).toHaveText(SHARED_LINE);
  await popup.click('#continue-email');
  await popup.waitForURL(/\/login\/email#/u);
  await expect(popup.locator('p.asker + #shared-wallet > summary')).toHaveText(SHARED_LINE);
  await popup.fill('#email-address', to);
  const before = ((await (await fetch(`${ISSUER_URL}/__e2e/outbox?to=${encodeURIComponent(to)}`)).json()) as unknown[]).length;
  await clickUntilTaken(popup, '#email-send');
  await expect(popup.locator('#email-code')).toBeVisible();
  await popup.fill('#email-code', await codeFor(to, before));
  await clickClosing(popup, '#email-verify');
}

// Journear's NEAR relayer, mocked at the network layer as the demo's spec does (src/near-relay.ts, shared with the
// hand-test browser, D880): activate creates the account on the mocked testnet; relay checks the delegate action calls
// `collect` on the stamps contract with no deposit and at most the relay's 10 Tgas, and delivers it to the stamps
// contract (`e2e_stamps_collect`): a panic is the API's 422 `contract_rejected`. Both answer 409
// near_account_unrecorded until the stack's real wallet directory holds the user's NEAR account.

const stampEl = (page: Page, id: string) => page.locator(`[data-stamp="${id}"]`);

/** Nothing of another chain anywhere on the page: no Stellar or EVM address, no such word, in text or attributes. */
async function expectNearOnly(page: Page): Promise<void> {
  const all = await page.evaluate(() => `${document.body.innerText} ${[...document.querySelectorAll('*')].flatMap((e) => [...e.attributes].map((a) => a.value)).join(' ')} ${document.title}`);
  expect(all).not.toMatch(/\bG[A-Z2-7]{55}\b|\b0x[0-9a-fA-F]{40}\b/u);
  expect(all).not.toMatch(/stellar|\bevm\b|ethereum|sepolia/iu);
  expect(all).not.toMatch(/\bHana\b/u);
}

/**
 * Clicks a stamp's collect button and approves the request it opens: in a new Journear Passport window, or in the one
 * still open from the previous approval (a request while it is open goes to it). Returns the window.
 */
async function collectWith(page: Page, id: ReviewedStampId, open: Page | null, note?: string): Promise<Page> {
  const popup = page.waitForEvent('popup', { timeout: 8_000 }).catch(() => null);
  await stampEl(page, id).locator('[data-action="collect"]').click();
  const reused = open !== null && !open.isClosed() ? open : null;
  const window = reused ?? (await popup);
  if (!window) throw new Error(`no approval window for ${id}`);
  await expectReviewedStamp(window, id, note);
  await approve(window);
  return window;
}

/**
 * D885: each stamp's approval is a reviewed call: the stamp by its slot's title, the contract named as checked by
 * Journear, no amber "acts as you" line; the raw account and method in the folded details.
 */
async function expectReviewedStamp(window: Page, id: ReviewedStampId, note?: string): Promise<void> {
  await expect(window.locator('h2.summary-headline')).toHaveText(`Stamp Trail wants to collect the ${REVIEWED_STAMP_TITLES[id]} stamp for you`);
  // D912: the approval window says the wallet is shared too, with "From Stamp Trail", before the amber or red boxes.
  await expect(window.locator('header.app + #shared-wallet > summary')).toHaveText(SHARED_LINE);
  if (note !== undefined) await expect(window.locator('div.summary-quote')).toHaveText(note);
  await expect(window.locator('p.summary-line').last()).toHaveText(`It uses Journear demo stamps (${E2E_STAMPS}, checked by Journear).`);
  await expect(window.locator('.warning-box')).toHaveCount(0);
  await expect(window.locator('details.request-details')).toContainText('collect');
  await expectPlainWindow(window);
}

/** D885: the Signature stamp's first approval, its NEP-413 message, read as the reviewed one. */
async function expectReviewedSignatureMessage(window: Page): Promise<void> {
  await expect(window.locator('h2.summary-headline')).toHaveText('Stamp Trail wants you to sign a message for your Signature stamp');
  await expect(window.locator('p.summary-line').last()).toHaveText(`It’s for Journear demo stamps (${E2E_STAMPS}, checked by Journear).`);
  await expect(window.locator('.warning-box')).toHaveCount(0);
  await expectPlainWindow(window);
}

test('the stamps site: email sign-in, Arrival, Sponsored, Postcard and Signature with zero NEAR, then the public passport', async ({ page }, info) => {
  test.setTimeout(150_000);
  await newApp(STAMPS_APP);
  // The hosted demo's app on the same scope, so the stamps site's wallet is shared whichever spec ran first (D912).
  await newApp(DEMO_APP);
  const relayer = await routeNearRelayer(page, ['stamps']);
  await recordCspViolations(page);
  await recordSlotStates(page);
  const res = await page.goto(`${STAMPS_ORIGIN}/`);
  expect(res?.status()).toBe(200);
  const csp = res?.headers()['content-security-policy'] ?? '';
  expect(csp).toContain(`frame-src ${VAULT_ORIGIN};`);
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toContain('unsafe-');
  expect(res?.headers()).toMatchObject({ 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cross-origin-opener-policy': 'same-origin-allow-popups' });
  await expect(page).toHaveTitle('Journear Passport stamps');

  // The cover: sign in to open the passport.
  await expect(page.locator('[data-mode="cover"]')).toBeVisible();
  await expect(page.locator('[data-action="sign-in"]')).toBeEnabled();

  const loginP = page.waitForEvent('popup');
  await page.locator('[data-action="sign-in"]').click();
  await emailLogin(await loginP, address(info));
  await expect(page.locator('[data-mode="mine"]')).toBeVisible();
  const share = (await page.locator('[data-role="share"]').getAttribute('href')) ?? '';
  const account = share.slice(`${STAMPS_ORIGIN}/p/`.length);
  expect(share).toBe(`${STAMPS_ORIGIN}/p/${account}`);
  expect(account).toMatch(/^[0-9a-f]{64}$/u);
  await expect(stampEl(page, 'arrival')).toHaveAttribute('data-status', 'available');
  await expect(stampEl(page, 'sponsored')).toHaveAttribute('data-status', 'locked');
  await expectNearOnly(page);

  // Arrival: the account is created for it (activate), then the relayed collect.
  let window = await collectWith(page, 'arrival', null);
  await expect(stampEl(page, 'arrival')).toHaveAttribute('data-status', 'collected', { timeout: 30_000 });
  await expect(page.locator('[data-role="notice"]')).toContainText('Arrival stamped on NEAR’s test network.');
  await expect(stampEl(page, 'sponsored')).toHaveAttribute('data-status', 'available');
  await expect(stampEl(page, 'own_fare')).toHaveAttribute('data-status', 'locked');
  await expect(stampEl(page, 'own_fare')).toContainText('The one stamp that needs your own test NEAR');
  // D807: Copy beside it (the full id; the local stack has no faucet to link).
  await expect(stampEl(page, 'own_fare').locator('[data-action="copy-account"]')).toBeVisible();
  await expect(stampEl(page, 'layover')).toContainText(/In \d+ (min|s)/u);

  window = await collectWith(page, 'sponsored', window);
  await expect(stampEl(page, 'sponsored')).toHaveAttribute('data-status', 'collected', { timeout: 30_000 });

  const note = `Greetings from the e2e stack (${info.project.name})`;
  await stampEl(page, 'postcard').locator('[data-field="note"]').fill(note);
  window = await collectWith(page, 'postcard', window, note);
  await expect(stampEl(page, 'postcard')).toHaveAttribute('data-status', 'collected', { timeout: 30_000 });
  await expect(stampEl(page, 'postcard')).toContainText(note);

  // Signature (D807): one click, one window, two approvals back to back. The NEP-413 approval first (the message and
  // the contract as its recipient, shown in the window), then the relayed collect with the proof: a second request,
  // sent the moment the first resolves, shown in the same window while it is open. No second window opens and the
  // SDK's launcher is never needed.
  await expect(stampEl(page, 'signature')).toContainText('Two approvals: sign a message, then send it.');
  const sigP = page.waitForEvent('popup', { timeout: 8_000 }).catch(() => null);
  await stampEl(page, 'signature').locator('[data-action="collect"]').click();
  const sigWindow = !window.isClosed() ? window : await sigP;
  if (!sigWindow) throw new Error('no approval window for the signature');
  await expect(sigWindow.getByText(`Stamp my passport: ${account}`).first()).toBeVisible();
  await expect(sigWindow.getByText(E2E_STAMPS).first()).toBeVisible();
  await expectReviewedSignatureMessage(sigWindow);
  await expect(stampEl(page, 'signature')).toContainText('Approval 1 of 2: sign the message');
  const extra = page.waitForEvent('popup', { timeout: 6_000 }).then(
    () => true,
    () => false,
  );
  await approve(sigWindow);
  await expectReviewedStamp(sigWindow, 'signature');
  await expect(stampEl(page, 'signature')).toContainText('Approval 2 of 2: send it to the stamps program');
  expect(sigWindow.isClosed()).toBe(false);
  await approve(sigWindow);
  await expect(stampEl(page, 'signature')).toHaveAttribute('data-status', 'collected', { timeout: 30_000 });
  expect(await extra).toBe(false);
  const seen = await seenStates(page);
  expect(seen).not.toContain('signature:continue');
  expect(seen.filter((x) => x.includes('Review in'))).toEqual([]);

  expect(relayer.stamps.map((a) => a.stamp)).toEqual(['arrival', 'sponsored', 'postcard', 'signature']);
  expect(relayer.stamps[2]).toEqual({ stamp: 'postcard', note });
  expect(relayer.stamps[3]).toMatchObject({ stamp: 'signature', proof: { message: `Stamp my passport: ${account}`, recipient: E2E_STAMPS } });
  expect(relayer.problems).toEqual([]);
  await expectNearOnly(page);
  expect(await cspViolations(page)).toEqual([]);

  // The public passport: read live from the chain, read-only, no sign-in needed.
  const viewer = await page.context().browser()!.newPage();
  try {
    await recordCspViolations(viewer);
    const pub = await viewer.goto(share);
    expect(pub?.status()).toBe(200);
    await expect(viewer.locator('[data-mode="public"]')).toBeVisible();
    for (const id of ['arrival', 'sponsored', 'postcard', 'signature']) await expect(viewer.locator(`[data-stamp="${id}"]`)).toHaveAttribute('data-status', 'collected');
    for (const id of ['own_fare', 'layover']) await expect(viewer.locator(`[data-stamp="${id}"]`)).toHaveAttribute('data-status', 'locked');
    await expect(viewer.locator('[data-stamp="postcard"]')).toContainText(note);
    await expect(viewer.locator('[data-action="collect"]')).toHaveCount(0);
    await expect(viewer.locator(`[data-role="recent-item"] a[href="${share}"]`).first()).toBeVisible();
    await expectNearOnly(viewer);
    expect(await cspViolations(viewer)).toEqual([]);
    // An invalid passport path is a 404, not the page.
    expect((await viewer.request.get(`${STAMPS_ORIGIN}/p/not..valid`)).status()).toBe(404);
  } finally {
    await viewer.close();
  }
});

test('reduced motion (D906): a working stamp’s spinners pulse slowly instead of turning; its marching outline stands still', async ({ page }) => {
  await newApp(STAMPS_APP);
  // The hosted demo's app on the same scope, so the stamps site's wallet is shared whichever spec ran first (D912).
  await newApp(DEMO_APP);
  await page.goto(`${STAMPS_ORIGIN}/`);
  await expect(page.locator('.pp').first()).toBeAttached();
  const motion = () =>
    page.evaluate(() => {
      const root = document.querySelector('.pp')!;
      const slot = document.createElement('div');
      slot.className = 'pp-slot';
      slot.dataset['status'] = 'working';
      const text = slot.appendChild(document.createElement('p'));
      text.className = 'pp-text';
      const svg = slot.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
      const sil = svg.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'path'));
      sil.setAttribute('class', 'pp-sil');
      const button = slot.appendChild(document.createElement('button'));
      button.className = 'jp-btn jp-btn-primary pp-btn pp-collect';
      const spin = button.appendChild(document.createElement('span'));
      spin.className = 'spin';
      root.append(slot);
      const of = (s: CSSStyleDeclaration) => ({ name: s.animationName, count: s.animationIterationCount, seconds: parseFloat(s.animationDuration) });
      const out = { spins: [of(getComputedStyle(text, '::before')), of(getComputedStyle(spin))], sil: getComputedStyle(sil).animationName };
      slot.remove();
      return out;
    });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reduced = await motion();
  for (const s of reduced.spins) expect(s).toEqual({ name: 'jp-spin-pulse', count: 'infinite', seconds: 2 });
  expect(reduced.sil).toBe('none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const moving = await motion();
  expect(moving.spins.map((s) => [s.name, s.count])).toEqual([['jp-spin', 'infinite'], ['jp-spin', 'infinite']]);
  expect(moving.sil).toBe('pp-march');
});

test('the Signature stamp’s second step after its window was closed in between: Continue in the slot opens it, the message is not signed again (D807)', async ({ page }, info) => {
  test.setTimeout(120_000);
  await newApp(STAMPS_APP);
  // The hosted demo's app on the same scope, so the stamps site's wallet is shared whichever spec ran first (D912).
  await newApp(DEMO_APP);
  const relayer = await routeNearRelayer(page, ['stamps']);
  // The vault's own read of the key before it queues a delegate action (checkNearDelegate), held 4 s when armed: time
  // for the user to close the window after the first approval, before the second request reaches it.
  let hold = false;
  const rpcOrigins = new Set([new URL(NEAR_RPC).origin, new URL(NEAR_RPC_FALLBACK).origin]);
  await page.context().route(
    (url) => rpcOrigins.has(url.origin),
    async (route) => {
      const req = route.request();
      if (hold && req.method() === 'POST' && req.headers()['origin'] === VAULT_ORIGIN && (req.postData() ?? '').includes('view_access_key')) await new Promise((r) => setTimeout(r, 4_000));
      await route.fallback();
    },
  );
  await page.goto(`${STAMPS_ORIGIN}/`);
  const account = await signIn(page, info);
  const first = await collectWith(page, 'arrival', null);
  await expect(stampEl(page, 'arrival')).toHaveAttribute('data-status', 'collected', { timeout: 30_000 });
  await first.close();

  // Step 1 in a window of its own; approved, then closed by the user before step 2 arrives.
  hold = true;
  const sigP = page.waitForEvent('popup', { timeout: 8_000 });
  await stampEl(page, 'signature').locator('[data-action="collect"]').click();
  const sigWindow = await sigP;
  await expect(sigWindow.getByText(`Stamp my passport: ${account}`).first()).toBeVisible();
  await expectReviewedSignatureMessage(sigWindow);
  // Past the click's transient activation (5 s in Chromium and Firefox, less in WebKit): from here the page can't open
  // a window by itself, as after any await in a real session.
  await page.waitForTimeout(6_000);
  await approve(sigWindow);
  await sigWindow.close();
  // The browser won't open a window outside a click: the slot says what is next, with its own button. (Should a
  // browser still let the SDK open one by itself, that is the step-2 request on show; closing it too is a decline,
  // which ends in the same slot state.)
  await expect
    .poll(
      async () => {
        for (const p of page.context().pages()) if (p !== page && !p.isClosed()) await p.close();
        return stampEl(page, 'signature').getAttribute('data-status');
      },
      { timeout: 20_000 },
    )
    .toBe('continue');
  await expect(stampEl(page, 'signature')).toContainText('Step 2 of 2: send your signed message to the stamps program.');
  hold = false;
  const nextP = page.waitForEvent('popup', { timeout: 8_000 });
  await stampEl(page, 'signature').locator('[data-action="collect"]', { hasText: 'Continue' }).click();
  const next = await nextP;
  // The waiting request, the relayed collect (its args carry the signed proof): not the message to sign again.
  await expectReviewedStamp(next, 'signature');
  await expect(stampEl(page, 'signature')).toContainText('Approval 2 of 2: send it to the stamps program');
  await approve(next);
  await expect(stampEl(page, 'signature')).toHaveAttribute('data-status', 'collected', { timeout: 30_000 });
  expect(relayer.stamps.map((a) => a.stamp)).toEqual(['arrival', 'signature']);
  expect(relayer.problems).toEqual([]);

});
