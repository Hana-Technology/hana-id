import { Asset, Keypair, Operation, StrKey, xdr } from '@stellar/stellar-base';
import { describe, expect, it } from 'vitest';
import {
  DecodeError,
  STELLAR_ACCOUNT_FLAGS,
  STELLAR_MAX_DEPTH,
  STELLAR_TRUSTLINE_FLAGS,
  type StellarOperation,
  decodeMessage,
  decodeStellarAuthPreimage,
  decodeStellarTransaction,
  stellarAccountControl,
  stellarFlagNames,
} from './entries.ts';
import {
  ATTACKER,
  BALANCE_ID,
  ISSUER,
  OTHER,
  POOL_ID,
  addSignerOp,
  homeDomainOp,
  masterWeightOp,
  mergeOp,
  plainClassicOps,
  thresholdsOp,
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

  it('decodes changeTrust, payment and createAccount', () => {
    const bytes = txBytes([
      Operation.changeTrust({ asset: USDC, limit: '100' }),
      paymentOp(),
      Operation.createAccount({ destination: OTHER, startingBalance: '2' }),
    ]);
    const ops = decodeStellarTransaction(bytes).tx.operations;
    expect(ops.map((o) => o.type)).toEqual(['changeTrust', 'payment', 'createAccount']);
    expect(ops[0]).toMatchObject({ asset: `USDC:${USDC.getIssuer()}`, limit: '1000000000' });
    expect(ops[1]).toMatchObject({ destination: OTHER, asset: 'native', amount: '10000000' });
    expect(ops[2]).toMatchObject({ destination: OTHER, startingBalance: '20000000' });
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

describe('decodeStellarTransaction: classic operations (CORE-1, D110)', () => {
  const one = (op: xdr.Operation) => {
    const ops = decodeStellarTransaction(txBytes([op])).tx.operations;
    expect(ops).toHaveLength(1);
    const [d] = ops;
    expect(d?.xdr).toBe(op.toXDR('base64'));
    return d as StellarOperation;
  };
  const usdc = `USDC:${ISSUER}`;
  const eurc = `EURC:${ISSUER}`;

  it('decodes a setOptions that adds a signer with its weight, flagged as account control', () => {
    const d = one(addSignerOp(255));
    expect(d).toEqual({
      type: 'setOptions',
      source: null,
      xdr: addSignerOp(255).toXDR('base64'),
      inflationDest: null,
      clearFlags: null,
      setFlags: null,
      masterWeight: null,
      lowThreshold: null,
      medThreshold: null,
      highThreshold: null,
      homeDomain: null,
      signer: { key: ATTACKER, keyType: 'ed25519', weight: 255 },
    });
    expect(stellarAccountControl(d)).toEqual(['signer']);
    expect(Object.isFrozen((d as { signer: object }).signer)).toBe(true);
  });

  it('decodes a signer removal (weight 0) and every other signer key type', () => {
    expect(one(addSignerOp(0))).toMatchObject({ signer: { key: ATTACKER, keyType: 'ed25519', weight: 0 } });
    const preAuth = StrKey.encodePreAuthTx(Buffer.alloc(32, 1));
    const hashX = StrKey.encodeSha256Hash(Buffer.alloc(32, 2));
    expect(one(Operation.setOptions({ signer: { preAuthTx: Buffer.alloc(32, 1), weight: 1 } }))).toMatchObject({
      signer: { key: preAuth, keyType: 'preAuthTx', weight: 1 },
    });
    expect(one(Operation.setOptions({ signer: { sha256Hash: Buffer.alloc(32, 2), weight: 3 } }))).toMatchObject({
      signer: { key: hashX, keyType: 'sha256Hash', weight: 3 },
    });
    const payload = StrKey.encodeSignedPayload(
      new xdr.SignerKeyEd25519SignedPayload({
        ed25519: StrKey.decodeEd25519PublicKey(ATTACKER),
        payload: Buffer.from([1, 2, 3, 4]),
      }).toXDR(),
    );
    const signed = one(Operation.setOptions({ signer: { ed25519SignedPayload: payload, weight: 9 } }));
    expect(signed).toMatchObject({ signer: { key: payload, keyType: 'ed25519SignedPayload', weight: 9 } });
    expect(stellarAccountControl(signed)).toEqual(['signer']);
  });

  it('decodes thresholds, master weight, flags, home domain and inflation destination', () => {
    const d = one(
      Operation.setOptions({
        inflationDest: OTHER,
        clearFlags: 2,
        setFlags: 9 as never,
        masterWeight: 0,
        lowThreshold: 1,
        medThreshold: 2,
        highThreshold: 3,
        homeDomain: 'example.com',
      }),
    );
    expect(d).toMatchObject({
      inflationDest: OTHER,
      clearFlags: 2,
      setFlags: 9,
      masterWeight: 0,
      lowThreshold: 1,
      medThreshold: 2,
      highThreshold: 3,
      homeDomain: { value: 'example.com', hex: Buffer.from('example.com').toString('hex') },
      signer: null,
    });
    expect(stellarAccountControl(d)).toEqual(['thresholds', 'master_weight']);
    expect(stellarAccountControl(one(thresholdsOp()))).toEqual(['thresholds']);
    expect(stellarAccountControl(one(Operation.setOptions({ highThreshold: 1 })))).toEqual(['thresholds']);
    expect(stellarAccountControl(one(masterWeightOp(255)))).toEqual(['master_weight']);
    // A home domain, flags or inflation destination alone doesn't change who controls the account.
    expect(stellarAccountControl(one(homeDomainOp()))).toEqual([]);
    expect(stellarAccountControl(one(Operation.setOptions({ setFlags: 1, inflationDest: OTHER })))).toEqual([]);
  });

  it('shows a home domain with invisible characters as hex only', () => {
    const rlo = `a${String.fromCodePoint(0x202e)}b`;
    expect(one(Operation.setOptions({ homeDomain: rlo }))).toMatchObject({
      homeDomain: { value: null, hex: Buffer.from(rlo).toString('hex') },
    });
  });

  it('decodes accountMerge with its destination (a muxed one too), flagged as account control', () => {
    const d = one(mergeOp());
    expect(d).toEqual({ type: 'accountMerge', source: null, xdr: mergeOp().toXDR('base64'), destination: ATTACKER });
    expect(stellarAccountControl(d)).toEqual(['merge']);
    const m = 'MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAACJUQ';
    expect(one(Operation.accountMerge({ destination: m }))).toMatchObject({ destination: m });
  });

  it('decodes path payments: assets, amounts, destination and path', () => {
    expect(one(plainClassicOps.pathPaymentStrictReceive?.() as xdr.Operation)).toMatchObject({
      type: 'pathPaymentStrictReceive',
      sendAsset: 'native',
      sendMax: '50000000',
      destination: OTHER,
      destAsset: usdc,
      destAmount: '10000000',
      path: [eurc],
    });
    expect(one(plainClassicOps.pathPaymentStrictSend?.() as xdr.Operation)).toMatchObject({
      type: 'pathPaymentStrictSend',
      sendAsset: usdc,
      sendAmount: '20000000',
      destination: OTHER,
      destAsset: 'native',
      destMin: '5000000',
      path: [],
    });
  });

  it.each([
    ['manageSellOffer', { selling: usdc, buying: 'native', amount: '30000000', price: { n: 1, d: 2 }, offerId: '7' }],
    ['manageBuyOffer', { selling: 'native', buying: usdc, buyAmount: '40000000', price: { n: 2, d: 1 }, offerId: '0' }],
    ['createPassiveSellOffer', { selling: usdc, buying: eurc, amount: '10000000', price: { n: 1, d: 1 }, offerId: '0' }],
    ['allowTrust', { trustor: OTHER, assetCode: 'USDC', authorize: 1 }],
    ['inflation', {}],
    ['manageData', { name: { value: 'config', hex: Buffer.from('config').toString('hex') }, value: '0102' }],
    ['bumpSequence', { bumpTo: '1000' }],
    [
      'createClaimableBalance',
      { asset: usdc, amount: '10000000', claimants: [{ destination: OTHER, unconditional: true }] },
    ],
    ['claimClaimableBalance', { balanceId: BALANCE_ID }],
    ['beginSponsoringFutureReserves', { sponsored: OTHER }],
    ['endSponsoringFutureReserves', {}],
    ['revokeSponsorship', { target: { type: 'ledgerEntry', key: { type: 'account', account: OTHER } } }],
    ['clawback', { asset: usdc, from: OTHER, amount: '10000000' }],
    ['clawbackClaimableBalance', { balanceId: BALANCE_ID }],
    ['setTrustLineFlags', { trustor: OTHER, asset: usdc, clearFlags: 4, setFlags: 1 }],
    [
      'liquidityPoolDeposit',
      {
        poolId: POOL_ID,
        maxAmountA: '10000000',
        maxAmountB: '20000000',
        minPrice: { n: 1, d: 2 },
        maxPrice: { n: 2, d: 1 },
      },
    ],
    ['liquidityPoolWithdraw', { poolId: POOL_ID, amount: '10000000', minAmountA: '1000000', minAmountB: '2000000' }],
  ])('decodes %s field by field, with no account-control flag', (type, fields) => {
    const build = plainClassicOps[type] as () => xdr.Operation;
    const d = one(build());
    expect(d).toMatchObject({ type, source: null, ...fields });
    expect(stellarAccountControl(d)).toEqual([]);
  });

  it('decodes manageData deletion, a 12-character allowTrust code and a signer sponsorship revocation', () => {
    expect(one(Operation.manageData({ name: 'config', value: null }))).toMatchObject({ value: null });
    expect(one(Operation.allowTrust({ trustor: OTHER, assetCode: 'LONGASSET123', authorize: 0 }))).toMatchObject({
      assetCode: 'LONGASSET123',
      authorize: 0,
    });
    expect(
      one(Operation.revokeSignerSponsorship({ account: OTHER, signer: { ed25519PublicKey: ATTACKER } })),
    ).toMatchObject({ target: { type: 'signer', account: OTHER, signer: ATTACKER } });
  });

  it('covers every operation type the XDR defines', () => {
    const decodedTypes = new Set([
      'invokeHostFunction',
      'extendFootprintTtl',
      'restoreFootprint',
      'changeTrust',
      'payment',
      'createAccount',
      'accountMerge',
      ...Object.keys(plainClassicOps),
    ]);
    const all = (xdr.OperationType as unknown as { _members: Record<string, unknown> })._members;
    expect(new Set(Object.keys(all))).toEqual(decodedTypes);
  });

  it('names flag bits, unknown ones too', () => {
    expect(stellarFlagNames(9, STELLAR_ACCOUNT_FLAGS)).toEqual(['auth required', 'clawback enabled']);
    expect(stellarFlagNames(0, STELLAR_ACCOUNT_FLAGS)).toEqual([]);
    expect(stellarFlagNames(0x13, STELLAR_TRUSTLINE_FLAGS)).toEqual([
      'authorized',
      'authorized to maintain liabilities',
      'unknown bits 16',
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
