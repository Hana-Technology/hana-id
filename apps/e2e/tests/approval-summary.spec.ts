// The approval window's plain summary (D808–D812) in the real popup: the details are closed for a request Journear can
// explain and the user can open them; they start open for one it can't; raw signing's can't be folded; every warning
// is visible while the details are closed; opening them doesn't touch the Approve guard.
//
// With HANA_SHOTS_DIR set (Chromium only), `screens for review` also saves each case's window at the real popup's
// size (420 × 680, the whole page) for the founder:
//
//   HANA_SHOTS_DIR=<dir> corepack pnpm exec playwright test --project=chromium tests/approval-summary.spec.ts
import { type Page } from '@playwright/test';
import { type NearAction, base64Encode, encodeNearDelegateAction, encodeNearTransaction, nearImplicitPublicKey } from '@hana-id/core';
import { parseFunctionSignature } from '@hana-id/core/decode';
import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-base';
import { E2E_STAMPS, EVM_CHAIN_ID, NEAR_RPC } from '../src/stack.ts';
import { approve, clickLauncher, expect, login, newApp, newLiveApp, okValue, openPartner, runAction, test } from './fixtures.ts';

const SHOTS = process.env.HANA_SHOTS_DIR;
/** The approval popup's window (`popup,width=420,height=680`, D99). */
const POPUP = { width: 420, height: 680 } as const;

const TOKEN = '0x1111111111111111111111111111111111111111';
const SPENDER = '0x3333333333333333333333333333333333333333';
const RECIPIENT = '0x000000000000000000000000000000000000dEaD';
const word = (v: bigint | string) => (typeof v === 'string' ? v.slice(2).toLowerCase().padStart(64, '0') : v.toString(16).padStart(64, '0'));
const call = (sig: string, ...args: (bigint | string)[]) => `${parseFunctionSignature(sig).selector}${args.map(word).join('')}`;

const evmTx = (over: { to?: string; value?: bigint; data?: string } = {}) => ({
  type: '0x2',
  chainId: `0x${EVM_CHAIN_ID.toString(16)}`,
  nonce: '0x0',
  gas: '0x186a0',
  maxFeePerGas: '0x3b9aca00',
  maxPriorityFeePerGas: '0x1',
  to: over.to ?? RECIPIENT,
  value: `0x${(over.value ?? 10n ** 16n).toString(16)}`,
  data: over.data ?? '0x',
});

async function popupFor(page: Page, name: string, action: string, ...args: unknown[]): Promise<Page> {
  await runAction(page, name, action, ...args);
  const popup = await clickLauncher(page, 'Review in Journear Passport');
  await expect(popup.locator('h2.summary-headline')).toBeVisible();
  return popup;
}

/** Saves the popup at its real size, whole (Chromium, HANA_SHOTS_DIR only). */
async function shot(popup: Page, name: string, browserName: string): Promise<void> {
  if (!SHOTS || browserName !== 'chromium') return;
  await popup.setViewportSize(POPUP);
  await popup.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true, animations: 'disabled' });
}

const details = (popup: Page) => popup.locator('details.request-details');

test('an explainable request: details closed; the user opens them; the guard still holds and Approve signs', async ({ page }) => {
  await openPartner(page, await newApp());
  await login(page);
  const popup = await popupFor(page, 'send', 'ethSignTx', evmTx());
  await expect(popup.locator('h2.summary-headline')).toHaveText(`E2E Partner wants to send 0.01 ETH to ${RECIPIENT}`);
  await expect(popup.getByText('Network fee', { exact: true })).toBeVisible();
  await expect(details(popup)).not.toHaveAttribute('open', '');
  // The nonce is in the details: not visible until the user opens them.
  const nonce = details(popup).getByText('Nonce', { exact: true });
  await expect(nonce).toBeHidden();
  await popup.getByText('Show details', { exact: true }).click();
  await expect(details(popup)).toHaveAttribute('open', '');
  await expect(nonce).toBeVisible();
  await expect(popup.getByText('Hide details', { exact: true })).toBeVisible();
  // Keyboard: the toggle is focusable and Enter folds it again.
  await popup.locator('summary.details-toggle').focus();
  await popup.keyboard.press('Enter');
  await expect(details(popup)).not.toHaveAttribute('open', '');
  await approve(popup);
  expect(await okValue(page, 'send')).toMatchObject({ valid: true });
});

