// @vitest-environment happy-dom
// hana.evm (D838, D855): the chains from the vault's `ready`, sendSponsored's checks and its port request (fresh
// copies, the window opened in the call), its errors (typed, exact-shape data only), sponsorship() against a mocked
// GET /v1/evm/sponsor/status, and EIP-5792 on the EIP-1193 provider. eth_sendTransaction is never sponsored.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HanaError, ProviderRpcError } from '../../src/client/errors.ts';
import { CALLS_VERSION, EIP5792 } from '../../src/client/ethereum.ts';
import { HanaSponsorError, NOT_OFFERED, sponsoredCalls } from '../../src/client/evm-sponsor.ts';
import { EVM, LOGGED_IN, LOGGED_OUT, type Setup, flush, rpcFetch, setup } from './harness.ts';

const API = 'https://api.hana.test';
const CHAIN = 31337;
const CHECK_IN = '0xa84BBd91a395ae028eE2890DcA0e20570C1Aa39e';
const CALL = { to: CHECK_IN, data: '0x183ff085' };
const HASH = `0x${'ab'.repeat(32)}` as const;
const SPONSORED = { ...LOGGED_IN, sponsoredChains: [CHAIN] };
const EVM_CONFIG = { chains: [{ id: CHAIN, rpcUrl: 'http://127.0.0.1:8545' }], defaultChainId: CHAIN };

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

async function ready(status: typeof LOGGED_IN = SPONSORED, o: Parameters<typeof setup>[0] = {}): Promise<Setup> {
  s = setup({ apiUrl: API, config: { evm: EVM_CONFIG }, ...o });
  await s.vault.connect(status);
  return s;
}

describe('hana.evm.sponsoredChains', () => {
  it('are the vault’s `ready` list, logged in or out, and [] from a vault that sends none', async () => {
    await ready();
    expect(s.client.evm.sponsoredChains).toEqual([CHAIN]);
    s.client.destroy();
    await ready({ ...LOGGED_OUT, sponsoredChains: [CHAIN] } as never);
    expect(s.client.evm.sponsoredChains).toEqual([CHAIN]);
    s.client.destroy();
    await ready(LOGGED_IN);
    expect(s.client.evm.sponsoredChains).toEqual([]);
  });

  it('is a copy (the page can’t change what the SDK checks)', async () => {
    await ready();
    s.client.evm.sponsoredChains.push(1);
    expect(s.client.evm.sponsoredChains).toEqual([CHAIN]);
  });
});

