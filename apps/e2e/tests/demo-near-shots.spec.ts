// Screens of the demo's NEAR card for review, in light and dark, desktop and phone: signed out (no card), signed in,
// each stage of the gasless write (Hana's relayer mocked at the network layer and held at each step), the approval
// window, success with the guestbook list, and an error. Runs only with HANA_SHOTS_DIR set, in Chromium:
//
//   HANA_SHOTS_DIR=<dir> corepack pnpm exec playwright test --project=chromium tests/demo-near-shots.spec.ts
import { type Page } from '@playwright/test';
import { base64Decode, decodeNearSignedDelegateAction } from '@hana-id/core';
import { API_URL, DEMO_ORIGIN, DEMO_PK, E2E_GUESTBOOK, NEAR_RPC } from '../src/stack.ts';
import { approve, chooseAccount, expect, newApp, test } from './fixtures.ts';

const SHOTS = process.env.HANA_SHOTS_DIR;
const VIEWPORTS = { desktop: { width: 1100, height: 1000 }, phone: { width: 390, height: 844 } } as const;

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

async function chain(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(NEAR_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return ((await res.json()) as { result: Record<string, unknown> }).result;
}

/** Each screen in both color schemes and both widths; `full`: the whole page, else the NEAR card (or `target`). */
async function shots(page: Page, name: string, o: { full?: boolean; target?: string } = {}): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [vp, size] of Object.entries(VIEWPORTS)) {
      await page.setViewportSize(size);
      const path = `${SHOTS}/${name}-${scheme}-${vp}.png`;
      if (o.full) await page.screenshot({ path, fullPage: true, animations: 'disabled' });
      else await page.locator(o.target ?? '#near').screenshot({ path, animations: 'disabled' });
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize(VIEWPORTS.desktop);
}

/** Approves the request `click` sends: in the approval window still open from the last one, or in a new one. */
async function approveNext(page: Page, open: Page, click: () => Promise<void>): Promise<void> {
  const fresh = page.waitForEvent('popup', { timeout: 10_000 }).catch(() => null);
  await click();
  const w = open.isClosed() ? await fresh : open;
  if (!w) throw new Error('No approval window');
  await approve(w);
}

test('screens of the NEAR card', async ({ page, browserName }) => {
  test.skip(!SHOTS || browserName !== 'chromium', 'HANA_SHOTS_DIR, Chromium only');
  test.setTimeout(120_000);
  const activation = gate();
  const relaying = gate();
  let failNext = false;
  const cors = { 'access-control-allow-origin': DEMO_ORIGIN, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type, x-hana-key' };
  await page.route(`${API_URL}/v1/near/*`, async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const body = req.postDataJSON() as Record<string, string>;
    if (req.url().endsWith('/activate')) {
      await activation.wait;
      const { created } = await chain('e2e_near_activate', { account_id: body.accountId });
      return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ created }) });
    }
    if (failNext) return route.fulfill({ status: 403, headers: cors, contentType: 'application/json', body: JSON.stringify({ code: 'receiver_not_allowed', error: 'receiver not allowed' }) });
    await relaying.wait;
    const { delegateAction: d } = decodeNearSignedDelegateAction(base64Decode(body.signedDelegateAction!));
    const { text } = JSON.parse(new TextDecoder().decode((d.actions[0] as { args: Uint8Array }).args)) as { text: string };
    await chain('e2e_guestbook_add', { account_id: d.senderId, text, nonce: String(d.nonce) });
    return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ transactionHash: '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi', status: 'executed' }) });
  });
  // Other writers, one of them hostile.
  await chain('e2e_guestbook_add', { account_id: 'alice.testnet', text: 'First! gm from NEAR testnet 🌸' });
  await chain('e2e_guestbook_add', { account_id: 'mallory.testnet', text: '<img src=x onerror=alert(1)> ‮gnp.exe https://evil.example' });
  await chain('e2e_guestbook_add', { account_id: 'a'.repeat(20) + '.' + 'b'.repeat(20) + '.testnet', text: 'Building on NEAR with Hana ID: sign in with email, write with zero NEAR, no extension, no seed phrase.' });

  await newApp({ name: 'Hana ID demo', origins: [DEMO_ORIGIN], publishableKey: DEMO_PK });
  await page.setViewportSize(VIEWPORTS.desktop);
  await page.goto(`${DEMO_ORIGIN}/`);
  await expect(page.locator('#status')).toHaveText('Logged out.');
  await shots(page, '01-signed-out', { full: true });

  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Log in with Google' }).click();
  await chooseAccount(await popup);
  await expect(page.locator('#near')).toBeVisible();
  await expect(page.locator('#near-messages li')).toHaveCount(3);
  await shots(page, '02-signed-in', { full: true });
  await shots(page, '02-signed-in-card');

  // A first write with the activation held: "Preparing your NEAR account…".
  await page.locator('#near-text').fill('gm from Hana ID: my first NEAR transaction, and I hold zero NEAR');
  const approvalP = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Write to the guestbook (no NEAR needed)' }).click();
  await expect(page.locator('#near-stage')).toHaveText('Preparing your NEAR account…');
  const approval = await approvalP;
  await page.bringToFront();
  await shots(page, '03-stage-preparing');
  activation.open();
  await expect(page.locator('#near-stage')).toHaveText('Waiting for your approval in the Hana window…');
  await shots(page, '04-stage-approving');
  await expect(approval.getByRole('heading', { name: 'NEAR transaction, fee paid by a relayer' })).toBeVisible();
  for (const scheme of ['light', 'dark'] as const) {
    await approval.emulateMedia({ colorScheme: scheme });
    await approval.screenshot({ path: `${SHOTS}/04-approval-window-${scheme}.png`, fullPage: true, animations: 'disabled' });
  }
  await approve(approval);
  await expect(page.locator('#near-stage')).toHaveText('Sending it through Hana’s relayer, which pays the fee…');
  await shots(page, '05-stage-relaying');
  relaying.open();
  await expect(page.locator('#near-done')).toBeVisible();
  await expect(page.locator('#near-messages li.mine')).toHaveCount(1);
  await shots(page, '06-success-with-list');

  // A refusal from the relayer, in the card.
  failNext = true;
  await page.locator('#near-text').fill('this one is refused');
  await approveNext(page, approval, () => page.getByRole('button', { name: 'Write to the guestbook (no NEAR needed)' }).click());
  await expect(page.locator('#near-error')).toBeVisible();
  await page.bringToFront();
  await shots(page, '07-error');

  // Sign a transaction with zero NEAR: signed, not sent.
  await approveNext(page, approval, () => page.getByRole('button', { name: 'Sign a transaction' }).click());
  await expect(page.locator('#near-results li').first()).toContainText('signed, not sent');
  await page.bringToFront();
  await shots(page, '08-transaction-not-sent');
});
