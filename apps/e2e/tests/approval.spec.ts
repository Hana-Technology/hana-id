// Signing through the approval popup (docs/batch-b-spec.md "Approval flow"): the launcher only opens the popup, the
// popup renders what it decoded itself, Approve is guarded against window-timing tricks, and the vault signs only an
// answer from its own popup whose digest matches the whole request.
import { type Page } from '@playwright/test';
import { approvalDigest, from0xHex } from '@hana-id/core';
import { verifyStellarSignature } from '@hana-id/core/signers/stellar';
import { AUTH_ORIGIN, LIVE_AUTH_ORIGIN, LIVE_PARTNER_ORIGIN, LIVE_VAULT_ORIGIN, SITE_B_ORIGIN, VAULT_ORIGIN } from '../src/stack.ts';
import {
  type App,
  VAULT_FRAME,
  approve,
  clickLauncher,
  errorCode,
  errorOf,
  launcher,
  expect,
  login,
  newApp,
  newLiveApp,
  okValue,
  openPartner,
  peek,
  recordApproveRequests,
  reject,
  runAction,
  test,
} from './fixtures.ts';

async function loggedIn(page: Page, app?: App): Promise<{ stellar: string; evm: string }> {
  await openPartner(page, app ?? (await newApp()));
  return login(page);
}

/** Logged in to a live (pk_live_) app in the stack's live mode: the only kind of app that can sign raw (D39). */
async function loggedInLive(page: Page, app: App): Promise<{ stellar: string; evm: string }> {
  expect(await openPartner(page, app, { live: true })).toBe('ok');
  return login(page);
}

/** Starts hana.signRaw over `len` bytes of `fill` (Stellar `bytes`, EVM `digest`), built in the page as a Uint8Array. */
async function runSignRaw(page: Page, name: string, chain: 'stellar' | 'evm', len: number, fill: number): Promise<Uint8Array> {
  await page.evaluate(
    ([n, c, l, f]) => {
      const b = new Uint8Array(l).fill(f);
      (window as any).e2e.run(n, 'signRaw', c === 'evm' ? { chain: c, digest: b } : { chain: c, bytes: b });
    },
    [name, chain, len, fill] as const,
  );
  return new Uint8Array(len).fill(fill);
}

/** The guard holds: nothing was signed `ms` after the attempt. */
async function stillPending(page: Page, name: string, ms = 1_500): Promise<void> {
  await page.waitForTimeout(ms);
  expect(await peek(page, name)).toEqual({ state: 'pending' });
}

/** Clicks at the centre of `selector` with the raw mouse, whether or not the element is enabled. */
async function rawClick(page: Page, selector: string, clickCount = 1): Promise<void> {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`${selector} has no box`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { clickCount });
}

test('a Stellar payment is shown decoded and signed after a guarded Approve', async ({ page }) => {
  const { stellar } = await loggedIn(page);
  await runAction(page, 'sig', 'stellarSignTx');
  const popup = await clickLauncher(page, 'Review in Hana');
  await expect(popup.getByText('Request 1 of 1', { exact: false })).toBeVisible();
  await expect(popup.getByText(stellar).first()).toBeVisible();
  await expect(popup.getByText('E2E Partner').first()).toBeVisible();
  await approve(popup);
  expect(await okValue(page, 'sig')).toEqual({ signerAddress: stellar, valid: true });
});

