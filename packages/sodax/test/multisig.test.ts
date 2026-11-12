// A Sodax swap that needs several Stellar signatures runs through one keep-open approval popup (docs/batch-b-spec.md
// "Sodax adapter"; Tests → Sodax → "A multi-signature swap (restoreFootprint, re-sign, trustline) runs through one
// keep-open popup"). End to end on the client side: the real vault (packages/web's vault test harness: real login,
// derivation, approval queue and popup reuse), the real hana.stellar over its port, this adapter, and the call pattern
// of @sodax/sdk 2.1.0's StellarSpokeService (requestTrustline, then deposit → submitOrRestoreAndRetry), whose own
// Soroban broadcast and receipt waits are mocked as time passing.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TransactionBuilder, type Transaction, type xdr } from '@stellar/stellar-base';
import { base64Encode } from '@hana-id/core';
import { HanaError, HanaStellarSigner } from '@hana-id/web';
import { Browser, type Google, type Tab, answer, google, login, makeConfig, openApproval, readyTab, sleepReal, waitLauncher } from '../../web/test/vault/harness.ts';
import { type SodaxStellarProvider, createSodaxStellarProvider } from '../src/index.ts';
import { changeTrustOp, depositCall, restoreTx, signedBy, tx } from './fixtures.ts';
import { HORIZON, PUBLIC, SOROBAN } from './helpers.ts';

type StellarHost = ConstructorParameters<typeof HanaStellarSigner>[0];

let g: Google;
const tabs: Tab[] = [];
beforeAll(async () => {
  g = await google();
});
afterEach(() => {
  for (const t of tabs.splice(0)) {
    t.close();
    t.browser.timers.dispose();
  }
});

/**
 * A logged-in vault tab, and the adapter over hana.stellar on its port. Sodax runs on Stellar mainnet, which only a
 * live app may sign for (a pk_test_ vault refuses it, docs/decisions.md D39), so the vault is a pk_live_ app's.
 */
async function sodaxOverVault(): Promise<{ tab: Tab; user: string; provider: SodaxStellarProvider }> {
  const tab = await readyTab(new Browser(), { googleJwk: g.jwk, config: makeConfig({ publishableKey: 'pk_live_1111111111111111111111' }) });
  tabs.push(tab);
  const { reply } = await login(tab, g);
  const user = (reply.result as { addresses: { stellar: string } }).addresses.stellar;
  const host: StellarHost = {
    stellarAddress: () => user,
    login: () => Promise.reject(new Error('already logged in')),
    request: (async (method: string, params?: unknown) => {
      const r = await tab.request(method, params);
      if (r.error) throw new HanaError(r.error.code as never, r.error.message, r.error.data);
      return r.result;
    }) as StellarHost['request'],
  };
  const stellar = new HanaStellarSigner(host, { networkPassphrase: PUBLIC });
  return { tab, user, provider: createSodaxStellarProvider({ stellar }, { networkPassphrase: PUBLIC, horizonUrl: HORIZON, sorobanRpcUrl: SOROBAN }) };
}

/**
 * @sodax/sdk 2.1.0 StellarSpokeService.signAndSendTransaction: `walletProvider.signTransaction(tx.toXDR())` with one
 * argument, parse the result, then its own Soroban sendTransaction and receipt wait (here: `wait`).
 */
async function sdkSignAndSend(walletProvider: SodaxStellarProvider, t: Transaction, signedXdrs: string[], wait: () => Promise<void>): Promise<void> {
  const signed = await walletProvider.signTransaction(t.toXDR());
  TransactionBuilder.fromXDR(signed, t.networkPassphrase);
  signedXdrs.push(signed);
  await wait();
}

/**
 * A Stellar → hub swap as the SDK runs it for an account without the trustline and with an archived footprint:
 * requestTrustline (changeTrust at the loaded sequence), then deposit: simulation asks for a restore, so
 * handleSimulationRestore (restoreFootprint at the loaded sequence), then the deposit again with the next sequence.
 */
async function sdkSwap(provider: SodaxStellarProvider, wait: () => Promise<void>): Promise<string[]> {
  const user = await provider.getWalletAddress();
  const signed: string[] = [];
  // requestTrustline: loadAccount → sequence 41.
  await sdkSignAndSend(provider, tx(user, 41n, [changeTrustOp()], PUBLIC, { fee: '100' }), signed, wait);
  // deposit: loadAccount → sequence 42; the assembled priority transaction needs a restore first.
  const deposit: xdr.Operation = depositCall(user);
  await sdkSignAndSend(provider, restoreTx(user, 42n, PUBLIC), signed, wait);
  // submitOrRestoreAndRetry: newAccount = account clone, incrementSequenceNumber(), rebuild with the same operation.
  await sdkSignAndSend(provider, tx(user, 43n, [deposit], PUBLIC), signed, wait);
  return signed;
}

/** Event-driven (the launcher view and its `ui` event on the port), so a loaded machine only slows it down. */
const waitLabel = (t: Tab, label: string): Promise<void> => waitLauncher(t, label);

const approvePopups = (t: Tab) => t.opened.filter((w) => w.url.endsWith('/approve'));

describe('multi-signature Sodax swap', () => {
  it('trustline, restoreFootprint and the re-signed deposit go through one approval popup, kept open between them', async () => {
    const { tab, user, provider } = await sodaxOverVault();
    // Between signatures the SDK broadcasts and waits for the receipt: a few seconds, inside the 15 s keep-open window.
    const wait = async () => {
      tab.browser.timers.advance(6_000);
    };
    const swap = sdkSwap(provider, wait);

    // The first signature needs the launcher click; the popup then shows each request in turn.
    await waitLabel(tab, 'Review in Journear Passport');
    const popup = openApproval(tab);
    const shown: string[] = [];
    for (let n = 0; n < 3; n++) {
      const m = await popup.next('hana:approve-request', n);
      expect(m).toMatchObject({ kind: 'stellar_tx', address: user, context: { networkPassphrase: PUBLIC } });
      const env = TransactionBuilder.fromXDR(base64Encode(m.bytes as Uint8Array), PUBLIC) as Transaction;
      shown.push(`${env.operations[0]?.type}@${env.sequence}`);
      answer(tab, popup, m, true);
    }
    const signed = await swap;

    expect(shown).toEqual(['changeTrust@42', 'restoreFootprint@43', 'invokeHostFunction@44']);
    expect(signed).toHaveLength(3);
    for (const s of signed) expect(signedBy(s, user, PUBLIC)).toBe(true);
    // One popup, opened once from the launcher; the follow-ups reused it (focused, no launcher).
    expect(approvePopups(tab)).toHaveLength(1);
    expect(tab.launcher.history.filter((l) => l === 'Review in Journear Passport')).toHaveLength(1);
    expect(popup.focused).toBeGreaterThanOrEqual(2);
    expect(popup.closed).toBe(false);
  });

  it('a rejection in the popup stops the swap: the SDK sees 4001 and nothing more is signed', async () => {
    const { tab, provider } = await sodaxOverVault();
    const swap = sdkSwap(provider, async () => {
      tab.browser.timers.advance(6_000);
    }).then(
      () => null,
      (e: unknown) => e,
    );
    await waitLabel(tab, 'Review in Journear Passport');
    const popup = openApproval(tab);
    answer(tab, popup, await popup.next('hana:approve-request', 0), true);
    answer(tab, popup, await popup.next('hana:approve-request', 1), false);
    expect(await swap).toMatchObject({ code: 4001 });
    await sleepReal(30);
    expect(popup.posted.filter((p) => p.message.t === 'hana:approve-request')).toHaveLength(2);
  });
});
