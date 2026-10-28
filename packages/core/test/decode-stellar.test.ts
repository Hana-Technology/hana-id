import { Asset, Keypair, Operation, StrKey, xdr } from '@stellar/stellar-base';
import { describe, expect, it } from 'vitest';
import {
  DecodeError,
  STELLAR_MAX_DEPTH,
  decodeMessage,
  decodeStellarAuthPreimage,
  decodeStellarTransaction,
} from './entries.ts';
import {
  OTHER,
  PASSPHRASE,
  POOL,
  ROUTER,
  TOKEN,
  USER,
  USDC,
  addr,
  addressAuth,
  authPreimageBytes,
  contractCodeKey,
  contractDataKey,
  feeBumpBytes,
  i128,
  invocation,
  invokeOp,
  paymentOp,
  sorobanData,
  sourceAuth,
  txBytes,
} from './stellar-fixtures.ts';

const errCode = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof DecodeError ? e.code : `not a DecodeError: ${String(e)}`;
  }
  return 'no error';
};

describe('decodeStellarTransaction', () => {
  it('decodes a Soroban invocation with typed arguments, its auth tree and footprint', () => {
    const args = [
      addr(USER),
      i128(-5n),
      xdr.ScVal.scvVec([addr(TOKEN), xdr.ScVal.scvU32(7), xdr.ScVal.scvBool(true)]),
      xdr.ScVal.scvMap([new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('to'), val: addr(OTHER) })]),
      xdr.ScVal.scvBytes(Buffer.from([1, 2, 3])),
      xdr.ScVal.scvString('hi'),
      xdr.ScVal.scvU64(xdr.Uint64.fromString('18446744073709551615')),
      xdr.ScVal.scvVoid(),
    ];
    const root = invocation(
      POOL,
      'swap',
      [addr(USER)],
      [invocation(TOKEN, 'transfer', [addr(USER), addr(POOL), i128(10n)])],
    );
    const bytes = txBytes(
      [invokeOp(POOL, 'swap', args, [sourceAuth(root), addressAuth(OTHER, invocation(ROUTER, 'route', []))])],
      {
        fee: '12345',
        soroban: sorobanData([contractCodeKey()], [contractDataKey(POOL)]),
      },
    );
    const d = decodeStellarTransaction(bytes);
    expect(d.envelope).toBe('tx');
    expect(d.signatures).toBe(0);
    expect(d.tx).toMatchObject({
      source: USER,
      sequence: '42',
      fee: '17345', // the builder adds the 5000 resource fee to the inclusion fee

      memo: { type: 'none' },
      timeBounds: { minTime: '10', maxTime: '2000' },
      ledgerBounds: null,
      otherPreconditions: false,
    });
    expect(d.tx.soroban).toMatchObject({
      resourceFee: '5000',
      instructions: 1000,
      readOnly: [{ type: 'contractCode' }],
      readWrite: [
        { type: 'contractData', contract: POOL, durability: 'persistent', key: { type: 'ledgerKeyContractInstance' } },
      ],
    });
    const op = d.tx.operations[0] as Extract<(typeof d.tx.operations)[number], { type: 'invokeHostFunction' }>;
    expect(op.type).toBe('invokeHostFunction');
    expect(op.source).toBeNull();
    expect(typeof op.xdr).toBe('string');
    expect(op.hostFunction).toEqual({
      type: 'invokeContract',
      contract: POOL,
      function: 'swap',
      args: [
        { type: 'address', addressType: 'account', address: USER },
        { type: 'i128', value: '-5' },
        {
          type: 'vec',
          items: [
            { type: 'address', addressType: 'contract', address: TOKEN },
            { type: 'u32', value: 7 },
            { type: 'bool', value: true },
          ],
        },
        {
          type: 'map',
          entries: [
            {
              key: { type: 'symbol', value: 'to' },
              value: { type: 'address', addressType: 'account', address: OTHER },
            },
          ],
        },
        { type: 'bytes', hex: '010203' },
        { type: 'string', value: 'hi', hex: '6869' },
        { type: 'u64', value: '18446744073709551615' },
        { type: 'void' },
      ],
    });
    expect(op.auth).toEqual([
      {
        credentials: { type: 'sourceAccount' },
        rootInvocation: {
          function: {
            type: 'contractFn',
            contract: POOL,
            function: 'swap',
            args: [{ type: 'address', addressType: 'account', address: USER }],
          },
          subInvocations: [
            {
              function: {
                type: 'contractFn',
                contract: TOKEN,
                function: 'transfer',
                args: [
                  { type: 'address', addressType: 'account', address: USER },
                  { type: 'address', addressType: 'contract', address: POOL },
                  { type: 'i128', value: '10' },
                ],
              },
              subInvocations: [],
            },
          ],
        },
      },
      {
        credentials: { type: 'address', address: OTHER, nonce: '42', signatureExpirationLedger: 1000 },
        rootInvocation: {
          function: { type: 'contractFn', contract: ROUTER, function: 'route', args: [] },
          subInvocations: [],
        },
      },
    ]);
    expect(Object.isFrozen(op.hostFunction)).toBe(true);
  });

  it('decodes classic operations by type, with raw XDR for the rest', () => {
    const setOptions = Operation.setOptions({ homeDomain: 'evil.test' });
    const bytes = txBytes([
      Operation.changeTrust({ asset: USDC, limit: '100' }),
      paymentOp(),
      setOptions,
      Operation.createAccount({ destination: OTHER, startingBalance: '2' }),
    ]);
    const ops = decodeStellarTransaction(bytes).tx.operations;
    expect(ops.map((o) => o.type)).toEqual(['changeTrust', 'payment', 'setOptions', 'createAccount']);
    expect(ops[0]).toMatchObject({ asset: `USDC:${USDC.getIssuer()}`, limit: '1000000000' });
    expect(ops[1]).toMatchObject({ destination: OTHER, asset: 'native', amount: '10000000' });
    expect(ops[2]).toEqual({ type: 'setOptions', source: null, xdr: setOptions.toXDR('base64') });
    expect(ops[3]).toMatchObject({ destination: OTHER, startingBalance: '20000000' });
  });

  it('decodes a 12-character asset code, an operation source, a text memo and muxed accounts', () => {
    const long = new Asset('LONGASSET123', USDC.getIssuer());
    const muxedSource = 'MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAACJUQ';
    const op = Operation.changeTrust({ asset: long, source: muxedSource });
    const env = xdr.TransactionEnvelope.fromXDR(Buffer.from(txBytes([op])));
    env.v1().tx().memo(xdr.Memo.memoText('gm'));
    const d = decodeStellarTransaction(new Uint8Array(env.toXDR()));
    expect(d.tx.operations[0]).toMatchObject({ asset: `LONGASSET123:${USDC.getIssuer()}`, source: muxedSource });
    expect(d.tx.memo).toEqual({ type: 'text', value: 'gm', hex: '676d' });
  });

  it('decodes a fee-bump envelope and a v0 envelope', () => {
    const inner = txBytes([paymentOp()]);
    const fb = decodeStellarTransaction(feeBumpBytes(inner, OTHER));
    expect(fb).toMatchObject({ envelope: 'fee_bump', feeSource: OTHER, fee: '2000', tx: { source: USER, fee: '100' } });

    const v1 = xdr.TransactionEnvelope.fromXDR(Buffer.from(inner)).v1().tx();
    const v0 = xdr.TransactionEnvelope.envelopeTypeTxV0(
      new xdr.TransactionV0Envelope({
        tx: new xdr.TransactionV0({
          sourceAccountEd25519: StrKey.decodeEd25519PublicKey(USER),
          fee: 100,
          seqNum: v1.seqNum(),
          timeBounds: null,
          memo: xdr.Memo.memoNone(),
          operations: v1.operations(),
          ext: new xdr.TransactionV0Ext(0),
        }),
        signatures: [],
      }),
    );
    expect(decodeStellarTransaction(new Uint8Array(v0.toXDR()))).toMatchObject({
      envelope: 'tx_v0',
      tx: { source: USER, timeBounds: null, operations: [{ type: 'payment' }] },
    });
  });

  it('refuses malformed, trailing and oversize input', () => {
    const good = txBytes([paymentOp()]);
    expect(errCode(() => decodeStellarTransaction(new Uint8Array([...good, 0, 0, 0, 0])))).toBe('malformed');
    expect(errCode(() => decodeStellarTransaction(good.subarray(0, good.length - 4)))).toBe('malformed');
    expect(errCode(() => decodeStellarTransaction(new Uint8Array([0, 0, 0, 9])))).toBe('malformed');
    expect(errCode(() => decodeStellarTransaction(new Uint8Array()))).toBe('malformed');
    expect(errCode(() => decodeStellarTransaction(new Uint8Array(192 * 1024 + 1)))).toBe('too_large');
  });

  it('refuses ScVal nesting deeper than the cap', () => {
    let v = xdr.ScVal.scvU32(1);
    for (let i = 0; i <= STELLAR_MAX_DEPTH; i++) v = xdr.ScVal.scvVec([v]);
    expect(errCode(() => decodeStellarTransaction(txBytes([invokeOp(POOL, 'f', [v])])))).toBe('too_large');
  });

  it('shows a string argument that is not clean UTF-8 as hex', () => {
    const rlo = String.fromCodePoint(0x202e);
    const bytes = txBytes([
      invokeOp(POOL, 'f', [xdr.ScVal.scvString(`abc${rlo}def`), xdr.ScVal.scvString(Buffer.from([0xff]))]),
    ]);
    const op = decodeStellarTransaction(bytes).tx.operations[0] as unknown as { hostFunction: { args: unknown[] } };
    expect(op.hostFunction.args).toEqual([
      { type: 'string', value: null, hex: Buffer.from(`abc${rlo}def`).toString('hex') },
      { type: 'string', value: null, hex: 'ff' },
    ]);
  });
});

