// Partner label documents and requests for the partner-labels tests (D892): the stamps' `collect` and the guestbook's
// `add_message` written as PARTNER labels (as if a partner had declared them; they are not Journear's reviewed entries,
// D885), a Soroban deposit, and a classic Stellar payment with an address book. Test accounts and hashes only.
import { Account, Asset, Memo, Operation, TransactionBuilder, type xdr } from '@stellar/stellar-base';
import { base58 } from '@scure/base';
import { ed25519 } from '@noble/curves/ed25519';
import { type LabelDocument, parseLabelDocument } from '../src/partner-labels/schema.ts';
import { REVIEWED_NEAR_DEPLOYS } from '../src/reviewed-near-calls.ts';
import { sha256, utf8 } from '../src/bytes.ts';
import { nearImplicitAccountId } from '../src/addresses.ts';
import type { NearAction } from '../src/near/codec.ts';
import { encodeNearDelegateAction, encodeNearTransaction } from '../src/near/codec.ts';
import { decodeApprovalRequest } from '../src/decode/request.ts';
import { ISSUER, OTHER, PASSPHRASE, POOL, USER, UNLISTED } from './stellar-fixtures.ts';

/** A TEST seed from a public label (never funded). */
const SEED = sha256(utf8('hana-id test: partner labels user'));
export const NEAR_PUB = Uint8Array.from(ed25519.getPublicKey(SEED));
export const ME = nearImplicitAccountId(NEAR_PUB);
export const NEAR_KEY = { type: 'ed25519' as const, bytes: NEAR_PUB };
export const STAMPS = 'stamps-partner.testnet';
export const BOOK = 'guestbook-partner.testnet';
/** The stamps contract's recorded code hash (D885): a partner would declare the hash of the code it deployed. */
export const STAMPS_HASH = REVIEWED_NEAR_DEPLOYS['sandbox-dev']!.stamps!.codeHash;
export const BOOK_HASH = REVIEWED_NEAR_DEPLOYS['sandbox-dev']!.guestbook!.codeHash;
export const OTHER_HASH = base58.encode(sha256(utf8('some other wasm')));
export const TGAS = 1_000_000_000_000n;

/** Stellar's testnet USDC asset contract (on Journear's known-token list) and a Soroban contract's Wasm hash. */
export const TEST_USDC_SAC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
export const POOL_WASM = 'ab'.repeat(32);
export { ISSUER, OTHER, PASSPHRASE, POOL, USER, UNLISTED };

export const STAMPS_DOC_JSON = {
  schema: 'journear-labels/1',
  context: { near: { network: 'testnet', account: STAMPS, codeHash: STAMPS_HASH } },
  metadata: { enums: { stamp: { arrival: 'Arrival', sponsored: 'Fare paid', layover: 'Layover', postcard: 'Postcard', own_fare: 'Own fare' } } },
  display: {
    formats: {
      collect: {
        call: { gasAtMost: '30000000000000', args: { stamp: { type: 'string' }, note: { type: 'string', maxLength: 140, optional: true } }, otherArgs: 'refuse' },
        intent: { verb: 'collect', object: 'the stamp' },
        sentence: ['verb', 'object', { field: 'args.stamp' }],
        fields: [{ path: 'args.stamp', label: 'Stamp', format: 'enum', params: { enum: 'stamp' } }],
      },
    },
  },
};

export const GUESTBOOK_DOC_JSON = {
  schema: 'journear-labels/1',
  context: { near: { network: 'testnet', account: BOOK, codeHash: BOOK_HASH } },
  display: {
    formats: {
      add_message: {
        call: { gasAtMost: '30000000000000', args: { text: { type: 'string', maxLength: 200 } } },
        intent: { verb: 'add', object: 'a message to the guestbook' },
        sentence: ['verb', 'object'],
        fields: [],
      },
    },
  },
};