describe('hana.evm.sendSponsored', () => {
  it('sends fresh {to, value: 0x0, data} copies, opens the window in the call, answers {transactionHash, status}', async () => {
    await ready();
    s.vault.handle('evm_sendSponsored', () => ({ result: { transactionHash: HASH.toUpperCase().replace('0X', '0x'), status: 'executed' } }));
    const mine = { ...CALL, value: 0n };
    const calls = [mine, { ...CALL, value: '0x0' }, { ...CALL, value: '0' }];
    const p = s.client.evm.sendSponsored({ chainId: CHAIN, calls });
    // The approval window opened synchronously, before any await (D99).
    expect(s.open).toHaveBeenCalledTimes(1);
    mine.to = '0x0000000000000000000000000000000000000001';
    await expect(p).resolves.toEqual({ transactionHash: HASH, status: 'executed' });
    const sent = s.vault.last('evm_sendSponsored');
    expect(sent.params).toEqual({ chainId: CHAIN, calls: [{ to: CHECK_IN, value: '0x0', data: '0x183ff085' }, { to: CHECK_IN, value: '0x0', data: '0x183ff085' }, { to: CHECK_IN, value: '0x0', data: '0x183ff085' }] });
    expect(sent.raw.popupOpened).toBe(true);
  });

  it.each([
    ['a bad address', [{ ...CALL, to: '0x123' }]],
    ['no function', [{ ...CALL, data: '0x' }]],
    ['odd hex', [{ ...CALL, data: '0x183ff08' }]],
    ['value', [{ ...CALL, value: 1n }]],
    ['value as hex', [{ ...CALL, value: '0x1' }]],
    ['an empty value', [{ ...CALL, value: '0x' }]],
    ['an unknown field', [{ ...CALL, gas: '0x1' }]],
    ['no calls', []],
    ['nine calls', Array.from({ length: 9 }, () => ({ ...CALL }))],
  ])('%s: -32602 before anything is sent', async (_n, calls) => {
    await ready();
    const e = await rejection(s.client.evm.sendSponsored({ chainId: CHAIN, calls: calls as never }));
    expect(e).toBeInstanceOf(HanaSponsorError);
    expect(e.code).toBe(-32602);
    expect(s.vault.seen('evm_sendSponsored')).toEqual([]);
    expect(s.open).not.toHaveBeenCalled();
  });

  it('chain 0, a chain the vault doesn’t sponsor, or logged out: refused before anything is sent', async () => {
    await ready();
    expect((await rejection(s.client.evm.sendSponsored({ chainId: 0, calls: [CALL] }))).code).toBe(-32602);
    const e = await rejection(s.client.evm.sendSponsored({ chainId: 84532, calls: [CALL] }));
    expect(e).toMatchObject({ code: 4100, message: NOT_OFFERED, data: { reason: 'chain_not_sponsored', chainId: 84532 } });
    s.client.destroy();
    await ready({ ...LOGGED_OUT, sponsoredChains: [CHAIN] } as never);
    expect((await rejection(s.client.evm.sendSponsored({ chainId: CHAIN, calls: [CALL] }))).code).toBe(4100);
    expect(s.vault.seen('evm_sendSponsored')).toEqual([]);
  });

  it('a refusal is a HanaSponsorError whose data has only exact-shape fields', async () => {
    await ready();
    s.vault.handle('evm_sendSponsored', () => ({
      error: {
        code: 4100,
        message: 'The action didn’t go through, so nothing changed.',
        data: { status: 422, reason: 'reverted', transactionHash: HASH, callIndex: 9, retryAfterS: -1, requestId: 'not an id', signature: '0xdead', extra: { a: 1 } },
      },
    }));
    const e = await rejection(s.client.evm.sendSponsored({ chainId: CHAIN, calls: [CALL] }));
    expect(e).toBeInstanceOf(HanaSponsorError);
    expect(e.message).toBe('The action didn’t go through, so nothing changed.');
    expect(e.data).toEqual({ status: 422, reason: 'reverted', transactionHash: HASH });
  });

  it('the user’s decline and busy keep their codes', async () => {
    await ready();
    s.vault.handle('evm_sendSponsored', () => ({ error: { code: 4001, message: 'The user rejected the request' } }));
    expect((await rejection(s.client.evm.sendSponsored({ chainId: CHAIN, calls: [CALL] }))).code).toBe(4001);
    s.vault.handle('evm_sendSponsored', () => ({ error: { code: 'busy', message: 'Your last action is still going through. Wait for it to finish, then try again.', data: { reason: 'sponsor_in_flight' } } }));
    expect(await rejection(s.client.evm.sendSponsored({ chainId: CHAIN, calls: [CALL] }))).toMatchObject({ code: 'busy', data: { reason: 'sponsor_in_flight' } });
  });

  it('sponsoredCalls never hands back the caller’s objects', () => {
    const c = { ...CALL };
    const out = sponsoredCalls([c]);
    expect(out[0]).not.toBe(c);
    expect(Object.keys(out[0]!)).toEqual(['to', 'value', 'data']);
  });
});

