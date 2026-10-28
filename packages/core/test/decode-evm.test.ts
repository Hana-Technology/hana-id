import { hexToBytes } from '@noble/hashes/utils';
import {
  type Hex,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  parseAbiParameters,
  serializeTransaction,
  toRlp,
} from 'viem';
import { describe, expect, it } from 'vitest';
import {
  ABI_MAX_ARRAY_LENGTH,
  DecodeError,
  decodeAbiParameters,
  decodeEvmTransaction,
  decodeFunctionData,
  decodeRlp,
  functionSelector,
  knownFunction,
  knownFunctions,
  parseFunctionSignature,
} from './entries.ts';

const b = (hex: string) => hexToBytes(hex.replace(/^0x/u, ''));

const errCode = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof DecodeError ? e.code : `not a DecodeError: ${String(e)}`;
  }
  return 'no error';
};

const SPENDER = '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD';
const USDC_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

describe('decodeRlp', () => {
  it('decodes what viem encodes', () => {
    const item = ['0x', '0x7f', '0x80', `0x${'11'.repeat(60)}`, ['0x01', ['0x']]] as const;
    const out = decodeRlp(b(toRlp(item as never)));
    expect(out).toEqual([new Uint8Array(), b('7f'), b('80'), b('11'.repeat(60)), [b('01'), [new Uint8Array()]]]);
  });

  it.each([
    ['a single byte < 0x80 wrapped', '8105'],
    ['a long-form length below 56', 'b80100'],
    ['a length with a leading zero', `b90038${'00'.repeat(56)}`],
    ['a string running past the end', '83aabb'],
    ['trailing bytes', '0102'],
    ['a list running past the end', 'c3010203'.slice(0, 6)],
    ['empty input', ''],
  ])('refuses %s', (_, hex) => {
    expect(errCode(() => decodeRlp(b(hex)))).toBe('malformed');
  });

  it('caps nesting', () => {
    let nested: unknown = [];
    for (let i = 0; i < 40; i++) nested = [nested];
    expect(errCode(() => decodeRlp(b(toRlp(nested as never))))).toBe('too_large');
  });
});

describe('function signatures and selectors', () => {
  it('known selectors equal their well-known values', () => {
    const expected: Record<string, string> = {
      'transfer(address,uint256)': '0xa9059cbb',
      'transferFrom(address,address,uint256)': '0x23b872dd',
      'approve(address,uint256)': '0x095ea7b3',
      'increaseAllowance(address,uint256)': '0x39509351',
      'decreaseAllowance(address,uint256)': '0xa457c2d7',
      'permit(address,address,uint256,uint256,uint8,bytes32,bytes32)': '0xd505accf',
      'safeTransferFrom(address,address,uint256)': '0x42842e0e',
      'safeTransferFrom(address,address,uint256,bytes)': '0xb88d4fde',
      'setApprovalForAll(address,bool)': '0xa22cb465',
      'safeTransferFrom(address,address,uint256,uint256,bytes)': '0xf242432a',
      'safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)': '0x2eb2c2d6',
      'deposit()': '0xd0e30db0',
      'withdraw(uint256)': '0x2e1a7d4d',
      'multicall(bytes[])': '0xac9650d8',
      'multicall(uint256,bytes[])': '0x5ae401dc',
    };
    expect(
      knownFunctions()
        .map((f) => f.signature)
        .sort(),
    ).toEqual(Object.keys(expected).sort());
    for (const [sig, sel] of Object.entries(expected)) {
      expect(functionSelector(sig)).toBe(sel);
      expect(knownFunction(sel)?.signature).toBe(sig);
    }
    expect(knownFunction('0xA9059CBB')?.name).toBe('transfer');
    expect(knownFunction('0x12345678')).toBeUndefined();
  });

  it('parses canonical signatures with tuples and arrays', () => {
    const fn = parseFunctionSignature('swap((address,uint256)[],bytes32[2],string)');
    expect(fn.name).toBe('swap');
    expect(fn.params.map((p) => p.kind)).toEqual(['array', 'array', 'string']);
    expect(fn.selector).toBe(functionSelector('swap((address,uint256)[],bytes32[2],string)'));
  });

  it.each([
    'transfer(address, uint256)',
    'transfer(address to,uint256 amount)',
    'transfer(address,uint)',
    'transfer(address,uint7)',
    'f(fixed128x18)',
    'f(function)',
    'f(())',
    'f(address,)',
    'f(address',
    '1f()',
    'f()x',
    'f(uint256[0])',
  ])('refuses non-canonical or unsupported %s', (sig) => {
    expect(() => parseFunctionSignature(sig)).toThrow(DecodeError);
  });

  it('caps fixed array lengths at ABI_MAX_ARRAY_LENGTH', () => {
    expect(parseFunctionSignature(`f(uint256[${ABI_MAX_ARRAY_LENGTH}])`).params[0]).toMatchObject({
      kind: 'array',
      length: ABI_MAX_ARRAY_LENGTH,
    });
    for (const sig of [`f(string[${ABI_MAX_ARRAY_LENGTH + 1}])`, 'f(string[1000000000])', 'f(uint8[2][1025])']) {
      expect(errCode(() => parseFunctionSignature(sig))).toBe('too_large');
    }
  });
});

