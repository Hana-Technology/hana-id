import { Asset, Operation, xdr } from '@stellar/stellar-base';
import { type Hex, encodeFunctionData, parseAbi, serializeTransaction } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  type ApprovalSubject,
  type AutoApprovePolicyV1,
  type AutoApproveResult,
  type PolicyValidationOptions,
  type ProtocolDecoder,
  matchAutoApprovePolicy,
  protocolDecoderRegistry,
  recordAutoApproveUse,
  usageToday,
  utcDay,
  validateAutoApprovePolicy,
} from '../src/index.ts';
import { CHAIN, EVM_FRIEND, EVM_PERMIT2, EVM_USDC, EVM_USER, EVM_VAULT, policyJson } from './policy-fixtures.ts';
import {
  OTHER,
  PASSPHRASE,
  POOL,
  ROUTER,
  TOKEN,
  UNLISTED,
  USDC,
  USER,
  accountKey,
  addr,
  addressAuth,
  authPreimageBytes,
  changeTrustOp,
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

const validated = (p: unknown, decoders?: PolicyValidationOptions['decoders']) => {
  const r = validateAutoApprovePolicy(p, decoders ? { decoders } : {});
  if (!r.ok) throw new Error(r.problems.join('; '));
  return r.policy;
};
const POLICY = validated(policyJson());
const NOW = Date.UTC(2026, 9, 28, 12);
const ctx = { usage: null, nowMs: NOW };

const stellarTx = (bytes: Uint8Array, networkPassphrase = PASSPHRASE): ApprovalSubject => ({
  kind: 'stellar_tx',
  chain: 'stellar',
  address: USER,
  context: { networkPassphrase },
  bytes,
});
const evmTx = (tx: Record<string, unknown>, chainId = CHAIN): ApprovalSubject => ({
  kind: 'evm_tx',
  chain: 'evm',
  address: EVM_USER,
  context: { chainId },
  bytes: Buffer.from(
    serializeTransaction({
      type: 'eip1559',
      chainId,
      nonce: 1,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      gas: 100_000n,
      ...tx,
    } as never).slice(2),
    'hex',
  ),
});

const reason = (r: AutoApproveResult) => (r.ok ? 'ok' : r.reason);
const match = (
  s: ApprovalSubject,
  policy: AutoApprovePolicyV1 = POLICY,
  c: Parameters<typeof matchAutoApprovePolicy>[2] = ctx,
) => matchAutoApprovePolicy(policy, s, c);

// A swap whose auth tree moves the user's tokens to the (listed) pool.
const swapRoot = (to = POOL) =>
  invocation(POOL, 'swap', [addr(USER), i128(5n)], [invocation(TOKEN, 'transfer', [addr(USER), addr(to), i128(5n)])]);
const swapTx = (
  o: {
    args?: xdr.ScVal[];
    root?: xdr.SorobanAuthorizedInvocation;
    fee?: string;
    source?: string;
    opSource?: string;
  } = {},
) =>
  txBytes([invokeOp(POOL, 'swap', o.args ?? [addr(USER), i128(5n)], [sourceAuth(o.root ?? swapRoot())], o.opSource)], {
    soroban: sorobanData(),
    fee: o.fee ?? '1000',
    ...(o.source ? { source: o.source } : {}),
  });

describe('never-covered kinds', () => {
  it.each([
    [
      'raw (Stellar)',
      { kind: 'raw', chain: 'stellar', address: USER, context: { networkPassphrase: PASSPHRASE }, bytes: swapTx() },
    ],
    [
      'raw (EVM)',
      { kind: 'raw', chain: 'evm', address: EVM_USER, context: { chainId: CHAIN }, bytes: new Uint8Array(32) },
    ],
    [
      'personal_sign',
      {
        kind: 'personal_sign',
        chain: 'evm',
        address: EVM_USER,
        context: { chainId: CHAIN },
        bytes: new Uint8Array([1]),
      },
    ],
    [
      'stellar_signMessage',
      {
        kind: 'stellar_message',
        chain: 'stellar',
        address: USER,
        context: { networkPassphrase: PASSPHRASE },
        bytes: new Uint8Array([1]),
      },
    ],
  ])('%s always needs approval', (_, s) => {
    expect(reason(match(s as ApprovalSubject))).toBe('never_covered');
  });
});

describe('Stellar transactions', () => {
  it('auto-approves a listed call whose whole auth tree uses only listed contracts and allowed addresses', () => {
    expect(match(stellarTx(swapTx()))).toEqual({ ok: true, chain: 'stellar', contract: POOL, function: 'swap' });
  });

  it('applies the address rule at any depth of the arguments', () => {
    const nested = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol('legs'),
        val: xdr.ScVal.scvVec([xdr.ScVal.scvVec([addr(OTHER)])]),
      }),
    ]);
    expect(reason(match(stellarTx(swapTx({ args: [addr(USER), nested] }))))).toBe('address_not_allowed');
    const ok = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: addr(TOKEN), val: xdr.ScVal.scvVec([addr(USER), addr(ROUTER)]) }),
    ]);
    expect(reason(match(stellarTx(swapTx({ args: [ok] }))))).toBe('ok');
  });

  it('applies the address rule inside nested authorizations', () => {
    expect(reason(match(stellarTx(swapTx({ root: swapRoot(OTHER) }))))).toBe('address_not_allowed');
    const deep = invocation(
      POOL,
      'swap',
      [],
      [invocation(TOKEN, 'transfer', [], [invocation(TOKEN, 'approve', [addr(USER), addr(OTHER)])])],
    );
    expect(reason(match(stellarTx(swapTx({ root: deep }))))).toBe('address_not_allowed');
  });

  it('accepts policy addresses as arguments', () => {
    const p = validated({ ...policyJson(), stellar: { ...policyJson().stellar, addresses: [OTHER] } });
    expect(reason(match(stellarTx(swapTx({ root: swapRoot(OTHER) })), p))).toBe('ok');
  });

  it("skips the address rule only for a function listed with 'any'", () => {
    const tx = txBytes([invokeOp(ROUTER, 'route', [addr(OTHER)])], { soroban: sorobanData(), fee: '1000' });
    expect(reason(match(stellarTx(tx)))).toBe('ok');
    // ... but a sub-invocation under it still follows its own entry's rule.
    const root = invocation(
      ROUTER,
      'route',
      [addr(OTHER)],
      [invocation(TOKEN, 'transfer', [addr(USER), addr(OTHER), i128(1n)])],
    );
    const tx2 = txBytes([invokeOp(ROUTER, 'route', [addr(OTHER)], [sourceAuth(root)])], {
      soroban: sorobanData(),
      fee: '1000',
    });
    expect(reason(match(stellarTx(tx2)))).toBe('address_not_allowed');
  });

  it('refuses opaque bytes arguments under the address rule', () => {
    expect(reason(match(stellarTx(swapTx({ args: [addr(USER), xdr.ScVal.scvBytes(Buffer.alloc(32))] }))))).toBe(
      'opaque_bytes',
    );
  });

  it.each([
    [
      'an unlisted contract',
      () => txBytes([invokeOp(UNLISTED, 'swap', [])], { soroban: sorobanData() }),
      'contract_not_listed',
    ],
    [
      'an unlisted function',
      () => txBytes([invokeOp(POOL, 'drain', [])], { soroban: sorobanData() }),
      'function_not_listed',
    ],
    [
      'an unlisted contract in the auth tree',
      () => swapTx({ root: invocation(POOL, 'swap', [], [invocation(UNLISTED, 'transfer', [])]) }),
      'contract_not_listed',
    ],
    [
      'an unlisted function in the auth tree',
      () => swapTx({ root: invocation(POOL, 'swap', [], [invocation(TOKEN, 'burn', [])]) }),
      'function_not_listed',
    ],
    ['a fee over maxFeeStroops', () => swapTx({ fee: '100001' }), 'fee_too_high'],
    ['another transaction source', () => swapTx({ source: OTHER }), 'source_not_self'],
    ['another operation source', () => swapTx({ opSource: OTHER }), 'source_not_self'],
    ['a classic payment', () => txBytes([paymentOp()]), 'operation_not_allowed'],
    ['setOptions', () => txBytes([Operation.setOptions({ homeDomain: 'evil.test' })]), 'operation_not_allowed'],
    ['accountMerge', () => txBytes([Operation.accountMerge({ destination: OTHER })]), 'operation_not_allowed'],
    ['an unlisted changeTrust asset', () => txBytes([changeTrustOp(new Asset('EURC', OTHER))]), 'asset_not_listed'],
    ['a listed changeTrust next to a payment', () => txBytes([changeTrustOp(), paymentOp()]), 'operation_not_allowed'],
    ['a fee-bump', () => feeBumpBytes(swapTx()), 'fee_bump'],
    ['garbage bytes', () => new Uint8Array([1, 2, 3, 4]), 'decode_failed'],
    [
      'a contract upload',
      () =>
        txBytes([Operation.uploadContractWasm({ wasm: Buffer.from([0, 97, 115, 109]) })], { soroban: sorobanData() }),
      'operation_not_allowed',
    ],
  ])('sends %s to the popup', (_, bytes, why) => {
    expect(reason(match(stellarTx(bytes())))).toBe(why);
  });

  it('refuses an unlisted network passphrase', () => {
    expect(reason(match(stellarTx(swapTx(), 'Public Global Stellar Network ; September 2015')))).toBe(
      'network_not_listed',
    );
  });

  it('auto-approves a listed changeTrust', () => {
    expect(match(stellarTx(txBytes([changeTrustOp(USDC)])))).toEqual({
      ok: true,
      chain: 'stellar',
      contract: `USDC:${USDC.getIssuer()}`,
      function: 'changeTrust',
    });
  });

  it('auto-approves restoreFootprint and extendFootprintTtl only for listed contracts', () => {
    const restore = (rw: xdr.LedgerKey[]) =>
      txBytes([Operation.restoreFootprint({})], { soroban: sorobanData([], rw) });
    expect(match(stellarTx(restore([contractDataKey(POOL), contractCodeKey()])))).toMatchObject({
      ok: true,
      contract: POOL,
      function: 'restoreFootprint',
    });
    expect(reason(match(stellarTx(restore([contractDataKey(UNLISTED)]))))).toBe('operation_not_allowed');
    expect(reason(match(stellarTx(restore([accountKey(USER)]))))).toBe('operation_not_allowed');
    expect(reason(match(stellarTx(restore([]))))).toBe('operation_not_allowed');
    const extend = txBytes([Operation.extendFootprintTtl({ extendTo: 1000 })], {
      soroban: sorobanData([contractDataKey(TOKEN)]),
    });
    expect(reason(match(stellarTx(extend)))).toBe('ok');
  });

  it('refuses a policy without a Stellar section', () => {
    const { stellar: _, ...evmOnly } = policyJson();
    expect(reason(match(stellarTx(swapTx()), validated(evmOnly)))).toBe('no_policy_section');
  });
});

