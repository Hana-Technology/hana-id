// Request builders for the signing tests: Stellar envelopes (with @stellar/stellar-base, as partners build them),
// EVM calldata, typed data, and signature checks against the vault's addresses.
import { Account, Address, Asset, Keypair, Networks, Operation, StrKey, TransactionBuilder, hash, nativeToScVal, xdr } from '@stellar/stellar-base';
import { base64Decode, eip191Hash, evmTxSigningHash, from0xHex, hashTypedData, normalizeTypedData, parseEvmTxRequest, recoverEvmAddress, toHex } from '@hana-id/core';
import { decodeRlp, functionSelector } from '@hana-id/core/decode';
import { sodaxHubWalletOf } from '@hana-id/core/mainnet-demo';
import { sep53MessageHash, verifyStellarSignature } from '@hana-id/core/signers/stellar';

export const PASSPHRASE: string = Networks.TESTNET;
export const POOL = StrKey.encodeContract(Buffer.alloc(32, 1));
export const UNLISTED = StrKey.encodeContract(Buffer.alloc(32, 4));
export const OTHER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9)).publicKey();
export const ISSUER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 11)).publicKey();
export const USDC = new Asset('USDC', ISSUER);

export const addr = (a: string) => nativeToScVal(a, { type: 'address' });
export const i128 = (n: bigint) => nativeToScVal(n, { type: 'i128' });

export function stellarTx(source: string, ops: xdr.Operation[], fee = '100'): string {
  const b = new TransactionBuilder(new Account(source, '41'), { fee, networkPassphrase: PASSPHRASE });
  for (const op of ops) b.addOperation(op);
  b.setTimebounds(10, 2000);
  return b.build().toEnvelope().toXDR('base64');
}

export const invoke = (contract: string, fn: string, args: xdr.ScVal[]) => Operation.invokeContractFunction({ contract, function: fn, args, auth: [] });
export const payment = () => Operation.payment({ destination: OTHER, asset: Asset.native(), amount: '1' });
export const changeTrust = (asset: Asset = USDC) => Operation.changeTrust({ asset });

export function feeBump(innerXdr: string, feeSource: string): string {
  const tx = TransactionBuilder.fromXDR(innerXdr, PASSPHRASE);
  return TransactionBuilder.buildFeeBumpTransaction(feeSource, '1000', tx as never, PASSPHRASE).toEnvelope().toXDR('base64');
}

/** A Soroban authorized contract call, with the calls it authorizes in turn (any depth). */
export const authCall = (contract: string, fn: string, args: xdr.ScVal[], subInvocations: xdr.SorobanAuthorizedInvocation[] = []): xdr.SorobanAuthorizedInvocation =>
  new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({ contractAddress: new Address(contract).toScAddress(), functionName: fn, args })),
    subInvocations,
  });

/** An invokeContractFunction whose auth tree is `root` (source-account credentials). */
export const invokeWithAuth = (contract: string, fn: string, args: xdr.ScVal[], root: xdr.SorobanAuthorizedInvocation) =>
  Operation.invokeContractFunction({ contract, function: fn, args, auth: [new xdr.SorobanAuthorizationEntry({ credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(), rootInvocation: root })] });

export function authPreimage(contract: string, fn: string, args: xdr.ScVal[], subInvocations: xdr.SorobanAuthorizedInvocation[] = []): string {
  return authPreimageOf(authCall(contract, fn, args, subInvocations));
}

export function authPreimageOf(invocation: xdr.SorobanAuthorizedInvocation): string {
  return xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({ networkId: hash(Buffer.from(PASSPHRASE)), nonce: xdr.Int64.fromString('99'), signatureExpirationLedger: 12345, invocation }),
  ).toXDR('base64');
}

/** True if `signedTxXdr` carries a valid signature by `address` over the transaction's hash. */
export function stellarTxSignedBy(signedTxXdr: string, address: string): boolean {
  const tx = TransactionBuilder.fromXDR(signedTxXdr, PASSPHRASE);
  const sigs = tx.signatures;
  return sigs.length > 0 && sigs.some((s) => verifyStellarSignature(address, tx.hash(), new Uint8Array(s.signature())));
}

export const stellarMessageSignedBy = (message: string, signedMessage: string, address: string): boolean =>
  verifyStellarSignature(address, sep53MessageHash(message), base64Decode(signedMessage));

export const stellarAuthSignedBy = (preimageXdr: string, signedAuthEntry: string, address: string): boolean =>
  verifyStellarSignature(address, new Uint8Array(hash(Buffer.from(preimageXdr, 'base64'))), base64Decode(signedAuthEntry));

