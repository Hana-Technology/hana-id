// Partner labels in the approval window (D896, piece 3 of D892, as amended after PR 123's review), on the local stack in
// every browser: an app whose request label is in force (written straight to the stack's D1, `/__e2e/labels`;
// PARTNER_LABELS is on only in the stack's API) asks for Stellar payments. One that matches the label shows "{App} says:
// …" with the attribution, in its own box after everything Journear says (only the details below it); a payment, a path
// payment or any value-moving operation to an account outside the app's address book shows the red line and no partner
// words; a listed account's M… form is still the listed account; a request the label doesn't describe shows the window
// exactly as without labels (compared, in the browser, with the same request after the label was removed and the vault
// read again). The divider checks (divider-checks.ts) run with a label on screen at 390 px and 1280 px, light and dark;
// a long label wraps inside its box with no sideways scrolling.
//
// With HANA_SHOTS_DIR (Chromium) each screen is saved at 390 and 1280, light and dark:
//   HANA_SHOTS_DIR=<dir> HANA_E2E_PORT_BASE=44010 corepack pnpm --filter @hana-id/e2e e2e tests/partner-labels-window.spec.ts --project=chromium
import { type Page } from '@playwright/test';
import { Account, Asset, Keypair, Memo, MuxedAccount, Networks, Operation, TransactionBuilder, type xdr } from '@stellar/stellar-base';
import { API_URL } from '../src/stack.ts';
import { expectEvenDividers } from './divider-checks.ts';
import { type App, approve, clickLauncher, expect, fontsLoaded, login, newApp, okValue, openPartner, reject, runAction, test } from './fixtures.ts';

const SHOTS = process.env.HANA_SHOTS_DIR;
const SIZES = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 900 } } as const;
/** The vault's freshness window for labels (packages/web vault/partner-labels.ts PARTNER_LABELS_FRESH_MS). */
const LABELS_FRESH_MS = 10_000;
/** The app's till (in its address book), another account (not), and an issuer of a "USDC" that isn't Circle's. */
const TILL = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 31)).publicKey();
const STRANGER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 32)).publicKey();
const FAKE_USDC_ISSUER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 33)).publicKey();

/** The payment document: the memo in the sentence by default; `row` puts it in a row of its own instead. */
const paymentDoc = (o: { name?: string; object?: string; label?: string; row?: boolean } = {}) =>
  JSON.stringify({
    schema: 'journear-labels/1',
    context: { stellar: { networkPassphrase: Networks.TESTNET } },
    metadata: { addressBook: [{ account: TILL, name: o.name ?? 'Coffee Club till' }] },
    display: {
      formats: {
        payment: {
          call: { memo: 'text', assets: ['native', `USDC:${FAKE_USDC_ISSUER}`], amountAtMost: '1000000000' },
          intent: { verb: 'pay', object: o.object ?? 'order' },
          sentence: o.row ? ['verb', { word: 'for' }, 'object'] : ['verb', { word: 'for' }, 'object', { field: 'memo' }],
          fields: [{ path: 'memo', label: o.label ?? 'Order', format: 'orderNumber' }],
        },
      },
    },
  });