test('a request Journear can’t explain: the plain line, and the details open from the start', async ({ page }) => {
  await openPartner(page, await newApp());
  await login(page);
  const popup = await popupFor(page, 'unknown', 'ethSignTx', evmTx({ to: TOKEN, value: 0n, data: '0xdeadbeef' }));
  await expect(popup.locator('p.summary-warning.cannot-explain')).toContainText('Journear can’t explain this request in plain words');
  await expect(details(popup)).toHaveAttribute('open', '');
  await expect(details(popup).getByText('0xdeadbeef', { exact: true })).toBeVisible();
});

test('warnings stay visible while the details are closed (an unlimited ERC-20 approve)', async ({ page }) => {
  await openPartner(page, await newApp());
  await login(page);
  const popup = await popupFor(page, 'approve', 'ethSignTx', evmTx({ to: TOKEN, value: 0n, data: call('approve(address,uint256)', SPENDER, 2n ** 256n - 1n) }));
  await expect(details(popup)).not.toHaveAttribute('open', '');
  await expect(popup.locator('p.summary-warning.unlimited-spend')).toBeVisible();
  await expect(popup.locator('p.summary-warning.unlimited-spend')).toContainText(`This lets ${SPENDER}, an address Journear hasn’t verified, spend all of your tokens of contract ${TOKEN}, with no limit`);
});

test('raw signing: the details can’t be folded', async ({ page }) => {
  await openPartner(page, await newLiveApp({ settings: { rawSign: 'approval' } }), { live: true });
  await login(page);
  await page.evaluate(() => (window as any).e2e.run('raw', 'signRaw', { chain: 'evm', digest: new Uint8Array(32).fill(3) }));
  const popup = await clickLauncher(page, 'Review in Journear Passport');
  await expect(popup.locator('section.request-details.fixed')).toBeVisible();
  await expect(popup.locator('details')).toHaveCount(0);
  await expect(popup.locator('summary')).toHaveCount(0);
  await expect(popup.getByText(`0x${'03'.repeat(32)}`, { exact: true })).toBeVisible();
  await expect(popup.getByText('Raw signing can authorize any transaction', { exact: false })).toBeVisible();
});

// ---- the founder's screens ----

const NEAR_HEIGHT = 200_000_000n;
const NEAR_BLOCK = new Uint8Array(32).fill(0x2a);

