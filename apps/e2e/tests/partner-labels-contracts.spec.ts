// Partner labels for NEAR programs and Soroban contracts (D900, piece 5 of D892), on the local stack in every browser.
// A label document in force (written straight to the stack's D1, `/__e2e/labels`; PARTNER_LABELS is on only in the
// stack's API) describes a NEAR program's `collect` or a Soroban contract's `vote`, each tied to its code.
//
// NEAR: the vault reads the program's code hash from both of the env's endpoints (the mocked chain's `rpc` and
// `rpcFallback`, `/__e2e/near-code` sets what each answers). Both the document's hash: the app's box, with its soft verb
// (the call attaches no NEAR), after Journear's amber "acts as you" box; the program's code changed (both answer
// another hash): the amber line, no partner words; the two endpoints disagree: the window exactly as without labels
// (compared, in the browser, with the same request after the label was removed).
// Soroban: no read; the transaction's own footprint names its code. The document's Wasm hash as its one code and only
// the contract's own data written: the box, after Journear's red box; another code: the amber line; a write to a token
// balance under a soft verb: the amber line.
//
// With HANA_SHOTS_DIR (Chromium) each screen is saved at 390 and 1280, light and dark:
//   HANA_SHOTS_DIR=<dir> HANA_E2E_PORT_BASE=44010 corepack pnpm --filter @hana-id/e2e e2e tests/partner-labels-contracts.spec.ts --project=chromium
import { type Page } from '@playwright/test';
import { type NearAction, base64Encode, encodeNearDelegateAction, nearImplicitPublicKey } from '@hana-id/core';
import { Account, Address, Networks, Operation, SorobanDataBuilder, TransactionBuilder, xdr } from '@stellar/stellar-base';
import { API_URL, NEAR_RPC } from '../src/stack.ts';
import { expectEvenDividers } from './divider-checks.ts';
import { type App, clickLauncher, expect, fontsLoaded, login, newApp, openPartner, reject, runAction, test } from './fixtures.ts';

const SHOTS = process.env.HANA_SHOTS_DIR;
const SIZES = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 900 } } as const;
/** The vault keeps a code read as long as a labels read (packages/web vault/partner-labels.ts NEAR_CODE_FRESH_MS). */
const CODE_FRESH_MS = 10_000;
const NEAR_HEIGHT = 200_000_000n;
const TGAS = 1_000_000_000_000n;

/** The program's account: one per browser, since the browsers' tests run at once on one mocked chain. */
const clubOf = (browserName: string) => `e2e-club-${browserName}.testnet`;
const H = 'GKot5hBsd81kMupNCXHaqbhv3huEbxAFMLnpcX2hniwn';
const H2 = '9pjHDkQQ5j37cU8kiVcnebh22788f6vAkS5JAY1pSNvA';
const nearDoc = (club: string) => JSON.stringify({
  schema: 'journear-labels/1',
  context: { near: { network: 'testnet', account: club, codeHash: H } },
  metadata: { enums: { stamp: { sponsored: 'Fare paid', arrival: 'Arrival' } } },
  display: {
    formats: {
      collect: {
        call: { gasAtMost: '30000000000000', args: { stamp: { type: 'string' } } },
        intent: { verb: 'collect', object: 'the stamp' },
        sentence: ['verb', 'object', { field: 'args.stamp' }],
        fields: [{ path: 'args.stamp', label: 'Stamp', format: 'enum', params: { enum: 'stamp' } }],
      },
    },
  },
});

