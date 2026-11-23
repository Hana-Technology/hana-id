// The approval and consent windows' dividers (D884's note, 2026-11-23): wherever two ruled blocks meet there is one
// line with the same space on each side, no rule against a box's border or a group's edge, and no ruled block around
// nothing (tests/divider-checks.ts measures what the browser draws). The founder's case first: the sponsored check-in,
// where the "Program" row's rule and the "Network" row's rule were two lines 12 px apart. Then a few windows that put
// each kind of neighbour next to a ruled block: a red box with its own rows, a quoted note, a signed message's box (and
// one Journear can't read), the user's own transaction's actions, a Stellar payment and the consent screen's contract
// lines; and batches, where every operation after the first must keep its own rule whatever the one before ends with
// (a sponsored batch whose first call Journear can't read, a NEAR call with JSON and with non-JSON arguments then a
// transfer, two Stellar operations, a Soroban call whose authorization holds another). Each at a phone's width
// (390 px) and the desktop popup's size (420 × 680), folded and with the details open.
import { type Page } from '@playwright/test';
import { DEMO_CHECK_IN, type NearAction, base64Encode, encodeNearDelegateAction, encodeNearTransaction, nearImplicitPublicKey } from '@hana-id/core';
import { parseFunctionSignature } from '@hana-id/core/decode';
import { type EvmSponsorSubject, SPONSOR_DELEGATES, encodeSponsorSubject } from '@hana-id/core/evm-sponsor';
import { Account, Address, Asset, Keypair, Networks, Operation, StrKey, TransactionBuilder, nativeToScVal, xdr } from '@stellar/stellar-base';
import { e2eRelayer } from '../src/relayer-key.ts';
import { E2E_STAMPS, EVM_CHAIN_ID, NEAR_RPC, PARTNER_ORIGIN, VAULT_ORIGIN } from '../src/stack.ts';
import { expectEvenDividers } from './divider-checks.ts';
import { approve, clickLauncher, expect, fontsLoaded, login, newApp, okValue, openPartner, runAction, test } from './fixtures.ts';

const SIZES = { phone: { width: 390, height: 844 }, popup: { width: 420, height: 680 } } as const;
const UNLISTED = '0x1111111111111111111111111111111111111111';
const SPENDER = '0x3333333333333333333333333333333333333333';
const NEAR_HEIGHT = 200_000_000n;
const word = (v: bigint | string) => (typeof v === 'string' ? v.slice(2).toLowerCase().padStart(64, '0') : v.toString(16).padStart(64, '0'));
const call = (sig: string, ...args: (bigint | string)[]) => `${parseFunctionSignature(sig).selector}${args.map(word).join('')}` as `0x${string}`;
const evmTx = { type: '0x2', chainId: `0x${EVM_CHAIN_ID.toString(16)}`, nonce: '0x0', gas: '0x186a0', maxFeePerGas: '0x3b9aca00', maxPriorityFeePerGas: '0x1', to: '0x000000000000000000000000000000000000dEaD', value: '0x2386f26fc10000', data: '0x' };

const SHOTS = process.env.HANA_SHOTS_DIR;

/**
 * The window on show, at both sizes, folded and open. With HANA_SHOTS_DIR (Chromium) each is also saved first, as
 * `dividers-{name}-{phone|popup}-{main|details}.png` (the same spec run with the old stylesheet saves the "before").
 */
async function check(popup: Page, name: string, browserName: string): Promise<void> {
  for (const [size, viewport] of Object.entries(SIZES)) {
    await popup.setViewportSize(viewport);
    if (SHOTS && browserName === 'chromium') {
      const details = popup.locator('details.request-details');
      const has = (await details.count()) > 0;
      for (const open of has ? [false, true] : [false]) {
        if (has) await details.evaluate((d, o) => ((d as HTMLDetailsElement).open = o), open);
        await fontsLoaded(popup);
        await popup.screenshot({ path: `${SHOTS}/dividers-${name}-${size}-${open ? 'details' : 'main'}.png`, fullPage: true, animations: 'disabled' });
      }
      if (has) await details.evaluate((d) => ((d as HTMLDetailsElement).open = false));
    }
    // Saving screens, a failure is recorded and the run goes on, so every screen is saved.
    await expectEvenDividers(popup, `${name} at ${size}`, { soft: Boolean(SHOTS) });
  }
}

