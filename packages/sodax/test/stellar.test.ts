// createSodaxStellarProvider (docs/batch-b-spec.md "Sodax adapter"; Tests → Sodax → "Stellar: signTransaction with and
// without address, fee-bump, sendTransaction, signAndSendTransaction, waitForTransactionReceipt polling and its 60 s
// timeout"), over the real hana.stellar and a scripted vault.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HanaError } from '@hana-id/web';
import { STELLAR_RECEIPT_POLL_MS, STELLAR_RECEIPT_TIMEOUT_MS, createSodaxStellarProvider } from '../src/index.ts';
import { ASSET_MANAGER, depositCall, feeBumpOf, horizonTx, signWith, signedBy, tx, txHash } from './fixtures.ts';
import { FakeNetwork, FakePort, HORIZON, OTHER_STELLAR, PUBLIC, SOROBAN, STELLAR, STELLAR_KEY, rejection, stellarHana } from './helpers.ts';

const CONFIG = { networkPassphrase: PUBLIC, horizonUrl: HORIZON, sorobanRpcUrl: SOROBAN };
const HASH = 'ab'.repeat(32);

let net: FakeNetwork;
let port: FakePort;
beforeEach(() => {
  net = new FakeNetwork();
  vi.stubGlobal('fetch', net.fetch);
  port = new FakePort({
    stellar_getAddress: () => ({ address: STELLAR }),
    stellar_signTransaction: (p) => {
      const { xdr, networkPassphrase, address } = p as { xdr: string; networkPassphrase: string; address?: string };
      if (address !== undefined && address !== STELLAR) throw new HanaError(4100, 'The address is not the Hana ID account');
      return { signedTxXdr: signWith(STELLAR_KEY, xdr, networkPassphrase), signerAddress: STELLAR };
    },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const provider = (p = port) => createSodaxStellarProvider(stellarHana(p), CONFIG);
const deposit = () => tx(STELLAR, 41n, [depositCall(STELLAR)], PUBLIC).toEnvelope().toXDR('base64');

describe('creation', () => {
  it("is chainType 'STELLAR' with every IStellarWalletProvider member, frozen", () => {
    const p = provider();
    expect(p.chainType).toBe('STELLAR');
    for (const m of ['getWalletAddress', 'signTransaction', 'sendTransaction', 'signAndSendTransaction', 'waitForTransactionReceipt'] as const) expect(typeof p[m]).toBe('function');
    expect(Object.isFrozen(p)).toBe(true);
  });

  it('validates the client and the config', () => {
    const hana = stellarHana(port);
    expect(() => createSodaxStellarProvider(null as never, CONFIG)).toThrow(/Hana client/u);
    expect(() => createSodaxStellarProvider(hana, null as never)).toThrow(TypeError);
    expect(() => createSodaxStellarProvider(hana, { ...CONFIG, networkPassphrase: '' })).toThrow(/networkPassphrase/u);
    expect(() => createSodaxStellarProvider(hana, { ...CONFIG, networkPassphrase: 'x'.repeat(257) })).toThrow(/networkPassphrase/u);
    expect(() => createSodaxStellarProvider(hana, { ...CONFIG, horizonUrl: 'not a url' })).toThrow(/horizonUrl/u);
    expect(() => createSodaxStellarProvider(hana, { ...CONFIG, sorobanRpcUrl: 'ftp://soroban.test' })).toThrow(/sorobanRpcUrl/u);
    expect(() => createSodaxStellarProvider(hana, { ...CONFIG, horizonUrl: undefined as never })).toThrow(/horizonUrl/u);
  });
});

describe('getWalletAddress', () => {
  it('asks the vault when logged in, and logs in (hana.login) when not', async () => {
    const hana = stellarHana(port);
    const p = createSodaxStellarProvider(hana, CONFIG);
    await expect(p.getWalletAddress()).resolves.toBe(STELLAR);
    expect(port.seen('stellar_getAddress')).toHaveLength(1);
    hana.session.addresses = null;
    await expect(p.getWalletAddress()).resolves.toBe(STELLAR);
    expect(hana.session.login).toHaveBeenCalledTimes(1);
  });
});

describe('signTransaction', () => {
  it('without address: signs with the provider passphrase and returns the signed envelope XDR', async () => {
    const xdr = deposit();
    const signed = await provider().signTransaction(xdr);
    expect(port.seen('stellar_signTransaction').map((c) => c.params)).toEqual([{ xdr, networkPassphrase: PUBLIC }]);
    expect(signedBy(signed, STELLAR, PUBLIC)).toBe(true);
    expect(txHash(signed, PUBLIC)).toBe(txHash(xdr, PUBLIC));
  });

  it('with address: passes it, so the vault refuses another account (4100)', async () => {
    const xdr = deposit();
    const p = provider();
    expect(signedBy(await p.signTransaction(xdr, { address: STELLAR }), STELLAR, PUBLIC)).toBe(true);
    expect(port.seen('stellar_signTransaction')[0]?.params).toEqual({ xdr, networkPassphrase: PUBLIC, address: STELLAR });
    expect((await rejection(p.signTransaction(xdr, { address: OTHER_STELLAR }))).code).toBe(4100);
  });

  it('signs a fee-bump envelope as given', async () => {
    const inner = tx(STELLAR, 41n, [depositCall(STELLAR)], PUBLIC);
    inner.sign(STELLAR_KEY);
    const bump = feeBumpOf(inner, PUBLIC).toEnvelope().toXDR('base64');
    const signed = await provider().signTransaction(bump);
    expect(port.seen('stellar_signTransaction')[0]?.params).toEqual({ xdr: bump, networkPassphrase: PUBLIC });
    expect(txHash(signed, PUBLIC)).toBe(txHash(bump, PUBLIC));
    expect(signedBy(signed, STELLAR, PUBLIC)).toBe(true);
  });

  it('a rejected approval is 4001; bad input is -32602 and never reaches the vault', async () => {
    port.handlers.stellar_signTransaction = () => {
      throw new HanaError(4001, 'User rejected');
    };
    const p = provider();
    expect((await rejection(p.signTransaction(deposit()))).code).toBe(4001);
    expect((await rejection(p.signTransaction(''))).code).toBe(-32602);
    expect((await rejection(p.signTransaction(42 as never))).code).toBe(-32602);
    expect((await rejection(p.signTransaction(deposit(), { address: 7 as never }))).code).toBe(-32602);
    expect(port.seen('stellar_signTransaction')).toHaveLength(1);
  });

  it('tolerates a non-object options argument (signs as the active account)', async () => {
    await provider().signTransaction(deposit(), false as never);
    expect(port.seen('stellar_signTransaction')[0]?.params).toEqual({ xdr: expect.any(String), networkPassphrase: PUBLIC });
  });
});

describe('sendTransaction', () => {
  it('sends the signed XDR to Soroban RPC (sendTransaction {transaction}) and returns the hash when PENDING or DUPLICATE', async () => {
    const p = provider();
    const signed = await p.signTransaction(deposit());
    const hash = txHash(signed, PUBLIC);
    net.rpc.set(SOROBAN, { sendTransaction: { status: 'PENDING', hash, latestLedger: 1, latestLedgerCloseTime: '1' } });
    await expect(p.sendTransaction(signed)).resolves.toBe(hash);
    expect(net.rpcCalls(SOROBAN, 'sendTransaction').map((c) => c.params)).toEqual([{ transaction: signed }]);
    net.rpc.set(SOROBAN, { sendTransaction: { status: 'DUPLICATE', hash: hash.toUpperCase() } });
    await expect(p.sendTransaction(signed)).resolves.toBe(hash);
    expect(net.calls.every((c) => c.url === SOROBAN)).toBe(true);
  });

  it('ERROR is refused with the error result XDR; TRY_AGAIN_LATER asks for a resend', async () => {
    const p = provider();
    net.rpc.set(SOROBAN, { sendTransaction: { status: 'ERROR', hash: HASH, errorResultXdr: 'AAAAAAAAAGT////7AAAAAA==' } });
    const e = await rejection(p.sendTransaction('AAAA'));
    expect(e.code).toBe(-32603);
    expect(e.data).toEqual({ status: 'ERROR', hash: HASH, errorResultXdr: 'AAAAAAAAAGT////7AAAAAA==' });
    net.rpc.set(SOROBAN, { sendTransaction: { status: 'TRY_AGAIN_LATER', hash: HASH } });
    const later = await rejection(p.sendTransaction('AAAA'));
    expect(later.message).toMatch(/TRY_AGAIN_LATER/u);
    expect(later.data).toEqual({ status: 'TRY_AGAIN_LATER', hash: HASH });
  });

  it('an RPC error, a malformed result, an unknown status or a network fault is -32603', async () => {
    const p = provider();
    net.rpc.set(SOROBAN, {
      sendTransaction: () => {
        throw { code: -32602, message: 'invalid transaction' };
      },
    });
    const e = await rejection(p.sendTransaction('AAAA'));
    expect(e).toMatchObject({ code: -32603, data: { rpcCode: -32602, rpcMessage: 'invalid transaction' } });
    for (const result of [null, { status: 'PENDING' }, { status: 'PENDING', hash: 'zz' }, { status: 'NEW', hash: HASH }]) {
      net.rpc.set(SOROBAN, { sendTransaction: result });
      expect((await rejection(p.sendTransaction('AAAA'))).code).toBe(-32603);
    }
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    expect(await rejection(p.sendTransaction('AAAA'))).toMatchObject({ code: -32603, message: /fetch failed/u });
  });

  it('refuses an empty or non-string XDR without a request', async () => {
    const p = provider();
    expect((await rejection(p.sendTransaction(''))).code).toBe(-32602);
    expect((await rejection(p.sendTransaction(null as never))).code).toBe(-32602);
    expect(net.calls).toEqual([]);
  });
});

describe('signAndSendTransaction', () => {
  it('signs rawTx.data as rawTx.from, then sends it', async () => {
    const xdr = deposit();
    const hash = txHash(xdr, PUBLIC);
    net.rpc.set(SOROBAN, { sendTransaction: { status: 'PENDING', hash } });
    const p = provider();
    await expect(p.signAndSendTransaction({ from: STELLAR, to: ASSET_MANAGER, value: 1_000_000n, data: xdr })).resolves.toBe(hash);
    expect(port.seen('stellar_signTransaction')[0]?.params).toEqual({ xdr, networkPassphrase: PUBLIC, address: STELLAR });
    const sent = (net.rpcCalls(SOROBAN, 'sendTransaction')[0]?.params as { transaction: string }).transaction;
    expect(signedBy(sent, STELLAR, PUBLIC)).toBe(true);
  });

  it('a raw transaction built for another account, or a rejected approval, sends nothing', async () => {
    const p = provider();
    expect((await rejection(p.signAndSendTransaction({ from: OTHER_STELLAR, to: ASSET_MANAGER, value: 0n, data: deposit() }))).code).toBe(4100);
    port.handlers.stellar_signTransaction = () => {
      throw new HanaError(4001, 'User rejected');
    };
    expect((await rejection(p.signAndSendTransaction({ from: STELLAR, to: ASSET_MANAGER, value: 0n, data: deposit() }))).code).toBe(4001);
    expect((await rejection(p.signAndSendTransaction({ from: STELLAR } as never))).code).toBe(-32602);
    expect(net.calls).toEqual([]);
  });
});

describe('waitForTransactionReceipt', () => {
  const url = `${HORIZON}/transactions/${HASH}`;

  it('polls Horizon every 2 s until the transaction is in a ledger, and returns its JSON', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    // Not found twice, then a 503 and a network fault (transient), then found.
    const answers = [{ status: 404 }, { status: 404 }, { status: 503 }, new TypeError('fetch failed'), { status: 200, json: horizonTx(HASH) }];
    net.get.set(url, (n) => answers[n] ?? { status: 500 });
    const p = provider().waitForTransactionReceipt(HASH.toUpperCase());
    await vi.advanceTimersByTimeAsync(4 * STELLAR_RECEIPT_POLL_MS);
    const receipt = await p;
    expect(receipt).toEqual(horizonTx(HASH));
    expect(net.calls.map((c) => [c.url, c.method, c.at - 1_000_000])).toEqual([0, 2000, 4000, 6000, 8000].map((t) => [url, 'GET', t]));
  });

  it('fills _links.transaction from _links.self when Horizon leaves it out', async () => {
    const json = horizonTx(HASH);
    const links = { ...(json._links as Record<string, unknown>) };
    delete links.transaction;
    net.get.set(url, () => ({ status: 200, json: { ...json, _links: links } }));
    const r = await provider().waitForTransactionReceipt(HASH);
    expect(r._links.transaction).toEqual({ href: `${HORIZON}/transactions/${HASH}` });
  });

  it('keeps a Horizon base path', async () => {
    const hana = stellarHana(port);
    const p = createSodaxStellarProvider(hana, { ...CONFIG, horizonUrl: 'https://rpc.test/stellar/horizon' });
    net.get.set(`https://rpc.test/stellar/horizon/transactions/${HASH}`, () => ({ status: 200, json: horizonTx(HASH) }));
    await expect(p.waitForTransactionReceipt(HASH)).resolves.toMatchObject({ hash: HASH });
  });

  it('gives up after 60 s with receipt_timeout, and not before', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    net.get.set(url, () => ({ status: 404 }));
    let settled = false;
    const p = provider()
      .waitForTransactionReceipt(HASH)
      .finally(() => {
        settled = true;
      });
    const e = rejection(p);
    await vi.advanceTimersByTimeAsync(STELLAR_RECEIPT_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await e).toMatchObject({ code: -32603, data: { reason: 'receipt_timeout', hash: HASH, lastStatus: 404 } });
    // Every 2 s from 0 to 60 s inclusive.
    expect(net.calls).toHaveLength(STELLAR_RECEIPT_TIMEOUT_MS / STELLAR_RECEIPT_POLL_MS + 1);
    expect(net.calls.at(-1)!.at - 1_000_000).toBe(STELLAR_RECEIPT_TIMEOUT_MS);
  });

  it('a status that will not change (400) fails at once; so does a body for another transaction', async () => {
    net.get.set(url, () => ({ status: 400 }));
    expect(await rejection(provider().waitForTransactionReceipt(HASH))).toMatchObject({ code: -32603, data: { status: 400 } });
    expect(net.calls).toHaveLength(1);
    net.get.set(url, () => ({ status: 200, json: horizonTx('cd'.repeat(32)) }));
    expect((await rejection(provider().waitForTransactionReceipt(HASH))).message).toMatch(/malformed/u);
    net.get.set(url, () => ({ status: 200, json: { hash: HASH } }));
    expect((await rejection(provider().waitForTransactionReceipt(HASH))).message).toMatch(/malformed/u);
  });

  it('refuses a malformed hash without a request', async () => {
    for (const h of ['', 'ab', `0x${HASH}`, `${HASH}/../accounts`, 42]) {
      expect((await rejection(provider().waitForTransactionReceipt(h as never))).code).toBe(-32602);
    }
    expect(net.calls).toEqual([]);
  });
});
