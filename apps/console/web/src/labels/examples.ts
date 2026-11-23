// The preview's example requests (D899): real Stellar transactions with made-up values, built with the Stellar SDK and
// read by Journear's own decoder (`decodeApprovalRequest`), exactly as the approval window reads a request, so the
// preview is the window's own outcome for them: the partner's box for a matching payment, the amber line for one that
// doesn't match, the red line for a payment to an account the document doesn't list. Nothing is signed or sent; the
// accounts are fixed example accounts, never a real user's.
import { Account, Asset, Keypair, Memo, Operation, TransactionBuilder } from '@stellar/stellar-base';
import { type DecodedApproval, decodeApprovalRequest } from '@hana-id/core/decode';
import type { LabelDocument } from '@hana-id/core/partner-labels';

/** The example user (an account made from a fixed seed: nobody's real account). */
export const EXAMPLE_USER = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(7) as never).publicKey();
/** An example account no document lists: the red line's payee. */
export const EXAMPLE_STRANGER = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(21) as never).publicKey();

export type ExampleKind = 'match' | 'mismatch' | 'not_listed';

export const EXAMPLE_TITLES: Readonly<Record<ExampleKind, string>> = Object.freeze({
  match: 'A payment that matches',
  mismatch: 'A payment that doesn’t match',
  not_listed: 'A payment to an account not in your list',
});

/** 25 units of the asset, in stroops (Stellar amounts have 7 decimals whatever the asset). */
const EXAMPLE_AMOUNT = 250_000_000n;
const BASE_FEE = 100n;

const stroopsToAmount = (s: bigint): string => {
  const t = s.toString().padStart(8, '0');
  const int = t.slice(0, -7);
  const frac = t.slice(-7).replace(/0+$/u, '');
  return frac ? `${int}.${frac}` : int;
};

function assetOf(a: string | undefined): Asset {
  if (a === undefined || a === 'native') return Asset.native();
  const [code, issuer] = a.split(':');
  return new Asset(code!, issuer!);
}

export type Example = { ok: true; decoded: DecodedApproval; payee: string } | { ok: false; why: string };

/**
 * The example request of `kind` for a parsed payment document: a payment from the example user, of one of its allowed
 * assets, within its amount and fee limits, with the memo it asks for, to its first listed Stellar account (G…). The
 * mismatch changes only the memo (none where it asks for one, a text memo where it asks for none); the not-listed one
 * only the payee.
 */
export function paymentExample(doc: LabelDocument, kind: ExampleKind): Example {
  if (doc.context.chain !== 'stellar') return { ok: false, why: 'Only a payment description has example payments.' };
  const format = doc.formats.payment;
  if (!format || format.chain !== 'stellar') return { ok: false, why: 'Describe the payment first.' };
  const listed = doc.metadata.addressBook.find((e) => e.account.startsWith('G'));
  if (!listed) return { ok: false, why: 'Add one of your Stellar accounts (G…) to see a matching payment.' };
  const call = format.call;
  const amount = call.amountAtMost !== undefined && BigInt(call.amountAtMost) < EXAMPLE_AMOUNT ? BigInt(call.amountAtMost) : EXAMPLE_AMOUNT;
  const fee = call.feeAtMost !== undefined && BigInt(call.feeAtMost) < BASE_FEE ? BigInt(call.feeAtMost) : BASE_FEE;
  const payee = kind === 'not_listed' ? EXAMPLE_STRANGER : listed.account;
  const memoKind = kind === 'mismatch' ? (call.memo === 'none' ? 'text' : 'none') : call.memo;
  const memo = memoKind === 'text' ? Memo.text('1042') : memoKind === 'id' ? Memo.id('1042') : Memo.none();
  try {
    const b = new TransactionBuilder(new Account(EXAMPLE_USER, '41'), { fee: fee.toString(), networkPassphrase: doc.context.networkPassphrase });
    b.addOperation(Operation.payment({ destination: payee, asset: assetOf(call.assets?.[0]), amount: stroopsToAmount(amount > 0n ? amount : 1n) }));
    b.addMemo(memo);
    b.setTimebounds(0, 0);
    const bytes = new Uint8Array(b.build().toEnvelope().toXDR());
    const decoded = decodeApprovalRequest({ kind: 'stellar_tx', chain: 'stellar', address: EXAMPLE_USER, context: { networkPassphrase: doc.context.networkPassphrase }, bytes });
    return { ok: true, decoded, payee };
  } catch {
    return { ok: false, why: 'This example can’t be built from the description yet: fix the problems above.' };
  }
}
