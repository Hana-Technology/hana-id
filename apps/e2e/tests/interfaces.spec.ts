// Standard interfaces (docs/batch-b-spec.md "Standard interfaces"): viem and wagmi over the EIP-1193 provider (wagmi
// finds it through EIP-6963), and Stellar Wallets Kit 1.9.x and 2.x with HanaIdModule. Each signs through the approval
// popup.
//
// The connect paths (wagmi connect, SWK getAddress/fetchAddress) call window.open after the libraries' own awaits.
// Safari blocks a popup there; Playwright's browsers never block popups, so in WebKit the partner page's window.open
// returns null instead (`blockPopups`), as Safari's blocker does, and the login goes through the vault's launcher.
import { type Page } from '@playwright/test';
import { type TransactionSerialized, keccak256, parseTransaction, recoverTransactionAddress } from 'viem';
import { EVM_CHAIN_ID } from '../src/stack.ts';
import { approve, chooseAccount, clickAction, clickLauncher, evmBroadcasts, expect, login, newApp, okValue, openPartner, runAction, test } from './fixtures.ts';

/**
 * Runs a connect action from a click, then finishes the login it starts: through the login popup, or (WebKit) through
 * the vault's "Sign in with Journear Passport" launcher.
 */
async function connectFromClick(page: Page, name: string, action: string, viaLauncher: boolean): Promise<void> {
  if (viaLauncher) {
    await clickAction(page, name, action);
    const popup = await clickLauncher(page, 'Sign in with Journear Passport');
    expect(new URL(popup.url()).search).toBe('?from=vault');
    await chooseAccount(popup);
  } else {
    const popupP = page.waitForEvent('popup');
    await clickAction(page, name, action);
    await chooseAccount(await popupP);
  }
}

async function approveNext(page: Page): Promise<void> {
  await approve(await clickLauncher(page, 'Review in Journear Passport'));
}

test.describe('EVM', () => {
  test('viem signs a message and sends a transaction through approval', async ({ page }) => {
    const app = await newApp();
    await openPartner(page, app);
    const { evm } = await login(page);

    await runAction(page, 'msg', 'viemSignMessage', 'hello from viem');
    const popup = await clickLauncher(page, 'Review in Journear Passport');
    await approve(popup);
    expect(await okValue(page, 'msg')).toEqual({ account: evm, valid: true });

    // Within 15 s the same popup shows the next request (filled from the chain RPC, then approved).
    await runAction(page, 'tx', 'viemSendTx');
    await approve(popup);
    const { hash } = await okValue<{ hash: string }>(page, 'tx');
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/u);
    // The mocked chain is shared by the parallel tests: find this broadcast by its hash.
    const raw = (await evmBroadcasts()).find((r) => keccak256(r) === hash);
    if (!raw) throw new Error('the transaction was not broadcast');
    const tx = parseTransaction(raw as TransactionSerialized);
    expect(tx).toMatchObject({ type: 'eip1559', chainId: EVM_CHAIN_ID, value: 1000n });
    expect(tx.to?.toLowerCase()).toBe('0x000000000000000000000000000000000000dead');
    expect(await recoverTransactionAddress({ serializedTransaction: raw as TransactionSerialized })).toBe(evm);
  });

  test('wagmi connects through EIP-6963 and signs through approval', async ({ page, browserName }) => {
    const webkit = browserName === 'webkit';
    const app = await newApp();
    await openPartner(page, app, { blockPopups: webkit });
    await connectFromClick(page, 'connect', 'wagmiConnect', webkit);
    const { accounts, chainId } = await okValue<{ accounts: string[]; chainId: number }>(page, 'connect');
    const evm = (await page.evaluate(() => (window as any).e2e.addresses().evm)) as string;
    expect(accounts).toEqual([evm]);
    expect(chainId).toBe(EVM_CHAIN_ID);

    await runAction(page, 'msg', 'wagmiSignMessage', 'hello from wagmi');
    await approveNext(page);
    expect(await okValue(page, 'msg')).toEqual({ valid: true });
  });
});

for (const kit of ['swk1', 'swk2'] as const) {
  test(`Stellar Wallets Kit ${kit === 'swk1' ? '1.9.x' : '2.x'} connects with HanaIdModule and signs through approval`, async ({ page, browserName }) => {
    const webkit = browserName === 'webkit';
    const app = await newApp();
    await openPartner(page, app, { blockPopups: webkit });
    await connectFromClick(page, 'connect', `${kit}Connect`, webkit);
    const { address } = await okValue<{ address: string }>(page, 'connect');
    expect(address).toMatch(/^G[A-Z2-7]{55}$/u);

    await runAction(page, 'tx', `${kit}SignTx`);
    await approveNext(page);
    expect(await okValue(page, 'tx')).toEqual({ signerAddress: address, valid: true });
  });
}
