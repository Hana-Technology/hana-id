// The mainnet demo's valuation (D428, D429; docs/mainnet-demo-and-key-export-spec.md): every shape it signs, every
// shape it refuses, the cap's edges, the price table's expiry and the pinned identifiers. The Sodax calls are built
// the way @sodax/sdk 2.2.0 builds them (EvmSpokeService.deposit, EvmSolverService.constructCreateIntentData,
// StellarSpokeService.buildDepositCall), with viem and @stellar/stellar-base.
import { Address, Asset, Networks, Operation, xdr } from '@stellar/stellar-base';
import { type Hex, encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters, serializeTransaction } from 'viem';
import { describe, expect, it } from 'vitest';
import type { ApprovalSubject } from '../src/approval.ts';
import { MAINNET_DEMO, MAINNET_DEMO_BALANCE_ORIGINS, assessMainnetDemo, fixedMainnetDemoPrices, formatUsd, mainnetDemoState, usdOf } from '../src/mainnet-demo.ts';
import { MAINNET_DEMO_STELLAR_PASSPHRASE } from '../src/demo-config.ts';
import { MAINNET_DEMO_EVM_CHAINS, STELLAR_MAINNET_PASSPHRASE } from '../src/networks.ts';
import { parsePortEvent } from '../src/protocol.ts';
import { OTHER, USER, addressAuth, invocation, sourceAuth, sorobanData, txBytes } from './stellar-fixtures.ts';

const NOW = Date.UTC(2026, 10, 6, 12);
const EVM_USER = '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826';
const FRIEND = '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB';
const BASE = MAINNET_DEMO.evm[8453]!;
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ASSET_MANAGER = BASE.sodaxAssetManager as Hex;
const INTENTS = MAINNET_DEMO.sodaxIntents as Hex;
const ETH_HUB = BASE.native.sodaxHubAsset as Hex;
const WEI_PER_ETH = 10n ** 18n;
/** The most wei the cap allows at $8,000/ETH: $9.99 / 8000 = 0.00124875 ETH. */
const CAP_WEI = (9_990_000n * WEI_PER_ETH) / 8_000_000_000n;

const evmTx = (tx: Record<string, unknown>, chainId = 8453): ApprovalSubject => ({
  kind: 'evm_tx',
  chain: 'evm',
  address: EVM_USER,
  context: { chainId },
  bytes: Buffer.from(serializeTransaction({ type: 'eip1559', chainId, nonce: 1, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, gas: 21_000n, ...tx } as never).slice(2), 'hex'),
});

const erc20 = parseAbi(['function transfer(address,uint256)', 'function transferFrom(address,address,uint256)', 'function approve(address,uint256)', 'function permit(address,address,uint256,uint256,uint8,bytes32,bytes32)']);
const spoke = parseAbi(['function transfer(address token, bytes to, uint256 amount, bytes data) payable']);
const intents = parseAbi([
  'function createIntent((uint256 intentId, address creator, address inputToken, address outputToken, uint256 inputAmount, uint256 minOutputAmount, uint256 deadline, bool allowPartialFill, uint256 srcChain, uint256 dstChain, bytes srcAddress, bytes dstAddress, address solver, bytes data) intent)',
]);
const HUB_WALLET = '0x1111111111111111111111111111111111111111';

/** Sodax's hub calls, as constructCreateIntentData encodes them. */
function hubCalls(o: { hubAsset?: Hex; approve?: bigint; spender?: Hex; intentToken?: Hex; intentAmount?: bigint; extra?: boolean; approveTarget?: Hex } = {}): Hex {
  const hubAsset = o.hubAsset ?? ETH_HUB;
  const approve = encodeFunctionData({ abi: erc20, functionName: 'approve', args: [o.spender ?? INTENTS, o.approve ?? 1000n] });
  const intent = encodeFunctionData({
    abi: intents,
    functionName: 'createIntent',
    args: [
      {
        intentId: 7n,
        creator: HUB_WALLET,
        inputToken: o.intentToken ?? hubAsset,
        outputToken: '0x2222222222222222222222222222222222222222',
        inputAmount: o.intentAmount ?? 1000n,
        minOutputAmount: 1n,
        deadline: 1n,
        allowPartialFill: false,
        srcChain: 1n,
        dstChain: 2n,
        srcAddress: '0x01',
        dstAddress: '0x02',
        solver: '0x0000000000000000000000000000000000000000',
        data: '0x',
      },
    ],
  });
  const calls = [
    [o.approveTarget ?? hubAsset, 0n, approve],
    [INTENTS, 0n, intent],
    ...(o.extra ? [[hubAsset, 0n, encodeFunctionData({ abi: erc20, functionName: 'transfer', args: [FRIEND, 1n] })]] : []),
  ] as [Hex, bigint, Hex][];
  return encodeAbiParameters(parseAbiParameters('(address,uint256,bytes)[]'), [calls]);
}

const deposit = (token: Hex, amount: bigint, data: Hex = '0x') => encodeFunctionData({ abi: spoke, functionName: 'transfer', args: [token, HUB_WALLET, amount, data] });
const ZERO = '0x0000000000000000000000000000000000000000' as Hex;

const ok = (s: ApprovalSubject, now = NOW) => {
  const r = assessMainnetDemo(s, now);
  if (!r.ok) throw new Error(`refused: ${r.reason} ${r.message}`);
  return r;
};
const refused = (s: ApprovalSubject, now = NOW) => {
  const r = assessMainnetDemo(s, now);
  if (r.ok) throw new Error('allowed');
  return r;
};

