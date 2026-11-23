// The preview's example requests (D899): real Stellar transactions with made-up values, built with the Stellar SDK and
// read by Journear's own decoder (`decodeApprovalRequest`), exactly as the approval window reads a request, so the
// preview is the window's own outcome for them: the partner's box for a matching payment, the amber line for one that
// doesn't match, the red line for a payment to an account the document doesn't list. Nothing is signed or sent; the
// accounts are fixed example accounts, never a real user's. D900: NEAR programs and Soroban contracts too, a call that
// matches and the same call after a code change (`contractExample`).
import { Account, Address, Asset, Keypair, Memo, Operation, SorobanDataBuilder, TransactionBuilder, nativeToScVal, xdr } from '@stellar/stellar-base';
import { type NearAction, encodeNearDelegateAction, encodeNearTransaction } from '@hana-id/core';
import { type DecodedApproval, decodeApprovalRequest } from '@hana-id/core/decode';
import { type ExampleArg, type LabelDocument, exampleCallArgs } from '@hana-id/core/partner-labels';

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

// ---- D900: NEAR programs and Soroban contracts ----

/** The example NEAR user: an implicit account (the hex of a fixed example key: nobody's real account). */
const EXAMPLE_NEAR_KEY = new Uint8Array(32).fill(7);
export const EXAMPLE_NEAR_USER = toHexString(EXAMPLE_NEAR_KEY);
/** Another code than the document's, for "after a code change" (a made-up hash). */
const OTHER_NEAR_CODE = '11111111111111111111111111111112';
const OTHER_WASM = 'cd'.repeat(32);
const TGAS = 1_000_000_000_000n;
const ONE_NEAR = 10n ** 24n;