describe('hana.evm.sponsorship', () => {
  it('asks GET /v1/evm/sponsor/status with the key, and reads the answer strictly', async () => {
    await ready(SPONSORED, { fetch: async () => new Response(JSON.stringify({ available: true, remainingToday: '9000000000000000', other: 1 })) });
    await expect(s.client.evm.sponsorship(CHAIN)).resolves.toEqual({ available: true, remainingToday: '9000000000000000' });
    const [url, init] = s.fetch.mock.calls.at(-1) as [string, RequestInit];
    expect(url).toBe(`${API}/v1/evm/sponsor/status?chainId=${CHAIN}`);
    expect(init).toMatchObject({ method: 'GET', credentials: 'omit', headers: { 'x-hana-key': expect.stringMatching(/^pk_test_/u) } });
  });

  it('a chain the vault didn’t report: not available, with no request', async () => {
    await ready(LOGGED_IN);
    await expect(s.client.evm.sponsorship(CHAIN)).resolves.toEqual({ available: false, reason: 'chain_not_enabled' });
    expect(s.fetch).not.toHaveBeenCalled();
  });

  it('not available today, a malformed reason left out, a 429 with its retry-after', async () => {
    await ready(SPONSORED, { fetch: async () => new Response(JSON.stringify({ available: false, reason: 'budget_exhausted', remainingToday: '0' })) });
    await expect(s.client.evm.sponsorship(CHAIN)).resolves.toEqual({ available: false, reason: 'budget_exhausted', remainingToday: '0' });
    s.client.destroy();
    await ready(SPONSORED, { fetch: async () => new Response(JSON.stringify({ available: false, reason: 'Bad Reason!' })) });
    await expect(s.client.evm.sponsorship(CHAIN)).resolves.toEqual({ available: false, reason: 'not_available' });
    s.client.destroy();
    await ready(SPONSORED, { fetch: async () => new Response(JSON.stringify({ error: 'x', code: 'rate_limited', requestId: 'r' }), { status: 429, headers: { 'retry-after': '12' } }) });
    expect(await rejection(s.client.evm.sponsorship(CHAIN))).toMatchObject({ code: 'rate_limited', data: { status: 429, reason: 'rate_limited', retryAfterS: 12 } });
  });
});

