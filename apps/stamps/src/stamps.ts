// The stamps contract (contracts/hana-stamps) as the site sees it, without the DOM or the SDK: the catalog, the
// postcard's text rule, the bytes the user signs (`collect` as a delegate action or an ordinary transaction, the
// NEP-413 message the `signature` stamp proves), and the views' answers parsed strictly.
//
// Everything read from NEAR is attacker-controlled (D753, D800): anyone can collect a postcard with any text, and an
// RPC can answer anything. So every answer is parsed field by field, bounded, and notes are made safe for a text node
// (`displayText`: invisible and direction-changing characters neutralised) before they reach the UI.
import { type NearAction, encodeNearDelegateAction, encodeNearTransaction, isNearAccountId, nearImplicitPublicKey, toBytes, utf8 } from '@hana-id/core';
import { base58 } from '@scure/base';
import { DELEGATE_TTL_BLOCKS, displayText, scalarCount, trimLikeRust } from '../../demo/src/near.ts';

export { displayText, scalarCount, trimLikeRust };

// ---- the catalog ----

/** Every stamp, in the contract's catalog order (the order the passport shows them). */
export const STAMP_IDS = ['arrival', 'sponsored', 'own_fare', 'signature', 'postcard', 'layover'] as const;
export type StampId = (typeof STAMP_IDS)[number];

export const isStampId = (v: unknown): v is StampId => typeof v === 'string' && (STAMP_IDS as readonly string[]).includes(v);

/** The stamps Journear's relayer pays for (a NEP-366 delegate action); `own_fare` alone is the user's own transaction. */
export const RELAYED_STAMPS: ReadonlySet<StampId> = new Set(['arrival', 'sponsored', 'signature', 'postcard', 'layover']);

/** The contract's postcard limit: characters (Unicode scalar values, Rust's `chars()`) after Rust's `trim`. */
export const NOTE_MAX_CHARS = 140;
/** The contract's layover: at least this long (block timestamps) after the account's arrival. */
export const LAYOVER_MS = 120_000;

/** A 64-hex implicit account (the only kind that can collect `signature`: its id is its public key). */
export const isImplicitAccount = (id: string): boolean => /^[0-9a-f]{64}$/u.test(id);

export type NoteCheck = { ok: true; text: string; chars: number } | { ok: false; reason: 'empty' | 'too_long' | 'malformed'; chars: number };

/** The note `collect` would store for `postcard`, or why the contract would refuse it (ERR_BAD_NOTE). */
export function checkNote(raw: string): NoteCheck {
  const text = trimLikeRust(raw);
  const chars = scalarCount(text);
  // A lone surrogate (possible in a JavaScript string, never in UTF-8): the contract's JSON parser refuses it.
  if (/\p{Cs}/u.test(text)) return { ok: false, reason: 'malformed', chars };
  if (chars === 0) return { ok: false, reason: 'empty', chars };
  if (chars > NOTE_MAX_CHARS) return { ok: false, reason: 'too_long', chars };
  return { ok: true, text, chars };
}

/** The message `signature` must carry: the contract rebuilds it from the caller's account id. */
export const signatureMessage = (accountId: string): string => `Stamp my passport: ${accountId}`;

// ---- the bytes the user signs ----

/** NEP-413's proof as `collect` takes it: the signed fields and the 64-byte signature, each base64 where bytes. */
export interface SignatureProof {
  message: string;
  /** base64 of the 32-byte nonce. */
  nonce: string;
  recipient: string;
  /** base64 of the 64-byte ed25519 signature. */
  signature: string;
}

export interface CollectArgs {
  stamp: StampId;
  note?: string;
  proof?: SignatureProof;
}

/** `collect`'s JSON arguments, with only the fields the stamp takes. */
export function collectArgs(stamp: StampId, extra: { note?: string; proof?: SignatureProof } = {}): CollectArgs {
  return { stamp, ...(stamp === 'postcard' && extra.note !== undefined ? { note: extra.note } : {}), ...(stamp === 'signature' && extra.proof ? { proof: extra.proof } : {}) };
}

