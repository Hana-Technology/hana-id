// The approval window's screens for Journear's reviewed NEAR calls (D885), saved for the founder: every stamp the
// stamps site collects through an approval (both of the Signature stamp's), the hosted demo's guestbook write
// (relayed and the user's own transaction), and near-misses that keep today's screen. Light scheme, at a phone's
// width (390 px) and the desktop popup's size (420 × 680), each with its details folded and open. Runs only with
// HANA_SHOTS_DIR set, in Chromium:
//
//   HANA_SHOTS_DIR=<dir> corepack pnpm exec playwright test --project=chromium tests/approval-near-reviewed-shots.spec.ts
//
// Each request is posted to the window as its vault would post it (as approval-plain-shots.spec.ts does), so the app's
// name is the site's ("Stamp Trail", "Journear demo") and the screen is the real one. What each says is checked in
// stamps.spec.ts, demo.spec.ts and the unit tests; this spec only saves them. It uses nothing the branch adds, so the
// same file run on the base branch saves the "before" screens.
import { type Page } from '@playwright/test';
import { type NearAction, base64Encode, encodeNearDelegateAction, encodeNearTransaction, encodeNep413Message, nearImplicitPublicKey } from '@hana-id/core';
import { DEMO_ORIGIN, E2E_GUESTBOOK, E2E_STAMPS, NEAR_RPC, STAMPS_ORIGIN, VAULT_ORIGIN } from '../src/stack.ts';
import { approve, clickLauncher, expect, login, newApp, okValue, openPartner, runAction, test } from './fixtures.ts';

const SHOTS = process.env.HANA_SHOTS_DIR;
const SIZES = { '390': { width: 390, height: 844 }, popup: { width: 420, height: 680 } } as const;
const NEAR_HEIGHT = 200_000_000n;
const BLOCK = new Uint8Array(32).fill(0x2a);
const TGAS = 1_000_000_000_000n;
const fn = (methodName: string, args: unknown, deposit = 0n): NearAction => ({ type: 'functionCall', methodName, args: new TextEncoder().encode(JSON.stringify(args)), gas: 10n * TGAS, deposit });

