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
//
// Sponsored EVM actions (D850): the real flow, from the partner page's click to the vault's send, and the founder's
// sponsored-*.png screens, are in tests/evm-sponsor.spec.ts (D855). This file keeps one render-level test that injects
// requests the vault would never build (a relayer that isn't the build's), to show the popup's own checks refuse them:
// it opens the popup with an ordinary request, then dispatches a `hana:approve-request` of kind `evm_sponsored` on the
// popup's window as a vault would post it (origin vaultOrigin, source the opener).
import { type Page } from '@playwright/test';
import { type NearAction, base64Encode, encodeNearDelegateAction, encodeNearTransaction, nearImplicitPublicKey, nearPublicKeyString } from '@hana-id/core';
import { parseFunctionSignature } from '@hana-id/core/decode';
import { Account, Address, Asset, Keypair, Networks, Operation, StrKey, TransactionBuilder, nativeToScVal, xdr } from '@stellar/stellar-base';
import { type EvmSponsorSubject, SPONSOR_DELEGATES, encodeSponsorSubject } from '@hana-id/core/evm-sponsor';
import { E2E_SPONSOR_RELAYER, E2E_STAMPS, EVM_CHAIN_ID, NEAR_RPC, PARTNER_ORIGIN, VAULT_ORIGIN } from '../src/stack.ts';
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
  const risk = popup.locator('.danger-box p.risk-lead.summary-warning.cannot-explain');
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
  await expect(popup.locator('.danger-box p.risk-lead.summary-warning.raw-signing')).toHaveText('This asks you to sign something Journear can’t read at all. On EVM chains it could give away control of your account or your funds. Reject unless you are certain.');
  await expect(details(popup)).not.toHaveAttribute('open', '');
  const hex = popup.getByText(`0x${'03'.repeat(32)}`, { exact: true });
  await expect(hex).toBeHidden();
  await shot(popup, 'raw-signing', browserName);
  await popup.getByText('Show details', { exact: true }).click();
  await expect(hex).toBeVisible();
});

// ---- sponsored EVM actions (D831, D850), injected into the real popup ----

/** Posts a sponsored action to the popup as its vault would (see the header). */
async function injectSponsored(popup: Page, subject: EvmSponsorSubject): Promise<void> {
  await popup.evaluate(
    ({ bytes, address, chainId, vaultOrigin, parentOrigin }) => {
      const id = crypto.randomUUID().replace(/-/gu, '');
      const data = { v: 1, t: 'hana:approve-request', id, appName: 'E2E Partner', parentOrigin, kind: 'evm_sponsored', chain: 'evm', address, bytes: new Uint8Array(bytes), context: { chainId }, position: 1, queued: 1 };
      // Firefox refuses a cross-origin window as MessageEventInit's `source`: set it on the event itself.
      const event = new MessageEvent('message', { data, origin: vaultOrigin });
      Object.defineProperty(event, 'source', { value: window.opener });
      window.dispatchEvent(event);
    },
    { bytes: Array.from(encodeSponsorSubject(subject)), address: subject.account, chainId: subject.chainId, vaultOrigin: VAULT_ORIGIN, parentOrigin: PARTNER_ORIGIN },
  );
}