describe('Stellar auth entries', () => {
  const entry = (root: xdr.SorobanAuthorizedInvocation, passphrase = PASSPHRASE): ApprovalSubject => ({
    kind: 'stellar_auth_entry',
    chain: 'stellar',
    address: USER,
    context: { networkPassphrase: passphrase },
    bytes: authPreimageBytes(root, passphrase),
  });

  it('auto-approves a tree that passes the contract, function and address checks', () => {
    expect(match(entry(swapRoot()))).toEqual({ ok: true, chain: 'stellar', contract: POOL, function: 'swap' });
  });

  it('refuses a tree with a bad address, an unlisted function or another network', () => {
    expect(reason(match(entry(swapRoot(OTHER))))).toBe('address_not_allowed');
    expect(reason(match(entry(invocation(POOL, 'swap', [], [invocation(POOL, 'drain', [])]))))).toBe(
      'function_not_listed',
    );
    const mainnet = 'Public Global Stellar Network ; September 2015';
    expect(reason(match(entry(swapRoot(), mainnet)))).toBe('network_not_listed');
    const wrongNet = { ...entry(swapRoot()), bytes: authPreimageBytes(swapRoot(), mainnet) };
    expect(reason(match(wrongNet))).toBe('decode_failed');
  });

  it("checks a transaction's address-credential entries by their tree, like source-account ones", () => {
    // Another account's entry is signed by that account, but its tree still has to pass the policy.
    const tx = txBytes([invokeOp(POOL, 'swap', [addr(USER)], [addressAuth(OTHER, swapRoot())])], {
      soroban: sorobanData(),
      fee: '1000',
    });
    expect(reason(match(stellarTx(tx)))).toBe('ok');
  });
});

