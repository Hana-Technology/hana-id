// Journear's reviewed NEAR calls (docs/decisions.md D885): the calls of Journear's own demo contracts that the
// approval window reads in plain words, marked as checked by Journear, the NEAR side of the EVM demo check-in
// (demo-check-in.ts, D854). Pinned data and pure matching, built into the popup bundle: a code release changes it.
//
// What an entry rests on (D885 "The trust argument"):
// - the contract's source in this repository, read by a person: `REVIEWED_NEAR_CONTRACTS[*].files` pins the sha256 of
//   every file that decides the build (`src/lib.rs`, `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`);
//   test/reviewed-near-calls.test.ts fails when any changes, so a review can't outlive its source. What the pin can't
//   hold (cargo-near's version, the host) the rebuild carries: `scripts/reviewed-near-rebuild.ts` (`pnpm verify --full`)
//   rebuilds with the deploy tool's command and compares with each record's code hash;
// - the account the env's manifest names for it (`near.demoStamps`, `near.demoGuestbook`), which reaches the popup
//   only through the build (HanaEnv.nearReviewed, packages/web/scripts/gen-envs.ts), and only for an env with a
//   deployment record below: the contract deployed from that source, then locked (no access key left: nothing can
//   deploy other code to it, and it has no upgrade method), checked by a person and written down here. The record
//   holds no account name (CLAUDE.md: names come from the manifests), only the sha256 of the account checked: gen-envs
//   refuses to build when the manifest names another (packages/web/test/gen-envs.test.ts pins it too). On chain,
//   `scripts/check-reviewed-near.ts <env>` (and deploy-check's `near-reviewed` group) reads both RPC providers;
// - an exact match on the request (`reviewedNearCall`, `reviewedNearMessage`): the network, the account, one action,
//   the method, no deposit, gas within a bound, the arguments exactly in the reviewed shape, relayed or direct as the
//   site sends it. Anything else is not a match, and the window shows what it shows for any other call.
//
// Per contract, not per app: the plain reading says what the contract's code does with this exact call, which is the
// same whichever app asks; the window names the asking app from the vault, never from the request.
//
// No imports beyond core's own pure helpers: the popup bundle takes it as it is.
import { ed25519 } from '@noble/curves/ed25519';
import { isNearImplicitAccountId, nearImplicitPublicKey } from './addresses.ts';
import { type Bytes, base64Decode, base64Encode } from './bytes.ts';
import { isDisplaySafeLine } from './display-safe.ts';
import { parseStrictJson } from './decode/json.ts';
import { type NearAction, type Nep413Payload, encodeNep413Message, nep413Hash } from './near/codec.ts';

/** Journear's reviewed NEAR contracts. */
export type ReviewedNearContract = 'stamps' | 'guestbook';

/** The build's accounts of the reviewed contracts (from the env's manifest), by contract. */
export type ReviewedNearAccounts = Readonly<Partial<Record<ReviewedNearContract, string>>>;

export interface ReviewedNearContractInfo {
  /** Shown in bold, as a checked contract's name is: "It uses {name} (…, checked by Journear)." */
  readonly name: string;
  /** The crate's directory, from the repository root. */
  readonly crate: string;
  /** The reviewed source file (in `files`), from the repository root. */
  readonly source: string;
  /** sha256 (hex, line endings as LF) of every file in the crate that decides the build, by path from the repository root. */
  readonly files: Readonly<Record<string, string>>;
  /** The one method the window reads for this contract. */
  readonly method: string;
  /** The ISO date the source was reviewed for this list. */
  readonly reviewed: string;
}

const crateFiles = (crate: string, lib: string, cargoToml: string, cargoLock: string, toolchain: string): Readonly<Record<string, string>> =>
  Object.freeze({ [`${crate}/src/lib.rs`]: lib, [`${crate}/Cargo.toml`]: cargoToml, [`${crate}/Cargo.lock`]: cargoLock, [`${crate}/rust-toolchain.toml`]: toolchain });

