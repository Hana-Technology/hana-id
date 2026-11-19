// Journear's reviewed NEAR calls (docs/decisions.md D885): the calls of Journear's own demo contracts that the
// approval window reads in plain words, marked as checked by Journear, the NEAR side of the EVM demo check-in
// (demo-check-in.ts, D854). Pinned data and pure matching, built into the popup bundle: a code release changes it.
//
// What an entry rests on (D885 "The trust argument"):
// - the contract's source in this repository, read by a person (`REVIEWED_NEAR_CONTRACTS[*].sourceSha256`: the
//   whole `src/lib.rs`; test/reviewed-near-calls.test.ts fails when it changes, so a review can't outlive its source);
// - the account the env's manifest names for it (`near.demoStamps`, `near.demoGuestbook`), which reaches the popup
//   only through the build (HanaEnv.nearReviewed, packages/web/scripts/gen-envs.ts), and only for an env with a
//   deployment record below: the contract deployed from that source, then locked (no access key left: nothing can
//   deploy other code to it, and it has no upgrade method), checked by a person and written down here. The record
//   holds no account name (CLAUDE.md: names come from the manifests); packages/web/test/gen-envs.test.ts pins each
//   record to its manifest account, so a new account in the manifest fails the tests until it is reviewed;
// - an exact match on the request (`reviewedNearCall`, `reviewedNearMessage`): the network, the account, one action,
//   the method, no deposit, gas within a bound, the arguments exactly in the reviewed shape, relayed or direct as the
//   site sends it. Anything else is not a match, and the window shows what it shows for any other call.
//
// Per contract, not per app: the plain reading says what the contract's code does with this exact call, which is the
// same whichever app asks; the window names the asking app from the vault, never from the request.
//
// No imports beyond core's own pure helpers: the popup bundle takes it as it is.
import { isDisplaySafeLine } from './display-safe.ts';
import { parseStrictJson } from './decode/json.ts';
import type { NearAction, Nep413Payload } from './near/codec.ts';

/** Journear's reviewed NEAR contracts. */
export type ReviewedNearContract = 'stamps' | 'guestbook';

/** The build's accounts of the reviewed contracts (from the env's manifest), by contract. */
export type ReviewedNearAccounts = Readonly<Partial<Record<ReviewedNearContract, string>>>;

export interface ReviewedNearContractInfo {
  /** Shown in bold, as a checked contract's name is: "It uses {name} (…, checked by Journear)." */
  readonly name: string;
  /** The reviewed source, from the repository root. */
  readonly source: string;
  /** sha256 (hex) of that file as reviewed, line endings as LF. */
  readonly sourceSha256: string;
  /** The one method the window reads for this contract. */
  readonly method: string;
  /** The ISO date the source was reviewed for this list. */
  readonly reviewed: string;
}

export const REVIEWED_NEAR_CONTRACTS: Readonly<Record<ReviewedNearContract, ReviewedNearContractInfo>> = Object.freeze({
  stamps: Object.freeze({ name: 'Journear demo stamps', source: 'contracts/hana-stamps/src/lib.rs', sourceSha256: 'ea2d68de011b74afd97b88f628fc49bd79b9152fbcfbfefb9acefb198737fbba', method: 'collect', reviewed: '2026-11-19' }),
  guestbook: Object.freeze({ name: 'Journear demo guestbook', source: 'contracts/hana-guestbook/src/lib.rs', sourceSha256: '04114e0190f500504772f012b9ea0714dc9b8b99d6690990957eb8f3ab43f197', method: 'add_message', reviewed: '2026-11-19' }),
});

/** A deployed, locked copy of a reviewed contract on one env, as a person checked it on chain. */
export interface ReviewedNearDeploy {
  /** The account's code hash (base58) after the deploy, as the deploy tool checked it against its build. */
  readonly codeHash: string;
  /** The ISO date its last access key was deleted: from then on nothing can change its code. */
  readonly locked: string;
  /** The transaction that deleted it. */
  readonly lockTx: string;
}

/**
 * Per env name, the reviewed contracts deployed and locked there. Only these envs' builds carry the accounts (the
 * local test stack sets its own, for its model of the contracts). No mainnet env, ever.
 */