function toHexString(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export type ContractExampleKind = 'match' | 'code_changed';

export const CONTRACT_EXAMPLE_TITLES: Readonly<Record<ContractExampleKind, string>> = Object.freeze({
  match: 'A call that matches',
  code_changed: 'The same call after a code change',
});

/** A contract example: the request the window reads, the user, and the vault's NEAR fact when there is one. */
export type ContractExample = { ok: true; decoded: DecodedApproval; user: string; labelFacts?: { near: { account: string; codeHash: string } } } | { ok: false; why: string };

/** The JSON a NEAR argument holds for an example value of its type. */
const nearJson = (a: ExampleArg): unknown => (a.type === 'integer' ? Number(a.value) : a.value);

/** A Soroban value for an example value of its declared type. */
function scValOf(a: ExampleArg): xdr.ScVal {
  const v = a.value;
  switch (a.type) {
    case 'address':
      return nativeToScVal(String(v), { type: 'address' });
    case 'bool':
      return xdr.ScVal.scvBool(v === true);
    case 'symbol':
      return xdr.ScVal.scvSymbol(String(v));
    case 'string':
      return xdr.ScVal.scvString(String(v));
    case 'u32':
      return xdr.ScVal.scvU32(Number(v));
    case 'i32':
      return xdr.ScVal.scvI32(Number(v));
    case 'timepoint':
      return xdr.ScVal.scvTimepoint(xdr.Uint64.fromString(String(v)));
    case 'duration':
      return xdr.ScVal.scvDuration(xdr.Uint64.fromString(String(v)));
    default:
      return nativeToScVal(BigInt(String(v)), { type: a.type });
  }
}

/** A footprint's ContractCode key for a Wasm hash in hex (built from its XDR: the entry type, then the 32 bytes). */
function codeKey(wasmHex: string): xdr.LedgerKey {
  const bytes = new Uint8Array(36);
  bytes[3] = 7; // LedgerEntryType CONTRACT_CODE
  for (let i = 0; i < 32; i++) bytes[4 + i] = parseInt(wasmHex.slice(2 * i, 2 * i + 2), 16);
  return xdr.LedgerKey.fromXDR(btoa(String.fromCharCode(...bytes)), 'base64');
}

/**
 * The example request of `kind` for the first request a NEAR or Soroban document describes, through Journear's own
 * decoder: NEAR, the example user's own transaction or a relayed action (as the format allows), its arguments as
 * core's preview picks them, with the vault's code hash for the account (the document's, or another after a code
 * change); Soroban, the example user's transaction whose footprint names the document's Wasm hash (or another) as its
 * one code and writes only the contract's own data. Nothing is signed or sent.
 */
export function contractExample(doc: LabelDocument, kind: ContractExampleKind, environment: 'test' | 'live'): ContractExample {
  const ctx = doc.context;
  if (ctx.chain === 'stellar') return { ok: false, why: 'Only a program or contract description has example calls.' };
  const key = Object.keys(doc.formats)[0];
  if (key === undefined) return { ok: false, why: 'Describe a request first.' };
  const format = doc.formats[key]!;
  try {
    if (ctx.chain === 'near' && format.chain === 'near') {
      const args = exampleCallArgs(doc, key, EXAMPLE_NEAR_USER) ?? [];
      const call = format.call;
      const deposit = 'exactly' in call.deposit ? BigInt(call.deposit.exactly) : BigInt(call.deposit.atMost) < ONE_NEAR ? BigInt(call.deposit.atMost) : ONE_NEAR;
      const gas = call.gasAtMost !== undefined && BigInt(call.gasAtMost) < 30n * TGAS ? BigInt(call.gasAtMost) : 30n * TGAS;
      const json = args.length === 0 ? '' : JSON.stringify(Object.fromEntries(args.map((a) => [a.name, nearJson(a)])));
      const action: NearAction = { type: 'functionCall', methodName: key, args: new TextEncoder().encode(json), gas, deposit };
      const publicKey = { type: 'ed25519' as const, bytes: EXAMPLE_NEAR_KEY };
      const context = { nearNetwork: ctx.network };
      const decoded =
        call.relayed === 'direct'
          ? decodeApprovalRequest({ kind: 'near_tx', chain: 'near', address: EXAMPLE_NEAR_USER, context, bytes: encodeNearTransaction({ signerId: EXAMPLE_NEAR_USER, publicKey, nonce: 1n, receiverId: ctx.account, blockHash: new Uint8Array(32).fill(1), actions: [action] }) })
          : decodeApprovalRequest({ kind: 'near_delegate', chain: 'near', address: EXAMPLE_NEAR_USER, context, bytes: encodeNearDelegateAction({ senderId: EXAMPLE_NEAR_USER, receiverId: ctx.account, actions: [action], nonce: 1n, maxBlockHeight: 2n, publicKey }) });
      if (environment === 'live' && call.relayed !== 'direct') return { ok: false, why: 'This example is a call someone else sends for the user, which shows Journear’s plain window from a live app (see above). Set “Who sends it” to “Only when the user sends it” to see one.' };
      return { ok: true, decoded, user: EXAMPLE_NEAR_USER, labelFacts: { near: { account: ctx.account, codeHash: kind === 'match' ? ctx.codeHash : OTHER_NEAR_CODE } } };
    }
    if (ctx.chain === 'soroban' && format.chain === 'soroban') {
      const args = (exampleCallArgs(doc, key, EXAMPLE_USER) ?? []).map(scValOf);
      const fee = format.call.feeAtMost !== undefined && BigInt(format.call.feeAtMost) < BASE_FEE ? BigInt(format.call.feeAtMost) : BASE_FEE;
      const root = new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({ contractAddress: new Address(ctx.contract).toScAddress(), functionName: key, args })),
        subInvocations: [],
      });
      const auth = new xdr.SorobanAuthorizationEntry({ credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(), rootInvocation: root });
      const instance = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({ contract: new Address(ctx.contract).toScAddress(), key: xdr.ScVal.scvLedgerKeyContractInstance(), durability: xdr.ContractDataDurability.persistent() }));
      const own = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({ contract: new Address(ctx.contract).toScAddress(), key: xdr.ScVal.scvSymbol('state'), durability: xdr.ContractDataDurability.persistent() }));
      const data = new SorobanDataBuilder().setFootprint([instance, codeKey(kind === 'match' ? ctx.wasmHash : OTHER_WASM)], [own]).setResourceFee('0').build();
      const b = new TransactionBuilder(new Account(EXAMPLE_USER, '41'), { fee: fee.toString(), networkPassphrase: ctx.networkPassphrase });
      b.addOperation(Operation.invokeContractFunction({ contract: ctx.contract, function: key, args, auth: [auth] }));
      b.setSorobanData(data);
      b.setTimebounds(0, 0);
      const bytes = new Uint8Array(b.build().toEnvelope().toXDR());
      const decoded = decodeApprovalRequest({ kind: 'stellar_tx', chain: 'stellar', address: EXAMPLE_USER, context: { networkPassphrase: ctx.networkPassphrase }, bytes });
      return { ok: true, decoded, user: EXAMPLE_USER };
    }
    return { ok: false, why: 'Describe a request first.' };
  } catch {
    return { ok: false, why: 'This example can’t be built from the description yet: fix the problems above.' };
  }
}