describe('decodeAbiParameters', () => {
  const types = '(address,uint256)[], bytes, string, int24, bool, bytes4, uint8[3], address[]';
  const values = [
    [
      [SPENDER, 5n],
      [USDC_ADDRESS, 2n ** 256n - 1n],
    ],
    '0xdeadbeef00',
    'héllo',
    -8388608,
    true,
    '0x01020304',
    [1, 2, 255],
    [],
  ] as const;

  it('decodes what viem encodes, with every value checked', () => {
    const data = encodeAbiParameters(parseAbiParameters(types), values as never);
    const fn = parseFunctionSignature('f((address,uint256)[],bytes,string,int24,bool,bytes4,uint8[3],address[])');
    const out = decodeAbiParameters(fn.params, b(data));
    expect(out[0]).toEqual({
      type: '(address,uint256)[]',
      kind: 'array',
      items: [
        {
          type: '(address,uint256)',
          kind: 'tuple',
          items: [
            { type: 'address', kind: 'address', value: SPENDER },
            { type: 'uint256', kind: 'uint', value: 5n },
          ],
        },
        {
          type: '(address,uint256)',
          kind: 'tuple',
          items: [
            { type: 'address', kind: 'address', value: USDC_ADDRESS },
            { type: 'uint256', kind: 'uint', value: 2n ** 256n - 1n },
          ],
        },
      ],
    });
    expect(out.slice(1)).toEqual([
      { type: 'bytes', kind: 'bytes', value: '0xdeadbeef00' },
      { type: 'string', kind: 'string', value: 'héllo', hex: '0x68c3a96c6c6f' },
      { type: 'int24', kind: 'int', value: -8388608n },
      { type: 'bool', kind: 'bool', value: true },
      { type: 'bytes4', kind: 'bytes', value: '0x01020304' },
      {
        type: 'uint8[3]',
        kind: 'array',
        items: [1n, 2n, 255n].map((value) => ({ type: 'uint8', kind: 'uint', value })),
      },
      { type: 'address[]', kind: 'array', items: [] },
    ]);
  });

  const transfer = parseFunctionSignature('transfer(address,uint256)');
  const good = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [SPENDER, 10n] });

  it('decodes calldata and checks the selector', () => {
    expect(decodeFunctionData(transfer, b(good)).map((v) => (v as { value: unknown }).value)).toEqual([SPENDER, 10n]);
    const approve = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [SPENDER, 10n] });
    expect(errCode(() => decodeFunctionData(transfer, b(approve)))).toBe('invalid_value');
  });

  it('refuses non-canonical encodings', () => {
    const word = (hex: string) => hex.padStart(64, '0');
    const body = good.slice(10);
    const sel = good.slice(0, 10);
    // Dirty high bytes in an address.
    expect(errCode(() => decodeFunctionData(transfer, b(`${sel}ff${body.slice(2)}`)))).toBe('invalid_value');
    // Trailing bytes.
    expect(errCode(() => decodeFunctionData(transfer, b(`${good}00`)))).toBe('malformed');
    // Truncated.
    expect(errCode(() => decodeFunctionData(transfer, b(good.slice(0, -2))))).toBe('malformed');
    // bool = 2, uint8 = 256, int8 badly sign-extended, bytes4 with dirty padding.
    const one = (sig: string, w: string) =>
      errCode(() => decodeFunctionData(parseFunctionSignature(sig), b(`${functionSelector(sig)}${w}`)));
    expect(one('f(bool)', word('02'))).toBe('invalid_value');
    expect(one('f(uint8)', word('0100'))).toBe('invalid_value');
    expect(one('f(int8)', word('80'))).toBe('invalid_value');
    expect(one('f(bytes4)', `01020304${'00'.repeat(27)}01`)).toBe('invalid_value');
    // A dynamic value whose offset doesn't point right after the head (a valid but non-canonical encoding).
    const bytesSig = 'f(bytes)';
    const canonical = encodeAbiParameters(parseAbiParameters('bytes'), ['0xaa']).slice(2);
    expect(one(bytesSig, canonical)).toBe('no error');
    const shifted = `${word('40')}${word('00')}${canonical.slice(64)}`;
    expect(one(bytesSig, shifted)).toBe('invalid_value');
    // Dirty padding after bytes, a huge length, a huge array count.
    expect(one(bytesSig, `${canonical.slice(0, -2)}01`)).toBe('invalid_value');
    expect(one(bytesSig, `${word('20')}${word('ffff')}`)).toBe('malformed');
    expect(one('f(uint256[])', `${word('20')}${word('ffffff')}`)).toBe('malformed');
    // Invalid UTF-8 in a string.
    expect(one('f(string)', `${word('20')}${word('01')}${'ff'.padEnd(64, '0')}`)).toBe('invalid_value');
  });
});