describe('EVM transactions', () => {
  const erc20 = parseAbi(['function approve(address,uint256)', 'function transfer(address,uint256)']);
  const vault = parseAbi([
    'function deposit(uint256)',
    'function withdraw(address,uint256)',
    'function batch((address,uint256)[])',
    'function execute(address,bytes)',
  ]);
  const approve = (spender: string) =>
    encodeFunctionData({ abi: erc20, functionName: 'approve', args: [spender as Hex, 10n] });

  it('auto-approves an ERC-20 approve to a listed contract', () => {
    expect(match(evmTx({ to: EVM_USDC, data: approve(EVM_VAULT) }))).toEqual({
      ok: true,
      chain: 'evm',
      contract: EVM_USDC,
      function: 'approve(address,uint256)',
      spend: { chainId: CHAIN, valueWei: 0n },
    });
  });

  it('applies the address rule to every address in the calldata, tuples and arrays included', () => {
    expect(reason(match(evmTx({ to: EVM_USDC, data: approve(EVM_FRIEND) })))).toBe('address_not_allowed');
    const batch = (a: string) =>
      encodeFunctionData({
        abi: vault,
        functionName: 'batch',
        args: [
          [
            [EVM_USER, 1n],
            [a as Hex, 2n],
          ],
        ],
      });
    expect(reason(match(evmTx({ to: EVM_VAULT, data: batch(EVM_USDC) })))).toBe('ok');
    expect(reason(match(evmTx({ to: EVM_VAULT, data: batch(EVM_FRIEND) })))).toBe('address_not_allowed');
    const withdraw = (a: string) => encodeFunctionData({ abi: vault, functionName: 'withdraw', args: [a as Hex, 1n] });
    expect(reason(match(evmTx({ to: EVM_VAULT, data: withdraw(EVM_USER.toLowerCase()) })))).toBe('ok');
  });

  it("skips the address rule for 'any' (opaque bytes) functions, within the value limits", () => {
    const exec = encodeFunctionData({ abi: vault, functionName: 'execute', args: [EVM_FRIEND, '0xdeadbeef'] });
    expect(reason(match(evmTx({ to: EVM_VAULT, data: exec, value: 1000n })))).toBe('ok');
    expect(reason(match(evmTx({ to: EVM_VAULT, data: exec, value: 1001n })))).toBe('value_too_high');
  });

  it.each([
    ['an unlisted chain', () => evmTx({ to: EVM_USDC, data: approve(EVM_VAULT) }, 1), 'chain_not_listed'],
    ['an unlisted contract', () => evmTx({ to: EVM_FRIEND, data: approve(EVM_VAULT) }), 'contract_not_listed'],
    [
      'an unlisted selector',
      () =>
        evmTx({
          to: EVM_USDC,
          data: encodeFunctionData({ abi: erc20, functionName: 'transfer', args: [EVM_VAULT, 1n] }),
        }),
      'selector_not_listed',
    ],
    ['no selector (plain value transfer)', () => evmTx({ to: EVM_VAULT, value: 1n }), 'selector_not_listed'],
    [
      'calldata with trailing bytes',
      () => evmTx({ to: EVM_USDC, data: `${approve(EVM_VAULT)}00` }),
      'calldata_mismatch',
    ],
    ['contract creation', () => evmTx({ data: '0x6080' }), 'contract_creation'],
    [
      'a value over maxValueWei',
      () =>
        evmTx({
          to: EVM_VAULT,
          data: encodeFunctionData({ abi: vault, functionName: 'deposit', args: [1n] }),
          value: 1001n,
        }),
      'value_too_high',
    ],
    [
      'an undecodable transaction',
      () => ({ ...evmTx({ to: EVM_USDC }), bytes: new Uint8Array([0x01, 0xc0]) }),
      'decode_failed',
    ],
  ])('sends %s to the popup', (_, s, why) => {
    expect(reason(match(s()))).toBe(why);
  });

  it('counts value per UTC day per chain, and resets the next day', () => {
    const deposit = evmTx({
      to: EVM_VAULT,
      data: encodeFunctionData({ abi: vault, functionName: 'deposit', args: [1n] }),
      value: 600n,
    });
    let usage = usageToday(null, NOW);
    const first = match(deposit, POLICY, { usage, nowMs: NOW });
    expect(first.ok).toBe(true);
    usage = recordAutoApproveUse(usage, NOW, first.ok ? first.spend : undefined);
    expect(usage).toEqual({ day: utcDay(NOW), count: 1, valueWeiByChain: { [CHAIN]: '600' } });
    const second = match(deposit, POLICY, { usage, nowMs: NOW });
    usage = recordAutoApproveUse(usage, NOW, second.ok ? second.spend : undefined);
    expect(reason(match(deposit, POLICY, { usage, nowMs: NOW }))).toBe('daily_value_exceeded'); // 1800 > 1500
    const tomorrow = NOW + 86_400_000;
    expect(reason(match(deposit, POLICY, { usage, nowMs: tomorrow }))).toBe('ok');
    expect(usageToday(usage, tomorrow)).toEqual({ day: utcDay(tomorrow), count: 0, valueWeiByChain: {} });
  });

  it('refuses a policy without an EVM section', () => {
    const { evm: _, ...stellarOnly } = policyJson();
    expect(reason(match(evmTx({ to: EVM_USDC, data: approve(EVM_VAULT) }), validated(stellarOnly)))).toBe(
      'no_policy_section',
    );
  });
});