/** rust-toolchain.toml as reviewed: Rust 1.85.1 with the wasm32-unknown-unknown target. */
const TOOLCHAIN_SHA256 = 'ac07090eaf2dfc1a06a87781c16a027e8958e7ba0dc4d43d569dcec029a3b5b5';

export const REVIEWED_NEAR_CONTRACTS: Readonly<Record<ReviewedNearContract, ReviewedNearContractInfo>> = Object.freeze({
  stamps: Object.freeze({
    name: 'Journear demo stamps',
    crate: 'contracts/hana-stamps',
    source: 'contracts/hana-stamps/src/lib.rs',
    files: crateFiles('contracts/hana-stamps', 'ea2d68de011b74afd97b88f628fc49bd79b9152fbcfbfefb9acefb198737fbba', 'e55dd4bfddb49777eaa8bf8019991477d5c6cf355ef7f1b7f54ba5c998d99463', 'd9885f9240a9abb2cc7b94622a84651052942bb162244edec76321421d9e0d92', TOOLCHAIN_SHA256),
    method: 'collect',
    reviewed: '2026-11-19',
  }),
  guestbook: Object.freeze({
    name: 'Journear demo guestbook',
    crate: 'contracts/hana-guestbook',
    source: 'contracts/hana-guestbook/src/lib.rs',
    files: crateFiles('contracts/hana-guestbook', '04114e0190f500504772f012b9ea0714dc9b8b99d6690990957eb8f3ab43f197', 'a0326bb9378e7a3d36d86e1517c0da42a0773c4dde15b7f78c14e9cee66bb388', 'cfce151f5c4e0e01801e3de8a897c4dcdea4daec2c1763721d51c6e024ef10d8', TOOLCHAIN_SHA256),
    method: 'add_message',
    reviewed: '2026-11-19',
  }),
});

/** How a reviewed code hash is rebuilt from the pinned files: the deploy tool's own command and the tools it ran on. */
export interface ReviewedNearBuild {
  /** Run in the crate's directory. */
  readonly command: string;
  /** The Rust toolchain (rust-toolchain.toml's channel). */
  readonly rust: string;
  /** `cargo near --version`'s version. */
  readonly cargoNear: string;
}

export const REVIEWED_NEAR_BUILD: ReviewedNearBuild = Object.freeze({ command: 'cargo near build non-reproducible-wasm --no-abi', rust: '1.85.1', cargoNear: '0.22.0' });

