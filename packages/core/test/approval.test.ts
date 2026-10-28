import { createHash } from 'node:crypto';
import { bytesToHex } from '@noble/hashes/utils';
import { serializeTransaction } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_KINDS,
  type ApprovalDigestInput,
  DecodeError,
  approvalContextString,
  approvalDigest,
  approvalDigestPreimage,
  approvalKindChain,
  decodeApprovalRequest,
  digestsEqual,
  rawSigningWarning,
  validateApprovalSubject,
} from '../src/index.ts';
import { PASSPHRASE, POOL, USER, addr, authPreimageBytes, invocation, paymentOp, txBytes } from './stellar-fixtures.ts';

const EVM_USER = '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826';

const base: ApprovalDigestInput = {
  id: '0123456789abcdef0123456789abcdef',
  kind: 'stellar_tx',
  chain: 'stellar',
  address: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7',
  parentOrigin: 'https://app.example',
  context: { networkPassphrase: 'Test SDF Network ; September 2015' },
  bytes: new Uint8Array([1, 2, 3, 4, 5]),
};

/** An independent implementation of the layout, with Node's Buffer and crypto. */
function referenceDigest(i: ApprovalDigestInput): string {
  const s = (v: string) => {
    const b = Buffer.from(v, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(b.length);
    return Buffer.concat([len, b]);
  };
  const ctx = 'networkPassphrase' in i.context ? i.context.networkPassphrase : String(i.context.chainId);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(i.bytes.length);
  return createHash('sha256')
    .update(
      Buffer.concat([
        Buffer.from('hana-id/approve/v1'),
        s(i.id),
        s(i.kind),
        s(i.chain),
        s(i.address),
        s(i.parentOrigin),
        s(ctx),
        len,
        Buffer.from(i.bytes),
      ]),
    )
    .digest('hex');
}

describe('approval digest', () => {
  it('matches the frozen vector and an independent implementation', () => {
    // Frozen: a change here changes what every approval popup returns.
    expect(bytesToHex(approvalDigest(base))).toBe('a11469a8133f107e5bb9c5e255762593000beae91c0dacde5a48ca9b774a8bee');
    expect(bytesToHex(approvalDigest(base))).toBe(referenceDigest(base));
    const evm: ApprovalDigestInput = {
      ...base,
      kind: 'eip712',
      chain: 'evm',
      address: EVM_USER,
      context: { chainId: 8453 },
    };
    expect(bytesToHex(approvalDigest(evm))).toBe(referenceDigest(evm));
  });

  it('starts with the domain and ends with the length-prefixed bytes', () => {
    const pre = approvalDigestPreimage(base);
    expect(Buffer.from(pre.subarray(0, 18)).toString()).toBe('hana-id/approve/v1');
    expect(Array.from(pre.subarray(pre.length - 9))).toEqual([5, 0, 0, 0, 1, 2, 3, 4, 5]);
  });

  it('changes when any bound field changes, the context alone included', () => {
    const d0 = bytesToHex(approvalDigest(base));
    const variants: ApprovalDigestInput[] = [
      { ...base, id: 'ffffffffffffffffffffffffffffffff' },
      { ...base, kind: 'stellar_auth_entry' },
      { ...base, address: 'GBBBB' },
      { ...base, parentOrigin: 'https://evil.example' },
      { ...base, context: { networkPassphrase: 'Public Global Stellar Network ; September 2015' } },
      { ...base, bytes: new Uint8Array([1, 2, 3, 4, 6]) },
      { ...base, bytes: new Uint8Array([1, 2, 3, 4, 5, 0]) },
    ];
    const digests = variants.map((v) => bytesToHex(approvalDigest(v)));
    expect(new Set([d0, ...digests]).size).toBe(variants.length + 1);
    // Length prefixes keep field boundaries: moving a character between id and kind changes the digest.
    const shifted = { ...base, id: `${base.id}s`, kind: 'tellar_tx' as never };
    expect(() => approvalDigest(shifted)).toThrow(); // and an unknown kind is refused outright
  });

  it('compares digests in constant time', () => {
    const d = approvalDigest(base);
    expect(digestsEqual(d, approvalDigest(base))).toBe(true);
    expect(digestsEqual(d, approvalDigest({ ...base, id: 'x' }))).toBe(false);
    expect(digestsEqual(d, d.subarray(0, 31))).toBe(false);
    expect(digestsEqual(d, 'abc' as never)).toBe(false);
  });
});

describe('approval subject validation', () => {
  it('pairs every kind with its chain', () => {
    expect(APPROVAL_KINDS.map((k) => [k, approvalKindChain(k)])).toEqual([
      ['stellar_tx', 'stellar'],
      ['stellar_auth_entry', 'stellar'],
      ['stellar_message', 'stellar'],
      ['evm_tx', 'evm'],
      ['personal_sign', 'evm'],
      ['eip712', 'evm'],
      ['raw', null],
    ]);
  });

  it.each([
    ['a kind on the wrong chain', { ...base, chain: 'evm', context: { chainId: 1 } }],
    ['an unknown kind', { ...base, kind: 'eth_sign' }],
    ['an unknown chain', { ...base, chain: 'solana' }],
    ['an EVM context on Stellar', { ...base, context: { chainId: 1 } }],
    ['extra context keys', { ...base, context: { networkPassphrase: 'x', chainId: 1 } }],
    ['an empty passphrase', { ...base, context: { networkPassphrase: '' } }],
    ['a zero chain ID', { ...base, kind: 'evm_tx', chain: 'evm', context: { chainId: 0 } }],
    ['a fractional chain ID', { ...base, kind: 'evm_tx', chain: 'evm', context: { chainId: 1.5 } }],
    ['an empty address', { ...base, address: '' }],
    ['an address with a lone surrogate', { ...base, address: `G${String.fromCharCode(0xd800)}` }],
    ['bytes as an array', { ...base, bytes: [1, 2] }],
    ['oversize bytes', { ...base, bytes: new Uint8Array(192 * 1024 + 1) }],
    [
      'a raw EVM request that is not 32 bytes',
      { ...base, kind: 'raw', chain: 'evm', context: { chainId: 1 }, bytes: new Uint8Array(31) },
    ],
    ['an empty raw Stellar request', { ...base, kind: 'raw', bytes: new Uint8Array() }],
    ['a raw Stellar request over 4 KiB', { ...base, kind: 'raw', bytes: new Uint8Array(4097) }],
  ])('refuses %s', (_, subject) => {
    expect(() => validateApprovalSubject(subject as never)).toThrow();
    expect(() => approvalDigest(subject as never)).toThrow();
  });

  it('refuses an empty id or parent origin', () => {
    expect(() => approvalDigest({ ...base, id: '' })).toThrow();
    expect(() => approvalDigest({ ...base, parentOrigin: '' })).toThrow();
  });

  it('renders the context string', () => {
    expect(approvalContextString('stellar', { networkPassphrase: PASSPHRASE })).toBe(PASSPHRASE);
    expect(approvalContextString('evm', { chainId: 8453 })).toBe('8453');
  });

  it('words the raw warning as the spec does', () => {
    expect(rawSigningWarning('Stellar', 'Acme')).toBe(
      "Raw signing can authorize any transaction, authorization or message on Stellar. Hana can't tell what this is. Only approve if you trust Acme completely.",
    );
  });
});

describe('decodeApprovalRequest', () => {
  const evmTx = (chainId: number) =>
    Buffer.from(
      serializeTransaction({
        type: 'eip1559',
        chainId,
        nonce: 1,
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 1n,
        gas: 21000n,
        to: EVM_USER,
        value: 1n,
      }).slice(2),
      'hex',
    );
  const typedData = (chainId: number) =>
    new TextEncoder().encode(
      JSON.stringify({
        types: { EIP712Domain: [{ name: 'chainId', type: 'uint256' }], M: [{ name: 'a', type: 'uint8' }] },
        primaryType: 'M',
        domain: { chainId },
        message: { a: 1 },
      }),
    );
  const evm = (kind: 'evm_tx' | 'eip712' | 'personal_sign', bytes: Uint8Array, chainId = 8453) =>
    ({ kind, chain: 'evm', address: EVM_USER, context: { chainId }, bytes }) as const;
  const stellar = (
    kind: 'stellar_tx' | 'stellar_auth_entry' | 'stellar_message' | 'raw',
    bytes: Uint8Array,
    networkPassphrase = PASSPHRASE,
  ) => ({ kind, chain: 'stellar', address: USER, context: { networkPassphrase }, bytes }) as const;

  it('decodes each kind', () => {
    expect(decodeApprovalRequest(stellar('stellar_tx', txBytes([paymentOp()])))).toMatchObject({
      kind: 'stellar_tx',
      networkPassphrase: PASSPHRASE,
      envelope: { envelope: 'tx' },
    });
    expect(
      decodeApprovalRequest(stellar('stellar_auth_entry', authPreimageBytes(invocation(POOL, 'f', [addr(USER)])))),
    ).toMatchObject({
      kind: 'stellar_auth_entry',
      preimage: { invocation: { function: { contract: POOL } } },
    });
    expect(decodeApprovalRequest(stellar('stellar_message', new TextEncoder().encode('hi')))).toMatchObject({
      message: { text: 'hi' },
    });
    expect(decodeApprovalRequest(evm('evm_tx', evmTx(8453)))).toMatchObject({
      kind: 'evm_tx',
      chainId: 8453,
      tx: { chainId: 8453n },
    });
    expect(decodeApprovalRequest(evm('eip712', typedData(8453)))).toMatchObject({
      kind: 'eip712',
      view: { primaryType: 'M' },
    });
    expect(decodeApprovalRequest(evm('personal_sign', new TextEncoder().encode('Sign in')))).toMatchObject({
      message: { text: 'Sign in' },
    });
  });

  it('refuses bytes for another chain or network than the context', () => {
    const code = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return (e as DecodeError).code;
      }
      return 'no error';
    };
    expect(code(() => decodeApprovalRequest(evm('evm_tx', evmTx(1))))).toBe('network_mismatch');
    expect(code(() => decodeApprovalRequest(evm('eip712', typedData(1))))).toBe('network_mismatch');
    const auth = authPreimageBytes(invocation(POOL, 'f', []));
    expect(
      code(() =>
        decodeApprovalRequest(stellar('stellar_auth_entry', auth, 'Public Global Stellar Network ; September 2015')),
      ),
    ).toBe('network_mismatch');
    expect(code(() => decodeApprovalRequest(evm('eip712', new Uint8Array([0xff]))))).toBe('malformed');
    expect(code(() => decodeApprovalRequest({ ...evm('evm_tx', evmTx(8453)), chain: 'stellar' } as never))).toBe(
      'malformed',
    );
  });

  it('never decodes raw bytes, even when they are a valid transaction', () => {
    const tx = txBytes([paymentOp()]);
    expect(decodeApprovalRequest(stellar('raw', tx))).toEqual({
      kind: 'raw',
      chain: 'stellar',
      hex: `0x${Buffer.from(tx).toString('hex')}`,
    });
    const digest = new Uint8Array(32).fill(0xab);
    expect(
      decodeApprovalRequest({ kind: 'raw', chain: 'evm', address: EVM_USER, context: { chainId: 1 }, bytes: digest }),
    ).toEqual({
      kind: 'raw',
      chain: 'evm',
      hex: `0x${'ab'.repeat(32)}`,
    });
  });

  it('throws only DecodeError', () => {
    expect(() => decodeApprovalRequest(stellar('stellar_tx', new Uint8Array([1, 2, 3])))).toThrow(DecodeError);
  });
});