const TGAS = 1_000_000_000_000n;

/** `collect(args)` with `tgas` and no deposit (`collect` is not payable). */
export const collectAction = (args: CollectArgs, tgas: number): NearAction => ({ type: 'functionCall', methodName: 'collect', args: utf8(JSON.stringify(args)), gas: BigInt(tgas) * TGAS, deposit: 0n });

const userKey = (accountId: string) => ({ type: 'ed25519' as const, bytes: nearImplicitPublicKey(accountId) });

/** borsh `DelegateAction`: `accountId` calls `collect(args)` on `contract`, valid until `blockHeight + DELEGATE_TTL_BLOCKS`. */
export function collectDelegate(p: { accountId: string; contract: string; args: CollectArgs; tgas: number; nonce: bigint; blockHeight: bigint }): Uint8Array {
  return encodeNearDelegateAction({
    senderId: p.accountId,
    receiverId: p.contract,
    actions: [collectAction(p.args, p.tgas)],
    nonce: p.nonce,
    maxBlockHeight: p.blockHeight + DELEGATE_TTL_BLOCKS,
    publicKey: userKey(p.accountId),
  });
}

/** borsh `Transaction`: the same call as an ordinary transaction, which the account's own NEAR pays for (`own_fare`). */
export function collectTransaction(p: { accountId: string; contract: string; args: CollectArgs; tgas: number; nonce: bigint; blockHash: string }): Uint8Array {
  return encodeNearTransaction({ signerId: p.accountId, publicKey: userKey(p.accountId), nonce: p.nonce, receiverId: p.contract, blockHash: toBytes(base58.decode(p.blockHash)), actions: [collectAction(p.args, p.tgas)] });
}

/**
 * The balance from which "Own fare" can be collected: the call prepays `collectTgas` (10 Tgas ≈ 0.001 NEAR at
 * testnet's gas price), so 0.01 NEAR leaves a margin, as the demo's "Sign a transaction" (D754).
 */
export const OWN_FARE_MIN_YOCTO = 10n ** 22n;

// ---- the views' answers ----

/** A stamp as the contract stores it, parsed. */
export interface ChainStamp {
  stamp: StampId;
  atMs: number;
  sponsored: boolean;
  /** The postcard's note, made safe for a text node (displayText), when it has one. */
  note?: string;
}

export interface Passport {
  accountId: string;
  /** At most one per stamp id, in catalog order (the contract lists them in the order collected; the page re-sorts). */
  stamps: ChainStamp[];
}

/** What the page shows for a note with nothing visible in it once neutralised (only invisible or control characters). */
export const BLANK_NOTE = '(blank note)';

/**
 * A note made safe for a text node (displayText: invisible, control and bidi characters become U+FFFD, cut to 140),
 * or BLANK_NOTE when nothing but those and spaces is left: an all-invisible postcard doesn't read as a row of `�`.
 */
export function displayNote(raw: string): string {
  const shown = displayText(raw, NOTE_MAX_CHARS);
  return /^[\p{White_Space}\uFFFD]*$/u.test(shown) ? BLANK_NOTE : shown;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A u64 as near-sdk serialises it (a JSON number, or a decimal string for U64), within JavaScript's safe range. */
export function u64(v: unknown): number | null {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? v : null;
  if (typeof v === 'string' && /^(?:0|[1-9]\d{0,15})$/u.test(v)) {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/** How long a stored note may be before it is dropped as hostile (UTF-16 units; the contract allows 140 scalars). */
const NOTE_MAX_UNITS = 4 * NOTE_MAX_CHARS;

/**
 * `get_passport`'s answer for `accountId`: null for no passport (or an answer about another account), else the
 * stamps it holds that parse (a known id, a time, a boolean `sponsored`, an optional bounded string note: the contract
 * sends `note` on a postcard only), each id once, in catalog order whatever order the contract lists them in (the order
 * collected). Anything else is dropped.
 */
export function parsePassport(value: unknown, accountId: string): Passport | null {
  if (!isObj(value) || value.account_id !== accountId || !Array.isArray(value.stamps)) return null;
  const byId = new Map<StampId, ChainStamp>();
  for (const s of value.stamps.slice(0, 4 * STAMP_IDS.length)) {
    if (!isObj(s) || !isStampId(s.stamp) || byId.has(s.stamp)) continue;
    const atMs = u64(s.block_timestamp_ms);
    if (atMs === null || typeof s.sponsored !== 'boolean') continue;
    const stamp: ChainStamp = { stamp: s.stamp, atMs, sponsored: s.sponsored };
    if (typeof s.note === 'string' && s.note.length > 0 && s.note.length <= NOTE_MAX_UNITS) stamp.note = displayNote(s.note);
    byId.set(s.stamp, stamp);
  }
  return { accountId, stamps: STAMP_IDS.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])) };
}