describe('decodeStellarAuthPreimage', () => {
  const root = invocation(
    POOL,
    'deposit',
    [addr(USER), i128(5n)],
    [invocation(TOKEN, 'transfer', [addr(USER), addr(POOL), i128(5n)])],
  );

  it('decodes the network ID, nonce, expiration and invocation tree', () => {
    const d = decodeStellarAuthPreimage(authPreimageBytes(root), PASSPHRASE);
    expect(d.nonce).toBe('99');
    expect(d.signatureExpirationLedger).toBe(12345);
    expect(d.networkId).toHaveLength(64);
    expect(d.invocation.function).toMatchObject({ type: 'contractFn', contract: POOL, function: 'deposit' });
    expect(d.invocation.subInvocations[0]?.function).toMatchObject({ contract: TOKEN, function: 'transfer' });
  });

  it('refuses another network, another preimage type and malformed bytes', () => {
    expect(
      errCode(() =>
        decodeStellarAuthPreimage(authPreimageBytes(root), 'Public Global Stellar Network ; September 2015'),
      ),
    ).toBe('network_mismatch');
    const opId = xdr.HashIdPreimage.envelopeTypeOpId(
      new xdr.HashIdPreimageOperationId({
        sourceAccount: Keypair.fromPublicKey(USER).xdrAccountId(),
        seqNum: xdr.Int64.fromString('1'),
        opNum: 0,
      }),
    );
    expect(errCode(() => decodeStellarAuthPreimage(new Uint8Array(opId.toXDR()), PASSPHRASE))).toBe('unsupported');
    expect(errCode(() => decodeStellarAuthPreimage(txBytes([paymentOp()]), PASSPHRASE))).toBe('malformed');
  });

  it('refuses an authorization tree deeper than the cap', () => {
    let inv = invocation(POOL, 'f', []);
    for (let i = 0; i <= STELLAR_MAX_DEPTH; i++) inv = invocation(POOL, 'f', [], [inv]);
    expect(errCode(() => decodeStellarAuthPreimage(authPreimageBytes(inv), PASSPHRASE))).toBe('too_large');
  });
});

describe('decodeMessage', () => {
  it('shows clean UTF-8 as text', () => {
    expect(decodeMessage(new TextEncoder().encode('Sign in to Example\nNonce: 1'))).toEqual({
      text: 'Sign in to Example\nNonce: 1',
      hex: `0x${Buffer.from('Sign in to Example\nNonce: 1').toString('hex')}`,
      length: 27,
    });
  });

  it.each([
    ['invalid UTF-8', [0xff, 0xfe]],
    ['a NUL', [0x61, 0x00]],
    ['a right-to-left override', [...new TextEncoder().encode(`a${String.fromCodePoint(0x202e)}b`)]],
    ['a zero-width space', [...new TextEncoder().encode(`a${String.fromCodePoint(0x200b)}b`)]],
    ['a BOM', [...new TextEncoder().encode(`${String.fromCodePoint(0xfeff)}a`)]],
    ['a C1 control', [...new TextEncoder().encode(`a${String.fromCodePoint(0x85)}`)]],
  ])('shows only hex for %s', (_, bytes) => {
    const m = decodeMessage(new Uint8Array(bytes));
    expect(m.text).toBeNull();
    expect(m.hex).toBe(`0x${Buffer.from(bytes).toString('hex')}`);
  });
});