describe('decodeAbiParameters: strings and fixed arrays', () => {
  const RLO = String.fromCodePoint(0x202e);
  const ZWSP = String.fromCodePoint(0x200b);

  it.each([
    ['a bidi override (U+202E)', `USD${RLO}C`],
    ['a zero-width space (U+200B)', `pay${ZWSP}me`],
    ['a control character', 'a\u0007b'],
  ])('hides a string with %s behind its hex', (_, text) => {
    const data = encodeAbiParameters(parseAbiParameters('string'), [text]);
    const [v] = decodeAbiParameters(parseFunctionSignature('f(string)').params, b(data));
    expect(v).toEqual({
      type: 'string',
      kind: 'string',
      value: null,
      hex: `0x${Buffer.from(text, 'utf8').toString('hex')}`,
    });
  });

  it('keeps newlines, tabs and non-ASCII text readable', () => {
    const data = encodeAbiParameters(parseAbiParameters('string'), ['línea 1\n\tlínea 2']);
    const [v] = decodeAbiParameters(parseFunctionSignature('f(string)').params, b(data));
    expect(v).toMatchObject({ value: 'línea 1\n\tlínea 2' });
  });

  it('decodes a fixed-length array of dynamic elements', () => {
    const data = encodeAbiParameters(parseAbiParameters('string[2]'), [['a', 'b']]);
    const [v] = decodeAbiParameters(parseFunctionSignature('f(string[2])').params, b(data));
    expect(v).toMatchObject({ type: 'string[2]', kind: 'array', items: [{ value: 'a' }, { value: 'b' }] });
  });

  it('refuses a fixed-length array of dynamic elements longer than the data before allocating it', () => {
    // One head word (offset 0x20) and nothing else: string[1024] needs at least 1024 more words.
    const data = b(`${'20'.padStart(64, '0')}`);
    const fn = parseFunctionSignature(`f(string[${ABI_MAX_ARRAY_LENGTH}])`);
    expect(errCode(() => decodeAbiParameters(fn.params, data))).toBe('malformed');
  });
});