test('a sponsored action: the calls’ own summary and warnings, the fee line, the one-time setup note (render level, D850)', async ({ page }) => {
  await openPartner(page, await newApp());
  await login(page);
  const me = (await page.evaluate(() => (window as any).e2e.addresses().evm)) as `0x${string}`;
  const popup = await popupFor(page, 'send', 'ethSignTx', evmTx());
  const subject = (over: Partial<EvmSponsorSubject>): EvmSponsorSubject => ({
    chainId: EVM_CHAIN_ID,
    account: me,
    delegate: (SPONSOR_DELEGATES[EVM_CHAIN_ID] as { address: `0x${string}` }).address,
    authNonce: null,
    calls: [{ to: TOKEN, value: 0n, data: call('transfer(address,uint256)', RECIPIENT, 5_000_000n) as `0x${string}` }],
    executeNonce: 0n,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
    relayer: E2E_SPONSOR_RELAYER,
    minGas: 100_000n,
    ...over,
  });
  const headline = popup.locator('h2.summary-headline');
  const fee = popup.locator('.summary-facts dt', { hasText: 'Network fee' }).locator('xpath=following-sibling::dd[1]');
  const setup = 'One-time setup: this also turns on free network fees for your account on the local test chain 31337. Your address stays the same and you still approve every action.';

  // First time: a known call and the account's setup.
  await injectSponsored(popup, subject({ authNonce: 0n }));
  await expect(headline).toHaveText(`E2E Partner wants to send tokens of contract ${TOKEN} to ${RECIPIENT}`);
  await expect(fee).toHaveText('none. Journear pays it for you.');
  await expect(popup.locator('.warning-box p.risk-lead.account-setup')).toHaveText(setup);
  await expect(popup.locator('.danger-box')).toHaveCount(0);
  await expect(popup.locator('button.primary')).toBeVisible();
  await expect(details(popup)).not.toHaveAttribute('open', '');
  expect(await popup.locator('body').innerText()).not.toMatch(/upgrade|smart account/iu);
  await popup.getByText('Show details', { exact: true }).click();
  await expect(details(popup).getByText('Account setup (EIP-7702)', { exact: true })).toBeVisible();

  // Later: the same call, no setup note.
  await injectSponsored(popup, subject({ executeNonce: 1n }));
  await expect(headline).toHaveText(`E2E Partner wants to send tokens of contract ${TOKEN} to ${RECIPIENT}`);
  await expect(popup.locator('.risk-box')).toHaveCount(0);
  await expect(fee).toHaveText('none. Journear pays it for you.');

  // A call Journear doesn't recognise (the demo's check-in): the same red line as unsponsored.
  await injectSponsored(popup, subject({ executeNonce: 1n, calls: [{ to: '0xa84BBd91a395ae028eE2890DcA0e20570C1Aa39e', value: 0n, data: '0x183ff085' }] }));
  await expect(popup.locator('.danger-box p.risk-lead.summary-warning.cannot-explain')).toContainText('Journear can’t tell what this request does: it calls a function Journear doesn’t recognise.');

  // An unlimited approve, first time: as alarming as unsponsored, plus the fee line and the setup note.
  await injectSponsored(popup, subject({ authNonce: 0n, calls: [{ to: TOKEN, value: 0n, data: call('approve(address,uint256)', SPENDER, 2n ** 256n - 1n) as `0x${string}` }] }));
  await expect(popup.locator('.danger-box p.risk-lead.summary-warning.unlimited-spend')).toContainText(`This lets ${SPENDER}, an address Journear hasn’t verified, spend all of your tokens of contract ${TOKEN}, with no limit`);
  await expect(popup.locator('.warning-box p.risk-lead.account-setup')).toHaveText(setup);

  // Another relayer than the build's: refused, no Approve.
  await injectSponsored(popup, subject({ relayer: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' }));
  await expect(popup.getByText('Journear can’t read this request, so it can’t be approved.')).toBeVisible();
  await expect(popup.locator('button.primary')).toHaveCount(0);
  await popup.close();
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
  // D814: one red box with the banner only (the key's own line names it whole, so no bullet repeats it) and two
  // grouped lines: the key appears exactly once above the fold.
  await expect(popup.locator('.danger-box')).toHaveCount(1);
  await expect(popup.locator('.danger-box .risk-lead')).toHaveText(/account/u);
  await expect(popup.locator('.danger-box li')).toHaveCount(0);
  const keyText = nearPublicKeyString(new Uint8Array(32).fill(9));
  const aboveFold = await popup.locator('div.request > :not(details)').allTextContents();
  expect(aboveFold.join('\n').split(keyText).length - 1).toBe(1);
  await expect(popup.locator('p.summary-line')).toHaveText([/^Add the full-access key ed25519:[1-9A-HJ-NP-Za-km-z]{43,44} to your account$/u, 'Send NEAR to your account, 99 times (less than 0.000001 NEAR in total)']);
  await shot(popup, 'near-many-actions-danger', browserName);
  await done(page, popup, 'many');

  // Mixed recipients (D814): a NEAR transaction has one receiver, so this uses a token's transfers: three to someone
  // else, two to the user's own account, and one other call; grouped by recipient, others first.
  const ft = (to: string, amount: string): NearAction => ({ type: 'functionCall', methodName: 'ft_transfer', args: new TextEncoder().encode(JSON.stringify({ receiver_id: to, amount })), gas: 30_000_000_000_000n, deposit: 1n });
  const mixed: NearAction[] = [ft('bob.testnet', '1000'), ft(near, '50'), ft('bob.testnet', '2000'), { type: 'functionCall', methodName: 'ping', args: new TextEncoder().encode('{}'), gas: 30_000_000_000_000n, deposit: 0n }, ft(near, '25'), ft('bob.testnet', '3000')];
  popup = await popupFor(page, 'mixed', 'nearSignTx', base64Encode(encodeNearTransaction({ signerId: near, publicKey: key, nonce: 12n, receiverId: 'usdc.testnet', blockHash: NEAR_BLOCK, actions: mixed })));
  await expect(popup.locator('p.summary-line')).toHaveText([
    'Send 6,000 (smallest units) of the token usdc.testnet to bob.testnet in 3 transfers',
    'Use usdc.testnet (ping)',
    'Send 75 (smallest units) of the token usdc.testnet to your account in 2 transfers',
  ]);
  await shot(popup, 'near-mixed-recipients', browserName);
  await done(page, popup, 'mixed');

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
  // One step: the banner, and the headline naming the signer whole; no bullet repeats it.
  await expect(popup.locator('.danger-box li')).toHaveCount(0);
  await expect(popup.locator('h2.summary-headline')).toContainText(`add ${other} as a signer with weight 255`);
  await shot(popup, 'stellar-account-control', browserName);
  await done(page, popup, 'control');
  // Six steps that move nothing, then a payment: the payment is listed first, with the XLM leaving (review 2, N2).
  const manySteps = new TransactionBuilder(new Account(stellar, '100'), { fee: '700', networkPassphrase: Networks.TESTNET });
  for (let i = 0; i < 6; i++) manySteps.addOperation(Operation.bumpSequence({ bumpTo: '99' }));
  manySteps.addOperation(Operation.payment({ destination: other, asset: Asset.native(), amount: '1000000' }));
  popup = await popupFor(page, 'many-steps', 'stellarSignXdr', manySteps.setTimeout(300).build().toXDR());
  await expect(popup.locator('p.summary-line').nth(1)).toHaveText(`Send 1,000,000 XLM to ${other}`);
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
  await expect(popup.locator('.danger-box .summary-warning.cannot-explain')).toBeVisible();
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