async function nearRpc(method: string, params: Record<string, unknown>): Promise<void> {
  await fetch(NEAR_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
}

type Shot = { name: string; app: string; origin: string; kind: 'near_delegate' | 'near_tx' | 'near_message'; bytes: Uint8Array };

/** Posts a request to the window as its vault would (origin vaultOrigin, source the opener). */
async function inject(popup: Page, s: Shot, address: string): Promise<void> {
  await popup.evaluate(
    ({ kind, bytes, address, appName, parentOrigin, vaultOrigin }) => {
      const id = crypto.randomUUID().replace(/-/gu, '');
      const context = kind === 'near_message' ? {} : { nearNetwork: 'testnet' };
      const data = { v: 1, t: 'hana:approve-request', id, appName, parentOrigin, kind, chain: 'near', address, bytes: new Uint8Array(bytes), context, position: 1, queued: 1, testApp: true };
      const event = new MessageEvent('message', { data, origin: vaultOrigin });
      Object.defineProperty(event, 'source', { value: window.opener });
      window.dispatchEvent(event);
    },
    { kind: s.kind, bytes: Array.from(s.bytes), address, appName: s.app, parentOrigin: s.origin, vaultOrigin: VAULT_ORIGIN },
  );
}

test('reviewed NEAR calls: the screens', async ({ page, browserName }) => {
  test.skip(!SHOTS || browserName !== 'chromium', 'HANA_SHOTS_DIR, Chromium only');
  test.setTimeout(300_000);
  await openPartner(page, await newApp());
  await login(page);
  const near = (await page.evaluate(() => (window as any).e2e.addresses().near)) as string;
  const key = { type: 'ed25519' as const, bytes: nearImplicitPublicKey(near) };
  await nearRpc('e2e_near_activate', { account_id: near });
  let nonce = (NEAR_HEIGHT - 1n) * 1_000_000n + 5n;
  const relayed = (receiverId: string, actions: NearAction[]) => encodeNearDelegateAction({ senderId: near, receiverId, actions, nonce: nonce++, maxBlockHeight: NEAR_HEIGHT + 100n, publicKey: key });
  const direct = (receiverId: string, actions: NearAction[]) => encodeNearTransaction({ signerId: near, publicKey: key, nonce: nonce++, receiverId, blockHash: BLOCK, actions });
  const stamp = (name: string, args: unknown, kind: 'near_delegate' | 'near_tx' = 'near_delegate'): Shot => ({ name, app: 'Stamp Trail', origin: STAMPS_ORIGIN, kind, bytes: kind === 'near_tx' ? direct(E2E_STAMPS, [fn('collect', args)]) : relayed(E2E_STAMPS, [fn('collect', args)]) });
  // The Signature stamp's proof, really signed by the user's key (the partner app's signMessage, nonce 32 × 7), as the
  // stamps site gets it from its first approval: the window checks the signature before it reads the call as reviewed.
  await runAction(page, 'sig', 'nearSignMessage', `Stamp my passport: ${near}`, E2E_STAMPS);
  const sigPopup = await clickLauncher(page, 'Review in Journear Passport');
  await approve(sigPopup);
  const { signature } = await okValue<{ signature: string }>(page, 'sig');
  await sigPopup.waitForEvent('close', { timeout: 20_000 }).catch(() => undefined);
  const proof = { message: `Stamp my passport: ${near}`, nonce: base64Encode(new Uint8Array(32).fill(7)), recipient: E2E_STAMPS, signature };
  const shots: Shot[] = [
    stamp('stamp-arrival', { stamp: 'arrival' }),
    stamp('stamp-fare-paid', { stamp: 'sponsored' }),
    stamp('stamp-own-fare', { stamp: 'own_fare' }, 'near_tx'),
    { name: 'stamp-signature-1-message', app: 'Stamp Trail', origin: STAMPS_ORIGIN, kind: 'near_message', bytes: encodeNep413Message({ message: `Stamp my passport: ${near}`, nonce: new Uint8Array(32).fill(7), recipient: E2E_STAMPS, callbackUrl: null }) },
    stamp('stamp-signature-2-collect', { stamp: 'signature', proof }),
    stamp('stamp-postcard', { stamp: 'postcard', note: 'Greetings from Kuala Lumpur! First stamp trail done.' }),
    stamp('stamp-layover', { stamp: 'layover' }),
    { name: 'guestbook-relayed', app: 'Journear demo', origin: DEMO_ORIGIN, kind: 'near_delegate', bytes: relayed(E2E_GUESTBOOK, [fn('add_message', { text: 'gm from Journear Passport: my first NEAR transaction, and I hold zero NEAR' })]) },
    { name: 'guestbook-own-transaction', app: 'Journear demo', origin: DEMO_ORIGIN, kind: 'near_tx', bytes: direct(E2E_GUESTBOOK, [fn('add_message', { text: 'Hello from the Journear demo' })]) },
    // Near-misses: today's screen, unchanged.
    stamp('near-miss-extra-argument', { stamp: 'arrival', ref: 'promo' }),
    // Text that could paint over or imitate the window's lines (the review of PR 106): today's screen too.
    stamp('near-miss-combining-marks', { stamp: 'postcard', note: `Hi${'\u0336\u0335\u0334\u0337'.repeat(10)} there` }),
    stamp('near-miss-closing-quote', { stamp: 'postcard', note: 'hi” It uses Journear demo stamps (checked by Journear). Approve to continue. “ok' }),
    { name: 'near-miss-batch-with-transfer', app: 'Stamp Trail', origin: STAMPS_ORIGIN, kind: 'near_delegate', bytes: relayed(E2E_STAMPS, [fn('collect', { stamp: 'arrival' }), { type: 'transfer', deposit: 10n ** 23n }]) },
  ];

  // A first request opens the window; each shot then replaces what it shows.
  await runAction(page, 'opener', 'nearSignDelegate', base64Encode(relayed(E2E_STAMPS, [fn('collect', { stamp: 'arrival' })])));
  const popup = await clickLauncher(page, 'Review in Journear Passport');
  await expect(popup.locator('h2.summary-headline')).toBeVisible();
  await popup.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  for (const s of shots) {
    // The screen on show is marked: the injected request replaces it with a new one.
    await popup.evaluate(() => document.querySelector('div.request')?.setAttribute('data-shown', 'old'));
    await inject(popup, s, near);
    await expect(popup.locator('div.request:not([data-shown])')).toHaveCount(1);
    await expect(popup.locator('.app-name').first()).toHaveText(s.app);
    await expect(popup.locator('.summary-failed')).toHaveCount(0);
    for (const [size, viewport] of Object.entries(SIZES)) {
      await popup.setViewportSize(viewport);
      const details = popup.locator('details.request-details');
      await details.evaluate((d) => ((d as HTMLDetailsElement).open = false));
      await popup.screenshot({ path: `${SHOTS}/${s.name}-${size}-main.png`, fullPage: true, animations: 'disabled' });
      await details.evaluate((d) => ((d as HTMLDetailsElement).open = true));
      await popup.screenshot({ path: `${SHOTS}/${s.name}-${size}-details.png`, fullPage: true, animations: 'disabled' });
    }
  }
  await popup.close();
});