export const SOROBAN_DOC_JSON = {
  schema: 'journear-labels/1',
  context: { soroban: { networkPassphrase: PASSPHRASE, contract: POOL, wasmHash: POOL_WASM } },
  metadata: { addressBook: [{ account: OTHER, name: 'Club treasury' }] },
  display: {
    formats: {
      deposit: {
        call: { args: [{ name: 'from', type: 'address', isSelf: true }, { name: 'amount', type: 'i128', atLeast: '1', atMost: '1000000000000' }], otherArgs: 'refuse', feeAtMost: '1000000' },
        intent: { verb: 'deposit' },
        sentence: ['verb', { field: 'args.amount' }, { word: 'from' }, { field: 'args.from' }],
        fields: [
          { path: 'args.amount', label: 'Amount', format: 'tokenAmount', params: { token: TEST_USDC_SAC } },
          { path: 'args.from', label: 'From', format: 'account' },
        ],
      },
      pay_to: {
        call: { args: [{ name: 'token', type: 'address' }, { name: 'to', type: 'address', inAddressBook: true }, { name: 'amount', type: 'i128' }] },
        intent: { verb: 'pay' },
        sentence: ['verb', { field: 'args.amount' }, { word: 'to' }, { field: 'args.to' }],
        fields: [
          { path: 'args.amount', label: 'Amount', format: 'tokenAmount', params: { tokenPath: 'args.token' } },
          { path: 'args.to', label: 'To', format: 'account' },
        ],
      },
    },
  },
};

export const PAYMENT_DOC_JSON = {
  schema: 'journear-labels/1',
  context: { stellar: { networkPassphrase: PASSPHRASE } },
  metadata: { addressBook: [{ account: OTHER, name: 'Coffee Club till' }] },
  display: {
    formats: {
      payment: {
        call: { memo: 'text', assets: ['native', `USDC:${ISSUER}`], amountAtMost: '1000000000' },
        intent: { verb: 'pay', object: 'order' },
        sentence: ['verb', { word: 'for' }, 'object', { field: 'memo' }],
        fields: [{ path: 'memo', label: 'Order', format: 'orderNumber' }],
      },
    },
  },
};

export function parsed(json: unknown): LabelDocument {
  const r = parseLabelDocument(typeof json === 'string' ? json : JSON.stringify(json));
  if (!r.ok) throw new Error(`fixture refused: ${JSON.stringify(r.errors)}`);
  return r.document;
}

export const fn = (methodName: string, args: string | Uint8Array, over: { gas?: bigint; deposit?: bigint } = {}): NearAction => ({
  type: 'functionCall',
  methodName,
  args: typeof args === 'string' ? utf8(args) : Uint8Array.from(args),
  gas: over.gas ?? 10n * TGAS,
  deposit: over.deposit ?? 0n,
});

/** A NEAR request through the real decoder: a delegate action (relayed, the default) or the user's own transaction. */
export function nearDecoded(actions: NearAction[], o: { receiver?: string; relayed?: boolean; network?: 'testnet' | 'mainnet' } = {}) {
  const receiverId = o.receiver ?? STAMPS;
  const context = { nearNetwork: o.network ?? 'testnet' };
  return o.relayed === false
    ? decodeApprovalRequest({ kind: 'near_tx', chain: 'near', address: ME, context, bytes: encodeNearTransaction({ signerId: ME, publicKey: NEAR_KEY, nonce: 3n, receiverId, blockHash: sha256(utf8('b')), actions }) })
    : decodeApprovalRequest({ kind: 'near_delegate', chain: 'near', address: ME, context, bytes: encodeNearDelegateAction({ senderId: ME, receiverId, actions, nonce: 7n, maxBlockHeight: 9n, publicKey: NEAR_KEY }) });
}

/** A classic payment's envelope bytes, with a memo. */
export function paymentTx(o: { destination?: string; asset?: Asset; amount?: string; memo?: Memo; source?: string; extra?: xdr.Operation[]; opSource?: string } = {}): Uint8Array {
  const b = new TransactionBuilder(new Account(o.source ?? USER, '41'), { fee: '100', networkPassphrase: PASSPHRASE });
  b.addOperation(Operation.payment({ destination: o.destination ?? OTHER, asset: o.asset ?? Asset.native(), amount: o.amount ?? '25', ...(o.opSource ? { source: o.opSource } : {}) }));
  for (const op of o.extra ?? []) b.addOperation(op);
  b.addMemo(o.memo ?? Memo.text('1042'));
  b.setTimebounds(10, 2000);
  return new Uint8Array(b.build().toEnvelope().toXDR());
}
