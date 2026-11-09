// The mainnet demo exception to D39 (docs/mainnet-demo-and-key-export-spec.md, D428, D429): a `pk_test_` app that Hana
// staff switched to `mainnet_demo` in a dev testnet env may sign on Base (8453) and Stellar's public network, one
// transaction at a time, only when Hana can value everything the transaction can move out and the total, fee
// included, is at most MAINNET_DEMO.txCapUsdMicros. The vault enforces it (vault/signing.ts) before any popup; the
// approval popup runs the same function on the bytes it decodes itself to show the value.
//
// Fail closed: a shape not listed here, an asset without a configured price, a contract not pinned here, or calldata
// that doesn't decode exactly as expected is refused. The decoders are the approval page's own (decode/), which
// accept only canonical encodings, so what is valued here is what the chain executes.
//
// SECURITY: the prices are a reviewed, deliberately high table (a higher price makes the cap stricter), valid until
// `validUntilMs`; after that every demo request is refused until someone reviews and rebuilds. Nothing here reads a
// key or the network.
import { type ApprovalSubject } from './approval.ts';
import { type AbiType, type AbiValue, decodeAbiParameters, decodeFunctionData, parseFunctionSignature } from './decode/abi.ts';
import { DecodeError } from './decode/errors.ts';
import type { DecodedEvmTx } from './decode/evm.ts';
import { type DecodedApproval, decodeApprovalRequest } from './decode/request.ts';
import type { StellarAuthEntry, StellarContractCall, StellarInvocation, StellarScVal, StellarTransaction } from './decode/stellar.ts';
import { from0xHex } from './bytes.ts';
import { MAINNET_DEMO_BALANCE_ENDPOINTS, MAINNET_DEMO_EVM_CHAINS, MAINNET_DEMO_TX_CAP_USD_MICROS, STELLAR_MAINNET_PASSPHRASE } from './networks.ts';

/** USD in millionths of a dollar. */
export type UsdMicros = bigint;

export interface DemoAsset {
  readonly symbol: string;
  readonly decimals: number;
  /** A deliberately high USD price per whole unit, in micros. */
  readonly priceUsdMicros: UsdMicros;
  /** The asset's Sodax hub asset on Sonic (what a Sodax deposit's hub calls must spend), when Sodax lists it. */
  readonly sodaxHubAsset?: string;
}

export interface DemoEvmChain {
  readonly chainId: number;
  readonly name: string;
  readonly native: DemoAsset;
  /** ERC-20 tokens by EIP-55 address. */
  readonly tokens: Readonly<Record<string, DemoAsset>>;
  /** Sodax's spoke asset manager (EIP-55). */
  readonly sodaxAssetManager: string;
  /** The public RPC the approval popup reads the balance from (never the partner's). */
  readonly balanceRpc: string;
}

export interface DemoStellar {
  readonly networkPassphrase: string;
  readonly native: DemoAsset & { readonly assetContract: string };
  /** Classic assets by `CODE:ISSUER`, each with its Stellar asset contract (C…). */
  readonly assets: Readonly<Record<string, DemoAsset & { readonly assetContract: string }>>;
  readonly sodaxAssetManager: string;
  /** Horizon, where the approval popup reads the balance. */
  readonly horizon: string;
}

/**
 * The reviewed config (2026-11-06; identifiers from Circle's USDC contract addresses page and @sodax/sdk 2.2.0's
 * packaged config, pinned by test/mainnet-demo.test.ts). Prices are above the market on purpose (D429, to confirm).
 */