export const REVIEWED_NEAR_DEPLOYS: Readonly<Record<string, Readonly<Partial<Record<ReviewedNearContract, ReviewedNearDeploy>>>>> = Object.freeze({
  'sandbox-dev': Object.freeze({
    stamps: Object.freeze({ codeHash: '9pjHDkQQ5j37cU8kiVcnebh22788f6vAkS5JAY1pSNvA', locked: '2026-11-13', lockTx: 'wUxYjzymRJ825xVs5zzr386LBfLocVsZz1fo1jAXDfU' }),
    guestbook: Object.freeze({ codeHash: '2cGY7mcQevAjB5nssu8VNYkkSiqSiSdimB98QYXbKJxb', locked: '2026-11-12', lockTx: 'HqnP7FRupTXdAUkKwVspAwRsY2ov3AWpwJLs4rR3VqDr' }),
  }),
});

/** The stamps, as the stamps site names them (its slots' titles). */
export type ReviewedStampId = 'arrival' | 'sponsored' | 'own_fare' | 'signature' | 'postcard' | 'layover';
export const REVIEWED_STAMP_TITLES: Readonly<Record<ReviewedStampId, string>> = Object.freeze({ arrival: 'Arrival', sponsored: 'Fare paid', own_fare: 'Own fare', signature: 'Signature', postcard: 'Postcard', layover: 'Layover' });

/** The most gas a reviewed call may attach: the sites attach 10 Tgas, a call burns under 2. */
export const REVIEWED_NEAR_MAX_GAS = 30_000_000_000_000n;
/** The contracts' own limits on the text they store, in Unicode scalar values after trimming. */
export const STAMP_NOTE_MAX_CHARS = 140;
export const GUESTBOOK_TEXT_MAX_CHARS = 200;
/** The message the signature stamp's proof signs, followed by the account id. */
export const STAMP_SIGN_MESSAGE_PREFIX = 'Stamp my passport: ';

/** A request that is exactly a reviewed call. Its values are the request's, each checked against the reviewed shape. */
export type ReviewedNearCall =
  | { readonly contract: 'stamps'; readonly account: string; readonly kind: 'collect'; readonly stamp: ReviewedStampId; readonly note?: string }
  | { readonly contract: 'stamps'; readonly account: string; readonly kind: 'signature_message' }
  | { readonly contract: 'guestbook'; readonly account: string; readonly kind: 'add_message'; readonly text: string };

/** What `reviewedNearCall` reads of a NEAR transaction or delegate action. */
export interface ReviewedNearRequest {
  readonly network: 'testnet' | 'mainnet';
  /** The transaction's signer or the delegate action's sender: the user's account. */
  readonly sender: string;
  readonly receiver: string;
  readonly actions: readonly NearAction[];
  /** A delegate action someone else sends (true), or the user's own transaction (false). */
  readonly relayed: boolean;
}

/** The reviewed contract at exactly this account in this build, or null (none, or two contracts named the same). */
function contractAt(accounts: ReviewedNearAccounts | undefined, account: string): ReviewedNearContract | null {
  if (!accounts) return null;
  const found = (Object.keys(REVIEWED_NEAR_CONTRACTS) as ReviewedNearContract[]).filter((c) => Object.hasOwn(accounts, c) && accounts[c] === account);
  return found.length === 1 ? (found[0] as ReviewedNearContract) : null;
}

/** Rust's `str::trim` (Unicode White_Space): the contracts store their text trimmed this way. */
const trimLikeRust = (s: string): string => s.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');

/**
 * A text the contract stores exactly as signed and the window can show as quoted text: already trimmed, 1 to `max`
 * Unicode scalar values, and one display-safe line (no control, format, bidi or invisible character).
 */
const storedText = (v: unknown, max: number): v is string => {
  if (typeof v !== 'string' || trimLikeRust(v) !== v || !isDisplaySafeLine(v)) return false;
  const n = [...v].length;
  return n >= 1 && n <= max;
};

/** Standard base64 with padding of exactly `bytes` bytes (its shape: the contract checks the rest). */
const base64Of = (v: unknown, bytes: 32 | 64): boolean => typeof v === 'string' && (bytes === 32 ? /^[A-Za-z0-9+/]{43}=$/u : /^[A-Za-z0-9+/]{86}==$/u).test(v);

