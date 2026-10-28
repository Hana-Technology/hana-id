// @vitest-environment happy-dom
// The Stellar Wallets Kit module (docs/batch-b-spec.md "Stellar Wallets Kit module"; Tests → Web unit → "SWK module:
// isAvailable() resolves true within 1000 ms after the handshake and false without one").
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HANA_ID_ICON } from '../../src/client/icon.ts';
import { HOT_WALLET, HanaIdModule, IS_AVAILABLE_TIMEOUT_MS } from '../../src/stellar-wallets-kit.ts';
import { EVM, LOGGED_IN, LOGGED_OUT, ORIGINS, STELLAR, type Setup, flush, setup } from './harness.ts';

const TESTNET = 'Test SDF Network ; September 2015';
const XDR = 'AAAAAgAAAAA=';

let s: Setup;
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  s?.client.destroy();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

async function swkRejection(p: Promise<unknown>): Promise<{ code: number; message: string; ext?: string[] }> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).not.toBeInstanceOf(Error);
  expect(Object.keys(e as object).sort()).toEqual(expect.arrayContaining(['code', 'message']));
  return e as { code: number; message: string; ext?: string[] };
}

describe('HanaIdModule', () => {
  it('has the module fields of SWK 1.9.x and 2.x', () => {
    s = setup({ config: { stellar: { networkPassphrase: TESTNET } } });
    const m = new HanaIdModule(s.client);
    expect(m.moduleType).toBe(HOT_WALLET);
    expect(m.moduleType).toBe('HOT_WALLET');
    expect(m.productId).toBe('hana-id');
    expect(m.productName).toBe('Hana ID');
    expect(m.productUrl).toBe(ORIGINS.authOrigin);
    expect(m.productIcon).toBe(HANA_ID_ICON);
    for (const f of ['isAvailable', 'getAddress', 'signTransaction', 'signAuthEntry', 'signMessage', 'getNetwork', 'disconnect'] as const) expect(typeof m[f]).toBe('function');
  });

  it('isAvailable() resolves true within 1000 ms when the handshake is done', async () => {
    s = setup();
    const m = new HanaIdModule(s.client);
    const p = m.isAvailable();
    await s.vault.connect(LOGGED_OUT);
    await expect(p).resolves.toBe(true);
    await expect(m.isAvailable()).resolves.toBe(true);
  });

  it('isAvailable() resolves false after 1000 ms without a handshake, and false on vault_unavailable', async () => {
    s = setup();
    const m = new HanaIdModule(s.client);
    let result: boolean | undefined;
    void m.isAvailable().then((r) => {
      result = r;
    });
    await vi.advanceTimersByTimeAsync(IS_AVAILABLE_TIMEOUT_MS - 1);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe(false);
    await vi.advanceTimersByTimeAsync(5000); // vault_unavailable
    await expect(m.isAvailable()).resolves.toBe(false);
  });

  it('getAddress logs in when needed (popup opened synchronously) and returns {address}', async () => {
    s = setup();
    await s.vault.connect(LOGGED_OUT);
    s.vault.handle('hana_login', () => 'manual');
    const m = new HanaIdModule(s.client);
    const p = m.getAddress();
    expect(s.open).toHaveBeenCalledTimes(1);
    await flush();
    s.vault.reply(s.vault.last('hana_login').id, { addresses: { stellar: STELLAR, evm: EVM }, expiresAtMs: 1_900_000_000_000, persistence: 'session' });
    await expect(p).resolves.toEqual({ address: STELLAR });
  });

  it('signs through hana.stellar with the networkPassphrase and address SWK passes; ignores path', async () => {
    s = setup({ config: { stellar: { networkPassphrase: TESTNET } } });
    await s.vault.connect(LOGGED_IN);
    s.vault.handle('stellar_signTransaction', () => ({ result: { signedTxXdr: XDR, signerAddress: STELLAR } }));
    const m = new HanaIdModule(s.client);
    await expect(m.signTransaction(XDR, { networkPassphrase: TESTNET, address: STELLAR, path: "m/44'/148'/0'", submit: false })).resolves.toEqual({ signedTxXdr: XDR, signerAddress: STELLAR });
    expect(s.vault.last('stellar_signTransaction').params).toEqual({ xdr: XDR, networkPassphrase: TESTNET, address: STELLAR });
  });

  it('signAuthEntry, signMessage and getNetwork', async () => {
    s = setup({ config: { stellar: { networkPassphrase: TESTNET } } });
    await s.vault.connect(LOGGED_IN);
    const sig = btoa(String.fromCharCode(...new Uint8Array(64)));
    s.vault.handle('stellar_signAuthEntry', () => ({ result: { signedAuthEntry: sig, signerAddress: STELLAR } }));
    s.vault.handle('stellar_signMessage', () => ({ result: { signedMessage: sig, signerAddress: STELLAR } }));
    const m = new HanaIdModule(s.client);
    await expect(m.signAuthEntry(XDR, { networkPassphrase: TESTNET })).resolves.toEqual({ signedAuthEntry: sig, signerAddress: STELLAR });
    await expect(m.signMessage('hi', { networkPassphrase: TESTNET, address: STELLAR })).resolves.toEqual({ signedMessage: sig, signerAddress: STELLAR });
    expect(s.vault.last('stellar_signMessage').params).toEqual({ message: 'hi', address: STELLAR });
    await expect(m.getNetwork()).resolves.toEqual({ network: 'TESTNET', networkPassphrase: TESTNET });
  });

  it('maps errors to {code, message, ext}: 4001 for a rejection, the Hana string code in ext', async () => {
    s = setup({ config: { stellar: { networkPassphrase: TESTNET } } });
    await s.vault.connect(LOGGED_IN);
    s.vault.handle('stellar_signTransaction', () => ({ error: { code: 4001, message: 'User rejected' } }));
    const m = new HanaIdModule(s.client);
    expect(await swkRejection(m.signTransaction(XDR))).toEqual({ code: 4001, message: 'User rejected' });
    s.vault.handle('stellar_signMessage', () => ({ error: { code: 'api_unavailable', message: 'API down' } }));
    expect(await swkRejection(m.signMessage('x'))).toEqual({ code: -32603, message: 'API down', ext: ['api_unavailable'] });
  });

  it('refuses submit: true (Hana ID only signs)', async () => {
    s = setup({ config: { stellar: { networkPassphrase: TESTNET } } });
    await s.vault.connect(LOGGED_IN);
    const m = new HanaIdModule(s.client);
    const e = await swkRejection(m.signTransaction(XDR, { submit: true }));
    expect(e.code).toBe(-32602);
    expect(s.vault.requests).toEqual([]);
  });

  it('disconnect() logs out', async () => {
    s = setup();
    await s.vault.connect(LOGGED_IN);
    s.vault.handle('hana_logout', () => ({ result: null }));
    await new HanaIdModule(s.client).disconnect();
    expect(s.vault.seen('hana_logout')).toHaveLength(1);
    expect(s.client.status).toBe('logged_out');
  });
});