export const MAINNET_DEMO = Object.freeze({
  reviewedAt: '2026-11-06',
  /** 45 days after the review: then every demo request is refused (`mainnet_demo_prices_stale`). */
  validUntilMs: Date.UTC(2026, 11, 21),
  /** At most $9.99 per transaction, fee included (the user: "limit funds to <$10"). */
  txCapUsdMicros: MAINNET_DEMO_TX_CAP_USD_MICROS,
  /** The approval popup warns when the wallet holds more than this (a warning, never a block). */
  balanceWarnUsdMicros: 10_000_000n,
  /** Sodax's intents contract on the hub (Sonic). */
  sodaxIntents: '0x6382D6ccD780758C5e8A6123c33ee8F4472F96ef',
  evm: Object.freeze({
    8453: Object.freeze({
      chainId: 8453,
      name: 'Base',
      native: Object.freeze({ symbol: 'ETH', decimals: 18, priceUsdMicros: 8_000_000_000n, sodaxHubAsset: '0x70178089842be7f8e4726b33f0d1569db8021faa' }),
      tokens: Object.freeze({
        '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913': Object.freeze({ symbol: 'USDC', decimals: 6, priceUsdMicros: 1_050_000n, sodaxHubAsset: '0x72E852545B024ddCbc5b70C1bCBDAA025164259C' }),
        '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42': Object.freeze({ symbol: 'EURC', decimals: 6, priceUsdMicros: 1_350_000n, sodaxHubAsset: '0x228615a4e0cb4cb1a8931605301661db2782adb8' }),
      }),
      sodaxAssetManager: '0x348BE44F63A458be9C1b13D6fD8e99048F297Bc3',
      balanceRpc: MAINNET_DEMO_BALANCE_ENDPOINTS.evm[8453] as string,
    }),
  }) as Readonly<Record<number, DemoEvmChain>>,
  stellar: Object.freeze({
    networkPassphrase: STELLAR_MAINNET_PASSPHRASE,
    native: Object.freeze({ symbol: 'XLM', decimals: 7, priceUsdMicros: 1_000_000n, assetContract: 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA', sodaxHubAsset: '0x8ac68af223907fb1b893086601a3d99e00f2fa9d' }),
    assets: Object.freeze({
      'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN': Object.freeze({
        symbol: 'USDC',
        decimals: 7,
        priceUsdMicros: 1_050_000n,
        assetContract: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
        sodaxHubAsset: '0x348007B53F25A9A857aB8eA81ec9E3CCBCf440f2',
      }),
      'EURC:GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2': Object.freeze({
        symbol: 'EURC',
        decimals: 7,
        priceUsdMicros: 1_350_000n,
        assetContract: 'CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV',
        sodaxHubAsset: '0x93d5d2382f302fa78350c18b4df3ee0bd09b3945',
      }),
    }),
    sodaxAssetManager: 'CCGF33A4CO6D3BXFEKPXVCFCZBK76I3AQOZK6KIKRPAWAZR3632WHCJ3',
    horizon: MAINNET_DEMO_BALANCE_ENDPOINTS.stellar,
  }) as DemoStellar,
});

export { MAINNET_DEMO_BALANCE_ORIGINS } from './networks.ts';

/** One thing a request can move out, valued. */
export interface DemoMovement {
  readonly what: 'fee' | 'send' | 'token' | 'approval' | 'deposit';
  readonly symbol: string;
  /** In the asset's smallest unit. */
  readonly amount: bigint;
  readonly usdMicros: UsdMicros;
}

export type DemoRefusalReason = 'mainnet_not_allowed' | 'mainnet_demo_unknown_call' | 'mainnet_demo_unpriced' | 'mainnet_demo_over_cap' | 'mainnet_demo_prices_stale';

export type DemoAssessment =
  | { readonly ok: true; readonly network: DemoNetwork; readonly usdMicros: UsdMicros; readonly capUsdMicros: UsdMicros; readonly movements: readonly DemoMovement[] }
  | { readonly ok: false; readonly reason: DemoRefusalReason; readonly message: string; readonly network: DemoNetwork | null; readonly usdMicros?: UsdMicros };

/**
 * What the vault tells the SDK about an app with the mainnet demo on (the `mainnetDemo` port event), so the page can
 * show it and its EVM provider lets exactly these chains through its early check. The vault stays the authority.
 */
export function mainnetDemoState(): { evmChains: number[]; stellarNetworkPassphrase: string; txCapUsdMicros: string; pricesReviewedAt: string; pricesValidUntilMs: number } {
  return {
    evmChains: Object.keys(MAINNET_DEMO.evm).map(Number),
    stellarNetworkPassphrase: MAINNET_DEMO.stellar.networkPassphrase,
    txCapUsdMicros: MAINNET_DEMO.txCapUsdMicros.toString(),
    pricesReviewedAt: MAINNET_DEMO.reviewedAt,
    pricesValidUntilMs: MAINNET_DEMO.validUntilMs,
  };
}

/** The demo network a request is for. */
export type DemoNetwork = { readonly chain: 'evm'; readonly chainId: number } | { readonly chain: 'stellar'; readonly network: 'pubnet' };

/** `ceil(amount × price / 10^decimals)`: an asset amount in USD micros, rounded up (never under). */
export function usdOf(amount: bigint, asset: Pick<DemoAsset, 'decimals' | 'priceUsdMicros'>): UsdMicros {
  if (amount <= 0n) return 0n;
  const scale = 10n ** BigInt(asset.decimals);
  return (amount * asset.priceUsdMicros + scale - 1n) / scale;
}

/** `$9.99`, `$12.40`, `$0.01` (rounded up to the cent; never shows less than it is). */
export function formatUsd(micros: UsdMicros): string {
  const cents = (micros + 9_999n) / 10_000n;
  return `$${(cents / 100n).toString()}.${(cents % 100n).toString().padStart(2, '0')}`;
}

export const MAINNET_DEMO_RULE = `Hana’s mainnet demo signs at most ${formatUsd(MAINNET_DEMO.txCapUsdMicros)} per transaction, on Base and Stellar only`;

class Refusal extends Error {
  constructor(
    readonly reason: Exclude<DemoRefusalReason, 'mainnet_demo_over_cap' | 'mainnet_demo_prices_stale' | 'mainnet_not_allowed'>,
    message: string,
  ) {
    super(message);
  }
}
const unknownCall = (why: string): never => {
  throw new Refusal('mainnet_demo_unknown_call', `Hana can’t tell how much this moves (${why}), so the mainnet demo won’t sign it`);
};
const unpriced = (what: string): never => {
  throw new Refusal('mainnet_demo_unpriced', `Hana has no price for ${what}, so the mainnet demo won’t sign it`);
};

const eq = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// ---- the Sodax hub calls a deposit may carry ----

const fn = (sig: string) => parseFunctionSignature(sig);
const ERC20_TRANSFER = fn('transfer(address,uint256)');
const ERC20_TRANSFER_FROM = fn('transferFrom(address,address,uint256)');
const ERC20_APPROVE = fn('approve(address,uint256)');
const SODAX_SPOKE_TRANSFER = fn('transfer(address,bytes,uint256,bytes)');
const SODAX_CREATE_INTENT = fn('createIntent((uint256,address,address,address,uint256,uint256,uint256,bool,uint256,uint256,bytes,bytes,address,bytes))');
const HUB_CALLS: readonly AbiType[] = fn('f((address,uint256,bytes)[])').params;

const uintOf = (v: AbiValue | undefined): bigint => (v && (v.kind === 'uint' || v.kind === 'int') ? v.value : unknownCall('a malformed argument'));
const addressOf = (v: AbiValue | undefined): string => (v && v.kind === 'address' ? v.value : unknownCall('a malformed argument'));
const bytesOf = (v: AbiValue | undefined): string => (v && v.kind === 'bytes' ? v.value : unknownCall('a malformed argument'));

function decodeOr(fnAbi: ReturnType<typeof fn>, data: Uint8Array, what: string): AbiValue[] {
  try {
    return decodeFunctionData(fnAbi, data);
  } catch {
    return unknownCall(what);
  }
}

/**
 * A Sodax deposit's `data` (relayed to the hub and run by the user's hub wallet): empty, or exactly
 * `[approve(intents, g) on hubAsset, createIntent(intent) on intents]` with g ≤ amount, the intent's input the hub
 * asset and its input amount ≤ g. So the hub calls can spend at most the deposited amount of the deposited asset.
 */
export function checkSodaxHubCalls(dataHex: string, hubAsset: string | undefined, amount: bigint): void {
  const data = from0xHex(dataHex.startsWith('0x') ? dataHex : `0x${dataHex}`);
  if (data.length === 0) return;
  if (!hubAsset) unknownCall('a Sodax deposit of an asset with no known hub asset');
  let calls: AbiValue[];
  try {
    calls = decodeAbiParameters(HUB_CALLS, data);
  } catch {
    return unknownCall('Sodax hub calls that don’t decode');
  }
  const list = calls[0];
  if (!list || list.kind !== 'array' || list.items.length !== 2) return unknownCall('Sodax hub calls of an unexpected shape');
  const [approveCall, intentCall] = list.items.map((c) => (c.kind === 'tuple' ? c.items : unknownCall('a malformed hub call')));
  if (!eq(addressOf(approveCall![0]), hubAsset as string) || uintOf(approveCall![1]) !== 0n) unknownCall('a hub call on another contract');
  const approveArgs = decodeOr(ERC20_APPROVE, from0xHex(bytesOf(approveCall![2])), 'a hub call other than approve');
  if (!eq(addressOf(approveArgs[0]), MAINNET_DEMO.sodaxIntents)) unknownCall('a hub approval to another spender');
  const gross = uintOf(approveArgs[1]);
  if (gross > amount) unknownCall('a hub approval above the deposit');
  if (!eq(addressOf(intentCall![0]), MAINNET_DEMO.sodaxIntents) || uintOf(intentCall![1]) !== 0n) unknownCall('a hub call on another contract');
  const intentArgs = decodeOr(SODAX_CREATE_INTENT, from0xHex(bytesOf(intentCall![2])), 'a hub call other than createIntent');
  const intent = intentArgs[0];
  if (!intent || intent.kind !== 'tuple') return unknownCall('a malformed intent');
  if (!eq(addressOf(intent.items[2]), hubAsset as string)) unknownCall('an intent spending another asset');
  if (uintOf(intent.items[4]) > gross) unknownCall('an intent above its approval');
}

// ---- EVM ----

function assessEvm(tx: DecodedEvmTx, chain: DemoEvmChain): DemoMovement[] {
  const out: DemoMovement[] = [];
  const native = chain.native;
  out.push({ what: 'fee', symbol: native.symbol, amount: tx.maxFeeWei, usdMicros: usdOf(tx.maxFeeWei, native) });
  if (tx.to === null) unknownCall('a contract creation');
  const data = from0xHex(tx.data);
  const to = tx.to as string;
  if (data.length === 0) {
    out.push({ what: 'send', symbol: native.symbol, amount: tx.value, usdMicros: usdOf(tx.value, native) });
    return out;
  }
  const selector = tx.selector;
  // Sodax's spoke asset manager: a deposit of native ETH (value == amount) or of a priced token.
  if (eq(to, chain.sodaxAssetManager)) {
    if (selector !== SODAX_SPOKE_TRANSFER.selector) unknownCall('a Sodax call other than a deposit');
    const [token, , amountV, hubData] = decodeOr(SODAX_SPOKE_TRANSFER, data, 'a Sodax deposit that doesn’t decode');
    const amount = uintOf(amountV);
    const tokenAddress = addressOf(token);
    if (eq(tokenAddress, ZERO_ADDRESS)) {
      if (tx.value !== amount) unknownCall('a native deposit whose value differs from its amount');
      checkSodaxHubCalls(bytesOf(hubData), native.sodaxHubAsset, amount);
      out.push({ what: 'deposit', symbol: native.symbol, amount, usdMicros: usdOf(amount, native) });
      return out;
    }
    const asset = tokenOf(chain, tokenAddress);
    checkSodaxHubCalls(bytesOf(hubData), asset.sodaxHubAsset, amount);
    out.push({ what: 'deposit', symbol: asset.symbol, amount, usdMicros: usdOf(amount, asset) });
    if (tx.value > 0n) out.push({ what: 'send', symbol: native.symbol, amount: tx.value, usdMicros: usdOf(tx.value, native) });
    return out;
  }
  // ERC-20 transfers and approvals of a priced token.
  const erc20 = [ERC20_TRANSFER, ERC20_TRANSFER_FROM, ERC20_APPROVE].find((f) => f.selector === selector);
  if (!erc20) return unknownCall('a contract call Hana can’t read');
  const asset = tokenOf(chain, to);
  const args = decodeOr(erc20, data, 'a token call that doesn’t decode');
  const amount = uintOf(args[args.length - 1]);
  out.push({ what: erc20 === ERC20_APPROVE ? 'approval' : 'token', symbol: asset.symbol, amount, usdMicros: usdOf(amount, asset) });
  if (tx.value > 0n) out.push({ what: 'send', symbol: native.symbol, amount: tx.value, usdMicros: usdOf(tx.value, native) });
  return out;
}

function tokenOf(chain: DemoEvmChain, address: string): DemoAsset {
  const hit = Object.entries(chain.tokens).find(([a]) => eq(a, address));
  return hit ? hit[1] : unpriced(`the token ${address}`);
}

// ---- Stellar ----

const STROOPS = (s: string): bigint => {
  if (!/^\d{1,20}$/u.test(s)) unknownCall('a malformed amount');
  return BigInt(s);
};

function stellarAsset(code: string): DemoAsset & { assetContract: string } {
  const s = MAINNET_DEMO.stellar;
  if (code === 'native') return s.native;
  return s.assets[code] ?? unpriced(`the asset ${code}`);
}

function stellarAssetByContract(contract: string): DemoAsset & { assetContract: string } {
  const s = MAINNET_DEMO.stellar;
  if (contract === s.native.assetContract) return s.native;
  // (Each classic asset's contract is pinned by test/mainnet-demo.test.ts against Asset.contractId on pubnet.)
  const hit = Object.values(s.assets).find((a) => a.assetContract === contract);
  return hit ?? unpriced(`the token contract ${contract}`);
}

const sameScVal = (a: StellarScVal, b: StellarScVal): boolean => JSON.stringify(a) === JSON.stringify(b);
const sameCall = (a: StellarContractCall, b: StellarContractCall): boolean =>
  a.contract === b.contract && a.function === b.function && a.args.length === b.args.length && a.args.every((x, i) => sameScVal(x, b.args[i]!));

const scAddress = (v: StellarScVal | undefined, kind: 'account' | 'contract'): string =>
  v && v.type === 'address' && v.addressType === kind ? v.address : unknownCall('a malformed contract argument');
const scAmount = (v: StellarScVal | undefined, type: 'u128' | 'i128'): bigint => {
  if (!v || v.type !== type || !/^\d{1,40}$/u.test(v.value)) return unknownCall('a malformed contract amount');
  return BigInt(v.value);
};
const scBytes = (v: StellarScVal | undefined): string => (v && v.type === 'bytes' ? v.hex : unknownCall('a malformed contract argument'));

/**
 * The Sodax Stellar deposit: `transfer(from, token, amount: u128, to: bytes, data: bytes)` on the asset manager, from the
 * signing account, of a priced token; every auth entry for exactly that call, with at most the token's own
 * `transfer(from, assetManager, amount: i128)` under it.
 */
function assessSodaxStellar(call: StellarContractCall, auth: readonly StellarAuthEntry[], signer: string): DemoMovement {
  const s = MAINNET_DEMO.stellar;
  if (call.function !== 'transfer' || call.args.length !== 5) unknownCall('a Sodax call other than a deposit');
  const from = scAddress(call.args[0], 'account');
  if (from !== signer) unknownCall('a Sodax deposit from another account');
  const token = stellarAssetByContract(scAddress(call.args[1], 'contract'));
  const amount = scAmount(call.args[2], 'u128');
  scBytes(call.args[3]);
  checkSodaxHubCalls(scBytes(call.args[4]), token.sodaxHubAsset, amount);
  if (auth.length === 0) unknownCall('a Sodax deposit without its authorization');
  for (const entry of auth) {
    if (entry.credentials.type === 'address' && entry.credentials.address !== signer) unknownCall('an authorization for another account');
    checkInvocation(entry.rootInvocation, call, token.assetContract, from, s.sodaxAssetManager, amount);
  }
  return { what: 'deposit', symbol: token.symbol, amount, usdMicros: usdOf(amount, token) };
}

function checkInvocation(root: StellarInvocation, call: StellarContractCall, tokenContract: string, from: string, assetManager: string, amount: bigint): void {
  const fnc = root.function;
  if (fnc.type !== 'contractFn' || !sameCall(fnc, call)) unknownCall('an authorization for another call');
  if (root.subInvocations.length > 1) unknownCall('an authorization for more calls');
  for (const sub of root.subInvocations) {
    const f = sub.function;
    if (f.type !== 'contractFn' || f.contract !== tokenContract || f.function !== 'transfer' || f.args.length !== 3 || sub.subInvocations.length !== 0) {
      unknownCall('an authorization for another call');
    }
    const c = f as StellarContractCall;
    if (scAddress(c.args[0], 'account') !== from || scAddress(c.args[1], 'contract') !== assetManager || scAmount(c.args[2], 'i128') !== amount) {
      unknownCall('a token authorization that differs from the deposit');
    }
  }
}

function assessStellar(tx: StellarTransaction, signer: string): DemoMovement[] {
  const s = MAINNET_DEMO.stellar;
  const out: DemoMovement[] = [];
  const fee = STROOPS(tx.fee);
  out.push({ what: 'fee', symbol: s.native.symbol, amount: fee, usdMicros: usdOf(fee, s.native) });
  for (const op of tx.operations) {
    switch (op.type) {
      case 'payment': {
        const a = stellarAsset(op.asset);
        const amount = STROOPS(op.amount);
        out.push({ what: 'send', symbol: a.symbol, amount, usdMicros: usdOf(amount, a) });
        break;
      }
      case 'createAccount': {
        const amount = STROOPS(op.startingBalance);
        out.push({ what: 'send', symbol: s.native.symbol, amount, usdMicros: usdOf(amount, s.native) });
        break;
      }
      case 'changeTrust':
        // Moves no funds (it reserves part of the account's own XLM); only for an asset Hana prices.
        stellarAsset(op.asset);
        break;
      case 'invokeHostFunction': {
        const hf = op.hostFunction;
        if (hf.type !== 'invokeContract' || hf.contract !== s.sodaxAssetManager) unknownCall('a Soroban call Hana can’t read');
        out.push(assessSodaxStellar(hf as StellarContractCall, op.auth, signer));
        break;
      }
      default:
        unknownCall(`a ${op.type} operation`);
    }
  }
  return out;
}

// ---- the entry point ----

/** The demo network a decoded request is for, or null when it names none of the demo's (another mainnet or none). */
export function demoNetworkOf(decoded: DecodedApproval): DemoNetwork | null {
  if (decoded.kind === 'evm_tx') return Object.hasOwn(MAINNET_DEMO.evm, decoded.chainId) ? { chain: 'evm', chainId: decoded.chainId } : null;
  if (decoded.kind === 'eip712') return decoded.chainId !== null && MAINNET_DEMO_EVM_CHAINS.includes(decoded.chainId) ? { chain: 'evm', chainId: decoded.chainId } : null;
  if (decoded.kind === 'stellar_tx' || decoded.kind === 'stellar_auth_entry') {
    return decoded.networkPassphrase === MAINNET_DEMO.stellar.networkPassphrase ? { chain: 'stellar', network: 'pubnet' } : null;
  }
  return null;
}

/**
 * Whether the mainnet demo may sign this mainnet request, and what it can move. `nowMs` is the server-corrected time
 * (the price table's validity). Never throws: anything that doesn't decode is refused.
 */
export function assessMainnetDemo(subject: ApprovalSubject, nowMs: number): DemoAssessment {
  let decoded: DecodedApproval;
  try {
    decoded = decodeApprovalRequest(subject);
  } catch (e) {
    return { ok: false, reason: 'mainnet_demo_unknown_call', network: null, message: `Hana can’t read this request (${e instanceof DecodeError ? e.message : 'malformed'})` };
  }
  const network = demoNetworkOf(decoded);
  if (!network) return { ok: false, reason: 'mainnet_not_allowed', network: null, message: MAINNET_DEMO_RULE };
  if (!(nowMs < MAINNET_DEMO.validUntilMs)) {
    return { ok: false, reason: 'mainnet_demo_prices_stale', network, message: `Hana’s mainnet demo prices were last reviewed on ${MAINNET_DEMO.reviewedAt} and have expired: nothing is signed until they are reviewed` };
  }
  let movements: DemoMovement[];
  try {
    if (decoded.kind === 'evm_tx') movements = assessEvm(decoded.tx, MAINNET_DEMO.evm[decoded.chainId] as DemoEvmChain);
    else if (decoded.kind === 'stellar_tx') {
      if (decoded.envelope.envelope === 'fee_bump') unknownCall('a fee-bump transaction');
      movements = assessStellar(decoded.envelope.tx, subject.address);
    } else if (decoded.kind === 'eip712') movements = unknownCall('typed data, which can authorize token moves');
    else movements = unknownCall('a Soroban authorization');
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, reason: e.reason, network, message: e.message };
    return { ok: false, reason: 'mainnet_demo_unknown_call', network, message: 'Hana can’t tell how much this moves, so the mainnet demo won’t sign it' };
  }
  const usdMicros = movements.reduce((sum, m) => sum + m.usdMicros, 0n);
  const cap = MAINNET_DEMO.txCapUsdMicros;
  if (usdMicros > cap) {
    return {
      ok: false,
      reason: 'mainnet_demo_over_cap',
      network,
      usdMicros,
      message: `Hana’s mainnet demo signs at most ${formatUsd(cap)} per transaction; this one can move about ${formatUsd(usdMicros)}`,
    };
  }
  return { ok: true, network, usdMicros, capUsdMicros: cap, movements };
}
