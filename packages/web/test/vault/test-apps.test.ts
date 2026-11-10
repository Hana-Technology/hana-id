// Test apps can't sign for mainnet chains (docs/decisions.md D39): a pk_test_ app's vault refuses Stellar mainnet and
// EVM chains outside the testnet allowlist before any popup or policy; live apps are unaffected; the popup says so.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { STELLAR_MAINNET_PASSPHRASE, TEST_APP_NETWORK_RULE } from '@hana-id/core';
import { functionSelector } from '@hana-id/core/decode';
import { Browser, type Google, HOUR, type Tab, answer, answerConsent, google, login, makeConfig, openApproval, readyTab, sleepReal, waitLauncher } from './harness.ts';
import { hash, xdr } from '@stellar/stellar-base';
import { CHAIN, EVM_VAULT, POOL, addr, authCall, evmTx, evmTxSigner, payment, stellarTx, typedData } from './chains.ts';

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

const LIVE_PK = 'pk_live_1111111111111111111111';

async function session(over: Parameters<typeof makeConfig>[0] = {}): Promise<{ t: Tab; stellar: string; evm: string }> {
  const t = await readyTab(new Browser(), { googleJwk: g.jwk, config: makeConfig(over) });
  tabs.push(t);
  const { reply } = await login(t, g);
  const a = (reply.result as { addresses: { stellar: string; evm: string } }).addresses;
  return { t, ...a };
}

/** A Soroban auth entry preimage for the public network (its network id is the mainnet passphrase's hash). */
const mainnetPreimage = (self: string): string =>
  xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: hash(Buffer.from(STELLAR_MAINNET_PASSPHRASE)),
      nonce: xdr.Int64.fromString('99'),
      signatureExpirationLedger: 12345,
      invocation: authCall(POOL, 'swap', [addr(self)]),
    }),
  ).toXDR('base64');

const ORDER = [{ name: 'amount', type: 'uint256' }];
/** Typed data whose domain names no chain. */
const chainless = () =>
  JSON.stringify({
    types: { EIP712Domain: [{ name: 'name', type: 'string' }], Order: ORDER },
    primaryType: 'Order',
    domain: { name: 'Example' },
    message: { amount: '5' },
  });