describe('EIP-712', () => {
  const permit = (
    o: { spender?: string; verifyingContract?: string; chainId?: number; primaryType?: string; extra?: boolean } = {},
  ) => {
    const types: Record<string, { name: string; type: string }[]> = {
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
      [o.primaryType ?? 'PermitSingle']: [
        { name: 'details', type: 'PermitDetails' },
        { name: 'spender', type: 'address' },
        { name: 'sigDeadline', type: 'uint256' },
        ...(o.extra ? [{ name: 'hook', type: 'bytes' }] : []),
      ],
    };
    const json = JSON.stringify({
      types,
      primaryType: o.primaryType ?? 'PermitSingle',
      domain: { name: 'Permit2', chainId: o.chainId ?? CHAIN, verifyingContract: o.verifyingContract ?? EVM_PERMIT2 },
      message: {
        details: { token: EVM_USDC, amount: '1000', expiration: 1, nonce: 0 },
        spender: o.spender ?? EVM_VAULT,
        sigDeadline: '1',
        ...(o.extra ? { hook: '0x1234' } : {}),
      },
    });
    return {
      kind: 'eip712',
      chain: 'evm',
      address: EVM_USER,
      context: { chainId: o.chainId ?? CHAIN },
      bytes: new TextEncoder().encode(json),
    } as ApprovalSubject;
  };

  it('auto-approves a listed (verifyingContract, primaryType) pair whose address fields pass the rule', () => {
    expect(match(permit())).toEqual({ ok: true, chain: 'evm', contract: EVM_PERMIT2, function: 'PermitSingle' });
  });

  it.each([
    ['an unlisted spender (nested address rule)', { spender: EVM_FRIEND }, 'address_not_allowed'],
    ['an unlisted verifying contract', { verifyingContract: EVM_FRIEND }, 'typed_data_not_listed'],
    ['an unlisted primary type', { primaryType: 'PermitBatch' }, 'typed_data_not_listed'],
    ['an unlisted chain', { chainId: 1 }, 'chain_not_listed'],
    ['an opaque bytes field', { extra: true }, 'opaque_bytes'],
  ])('sends %s to the popup', (_, o, why) => {
    expect(reason(match(permit(o)))).toBe(why);
  });

  it('refuses typed data whose domain has no chainId or verifyingContract', () => {
    const noChain = JSON.stringify({
      types: {
        EIP712Domain: [{ name: 'verifyingContract', type: 'address' }],
        PermitSingle: [{ name: 'a', type: 'uint8' }],
      },
      primaryType: 'PermitSingle',
      domain: { verifyingContract: EVM_PERMIT2 },
      message: { a: 1 },
    });
    const s = { ...permit(), bytes: new TextEncoder().encode(noChain) };
    expect(reason(match(s))).toBe('typed_data_not_listed');
  });
});

