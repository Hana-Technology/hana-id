// The approval window's plain summary (D808–D813) in the real popup: the details always start closed and the user
// can open them; a request Journear can't explain, raw signing included, states its risk in view; every warning is
// visible while the details are closed; opening them doesn't touch the Approve guard.
//
// With HANA_SHOTS_DIR set (Chromium only), `screens for review` also saves each case's window at the real popup's
// size (420 × 680, the whole page) for the founder:
//
//   HANA_SHOTS_DIR=<dir> corepack pnpm exec playwright test --project=chromium tests/approval-summary.spec.ts
//
// The details always start folded (D810, the founder's decision); a request Journear can't explain states its risk
// above them.
import { type Page } from '@playwright/test';
import { type NearAction, base64Encode, encodeNearDelegateAction, encodeNearTransaction, nearImplicitPublicKey } from '@hana-id/core';
import { parseFunctionSignature } from '@hana-id/core/decode';
import { Account, Address, Asset, Keypair, Networks, Operation, StrKey, TransactionBuilder, nativeToScVal, xdr } from '@stellar/stellar-base';
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
  // A valid request never gets the catch-all summary (review 3): every case here checks it.
  await expect(popup.locator('.summary-failed')).toHaveCount(0);
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

test('a request Journear can’t explain: the red risk line in view, the details folded until the user opens them (D810)', async ({ page }) => {
  await openPartner(page, await newApp());
  await login(page);
  const popup = await popupFor(page, 'unknown', 'ethSignTx', evmTx({ to: TOKEN, value: 0n, data: '0xdeadbeef' }));
  const risk = popup.locator('p.summary-warning.cannot-explain.jp-alert-danger');
  await expect(risk).toBeVisible();
  await expect(risk).toContainText('Journear can’t tell what this request does');
  await expect(details(popup)).not.toHaveAttribute('open', '');
  const raw = details(popup).getByText('0xdeadbeef', { exact: true });
  await expect(raw).toBeHidden();
  await popup.getByText('Show details', { exact: true }).click();
  await expect(raw).toBeVisible();
});

test('warnings stay visible while the details are closed (an unlimited ERC-20 approve)', async ({ page }) => {
  await openPartner(page, await newApp());
  await login(page);
  const popup = await popupFor(page, 'approve', 'ethSignTx', evmTx({ to: TOKEN, value: 0n, data: call('approve(address,uint256)', SPENDER, 2n ** 256n - 1n) }));
  await expect(details(popup)).not.toHaveAttribute('open', '');
  await expect(popup.locator('p.summary-warning.unlimited-spend')).toBeVisible();
  await expect(popup.locator('p.summary-warning.unlimited-spend')).toContainText(`This lets ${SPENDER}, an address Journear hasn’t verified, spend all of your tokens of contract ${TOKEN}, with no limit`);
});

test('raw signing: folded like any other request, the red risk line in view (D810)', async ({ page, browserName }) => {
  await openPartner(page, await newLiveApp({ settings: { rawSign: 'approval' } }), { live: true });
  await login(page);
  await page.evaluate(() => (window as any).e2e.run('raw', 'signRaw', { chain: 'evm', digest: new Uint8Array(32).fill(3) }));
  const popup = await clickLauncher(page, 'Review in Journear Passport');
  await expect(popup.locator('p.summary-warning.raw-signing.jp-alert-danger')).toHaveText('This asks you to sign something Journear can’t read at all. On EVM chains it could give away control of your account or your funds. Reject unless you are certain.');
  await expect(details(popup)).not.toHaveAttribute('open', '');
  const hex = popup.getByText(`0x${'03'.repeat(32)}`, { exact: true });
  await expect(hex).toBeHidden();
  await shot(popup, 'raw-signing', browserName);
  await popup.getByText('Show details', { exact: true }).click();
  await expect(hex).toBeVisible();
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

  // Many harmless actions and one full-access key: the red banner stays under the headline (review M2).
  const many: NearAction[] = [...Array.from({ length: 99 }, (): NearAction => ({ type: 'transfer', deposit: 1n })), { type: 'addKey', publicKey: { type: 'ed25519', bytes: new Uint8Array(32).fill(9) }, accessKey: { nonce: 0n, permission: { type: 'fullAccess' } } }];
  popup = await popupFor(page, 'many', 'nearSignTx', base64Encode(encodeNearTransaction({ signerId: near, publicKey: key, nonce: 11n, receiverId: near, blockHash: NEAR_BLOCK, actions: many })));
  await shot(popup, 'near-many-actions-danger', browserName);
  await done(page, popup, 'many');

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
  popup = await popupFor(page, 'nft0', 'ethSignTx', evmTx({ to: TOKEN, value: 0n, data: call('approve(address,uint256)', SPENDER, 0n) }));
  await shot(popup, 'erc721-approve-zero', browserName);
  await done(page, popup, 'nft0');
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
  // Six steps that move nothing, then a payment: the payment is listed first, with the XLM leaving (review 2, N2).
  const manySteps = new TransactionBuilder(new Account(stellar, '100'), { fee: '700', networkPassphrase: Networks.TESTNET });
  for (let i = 0; i < 6; i++) manySteps.addOperation(Operation.bumpSequence({ bumpTo: '99' }));
  manySteps.addOperation(Operation.payment({ destination: other, asset: Asset.native(), amount: '1000000' }));
  popup = await popupFor(page, 'many-steps', 'stellarSignXdr', manySteps.setTimeout(300).build().toXDR());
  await expect(popup.locator('p.summary-line').nth(1)).toHaveText(`7. Send 1,000,000 XLM to ${other}`);
  await shot(popup, 'stellar-many-steps-payment', browserName);
  await done(page, popup, 'many-steps');
  const junk = new Asset('USDC', Keypair.random().publicKey());
  popup = await popupFor(page, 'offer', 'stellarSignXdr', build(Operation.manageSellOffer({ selling: Asset.native(), buying: junk, amount: '100', price: { n: 1, d: 10000 } })));
  await shot(popup, 'stellar-offer', browserName);
  await done(page, popup, 'offer');
  // A token-shaped call on one contract whose authorization also moves another token (review H1): details open.
  const contract = (n: number) => StrKey.encodeContract(Buffer.alloc(32, n));
  const sc = (a: string) => nativeToScVal(a, { type: 'address' });
  const amount = (n: bigint) => nativeToScVal(n, { type: 'i128' });
  const inv = (c: string, fn: string, args: xdr.ScVal[], subs: xdr.SorobanAuthorizedInvocation[] = []) =>
    new xdr.SorobanAuthorizedInvocation({ function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({ contractAddress: new Address(c).toScAddress(), functionName: fn, args })), subInvocations: subs });
  const callArgs = [sc(stellar), sc(other), amount(1n)];
  const auth = new xdr.SorobanAuthorizationEntry({ credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(), rootInvocation: inv(contract(3), 'transfer', callArgs, [inv(contract(2), 'transfer', [sc(stellar), sc(other), amount(10n ** 15n)])]) });
  popup = await popupFor(page, 'nested', 'stellarSignXdr', build(Operation.invokeContractFunction({ contract: contract(3), function: 'transfer', args: callArgs, auth: [auth] }) as never));
  await expect(details(popup)).not.toHaveAttribute('open', '');
  await expect(popup.locator('p.summary-warning.cannot-explain.jp-alert-danger')).toBeVisible();
  await shot(popup, 'soroban-nested-transfer', browserName);
  await done(page, popup, 'nested');
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
