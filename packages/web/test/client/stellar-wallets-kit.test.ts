// @vitest-environment happy-dom
// The Stellar Wallets Kit module (docs/batch-b-spec.md "Stellar Wallets Kit module"; Tests → Web unit → "SWK module:
// isAvailable() resolves true within 1000 ms after the handshake and false without one").
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HANA_ID_ICON } from '../../src/client/icon.ts';
import { HANA_ID_MODULE_ID, HOT_WALLET, HanaIdModule, IS_AVAILABLE_TIMEOUT_MS, JOURNEAR_PASSPORT_MODULE_ID } from '../../src/stellar-wallets-kit.ts';
import { ANSWER_TIMEOUT_MS } from '../../src/client/vault-connection.ts';
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
    expect(m.productName).toBe('Journear Passport');
    expect(m.productUrl).toBe(ORIGINS.authOrigin);
    expect(m.productIcon).toBe(HANA_ID_ICON);
    for (const f of ['isAvailable', 'getAddress', 'signTransaction', 'signAuthEntry', 'signMessage', 'getNetwork', 'disconnect'] as const) expect(typeof m[f]).toBe('function');
  });

  // D923: Sodax's wallet kit finds Hana Wallet (the browser extension) by the substring "hana" of a wallet's id or name,
  // so a host like it passes a productId without "hana"; the default stays 'hana-id' for hosts that stored it.
  it('takes a productId from the host; the default stays hana-id', () => {
    s = setup({ config: { stellar: { networkPassphrase: TESTNET } } });
    expect(HANA_ID_MODULE_ID).toBe('hana-id');
    expect(new HanaIdModule(s.client).productId).toBe('hana-id');
    expect(new HanaIdModule(s.client, {}).productId).toBe('hana-id');
    const m = new HanaIdModule(s.client, { productId: JOURNEAR_PASSPORT_MODULE_ID });
    expect(m.productId).toBe('journear-passport');
    expect(m.productId).not.toContain('hana');
    expect(m.productName.toLowerCase()).not.toContain('hana');
    expect(m.productName).toBe('Journear Passport');
    expect(new HanaIdModule(s.client, { productId: 'partner.wallet-1' }).productId).toBe('partner.wallet-1');
  });

  it("refuses a productId that is malformed or another wallet's", () => {
    s = setup({ config: { stellar: { networkPassphrase: TESTNET } } });
    for (const productId of ['', 'ab', 'Journear', 'has space', '-lead', 'trail.', 'a..b', 'x'.repeat(65), 'hana', 'io.hana.wallet', 7 as unknown as string]) {
      expect(() => new HanaIdModule(s.client, { productId }), String(productId)).toThrow(expect.objectContaining({ code: -32602 }));
    }
    expect(new HanaIdModule(s.client, { productId: 'x'.repeat(64) }).productId).toHaveLength(64);
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
    await vi.advanceTimersByTimeAsync(2 * (ANSWER_TIMEOUT_MS + 1)); // vault_unavailable (the frame never loads: its deadline, then its one extension)
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
