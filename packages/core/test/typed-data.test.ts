import { bytesToHex } from '@noble/hashes/utils';
import { getAddress, hashTypedData as viemHashTypedData } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  DecodeError,
  type NormalizedTypedData,
  encodeTypedDataType,
  hashTypedData,
  normalizeTypedData,
  typedDataChainId,
  typedDataView,
} from './entries.ts';

const DOMAIN_TYPES = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
];

// EIP-712's own example.
const MAIL = {
  types: {
    EIP712Domain: DOMAIN_TYPES,
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
  domain: {
    name: 'Ether Mail',
    version: '1',
    chainId: 1,
    verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC',
  },
  message: {
    from: { name: 'Cow', wallet: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826' },
    to: { name: 'Bob', wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB' },
    contents: 'Hello, Bob!',
  },
};

// USDC on Polygon, all lowercase (a public contract address).
const POLYGON_USDC = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';

// Permit2 PermitSingle: nested struct, uint160/uint48, a big decimal string.
const PERMIT_SINGLE = {
  types: {
    EIP712Domain: [
      { name: 'name', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ],
    PermitDetails: [
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
      { name: 'nonce', type: 'uint48' },
    ],
    PermitSingle: [
      { name: 'details', type: 'PermitDetails' },
      { name: 'spender', type: 'address' },
      { name: 'sigDeadline', type: 'uint256' },
    ],
  },
  primaryType: 'PermitSingle',
  domain: { name: 'Permit2', chainId: '0x89', verifyingContract: '0x000000000022d473030f116ddee9f6b43ac78ba3' },
  message: {
    details: {
      token: POLYGON_USDC,
      amount: '1461501637330902918203684832716283019655932542975',
      expiration: 1700000000,
      nonce: 0,
    },
    spender: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD',
    sigDeadline: '115792089237316195423570985008687907853269984665640564039457584007913129639935',
  },
};

// Every atomic kind, arrays (dynamic, fixed, nested), negative ints, bytes, a domain with salt.
const KITCHEN_SINK = {
  types: {
    EIP712Domain: [
      { name: 'name', type: 'string' },
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
    ],
  },
  primaryType: 'Order',
  domain: { name: 'Sink', salt: `0x${'ab'.repeat(32)}` },
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
  },
};

const json = (o: unknown) => JSON.stringify(o);

const refusal = (text: string) => {
  try {
    normalizeTypedData(text);
  } catch (e) {
    if (!(e instanceof DecodeError)) throw e;
    return e.code;
  }
  return 'accepted';
};

const viemHash = (n: NormalizedTypedData) =>
  viemHashTypedData({
    domain: n.domain as never,
    types: n.types as never,
    primaryType: n.primaryType,
    message: n.message,
  } as never);

describe('normalizeTypedData: valid input hashes as viem does', () => {
  it.each([
    ['EIP-712 Mail', MAIL],
    ['Permit2 PermitSingle', PERMIT_SINGLE],
    ['every atomic kind and array shape', KITCHEN_SINK],
  ])('%s', (_, data) => {
    const n = normalizeTypedData(json(data));
    expect(`0x${bytesToHex(hashTypedData(n))}`).toBe(viemHash(n));
  });

  it('matches the digest published in EIP-712 for Mail', () => {
    expect(bytesToHex(hashTypedData(normalizeTypedData(json(MAIL))))).toBe(
      'be609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2',
    );
    expect(encodeTypedDataType(normalizeTypedData(json(MAIL)).types, 'Mail')).toBe(
      'Mail(Person from,Person to,string contents)Person(string name,address wallet)',
    );
  });

  it('normalizes values: bigint integers, EIP-55 addresses, lowercase hex, exact big numbers', () => {
    const n = normalizeTypedData(json(PERMIT_SINGLE));
    const details = n.message.details as Record<string, unknown>;
    expect(details.amount).toBe(1461501637330902918203684832716283019655932542975n);
    expect(details.token).toBe(getAddress(POLYGON_USDC));
    expect(details.token).toBe('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359');
    expect(n.domain.chainId).toBe(137n);
    expect(typedDataChainId(n)).toBe(137);
    // A JSON number beyond 2^53 is kept exactly, not rounded.
    const big = { ...MAIL, domain: { ...MAIL.domain } };
    const text = json(big).replace('"chainId":1', '"chainId":9007199254740993');
    expect(normalizeTypedData(text).domain.chainId).toBe(9007199254740993n);
  });

  it('returns frozen, null-prototype structs', () => {
    const n = normalizeTypedData(json(MAIL));
    expect(Object.isFrozen(n)).toBe(true);
    expect(Object.isFrozen(n.message)).toBe(true);
    expect(Object.getPrototypeOf(n.message)).toBeNull();
  });

  it('accepts unused declared types (they do not affect the hash)', () => {
    const data = { ...MAIL, types: { ...MAIL.types, Unused: [{ name: 'x', type: 'uint8' }] } };
    const n = normalizeTypedData(json(data));
    expect(`0x${bytesToHex(hashTypedData(n))}`).toBe(viemHash(n));
  });
});

describe('normalizeTypedData: refusals', () => {
  const withMessage = (message: unknown) => json({ ...MAIL, message });
  const withTypes = (types: unknown) => json({ ...MAIL, types });

  it('refuses duplicate JSON keys anywhere', () => {
    const text = json(MAIL).replace('"contents":"Hello, Bob!"', '"contents":"Hello, Bob!","contents":"Pay Eve"');
    expect(refusal(text)).toBe('malformed');
    const inTypes = json(MAIL).replace('"primaryType":"Mail"', '"primaryType":"Mail","primaryType":"Person"');
    expect(refusal(inTypes)).toBe('malformed');
  });

  it('refuses a field not declared in its type', () => {
    expect(refusal(withMessage({ ...MAIL.message, amount: 1 }))).toBe('typed_data_invalid');
    expect(refusal(withMessage({ ...MAIL.message, to: { ...MAIL.message.to, extra: 'x' } }))).toBe(
      'typed_data_invalid',
    );
  });

  it('refuses a missing field', () => {
    const { contents: _, ...rest } = MAIL.message;
    expect(refusal(withMessage(rest))).toBe('typed_data_invalid');
    expect(refusal(json({ ...MAIL, domain: { ...MAIL.domain, version: undefined } }))).toBe('typed_data_invalid');
  });

  it('refuses an undeclared type', () => {
    expect(refusal(withTypes({ ...MAIL.types, Mail: [{ name: 'from', type: 'Human' }] }))).toBe('typed_data_invalid');
  });

  it('refuses cyclic types, direct and indirect, arrays included', () => {
    const direct = { ...MAIL.types, Person: [...MAIL.types.Person, { name: 'friend', type: 'Person[]' }] };
    expect(refusal(withTypes(direct))).toBe('typed_data_invalid');
    const indirect = {
      EIP712Domain: DOMAIN_TYPES,
      A: [{ name: 'b', type: 'B' }],
      B: [{ name: 'a', type: 'A[2]' }],
      Mail: MAIL.types.Mail,
      Person: MAIL.types.Person,
    };
    expect(refusal(withTypes(indirect))).toBe('typed_data_invalid');
  });

  it('refuses a primaryType not in types, missing, or EIP712Domain', () => {
    expect(refusal(json({ ...MAIL, primaryType: 'Letter' }))).toBe('typed_data_invalid');
    expect(refusal(json({ ...MAIL, primaryType: undefined }))).toBe('typed_data_invalid');
    expect(refusal(json({ ...MAIL, primaryType: 'EIP712Domain' }))).toBe('typed_data_invalid');
  });

  it('refuses an EIP712Domain that does not match its declared fields', () => {
    // A domain value field that isn't declared.
    expect(refusal(json({ ...MAIL, domain: { ...MAIL.domain, salt: `0x${'00'.repeat(32)}` } }))).toBe(
      'typed_data_invalid',
    );
    // A non-standard field, a standard field with the wrong type, the wrong order, a missing declaration.
    const bad = [
      [...DOMAIN_TYPES, { name: 'extra', type: 'string' }],
      [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint64' },
      ],
      [DOMAIN_TYPES[1], DOMAIN_TYPES[0], DOMAIN_TYPES[2], DOMAIN_TYPES[3]],
      undefined,
    ];
    for (const EIP712Domain of bad) {
      expect(refusal(withTypes({ ...MAIL.types, EIP712Domain }))).toBe('typed_data_invalid');
    }
    expect(refusal(json({ ...MAIL, domain: undefined }))).toBe('typed_data_invalid');
  });

  it('refuses bad type declarations', () => {
    const cases: unknown[] = [
      { ...MAIL.types, Mail: [{ name: 'from', type: 'Person', internalType: 'x' }] }, // extra key in a field
      {
        ...MAIL.types,
        Mail: [
          { name: 'a', type: 'string' },
          { name: 'a', type: 'string' },
        ],
      }, // duplicate field
      { ...MAIL.types, Mail: [{ name: 'n', type: 'uint' }] }, // alias, not a type
      { ...MAIL.types, Mail: [{ name: 'n', type: 'uint7' }] },
      { ...MAIL.types, Mail: [{ name: 'n', type: 'bytes33' }] },
      { ...MAIL.types, Mail: [{ name: 'n', type: 'string[0]' }] },
      { ...MAIL.types, Mail: [{ name: '1n', type: 'string' }] },
      { ...MAIL.types, uint256: [{ name: 'x', type: 'string' }] }, // struct named like an atomic type
      { ...MAIL.types, Mail: {} },
    ];
    for (const types of cases) expect(refusal(withTypes(types))).toBe('typed_data_invalid');
  });

  it('refuses bad values', () => {
    const msg = (to: unknown) => withMessage({ ...MAIL.message, to });
    // Mixed-case address with a bad EIP-55 checksum, short address, number instead of string.
    expect(refusal(msg({ name: 'Bob', wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbb' }))).toBe(
      'typed_data_invalid',
    );
    expect(refusal(msg({ name: 'Bob', wallet: '0x1234' }))).toBe('typed_data_invalid');
    expect(refusal(msg({ name: 1, wallet: MAIL.message.to.wallet }))).toBe('typed_data_invalid');

    const sink = (patch: Record<string, unknown>) =>
      json({ ...KITCHEN_SINK, message: { ...KITCHEN_SINK.message, ...patch } });
    expect(refusal(sink({ pairs: [[1, 256]] }))).toBe('typed_data_invalid'); // uint8 overflow
    expect(refusal(sink({ pairs: [[1, -1]] }))).toBe('typed_data_invalid'); // negative uint
    expect(refusal(sink({ pairs: [[1, 1.5]] }))).toBe('typed_data_invalid'); // fraction
    expect(refusal(sink({ pairs: [[1, 1e2]] }))).toBe('accepted'); // JSON.stringify writes 100
    expect(refusal(json(KITCHEN_SINK).replace('[255,"0x10"]', '[255,1e2]'))).toBe('typed_data_invalid'); // exponent
    expect(refusal(sink({ pairs: [[1, '007']] }))).toBe('typed_data_invalid'); // leading zeros
    expect(refusal(sink({ pairs: [[1, 2, 3]] }))).toBe('typed_data_invalid'); // fixed length
    expect(refusal(sink({ owners: ['0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826'] }))).toBe('typed_data_invalid');
    expect(refusal(sink({ blob: '0x123' }))).toBe('typed_data_invalid'); // odd hex
    expect(refusal(sink({ blob: 'abcd' }))).toBe('typed_data_invalid'); // no 0x
    expect(refusal(sink({ items: [{ id: 1, flag: 'true', tag: '0xdeadbeef' }] }))).toBe('typed_data_invalid');
    expect(refusal(sink({ items: [{ id: 1, flag: true, tag: '0xdead' }] }))).toBe('typed_data_invalid'); // bytes4
    expect(refusal(sink({ items: [{ id: '9223372036854775808', flag: true, tag: '0xdeadbeef' }] }))).toBe(
      'typed_data_invalid',
    ); // int64 overflow
    expect(refusal(sink({ items: { id: 1 } }))).toBe('typed_data_invalid'); // array expected
  });

  it('refuses unknown top-level keys and non-object input', () => {
    expect(refusal(json({ ...MAIL, extra: 1 }))).toBe('typed_data_invalid');
    expect(refusal('[]')).toBe('typed_data_invalid');
    expect(refusal('not json')).toBe('malformed');
  });
});

describe('typedDataView', () => {
  it('renders the normalized tree walked from primaryType, and the domain', () => {
    const view = typedDataView(normalizeTypedData(json(KITCHEN_SINK)));
    expect(view.primaryType).toBe('Order');
    expect(view.domain).toEqual([
      { name: 'name', type: 'string', value: 'Sink' },
      { name: 'salt', type: 'bytes32', value: `0x${'ab'.repeat(32)}` },
    ]);
    const msg = view.message as unknown as { children: { name: string }[] };
    expect(msg.children.map((c) => c.name)).toEqual(['items', 'pairs', 'owners', 'blob', 'note', 'delta']);
    expect(msg.children[0]).toEqual({
      name: 'items',
      type: 'Item[]',
      children: [
        {
          name: '[0]',
          type: 'Item',
          children: [
            { name: 'id', type: 'int64', value: '-5' },
            { name: 'flag', type: 'bool', value: 'true' },
            { name: 'tag', type: 'bytes4', value: '0xdeadbeef' },
          ],
        },
        {
          name: '[1]',
          type: 'Item',
          children: [
            { name: 'id', type: 'int64', value: '9223372036854775807' },
            { name: 'flag', type: 'bool', value: 'false' },
            { name: 'tag', type: 'bytes4', value: '0x00000000' },
          ],
        },
      ],
    });
    expect(msg.children[1]).toEqual({
      name: 'pairs',
      type: 'uint8[2][]',
      children: [
        {
          name: '[0]',
          type: 'uint8[2]',
          children: [
            { name: '[0]', type: 'uint8', value: '1' },
            { name: '[1]', type: 'uint8', value: '2' },
          ],
        },
        {
          name: '[1]',
          type: 'uint8[2]',
          children: [
            { name: '[0]', type: 'uint8', value: '255' },
            { name: '[1]', type: 'uint8', value: '16' },
          ],
        },
      ],
    });
    expect(msg.children[2]).toMatchObject({
      children: [
        { value: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826' },
        { value: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB' },
      ],
    });
  });
});

describe('typedDataView: unsafe strings', () => {
  const RLO = String.fromCodePoint(0x202e);
  const ZWSP = String.fromCodePoint(0x200b);
  const hex = (t: string) => `0x${Buffer.from(t, 'utf8').toString('hex')}`;

  it('shows the hex of a domain name with a bidi override and a message string with a zero-width space', () => {
    const name = `USD${RLO}C`;
    const contents = `Pay${ZWSP} Bob`;
    const view = typedDataView(
      normalizeTypedData(json({ ...MAIL, domain: { ...MAIL.domain, name }, message: { ...MAIL.message, contents } })),
    );
    expect(view.domain[0]).toEqual({ name: 'name', type: 'string', value: null, hex: hex(name) });
    expect((view.message as { readonly children: readonly unknown[] }).children[2]).toEqual({
      name: 'contents',
      type: 'string',
      value: null,
      hex: hex(contents),
    });
  });

  it('hides unsafe strings at any depth, and leaves clean ones as text', () => {
    const view = typedDataView(
      normalizeTypedData(
        json({ ...MAIL, message: { ...MAIL.message, to: { ...MAIL.message.to, name: `B${RLO}ob` } } }),
      ),
    );
    const msg = view.message as unknown as { children: { children?: unknown[]; value?: unknown }[] };
    expect(msg.children[0]?.children?.[0]).toEqual({ name: 'name', type: 'string', value: 'Cow' });
    expect(msg.children[1]?.children?.[0]).toEqual({
      name: 'name',
      type: 'string',
      value: null,
      hex: hex(`B${RLO}ob`),
    });
    expect(msg.children[2]).toEqual({ name: 'contents', type: 'string', value: 'Hello, Bob!' });
  });
});
