// Request builders for the signing tests: Stellar envelopes (with @stellar/stellar-base, as partners build them),
// EVM calldata, typed data, and signature checks against the vault's addresses.
import { Account, Address, Asset, Keypair, Networks, Operation, StrKey, TransactionBuilder, hash, nativeToScVal, xdr } from '@stellar/stellar-base';
import { base64Decode, eip191Hash, evmTxSigningHash, from0xHex, hashTypedData, normalizeTypedData, parseEvmTxRequest, recoverEvmAddress, toHex } from '@hana-id/core';
import { decodeRlp, functionSelector } from '@hana-id/core/decode';
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
/** @sodax/sdk 2.2.0's hub calls for 1 USDC Base → Stellar (its static encoders, offline; D475), to the account below. */
const SDK_BRIDGE_CALLS = '0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000001600000000000000000000000000000000000000000000000000000000000000240000000000000000000000000000000000000000000000000000000000000032000000000000000000000000072e852545b024ddcbc5b70c1bcbdaa025164259c000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000044095ea7b3000000000000000000000000abbb91c0617090f0028bdc27597cd0d038f3a83300000000000000000000000000000000000000000000000000000000000f424000000000000000000000000000000000000000000000000000000000000000000000000000000000abbb91c0617090f0028bdc27597cd0d038f3a83300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000004447e7ef2400000000000000000000000072e852545b024ddcbc5b70c1bcbdaa025164259c00000000000000000000000000000000000000000000000000000000000f424000000000000000000000000000000000000000000000000000000000000000000000000000000000abbb91c0617090f0028bdc27597cd0d038f3a833000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000044f3fef3a3000000000000000000000000348007b53f25a9a857ab8ea81ec9e3ccbcf440f20000000000000000000000000000000000000000000000000de0b6b3a76400000000000000000000000000000000000000000000000000000000000000000000000000000000000060c5681bd1db4e50735c4ca3386005a4ba4937c0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000104c6b4180b000000000000000000000000348007b53f25a9a857ab8ea81ec9e3ccbcf440f20000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000098968000000000000000000000000000000000000000000000000000000000000000e0000000000000000000000000000000000000000000000000000000000000002c000000120000000000000000ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';
const SDK_BRIDGE_RECIPIENT = 'GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57';

const abiWord = (n: bigint): string => n.toString(16).padStart(64, '0');
const abiBytes = (hex: string): string => abiWord(BigInt(hex.length / 2)) + hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');

/** A Sodax USDC deposit on Base carrying the SDK's bridge calls, delivering 1 USDC to the Stellar account `recipient`. */
export function sodaxBridgeDeposit(recipient: string): string {
  const key = Buffer.from(StrKey.decodeEd25519PublicKey(recipient)).toString('hex');
  const calls = SDK_BRIDGE_CALLS.slice(2).replace(Buffer.from(StrKey.decodeEd25519PublicKey(SDK_BRIDGE_RECIPIENT)).toString('hex'), key);
  const hubWallet = '11'.repeat(20);
  return `${functionSelector('transfer(address,bytes,uint256,bytes)')}${USDC_ON_BASE.padStart(64, '0')}${abiWord(0x80n)}${abiWord(1_000_000n)}${abiWord(0xc0n)}${abiBytes(hubWallet)}${abiBytes(calls)}`;
}

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
