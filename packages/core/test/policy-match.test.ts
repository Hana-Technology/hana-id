import { Asset, Keypair, Operation, nativeToScVal, xdr } from '@stellar/stellar-base';
import { type Hex, encodeFunctionData, parseAbi, serializeTransaction } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  type ApprovalSubject,
  type AutoApprovePolicyV1,
  type AutoApproveResult,
  type PolicyValidationOptions,
  type ProtocolDecoder,
  functionSelector,
  matchAutoApprovePolicy,
  protocolDecoderRegistry,
  recordAutoApproveUse,
  usageToday,
  utcDay,
  validateAutoApprovePolicy,
} from './entries.ts';
import { CHAIN, EVM_FRIEND, EVM_PERMIT2, EVM_USDC, EVM_USER, EVM_VAULT, policyJson } from './policy-fixtures.ts';
import {
  ATTACKER,
  OTHER,
  PASSPHRASE,
  POOL,
  ROUTER,
  TOKEN,
  UNLISTED,
  USDC,
  USER,
  accountControlOps,
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
  plainClassicOps,
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

const legacyTx = (tx: Record<string, unknown>, chainId = CHAIN): ApprovalSubject => ({
  kind: 'evm_tx',
  chain: 'evm',
  address: EVM_USER,
  context: { chainId },
  bytes: Buffer.from(
    serializeTransaction({ type: 'legacy', chainId, nonce: 1, gasPrice: 1n, gas: 100_000n, ...tx } as never).slice(2),
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
      { kind: 'raw', chain: 'stellar', address: USER, context: {}, bytes: swapTx() },
    ],
    [
      'raw (EVM)',
      { kind: 'raw', chain: 'evm', address: EVM_USER, context: {}, bytes: new Uint8Array(32) },
    ],
    [
      'personal_sign',
      {
        kind: 'personal_sign',
        chain: 'evm',
        address: EVM_USER,
        context: {},
        bytes: new Uint8Array([1]),
      },
    ],
    [
      'stellar_signMessage',
      {
        kind: 'stellar_message',
        chain: 'stellar',
        address: USER,
        context: {},
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

  it("refuses Bytes and String arguments under 'any' too (a Stellar policy declares no argument types)", () => {
    const bytes = txBytes([invokeOp(ROUTER, 'route', [addr(OTHER), xdr.ScVal.scvBytes(Buffer.alloc(32))])], {
      soroban: sorobanData(),
      fee: '1000',
    });
    expect(match(stellarTx(bytes))).toMatchObject({ ok: false, reason: 'opaque_bytes' });
    const nested = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('to'), val: xdr.ScVal.scvString(`0x${'ee'.repeat(20)}`) }),
    ]);
    const str = txBytes([invokeOp(ROUTER, 'route', [nested])], { soroban: sorobanData(), fee: '1000' });
    expect(reason(match(stellarTx(str)))).toBe('opaque_bytes');
    const inAuth = invocation(ROUTER, 'route', [xdr.ScVal.scvVec([xdr.ScVal.scvBytes(Buffer.alloc(20))])]);
    const auth = txBytes([invokeOp(ROUTER, 'route', [addr(OTHER)], [sourceAuth(inAuth)])], {
      soroban: sorobanData(),
      fee: '1000',
    });
    expect(reason(match(stellarTx(auth)))).toBe('opaque_bytes');
  });

  it('allows wide integers (u256) as amounts under the address rule (Soroban has no 160-bit integers)', () => {
    const wide = nativeToScVal(2n ** 200n, { type: 'u256' });
    expect(reason(match(stellarTx(swapTx({ args: [addr(USER), wide] }))))).toBe('ok');
  });

  it('refuses opaque bytes arguments under the address rule', () => {
    expect(reason(match(stellarTx(swapTx({ args: [addr(USER), xdr.ScVal.scvBytes(Buffer.alloc(32))] }))))).toBe(
      'opaque_bytes',
    );
  });

  it('refuses String arguments under the address rule (a recipient on another chain could hide in one)', () => {
    const evil = xdr.ScVal.scvString(`0x${'ee'.repeat(20)}`);
    expect(reason(match(stellarTx(swapTx({ args: [addr(USER), evil] }))))).toBe('opaque_bytes');
    const nested = xdr.ScVal.scvVec([i128(1n), xdr.ScVal.scvString('GATTACKER')]);
    expect(reason(match(stellarTx(swapTx({ args: [addr(USER), nested] }))))).toBe('opaque_bytes');
    const inAuth = invocation(POOL, 'swap', [addr(USER), xdr.ScVal.scvString('x')]);
    expect(reason(match(stellarTx(swapTx({ root: inAuth }))))).toBe('opaque_bytes');
  });

  it('allows Symbol arguments (too short to hold an address) under the address rule', () => {
    const tag = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Native')]);
    expect(reason(match(stellarTx(swapTx({ args: [addr(USER), tag] }))))).toBe('ok');
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
    ['accountMerge', () => txBytes([Operation.accountMerge({ destination: OTHER })]), 'account_control'],
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

  describe('account-control operations are never auto-approved (CORE-1, D110)', () => {
    it.each(Object.entries(accountControlOps))('%s alone', (_, op) => {
      const r = match(stellarTx(txBytes([op()])));
      expect(reason(r)).toBe('account_control');
      expect(r.ok ? '' : r.detail).toMatch(/changes who controls the account/u);
    });

    it.each(Object.entries(accountControlOps))('%s next to a listed changeTrust, a listed call or with another source', (_, op) => {
      expect(reason(match(stellarTx(txBytes([changeTrustOp(USDC), op()]))))).toBe('account_control');
      const sourced = op();
      sourced.sourceAccount(xdr.MuxedAccount.keyTypeEd25519(Keypair.fromPublicKey(OTHER).rawPublicKey()));
      expect(reason(match(stellarTx(txBytes([sourced]))))).toBe('account_control');
    });

    it('even under a policy that lists every contract, asset and address', () => {
      const wide = validated({
        ...policyJson(),
        stellar: { ...policyJson().stellar, changeTrustAssets: [`USDC:${USDC.getIssuer()}`], addresses: [OTHER, ATTACKER] },
      });
      for (const op of Object.values(accountControlOps)) {
        expect(reason(matchAutoApprovePolicy(wide, stellarTx(txBytes([op()])), ctx))).toBe('account_control');
      }
    });

    it.each(Object.keys(plainClassicOps))('%s is refused as an operation the rules can’t allow', (type) => {
      const build = plainClassicOps[type] as () => xdr.Operation;
      expect(reason(match(stellarTx(txBytes([build()]))))).toBe('operation_not_allowed');
    });
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
    'function vote(address,uint256)',
  ]);
  const approve = (spender: string) =>
    encodeFunctionData({ abi: erc20, functionName: 'approve', args: [spender as Hex, 10n] });

  it('auto-approves an ERC-20 approve to a listed contract', () => {
    expect(match(evmTx({ to: EVM_USDC, data: approve(EVM_VAULT) }))).toEqual({
      ok: true,
      chain: 'evm',
      contract: EVM_USDC,
      function: 'approve(address,uint256)',
      // No value, but the maximum fee (gas 100 000 at 1 wei) counts as native spend.
      spend: { chainId: CHAIN, valueWei: 100_000n },
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

  it("skips the address rule for 'any' functions, within the value limits", () => {
    const vote = encodeFunctionData({ abi: vault, functionName: 'vote', args: [EVM_FRIEND, 1n] });
    expect(reason(match(evmTx({ to: EVM_VAULT, data: vote, value: 1000n })))).toBe('ok');
    expect(reason(match(evmTx({ to: EVM_VAULT, data: vote, value: 1001n })))).toBe('value_plus_fee_too_high');
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
          value: 101_001n,
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
    // Value 600 plus the maximum fee of 100 000.
    expect(usage).toEqual({ day: utcDay(NOW), count: 1, valueWeiByChain: { [CHAIN]: '100600' } });
    const second = match(deposit, POLICY, { usage, nowMs: NOW });
    usage = recordAutoApproveUse(usage, NOW, second.ok ? second.spend : undefined);
    // 3 × 100 600 = 301 800 > 301 500.
    expect(match(deposit, POLICY, { usage, nowMs: NOW })).toMatchObject({
      ok: false,
      reason: 'daily_value_exceeded',
      detail: expect.stringMatching(/maximum fee/u),
    });
    const tomorrow = NOW + 86_400_000;
    expect(reason(match(deposit, POLICY, { usage, nowMs: tomorrow }))).toBe('ok');
    expect(usageToday(usage, tomorrow)).toEqual({ day: utcDay(tomorrow), count: 0, valueWeiByChain: {} });
    // A clock that went back a day keeps the later day's usage instead of resetting the caps (VAUL-2).
    const yesterday = NOW - 86_400_000;
    expect(usageToday(usage, yesterday)).toBe(usage);
    expect(match(deposit, POLICY, { usage, nowMs: yesterday })).toMatchObject({ ok: false, reason: 'daily_value_exceeded' });
    expect(recordAutoApproveUse(usage, yesterday)).toMatchObject({ day: utcDay(NOW), count: usage.count + 1 });
  });

  describe('value plus fee (maxValueWei 101 000, maxValueWeiPerDay 301 500 in the fixture)', () => {
    const deposit = encodeFunctionData({ abi: vault, functionName: 'deposit', args: [1n] });

    it('counts the EIP-1559 maximum fee (gas × maxFeePerGas) with the value, and records both as the spend', () => {
      // Fee 50 000 × 2 = 100 000; value 1 000: exactly 101 000.
      const at = (value: bigint) => evmTx({ to: EVM_VAULT, data: deposit, gas: 50_000n, maxFeePerGas: 2n, value });
      expect(match(at(1000n))).toMatchObject({ ok: true, spend: { chainId: CHAIN, valueWei: 101_000n } });
      expect(match(at(1001n))).toMatchObject({
        ok: false,
        reason: 'value_plus_fee_too_high',
        detail: expect.stringMatching(/maximum fee/u),
      });
      // A lower fee leaves room for more value: fee 21 000, value 80 000.
      expect(match(evmTx({ to: EVM_VAULT, data: deposit, gas: 21_000n, value: 80_000n }))).toMatchObject({
        ok: true,
        spend: { chainId: CHAIN, valueWei: 101_000n },
      });
    });

    it('counts the legacy fee (gas × gasPrice) the same way', () => {
      const at = (value: bigint) => legacyTx({ to: EVM_VAULT, data: deposit, gas: 25_000n, gasPrice: 4n, value });
      expect(match(at(1000n))).toMatchObject({ ok: true, spend: { chainId: CHAIN, valueWei: 101_000n } });
      expect(reason(match(at(1001n)))).toBe('value_plus_fee_too_high');
    });

    it('refuses a value over maxValueWei on its own as value_too_high, and a fee over maxFeeWei as fee_too_high', () => {
      expect(reason(match(evmTx({ to: EVM_VAULT, data: deposit, gas: 1n, value: 101_001n })))).toBe('value_too_high');
      expect(reason(match(evmTx({ to: EVM_VAULT, data: deposit, gas: 100_001n })))).toBe('fee_too_high');
    });

    it('counts fees against the daily total even when no value is sent', () => {
      const approve0 = evmTx({ to: EVM_USDC, data: approve(EVM_VAULT) });
      let usage = usageToday(null, NOW);
      for (let i = 0; i < 3; i++) {
        const r = match(approve0, POLICY, { usage, nowMs: NOW });
        expect(r.ok).toBe(true);
        usage = recordAutoApproveUse(usage, NOW, r.ok ? r.spend : undefined);
      }
      expect(usage.valueWeiByChain[CHAIN]).toBe('300000');
      // A fourth 100 000 would make 400 000 > 301 500 (checked before the daily count of 3).
      expect(reason(match(approve0, POLICY, { usage, nowMs: NOW }))).toBe('daily_value_exceeded');
    });
  });

  describe('fee cap (maxFeeWei 100 000 in the fixture)', () => {
    const deposit = encodeFunctionData({ abi: vault, functionName: 'deposit', args: [1n] });
    const vote = encodeFunctionData({ abi: vault, functionName: 'vote', args: [EVM_FRIEND, 1n] });

    it('auto-approves an EIP-1559 or legacy transaction whose maximum fee is at the cap', () => {
      expect(reason(match(evmTx({ to: EVM_VAULT, data: deposit, gas: 50_000n, maxFeePerGas: 2n })))).toBe('ok');
      expect(reason(match(legacyTx({ to: EVM_VAULT, data: deposit, gas: 25_000n, gasPrice: 4n })))).toBe('ok');
    });

    it.each([
      ['an EIP-1559 gas limit one over', () => evmTx({ to: EVM_VAULT, data: deposit, gas: 100_001n })],
      ['an EIP-1559 maxFeePerGas over', () => evmTx({ to: EVM_VAULT, data: deposit, maxFeePerGas: 2n })],
      [
        'a huge priority fee',
        () =>
          evmTx({
            to: EVM_VAULT,
            data: deposit,
            gas: 10_000_000n,
            maxFeePerGas: 10n ** 15n,
            maxPriorityFeePerGas: 10n ** 15n,
          }),
      ],
      ['a legacy gasPrice over', () => legacyTx({ to: EVM_VAULT, data: deposit, gasPrice: 2n })],
      ['a legacy gas limit over', () => legacyTx({ to: EVM_VAULT, data: deposit, gas: 100_001n })],
      ['an addressArgs any function', () => evmTx({ to: EVM_VAULT, data: vote, gas: 200_000n })],
    ])('sends %s to the popup', (_, s) => {
      expect(match(s())).toMatchObject({ ok: false, reason: 'fee_too_high' });
    });
  });

  describe('opaque arguments as defence in depth (policies the validator would refuse)', () => {
    const ATTACKER = '0x000000000000000000000000eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as Hex;
    const BRIDGE = '0x1111111111111111111111111111111111111111';
    const unvalidated = (
      signature: string,
      addressArgs: 'self-or-listed' | 'any' = 'self-or-listed',
    ): AutoApprovePolicyV1 => {
      const chain = POLICY.evm?.chains[0] as NonNullable<AutoApprovePolicyV1['evm']>['chains'][number];
      return {
        ...POLICY,
        evm: {
          chains: [
            {
              ...chain,
              contracts: [
                {
                  address: BRIDGE,
                  name: 'Bridge',
                  selectors: [
                    { selector: functionSelector(signature), signature, addressArgs },
                  ],
                },
              ],
            },
          ],
        },
      };
    };
    const call = (signature: string, args: readonly unknown[]) =>
      evmTx({
        to: BRIDGE,
        data: encodeFunctionData({ abi: parseAbi([`function ${signature}` as string]), args: args as never } as never),
      });

    it('refuses a Wormhole-shaped transfer to a bytes32 recipient', () => {
      const sig = 'transferTokens(address,uint256,uint16,bytes32,uint256,uint32)';
      expect(validateAutoApprovePolicy(unvalidated(sig)).ok).toBe(false);
      expect(match(call(sig, [EVM_USDC, 10n, 2, ATTACKER, 0n, 0]), unvalidated(sig))).toMatchObject({
        ok: false,
        reason: 'opaque_bytes',
        detail: expect.stringMatching(/bytes32/u),
      });
    });

    it('refuses an Axelar-shaped sendToken to a string address', () => {
      const sig = 'sendToken(string,string,string,uint256)';
      expect(validateAutoApprovePolicy(unvalidated(sig)).ok).toBe(false);
      expect(
        reason(match(call(sig, ['ethereum', `0x${'ee'.repeat(20)}`, 'USDC', 10n]), unvalidated(sig))),
      ).toBe('opaque_bytes');
    });

    it('refuses bytes20 and nested bytes32, and lets short fixed bytes through', () => {
      const b20 = 'f(address,bytes20)';
      expect(reason(match(call(b20, [EVM_USER, `0x${'ee'.repeat(20)}`]), unvalidated(b20)))).toBe('opaque_bytes');
      const nested = 'g((uint256,bytes32)[])';
      expect(reason(match(call(nested, [[[1n, ATTACKER]]]), unvalidated(nested)))).toBe('opaque_bytes');
      const short = 'h(address,bytes4)';
      expect(reason(match(call(short, [EVM_USER, '0xdeadbeef']), unvalidated(short)))).toBe('ok');
    });

    it('refuses a 160-bit integer (an address as an integer), at any depth, and lets other widths through', () => {
      const u160 = 'stake(uint160,uint256)';
      expect(validateAutoApprovePolicy(unvalidated(u160)).ok).toBe(false);
      expect(match(call(u160, [BigInt(ATTACKER), 1n]), unvalidated(u160))).toMatchObject({
        ok: false,
        reason: 'opaque_bytes',
        detail: expect.stringMatching(/uint160/u),
      });
      const i160 = 'stake((int160,uint256)[])';
      expect(reason(match(call(i160, [[[1n, 2n]]]), unvalidated(i160)))).toBe('opaque_bytes');
      // Residual risk, accepted: a uint256 holding an address is an amount to the rule.
      const wide = 'stake(uint256,int256,uint168)';
      expect(validateAutoApprovePolicy(unvalidated(wide)).ok).toBe(true);
      expect(reason(match(call(wide, [BigInt(ATTACKER), -1n, 1n]), unvalidated(wide)))).toBe('ok');
    });

    it("refuses opaque arguments under 'any' too", () => {
      const run = 'run(address,bytes)';
      expect(validateAutoApprovePolicy(unvalidated(run, 'any')).ok).toBe(false);
      expect(reason(match(call(run, [EVM_FRIEND, '0xdeadbeef']), unvalidated(run, 'any')))).toBe('opaque_bytes');
      const u160 = 'stake(uint160)';
      expect(reason(match(call(u160, [1n]), unvalidated(u160, 'any')))).toBe('opaque_bytes');
    });
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
    o: {
      spender?: string;
      verifyingContract?: string;
      chainId?: number;
      primaryType?: string;
      extra?: boolean;
      field?: { type: string; value: unknown };
      /** Permit2's real PermitDetails.amount is uint160 (see the test below); the other tests use uint256. */
      amountType?: string;
    } = {},
  ) => {
    const types: Record<string, { name: string; type: string }[]> = {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      PermitDetails: [
        { name: 'token', type: 'address' },
        { name: 'amount', type: o.amountType ?? 'uint256' },
        { name: 'expiration', type: 'uint48' },
        { name: 'nonce', type: 'uint48' },
      ],
      [o.primaryType ?? 'PermitSingle']: [
        { name: 'details', type: 'PermitDetails' },
        { name: 'spender', type: 'address' },
        { name: 'sigDeadline', type: 'uint256' },
        ...(o.extra ? [{ name: 'hook', type: 'bytes' }] : []),
        ...(o.field ? [{ name: 'field', type: o.field.type }] : []),
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
        ...(o.field ? { field: o.field.value } : {}),
      },
    });
    return {
      kind: 'eip712',
      chain: 'evm',
      address: EVM_USER,
      // Typed data carries no context: the domain's chainId is what the policy checks.
      context: {},
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
    ['a bytes32 field', { field: { type: 'bytes32', value: `0x${'ee'.repeat(32)}` } }, 'opaque_bytes'],
    ['a bytes20 field', { field: { type: 'bytes20', value: `0x${'ee'.repeat(20)}` } }, 'opaque_bytes'],
    ['a string field', { field: { type: 'string', value: `0x${'ee'.repeat(20)}` } }, 'opaque_bytes'],
    ['a string array field', { field: { type: 'string[]', value: ['a'] } }, 'opaque_bytes'],
  ])('sends %s to the popup', (_, o, why) => {
    expect(reason(match(permit(o)))).toBe(why);
  });

  it('allows fixed bytes too short to hold an address', () => {
    expect(reason(match(permit({ field: { type: 'bytes4', value: '0xdeadbeef' } })))).toBe('ok');
  });

  it("treats 160-bit integer fields as opaque, so Permit2's PermitSingle (uint160 amount) goes to the popup", () => {
    expect(match(permit({ amountType: 'uint160' }))).toMatchObject({
      ok: false,
      reason: 'opaque_bytes',
      detail: expect.stringMatching(/details\.amount: uint160/u),
    });
    expect(reason(match(permit({ field: { type: 'int160', value: '-1' } })))).toBe('opaque_bytes');
    expect(reason(match(permit({ field: { type: 'uint160[]', value: ['1'] } })))).toBe('opaque_bytes');
    expect(reason(match(permit({ field: { type: 'uint168', value: '1' } })))).toBe('ok');
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
