// The approval window's screens for the plain-wording review (D853, D858–D860), saved for the founder at the real
// popup's size (420 × 680, the whole page); D884's (where the network fee is) also at 390 px and with the details
// open. Runs only with HANA_SHOTS_DIR set, in Chromium:
//
//   HANA_SHOTS_DIR=<dir> corepack pnpm exec playwright test --project=chromium tests/approval-plain-shots.spec.ts
//
// What each screen says is checked in tests/approval-summary.spec.ts and the unit tests; this spec only saves them.
import { type Page } from '@playwright/test';
import { DEMO_CHECK_IN, type NearAction, approvalContent, base64Encode, encodeNearDelegateAction, encodeNearTransaction, nearImplicitPublicKey } from '@hana-id/core';
import { parseFunctionSignature } from '@hana-id/core/decode';
import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-base';
import { type EvmSponsorSubject, SPONSOR_DELEGATES, encodeSponsorSubject } from '@hana-id/core/evm-sponsor';
import { e2eRelayer } from '../src/relayer-key.ts';
import { E2E_STAMPS, EVM_CHAIN_ID, NEAR_RPC, PARTNER_ORIGIN, VAULT_ORIGIN } from '../src/stack.ts';
import { approve, clickLauncher, expect, login, newApp, newLiveApp, okValue, openPartner, reject, runAction, test } from './fixtures.ts';

const SHOTS = process.env.HANA_SHOTS_DIR;
const POPUP = { width: 420, height: 680 } as const;

const UNLISTED = '0x1111111111111111111111111111111111111111';
const SPENDER = '0x3333333333333333333333333333333333333333';
const RECIPIENT = '0x000000000000000000000000000000000000dEaD';
/** Circle's USDC on Base Sepolia (developers.circle.com, read 2026-11-18). */
const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const BASE_SEPOLIA = 84532;
const word = (v: bigint | string) => (typeof v === 'string' ? v.slice(2).toLowerCase().padStart(64, '0') : v.toString(16).padStart(64, '0'));
const call = (sig: string, ...args: (bigint | string)[]) => `${parseFunctionSignature(sig).selector}${args.map(word).join('')}`;

const evmTx = (over: { to?: string; value?: bigint; data?: string; chainId?: number } = {}) => ({
  type: '0x2',
  chainId: `0x${(over.chainId ?? EVM_CHAIN_ID).toString(16)}`,
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
  await expect(popup.locator('.summary-failed')).toHaveCount(0);
  return popup;
}

async function shot(popup: Page, name: string): Promise<void> {
  await popup.setViewportSize(POPUP);
  await popup.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true, animations: 'disabled' });
}

const SIZES = { phone: { width: 390, height: 844 }, popup: POPUP } as const;

/** A screen at both sizes, folded and then with the details open (D884). */
async function feeShots(popup: Page, name: string): Promise<void> {
  const details = popup.locator('details.request-details');
  for (const open of [false, true]) {
    if (open) await popup.locator('summary.details-toggle').click();
    await expect(details).toHaveJSProperty('open', open);
    for (const [size, viewport] of Object.entries(SIZES)) {
      await popup.setViewportSize(viewport);
      await popup.screenshot({ path: `${SHOTS}/${name}-${open ? 'details' : 'main'}-${size}.png`, fullPage: true, animations: 'disabled' });
    }
  }
}

async function done(page: Page, popup: Page, name: string): Promise<void> {
  await approve(popup);
  await okValue(page, name);
  await popup.waitForEvent('close', { timeout: 20_000 }).catch(() => undefined);
}