const POLL = Address.contract(Buffer.alloc(32, 0x5a)).toString();
const TOKEN = Address.contract(Buffer.alloc(32, 0x5b)).toString();
const WASM = 'ab'.repeat(32);
const SOROBAN_DOC = JSON.stringify({
  schema: 'journear-labels/1',
  context: { soroban: { networkPassphrase: Networks.TESTNET, contract: POLL, wasmHash: WASM } },
  display: { formats: { vote: { call: { args: [{ name: 'choice', type: 'u32', min: 1, max: 3 }] }, intent: { verb: 'vote', object: 'in the club poll' }, sentence: ['verb', 'object'], fields: [] } } },
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

/** What the mocked chain's two endpoints answer for the club's code (the same unless `fallback` is given). */
async function setCode(club: string, primary: string, fallback?: string): Promise<void> {
  const res = await fetch(`${API_URL}/__e2e/near-code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: club, codeHash: primary, ...(fallback ? { fallbackCodeHash: fallback } : {}) }) });
  expect(res.status).toBe(200);
}

async function nearRpc(method: string, params: Record<string, unknown>): Promise<void> {
  await fetch(NEAR_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
}

/** The window's request content, children in order, by each one's first class (the tag where it has none). */
const order = (popup: Page) => popup.evaluate(() => [...document.querySelector('div.request')!.children].map((c) => c.classList[0] ?? c.tagName.toLowerCase()));

async function popupFor(page: Page, name: string, action: string, arg: string): Promise<Page> {
  await runAction(page, name, action, arg);
  const popup = await clickLauncher(page, 'Review in Journear Passport');
  await expect(popup.locator('h2.summary-headline')).toBeVisible();
  await expect(popup.locator('.summary-failed')).toHaveCount(0);
  return popup;
}

/** Rejects and waits for the window to close by itself, so the next request opens its own (and reads afresh). */
async function finish(popup: Page): Promise<void> {
  await reject(popup);
  await popup.waitForEvent('close', { timeout: 25_000 }).catch(() => undefined);
}

/** The window at a phone's and a desktop's width, light and dark: the divider checks each time, saved with HANA_SHOTS_DIR. */
async function check(popup: Page, name: string, browserName: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await popup.emulateMedia({ colorScheme: scheme });
    for (const [size, viewport] of Object.entries(SIZES)) {
      await popup.setViewportSize(viewport);
      await fontsLoaded(popup);
      if (SHOTS && browserName === 'chromium') await popup.screenshot({ path: `${SHOTS}/${name}-${size}-${scheme}.png`, fullPage: true, animations: 'disabled' });
      await expectEvenDividers(popup, `${name} at ${size}, ${scheme}`, { soft: Boolean(SHOTS) });
      expect.soft(await popup.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${name} ${size}: no sideways scroll`).toBe(true);
    }
  }
  await popup.emulateMedia({ colorScheme: 'light' });
  await popup.setViewportSize({ width: 420, height: 680 });
}

const MISMATCH = (app: string) => `${app} describes this kind of request, but this one doesn’t match, so Journear isn’t showing ${app}’s description. If you’re not sure what this does, reject it.`;