async function seedLabel(app: App, text: string): Promise<string> {
  const res = await fetch(`${API_URL}/__e2e/labels`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appId: app.appId, text }) });
  if (res.status !== 201) throw new Error(`seeding the label failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { labelId: string }).labelId;
}

async function removeLabel(labelId: string): Promise<void> {
  const res = await fetch(`${API_URL}/__e2e/labels/remove`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ labelId }) });
  expect(await res.json()).toEqual({ removed: 1 });
}

/** When the vault's GET /v1/app reads of the app arrived (the stack's log, `/__e2e/app-reads`). */
async function appReads(app: App): Promise<number[]> {
  return ((await (await fetch(`${API_URL}/__e2e/app-reads?pk=${app.pk}`)).json()) as { reads: number[] }).reads;
}

/** A payment from the user's account (its own sequence), with a text memo by default. */
function payment(source: string, o: { to?: string; asset?: Asset; memo?: Memo; amount?: string } = {}): string {
  return build(source, Operation.payment({ destination: o.to ?? TILL, asset: o.asset ?? Asset.native(), amount: o.amount ?? '2.5' }), o.memo ?? Memo.text('1042'));
}

function build(source: string, op: xdr.Operation, memo?: Memo): string {
  const b = new TransactionBuilder(new Account(source, '100'), { fee: '100', networkPassphrase: Networks.TESTNET }).addOperation(op);
  if (memo) b.addMemo(memo);
  return b.setTimeout(0).build().toEnvelope().toXDR('base64');
}

const createAccount = (source: string) => build(source, Operation.createAccount({ destination: STRANGER, startingBalance: '2' }));

async function popupFor(page: Page, name: string, xdr: string): Promise<Page> {
  await runAction(page, name, 'stellarSignXdr', xdr);
  const popup = await clickLauncher(page, 'Review in Journear Passport');
  await expect(popup.locator('h2.summary-headline')).toBeVisible();
  await expect(popup.locator('.summary-failed')).toHaveCount(0);
  return popup;
}

/** Rejects (or approves) and waits for the window to close by itself, so the next request opens its own. */
async function finish(page: Page, popup: Page, name: string, how: 'approve' | 'reject' = 'reject'): Promise<void> {
  if (how === 'approve') await approve(popup);
  else await reject(popup);
  if (how === 'approve') await okValue(page, name);
  await popup.waitForEvent('close', { timeout: 25_000 }).catch(() => undefined);
}

/** The window's request content, children in order, by each one's first class (the tag where it has none). */
const order = (popup: Page) => popup.evaluate(() => [...document.querySelector('div.request')!.children].map((c) => c.classList[0] ?? c.tagName.toLowerCase()));

/**
 * The window at a phone's and a desktop's width, light and dark: the divider checks each time, saved with HANA_SHOTS_DIR
 * (Chromium). Back to light at the popup's own size after.
 */
async function check(popup: Page, name: string, browserName: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await popup.emulateMedia({ colorScheme: scheme });
    for (const [size, viewport] of Object.entries(SIZES)) {
      await popup.setViewportSize(viewport);
      await fontsLoaded(popup);
      if (SHOTS && browserName === 'chromium') await popup.screenshot({ path: `${SHOTS}/${name}-${size}-${scheme}.png`, fullPage: true, animations: 'disabled' });
      await expectEvenDividers(popup, `${name} at ${size}, ${scheme}`, { soft: Boolean(SHOTS) });
      // Nothing scrolls sideways; the label's box holds everything drawn in it.
      expect.soft(await popup.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${name} ${size}: no sideways scroll`).toBe(true);
      const spill = await popup.evaluate(() => {
        const box = document.querySelector('div.partner-label');
        if (!box) return [];
        const r = box.getBoundingClientRect();
        return [...box.querySelectorAll('*')].map((el) => ({ el, b: el.getBoundingClientRect() })).filter(({ b }) => b.width > 0 && (b.left < r.left - 0.5 || b.right > r.right + 0.5)).map(({ el }) => `${el.tagName.toLowerCase()}.${el.className}`);
      });
      expect.soft(spill, `${name} ${size}: nothing outside the label's box`).toEqual([]);
    }
  }
  await popup.emulateMedia({ colorScheme: 'light' });
  await popup.setViewportSize({ width: 420, height: 680 });
}