async function popupFor(page: Page, name: string, action: string, ...args: unknown[]): Promise<Page> {
  await runAction(page, name, action, ...args);
  const popup = await clickLauncher(page, 'Review in Journear Passport');
  await expect(popup.locator('h2.summary-headline, h1').first()).toBeVisible();
  return popup;
}

async function done(page: Page, popup: Page, name: string, label: 'Approve' | 'Allow' = 'Approve'): Promise<void> {
  await approve(popup, label);
  await okValue(page, name);
  await popup.waitForEvent('close', { timeout: 20_000 }).catch(() => undefined);
}

/** Posts a sponsored EVM request to the window as its vault would (approval-plain-shots.spec.ts): the real screen. */
async function injectSponsored(popup: Page, subject: EvmSponsorSubject): Promise<void> {
  await popup.evaluate(() => document.querySelector('div.request')?.setAttribute('data-shown', 'old'));
  await popup.evaluate(
    ({ bytes, address, chainId, vaultOrigin, parentOrigin }) => {
      const id = crypto.randomUUID().replace(/-/gu, '');
      const data = { v: 1, t: 'hana:approve-request', id, appName: 'E2E Partner', parentOrigin, kind: 'evm_sponsored', chain: 'evm', address, bytes: new Uint8Array(bytes), context: { chainId }, position: 1, queued: 1, testApp: true };
      const event = new MessageEvent('message', { data, origin: vaultOrigin });
      Object.defineProperty(event, 'source', { value: window.opener });
      window.dispatchEvent(event);
    },
    { bytes: Array.from(encodeSponsorSubject(subject)), address: subject.account, chainId: subject.chainId, vaultOrigin: VAULT_ORIGIN, parentOrigin: PARTNER_ORIGIN },
  );
  await expect(popup.locator('div.request:not([data-shown])')).toHaveCount(1);
  await expect(popup.locator('.summary-failed')).toHaveCount(0);
}

