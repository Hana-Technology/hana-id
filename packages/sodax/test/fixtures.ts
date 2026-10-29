// Stellar transactions as @sodax/sdk 2.1.0's StellarSpokeService builds them (deposit = AssetManager `transfer`,
// `restoreFootprint`, `changeTrust`), plus signing and signature checks, with @stellar/stellar-base.
import {
  Account,
  Address,
  Asset,
  Contract,
  FeeBumpTransaction,
  Keypair,
  Operation,
  SorobanDataBuilder,
  StrKey,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-base';
import { verifyStellarSignature } from '@hana-id/core/signers/stellar';

export const ASSET_MANAGER = StrKey.encodeContract(Buffer.alloc(32, 1));
export const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 2));
export const ISSUER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 11)).publicKey();
export const FEE_PAYER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 12)).publicKey();
/** The user's hub wallet on Sonic and the intent payload: opaque bytes to the vault. */
const HUB_WALLET = Buffer.alloc(20, 0x33);
const INTENT_DATA = Buffer.alloc(96, 0x44);

/** AssetManager.transfer(from, token, amount: u128, to: Bytes, data: Bytes): a Sodax swap's deposit. */
export const depositCall = (from: string, amount = 1_000_000n): xdr.Operation =>
  new Contract(ASSET_MANAGER).call(
    'transfer',
    nativeToScVal(Address.fromString(from), { type: 'address' }),
    nativeToScVal(Address.fromString(TOKEN), { type: 'address' }),
    nativeToScVal(amount, { type: 'u128' }),
    nativeToScVal(HUB_WALLET, { type: 'bytes' }),
    nativeToScVal(INTENT_DATA, { type: 'bytes' }),
  );

/** One transaction from `source` at sequence `seq` (the next one is seq + 1), as the SDK builds them. */
export function tx(source: string, seq: bigint, ops: xdr.Operation[], passphrase: string, o: { fee?: string; sorobanData?: xdr.SorobanTransactionData } = {}): Transaction {
  const b = new TransactionBuilder(new Account(source, seq.toString()), { fee: o.fee ?? '100', networkPassphrase: passphrase });
  for (const op of ops) b.addOperation(op);
  if (o.sorobanData) b.setSorobanData(o.sorobanData);
  return b.setTimeout(180).build();
}

/** The restore the SDK sends when simulation says the footprint is archived. */
export function restoreTx(source: string, seq: bigint, passphrase: string): Transaction {
  const data = new SorobanDataBuilder().setReadWrite([xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: Buffer.alloc(32, 5) }))]).build();
  return tx(source, seq, [Operation.restoreFootprint({})], passphrase, { fee: '20000', sorobanData: data });
}

export const changeTrustOp = (): xdr.Operation => Operation.changeTrust({ asset: new Asset('USDC', ISSUER) });

export function feeBumpOf(inner: Transaction, passphrase: string): FeeBumpTransaction {
  return TransactionBuilder.buildFeeBumpTransaction(FEE_PAYER, '1000', inner, passphrase);
}

/** `envelopeXdr` signed by `key` (the scripted vault's signature). */
export function signWith(key: Keypair, envelopeXdr: string, passphrase: string): string {
  const t = TransactionBuilder.fromXDR(envelopeXdr, passphrase);
  t.sign(key);
  return t.toEnvelope().toXDR('base64');
}

/** True if `signedXdr` carries a valid signature by `address` over its transaction hash on `passphrase`. */
export function signedBy(signedXdr: string, address: string, passphrase: string): boolean {
  const t = TransactionBuilder.fromXDR(signedXdr, passphrase);
  return t.signatures.some((s) => verifyStellarSignature(address, t.hash(), new Uint8Array(s.signature())));
}

/** The envelope's transaction hash (hex). */
export const txHash = (envelopeXdr: string, passphrase: string): string => TransactionBuilder.fromXDR(envelopeXdr, passphrase).hash().toString('hex');

/** A Horizon transaction resource for `hash` (the fields Sodax's StellarRawTransactionReceipt names). */
export function horizonTx(hash: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const href = (p: string) => ({ href: `https://horizon.test/${p}` });
  return {
    _links: {
      self: href(`transactions/${hash}`),
      account: href('accounts/G'),
      ledger: href('ledgers/1'),
      operations: href(`transactions/${hash}/operations`),
      effects: href(`transactions/${hash}/effects`),
      precedes: href('transactions?order=asc'),
      succeeds: href('transactions?order=desc'),
      transaction: href(`transactions/${hash}`),
    },
    id: hash,
    paging_token: '1',
    successful: true,
    hash,
    ledger: 1,
    created_at: '2026-10-28T00:00:00Z',
    source_account: 'G',
    source_account_sequence: '42',
    fee_account: 'G',
    fee_charged: '100',
    max_fee: '100',
    operation_count: 1,
    envelope_xdr: 'AAAA',
    result_xdr: 'AAAA',
    result_meta_xdr: 'AAAA',
    fee_meta_xdr: 'AAAA',
    signatures: [],
    ...over,
  };
}
