// The stamps site (apps/stamps, D798–D802): its built page, served by its own Worker handler with its real CSP and
// headers, signs in by email through the vault, collects Arrival, Sponsored, Postcard and Signature (each approved in
// the Journear Passport window, each a NEAR call the mocked relayer delivers to the stamps contract on the mocked
// testnet, which verifies the signature stamp's NEP-413 proof with ed25519 as the contract does), then shows them on
// the public passport. Nothing of another chain is ever on the page. The page is configured at build time like the
// deployed one (src/build.ts STAMPS_CONFIG), so its app has a fixed key (STAMPS_PK).
import { type Page, type TestInfo } from '@playwright/test';
import { base64Decode, decodeNearSignedDelegateAction } from '@hana-id/core';
import { API_URL, E2E_STAMPS, ISSUER_URL, NEAR_RPC, STAMPS_ORIGIN, STAMPS_PK, VAULT_ORIGIN } from '../src/stack.ts';
import { approve, clickClosing, clickUntilTaken, expect, newApp, test, walletDirectory } from './fixtures.ts';

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

/** The popup's chooser → email → address → code → Continue; the popup closes. */
async function emailLogin(popup: Page, to: string): Promise<void> {
  await expect(popup.locator('#continue-email')).toBeVisible();
  await popup.click('#continue-email');
  await popup.waitForURL(/\/login\/email#/u);
  await popup.fill('#email-address', to);
  const before = ((await (await fetch(`${ISSUER_URL}/__e2e/outbox?to=${encodeURIComponent(to)}`)).json()) as unknown[]).length;
  await clickUntilTaken(popup, '#email-send');
  await expect(popup.locator('#email-code')).toBeVisible();
  await popup.fill('#email-code', await codeFor(to, before));
  await clickClosing(popup, '#email-verify');
}

/**
 * Journear's NEAR relayer, mocked at the network layer as the demo's spec does (the stack runs no relay account):
 * activate creates the account on the mocked testnet; relay decodes the signed delegate action, checks it calls
 * `collect` on the stamps contract with no deposit and at most the relay's 10 Tgas, and delivers it to the stamps
 * contract (`e2e_stamps_collect`): a panic is the API's 422 `contract_rejected`. Both answer 409
 * near_account_unrecorded until the stack's real wallet directory holds the user's NEAR account.
 */
/** The relayer's transaction in the mocked answers (base58, as NEAR's hashes). */
const RELAY_TX = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi';

async function routeNearRelayer(page: Page): Promise<{ relayed: Record<string, unknown>[]; refused: string[] }> {
  const relayed: Record<string, unknown>[] = [];
  const refused: string[] = [];
  const cors = { 'access-control-allow-origin': STAMPS_ORIGIN, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type, x-hana-key', 'access-control-expose-headers': 'retry-after', vary: 'Origin' };
  const chain = async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const res = await fetch(NEAR_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return ((await res.json()) as { result: Record<string, unknown> }).result;
  };
  await page.route(`${API_URL}/v1/near/*`, async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    expect(req.headers()['x-hana-key']).toBe(STAMPS_PK);
    const body = req.postDataJSON() as Record<string, string>;
    const activate = req.url().endsWith('/v1/near/activate');
    const sender = activate ? body.accountId! : decodeNearSignedDelegateAction(base64Decode(body.signedDelegateAction!)).delegateAction.senderId;
    const recorded = (await walletDirectory(sender)).some((u) => u.wallets.some((w) => w.chain === 'near' && w.address === sender));
    if (!recorded) {
      refused.push(req.url().slice(API_URL.length));
      return route.fulfill({ status: 409, headers: { ...cors, 'retry-after': '2' }, contentType: 'application/json', body: JSON.stringify({ error: 'not recorded yet', code: 'near_account_unrecorded', retryable: true }) });
    }
    if (activate) return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(await chain('e2e_near_activate', { account_id: body.accountId })) });
    const { delegateAction: d } = decodeNearSignedDelegateAction(base64Decode(body.signedDelegateAction!));
    expect(d.actions).toHaveLength(1);
    const call = d.actions[0] as { type: string; methodName: string; args: Uint8Array; gas: bigint; deposit: bigint };
    expect([d.receiverId, call.type, call.methodName, call.deposit]).toEqual([E2E_STAMPS, 'functionCall', 'collect', 0n]);
    expect(call.gas).toBeLessThanOrEqual(10_000_000_000_000n);
    const args = new TextDecoder().decode(call.args);
    relayed.push(JSON.parse(args) as Record<string, unknown>);
    const { panic } = (await chain('e2e_stamps_collect', { account_id: d.senderId, args, sponsored: true, nonce: String(d.nonce) })) as { panic: string | null };
    // The API's answers as apps/api/src/near/relay.ts relayAnswerBody writes them (the panic text as NEAR's
    // ExecutionError gives it, the failed receipt's executor, the relay's transaction).
    const tx = { transactionHash: RELAY_TX, nearTx: RELAY_TX };
    if (panic) return route.fulfill({ status: 422, headers: cors, contentType: 'application/json', body: JSON.stringify({ error: `Smart contract panicked: ${panic}`, code: 'contract_rejected', status: 'failed', executor: E2E_STAMPS, ...tx }) });
    return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ status: 'executed', ...tx }) });
  });
  return { relayed, refused };
}

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
async function collectWith(page: Page, id: string, open: Page | null): Promise<Page> {
  const popup = page.waitForEvent('popup', { timeout: 8_000 }).catch(() => null);
  await stampEl(page, id).locator('[data-action="collect"]').click();
  const reused = open !== null && !open.isClosed() ? open : null;
  const window = reused ?? (await popup);
  if (!window) throw new Error(`no approval window for ${id}`);
  await approve(window);
  return window;
}