describe('daily count', () => {
  it('counts every match against perDayCount (3 in the fixture)', () => {
    let usage = null as ReturnType<typeof usageToday> | null;
    for (let i = 0; i < 3; i++) {
      const r = match(stellarTx(swapTx()), POLICY, { usage, nowMs: NOW });
      expect(r.ok).toBe(true);
      usage = recordAutoApproveUse(usage, NOW);
    }
    expect(reason(match(stellarTx(swapTx()), POLICY, { usage, nowMs: NOW }))).toBe('daily_count_reached');
    expect(reason(match(stellarTx(swapTx()), POLICY, { usage, nowMs: NOW + 86_400_000 }))).toBe('ok');
  });
});

describe('protocol decoders', () => {
  const decoder = (recipients: string[], o: Partial<ProtocolDecoder> = {}): ProtocolDecoder => ({
    id: 'test-intent-v1',
    chain: 'stellar',
    matches: (call) => call.chain === 'stellar' && call.function === 'swap',
    decode: () => ({ ok: true, effects: { recipients, targets: [POOL], tokens: [] } }),
    ...o,
  });
  const withDecoder = () => {
    const p = policyJson();
    p.stellar.contracts[0] = {
      id: POOL,
      name: 'Example pool',
      functions: [{ name: 'swap', decoder: 'test-intent-v1' } as never],
    };
    return p;
  };
  // Bytes in the arguments are fine here: the decoder, not the address rule, reads them.
  const tx = () => stellarTx(swapTx({ args: [addr(USER), xdr.ScVal.scvBytes(Buffer.from('opaque'))] }));

  it('applies the address rule to the decoder’s recipients and targets', () => {
    const ok = protocolDecoderRegistry([decoder([USER])]);
    expect(reason(match(tx(), validated(withDecoder(), ok), { ...ctx, decoders: ok }))).toBe('ok');
    const bad = protocolDecoderRegistry([decoder([OTHER])]);
    expect(reason(match(tx(), validated(withDecoder(), bad), { ...ctx, decoders: bad }))).toBe('address_not_allowed');
  });

  it('sends the request to the popup when the decoder refuses, throws, does not match or is not shipped', () => {
    const refuse = protocolDecoderRegistry([decoder([], { decode: () => ({ ok: false, reason: 'unknown intent' }) })]);
    expect(reason(match(tx(), validated(withDecoder(), refuse), { ...ctx, decoders: refuse }))).toBe('decoder_refused');
    const throws = protocolDecoderRegistry([
      decoder([], {
        decode: () => {
          throw new Error('boom');
        },
      }),
    ]);
    expect(reason(match(tx(), validated(withDecoder(), throws), { ...ctx, decoders: throws }))).toBe('decoder_refused');
    const noMatch = protocolDecoderRegistry([decoder([], { matches: () => false })]);
    expect(reason(match(tx(), validated(withDecoder(), noMatch), { ...ctx, decoders: noMatch }))).toBe(
      'decoder_refused',
    );
    // A policy validated against a bundle with the decoder, matched in one without (the batch B registry).
    expect(reason(match(tx(), validated(withDecoder(), noMatch), ctx))).toBe('decoder_unavailable');
  });
});
