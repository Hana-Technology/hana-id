// Stellar test fixtures built with @stellar/stellar-base: a user, a few contracts, and builders for transactions and
// authorization entries with nested invocation trees.
import {
  Account,
  Address,
  Asset,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  hash,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-base';

export const PASSPHRASE: string = Networks.TESTNET;
export const user = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(7) as never);
export const other = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(9) as never);
export const USER = user.publicKey();
export const OTHER = other.publicKey();

const contractId = (n: number) => StrKey.encodeContract(Buffer.alloc(32, n));
export const POOL = contractId(1);
export const TOKEN = contractId(2);
export const ROUTER = contractId(3);
export const UNLISTED = contractId(4);

export const ISSUER = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(11) as never).publicKey();
export const USDC = new Asset('USDC', ISSUER);

export const addr = (a: string) => nativeToScVal(a, { type: 'address' });
export const i128 = (n: bigint) => nativeToScVal(n, { type: 'i128' });

export function invocation(
  contract: string,
  fn: string,
  args: xdr.ScVal[],
  subs: xdr.SorobanAuthorizedInvocation[] = [],
): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(contract).toScAddress(),
        functionName: fn,
        args,
      }),
    ),
    subInvocations: subs,
  });
}

export function sourceAuth(root: xdr.SorobanAuthorizedInvocation): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: root,
  });
}

export function addressAuth(address: string, root: xdr.SorobanAuthorizedInvocation): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(address).toScAddress(),
        nonce: xdr.Int64.fromString('42'),
        signatureExpirationLedger: 1000,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: root,
  });
}

export function sorobanData(
  readOnly: xdr.LedgerKey[] = [],
  readWrite: xdr.LedgerKey[] = [],
): xdr.SorobanTransactionData {
  return new xdr.SorobanTransactionData({
    ext: new xdr.SorobanTransactionDataExt(0),
    resources: new xdr.SorobanResources({
      footprint: new xdr.LedgerFootprint({ readOnly, readWrite }),
      instructions: 1000,
      diskReadBytes: 0,
      writeBytes: 0,
    }),
    resourceFee: xdr.Int64.fromString('5000'),
  });
}

export const contractDataKey = (contract: string) =>
  xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contract).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );

export const contractCodeKey = () =>
  xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: hash(Buffer.from('wasm')) }));

export const accountKey = (account: string) =>
  xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(account).xdrAccountId() }));

interface TxOptions {
  source?: string;
  fee?: string;
  memo?: 'text';
  soroban?: xdr.SorobanTransactionData;
}

/** A v1 envelope's XDR bytes with the given operations. */
export function txBytes(ops: xdr.Operation[], o: TxOptions = {}): Uint8Array {
  const builder = new TransactionBuilder(new Account(o.source ?? USER, '41'), {
    fee: o.fee ?? '100',
    networkPassphrase: PASSPHRASE,
  });
  for (const op of ops) builder.addOperation(op);
  if (o.soroban) builder.setSorobanData(o.soroban);
  builder.setTimebounds(10, 2000);
  return new Uint8Array(builder.build().toEnvelope().toXDR());
}

export function invokeOp(
  contract: string,
  fn: string,
  args: xdr.ScVal[],
  auth: xdr.SorobanAuthorizationEntry[] = [],
  source?: string,
): xdr.Operation {
  return Operation.invokeContractFunction({ contract, function: fn, args, auth, ...(source ? { source } : {}) });
}

export const changeTrustOp = (asset: Asset = USDC) => Operation.changeTrust({ asset });
export const paymentOp = () => Operation.payment({ destination: OTHER, asset: Asset.native(), amount: '1' });

/** A Soroban authorization preimage's XDR bytes. */
export function authPreimageBytes(root: xdr.SorobanAuthorizedInvocation, passphrase: string = PASSPHRASE): Uint8Array {
  const pre = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: hash(Buffer.from(passphrase)),
      nonce: xdr.Int64.fromString('99'),
      signatureExpirationLedger: 12345,
      invocation: root,
    }),
  );
  return new Uint8Array(pre.toXDR());
}

/** A fee-bump envelope around a v1 transaction. */
export function feeBumpBytes(inner: Uint8Array, feeSource = USER): Uint8Array {
  const tx = TransactionBuilder.fromXDR(Buffer.from(inner).toString('base64'), PASSPHRASE);
  const fb = TransactionBuilder.buildFeeBumpTransaction(feeSource, '1000', tx as never, PASSPHRASE);
  return new Uint8Array(fb.toEnvelope().toXDR());
}