test.describe('partner labels in the approval window (D896)', () => {
  test('a label in force: the matching payment, a warning with it, a mismatch, unlisted accounts, a muxed till, a request it doesn’t describe, then removed', async ({ page, browserName }) => {
    test.setTimeout(420_000);
    const app = await newApp({ name: 'Coffee Club' });
    const labelId = await seedLabel(app, paymentDoc());
    await openPartner(page, app);
    const { stellar } = await login(page);

    // 1. Exactly the described payment: the app's box, attributed, after everything Journear says; Approve signs as ever.
    let popup = await popupFor(page, 'pay', payment(stellar));
    const box = popup.locator('div.partner-label');
    await expect(box).toHaveAttribute('role', 'group');
    await expect(box).toHaveAttribute('aria-label', 'What Coffee Club says');
    await expect(box.locator('p.partner-says')).toHaveText('Coffee Club says: pay for order 1042');
    await expect(box.locator('p.partner-attribution')).toHaveText('These are Coffee Club’s words. Journear hasn’t checked them.');
    // The memo is in the sentence (no row repeats it); no partner "To" row.
    await expect(box.locator('dl')).toHaveCount(0);
    await expect(popup.locator('h2.summary-headline')).toHaveText(/^Coffee Club wants to send 2\.5 XLM to /u);
    // Journear's headline, facts and memo row, the test-app note, then the box, then only the details.
    expect(await order(popup)).toEqual(['summary-headline', 'jp-kv', 'headline', 'summary-line', 'jp-kv', 'jp-kv', 'note', 'partner-label', 'request-details']);
    await check(popup, 'with-label', browserName);
    await finish(page, popup, 'pay', 'approve');

    // 2. A warning and a label: the look-alike USDC's amber line stays where it is, the box after everything.
    popup = await popupFor(page, 'pay-usdc', payment(stellar, { asset: new Asset('USDC', FAKE_USDC_ISSUER) }));
    await expect(popup.locator('.risk-box.warning-box p.risk-lead')).toHaveText(/^This is not the USDC Journear knows/u);
    expect((await order(popup)).slice(-2)).toEqual(['partner-label', 'request-details']);
    await check(popup, 'warning-and-label', browserName);
    await finish(page, popup, 'pay-usdc');

    // 3. Described, but not as described (an id memo where the label says text): the amber line, no partner words.
    popup = await popupFor(page, 'pay-id', payment(stellar, { memo: Memo.id('1042') }));
    await expect(popup.locator('div.partner-label')).toHaveCount(0);
    await expect(popup.locator('.risk-box.warning-box p.risk-lead.partner-mismatch')).toHaveText(
      'Coffee Club describes this kind of request, but this one doesn’t match, so Journear isn’t showing Coffee Club’s description. If you’re not sure what this does, reject it.',
    );
    await check(popup, 'mismatch', browserName);
    await finish(page, popup, 'pay-id');

    // 4. A payment to an account the app hasn't listed: the red line under the headline, no partner words.
    const NOT_LISTED = 'This isn’t one of the accounts Coffee Club has listed for payments. If you expected to pay Coffee Club, don’t approve.';
    popup = await popupFor(page, 'pay-stranger', payment(stellar, { to: STRANGER }));
    await expect(popup.locator('div.partner-label')).toHaveCount(0);
    await expect(popup.locator('h2.summary-headline + .risk-box.danger-box p.risk-lead')).toHaveText(NOT_LISTED);
    await expect(popup.getByRole('alert')).toHaveCount(1);
    await expect(popup.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
    await check(popup, 'not-listed', browserName);
    await finish(page, popup, 'pay-stranger');

    // 5. The same money moved as a path payment to that account: red too.
    popup = await popupFor(page, 'path-stranger', build(stellar, Operation.pathPaymentStrictSend({ sendAsset: Asset.native(), sendAmount: '2', destination: STRANGER, destAsset: new Asset('USDC', FAKE_USDC_ISSUER), destMin: '1', path: [] })));
    await expect(popup.locator('.risk-box.danger-box .partner-not-listed')).toHaveCount(1);
    await expect(popup.locator('div.partner-label')).toHaveCount(0);
    await check(popup, 'not-listed-path-payment', browserName);
    await finish(page, popup, 'path-stranger');

    // 6. The till's M… form (an id the till's bookkeeping uses): not red, the box, and Journear's row shows the M… whole.
    const muxedTill = new MuxedAccount(new Account(TILL, '0'), '77').accountId();
    popup = await popupFor(page, 'pay-muxed', payment(stellar, { to: muxedTill }));
    await expect(popup.locator('.partner-not-listed, .partner-mismatch')).toHaveCount(0);
    await expect(popup.locator('p.partner-says')).toHaveText('Coffee Club says: pay for order 1042');
    await expect(popup.locator('dl.id-rows code.id-full')).toHaveText(muxedTill);
    await expect(popup.locator('div.partner-label')).not.toContainText(TILL);
    await finish(page, popup, 'pay-muxed');

    // 7. A request the label doesn't describe (a trust line: nothing moves to anyone).
    const trust = build(stellar, Operation.changeTrust({ asset: new Asset('USDC', FAKE_USDC_ISSUER) }));
    popup = await popupFor(page, 'trust', trust);
    await expect(popup.locator('div.partner-label, .partner-mismatch, .partner-not-listed')).toHaveCount(0);
    const described = await popup.locator('div.request').evaluate((el) => el.outerHTML);
    await finish(page, popup, 'trust');

    // 8. The label removed (a staff switch or block does the same to GET /v1/app). Wait, explicitly, until the vault's
    //    last read is older than its freshness window; the next window then reads again before it shows anything
    //    (checked: a read after the removal), and is plain.
    await removeLabel(labelId);
    const removedAt = Date.now();
    await expect.poll(async () => Date.now() - Math.max(...(await appReads(app))), { timeout: 30_000, intervals: [500] }).toBeGreaterThan(LABELS_FRESH_MS);
    popup = await popupFor(page, 'pay-again', payment(stellar));
    expect((await appReads(app)).some((t) => t > removedAt)).toBe(true);
    await expect(popup.locator('div.partner-label')).toHaveCount(0);
    await check(popup, 'without-label', browserName);
    await finish(page, popup, 'pay-again');
    popup = await popupFor(page, 'trust-again', trust);
    expect(await popup.locator('div.request').evaluate((el) => el.outerHTML)).toBe(described);
    await finish(page, popup, 'trust-again');
    // An account creation to an unlisted account, with no label in force: Journear's window as ever, no red line.
    popup = await popupFor(page, 'create', createAccount(stellar));
    await expect(popup.locator('.partner-not-listed')).toHaveCount(0);
    await finish(page, popup, 'create');
  });

  test('a long label wraps inside its box at a phone’s width, its values whole; its one row', async ({ page, browserName }) => {
    test.setTimeout(180_000);
    const app = await newApp({ name: 'Riverside Coffee Club Kiosk' });
    await seedLabel(app, paymentDoc({ name: 'Riverside Kiosk Coffee Club Till', object: 'the large breakfast set order', label: 'Kiosk order reference', row: true }));
    await openPartner(page, app);
    const { stellar } = await login(page);
    const memo = 'A1B2C3D4E5F6G7H8J9K0L1M2N3P4';
    const popup = await popupFor(page, 'pay-long', payment(stellar, { memo: Memo.text(memo) }));
    const box = popup.locator('div.partner-label');
    await expect(box.locator('p.partner-says')).toHaveText('Riverside Coffee Club Kiosk says: pay for the large breakfast set order');
    await expect(box.locator('dl.partner-fields dt')).toHaveText(['Kiosk order reference']);
    await expect(box.locator('dl.partner-fields dd')).toHaveText(memo);
    await popup.setViewportSize(SIZES.phone);
    const lines = await box.locator('p.partner-says').evaluate((p) => Math.round(p.getBoundingClientRect().height / parseFloat(getComputedStyle(p).lineHeight)));
    expect(lines).toBeGreaterThan(1);
    await check(popup, 'long-text', browserName);
    await finish(page, popup, 'pay-long');
  });
});