const keysAre = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(o, k));
};

/** Strict JSON object arguments (UTF-8, no duplicate keys, no lone surrogates), or null. */
function argsObject(args: Uint8Array): Record<string, unknown> | null {
  try {
    const v = parseStrictJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(args));
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const STAMP_IDS = Object.keys(REVIEWED_STAMP_TITLES) as ReviewedStampId[];

/** `collect`'s arguments exactly as the stamps site sends them for `stamp`, from `sender` to `account`, or null. */
function collectCall(args: Record<string, unknown>, sender: string, account: string, relayed: boolean): ReviewedNearCall | null {
  const stamp = args.stamp;
  if (typeof stamp !== 'string' || !(STAMP_IDS as string[]).includes(stamp)) return null;
  const id = stamp as ReviewedStampId;
  // Own fare is the one stamp the user pays for: their own transaction. Every other one is relayed, as the site sends it.
  if (relayed !== (id !== 'own_fare')) return null;
  switch (id) {
    case 'postcard':
      return keysAre(args, ['stamp', 'note']) && storedText(args.note, STAMP_NOTE_MAX_CHARS) ? { contract: 'stamps', account, kind: 'collect', stamp: id, note: args.note } : null;
    case 'signature': {
      if (!keysAre(args, ['stamp', 'proof'])) return null;
      const p = args.proof;
      if (p === null || typeof p !== 'object' || Array.isArray(p)) return null;
      const proof = p as Record<string, unknown>;
      const ok = keysAre(proof, ['message', 'nonce', 'recipient', 'signature']) && proof.message === `${STAMP_SIGN_MESSAGE_PREFIX}${sender}` && proof.recipient === account && base64Of(proof.nonce, 32) && base64Of(proof.signature, 64);
      return ok ? { contract: 'stamps', account, kind: 'collect', stamp: id } : null;
    }
    default:
      return keysAre(args, ['stamp']) ? { contract: 'stamps', account, kind: 'collect', stamp: id } : null;
  }
}

/**
 * The reviewed call this request is, or null. A match needs all of: the NEAR test network; a receiver that is exactly
 * a reviewed contract's account in this build and not the user's own; one action, a function call of that contract's
 * reviewed method, with no deposit and at most `REVIEWED_NEAR_MAX_GAS`; arguments that are strict JSON of exactly the
 * reviewed shape (no other key, each value of its reviewed kind); relayed or direct as reviewed.
 */
export function reviewedNearCall(r: ReviewedNearRequest, accounts: ReviewedNearAccounts | undefined): ReviewedNearCall | null {
  if (r.network !== 'testnet' || r.receiver === r.sender || r.actions.length !== 1) return null;
  const contract = contractAt(accounts, r.receiver);
  const a = r.actions[0] as NearAction;
  if (contract === null || a.type !== 'functionCall' || a.methodName !== REVIEWED_NEAR_CONTRACTS[contract].method) return null;
  if (a.deposit !== 0n || a.gas <= 0n || a.gas > REVIEWED_NEAR_MAX_GAS) return null;
  const args = argsObject(a.args);
  if (args === null) return null;
  if (contract === 'stamps') return collectCall(args, r.sender, r.receiver, r.relayed);
  return keysAre(args, ['text']) && storedText(args.text, GUESTBOOK_TEXT_MAX_CHARS) ? { contract: 'guestbook', account: r.receiver, kind: 'add_message', text: args.text } : null;
}

/**
 * The signature stamp's message (NEP-413), when it is exactly the reviewed one: for the build's stamps account, the
 * text "Stamp my passport: " followed by the user's own account (`address`), and no callback URL. Else null.
 */
export function reviewedNearMessage(p: Pick<Nep413Payload, 'message' | 'recipient' | 'callbackUrl'>, address: string, accounts: ReviewedNearAccounts | undefined): ReviewedNearCall | null {
  if (contractAt(accounts, p.recipient) !== 'stamps' || p.callbackUrl !== null || address.length === 0) return null;
  return p.message === `${STAMP_SIGN_MESSAGE_PREFIX}${address}` ? { contract: 'stamps', account: p.recipient, kind: 'signature_message' } : null;
}