async function nearRpc(method: string, params: Record<string, unknown>): Promise<void> {
  await fetch(NEAR_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
}

/** Posts a request to the popup as its vault would (origin vaultOrigin, source the opener): the screen is the real one. */
async function inject(popup: Page, kind: string, bytes: Uint8Array, address: string, chainId: number): Promise<void> {
  await popup.evaluate(
    ({ kind, bytes, address, chainId, vaultOrigin, parentOrigin }) => {
      const id = crypto.randomUUID().replace(/-/gu, '');
      const data = { v: 1, t: 'hana:approve-request', id, appName: 'E2E Partner', parentOrigin, kind, chain: 'evm', address, bytes: new Uint8Array(bytes), context: { chainId }, position: 1, queued: 1, testApp: true };
      const event = new MessageEvent('message', { data, origin: vaultOrigin });
      Object.defineProperty(event, 'source', { value: window.opener });
      window.dispatchEvent(event);
    },
    { kind, bytes: Array.from(bytes), address, chainId, vaultOrigin: VAULT_ORIGIN, parentOrigin: PARTNER_ORIGIN },
  );
}

const NEAR_HEIGHT = 200_000_000n;
const NEAR_BLOCK = new Uint8Array(32).fill(0x2a);
const collect: NearAction = { type: 'functionCall', methodName: 'collect', args: new TextEncoder().encode('{"stamp":"arrival"}'), gas: 30_000_000_000_000n, deposit: 0n };

test.describe('plain-wording screens', () => {
  test.skip(({ browserName }) => !SHOTS || browserName !== 'chromium', 'HANA_SHOTS_DIR, Chromium only');
  test.setTimeout(300_000);

  test('a test app', async ({ page }) => {
    await openPartner(page, await newApp());
    const { stellar } = await login(page);
    const near = (await page.evaluate(() => (window as any).e2e.addresses().near)) as string;
    const me = (await page.evaluate(() => (window as any).e2e.addresses().evm)) as `0x${string}`;
    const key = { type: 'ed25519' as const, bytes: nearImplicitPublicKey(near) };

    // The stamps demo's relayed call (D858).
    await nearRpc('e2e_near_activate', { account_id: near });
    const delegate = encodeNearDelegateAction({ senderId: near, receiverId: E2E_STAMPS, actions: [collect], nonce: (NEAR_HEIGHT - 1n) * 1_000_000n + 5n, maxBlockHeight: NEAR_HEIGHT + 100n, publicKey: key });
    let popup = await popupFor(page, 'delegate', 'nearSignDelegate', base64Encode(delegate));
    await shot(popup, 'near-stamp-relayed-test-app');
    await done(page, popup, 'delegate');

    // A full-access key on the user's own account.
    const fullKey: NearAction = { type: 'addKey', publicKey: { type: 'ed25519', bytes: new Uint8Array(32).fill(9) }, accessKey: { nonce: 0n, permission: { type: 'fullAccess' } } };
    popup = await popupFor(page, 'key', 'nearSignTx', base64Encode(encodeNearTransaction({ signerId: near, publicKey: key, nonce: 11n, receiverId: near, blockHash: NEAR_BLOCK, actions: [fullKey] })));
    await shot(popup, 'near-full-access-key');
    await done(page, popup, 'key');

    // EVM: a listed token (USDC on Base Sepolia), an unlisted one, an unlimited permission, an unknown call.
    // The partner page knows only the local chain: the Base Sepolia transfer is posted to the popup as its vault would.
    popup = await popupFor(page, 'send', 'ethSignTx', evmTx());
    const usdc = approvalContent({ v: 1, id: 'shot', method: 'eth_signTransaction', params: { tx: evmTx({ chainId: BASE_SEPOLIA, to: BASE_SEPOLIA_USDC, value: 0n, data: call('transfer(address,uint256)', RECIPIENT, 5_000_000n) }) as never } });
    await inject(popup, 'evm_tx', usdc.bytes, me, BASE_SEPOLIA);
    await expect(popup.locator('h2.summary-headline')).toContainText('5 USDC');
    await shot(popup, 'evm-listed-token-transfer');
    await popup.close();
    await okValue(page, 'send').catch(() => undefined);
    popup = await popupFor(page, 'erc20', 'ethSignTx', evmTx({ to: UNLISTED, value: 0n, data: call('transfer(address,uint256)', RECIPIENT, 5_000_000n) }));
    await shot(popup, 'evm-unlisted-token-transfer');
    await done(page, popup, 'erc20');
    popup = await popupFor(page, 'approve', 'ethSignTx', evmTx({ to: UNLISTED, value: 0n, data: call('approve(address,uint256)', SPENDER, 2n ** 256n - 1n) }));
    await shot(popup, 'evm-unlimited-permission');
    await done(page, popup, 'approve');
    popup = await popupFor(page, 'unknown', 'ethSignTx', evmTx({ to: UNLISTED, value: 0n, data: `0xdeadbeef${word(42n)}` }));
    await shot(popup, 'evm-unknown-call');
    await done(page, popup, 'unknown');

    // Stellar payment.
    const other = Keypair.random().publicKey();
    const xdrOf = (op: ReturnType<typeof Operation.payment>) => new TransactionBuilder(new Account(stellar, '100'), { fee: '100', networkPassphrase: Networks.TESTNET }).addOperation(op).setTimeout(300).build().toXDR();
    popup = await popupFor(page, 'pay', 'stellarSignXdr', xdrOf(Operation.payment({ destination: other, asset: Asset.native(), amount: '1.5' })));
    await shot(popup, 'stellar-payment');
    await done(page, popup, 'pay');

    // The sponsored check-in (injected as its vault would post it: approval-summary.spec.ts).
    popup = await popupFor(page, 'send', 'ethSignTx', evmTx());
    const subject: EvmSponsorSubject = {
      chainId: EVM_CHAIN_ID,
      account: me,
      delegate: (SPONSOR_DELEGATES[EVM_CHAIN_ID] as { address: `0x${string}` }).address,
      authNonce: 0n,
      calls: [{ to: (DEMO_CHECK_IN[EVM_CHAIN_ID] as { address: `0x${string}` }).address, value: 0n, data: '0x183ff085' }],
      executeNonce: 0n,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
      relayer: e2eRelayer().address,
      minGas: 100_000n,
    };
    await inject(popup, 'evm_sponsored', encodeSponsorSubject(subject), me, EVM_CHAIN_ID);
    await expect(popup.locator('h2.summary-headline')).toHaveText('E2E Partner wants to check you in');
    await shot(popup, 'sponsored-check-in');

    // Reject it: the result screen.
    await reject(popup);
    await expect(popup.locator('h1.outcome')).toBeVisible();
    await shot(popup, 'rejected-result');
  });

  // D884: where the network fee is, free or not. Each screen at a phone's width (390 px) and at the popup's size, the
  // main view and then the details open: `{name}-{main|details}-{phone|popup}.png`.
  test('the network fee, free and not (D884)', async ({ page }) => {
    await openPartner(page, await newApp());
    const { stellar } = await login(page);
    const near = (await page.evaluate(() => (window as any).e2e.addresses().near)) as string;
    const me = (await page.evaluate(() => (window as any).e2e.addresses().evm)) as `0x${string}`;
    const key = { type: 'ed25519' as const, bytes: nearImplicitPublicKey(near) };
    await nearRpc('e2e_near_activate', { account_id: near });

    // Not free: an EVM send the user pays for.
    let popup = await popupFor(page, 'send', 'ethSignTx', evmTx());
    await feeShots(popup, 'fee-evm-send');

    // Free: the sponsored check-in, first time (the amber setup box) and later; an unlimited permission (a red box).
    const subject = (over: Partial<EvmSponsorSubject>): EvmSponsorSubject => ({
      chainId: EVM_CHAIN_ID,
      account: me,
      delegate: (SPONSOR_DELEGATES[EVM_CHAIN_ID] as { address: `0x${string}` }).address,
      authNonce: null,
      calls: [{ to: (DEMO_CHECK_IN[EVM_CHAIN_ID] as { address: `0x${string}` }).address, value: 0n, data: '0x183ff085' }],
      executeNonce: 1n,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
      relayer: e2eRelayer().address,
      minGas: 100_000n,
      ...over,
    });
    await inject(popup, 'evm_sponsored', encodeSponsorSubject(subject({ authNonce: 0n, executeNonce: 0n })), me, EVM_CHAIN_ID);
    await expect(popup.locator('.warning-box p.risk-lead.account-setup')).toBeVisible();
    await feeShots(popup, 'fee-sponsored-check-in-first');
    await inject(popup, 'evm_sponsored', encodeSponsorSubject(subject({})), me, EVM_CHAIN_ID);
    await expect(popup.locator('.risk-box')).toHaveCount(0);
    await feeShots(popup, 'fee-sponsored-check-in-later');
    await inject(popup, 'evm_sponsored', encodeSponsorSubject(subject({ calls: [{ to: UNLISTED, value: 0n, data: call('approve(address,uint256)', SPENDER, 2n ** 256n - 1n) as `0x${string}` }] })), me, EVM_CHAIN_ID);
    await expect(popup.locator('.danger-box')).toBeVisible();
    await feeShots(popup, 'fee-sponsored-unlimited-permission');
    await popup.close();
    await okValue(page, 'send').catch(() => undefined);

    // Free: the stamps demo's relayed call (D858), and one that attaches NEAR (someone else's, nearcore).
    const delegate = (actions: NearAction[], n: bigint) =>
      base64Encode(encodeNearDelegateAction({ senderId: near, receiverId: E2E_STAMPS, actions, nonce: (NEAR_HEIGHT - 1n) * 1_000_000n + n, maxBlockHeight: NEAR_HEIGHT + 100n, publicKey: key }));
    popup = await popupFor(page, 'delegate', 'nearSignDelegate', delegate([collect], 7n));
    await feeShots(popup, 'fee-near-relayed');
    await done(page, popup, 'delegate');
    popup = await popupFor(page, 'attached', 'nearSignDelegate', delegate([{ ...collect, deposit: 10n ** 24n }], 8n));
    await feeShots(popup, 'fee-near-relayed-attaches-near');
    await done(page, popup, 'attached');

    // Not free: a NEAR transfer the user signs and pays for.
    popup = await popupFor(page, 'near', 'nearSignTx', base64Encode(encodeNearTransaction({ signerId: near, publicKey: key, nonce: 12n, receiverId: E2E_STAMPS, blockHash: NEAR_BLOCK, actions: [{ type: 'transfer', deposit: 10n ** 24n }] })));
    await feeShots(popup, 'fee-near-transfer');
    await done(page, popup, 'near');

    // Not free: a Stellar payment.
    const xdr = new TransactionBuilder(new Account(stellar, '100'), { fee: '100', networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.payment({ destination: Keypair.random().publicKey(), asset: Asset.native(), amount: '1.5' }))
      .setTimeout(300)
      .build()
      .toXDR();
    popup = await popupFor(page, 'pay', 'stellarSignXdr', xdr);
    await feeShots(popup, 'fee-stellar-payment');
    await done(page, popup, 'pay');
  });

  test('a live app', async ({ page }) => {
    await openPartner(page, await newLiveApp(), { live: true });
    await login(page);
    const near = (await page.evaluate(() => (window as any).e2e.addresses().near)) as string;
    const key = { type: 'ed25519' as const, bytes: nearImplicitPublicKey(near) };
    await nearRpc('e2e_near_activate', { account_id: near });
    const delegate = encodeNearDelegateAction({ senderId: near, receiverId: E2E_STAMPS, actions: [collect], nonce: (NEAR_HEIGHT - 1n) * 1_000_000n + 5n, maxBlockHeight: NEAR_HEIGHT + 100n, publicKey: key });
    const popup = await popupFor(page, 'delegate', 'nearSignDelegate', base64Encode(delegate));
    await shot(popup, 'near-stamp-relayed-live-app');
    await done(page, popup, 'delegate');
  });
});