// ---- EVM ----

export const EVM_VAULT = '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD';
export const EVM_FRIEND = '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB';
export const CHAIN = 84532;

const word = (hex: string) => hex.replace(/^0x/u, '').toLowerCase().padStart(64, '0');
export const deposit = (amount: bigint) => `${functionSelector('deposit(uint256)')}${word(amount.toString(16))}`;
export const withdraw = (to: string, amount: bigint) => `${functionSelector('withdraw(address,uint256)')}${word(to)}${word(amount.toString(16))}`;

/** A contract creation: no `to`. */
export function evmCreation(): Record<string, string> {
  const { to: _, ...rest } = evmTx({ data: '0x6080' });
  return rest;
}

export function evmTx(over: Record<string, string> = {}): Record<string, string> {
  return { chainId: `0x${CHAIN.toString(16)}`, nonce: '0x1', gas: '0x186a0', maxFeePerGas: '0x1', maxPriorityFeePerGas: '0x1', to: EVM_VAULT, value: '0x0', data: deposit(5n), ...over };
}

/** Sodax's spoke asset manager on Base (pinned by packages/core/test/mainnet-demo.test.ts). */
export const SODAX_ASSET_MANAGER_BASE = '0x348BE44F63A458be9C1b13D6fD8e99048F297Bc3';
const USDC_ON_BASE = '833589fcd6edb6e08f4c7c32d4f71b54bda02913';
/** @sodax/sdk 2.2.0's hub calls for 1 USDC Base → Stellar (its static encoders, offline; D476), to the account below. */
const SDK_BRIDGE_CALLS = '0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000001600000000000000000000000000000000000000000000000000000000000000240000000000000000000000000000000000000000000000000000000000000032000000000000000000000000072e852545b024ddcbc5b70c1bcbdaa025164259c000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000044095ea7b3000000000000000000000000abbb91c0617090f0028bdc27597cd0d038f3a83300000000000000000000000000000000000000000000000000000000000f424000000000000000000000000000000000000000000000000000000000000000000000000000000000abbb91c0617090f0028bdc27597cd0d038f3a83300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000004447e7ef2400000000000000000000000072e852545b024ddcbc5b70c1bcbdaa025164259c00000000000000000000000000000000000000000000000000000000000f424000000000000000000000000000000000000000000000000000000000000000000000000000000000abbb91c0617090f0028bdc27597cd0d038f3a833000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000044f3fef3a3000000000000000000000000348007b53f25a9a857ab8ea81ec9e3ccbcf440f20000000000000000000000000000000000000000000000000de0b6b3a76400000000000000000000000000000000000000000000000000000000000000000000000000000000000060c5681bd1db4e50735c4ca3386005a4ba4937c0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000104c6b4180b000000000000000000000000348007b53f25a9a857ab8ea81ec9e3ccbcf440f20000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000098968000000000000000000000000000000000000000000000000000000000000000e0000000000000000000000000000000000000000000000000000000000000002c000000120000000000000000ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';
const SDK_BRIDGE_RECIPIENT = 'GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57';

const abiWord = (n: bigint): string => n.toString(16).padStart(64, '0');
const abiBytes = (hex: string): string => abiWord(BigInt(hex.length / 2)) + hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');

/**
 * A Sodax USDC deposit on Base carrying the SDK's bridge calls, delivering 1 USDC to the Stellar account `recipient`,
 * from `signer`'s own hub wallet unless `hubWallet` (20 bytes) names another (D476).
 */
export function sodaxBridgeDeposit(recipient: string, signer: string, hubWallet?: string): string {
  const key = Buffer.from(StrKey.decodeEd25519PublicKey(recipient)).toString('hex');
  const calls = SDK_BRIDGE_CALLS.slice(2).replace(Buffer.from(StrKey.decodeEd25519PublicKey(SDK_BRIDGE_RECIPIENT)).toString('hex'), key);
  const to = (hubWallet ?? sodaxHubWalletOf('evm', signer)).slice(2).toLowerCase();
  return `${functionSelector('transfer(address,bytes,uint256,bytes)')}${USDC_ON_BASE.padStart(64, '0')}${abiWord(0x80n)}${abiWord(1_000_000n)}${abiWord(0xc0n)}${abiBytes(to)}${abiBytes(calls)}`;
}