/** A deployed, locked copy of a reviewed contract on one env, as a person checked it on chain. */
export interface ReviewedNearDeploy {
  /** sha256 (hex) of the account id that was checked, UTF-8: the build refuses a manifest that names another. */
  readonly accountSha256: string;
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
    stamps: Object.freeze({ accountSha256: '3a5d1a60b53fe18b309d7298aa55ad7836ec0dcf7f9850cdd24033a397dda892', codeHash: '9pjHDkQQ5j37cU8kiVcnebh22788f6vAkS5JAY1pSNvA', locked: '2026-11-13', lockTx: 'wUxYjzymRJ825xVs5zzr386LBfLocVsZz1fo1jAXDfU' }),
    guestbook: Object.freeze({ accountSha256: '31d46333abc5c948e22c4102e1d488111d1df47126f338e2baabcccdb4981b03', codeHash: '2cGY7mcQevAjB5nssu8VNYkkSiqSiSdimB98QYXbKJxb', locked: '2026-11-12', lockTx: 'HqnP7FRupTXdAUkKwVspAwRsY2ov3AWpwJLs4rR3VqDr' }),
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
 * More than two combining marks in a row: enough to stack glyphs far above or below their line and paint over the
 * window's own sentences (two cover every accent a language puts on one letter, e.g. Vietnamese).
 */
export const COMBINING_RUN = /\p{M}{3,}/u;

/**
 * Characters that open or close a quotation, so a text could seem to end the quoted words and go on in the window's own
 * voice: every Unicode Quotation_Mark, the look-alikes that aren't classed as one (double primes, modifier letters,
 * ditto, ornaments), except the single quotes that are also the apostrophe in "don't" and "I’m" (U+0027, U+2018,
 * U+2019, U+201B, U+FF07). Those stay: the window draws no quotation marks around the text at all (its own box).
 */
export const QUOTE_LIKE = /(?![\u0027\u2018\u2019\u201b\uff07])[\p{Quotation_Mark}\u02ba\u02dd\u02ee\u2033\u2036\u3003\u275d\u275e\u{1f676}-\u{1f678}]/u;

/**
 * A text the window may show as the words of a reviewed call: exactly what the contract stores (already trimmed,
 * 1 to `max` Unicode scalar values), one display-safe line (no control, format, bidi, invisible character or variation
 * selector), no run of more than two combining marks and no quotation mark (apostrophes aside). Anything else: today's
 * screen.
 */
export function reviewedText(v: unknown, max: number): v is string {
  if (typeof v !== 'string' || trimLikeRust(v) !== v || !isDisplaySafeLine(v) || COMBINING_RUN.test(v) || QUOTE_LIKE.test(v)) return false;
  const n = [...v].length;
  return n >= 1 && n <= max;
}

/** Standard base64 with padding of exactly `bytes` bytes, in its one canonical form, decoded; else null. */
function base64Of(v: unknown, bytes: 32 | 64): Bytes | null {
  if (typeof v !== 'string' || !(bytes === 32 ? /^[A-Za-z0-9+/]{43}=$/u : /^[A-Za-z0-9+/]{86}==$/u).test(v)) return null;
  try {
    const out = base64Decode(v);
    return out.length === bytes && base64Encode(out) === v ? out : null;
  } catch {
    return null;
  }
}

/**
 * Whether `proof` is what the stamps contract accepts for `sender` (its `proof_is_valid`): the message for that account,
 * this contract as the recipient, no callback, and an ed25519 signature by the account's own key (an implicit account:
 * the key is the account id). Checked here so the window can say the user signed it. Pure math: no new trust.
 */
function proofSignedBy(proof: Record<string, unknown>, sender: string, account: string): boolean {
  if (!keysAre(proof, ['message', 'nonce', 'recipient', 'signature']) || proof.message !== `${STAMP_SIGN_MESSAGE_PREFIX}${sender}` || proof.recipient !== account) return false;
  const nonce = base64Of(proof.nonce, 32);
  const signature = base64Of(proof.signature, 64);
  if (nonce === null || signature === null || !isNearImplicitAccountId(sender)) return false;
  try {
    const hash = nep413Hash(encodeNep413Message({ message: proof.message, nonce, recipient: account, callbackUrl: null }));
    return ed25519.verify(signature, hash, nearImplicitPublicKey(sender), { zip215: false });
  } catch {
    return false;
  }
}

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
      return keysAre(args, ['stamp', 'note']) && reviewedText(args.note, STAMP_NOTE_MAX_CHARS) ? { contract: 'stamps', account, kind: 'collect', stamp: id, note: args.note } : null;
    case 'signature': {
      if (!keysAre(args, ['stamp', 'proof'])) return null;
      const p = args.proof;
      if (p === null || typeof p !== 'object' || Array.isArray(p)) return null;
      return proofSignedBy(p as Record<string, unknown>, sender, account) ? { contract: 'stamps', account, kind: 'collect', stamp: id } : null;
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
  return keysAre(args, ['text']) && reviewedText(args.text, GUESTBOOK_TEXT_MAX_CHARS) ? { contract: 'guestbook', account: r.receiver, kind: 'add_message', text: args.text } : null;
}

/**
 * The signature stamp's message (NEP-413), when it is exactly the reviewed one: for the build's stamps account, the
 * text "Stamp my passport: " followed by the user's own account (`address`), and no callback URL. Else null.
 */
export function reviewedNearMessage(p: Pick<Nep413Payload, 'message' | 'recipient' | 'callbackUrl'>, address: string, accounts: ReviewedNearAccounts | undefined): ReviewedNearCall | null {
  if (contractAt(accounts, p.recipient) !== 'stamps' || p.callbackUrl !== null || address.length === 0) return null;
  return p.message === `${STAMP_SIGN_MESSAGE_PREFIX}${address}` ? { contract: 'stamps', account: p.recipient, kind: 'signature_message' } : null;
}
