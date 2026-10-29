// The vault signs what normalizeTypedData returns; signTypedData hashes it with typed-data.ts's hashTypedData, the
// single parser and hasher (sweep CORE-5). The second, independent hasher (test/eip712-reference.ts, test-only, checked
// against viem in signers.test.ts) must give the same digest for every normalized input, and the signature must
// recover to the signer's address over that digest.
import { describe, expect, it } from 'vitest';
import { hashTypedData as signerHash } from './eip712-reference.ts';
import { evmSignerAddress, recoverEvmAddress, signTypedData } from '../src/signers/evm.ts';
import { hashTypedData, normalizeTypedData } from '../src/typed-data.ts';

const MAIL = {
  types: {
    EIP712Domain: [
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ],
    Person: [
      { name: 'name', type: 'string' },
      { name: 'wallet', type: 'address' },
    ],
    Mail: [
      { name: 'from', type: 'Person' },
      { name: 'to', type: 'Person' },
      { name: 'contents', type: 'string' },
    ],
  },
  primaryType: 'Mail',
  domain: { name: 'Ether Mail', version: '1', chainId: 1, verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC' },
  message: {
    from: { name: 'Cow', wallet: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826' },
    to: { name: 'Bob', wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB' },
    contents: 'Hello, Bob!',
  },
};

// Every atomic kind, nested and fixed arrays, structs in arrays, negative and maximal integers, a salted domain.
const SINK = {
  types: {
    EIP712Domain: [
      { name: 'name', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'salt', type: 'bytes32' },
    ],
    Item: [
      { name: 'id', type: 'int64' },
      { name: 'flag', type: 'bool' },
      { name: 'tag', type: 'bytes4' },
    ],
    Order: [
      { name: 'items', type: 'Item[]' },
      { name: 'pairs', type: 'uint8[2][]' },
      { name: 'owners', type: 'address[2]' },
      { name: 'blob', type: 'bytes' },
      { name: 'note', type: 'string' },
      { name: 'delta', type: 'int256' },
      { name: 'cap', type: 'uint256' },
    ],
  },
  primaryType: 'Order',
  domain: { name: 'Sink', chainId: '0x89', salt: `0x${'ab'.repeat(32)}` },
  message: {
    items: [
      { id: -5, flag: true, tag: '0xdeadbeef' },
      { id: '9223372036854775807', flag: false, tag: '0x00000000' },
    ],
    pairs: [
      [1, 2],
      [255, '0x10'],
    ],
    owners: ['0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826', '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
    blob: '0x0102030405',
    note: 'café \u{1f600}',
    delta: '-57896044618658097711785492504343953926634992332820282019728792003956564819968',
    cap: '115792089237316195423570985008687907853269984665640564039457584007913129639935',
  },
};

// A fixed test scalar (not a real key).
const D = new Uint8Array(32).fill(7);

describe('EIP-712: the parser and the signer hash normalized data alike', () => {
  it.each([
    ['EIP-712 Mail', MAIL],
    ['every atomic kind and array shape', SINK],
  ])('%s', (_, data) => {
    const normalized = normalizeTypedData(JSON.stringify(data));
    const digest = hashTypedData(normalized);
    expect(signerHash(normalized)).toEqual(digest);
    const sig = signTypedData(D, normalized);
    expect(recoverEvmAddress(digest, Uint8Array.from(Buffer.from(sig.slice(2), 'hex')))).toBe(evmSignerAddress(D));
  });

  it('hashes the EIP-712 Mail example to its published digest through both', () => {
    const normalized = normalizeTypedData(JSON.stringify(MAIL));
    const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
    expect(hex(hashTypedData(normalized))).toBe('be609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2');
    expect(hex(signerHash(normalized))).toBe('be609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2');
  });
});
