// Stellar test fixtures built with @stellar/stellar-base: a user, a few contracts, and builders for transactions and
// authorization entries with nested invocation trees.
import {
  Account,
  Address,
  Asset,
  Claimant,
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

// --- classic operations (CORE-1, D110) ---

/** A second key: the "attacker" signer in account-takeover fixtures. */
export const ATTACKER = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(13) as never).publicKey();
export const EURC = new Asset('EURC', ISSUER);
/** A claimable balance id in Horizon's hex form (type 0 ‖ hash). */
export const BALANCE_ID = `00000000${'ab'.repeat(32)}`;
export const POOL_ID = 'cd'.repeat(32);

/** setOptions adding ATTACKER as a signer (weight 255 by default): the one-click account takeover. */
export const addSignerOp = (weight = 255) => Operation.setOptions({ signer: { ed25519PublicKey: ATTACKER, weight } });
export const thresholdsOp = () => Operation.setOptions({ lowThreshold: 0, medThreshold: 2, highThreshold: 255 });
export const masterWeightOp = (w = 0) => Operation.setOptions({ masterWeight: w });
export const mergeOp = (destination = ATTACKER) => Operation.accountMerge({ destination });
export const homeDomainOp = () => Operation.setOptions({ homeDomain: 'example.com' });

/** One builder per classic operation type, none with an account-control effect. */
export const plainClassicOps: Readonly<Record<string, () => xdr.Operation>> = {
  pathPaymentStrictReceive: () =>
    Operation.pathPaymentStrictReceive({
      sendAsset: Asset.native(),
      sendMax: '5',
      destination: OTHER,
      destAsset: USDC,
      destAmount: '1',
      path: [EURC],
    }),
  pathPaymentStrictSend: () =>
    Operation.pathPaymentStrictSend({
      sendAsset: USDC,
      sendAmount: '2',
      destination: OTHER,
      destAsset: Asset.native(),
      destMin: '0.5',
      path: [],
    }),
  manageSellOffer: () =>
    Operation.manageSellOffer({ selling: USDC, buying: Asset.native(), amount: '3', price: '0.5', offerId: '7' }),
  manageBuyOffer: () =>
    Operation.manageBuyOffer({ selling: Asset.native(), buying: USDC, buyAmount: '4', price: '2', offerId: '0' }),
  createPassiveSellOffer: () => Operation.createPassiveSellOffer({ selling: USDC, buying: EURC, amount: '1', price: '1' }),
  setOptions: homeDomainOp,
  allowTrust: () => Operation.allowTrust({ trustor: OTHER, assetCode: 'USDC', authorize: 1 }),
  inflation: () => Operation.inflation({}),
  manageData: () => Operation.manageData({ name: 'config', value: Buffer.from([1, 2]) }),
  bumpSequence: () => Operation.bumpSequence({ bumpTo: '1000' }),
  createClaimableBalance: () =>
    Operation.createClaimableBalance({ asset: USDC, amount: '1', claimants: [new Claimant(OTHER)] }),
  claimClaimableBalance: () => Operation.claimClaimableBalance({ balanceId: BALANCE_ID }),
  beginSponsoringFutureReserves: () => Operation.beginSponsoringFutureReserves({ sponsoredId: OTHER }),
  endSponsoringFutureReserves: () => Operation.endSponsoringFutureReserves({}),
  revokeSponsorship: () => Operation.revokeAccountSponsorship({ account: OTHER }),
  clawback: () => Operation.clawback({ asset: USDC, from: OTHER, amount: '1' }),
  clawbackClaimableBalance: () => Operation.clawbackClaimableBalance({ balanceId: BALANCE_ID }),
  setTrustLineFlags: () =>
    Operation.setTrustLineFlags({ trustor: OTHER, asset: USDC, flags: { authorized: true, clawbackEnabled: false } }),
  liquidityPoolDeposit: () =>
    Operation.liquidityPoolDeposit({
      liquidityPoolId: POOL_ID,
      maxAmountA: '1',
      maxAmountB: '2',
      minPrice: '0.5',
      maxPrice: '2',
    }),
  liquidityPoolWithdraw: () =>
    Operation.liquidityPoolWithdraw({ liquidityPoolId: POOL_ID, amount: '1', minAmountA: '0.1', minAmountB: '0.2' }),
};

/** The account-control operations (stellarAccountControl non-empty), by description. */
export const accountControlOps: Readonly<Record<string, () => xdr.Operation>> = {
  'a new signer': () => addSignerOp(),
  'a signer removed': () => addSignerOp(0),
  'threshold changes': thresholdsOp,
  'a master-weight change': () => masterWeightOp(),
  'an account merge': () => mergeOp(),
};
