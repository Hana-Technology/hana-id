// Test apps and mainnet chains (docs/decisions.md D39): the allowlist of test EVM chains, the Stellar mainnet
// passphrase, and which sign requests name a mainnet.
import { describe, expect, it } from 'vitest';
import {
  STELLAR_MAINNET_PASSPHRASE,
  TEST_EVM_CHAINS,
  isTestEvmChain,
  isTestPublishableKey,
  isTestStellarNetwork,
  mainnetOfRequest,
  parsePortRequest,
} from '../src/index.ts';

const TESTNET = 'Test SDF Network ; September 2015';
const EVM = '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD';

const req = (method: string, params: unknown) => {
  const r = parsePortRequest({ v: 1, id: 'r1', method, params });
  if (!r) throw new Error(`bad request ${method}`);
  return r as Parameters<typeof mainnetOfRequest>[0];
};
const tx = (chainId: number) => ({ type: '0x2', chainId: `0x${chainId.toString(16)}`, nonce: '0x0', gas: '0x5208', maxFeePerGas: '0x1', maxPriorityFeePerGas: '0x1', to: EVM, value: '0x0', data: '0x' });
const typed = (domain: Record<string, unknown>) =>
  JSON.stringify({
    types: { EIP712Domain: [{ name: 'name', type: 'string' }, ...(domain.chainId === undefined ? [] : [{ name: 'chainId', type: 'uint256' }])], Mail: [{ name: 'text', type: 'string' }] },
    primaryType: 'Mail',
    domain,
    message: { text: 'hi' },
  });

describe('test apps and mainnet chains (D39)', () => {
  it('allows exactly the listed EVM testnets and local chains', () => {
    for (const id of [11155111, 17000, 560048, 84532, 421614, 11155420, 57054, 14601, 97, 80002, 43113, 31337, 1337]) expect(isTestEvmChain(id)).toBe(true);
    expect(Object.keys(TEST_EVM_CHAINS)).toHaveLength(13);
    // Mainnets, and chains nobody listed, are refused alike.
    for (const id of [1, 8453, 42161, 10, 146, 56, 137, 43114, 999_999, 0, -1, 1.5, Number.NaN]) expect(isTestEvmChain(id)).toBe(false);
    // Inherited object keys are not chains.
    expect(isTestEvmChain('constructor' as unknown as number)).toBe(false);
  });

  it('refuses only the Stellar public network', () => {
    expect(STELLAR_MAINNET_PASSPHRASE).toBe('Public Global Stellar Network ; September 2015');
    expect(isTestStellarNetwork(STELLAR_MAINNET_PASSPHRASE)).toBe(false);
    expect(isTestStellarNetwork(TESTNET)).toBe(true);
    expect(isTestStellarNetwork('Test SDF Future Network ; October 2022')).toBe(true);
  });

  it('tells test keys apart', () => {
    expect(isTestPublishableKey('pk_test_abc')).toBe(true);
    expect(isTestPublishableKey('pk_live_abc')).toBe(false);
  });

  it('names the mainnet a sign request is for, and null for test networks and requests with no network', () => {
    const xdr = 'AAAA';
    expect(mainnetOfRequest(req('stellar_signTransaction', { xdr, networkPassphrase: STELLAR_MAINNET_PASSPHRASE }))).toEqual({ chain: 'stellar', networkPassphrase: STELLAR_MAINNET_PASSPHRASE });
    expect(mainnetOfRequest(req('stellar_signTransaction', { xdr, networkPassphrase: TESTNET }))).toBeNull();
    expect(mainnetOfRequest(req('stellar_signAuthEntry', { preimageXdr: xdr, networkPassphrase: STELLAR_MAINNET_PASSPHRASE }))).toEqual({ chain: 'stellar', networkPassphrase: STELLAR_MAINNET_PASSPHRASE });
    expect(mainnetOfRequest(req('stellar_signAuthEntry', { preimageXdr: xdr, networkPassphrase: TESTNET }))).toBeNull();
    expect(mainnetOfRequest(req('eth_signTransaction', { tx: tx(1) }))).toEqual({ chain: 'evm', chainId: 1 });
    expect(mainnetOfRequest(req('eth_signTransaction', { tx: tx(8453) }))).toEqual({ chain: 'evm', chainId: 8453 });
    expect(mainnetOfRequest(req('eth_signTransaction', { tx: tx(84532) }))).toBeNull();
    expect(mainnetOfRequest(req('eth_signTypedData_v4', [EVM, typed({ name: 'X', chainId: 1 })]))).toEqual({ chain: 'evm', chainId: 1 });
    expect(mainnetOfRequest(req('eth_signTypedData_v4', [EVM, typed({ name: 'X', chainId: 11155111 })]))).toBeNull();
    // No chain in the domain: the signature names no network (D35), so it is not refused.
    expect(mainnetOfRequest(req('eth_signTypedData_v4', [EVM, typed({ name: 'X' })]))).toBeNull();
    expect(mainnetOfRequest(req('personal_sign', ['0x68656c6c6f', EVM]))).toBeNull();
    expect(mainnetOfRequest(req('stellar_signMessage', { message: 'hello' }))).toBeNull();
    expect(mainnetOfRequest(req('hana_signRaw', { chain: 'evm', digest: new Uint8Array(32) }))).toBeNull();
  });
});