test.describe('partner labels for NEAR programs and Soroban contracts (D900)', () => {
  test('NEAR: the code both endpoints agree on shows the box (a soft verb); a changed code, the amber line; endpoints that disagree, the plain window', async ({ page, browserName }) => {
    test.setTimeout(420_000);
    const app = await newApp({ name: 'Club Trail' });
    const CLUB = clubOf(browserName);
    const labelId = await seedLabel(app, nearDoc(CLUB));
    await setCode(CLUB, H);
    await openPartner(page, app);
    await login(page);
    const near = (await page.evaluate(() => (window as any).e2e.addresses().near)) as string;
    await nearRpc('e2e_near_activate', { account_id: near });
    const key = { type: 'ed25519' as const, bytes: nearImplicitPublicKey(near) };
    const fn = (stamp: string): NearAction => ({ type: 'functionCall', methodName: 'collect', args: new TextEncoder().encode(JSON.stringify({ stamp })), gas: 10n * TGAS, deposit: 0n });
    // One delegate action's bytes, reused (rejected each time, so its nonce is never spent): the same request each time.
    const collect = base64Encode(encodeNearDelegateAction({ senderId: near, receiverId: CLUB, actions: [fn('sponsored')], nonce: (NEAR_HEIGHT - 1n) * 1_000_000n + 5n, maxBlockHeight: NEAR_HEIGHT + 100n, publicKey: key }));

    // 1. Both endpoints answer the document's code hash: the app's box with its soft verb, after the amber box.
    let popup = await popupFor(page, 'collect', 'nearSignDelegate', collect);
    const box = popup.locator('div.partner-label');
    await expect(box.locator('p.partner-says')).toHaveText('Club Trail says: collect the stamp Fare paid');
    await expect(box.locator('p.partner-attribution')).toHaveText('These are Club Trail’s words. Journear hasn’t checked them.');
    await expect(popup.locator('.risk-box.warning-box p.risk-lead')).toHaveText(/^This acts as you/u);
    const kids = await order(popup);
    expect(kids.indexOf('partner-label')).toBeGreaterThan(kids.findIndex((k) => k === 'risk-box'));
    expect(kids.slice(-2)).toEqual(['partner-label', 'request-details']);
    await check(popup, 'near-match-soft-verb', browserName);
    await finish(popup);

    // 2. The program's code changed (both endpoints now answer another hash): once the vault's read is older than its
    //    window, the amber line, never the partner's words.
    await setCode(CLUB, H2);
    await page.waitForTimeout(CODE_FRESH_MS + 500);
    popup = await popupFor(page, 'collect-changed', 'nearSignDelegate', collect);
    await expect(popup.locator('div.partner-label')).toHaveCount(0);
    await expect(popup.locator('.partner-mismatch')).toHaveCount(1);
    await expect(popup.locator('.risk-box.warning-box')).toContainText('Doesn’t match how Club Trail describes this kind of request');
    await check(popup, 'near-code-changed', browserName);
    await finish(popup);

    // 3. The endpoints disagree (the env's rpc the document's hash, its rpcFallback another): no code hash, so the
    //    window is plain, byte for byte the window after the label is gone.
    await setCode(CLUB, H, H2);
    await page.waitForTimeout(CODE_FRESH_MS + 500);
    popup = await popupFor(page, 'collect-disagree', 'nearSignDelegate', collect);
    await expect(popup.locator('div.partner-label, .partner-mismatch')).toHaveCount(0);
    const disagree = await popup.locator('div.request').evaluate((el) => el.outerHTML);
    await check(popup, 'near-endpoints-disagree', browserName);
    await finish(popup);

    await removeLabel(labelId);
    await page.waitForTimeout(CODE_FRESH_MS + 500);
    popup = await popupFor(page, 'collect-plain', 'nearSignDelegate', collect);
    expect(await popup.locator('div.request').evaluate((el) => el.outerHTML)).toBe(disagree);
    await finish(popup);
  });

  test('Soroban: the transaction’s own code shows the box; another code or a write outside the contract under a soft verb, the amber line', async ({ page, browserName }) => {
    test.setTimeout(300_000);
    const app = await newApp({ name: 'Club Poll' });
    await seedLabel(app, SOROBAN_DOC);
    await openPartner(page, app);
    const { stellar } = await login(page);
    const instance = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({ contract: new Address(POLL).toScAddress(), key: xdr.ScVal.scvLedgerKeyContractInstance(), durability: xdr.ContractDataDurability.persistent() }));
    const own = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({ contract: new Address(POLL).toScAddress(), key: xdr.ScVal.scvSymbol('votes'), durability: xdr.ContractDataDurability.persistent() }));
    const balance = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({ contract: new Address(TOKEN).toScAddress(), key: xdr.ScVal.scvSymbol('balance'), durability: xdr.ContractDataDurability.persistent() }));
    const code = (hex: string) => xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: Buffer.from(hex, 'hex') }));
    const vote = (wasm: string, writes: xdr.LedgerKey[] = [own]) => {
      const args = [xdr.ScVal.scvU32(2)];
      const root = new xdr.SorobanAuthorizedInvocation({ function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({ contractAddress: new Address(POLL).toScAddress(), functionName: 'vote', args })), subInvocations: [] });
      const auth = new xdr.SorobanAuthorizationEntry({ credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(), rootInvocation: root });
      const data = new SorobanDataBuilder().setFootprint([instance, code(wasm)], writes).setResourceFee('5000').build();
      return new TransactionBuilder(new Account(stellar, '100'), { fee: '100', networkPassphrase: Networks.TESTNET })
        .addOperation(Operation.invokeContractFunction({ contract: POLL, function: 'vote', args, auth: [auth] }))
        .setSorobanData(data)
        .setTimeout(0)
        .build()
        .toEnvelope()
        .toXDR('base64');
    };

    // 1. The footprint names the document's Wasm hash as its one code, and writes only the poll's own data.
    let popup = await popupFor(page, 'vote', 'stellarSignXdr', vote(WASM));
    await expect(popup.locator('p.partner-says')).toHaveText('Club Poll says: vote in the club poll');
    // Journear's red box (it can't tell what an unknown contract does) stays, above the partner's box.
    await expect(popup.locator('.risk-box.danger-box')).toHaveCount(1);
    const kids = await order(popup);
    expect(kids.indexOf('partner-label')).toBeGreaterThan(kids.indexOf('risk-box'));
    expect(kids.slice(-2)).toEqual(['partner-label', 'request-details']);
    await check(popup, 'soroban-match-soft-verb', browserName);
    await finish(popup);

    // 2. Another code in the footprint: the amber line.
    popup = await popupFor(page, 'vote-changed', 'stellarSignXdr', vote('cd'.repeat(32)));
    await expect(popup.locator('div.partner-label')).toHaveCount(0);
    await expect(popup.locator('.risk-box.warning-box p.risk-lead.partner-mismatch')).toHaveText(MISMATCH('Club Poll'));
    await check(popup, 'soroban-code-changed', browserName);
    await finish(popup);

    // 3. A soft verb over a transaction that may write a token's balance: the amber line.
    popup = await popupFor(page, 'vote-writes', 'stellarSignXdr', vote(WASM, [own, balance]));
    await expect(popup.locator('div.partner-label')).toHaveCount(0);
    await expect(popup.locator('.partner-mismatch')).toHaveCount(1);
    await finish(popup);
  });
});