async function nearRpc(method: string, params: Record<string, unknown>): Promise<void> {
  await fetch(NEAR_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
}

/** Approves `popup` and waits for the result, so the next case starts with no window open. */
async function done(page: Page, popup: Page, name: string): Promise<void> {
  await approve(popup);
  await okValue(page, name);
  await popup.waitForEvent('close', { timeout: 20_000 }).catch(() => undefined);
}

test('screens for review', async ({ page, browserName }) => {
  test.skip(!SHOTS || browserName !== 'chromium', 'HANA_SHOTS_DIR, Chromium only');
  test.setTimeout(300_000);
  await openPartner(page, await newApp());
  const { stellar } = await login(page);
  const near = (await page.evaluate(() => (window as any).e2e.addresses().near)) as string;
  const key = { type: 'ed25519' as const, bytes: nearImplicitPublicKey(near) };

  // NEAR: a relayed contract call like the stamps site's, closed and opened; a transfer; NEP-413.
  await nearRpc('e2e_near_activate', { account_id: near });
  const collect: NearAction = { type: 'functionCall', methodName: 'collect', args: new TextEncoder().encode('{"stamp":"arrival"}'), gas: 30_000_000_000_000n, deposit: 0n };
  const delegate = encodeNearDelegateAction({ senderId: near, receiverId: E2E_STAMPS, actions: [collect], nonce: (NEAR_HEIGHT - 1n) * 1_000_000n + 5n, maxBlockHeight: NEAR_HEIGHT + 100n, publicKey: key });
  let popup = await popupFor(page, 'delegate', 'nearSignDelegate', base64Encode(delegate));
  await shot(popup, 'near-relayed-call-closed', browserName);
  await popup.getByText('Show details', { exact: true }).click();
  await shot(popup, 'near-relayed-call-open', browserName);
  await done(page, popup, 'delegate');

  const transfer = encodeNearTransaction({ signerId: near, publicKey: key, nonce: 10n, receiverId: 'bob.testnet', blockHash: NEAR_BLOCK, actions: [{ type: 'transfer', deposit: 10n ** 23n }] });
  popup = await popupFor(page, 'neartx', 'nearSignTx', base64Encode(transfer));
  await shot(popup, 'near-transfer', browserName);
  await done(page, popup, 'neartx');

  popup = await popupFor(page, 'nep413', 'nearSignMessage', 'Sign in to Stamp Trail', 'localhost');
  await shot(popup, 'nep413', browserName);
  await done(page, popup, 'nep413');

  // EVM.
  popup = await popupFor(page, 'send', 'ethSignTx', evmTx());
  await shot(popup, 'evm-plain-send', browserName);
  await done(page, popup, 'send');
  popup = await popupFor(page, 'erc20', 'ethSignTx', evmTx({ to: TOKEN, value: 0n, data: call('transfer(address,uint256)', RECIPIENT, 5_000_000n) }));
  await shot(popup, 'erc20-transfer', browserName);
  await done(page, popup, 'erc20');
  popup = await popupFor(page, 'approve', 'ethSignTx', evmTx({ to: TOKEN, value: 0n, data: call('approve(address,uint256)', SPENDER, 2n ** 256n - 1n) }));
  await shot(popup, 'erc20-unlimited-approve', browserName);
  await done(page, popup, 'approve');
  popup = await popupFor(page, 'unknown', 'ethSignTx', evmTx({ to: TOKEN, value: 0n, data: `0xdeadbeef${word(42n)}` }));
  await shot(popup, 'evm-unknown-call', browserName);
  await done(page, popup, 'unknown');
  const permit = {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'Permit',
    domain: { name: 'Example Token', version: '1', chainId: EVM_CHAIN_ID, verifyingContract: TOKEN },
    message: { owner: (await page.evaluate(() => (window as any).e2e.addresses().evm)) as string, spender: SPENDER, value: (2n ** 256n - 1n).toString(), nonce: '0', deadline: '1900000000' },
  };
  popup = await popupFor(page, 'permit', 'ethSignTypedData', JSON.stringify(permit));
  await shot(popup, 'typed-data-permit', browserName);
  await done(page, popup, 'permit');
  popup = await popupFor(page, 'msg', 'personalSign', 'Welcome to Stamp Trail!\n\nSign this message to prove you own this wallet. It costs nothing.');
  await shot(popup, 'plain-message', browserName);
  await done(page, popup, 'msg');

  // Stellar.
  const other = Keypair.random().publicKey();
  const build = (op: ReturnType<typeof Operation.payment>) => new TransactionBuilder(new Account(stellar, '100'), { fee: '100', networkPassphrase: Networks.TESTNET }).addOperation(op).setTimeout(300).build().toXDR();
  popup = await popupFor(page, 'pay', 'stellarSignXdr', build(Operation.payment({ destination: other, asset: Asset.native(), amount: '1.5' })));
  await shot(popup, 'stellar-payment', browserName);
  await done(page, popup, 'pay');
  popup = await popupFor(page, 'control', 'stellarSignXdr', build(Operation.setOptions({ signer: { ed25519PublicKey: other, weight: 255 } })));
  await shot(popup, 'stellar-account-control', browserName);
  await done(page, popup, 'control');
});

test('screens for review: the mainnet demo', async ({ page, browserName }) => {
  test.skip(!SHOTS || browserName !== 'chromium', 'HANA_SHOTS_DIR, Chromium only');
  await page.context().route('https://horizon.stellar.org/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ balances: [{ asset_type: 'native', balance: '25.0000000' }] }) }),
  );
  await page.context().route('https://mainnet.base.org/**', (route) => route.fulfill({ status: 500, body: 'not in this test' }));
  await openPartner(page, await newApp({ mainnetDemo: true }));
  await login(page);
  const popup = await popupFor(page, 'pubnet', 'stellarSignPubnet', '2');
  await expect(popup.getByText('Real funds, test custody: these funds may be lost')).toBeVisible();
  await shot(popup, 'mainnet-demo-stellar-payment', browserName);
  await done(page, popup, 'pubnet');
});