test('Reject returns 4001, and so does closing the popup', async ({ page }) => {
  await loggedIn(page);
  await runAction(page, 'rejected', 'personalSign', 'hello');
  const popup = await clickLauncher(page, 'Review in Hana');
  await expect(popup.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
  await reject(popup);
  expect(await errorCode(page, 'rejected')).toBe(4001);

  // The popup now waits for a follow-up; a new request is shown there, and closing the window rejects it.
  await runAction(page, 'closed', 'stellarSignMessage', 'bye');
  await expect(popup.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
  await popup.close();
  expect(await errorCode(page, 'closed')).toBe(4001);
});

test('a follow-up request appears in the same open popup and needs its own guarded Approve', async ({ page }) => {
  const { evm } = await loggedIn(page);
  await runAction(page, 'first', 'personalSign', 'one');
  const popup = await clickLauncher(page, 'Review in Hana');
  await approve(popup);
  expect(await okValue(page, 'first')).toMatchObject({ valid: true });
  await expect(popup.getByText('Waiting for the next request', { exact: false })).toBeVisible();

  // Injected into the reused popup, then clicked within 1 s of rendering: no signature.
  let opened = false;
  page.on('popup', () => {
    opened = true;
  });
  await runAction(page, 'second', 'personalSign', 'two');
  await expect(popup.getByText('Request 2 of 2', { exact: false })).toBeVisible();
  await popup.mouse.move(10, 10);
  await rawClick(popup, 'button.primary');
  await stillPending(page, 'second', 600);
  expect(opened).toBe(false);

  await approve(popup);
  expect(await okValue(page, 'second')).toMatchObject({ valid: true });
  expect(evm).toMatch(/^0x/u);
});

test('a scripted double-click across the launcher→popup opening produces no signature', async ({ page }) => {
  await loggedIn(page);
  await runAction(page, 'sig', 'stellarSignMessage', 'double');
  const button = page.frameLocator(VAULT_FRAME).getByRole('button', { name: 'Review in Hana' });
  await expect(button).toBeVisible();
  const box = await page.locator(VAULT_FRAME).boundingBox();
  if (!box) throw new Error('no launcher box');
  const popupP = page.waitForEvent('popup');
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  const popup = await popupP;
  // The second click lands where Approve renders, as soon as it is there.
  await popup.locator('button.primary').waitFor();
  await rawClick(popup, 'button.primary', 2);
  await stillPending(page, 'sig');
  await expect(popup.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();
  await reject(popup);
  expect(await errorCode(page, 'sig')).toBe(4001);
});

test('an opacity-0 launcher: the click only opens the popup, and an immediate click there signs nothing', async ({ page }) => {
  await loggedIn(page);
  await page.evaluate(() => (window as any).e2e.hideLauncher());
  await runAction(page, 'sig', 'stellarSignMessage', 'invisible');
  await expect(page.frameLocator(VAULT_FRAME).getByRole('button', { name: 'Review in Hana' })).toBeAttached();
  const box = await page.locator(VAULT_FRAME).boundingBox();
  if (!box) throw new Error('no launcher box');
  const popupP = page.waitForEvent('popup');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const popup = await popupP;
  await popup.locator('button.primary').waitFor();
  await rawClick(popup, 'button.primary');
  await stillPending(page, 'sig');
  await popup.close();
  expect(await errorCode(page, 'sig')).toBe(4001);
});

test('an opacity-0 overlay over the launcher takes the click: no popup, no signature', async ({ page }) => {
  await loggedIn(page);
  await page.evaluate(() => (window as any).e2e.coverLauncher());
  await runAction(page, 'sig', 'stellarSignMessage', 'covered');
  await expect(page.frameLocator(VAULT_FRAME).getByRole('button', { name: 'Review in Hana' })).toBeVisible();
  const box = await page.locator(VAULT_FRAME).boundingBox();
  if (!box) throw new Error('no launcher box');
  let opened = false;
  page.on('popup', () => {
    opened = true;
  });
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await stillPending(page, 'sig');
  expect(opened).toBe(false);
});

test.describe('the digest binds the answer to the whole request', () => {
  test.beforeEach(async ({ context }) => recordApproveRequests(context));

  /** Posts a forged hana:approve-result from inside the real popup (right window, right origin) for the request on show. */
  async function forgeFromPopup(popup: Page, mutate: (input: Parameters<typeof approvalDigest>[0]) => Parameters<typeof approvalDigest>[0]): Promise<void> {
    const req = await popup.waitForFunction(() => (window as any).__approveRequests?.at(-1)).then((h) =>
      h.evaluate((m: any) => ({ id: m.id, kind: m.kind, chain: m.chain, address: m.address, parentOrigin: m.parentOrigin, context: m.context, bytes: Array.from(m.bytes as Uint8Array) })),
    );
    const input = mutate({ ...req, bytes: Uint8Array.from(req.bytes) } as Parameters<typeof approvalDigest>[0]);
    const digest = Array.from(approvalDigest(input));
    await popup.evaluate(
      ([id, d, vault]) => window.opener.postMessage({ v: 1, t: 'hana:approve-result', id, approved: true, digest: Uint8Array.from(d as number[]) }, vault as string),
      // The vault that opened this popup: live mode's when the popup is on live mode's authOrigin.
      [req.id, digest, new URL(popup.url()).origin === LIVE_AUTH_ORIGIN ? LIVE_VAULT_ORIGIN : VAULT_ORIGIN] as const,
    );
  }

  test('a digest over a different context is refused (4001, no signature)', async ({ page }) => {
    await loggedIn(page);
    await runAction(page, 'sig', 'stellarSignTx');
    const popup = await clickLauncher(page, 'Review in Hana');
    await forgeFromPopup(popup, (i) => ({ ...i, context: { networkPassphrase: 'Public Global Stellar Network ; September 2015' } }));
    expect(await errorCode(page, 'sig')).toBe(4001);
  });

  test('a digest over other bytes is refused (4001, no signature)', async ({ page }) => {
    await loggedIn(page);
    await runAction(page, 'sig', 'personalSign', 'what you see');
    const popup = await clickLauncher(page, 'Review in Hana');
    await forgeFromPopup(popup, (i) => ({ ...i, bytes: new TextEncoder().encode('what you sign') }));
    expect(await errorCode(page, 'sig')).toBe(4001);
  });

  test('a digest over another kind is refused (4001, no signature)', async ({ page }) => {
    await loggedIn(page);
    await runAction(page, 'sig', 'personalSign', 'a message');
    const popup = await clickLauncher(page, 'Review in Hana');
    // Same chain, same (empty) context and bytes: only the kind differs.
    await forgeFromPopup(popup, (i) => ({ ...i, kind: i.kind === 'personal_sign' ? 'eip712' : 'personal_sign' }));
    expect(await errorCode(page, 'sig')).toBe(4001);
  });

  test('a digest over another chain is refused (4001, no signature)', async ({ page }) => {
    // Raw requests are a live app's (D39). One of 32 bytes fits both chains, so only the chain differs.
    await loggedInLive(page, await newLiveApp({ settings: { rawSign: 'approval' } }));
    await runSignRaw(page, 'sig', 'stellar', 32, 3);
    const popup = await clickLauncher(page, 'Review in Hana');
    await forgeFromPopup(popup, (i) => ({ ...i, chain: i.chain === 'stellar' ? 'evm' : 'stellar' }));
    expect(await errorCode(page, 'sig')).toBe(4001);
  });

  test('a digest over another address is refused (4001, no signature)', async ({ page }) => {
    await loggedIn(page);
    await runAction(page, 'sig', 'personalSign', 'whose key');
    const popup = await clickLauncher(page, 'Review in Hana');
    await forgeFromPopup(popup, (i) => ({ ...i, address: '0x000000000000000000000000000000000000dEaD' }));
    expect(await errorCode(page, 'sig')).toBe(4001);
  });

  test('a digest over another parent origin is refused (4001, no signature)', async ({ page }) => {
    await loggedIn(page);
    await runAction(page, 'sig', 'stellarSignMessage', 'for which site');
    const popup = await clickLauncher(page, 'Review in Hana');
    await forgeFromPopup(popup, (i) => ({ ...i, parentOrigin: SITE_B_ORIGIN }));
    expect(await errorCode(page, 'sig')).toBe(4001);
  });

  test('a digest for another request id is refused (4001, no signature)', async ({ page }) => {
    await loggedIn(page);
    await runAction(page, 'sig', 'personalSign', 'which request');
    const popup = await clickLauncher(page, 'Review in Hana');
    // The result names the request on show; only the id inside the digest differs.
    await forgeFromPopup(popup, (i) => ({ ...i, id: `${i.id}-other` }));
    expect(await errorCode(page, 'sig')).toBe(4001);
  });

  test('the right digest, posted the same way, is accepted (the control for the cases above)', async ({ page }) => {
    await loggedIn(page);
    await runAction(page, 'sig', 'personalSign', 'exact');
    const popup = await clickLauncher(page, 'Review in Hana');
    await forgeFromPopup(popup, (i) => i);
    expect(await okValue(page, 'sig')).toMatchObject({ valid: true });
  });
});

test.describe('raw signing', () => {
  // Only a live app signs raw (test apps never do, D39): these run as a pk_live_ app in the stack's live mode
  // (src/stack.ts), except the test-app refusal itself.
  test('a live app needs a guarded Approve under the raw warning when raw_sign is approval', async ({ page }) => {
    const { stellar } = await loggedInLive(page, await newLiveApp({ settings: { rawSign: 'approval' } }));
    const bytes = await runSignRaw(page, 'raw', 'stellar', 64, 2);
    const popup = await clickLauncher(page, 'Review in Hana');
    await expect(popup.getByText('Raw signing can authorize any transaction', { exact: false })).toBeVisible();
    await expect(popup.getByText('This signature isn’t tied to one network.', { exact: false })).toBeVisible();
    await expect(popup.getByText(stellar).first()).toBeVisible();
    await expect(popup.getByText(LIVE_PARTNER_ORIGIN, { exact: true })).toBeVisible();
    // A live app's popup has no test-network notice.
    await expect(popup.getByText('test networks', { exact: false })).toHaveCount(0);
    // A click within 1 s of rendering signs nothing.
    await rawClick(popup, 'button.primary');
    await stillPending(page, 'raw', 600);
    await approve(popup);
    const { signature } = await okValue<{ signature: `0x${string}` }>(page, 'raw');
    expect(signature).toMatch(/^0x[0-9a-f]{128}$/u);
    expect(verifyStellarSignature(stellar, bytes, from0xHex(signature))).toBe(true);
  });

  test("is refused with 4100 when a live app's raw_sign is off, with no popup", async ({ page }) => {
    await loggedInLive(page, await newLiveApp());
    await runSignRaw(page, 'raw', 'evm', 32, 1);
    expect(await errorOf(page, 'raw')).toEqual({ code: 4100, reason: 'raw_sign_off' });
    await expect(launcher(page).getByRole('button', { name: 'Review in Hana' })).toHaveCount(0);
  });

  test('is refused with 4100 for a test app even when raw_sign is approval, with no popup', async ({ page }) => {
    await loggedIn(page, await newApp({ settings: { rawSign: 'approval' } }));
    await runSignRaw(page, 'raw', 'stellar', 64, 2);
    expect(await errorOf(page, 'raw')).toEqual({ code: 4100, reason: 'raw_not_allowed_for_test_apps' });
    await expect(launcher(page).getByRole('button', { name: 'Review in Hana' })).toHaveCount(0);
  });
});

test('the approval popup is on authOrigin and was opened by the vault', async ({ page }) => {
  await loggedIn(page);
  await runAction(page, 'sig', 'stellarSignMessage', 'where');
  const popup = await clickLauncher(page, 'Review in Hana');
  expect(new URL(popup.url()).origin).toBe(AUTH_ORIGIN);
  expect(new URL(popup.url()).pathname).toBe('/approve');
  await reject(popup);
  expect(await errorCode(page, 'sig')).toBe(4001);
});