describe('decodeEvmTransaction', () => {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [SPENDER, 1000n] });

  it('decodes an unsigned EIP-1559 transaction with a known call and an access list', () => {
    const raw = serializeTransaction({
      type: 'eip1559',
      chainId: 8453,
      nonce: 7,
      maxPriorityFeePerGas: 1_000_000n,
      maxFeePerGas: 2_000_000_000n,
      gas: 60_000n,
      to: USDC_ADDRESS,
      value: 0n,
      data,
      accessList: [{ address: USDC_ADDRESS, storageKeys: [`0x${'01'.repeat(32)}`] }],
    });
    const tx = decodeEvmTransaction(b(raw));
    expect(tx).toMatchObject({
      type: 'eip1559',
      chainId: 8453n,
      nonce: 7n,
      maxPriorityFeePerGas: 1_000_000n,
      maxFeePerGas: 2_000_000_000n,
      gasLimit: 60_000n,
      to: USDC_ADDRESS,
      value: 0n,
      data,
      selector: '0x095ea7b3',
      maxFeeWei: 60_000n * 2_000_000_000n,
      accessList: [{ address: USDC_ADDRESS, storageKeys: [`0x${'01'.repeat(32)}`] }],
    });
    expect(tx.call?.signature).toBe('approve(address,uint256)');
    expect(tx.call?.args.map((a) => (a as { value: unknown }).value)).toEqual([SPENDER, 1000n]);
  });

  it('decodes an EIP-155 legacy preimage, a value transfer and contract creation', () => {
    const raw = serializeTransaction({
      type: 'legacy',
      chainId: 1,
      nonce: 0,
      gasPrice: 3n,
      gas: 21_000n,
      to: SPENDER,
      value: 10n ** 18n,
    });
    const tx = decodeEvmTransaction(b(raw));
    expect(tx).toMatchObject({
      type: 'legacy',
      chainId: 1n,
      gasPrice: 3n,
      to: SPENDER,
      value: 10n ** 18n,
      data: '0x',
      selector: null,
      call: null,
    });
    const create = serializeTransaction({
      type: 'eip1559',
      chainId: 1,
      nonce: 1,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      gas: 1n,
      data: '0x6080',
    });
    expect(decodeEvmTransaction(b(create)).to).toBeNull();
  });

  it('shows unknown selectors and undecodable known calls as raw data', () => {
    const unknown = serializeTransaction({
      type: 'eip1559',
      chainId: 1,
      nonce: 1,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      gas: 1n,
      to: USDC_ADDRESS,
      data: '0x12345678aa',
    });
    expect(decodeEvmTransaction(b(unknown))).toMatchObject({ selector: '0x12345678', call: null });
    const bad = serializeTransaction({
      type: 'eip1559',
      chainId: 1,
      nonce: 1,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      gas: 1n,
      to: USDC_ADDRESS,
      data: `${data}00` as Hex,
    });
    expect(decodeEvmTransaction(b(bad))).toMatchObject({ selector: '0x095ea7b3', call: null });
  });

  it('refuses other transaction types, unprotected legacy and signed payloads', () => {
    const base = { chainId: 1, nonce: 1, gas: 1n, to: USDC_ADDRESS } as const;
    const eip2930 = serializeTransaction({ ...base, type: 'eip2930', gasPrice: 1n, accessList: [] });
    expect(errCode(() => decodeEvmTransaction(b(eip2930)))).toBe('unsupported');
    expect(errCode(() => decodeEvmTransaction(b(`0x04${toRlp([]).slice(2)}`)))).toBe('unsupported');
    expect(errCode(() => decodeEvmTransaction(b(`0x03${toRlp([]).slice(2)}`)))).toBe('unsupported');
    // Pre-EIP-155 legacy (6 fields, no chain ID).
    const noChain = toRlp(['0x01', '0x01', '0x01', USDC_ADDRESS, '0x', '0x']);
    expect(errCode(() => decodeEvmTransaction(b(noChain)))).toBe('unsupported');
    // A signed EIP-1559 transaction (12 fields) is not what the vault signs.
    const signed = serializeTransaction(
      { type: 'eip1559', ...base, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
      { r: `0x${'11'.repeat(32)}`, s: `0x${'22'.repeat(32)}`, yParity: 0 },
    );
    expect(errCode(() => decodeEvmTransaction(b(signed)))).toBe('malformed');
  });

  it('refuses bad fields', () => {
    const fields = (patch: Record<number, unknown>) => {
      const f: unknown[] = ['0x01', '0x01', '0x01', '0x02', '0x5208', USDC_ADDRESS, '0x', '0x', []];
      for (const [i, v] of Object.entries(patch)) f[Number(i)] = v;
      return b(`0x02${toRlp(f as never).slice(2)}`);
    };
    expect(errCode(() => decodeEvmTransaction(fields({})))).toBe('no error');
    expect(errCode(() => decodeEvmTransaction(fields({ 0: '0x' })))).toBe('invalid_value'); // chainId 0
    expect(errCode(() => decodeEvmTransaction(fields({ 1: '0x0001' })))).toBe('invalid_value'); // leading zero
    expect(errCode(() => decodeEvmTransaction(fields({ 5: '0x1234' })))).toBe('invalid_value'); // short `to`
    expect(errCode(() => decodeEvmTransaction(fields({ 2: '0x03' })))).toBe('invalid_value'); // tip > max fee
    expect(errCode(() => decodeEvmTransaction(fields({ 8: [['0x1234', []]] })))).toBe('invalid_value');
    expect(errCode(() => decodeEvmTransaction(fields({ 8: '0x' })))).toBe('malformed');
    expect(errCode(() => decodeEvmTransaction(fields({ 7: ['0x'] })))).toBe('malformed'); // data as a list
    expect(errCode(() => decodeEvmTransaction(new Uint8Array()))).toBe('malformed');
    expect(errCode(() => decodeEvmTransaction(b('80')))).toBe('malformed');
  });
});