/** @sodax/sdk 2.2.0's hub calls for a swap of 1 USDC Base → Stellar (constructCreateIntentData, offline; D492), for the addresses below. */
const SDK_SWAP_CALLS = '0x000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000012000000000000000000000000072e852545b024ddcbc5b70c1bcbdaa025164259c000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000044095ea7b30000000000000000000000006382d6ccd780758c5e8a6123c33ee8f4472f96ef00000000000000000000000000000000000000000000000000000000000f4240000000000000000000000000000000000000000000000000000000000000000000000000000000006382d6ccd780758c5e8a6123c33ee8f4472f96ef0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000002a4016f02e300000000000000000000000000000000000000000000000000000000000000205e7fefbf0064ee5b02d3e12a295e5ea969a891cf9e9427fc1520d4312e9de767000000000000000000000000f05e4fb1a3917a7fd722749047c2f6795fa1368b00000000000000000000000072e852545b024ddcbc5b70c1bcbdaa025164259c000000000000000000000000348007b53f25a9a857ab8ea81ec9e3ccbcf440f200000000000000000000000000000000000000000000000000000000000f424000000000000000000000000000000000000000000000000000000000000dbba000000000000000000000000000000000000000000000000000000000713fb3000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001e000000000000000000000000000000000000000000000000000000000000001b00000000000000000000000000000000000000000000000000000000000001c00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002600000000000000000000000000000000000000000000000000000000000000014cd2a3d9f938e13cd947ec05abc7fe734df8dd826000000000000000000000000000000000000000000000000000000000000000000000000000000000000002c000000120000000000000000ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';

/** The same for a swap of 1 USDC Stellar → Base, from the Stellar account of the fixtures to the EVM address above. */
const SDK_SWAP_FROM_STELLAR_CALLS = '0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000120000000000000000000000000348007b53f25a9a857ab8ea81ec9e3ccbcf440f2000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000044095ea7b30000000000000000000000006382d6ccd780758c5e8a6123c33ee8f4472f96ef0000000000000000000000000000000000000000000000000000000000989680000000000000000000000000000000000000000000000000000000000000000000000000000000006382d6ccd780758c5e8a6123c33ee8f4472f96ef0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000002a4016f02e300000000000000000000000000000000000000000000000000000000000000205a8a6ca9e7f7ccbb537be0411c95cfdebcf64ca5edd68f5bcd441b8fbb6e04f300000000000000000000000000504aac4aff32f24e4dd77b6b81d6af2d936b6e000000000000000000000000348007b53f25a9a857ab8ea81ec9e3ccbcf440f200000000000000000000000072e852545b024ddcbc5b70c1bcbdaa025164259c000000000000000000000000000000000000000000000000000000000098968000000000000000000000000000000000000000000000000000000000000dbba000000000000000000000000000000000000000000000000000000000713fb3000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001b000000000000000000000000000000000000000000000000000000000000001e00000000000000000000000000000000000000000000000000000000000001c0000000000000000000000000000000000000000000000000000000000000022000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000260000000000000000000000000000000000000000000000000000000000000002c000000120000000000000000ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000014cd2a3d9f938e13cd947ec05abc7fe734df8dd826000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';

const SDK_SWAP_SIGNER = 'cd2a3d9f938e13cd947ec05abc7fe734df8dd826';
const SDK_SWAP_HUB_WALLET = 'f05e4fb1a3917a7fd722749047c2f6795fa1368b';
const SDK_SWAP_STELLAR_USDC_HUB = '348007b53f25a9a857ab8ea81ec9e3ccbcf440f2';
const SDK_SWAP_BASE_USDC_HUB = '72e852545b024ddcbc5b70c1bcbdaa025164259c';
const SDK_SWAP_MIN_OUTPUT = (900_000n).toString(16).padStart(64, '0');
const SDK_SWAP_DEADLINE = (1_900_000_000n).toString(16).padStart(64, '0');
/** Ten minutes after the time the demo's vault and popup tests run at. */
const SWAP_DEADLINE = BigInt(Date.UTC(2026, 10, 10) / 1000 + 600);

const sodaxUsdcDeposit = (calls: string, signer: string, hubWallet?: string): string => {
  const to = (hubWallet ?? sodaxHubWalletOf('evm', signer)).slice(2).toLowerCase();
  return `${functionSelector('transfer(address,bytes,uint256,bytes)')}${USDC_ON_BASE.padStart(64, '0')}${abiWord(0x80n)}${abiWord(1_000_000n)}${abiWord(0xc0n)}${abiBytes(to)}${abiBytes(calls)}`;
};

/**
 * A Sodax USDC swap on Base with the SDK's hub calls, retargeted at `signer` and delivering to the Stellar account
 * `recipient` (D492). `to` replaces the spoke `to`, `creator` the intent's creator (each 20 bytes, for refusals);
 * `outputToken` (a hub asset), `minOutput` and `deadline` replace the intent's.
 */
