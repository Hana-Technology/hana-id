// @vitest-environment happy-dom
// hana.stellar and hana.signRaw (docs/batch-b-spec.md "Partner client", "Port methods", "Signing and approval").
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HanaError } from '../../src/client/errors.ts';
import { EVM, LOGGED_IN, LOGGED_OUT, STELLAR, STELLAR_2, type Setup, flush, setup } from './harness.ts';

const TESTNET = 'Test SDF Network ; September 2015';
const PUBLIC = 'Public Global Stellar Network ; September 2015';
const XDR = 'AAAAAgAAAAA=';
const SIG64 = btoa(String.fromCharCode(...new Uint8Array(64).fill(1)));

let s: Setup;
afterEach(() => {
  s?.client.destroy();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

async function rejection(p: Promise<unknown>): Promise<HanaError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(HanaError);
  return e as HanaError;
}

describe('hana.stellar', () => {
  it('signTransaction uses the configured passphrase, or the call’s, and passes address when given', async () => {
    s = setup({ config: { stellar: { networkPassphrase: TESTNET } } });
    await s.vault.connect(LOGGED_IN);
    s.vault.handle('stellar_signTransaction', () => ({ result: { signedTxXdr: XDR, signerAddress: STELLAR } }));
    await expect(s.client.stellar.signTransaction(XDR)).resolves.toEqual({ signedTxXdr: XDR, signerAddress: STELLAR });
    expect(s.vault.last('stellar_signTransaction').params).toEqual({ xdr: XDR, networkPassphrase: TESTNET });
    await s.client.stellar.signTransaction(XDR, { networkPassphrase: PUBLIC, address: STELLAR });
    expect(s.vault.last('stellar_signTransaction').params).toEqual({ xdr: XDR, networkPassphrase: PUBLIC, address: STELLAR });
  });

  it("passes on the vault's 4100 for another address and 4001 for a rejection", async () => {
    s = setup({ config: { stellar: { networkPassphrase: TESTNET } } });
    await s.vault.connect(LOGGED_IN);
    s.vault.handle('stellar_signTransaction', (p) => ({ error: (p as { address?: string }).address === STELLAR_2 ? { code: 4100, message: 'Address mismatch' } : { code: 4001, message: 'User rejected' } }));
    expect((await rejection(s.client.stellar.signTransaction(XDR, { address: STELLAR_2 }))).code).toBe(4100);
    expect((await rejection(s.client.stellar.signTransaction(XDR))).code).toBe(4001);
  });

  it('without any passphrase, refuses (-32602) before sending', async () => {
    s = setup();
    await s.vault.connect(LOGGED_IN);
    expect((await rejection(s.client.stellar.signTransaction(XDR))).code).toBe(-32602);
    expect((await rejection(s.client.stellar.signAuthEntry(XDR))).code).toBe(-32602);
    expect((await rejection(s.client.stellar.getNetwork())).code).toBe(-32602);
    expect(s.vault.requests).toEqual([]);
  });

  it('signAuthEntry and signMessage go to their port methods', async () => {
    s = setup({ config: { stellar: { networkPassphrase: TESTNET } } });
    await s.vault.connect(LOGGED_IN);
    s.vault.handle('stellar_signAuthEntry', () => ({ result: { signedAuthEntry: SIG64, signerAddress: STELLAR } }));
    s.vault.handle('stellar_signMessage', () => ({ result: { signedMessage: SIG64, signerAddress: STELLAR } }));
    await expect(s.client.stellar.signAuthEntry(XDR)).resolves.toEqual({ signedAuthEntry: SIG64, signerAddress: STELLAR });
    expect(s.vault.last('stellar_signAuthEntry').params).toEqual({ preimageXdr: XDR, networkPassphrase: TESTNET });
    await s.client.stellar.signMessage('hello', { address: STELLAR });
    expect(s.vault.last('stellar_signMessage').params).toEqual({ message: 'hello', address: STELLAR });
    const bytes = new Uint8Array([1, 2, 3]);
    await s.client.stellar.signMessage(bytes);
    expect(s.vault.last('stellar_signMessage').params).toEqual({ message: bytes });
  });

  it('getNetwork names the well-known passphrases and calls others CUSTOM', async () => {
    s = setup({ config: { stellar: { networkPassphrase: PUBLIC } } });
    await expect(s.client.stellar.getNetwork()).resolves.toEqual({ network: 'PUBLIC', networkPassphrase: PUBLIC });
    s.client.destroy();
    s = setup({ config: { stellar: { networkPassphrase: 'Standalone Network ; February 2017' } } });
    await expect(s.client.stellar.getNetwork()).resolves.toEqual({ network: 'CUSTOM', networkPassphrase: 'Standalone Network ; February 2017' });
  });

  it('getAddress asks the vault when logged in, and logs in (popup opened synchronously) when not', async () => {
    s = setup();
    await s.vault.connect(LOGGED_IN);
    s.vault.handle('stellar_getAddress', () => ({ result: { address: STELLAR } }));
    await expect(s.client.stellar.getAddress()).resolves.toEqual({ address: STELLAR });
    s.client.destroy();

    s = setup();
    await s.vault.connect(LOGGED_OUT);
    s.vault.handle('hana_login', () => 'manual');
    const p = s.client.stellar.getAddress();
    expect(s.open).toHaveBeenCalledTimes(1);
    await flush();
    s.vault.reply(s.vault.last('hana_login').id, { addresses: { stellar: STELLAR, evm: EVM }, expiresAtMs: 1_900_000_000_000, persistence: 'session' });
    await expect(p).resolves.toEqual({ address: STELLAR });
  });

  it('createHana validates stellar config', () => {
    expect(() => setup({ config: { stellar: { networkPassphrase: '' } } })).toThrow(TypeError);
    expect(() => setup({ config: { stellar: { networkPassphrase: TESTNET, horizonUrl: 'not a url' } } })).toThrow(/horizonUrl/u);
  });
});

describe('hana.signRaw', () => {
  it('sends {chain, bytes} or {chain, digest} and resolves with the signature bytes', async () => {
    s = setup();
    await s.vault.connect(LOGGED_IN);
    const sig65 = new Uint8Array(65).fill(2);
    sig65[64] = 27;
    s.vault.handle('hana_signRaw', (p) => ({ result: { signature: (p as { chain: string }).chain === 'evm' ? sig65 : new Uint8Array(64).fill(3) } }));
    const digest = new Uint8Array(32).fill(9);
    const r = await s.client.signRaw({ chain: 'evm', digest });
    expect(r.signature).toEqual(sig65);
    expect(s.vault.last('hana_signRaw').params).toEqual({ chain: 'evm', digest });
    const bytes = new Uint8Array(100).fill(4);
    await expect(s.client.signRaw({ chain: 'stellar', bytes })).resolves.toEqual({ signature: new Uint8Array(64).fill(3) });
  });

  it('passes on 4100 when the app has raw signing off', async () => {
    s = setup();
    await s.vault.connect(LOGGED_IN);
    s.vault.handle('hana_signRaw', () => ({ error: { code: 4100, message: 'Raw signing is off for this app' } }));
    expect((await rejection(s.client.signRaw({ chain: 'stellar', bytes: new Uint8Array(1) }))).code).toBe(4100);
  });

  it('refuses oversize raw bytes (> 4 KiB) and a digest that is not 32 bytes before sending', async () => {
    s = setup();
    await s.vault.connect(LOGGED_IN);
    expect((await rejection(s.client.signRaw({ chain: 'stellar', bytes: new Uint8Array(4097) }))).code).toBe(-32602);
    expect((await rejection(s.client.signRaw({ chain: 'evm', digest: new Uint8Array(33) }))).code).toBe(-32602);
    expect(s.vault.requests).toEqual([]);
  });
});