describe('the reviewed config', () => {
  it('names exactly Base and Stellar’s public network, and the identifiers Circle and Sodax publish', () => {
    expect(Object.keys(MAINNET_DEMO.evm)).toEqual(['8453']);
    expect(MAINNET_DEMO_EVM_CHAINS).toEqual([8453]);
    expect(MAINNET_DEMO.stellar.networkPassphrase).toBe(STELLAR_MAINNET_PASSPHRASE);
    // Circle's USDC and EURC contract addresses pages (2026-11-06).
    expect(Object.keys(BASE.tokens)).toEqual([USDC_BASE, '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42']);
    expect(Object.keys(MAINNET_DEMO.stellar.assets)).toEqual(['USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN', 'EURC:GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2']);
    expect(MAINNET_DEMO_STELLAR_PASSPHRASE).toBe(STELLAR_MAINNET_PASSPHRASE);
    // @sodax/sdk 2.2.0's packaged config.
    expect(BASE.sodaxAssetManager).toBe('0x348BE44F63A458be9C1b13D6fD8e99048F297Bc3');
    expect(MAINNET_DEMO.stellar.sodaxAssetManager).toBe('CCGF33A4CO6D3BXFEKPXVCFCZBK76I3AQOZK6KIKRPAWAZR3632WHCJ3');
    expect(MAINNET_DEMO.sodaxIntents).toBe('0x6382D6ccD780758C5e8A6123c33ee8F4472F96ef');
  });

  it('pins each Stellar asset contract to the classic asset it wraps on the public network', () => {
    expect(MAINNET_DEMO.stellar.native.assetContract).toBe(Asset.native().contractId(Networks.PUBLIC));
    for (const [code, a] of Object.entries(MAINNET_DEMO.stellar.assets)) {
      const [c, issuer] = code.split(':') as [string, string];
      expect(a.assetContract).toBe(new Asset(c, issuer).contractId(Networks.PUBLIC));
    }
  });

  it('caps a transaction under $10, warns above $10, and expires 45 days after review', () => {
    expect(MAINNET_DEMO.txCapUsdMicros).toBe(9_990_000n);
    expect(MAINNET_DEMO.balanceWarnUsdMicros).toBe(10_000_000n);
    expect(MAINNET_DEMO.validUntilMs - Date.parse(`${MAINNET_DEMO.reviewedAt}T00:00:00Z`)).toBe(45 * 86_400_000);
    expect(MAINNET_DEMO_BALANCE_ORIGINS).toEqual(['https://mainnet.base.org', 'https://horizon.stellar.org']);
  });

  it('states its rules to the SDK in the mainnetDemo event, which accepts only the demo’s own chains and network', () => {
    const state = mainnetDemoState();
    expect(state).toEqual({ evmChains: [8453], stellarNetworkPassphrase: STELLAR_MAINNET_PASSPHRASE, txCapUsdMicros: '9990000', pricesReviewedAt: '2026-11-06', pricesValidUntilMs: MAINNET_DEMO.validUntilMs });
    const event = (data: unknown) => parsePortEvent({ v: 1, event: 'mainnetDemo', data });
    expect(event(state)).not.toBeNull();
    expect(event(null)).not.toBeNull();
    for (const bad of [{ ...state, evmChains: [8453, 1] }, { ...state, evmChains: [146] }, { ...state, evmChains: [8453, 8453] }, { ...state, stellarNetworkPassphrase: 'Test SDF Network ; September 2015' }, { ...state, txCapUsdMicros: 9990000 }, { ...state, extra: 1 }]) {
      expect(event(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('rounds values up, never down', () => {
    expect(usdOf(1n, BASE.native)).toBe(1n);
    expect(usdOf(0n, BASE.native)).toBe(0n);
    expect(usdOf(1_000_000n, BASE.tokens[USDC_BASE]!)).toBe(1_050_000n);
    expect(formatUsd(9_990_000n)).toBe('$9.99');
    expect(formatUsd(9_990_001n)).toBe('$10.00');
    expect(formatUsd(1n)).toBe('$0.01');
  });
});

describe('EVM on Base', () => {
  it('signs a plain ETH send at the cap and refuses one wei more', () => {
    expect(ok(evmTx({ to: FRIEND, value: CAP_WEI })).usdMicros).toBe(9_990_000n);
    const r = refused(evmTx({ to: FRIEND, value: CAP_WEI + 1n }));
    expect(r.reason).toBe('mainnet_demo_over_cap');
    expect(r.message).toBe('Hana’s mainnet demo signs at most $9.99 per transaction; this one can move about $10.00');
  });

  it('counts the maximum fee', () => {
    // 21,000 gas × 1 gwei = 0.000021 ETH = $0.168 at $8,000.
    const r = ok(evmTx({ to: FRIEND, value: 0n, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 1n }));
    expect(r.usdMicros).toBe(168_000n);
    expect(refused(evmTx({ to: FRIEND, value: CAP_WEI, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n })).reason).toBe('mainnet_demo_over_cap');
    // A huge gas price is a way to burn funds: it counts.
    expect(refused(evmTx({ to: FRIEND, value: 0n, gas: 30_000_000n, maxFeePerGas: 10n ** 12n, maxPriorityFeePerGas: 1n })).reason).toBe('mainnet_demo_over_cap');
  });

  it('values USDC transfers, transferFroms and approvals, and refuses an unlimited approval', () => {
    const transfer = (amount: bigint) => evmTx({ to: USDC_BASE, value: 0n, gas: 60_000n, data: encodeFunctionData({ abi: erc20, functionName: 'transfer', args: [FRIEND, amount] }) });
    expect(ok(transfer(9_514_285n)).usdMicros).toBe(9_989_999n + 1n);
    expect(refused(transfer(9_514_286n)).reason).toBe('mainnet_demo_over_cap');
    expect(ok(evmTx({ to: USDC_BASE, value: 0n, data: encodeFunctionData({ abi: erc20, functionName: 'transferFrom', args: [EVM_USER, FRIEND, 1_000_000n] }) })).usdMicros).toBe(1_050_000n);
    const approve = (amount: bigint) => evmTx({ to: USDC_BASE, value: 0n, data: encodeFunctionData({ abi: erc20, functionName: 'approve', args: [ASSET_MANAGER, amount] }) });
    expect(ok(approve(5_000_000n)).movements.map((m) => m.what)).toEqual(['fee', 'approval']);
    expect(ok(approve(0n)).usdMicros).toBe(0n);
    expect(refused(approve(2n ** 256n - 1n)).reason).toBe('mainnet_demo_over_cap');
  });

  it('values EURC on Base like USDC, at its own (higher) price', () => {
    const eurc = '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42';
    const transfer = (amount: bigint) => evmTx({ to: eurc, value: 0n, data: encodeFunctionData({ abi: erc20, functionName: 'transfer', args: [FRIEND, amount] }) });
    expect(ok(transfer(7_000_000n)).usdMicros).toBe(9_450_000n);
    expect(refused(transfer(7_400_001n)).reason).toBe('mainnet_demo_over_cap');
  });

  it('refuses a token it has no price for', () => {
    const r = refused(evmTx({ to: '0x4200000000000000000000000000000000000006', value: 0n, data: encodeFunctionData({ abi: erc20, functionName: 'transfer', args: [FRIEND, 1n] }) }));
    expect(r.reason).toBe('mainnet_demo_unpriced');
  });

  it('refuses calldata it can’t value, even with no ETH attached', () => {
    // A permit call on USDC, any other function, a call to another contract, a contract creation, garbage.
    const permit = encodeFunctionData({ abi: erc20, functionName: 'permit', args: [EVM_USER, FRIEND, 1n, 1n, 27, `0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`] });
    expect(refused(evmTx({ to: USDC_BASE, value: 0n, data: permit })).reason).toBe('mainnet_demo_unknown_call');
    expect(refused(evmTx({ to: FRIEND, value: 0n, data: '0xdeadbeef' })).reason).toBe('mainnet_demo_unknown_call');
    expect(refused(evmTx({ to: undefined, value: 0n, data: '0x6000' })).reason).toBe('mainnet_demo_unknown_call');
    // A transfer whose arguments aren't canonically encoded (one byte short).
    const short = encodeFunctionData({ abi: erc20, functionName: 'transfer', args: [FRIEND, 1n] }).slice(0, -2) as Hex;
    expect(refused(evmTx({ to: USDC_BASE, value: 0n, data: short })).reason).toBe('mainnet_demo_unknown_call');
  });

  it('signs the sample’s Sodax swap (native ETH into the asset manager, with Sodax’s hub calls)', () => {
    const amount = 1_000_000_000_000_000n; // 0.001 ETH = $8
    const r = ok(evmTx({ to: ASSET_MANAGER, value: amount, gas: 200_000n, data: deposit(ZERO, amount, hubCalls({ approve: amount, intentAmount: amount })) }));
    expect(r.usdMicros).toBe(8_000_000n);
    expect(r.movements.map((m) => m.what)).toEqual(['fee', 'deposit']);
    // A plain deposit with no hub calls.
    expect(ok(evmTx({ to: ASSET_MANAGER, value: amount, data: deposit(ZERO, amount) })).usdMicros).toBe(8_000_000n);
    // And a USDC deposit (its approval is a transaction of its own).
    const usdcHub = BASE.tokens[USDC_BASE]!.sodaxHubAsset as Hex;
    expect(ok(evmTx({ to: ASSET_MANAGER, value: 0n, data: deposit(USDC_BASE, 2_000_000n, hubCalls({ hubAsset: usdcHub, approve: 2_000_000n, intentAmount: 1_990_000n })) })).usdMicros).toBe(2_100_000n);
  });

  it('refuses a Sodax deposit over the cap, with value ≠ amount, of another asset, or with other hub calls', () => {
    const amount = 10n ** 15n;
    const send = (value: bigint, data: Hex) => evmTx({ to: ASSET_MANAGER, value, data });
    expect(refused(send(2n * 10n ** 15n, deposit(ZERO, 2n * 10n ** 15n))).reason).toBe('mainnet_demo_over_cap');
    expect(refused(send(0n, deposit(ZERO, amount))).reason).toBe('mainnet_demo_unknown_call');
    expect(refused(send(amount + 1n, deposit(ZERO, amount))).reason).toBe('mainnet_demo_unknown_call');
    expect(refused(send(0n, deposit('0x4200000000000000000000000000000000000006', 1n))).reason).toBe('mainnet_demo_unpriced');
    const bad = (o: Parameters<typeof hubCalls>[0]) => refused(send(amount, deposit(ZERO, amount, hubCalls({ approve: amount, intentAmount: amount, ...o })))).reason;
    expect(bad({ approve: amount + 1n })).toBe('mainnet_demo_unknown_call');
    expect(bad({ intentAmount: amount + 1n })).toBe('mainnet_demo_unknown_call');
    expect(bad({ spender: FRIEND })).toBe('mainnet_demo_unknown_call');
    expect(bad({ intentToken: '0x3333333333333333333333333333333333333333' })).toBe('mainnet_demo_unknown_call');
    expect(bad({ approveTarget: '0x3333333333333333333333333333333333333333' })).toBe('mainnet_demo_unknown_call');
    expect(bad({ extra: true })).toBe('mainnet_demo_unknown_call');
    expect(refused(send(amount, deposit(ZERO, amount, '0x1234'))).reason).toBe('mainnet_demo_unknown_call');
    // Another asset-manager function.
    expect(refused(send(0n, encodeFunctionData({ abi: erc20, functionName: 'transfer', args: [FRIEND, 1n] }))).reason).toBe('mainnet_demo_unknown_call');
  });

  it('refuses typed data for Base (a permit moves tokens without a transaction) and any other mainnet', () => {
    const typed: ApprovalSubject = {
      kind: 'eip712',
      chain: 'evm',
      address: EVM_USER,
      context: {},
      bytes: new TextEncoder().encode(
        JSON.stringify({ types: { EIP712Domain: [{ name: 'chainId', type: 'uint256' }], M: [{ name: 'a', type: 'uint256' }] }, primaryType: 'M', domain: { chainId: 8453 }, message: { a: '1' } }),
      ),
    };
    expect(refused(typed).reason).toBe('mainnet_demo_unknown_call');
    for (const chainId of [1, 146, 10]) expect(refused(evmTx({ to: FRIEND, value: 1n }, chainId)).reason).toBe('mainnet_not_allowed');
  });

  it('refuses everything once the prices have expired', () => {
    const r = refused(evmTx({ to: FRIEND, value: 1n }), MAINNET_DEMO.validUntilMs);
    expect(r.reason).toBe('mainnet_demo_prices_stale');
    expect(ok(evmTx({ to: FRIEND, value: 1n }), MAINNET_DEMO.validUntilMs - 1).ok).toBe(true);
  });
});

describe('Stellar’s public network', () => {
  const stellar = (bytes: Uint8Array, passphrase = STELLAR_MAINNET_PASSPHRASE, address = USER): ApprovalSubject => ({
    kind: 'stellar_tx',
    chain: 'stellar',
    address,
    context: { networkPassphrase: passphrase },
    bytes,
  });
  const USDC = new Asset('USDC', 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN');
  const XLM_SAC = MAINNET_DEMO.stellar.native.assetContract;
  const AM = MAINNET_DEMO.stellar.sodaxAssetManager;

  it('values XLM and USDC payments and account creation, fee included', () => {
    // 9.99 XLM minus the 100-stroop fee is at the cap; one stroop more is over.
    expect(ok(stellar(txBytes([Operation.payment({ destination: OTHER, asset: Asset.native(), amount: '9.9899900' })]))).usdMicros).toBe(9_990_000n);
    expect(refused(stellar(txBytes([Operation.payment({ destination: OTHER, asset: Asset.native(), amount: '9.9899901' })]))).reason).toBe('mainnet_demo_over_cap');
    expect(ok(stellar(txBytes([Operation.payment({ destination: OTHER, asset: USDC, amount: '5' })]))).usdMicros).toBe(5_250_010n);
    expect(ok(stellar(txBytes([Operation.createAccount({ destination: OTHER, startingBalance: '2' })]))).usdMicros).toBe(2_000_010n);
    // Two payments add up.
    expect(refused(stellar(txBytes([Operation.payment({ destination: OTHER, asset: Asset.native(), amount: '5' }), Operation.payment({ destination: OTHER, asset: USDC, amount: '5' })]))).reason).toBe('mainnet_demo_over_cap');
  });

  it('allows a USDC trustline (it moves nothing) and refuses an unpriced asset', () => {
    expect(ok(stellar(txBytes([Operation.changeTrust({ asset: USDC })]))).usdMicros).toBe(10n);
    const other = new Asset('USDC', OTHER);
    expect(refused(stellar(txBytes([Operation.changeTrust({ asset: other })]))).reason).toBe('mainnet_demo_unpriced');
    expect(refused(stellar(txBytes([Operation.payment({ destination: OTHER, asset: other, amount: '1' })]))).reason).toBe('mainnet_demo_unpriced');
  });

  it('refuses operations it can’t value', () => {
    for (const op of [
      Operation.accountMerge({ destination: OTHER }),
      Operation.setOptions({ signer: { ed25519PublicKey: OTHER, weight: 1 } }),
      Operation.pathPaymentStrictSend({ sendAsset: Asset.native(), sendAmount: '1', destination: OTHER, destAsset: USDC, destMin: '0.1', path: [] }),
      Operation.manageSellOffer({ selling: Asset.native(), buying: USDC, amount: '1', price: '1' }),
      Operation.manageData({ name: 'x', value: 'y' }),
    ]) {
      expect(refused(stellar(txBytes([op]))).reason).toBe('mainnet_demo_unknown_call');
    }
  });

  const am = (fn: string, args: xdr.ScVal[], auth: xdr.SorobanAuthorizationEntry[]) =>
    stellar(txBytes([Operation.invokeContractFunction({ contract: AM, function: fn, args, auth })], { soroban: sorobanData(), fee: '100000' }));
  const scAddr = (a: string) => new Address(a).toScVal();
  const u128 = (n: bigint) => xdr.ScVal.scvU128(new xdr.UInt128Parts({ hi: xdr.Uint64.fromString('0'), lo: xdr.Uint64.fromString(n.toString()) }));
  const i128 = (n: bigint) => xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: xdr.Int64.fromString('0'), lo: xdr.Uint64.fromString(n.toString()) }));
  const bytes = (hex: string) => xdr.ScVal.scvBytes(Buffer.from(hex.replace(/^0x/u, ''), 'hex'));
  const depositArgs = (amount: bigint, data: string, from = USER, token = XLM_SAC) => [scAddr(from), scAddr(token), u128(amount), bytes(HUB_WALLET), bytes(data)];
  const xlmHub = MAINNET_DEMO.stellar.native.sodaxHubAsset as Hex;
  const sodaxAuth = (args: xdr.ScVal[], sub: { from?: string; to?: string; amount?: bigint; token?: string; extra?: boolean } = {}) =>
    sourceAuth(
      invocation(AM, 'transfer', args, [
        invocation(sub.token ?? XLM_SAC, 'transfer', [scAddr(sub.from ?? USER), scAddr(sub.to ?? AM), i128(sub.amount ?? 50_000_000n)]),
        ...(sub.extra ? [invocation(XLM_SAC, 'transfer', [scAddr(USER), scAddr(OTHER), i128(1n)])] : []),
      ]),
    );

  it('signs a Sodax deposit of XLM with its own authorization', () => {
    const data = hubCalls({ hubAsset: xlmHub, approve: 50_000_000n, intentAmount: 50_000_000n });
    const args = depositArgs(50_000_000n, data);
    const r = ok(am('transfer', args, [sodaxAuth(args)]));
    // 5 XLM + the 0.0105 XLM fee (0.01 inclusion fee + the 5,000-stroop Soroban resource fee).
    expect(r.usdMicros).toBe(5_010_500n);
    expect(r.movements.map((m) => m.what)).toEqual(['fee', 'deposit']);
  });

  it('refuses a Sodax deposit with a wrong or missing authorization, from another account, or over the cap', () => {
    const data = hubCalls({ hubAsset: xlmHub, approve: 50_000_000n, intentAmount: 50_000_000n });
    const args = depositArgs(50_000_000n, data);
    expect(refused(am('transfer', args, [])).reason).toBe('mainnet_demo_unknown_call');
    expect(refused(am('transfer', args, [sodaxAuth(args, { amount: 60_000_000n })])).reason).toBe('mainnet_demo_unknown_call');
    expect(refused(am('transfer', args, [sodaxAuth(args, { to: OTHER })])).reason).toBe('mainnet_demo_unknown_call');
    expect(refused(am('transfer', args, [sodaxAuth(args, { extra: true })])).reason).toBe('mainnet_demo_unknown_call');
    expect(refused(am('transfer', args, [sodaxAuth(depositArgs(1n, '0x'))])).reason).toBe('mainnet_demo_unknown_call');
    expect(refused(am('transfer', args, [addressAuth(OTHER, invocation(AM, 'transfer', args))])).reason).toBe('mainnet_demo_unknown_call');
    const fromOther = depositArgs(50_000_000n, data, OTHER);
    expect(refused(am('transfer', fromOther, [sodaxAuth(fromOther, { from: OTHER })])).reason).toBe('mainnet_demo_unknown_call');
    const big = depositArgs(200_000_000n, '0x');
    expect(refused(am('transfer', big, [sodaxAuth(big, { amount: 200_000_000n })])).reason).toBe('mainnet_demo_over_cap');
    // Hub calls spending more than the deposit.
    const greedy = depositArgs(50_000_000n, hubCalls({ hubAsset: xlmHub, approve: 60_000_000n, intentAmount: 50_000_000n }));
    expect(refused(am('transfer', greedy, [sodaxAuth(greedy)])).reason).toBe('mainnet_demo_unknown_call');
    // Another function of the asset manager, and another contract.
    expect(refused(am('withdraw', args, [sodaxAuth(args)])).reason).toBe('mainnet_demo_unknown_call');
    expect(refused(stellar(txBytes([Operation.invokeContractFunction({ contract: XLM_SAC, function: 'transfer', args: [scAddr(USER), scAddr(AM), i128(1n)], auth: [] })], { soroban: sorobanData() }))).reason).toBe(
      'mainnet_demo_unknown_call',
    );
  });

  it('refuses a fee bump, a Soroban auth entry and the testnet passphrase (that is not a demo network)', () => {
    const preimage: ApprovalSubject = { kind: 'stellar_auth_entry', chain: 'stellar', address: USER, context: { networkPassphrase: STELLAR_MAINNET_PASSPHRASE }, bytes: new Uint8Array([1, 2, 3]) };
    expect(refused(preimage).reason).toBe('mainnet_demo_unknown_call');
    expect(refused(stellar(txBytes([Operation.payment({ destination: OTHER, asset: Asset.native(), amount: '1' })]), Networks.TESTNET)).reason).toBe('mainnet_not_allowed');
  });
});

describe('the Sodax USDC ⇄ USDC bridge between Base and Stellar (D476)', () => {
  const VAULT = '0xAbbb91c0617090F0028BDC27597Cd0D038F3A833' as Hex;
  const HUB_AM = '0x60c5681bD1DB4e50735c4cA3386005A4BA4937C0' as Hex;
  const BASE_HUB = BASE.tokens[USDC_BASE]!.sodaxHubAsset as Hex;
  const STELLAR_USDC = 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
  const STELLAR_HUB = MAINNET_DEMO.stellar.assets[STELLAR_USDC]!.sodaxHubAsset as Hex;
  const EURC_BASE_ADDR = '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42' as Hex;
  const EURC_HUB = BASE.tokens[EURC_BASE_ADDR]!.sodaxHubAsset as Hex;
  const WALLETS = { evm: EVM_USER, stellar: USER };
  /** The user's Stellar account as the hub receives it: SCV_ADDRESS XDR, exactly what the SDK's encodeAddress gives. */
  const recipientOf = (g: string) => `0x${new Address(g).toScVal().toXDR('hex')}` as Hex;
  const STELLAR_RECIPIENT = recipientOf(USER);
  const BASE_RECIPIENT = EVM_USER.toLowerCase() as Hex;

  // Built offline with @sodax/sdk 2.2.0's static encoders (Erc20Service, EvmVaultTokenService, EvmAssetManagerService,
  // encodeAddress, encodeContractCalls) and its packaged config, for 1 USDC each way; hex lowercased (same bytes).
  const SDK_BASE_TO_STELLAR = '0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000001600000000000000000000000000000000000000000000000000000000000000240000000000000000000000000000000000000000000000000000000000000032000000000000000000000000072e852545b024ddcbc5b70c1bcbdaa025164259c000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000044095ea7b3000000000000000000000000abbb91c0617090f0028bdc27597cd0d038f3a83300000000000000000000000000000000000000000000000000000000000f424000000000000000000000000000000000000000000000000000000000000000000000000000000000abbb91c0617090f0028bdc27597cd0d038f3a83300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000004447e7ef2400000000000000000000000072e852545b024ddcbc5b70c1bcbdaa025164259c00000000000000000000000000000000000000000000000000000000000f424000000000000000000000000000000000000000000000000000000000000000000000000000000000abbb91c0617090f0028bdc27597cd0d038f3a833000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000044f3fef3a3000000000000000000000000348007b53f25a9a857ab8ea81ec9e3ccbcf440f20000000000000000000000000000000000000000000000000de0b6b3a76400000000000000000000000000000000000000000000000000000000000000000000000000000000000060c5681bd1db4e50735c4ca3386005a4ba4937c0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000104c6b4180b000000000000000000000000348007b53f25a9a857ab8ea81ec9e3ccbcf440f20000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000098968000000000000000000000000000000000000000000000000000000000000000e0000000000000000000000000000000000000000000000000000000000000002c000000120000000000000000ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' as Hex;
  const SDK_STELLAR_TO_BASE = '0x000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000016000000000000000000000000000000000000000000000000000000000000002400000000000000000000000000000000000000000000000000000000000000320000000000000000000000000348007b53f25a9a857ab8ea81ec9e3ccbcf440f2000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000044095ea7b3000000000000000000000000abbb91c0617090f0028bdc27597cd0d038f3a833000000000000000000000000000000000000000000000000000000000098968000000000000000000000000000000000000000000000000000000000000000000000000000000000abbb91c0617090f0028bdc27597cd0d038f3a83300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000004447e7ef24000000000000000000000000348007b53f25a9a857ab8ea81ec9e3ccbcf440f2000000000000000000000000000000000000000000000000000000000098968000000000000000000000000000000000000000000000000000000000000000000000000000000000abbb91c0617090f0028bdc27597cd0d038f3a833000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000044f3fef3a300000000000000000000000072e852545b024ddcbc5b70c1bcbdaa025164259c0000000000000000000000000000000000000000000000000de0b6b3a76400000000000000000000000000000000000000000000000000000000000000000000000000000000000060c5681bd1db4e50735c4ca3386005a4ba4937c00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000e4c6b4180b00000000000000000000000072e852545b024ddcbc5b70c1bcbdaa025164259c000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000f424000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000014cd2a3d9f938e13cd947ec05abc7fe734df8dd826000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' as Hex;

  type HubCall = [Hex, bigint, Hex];
  const vaultAbi = parseAbi(['function deposit(address,uint256)', 'function withdraw(address,uint256)']);
  const amAbi = parseAbi(['function transfer(address,bytes,uint256,bytes)']);
  interface Build {
    srcHub: Hex;
    dstHub: Hex;
    srcDec: number;
    dstDec: number;
    amount: bigint;
    recipient: Hex;
    mutate?: (c: HubCall[]) => HubCall[];
  }
  /** The bridge's four hub calls, as buildBridgeData encodes them; `mutate` then changes one field. */
  function bridgeHubCalls(o: Build): Hex {
    const w = o.amount * 10n ** BigInt(18 - o.srcDec);
    const delivered = w / 10n ** BigInt(18 - o.dstDec);
    const calls: HubCall[] = [
      [o.srcHub, 0n, encodeFunctionData({ abi: erc20, functionName: 'approve', args: [VAULT, o.amount] })],
      [VAULT, 0n, encodeFunctionData({ abi: vaultAbi, functionName: 'deposit', args: [o.srcHub, o.amount] })],
      [VAULT, 0n, encodeFunctionData({ abi: vaultAbi, functionName: 'withdraw', args: [o.dstHub, w] })],
      [HUB_AM, 0n, encodeFunctionData({ abi: amAbi, functionName: 'transfer', args: [o.dstHub, o.recipient, delivered, '0x'] })],
    ];
    return encodeAbiParameters(parseAbiParameters('(address,uint256,bytes)[]'), [o.mutate ? o.mutate(calls) : calls]);
  }
  const baseToStellar = (over: Partial<Build> = {}): Hex => bridgeHubCalls({ srcHub: BASE_HUB, dstHub: STELLAR_HUB, srcDec: 6, dstDec: 7, amount: 1_000_000n, recipient: STELLAR_RECIPIENT, ...over });
  const stellarToBase = (over: Partial<Build> = {}): Hex => bridgeHubCalls({ srcHub: STELLAR_HUB, dstHub: BASE_HUB, srcDec: 7, dstDec: 6, amount: 10_000_000n, recipient: BASE_RECIPIENT, ...over });

  const baseDeposit = (data: Hex, amount = 1_000_000n) => evmTx({ to: ASSET_MANAGER, value: 0n, data: deposit(USDC_BASE as Hex, amount, data) });
  const assess = (s: ApprovalSubject, recipients: Parameters<typeof assessMainnetDemo>[3] = { wallets: WALLETS }) => assessMainnetDemo(s, NOW, fixedMainnetDemoPrices(), recipients);
  const bridgeOk = (s: ApprovalSubject, recipients?: Parameters<typeof assessMainnetDemo>[3]) => {
    const r = assess(s, recipients);
    if (!r.ok) throw new Error(`refused: ${r.reason} ${r.message}`);
    return r;
  };
  const bridgeRefusal = (s: ApprovalSubject) => {
    const r = assess(s);
    if (r.ok) throw new Error('allowed');
    return r.reason;
  };

  // The Stellar source's deposit.
  const AM = MAINNET_DEMO.stellar.sodaxAssetManager;
  const USDC_SAC = MAINNET_DEMO.stellar.assets[STELLAR_USDC]!.assetContract;
  const EURC_KEY = 'EURC:GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2';
  const scAddr = (a: string) => new Address(a).toScVal();
  const u128 = (n: bigint) => xdr.ScVal.scvU128(new xdr.UInt128Parts({ hi: xdr.Uint64.fromString('0'), lo: xdr.Uint64.fromString(n.toString()) }));
  const i128 = (n: bigint) => xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: xdr.Int64.fromString('0'), lo: xdr.Uint64.fromString(n.toString()) }));
  const scBytes = (hex: string) => xdr.ScVal.scvBytes(Buffer.from(hex.replace(/^0x/u, ''), 'hex'));
  const stellarDeposit = (data: Hex, amount = 10_000_000n, token = USDC_SAC): ApprovalSubject => {
    const args = [scAddr(USER), scAddr(token), u128(amount), scBytes(HUB_WALLET), scBytes(data)];
    const auth = sourceAuth(invocation(AM, 'transfer', args, [invocation(token, 'transfer', [scAddr(USER), scAddr(AM), i128(amount)])]));
    return {
      kind: 'stellar_tx',
      chain: 'stellar',
      address: USER,
      context: { networkPassphrase: STELLAR_MAINNET_PASSPHRASE },
      bytes: txBytes([Operation.invokeContractFunction({ contract: AM, function: 'transfer', args, auth: [auth] })], { soroban: sorobanData(), fee: '100000' }),
    };
  };

  it('pins sodaUSDC, the hub asset manager and the two USDC hub assets with their decimals (@sodax/sdk 2.2.0’s packaged config)', () => {
    expect(MAINNET_DEMO.sodaxBridge.vault).toBe('0xAbbb91c0617090F0028BDC27597Cd0D038F3A833');
    expect(MAINNET_DEMO.sodaxBridge.hubAssetManager).toBe('0x60c5681bD1DB4e50735c4cA3386005A4BA4937C0');
    expect(MAINNET_DEMO.sodaxBridge.usdc).toEqual([
      { hubAsset: '0x72E852545B024ddCbc5b70C1bCBDAA025164259C', decimals: 6, chain: 'evm', chainName: 'Base' },
      { hubAsset: '0x348007B53F25A9A857aB8eA81ec9E3CCBCf440f2', decimals: 7, chain: 'stellar', chainName: 'Stellar' },
    ]);
    // The same hub assets and decimals as the swap's own pins.
    expect(BASE.tokens[USDC_BASE]).toMatchObject({ sodaxHubAsset: '0x72E852545B024ddCbc5b70C1bCBDAA025164259C', decimals: 6 });
    expect(MAINNET_DEMO.stellar.assets[STELLAR_USDC]).toMatchObject({ sodaxHubAsset: '0x348007B53F25A9A857aB8eA81ec9E3CCBCf440f2', decimals: 7 });
  });

  it('builds the same bytes as the SDK for both directions (the mutations below start from these)', () => {
    expect(baseToStellar()).toBe(SDK_BASE_TO_STELLAR);
    expect(stellarToBase()).toBe(SDK_STELLAR_TO_BASE);
  });

  it('signs Base → Stellar: the deposit is valued, and the bridge is described for the popup', () => {
    const r = bridgeOk(baseDeposit(SDK_BASE_TO_STELLAR));
    expect(r.usdMicros).toBe(1_050_000n);
    expect(r.movements.map((m) => m.what)).toEqual(['fee', 'deposit']);
    expect(r.bridge).toEqual({ symbol: 'USDC', amount: '1', fromChain: 'Base', toChain: 'Stellar', recipient: USER });
  });

  it('signs Stellar → Base from the signing account, with its own authorization', () => {
    const r = bridgeOk(stellarDeposit(SDK_STELLAR_TO_BASE));
    expect(r.movements.map((m) => m.what)).toEqual(['fee', 'deposit']);
    expect(r.movements.find((m) => m.what === 'deposit')).toMatchObject({ symbol: 'USDC', amount: 10_000_000n });
    expect(r.bridge).toEqual({ symbol: 'USDC', amount: '1', fromChain: 'Stellar', toChain: 'Base', recipient: EVM_USER });
    // A fractional amount is shown as such.
    const half = bridgeOk(stellarDeposit(stellarToBase({ amount: 2_500_000n }), 2_500_000n));
    expect(half.bridge?.amount).toBe('0.25');
  });

  it('refuses a bridge when no wallets were given to check the recipient, and lets the popup read it to show it', () => {
    const noWallets = assessMainnetDemo(baseDeposit(SDK_BASE_TO_STELLAR), NOW);
    expect(noWallets.ok ? null : noWallets.reason).toBe('mainnet_demo_unknown_call');
    // `shown` (the popup, which holds one address): the recipient is read, not bound; the vault binds it.
    expect(bridgeOk(baseDeposit(baseToStellar({ recipient: recipientOf(OTHER) })), 'shown').bridge?.recipient).toBe(OTHER);
    // A recipient of the wrong form is refused even then: the popup never renders one it can't read canonically.
    const shownRefused = (recipient: Hex) => {
      const r = assess(baseDeposit(baseToStellar({ recipient })), 'shown');
      return r.ok ? null : r.reason;
    };
    expect(shownRefused(`0x000000120000000100000000${'ab'.repeat(32)}`)).toBe('mainnet_demo_unknown_call');
    expect(shownRefused(`0x00000011${'00'.repeat(8)}${'ab'.repeat(32)}`)).toBe('mainnet_demo_unknown_call');
    expect(shownRefused(BASE_RECIPIENT)).toBe('mainnet_demo_unknown_call');
  });

  const setCall = (i: number, c: (call: HubCall) => HubCall) => (calls: HubCall[]) => calls.map((x, n) => (n === i ? c(x) : x));
  const ANY = '0x3333333333333333333333333333333333333333' as Hex;

  it.each([
    ['approve’s target', setCall(0, ([, v, d]) => [ANY, v, d])],
    ['deposit’s target', setCall(1, ([, v, d]) => [ANY, v, d])],
    ['withdraw’s target', setCall(2, ([, v, d]) => [ANY, v, d])],
    ['the transfer’s target', setCall(3, ([, v, d]) => [ANY, v, d])],
    ['approve’s selector', setCall(0, ([t, v, d]) => [t, v, `0xa9059cbb${d.slice(10)}` as Hex])],
    ['deposit’s selector', setCall(1, ([t, v, d]) => [t, v, `0xdeadbeef${d.slice(10)}` as Hex])],
    ['withdraw’s selector', setCall(2, ([t, v, d]) => [t, v, `0xdeadbeef${d.slice(10)}` as Hex])],
    ['the transfer’s selector', setCall(3, ([t, v, d]) => [t, v, `0xdeadbeef${d.slice(10)}` as Hex])],
    ['a value on approve', setCall(0, ([t, , d]) => [t, 1n, d])],
    ['a value on deposit', setCall(1, ([t, , d]) => [t, 1n, d])],
    ['a value on withdraw', setCall(2, ([t, , d]) => [t, 1n, d])],
    ['a value on the transfer', setCall(3, ([t, , d]) => [t, 1n, d])],
    ['the approval’s spender', setCall(0, ([t, v]) => [t, v, encodeFunctionData({ abi: erc20, functionName: 'approve', args: [FRIEND, 1_000_000n] })])],
    ['the approval’s amount (lower)', setCall(0, ([t, v]) => [t, v, encodeFunctionData({ abi: erc20, functionName: 'approve', args: [VAULT, 999_999n] })])],
    ['the approval’s amount (higher)', setCall(0, ([t, v]) => [t, v, encodeFunctionData({ abi: erc20, functionName: 'approve', args: [VAULT, 1_000_001n] })])],
    ['the deposit’s amount', setCall(1, ([t, v]) => [t, v, encodeFunctionData({ abi: vaultAbi, functionName: 'deposit', args: [BASE_HUB, 999_999n] })])],
    ['the deposit’s token', setCall(1, ([t, v]) => [t, v, encodeFunctionData({ abi: vaultAbi, functionName: 'deposit', args: [ANY, 1_000_000n] })])],
    ['the withdrawal’s amount', setCall(2, ([t, v]) => [t, v, encodeFunctionData({ abi: vaultAbi, functionName: 'withdraw', args: [STELLAR_HUB, 10n ** 18n - 1n] })])],
    ['the withdrawal’s token', setCall(2, ([t, v]) => [t, v, encodeFunctionData({ abi: vaultAbi, functionName: 'withdraw', args: [EURC_HUB, 10n ** 18n] })])],
    ['the delivered amount', setCall(3, ([t, v]) => [t, v, encodeFunctionData({ abi: amAbi, functionName: 'transfer', args: [STELLAR_HUB, STELLAR_RECIPIENT, 9_999_999n, '0x'] })])],
    ['the delivered token', setCall(3, ([t, v]) => [t, v, encodeFunctionData({ abi: amAbi, functionName: 'transfer', args: [EURC_HUB, STELLAR_RECIPIENT, 10_000_000n, '0x'] })])],
    ['data on the transfer', setCall(3, ([t, v]) => [t, v, encodeFunctionData({ abi: amAbi, functionName: 'transfer', args: [STELLAR_HUB, STELLAR_RECIPIENT, 10_000_000n, '0x01'] })])],
    ['a fifth call (a partner fee)', (calls: HubCall[]) => [...calls, [VAULT, 0n, encodeFunctionData({ abi: erc20, functionName: 'transfer', args: [FRIEND, 1n] })] as HubCall]],
    ['a missing call', (calls: HubCall[]) => calls.slice(0, 3)],
    ['the calls reordered', (calls: HubCall[]) => [calls[1]!, calls[0]!, calls[2]!, calls[3]!]],
  ] as const)('refuses a mutated %s', (_name, mutate) => {
    expect(bridgeRefusal(baseDeposit(baseToStellar({ mutate: mutate as (c: HubCall[]) => HubCall[] })))).toBe('mainnet_demo_unknown_call');
  });

  it('refuses swapped hub assets, a same-asset “bridge”, EURC, ETH and XLM', () => {
    // Swapped: the source isn't the deposited asset's hub asset.
    expect(bridgeRefusal(baseDeposit(baseToStellar({ srcHub: STELLAR_HUB, dstHub: BASE_HUB })))).toBe('mainnet_demo_unknown_call');
    expect(bridgeRefusal(stellarDeposit(stellarToBase({ srcHub: BASE_HUB, dstHub: STELLAR_HUB })))).toBe('mainnet_demo_unknown_call');
    // Source and destination the same hub asset.
    expect(bridgeRefusal(baseDeposit(baseToStellar({ dstHub: BASE_HUB, dstDec: 6, recipient: BASE_RECIPIENT })))).toBe('mainnet_demo_unknown_call');
    // EURC: deposited, or as the destination.
    expect(bridgeRefusal(evmTx({ to: ASSET_MANAGER, value: 0n, data: deposit(EURC_BASE_ADDR, 1_000_000n, baseToStellar({ srcHub: EURC_HUB, dstHub: STELLAR_HUB })) }))).toBe('mainnet_demo_unknown_call');
    expect(bridgeRefusal(baseDeposit(baseToStellar({ dstHub: MAINNET_DEMO.stellar.assets[EURC_KEY]!.sodaxHubAsset as Hex })))).toBe('mainnet_demo_unknown_call');
    // ETH and XLM share a four-call shape but aren't the pair.
    const ethAmount = 1_000_000_000_000_000n;
    expect(
      bridgeRefusal(evmTx({ to: ASSET_MANAGER, value: ethAmount, data: deposit(ZERO, ethAmount, bridgeHubCalls({ srcHub: ETH_HUB, dstHub: STELLAR_HUB, srcDec: 18, dstDec: 7, amount: ethAmount, recipient: STELLAR_RECIPIENT })) })),
    ).toBe('mainnet_demo_unknown_call');
    const xlmHub = MAINNET_DEMO.stellar.native.sodaxHubAsset as Hex;
    expect(bridgeRefusal(stellarDeposit(bridgeHubCalls({ srcHub: xlmHub, dstHub: BASE_HUB, srcDec: 7, dstDec: 6, amount: 10_000_000n, recipient: BASE_RECIPIENT }), 10_000_000n, MAINNET_DEMO.stellar.native.assetContract))).toBe('mainnet_demo_unknown_call');
  });

  it('refuses dust from Stellar’s 7 decimals to Base’s 6, and a zero amount', () => {
    // 1.0000001 USDC: the SDK floors it to 1 USDC on delivery and leaves dust; the exact-equality rule refuses it.
    expect(bridgeRefusal(stellarDeposit(stellarToBase({ amount: 10_000_001n }), 10_000_001n))).toBe('mainnet_demo_unknown_call');
    expect(bridgeRefusal(stellarDeposit(stellarToBase({ amount: 9n }), 9n))).toBe('mainnet_demo_unknown_call');
    expect(bridgeRefusal(baseDeposit(baseToStellar({ amount: 0n }), 0n))).toBe('mainnet_demo_unknown_call');
  });

  it('refuses a recipient of the wrong form for the destination, or not the user’s own wallet', () => {
    const wrong: Hex[] = [
      // 20 bytes (an EVM address) where Stellar needs SCV_ADDRESS XDR.
      BASE_RECIPIENT,
      // 44 bytes without the `00000012` account prefix.
      `0x000000120000000100000000${'ab'.repeat(32)}`,
      `0x000000110000000000000000${'ab'.repeat(32)}`,
      // A 32-byte key alone.
      `0x${'ab'.repeat(32)}`,
      // Another account.
      recipientOf(OTHER),
    ];
    for (const recipient of wrong) expect(bridgeRefusal(baseDeposit(baseToStellar({ recipient }))), recipient).toBe('mainnet_demo_unknown_call');
    const wrongEvm: Hex[] = [STELLAR_RECIPIENT, `0x${'ab'.repeat(19)}`, `0x${'ab'.repeat(21)}`, FRIEND.toLowerCase() as Hex];
    for (const recipient of wrongEvm) expect(bridgeRefusal(stellarDeposit(stellarToBase({ recipient }))), recipient).toBe('mainnet_demo_unknown_call');
  });

  it('keeps the $9.99 cap: an over-cap bridge is refused as over the cap', () => {
    // At the fixed $1.05: $9.99 is 9.514285 USDC.
    expect(bridgeOk(baseDeposit(baseToStellar({ amount: 9_514_285n }), 9_514_285n)).usdMicros).toBe(9_990_000n);
    expect(bridgeRefusal(baseDeposit(baseToStellar({ amount: 9_514_286n }), 9_514_286n))).toBe('mainnet_demo_over_cap');
  });

  it('leaves a two-call swap and a plain deposit exactly as they were (no recipients needed, no bridge)', () => {
    const swap = evmTx({ to: ASSET_MANAGER, value: 0n, data: deposit(USDC_BASE as Hex, 2_000_000n, hubCalls({ hubAsset: BASE_HUB, approve: 2_000_000n, intentAmount: 1_990_000n })) });
    const r = ok(swap);
    expect(r.usdMicros).toBe(2_100_000n);
    expect(r.bridge).toBeUndefined();
    expect(ok(evmTx({ to: ASSET_MANAGER, value: 0n, data: deposit(USDC_BASE as Hex, 1_000_000n) })).bridge).toBeUndefined();
  });
});