export function sodaxSwapDeposit(recipient: string, signer: string, over: { to?: string; creator?: string; outputToken?: string; minOutput?: bigint; deadline?: bigint } = {}): string {
  const key = Buffer.from(StrKey.decodeEd25519PublicKey(recipient)).toString('hex');
  const sdkKey = Buffer.from(StrKey.decodeEd25519PublicKey(SDK_BRIDGE_RECIPIENT)).toString('hex');
  const own = sodaxHubWalletOf('evm', signer).slice(2).toLowerCase();
  for (const part of [sdkKey, SDK_SWAP_SIGNER, SDK_SWAP_HUB_WALLET, SDK_SWAP_STELLAR_USDC_HUB, SDK_SWAP_MIN_OUTPUT, SDK_SWAP_DEADLINE]) if (!SDK_SWAP_CALLS.includes(part)) throw new Error('the swap fixture changed');
  const calls = SDK_SWAP_CALLS.slice(2)
    .replace(sdkKey, key)
    .replace(SDK_SWAP_SIGNER, signer.slice(2).toLowerCase())
    .replace(SDK_SWAP_HUB_WALLET, (over.creator ?? `0x${own}`).slice(2).toLowerCase())
    .replace(SDK_SWAP_STELLAR_USDC_HUB, (over.outputToken ?? `0x${SDK_SWAP_STELLAR_USDC_HUB}`).slice(2).toLowerCase())
    .replace(SDK_SWAP_MIN_OUTPUT, abiWord(over.minOutput ?? 900_000n))
    .replace(SDK_SWAP_DEADLINE, abiWord(over.deadline ?? SWAP_DEADLINE));
  return sodaxUsdcDeposit(calls, signer, over.to);
}

/** The SDK's hub calls for a swap of 1 USDC Stellar → Base, with the intent's `outputToken` and `minOutput` replaced. */
export function sodaxStellarSwapCalls(over: { outputToken?: string; minOutput?: bigint } = {}): string {
  for (const part of [SDK_SWAP_BASE_USDC_HUB, SDK_SWAP_MIN_OUTPUT, SDK_SWAP_DEADLINE]) if (!SDK_SWAP_FROM_STELLAR_CALLS.includes(part)) throw new Error('the swap fixture changed');
  return SDK_SWAP_FROM_STELLAR_CALLS.replace(SDK_SWAP_BASE_USDC_HUB, (over.outputToken ?? `0x${SDK_SWAP_BASE_USDC_HUB}`).slice(2).toLowerCase())
    .replace(SDK_SWAP_MIN_OUTPUT, abiWord(over.minOutput ?? 900_000n))
    .replace(SDK_SWAP_DEADLINE, abiWord(SWAP_DEADLINE));
}

/** A Sodax USDC deposit on Base with no hub calls, from `signer`'s own hub wallet unless `hubWallet` names another (D492). */
export const sodaxEmptyDeposit = (signer: string, hubWallet?: string): string => sodaxUsdcDeposit('', signer, hubWallet);

/** The address that signed a raw EIP-1559 transaction. */
export function evmTxSigner(raw: string, request: Record<string, string>): string {
  const bytes = from0xHex(raw);
  if (bytes[0] !== 2) throw new Error('not EIP-1559');
  const fields = decodeRlp(bytes.subarray(1)) as Uint8Array[];
  const pad = (b: Uint8Array) => {
    const out = new Uint8Array(32);
    out.set(b, 32 - b.length);
    return out;
  };
  const yParity = fields[9]!.length === 0 ? 0 : fields[9]![0]!;
  const sig = new Uint8Array([...pad(fields[10]!), ...pad(fields[11]!), 27 + yParity]);
  return recoverEvmAddress(evmTxSigningHash(parseEvmTxRequest(request)), sig);
}

export const personalSigner = (messageHex: string, sig: string): string => recoverEvmAddress(eip191Hash(from0xHex(messageHex)), from0xHex(sig));

export const typedSigner = (json: string, sig: string): string => recoverEvmAddress(hashTypedData(normalizeTypedData(json)), from0xHex(sig));

export const typedData = (verifyingContract: string, primaryType: string, message: Record<string, unknown>, types: { name: string; type: string }[], chainId: number = CHAIN) =>
  JSON.stringify({
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      [primaryType]: types,
    },
    primaryType,
    domain: { name: 'Example', chainId, verifyingContract },
    message,
  });

export const hex = toHex;