describe('EIP-5792 on hana.ethereum (D838)', () => {
  const request = (method: string, params?: unknown) => s.client.ethereum.request({ method, ...(params === undefined ? {} : { params: params as never }) });
  async function providerError(p: Promise<unknown>): Promise<ProviderRpcError> {
    const e = await p.then(
      () => null,
      (err: unknown) => err,
    );
    expect(e).toBeInstanceOf(ProviderRpcError);
    return e as ProviderRpcError;
  }
  const batch = (over: Record<string, unknown> = {}) => [{ version: CALLS_VERSION, chainId: '0x7a69', atomicRequired: true, calls: [{ ...CALL }], ...over }];

  it('wallet_getCapabilities: atomic on the configured chains the vault sponsors, nothing elsewhere', async () => {
    await ready();
    await expect(request('wallet_getCapabilities', [EVM])).resolves.toEqual({ '0x7a69': { atomic: { status: 'supported' } } });
    await expect(request('wallet_getCapabilities', [EVM, ['0x1']])).resolves.toEqual({});
    expect((await providerError(request('wallet_getCapabilities', ['0x0000000000000000000000000000000000000001']))).code).toBe(4100);
    s.client.destroy();
    await ready(LOGGED_IN);
    await expect(request('wallet_getCapabilities', [EVM])).resolves.toEqual({});
  });

  it('wallet_sendCalls: one gas-free action, the id, then wallet_getCallsStatus from the chain’s receipt', async () => {
    const receipt = { status: '0x1', blockHash: `0x${'01'.repeat(32)}`, blockNumber: '0x10', gasUsed: '0x5208', logs: [{ address: EVM, data: '0x', topics: [], extra: 1 }], transactionHash: HASH };
    const rpc = rpcFetch({ eth_getTransactionReceipt: () => receipt });
    await ready(SPONSORED, { fetch: rpc });
    s.vault.handle('evm_sendSponsored', () => ({ result: { transactionHash: HASH, status: 'executed' } }));
    const p = request('wallet_sendCalls', batch());
    expect(s.open).toHaveBeenCalledTimes(1);
    const { id } = (await p) as { id: string };
    expect(id).toMatch(/^0x[0-9a-f]{64}$/u);
    expect(s.vault.last('evm_sendSponsored').params).toEqual({ chainId: CHAIN, calls: [{ to: CHECK_IN, value: '0x0', data: '0x183ff085' }] });
    await expect(request('wallet_getCallsStatus', [id])).resolves.toEqual({
      version: CALLS_VERSION,
      id,
      chainId: '0x7a69',
      atomic: true,
      status: 200,
      receipts: [{ logs: [{ address: EVM, data: '0x', topics: [] }], status: '0x1', blockHash: receipt.blockHash, blockNumber: '0x10', gasUsed: '0x5208', transactionHash: HASH }],
    });
    expect(rpc.calls.at(-1)).toEqual({ method: 'eth_getTransactionReceipt', params: [HASH] });
  });

  it('an app’s own id is used, a duplicate is 5720; no receipt yet is 100; an unknown id 5730', async () => {
    await ready(SPONSORED, { fetch: rpcFetch({ eth_getTransactionReceipt: null }) });
    s.vault.handle('evm_sendSponsored', () => ({ result: { transactionHash: HASH, status: 'executed' } }));
    await expect(request('wallet_sendCalls', batch({ id: 'mine-1' }))).resolves.toEqual({ id: 'mine-1' });
    expect((await providerError(request('wallet_sendCalls', batch({ id: 'mine-1' })))).code).toBe(EIP5792.duplicateId);
    await expect(request('wallet_getCallsStatus', ['mine-1'])).resolves.toMatchObject({ status: 100, atomic: true });
    expect((await providerError(request('wallet_getCallsStatus', ['other']))).code).toBe(EIP5792.unknownBundle);
  });

  it.each([
    ['version 1.0', batch({ version: '1.0' }), -32602],
    ['no atomicRequired', [{ version: CALLS_VERSION, chainId: '0x7a69', calls: [{ ...CALL }] }], -32602],
    ['value on a call', batch({ calls: [{ ...CALL, value: '0x1' }] }), -32602],
    ['a contract creation', batch({ calls: [{ data: '0x6000' }] }), -32602],
    ['a chain the vault doesn’t sponsor', batch({ chainId: '0x14a34' }), EIP5792.unsupportedChain],
    ['a required capability', batch({ capabilities: { paymasterService: { url: 'https://pm.test' } } }), EIP5792.unsupportedCapability],
    ['a required capability on a call', batch({ calls: [{ ...CALL, capabilities: { auxiliaryFunds: {} } }] }), EIP5792.unsupportedCapability],
    ['nine calls', batch({ calls: Array.from({ length: 9 }, () => ({ ...CALL })) }), EIP5792.bundleTooLarge],
    ['another from', batch({ from: '0x0000000000000000000000000000000000000001' }), 4100],
  ])('%s: refused (%s → its code) before anything is sent', async (_n, params, code) => {
    await ready();
    expect((await providerError(request('wallet_sendCalls', params))).code).toBe(code);
    expect(s.vault.seen('evm_sendSponsored')).toEqual([]);
  });

  it('an optional capability is ignored; a decline is 4001', async () => {
    await ready();
    s.vault.handle('evm_sendSponsored', () => ({ error: { code: 4001, message: 'The user rejected the request' } }));
    expect((await providerError(request('wallet_sendCalls', batch({ capabilities: { paymasterService: { url: 'x', optional: true } } })))).code).toBe(4001);
    expect(s.vault.seen('evm_sendSponsored')).toHaveLength(1);
  });

  it('eth_sendTransaction is never sponsored (D838): it goes the ordinary way, and the source has no path to it', async () => {
    await ready(SPONSORED, { fetch: rpcFetch({}) });
    await providerError(request('eth_sendTransaction', [{ to: CHECK_IN, data: '0x183ff085' }]));
    await flush();
    expect(s.vault.seen('evm_sendSponsored')).toEqual([]);
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../src/client/ethereum.ts'), 'utf8');
    const send = src.slice(src.indexOf('  #sendTransaction('), src.indexOf('  #prepare(): ApprovalTicket'));
    const sendTx = send.slice(0, send.indexOf('  // ---- EIP-5792'));
    expect(sendTx).not.toMatch(/sendSponsored|evm_sendSponsored/u);
  });
});