describe('a pk_test_ app and mainnet chains', () => {
  it.each([
    ['an EVM transaction on chain 1', () => ['eth_signTransaction', { tx: evmTx({ chainId: '0x1' }) }], { chain: 'evm', chainId: 1 }],
    ['an EVM transaction on Base mainnet', () => ['eth_signTransaction', { tx: evmTx({ chainId: '0x2105' }) }], { chain: 'evm', chainId: 8453 }],
    ['an EVM transaction on a chain nobody listed', () => ['eth_signTransaction', { tx: evmTx({ chainId: '0xf423f' }) }], { chain: 'evm', chainId: 999_999 }],
    ['typed data whose domain is on chain 1', () => ['eth_signTypedData_v4', [null, typedData(EVM_VAULT, 'Order', { amount: '5' }, ORDER, 1)]], { chain: 'evm', chainId: 1 }],
    ['a Stellar mainnet transaction', (s: { stellar: string }) => ['stellar_signTransaction', { xdr: stellarTx(s.stellar, [payment()]), networkPassphrase: STELLAR_MAINNET_PASSPHRASE }], { chain: 'stellar', networkPassphrase: STELLAR_MAINNET_PASSPHRASE }],
    ['a Stellar mainnet auth entry', (s: { stellar: string }) => ['stellar_signAuthEntry', { preimageXdr: mainnetPreimage(s.stellar), networkPassphrase: STELLAR_MAINNET_PASSPHRASE }], { chain: 'stellar', networkPassphrase: STELLAR_MAINNET_PASSPHRASE }],
  ] as const)('refuses %s at once (4100 mainnet_not_allowed), with no popup', async (_, make, network) => {
    const s = await session();
    const [method, raw] = (make as unknown as (s: { stellar: string }) => readonly [string, unknown])(s);
    const params = method === 'eth_signTypedData_v4' ? [s.evm, (raw as unknown[])[1]] : raw;
    const reply = await s.t.request(method, params);
    expect(reply.error).toEqual({ code: 4100, message: TEST_APP_NETWORK_RULE, data: { reason: 'mainnet_not_allowed', ...network } });
    await sleepReal(20);
    expect(s.t.launcher.label).toBeNull();
    expect(s.t.opened.filter((w) => w.url.endsWith('/approve'))).toHaveLength(0);
  });

  it('signs test networks and requests that name no network, and tells the popup it is a test app', async () => {
    const s = await session();
    const tx = evmTx();
    const reply = s.t.request('eth_signTransaction', { tx });
    await waitLauncher(s.t, 'Review in Hana');
    const popup = openApproval(s.t);
    const m = await popup.next('hana:approve-request');
    expect(m).toMatchObject({ context: { chainId: CHAIN }, testApp: true });
    // The mainnet demo is off for this app: the message is exactly the older one.
    expect(m).not.toHaveProperty('mainnetDemo');
    answer(s.t, popup, m, true);
    expect(evmTxSigner((await reply).result as string, tx)).toBe(s.evm);
    // Messages and typed data without a domain chain aren't tied to a network (D35): shown, not refused.
    for (const [method, params] of [
      ['personal_sign', ['0x68656c6c6f', s.evm]],
      ['eth_signTypedData_v4', [s.evm, chainless()]],
      ['stellar_signMessage', { message: 'hello' }],
    ] as const) {
      const r = s.t.request(method, params);
      const shown = await popup.next('hana:approve-request', popup.posted.filter((p) => p.message.t === 'hana:approve-request').length);
      expect(shown.testApp).toBe(true);
      answer(s.t, popup, shown, true);
      expect((await r).error).toBeUndefined();
    }
  });

  it('never auto-approves a mainnet request, even under a policy that lists the chain', async () => {
    const policy = {
      v: 1,
      label: 'Deposits',
      maxConsentMs: 6 * HOUR,
      limits: { perDayCount: 5 },
      evm: {
        chains: [1, CHAIN].map((chainId) => ({
          chainId,
          maxValueWei: '200000',
          maxValueWeiPerDay: '500000',
          maxFeeWei: '100000',
          contracts: [{ address: EVM_VAULT, name: 'Vault', selectors: [{ selector: functionSelector('deposit(uint256)'), signature: 'deposit(uint256)' }] }],
        })),
      },
    };
    const s = await session({ settings: { autoApprovePolicy: policy } });
    const grant = s.t.request('hana_requestAutoApprove');
    await waitLauncher(s.t, 'Review in Hana');
    const popup = openApproval(s.t);
    const m = await popup.next('hana:consent-request');
    expect(m.testApp).toBe(true);
    answerConsent(s.t, popup, m, true);
    expect((await grant).result).toMatchObject({ granted: true });
    // The test chain is auto-signed; chain 1 is refused before the policy is looked at.
    expect((await s.t.request('eth_signTransaction', { tx: evmTx() })).result).toMatch(/^0x02/u);
    expect((await s.t.request('eth_signTransaction', { tx: evmTx({ chainId: '0x1' }) })).error).toMatchObject({ code: 4100, data: { reason: 'mainnet_not_allowed' } });
    expect(s.t.events.filter((e) => e.event === 'autoApproved')).toHaveLength(1);
  });
});

describe('a pk_live_ app', () => {
  it('may sign for mainnets, and the popup carries no test-app note', async () => {
    const s = await session({ publishableKey: LIVE_PK });
    const tx = evmTx({ chainId: '0x1' });
    const reply = s.t.request('eth_signTransaction', { tx });
    await waitLauncher(s.t, 'Review in Hana');
    const popup = openApproval(s.t);
    const m = await popup.next('hana:approve-request');
    expect(m).toMatchObject({ context: { chainId: 1 } });
    expect(m).not.toHaveProperty('testApp');
    answer(s.t, popup, m, true);
    expect(evmTxSigner((await reply).result as string, tx)).toBe(s.evm);
  });
});