test('the stamps site: email sign-in, Arrival, Sponsored, Postcard and Signature with zero NEAR, then the public passport', async ({ page }, info) => {
  test.setTimeout(150_000);
  await newApp({ name: 'Stamp Trail', origins: [STAMPS_ORIGIN], publishableKey: STAMPS_PK, loginMethods: 'google,email' });
  const relayer = await routeNearRelayer(page);
  await recordCspViolations(page);
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
  await expect(page.locator('[data-role="notice"]')).toContainText('Arrival stamped on NEAR testnet.');
  await expect(stampEl(page, 'sponsored')).toHaveAttribute('data-status', 'available');
  await expect(stampEl(page, 'own_fare')).toHaveAttribute('data-status', 'locked');
  await expect(stampEl(page, 'own_fare')).toContainText('Needs testnet NEAR');
  await expect(stampEl(page, 'layover')).toContainText(/In \d+ (min|s)/u);

  window = await collectWith(page, 'sponsored', window);
  await expect(stampEl(page, 'sponsored')).toHaveAttribute('data-status', 'collected', { timeout: 30_000 });

  const note = `Greetings from the e2e stack (${info.project.name})`;
  await stampEl(page, 'postcard').locator('[data-field="note"]').fill(note);
  window = await collectWith(page, 'postcard', window);
  await expect(stampEl(page, 'postcard')).toHaveAttribute('data-status', 'collected', { timeout: 30_000 });
  await expect(stampEl(page, 'postcard')).toContainText(note);

  // Signature: the NEP-413 approval first (the message and the contract as its recipient, shown in the window), then
  // the relayed collect with the proof: a second request, to the same window while it is open.
  const sigP = page.waitForEvent('popup', { timeout: 8_000 }).catch(() => null);
  await stampEl(page, 'signature').locator('[data-action="collect"]').click();
  const sigWindow = !window.isClosed() ? window : await sigP;
  if (!sigWindow) throw new Error('no approval window for the signature');
  await expect(sigWindow.getByText(`Stamp my passport: ${account}`).first()).toBeVisible();
  await expect(sigWindow.getByText(E2E_STAMPS).first()).toBeVisible();
  await approve(sigWindow);
  const relayP = page.waitForEvent('popup', { timeout: 8_000 }).catch(() => null);
  await expect(stampEl(page, 'signature')).toContainText(/approval|relayer/u);
  const relayWindow = !sigWindow.isClosed() ? sigWindow : await relayP;
  if (!relayWindow) throw new Error('no approval window for the signature’s collect');
  await expect(relayWindow.getByText('collect').first()).toBeVisible();
  await approve(relayWindow);
  await expect(stampEl(page, 'signature')).toHaveAttribute('data-status', 'collected', { timeout: 30_000 });

  expect(relayer.relayed.map((a) => a.stamp)).toEqual(['arrival', 'sponsored', 'postcard', 'signature']);
  expect(relayer.relayed[2]).toEqual({ stamp: 'postcard', note });
  expect(relayer.relayed[3]).toMatchObject({ stamp: 'signature', proof: { message: `Stamp my passport: ${account}`, recipient: E2E_STAMPS } });
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