test('one divider where ruled blocks meet, on each kind of approval', async ({ page, browserName }) => {
  test.setTimeout(420_000);
  await openPartner(page, await newApp({ settings: { autoApprovePolicy: CONSENT_POLICY } }));
  const { stellar } = await login(page);
  const near = (await page.evaluate(() => (window as any).e2e.addresses().near)) as string;
  const me = (await page.evaluate(() => (window as any).e2e.addresses().evm)) as `0x${string}`;
  const key = { type: 'ed25519' as const, bytes: nearImplicitPublicKey(near) };
  await fetch(NEAR_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'e2e_near_activate', params: { account_id: near } }) });

  // An EVM send the user pays for; then, in the same window, the sponsored ones.
  let popup = await popupFor(page, 'send', 'ethSignTx', evmTx);
  await check(popup, 'evm-send', browserName);
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
  // The founder's case: "Program", then "Network" (later), and the first time's amber box.
  await injectSponsored(popup, subject({}));
  await expect(popup.locator('dl.id-rows dt')).toHaveText(['Program']);
  await expect(popup.locator('dl.summary-facts dt')).toHaveText(['Network']);
  await check(popup, 'sponsored-check-in-later', browserName);
  await injectSponsored(popup, subject({ authNonce: 0n, executeNonce: 0n }));
  await expect(popup.locator('.warning-box')).toBeVisible();
  await check(popup, 'sponsored-check-in-first-time', browserName);
  // A red box holding its own row, then the token's row and the network's.
  await injectSponsored(popup, subject({ calls: [{ to: UNLISTED, value: 0n, data: call('approve(address,uint256)', SPENDER, 2n ** 256n - 1n) }] }));
  await expect(popup.locator('.danger-box dl.id-rows')).toBeVisible();
  await check(popup, 'sponsored-unlimited-permission', browserName);
  // A batch whose first call Journear can't read: its raw data ends that call; the second call keeps its own rule.
  const checkIn = { to: (DEMO_CHECK_IN[EVM_CHAIN_ID] as { address: `0x${string}` }).address, value: 0n, data: '0x183ff085' as const };
  await injectSponsored(popup, subject({ calls: [{ to: UNLISTED, value: 0n, data: `0xdeadbeef${word(42n)}` }, checkIn] }));
  await expect(popup.locator('details.request-details ol.ops > li')).toHaveCount(2);
  await check(popup, 'sponsored-batch-unknown-first', browserName);
  await popup.close();
  await okValue(page, 'send').catch(() => undefined);

  // A relayed NEAR call with a quoted note (the Postcard stamp, D885).
  const note = new TextEncoder().encode(JSON.stringify({ stamp: 'postcard', note: 'Greetings from Kuala Lumpur!' }));
  const postcard: NearAction = { type: 'functionCall', methodName: 'collect', args: note, gas: 30_000_000_000_000n, deposit: 0n };
  popup = await popupFor(page, 'postcard', 'nearSignDelegate', base64Encode(encodeNearDelegateAction({ senderId: near, receiverId: E2E_STAMPS, actions: [postcard], nonce: (NEAR_HEIGHT - 1n) * 1_000_000n + 3n, maxBlockHeight: NEAR_HEIGHT + 100n, publicKey: key })));
  await expect(popup.locator('div.summary-quote')).toBeVisible();
  await check(popup, 'near-postcard', browserName);
  await done(page, popup, 'postcard');

  // The user's own NEAR transfer: its actions' heading and list in the details.
  popup = await popupFor(page, 'near', 'nearSignTx', base64Encode(encodeNearTransaction({ signerId: near, publicKey: key, nonce: 12n, receiverId: E2E_STAMPS, blockHash: new Uint8Array(32).fill(0x2a), actions: [{ type: 'transfer', deposit: 10n ** 24n }] })));
  await check(popup, 'near-transfer', browserName);
  await done(page, popup, 'near');

  // A NEAR call then a transfer: with JSON arguments (their box ends the call) and without (an amber line, then the bytes).
  const fnCall = (args: Uint8Array<ArrayBuffer>): NearAction => ({ type: 'functionCall', methodName: 'collect', args, gas: 30_000_000_000_000n, deposit: 0n });
  const batches: [string, Uint8Array<ArrayBuffer>, bigint][] = [
    ['near-call-json-then-transfer', new TextEncoder().encode('{"stamp":"arrival"}'), 13n],
    ['near-call-bytes-then-transfer', new Uint8Array([0xff, 0x00, 0x01]), 14n],
  ];
  for (const [name, args, nonce] of batches) {
    popup = await popupFor(page, name, 'nearSignTx', base64Encode(encodeNearTransaction({ signerId: near, publicKey: key, nonce, receiverId: E2E_STAMPS, blockHash: new Uint8Array(32).fill(0x2a), actions: [fnCall(args), { type: 'transfer', deposit: 10n ** 23n }] })));
    await expect(popup.locator('details.request-details ol.ops > li')).toHaveCount(2);
    await check(popup, name, browserName);
    await done(page, popup, name);
  }

  // A message in its box.
  popup = await popupFor(page, 'msg', 'personalSign', 'Welcome to Stamp Trail!\n\nSign this message to prove you own this wallet.');
  await expect(popup.locator('pre.message')).toBeVisible();
  await check(popup, 'personal-sign', browserName);
  await done(page, popup, 'msg');
  // One Journear can't read (D886's note): the line that says so, then the label right above the raw form.
  popup = await popupFor(page, 'raw-msg', 'personalSign', 'pay\u202eevil');
  // Soft: a run on the old order still saves the screens after it (the "before").
  await expect.soft(popup.locator('div.request > p.message-label + code.mono')).toBeVisible();
  await check(popup, 'personal-sign-unreadable', browserName);
  await done(page, popup, 'raw-msg');

  // A Stellar payment: its operations' rules after the transaction's facts.
  const payment = new TransactionBuilder(new Account(stellar, '100'), { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.payment({ destination: Keypair.random().publicKey(), asset: Asset.native(), amount: '1.5' }))
    .setTimeout(300)
    .build()
    .toXDR();
  popup = await popupFor(page, 'pay', 'stellarSignXdr', payment);
  await check(popup, 'stellar-payment', browserName);
  await done(page, popup, 'pay');
  // Two Stellar operations.
  const other = Keypair.random().publicKey();
  const two = new TransactionBuilder(new Account(stellar, '100'), { fee: '200', networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.payment({ destination: other, asset: Asset.native(), amount: '1.5' }))
    .addOperation(Operation.payment({ destination: other, asset: Asset.native(), amount: '2' }))
    .setTimeout(300)
    .build()
    .toXDR();
  popup = await popupFor(page, 'pay2', 'stellarSignXdr', two);
  await expect(popup.locator('details.request-details ol.ops > li')).toHaveCount(2);
  await check(popup, 'stellar-two-operations', browserName);
  await done(page, popup, 'pay2');
  // A Soroban call whose authorization holds another token move (approval-summary.spec.ts): nested groups.
  const contract = (n: number) => StrKey.encodeContract(Buffer.alloc(32, n));
  const sc = (a: string) => nativeToScVal(a, { type: 'address' });
  const amount = (n: bigint) => nativeToScVal(n, { type: 'i128' });
  const inv = (c: string, fn: string, args: xdr.ScVal[], subs: xdr.SorobanAuthorizedInvocation[] = []) =>
    new xdr.SorobanAuthorizedInvocation({ function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({ contractAddress: new Address(c).toScAddress(), functionName: fn, args })), subInvocations: subs });
  const callArgs = [sc(stellar), sc(other), amount(1n)];
  const auth = new xdr.SorobanAuthorizationEntry({ credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(), rootInvocation: inv(contract(3), 'transfer', callArgs, [inv(contract(2), 'transfer', [sc(stellar), sc(other), amount(10n ** 15n)])]) });
  const nested = new TransactionBuilder(new Account(stellar, '100'), { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.invokeContractFunction({ contract: contract(3), function: 'transfer', args: callArgs, auth: [auth] }))
    .setTimeout(300)
    .build()
    .toXDR();
  popup = await popupFor(page, 'nested', 'stellarSignXdr', nested);
  await check(popup, 'soroban-nested', browserName);
  await done(page, popup, 'nested');

  // The consent screen: facts, then contract lines with their own rules, then a note.
  popup = await popupFor(page, 'consent', 'requestAutoApprove');
  await expect(popup.getByRole('heading', { name: 'Allow automatic approvals?' })).toBeVisible();
  await check(popup, 'consent', browserName);
  await done(page, popup, 'consent', 'Allow');
});

const CONSENT_POLICY = {
  v: 1,
  label: 'Deposits',
  maxConsentMs: 3_600_000,
  limits: { perDayCount: 3 },
  evm: {
    chains: [
      {
        chainId: 8453,
        maxValueWei: '1000',
        maxValueWeiPerDay: '3000',
        maxFeeWei: '1000',
        // Two contract lines: each its own rule, the same space on each side.
        contracts: [
          { address: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD', name: 'Example vault', selectors: [{ selector: '0xb6b55f25', signature: 'deposit(uint256)', addressArgs: 'self-or-listed' }] },
          { address: '0x348BE44F63A458be9C1b13D6fD8e99048F297Bc3', name: 'Another vault', selectors: [{ selector: '0xb6b55f25', signature: 'deposit(uint256)', addressArgs: 'self-or-listed' }] },
        ],
      },
    ],
  },
};