export interface RecentStamp {
  accountId: string;
  stamp: StampId;
  atMs: number;
}

/** How many recent stamps the page lists. */
export const RECENT_SHOWN = 20;
/** `recent`'s page size (the contract's limit) and the ring's size. */
export const RECENT_PAGE = 50;
export const RECENT_RING = 100;

/**
 * `recent`'s answers (one or more pages), parsed strictly: entries with a valid NEAR account id that `keep` accepts
 * (filtered before the cut, so spam can't push the kept ones out), a known stamp and a time; each (account, stamp)
 * once; newest first; at most RECENT_SHOWN. Whatever order the ring answers in, the
 * newest are kept.
 */
export function parseRecent(pages: readonly unknown[], keep: (accountId: string) => boolean = () => true): RecentStamp[] {
  const seen = new Set<string>();
  const out: RecentStamp[] = [];
  for (const page of pages) {
    if (!Array.isArray(page)) continue;
    for (const r of page.slice(0, RECENT_RING)) {
      if (!isObj(r) || !isNearAccountId(r.account_id) || !keep(r.account_id) || !isStampId(r.stamp)) continue;
      const atMs = u64(r.block_timestamp_ms);
      if (atMs === null) continue;
      const key = `${r.account_id} ${r.stamp}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ accountId: r.account_id, stamp: r.stamp, atMs });
    }
  }
  return out.sort((a, b) => b.atMs - a.atMs).slice(0, RECENT_SHOWN);
}

/** `totals()`'s answer, or null when it isn't two counts. */
export function parseTotals(value: unknown): { passports: number; stamps: number } | null {
  if (!isObj(value)) return null;
  const passports = u64(value.passports);
  const stamps = u64(value.stamps);
  return passports === null || stamps === null ? null : { passports, stamps };
}

// ---- the contract's refusals ----

/** The contract's panics (`ERR_*`), in plain words. */
export const CONTRACT_ERRORS: Readonly<Record<string, string>> = {
  ERR_NO_ARRIVAL: 'Collect your Arrival stamp first: every passport starts with it.',
  ERR_ALREADY: 'You already hold this stamp: each one can be collected once.',
  ERR_NOT_SPONSORED: 'This stamp must come through Journear’s relayer (a sponsored, gasless transaction), and this one didn’t.',
  ERR_NOT_OWN_FARE: 'This stamp needs a transaction you sign and pay for yourself, and this one came through a relayer.',
  ERR_BAD_PROOF: 'The contract couldn’t verify your signature for this stamp. Try again: a new signature is made each time.',
  ERR_NOT_IMPLICIT: 'Only an account whose name is its own key (a Journear Passport NEAR account) can collect this stamp.',
  ERR_BAD_NOTE: 'The postcard needs a note of 1 to 140 characters.',
  ERR_TOO_SOON: 'Not yet: the layover needs 2 minutes on NEAR’s clock after your Arrival. Try again in a moment.',
  ERR_UNKNOWN_STAMP: 'The contract doesn’t know this stamp.',
};

/** The first `ERR_*` code in a contract's panic text (the relay's or NEAR's error), or null. */
export function contractErrorCode(text: string): string | null {
  const m = /\bERR_[A-Z_]{2,40}\b/u.exec(text);
  return m && Object.hasOwn(CONTRACT_ERRORS, m[0]) ? m[0] : null;
}
