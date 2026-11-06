// End users and their wallets (D310, D312–D315, D346): the three ids, the search a staff or partner query is read as,
// the RPC inputs of AdminRpc's and ConsoleRpc's user methods, and what each side gets back. The API is the only writer
// (apps/api/src/directory/), from the vault's wallet record and the API's own chain reads.
//
// - **User ID** (D346): the partner identity token's `sub`, "u1_" ‖ 22 base64url characters of
//   HMAC-SHA256(IDENTITY_SUB_KEY, "hana-id/idt-sub/v1" ‖ 0x00 ‖ borsh(scope) ‖ borsh(root provider) ‖ borsh(root
//   sub))[0..16] (core identity.ts `identitySub`; docs/identity-token-spec.md). Per scope and account root; a linked
//   member shares its root's. The one id partners see: the value their backends already store from the token.
// - **Support ID** (D276 as amended by D346): "HANA-XXXX-XXXX", the Crockford base32 (uppercase) of the first 5 bytes
//   (40 bits) of those same 16 bytes: the User ID's short form. Anyone holding a User ID can compute it without a key
//   (the base64url decoded); it is not a visible prefix of the User ID's text (base64url and base32 split bits apart).
// - **Internal id** (D312): "hu_" ‖ Crockford base32, lowercase, of the 16-byte uid (layouts.ts `uid`: HMAC-SHA256 of
//   USER_ID_KEY over the same scope and root, the usage ledger's pseudonym, D96). The hot DB's key and the join to the
//   ledger's events; staff only, never in a partner answer.
//
// Partners get the User ID, the Support ID, times, connected account kinds and wallet addresses (`PartnerUser`), never
// the internal id, a sub, an identity key or an email. Staff get all three ids and the identities with their subs
// (`StaffUser`); the email comes from the issuer's directory through D275's DirectoryRpc, keyed by `directoryKey` (the
// join point; this package and the API never read the issuer).
import { CROCKFORD_ALPHABET, IDENTITY_SUB_RE, crockford32, decodeIdentitySub, supportCodeFromSub, supportIdFromSub } from '@hana-id/core/support-id';
import { z } from 'zod';
import { ctx } from './types.ts';
import { orgIdInput, scopeIdInput } from './rpc.ts';

/** The User ID's prefix: core identity.ts `IDENTITY_SUB_PREFIX` (a test pins them equal). */
export const USER_ID_PREFIX = 'u1_';
export const INTERNAL_ID_PREFIX = 'hu_';
// The Crockford encoding and the User ID -> Support ID step are @hana-id/core's (support-id.ts): the one
// implementation, which the SDK also gives partners as `supportIdFromSub`.
export { SUPPORT_ID_BYTES, SUPPORT_ID_PREFIX, crockford32, formatSupportId } from '@hana-id/core/support-id';
/**
 * A User ID: "u1_" and the canonical base64url of 16 bytes (22 characters; the last one's 4 low bits are zero, so it
 * is A, Q, g or w). Case-sensitive.
 */
export const USER_ID_RE = IDENTITY_SUB_RE;
export const INTERNAL_ID_RE = /^hu_[0-9a-hjkmnp-tv-z]{26}$/u;
/** The stored form of a Support ID (8 Crockford characters, uppercase, no prefix or dash). */
export const SUPPORT_CODE_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/u;

/** The internal id of a 16-byte uid. */
export function internalIdOf(uidBytes: Uint8Array): string {
  if (!(uidBytes instanceof Uint8Array) || uidBytes.length !== 16) throw new TypeError('A uid is 16 bytes');
  return INTERNAL_ID_PREFIX + crockford32(uidBytes).toLowerCase();
}

/**
 * The 16-byte uid of an internal id (internalIdOf's inverse; the erasure script, D361), or null when it isn't one:
 * wrong prefix, length or alphabet, or the last character's two padding bits set (no uid encodes to it).
 */
export function uidOfInternalId(internalId: string): Uint8Array | null {
  if (typeof internalId !== 'string' || !INTERNAL_ID_RE.test(internalId)) return null;
  const out = new Uint8Array(16);
  let acc = 0;
  let bits = 0;
  let n = 0;
  for (const ch of internalId.slice(INTERNAL_ID_PREFIX.length).toUpperCase()) {
    acc = (acc << 5) | CROCKFORD_ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out[n++] = (acc >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
    acc &= (1 << bits) - 1;
  }
  return n === 16 && acc === 0 ? out : null;
}

/** The 16 bytes a User ID encodes (its base64url decoded); a TypeError for anything that isn't a User ID. */
export const userIdBytes = decodeIdentitySub;

/** The stored Support code of a User ID: the Crockford base32 of its first 5 bytes. */
export const supportCodeOf = supportCodeFromSub;

/** The Support ID of a User ID (`u1_...`). */
export const supportIdOf = supportIdFromSub;

/**
 * A Support ID as a person types it: optional `HANA-`, dashes and spaces anywhere, any case, Crockford's look-alikes
 * read as he defined them (I and L as 1, O as 0). The stored code, or null.
 */
export function parseSupportId(input: string): string | null {
  if (typeof input !== 'string' || input.length > 32) return null;
  let s = input.trim().toUpperCase().replace(/[\s-]/gu, '');
  if (s.startsWith('HANA')) s = s.slice(4);
  s = s.replace(/[IL]/gu, '1').replace(/O/gu, '0');
  return SUPPORT_CODE_RE.test(s) ? s : null;
}

// ---- search ----

export type UserSearch =
  | { kind: 'address'; chain: 'stellar' | 'evm'; address: string }
  | { kind: 'userId'; userId: string }
  | { kind: 'internalId'; internalId: string }
  | { kind: 'supportId'; code: string }
  | { kind: 'sub'; sub: string };

const STELLAR_RE = /^G[A-Z2-7]{55}$/u;
const EVM_RE = /^0x[0-9a-fA-F]{40}$/u;

/**
 * What a search string names: a Stellar `G…` or EVM `0x…` address (the API canonicalizes it), a User ID (`u1_…`, exact
 * case), a Support ID, and for staff only an internal id (`hu_…`, any case) or else a sub. Null when it can be nothing
 * (empty, too long, whitespace inside a sub) and, for a partner, for an internal id or a sub: those are never a
 * partner's search.
 */
export function parseUserSearch(input: string, opts: { staff: boolean }): UserSearch | null {
  if (typeof input !== 'string') return null;
  const q = input.trim();
  if (!q || q.length > 255) return null;
  if (STELLAR_RE.test(q)) return { kind: 'address', chain: 'stellar', address: q };
  if (EVM_RE.test(q)) return { kind: 'address', chain: 'evm', address: q };
  if (USER_ID_RE.test(q)) return { kind: 'userId', userId: q };
  if (INTERNAL_ID_RE.test(q.toLowerCase())) return opts.staff ? { kind: 'internalId', internalId: q.toLowerCase() } : null;
  const code = /^hana[\s-]?/iu.test(q) || /^[0-9a-z]{4}-?[0-9a-z]{4}$/iu.test(q) ? parseSupportId(q) : null;
  if (code) return { kind: 'supportId', code };
  if (!opts.staff || /\s/u.test(q)) return null;
  return { kind: 'sub', sub: q };
}

// ---- RPC inputs ----

const userIdInput = z.string().regex(USER_ID_RE);
const internalIdInput = z.string().regex(INTERNAL_ID_RE);
const limit = (max: number) => z.number().int().min(1).max(max);
/** A page cursor: the last row's `lastSeenAt` and User ID, as the previous answer's `nextCursor` gave them. */
export const USER_CURSOR_RE = /^\d{1,16}:u1_[A-Za-z0-9_-]{21}[AQgw]$/u;
const cursor = z.string().regex(USER_CURSOR_RE);
const search = z.string().min(1).max(255);

export const USER_PAGE_MAX = 200;
export const PARTNER_USER_PAGE_MAX = 100;

export const adminListUsersInput = ctx.extend({ orgId: orgIdInput.optional(), scopeId: scopeIdInput.optional(), cursor: cursor.optional(), limit: limit(USER_PAGE_MAX).optional() }).strict();
/** One user by its User ID (`u1_…`) or its internal id (`hu_…`): exactly one of the two. */
export const adminGetUserInput = ctx
  .extend({ userId: userIdInput.optional(), internalId: internalIdInput.optional() })
  .strict()
  .refine((v) => (v.userId === undefined) !== (v.internalId === undefined), { message: 'Give userId or internalId, exactly one' });
/** Wallet address, User ID, internal id, Support ID or sub; `provider` narrows a sub search. */
export const adminFindUsersInput = ctx.extend({ query: search, provider: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/u).optional() }).strict();
export const consoleListUsersInput = ctx
  .extend({ orgId: orgIdInput, scopeId: scopeIdInput.optional(), search: search.optional(), cursor: cursor.optional(), limit: limit(PARTNER_USER_PAGE_MAX).optional() })
  .strict();
export const consoleGetUserInput = ctx.extend({ orgId: orgIdInput, userId: userIdInput }).strict();

/**
 * The staff Users screen's app labels (C8b): the directory names apps by id only (the issuer doesn't know their org),
 * so AdminRpc.appNames reads names, orgs, scopes and environments of up to APP_NAMES_MAX ids at once, deleted apps
 * included. Staff only.
 */
export const APP_NAMES_MAX = 50;
export const adminAppNamesInput = ctx.extend({ appIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u)).min(1).max(APP_NAMES_MAX) }).strict();
export interface AppNameView {
  id: string;
  name: string;
  orgId: string;
  scopeId: string;
  environment: 'test' | 'live' | null;
  /** Soft-deleted (AdminRpc.deleteApp): still named, so a user's history reads. */
  deletedAt: number | null;
}

export type AdminListUsersInput = z.infer<typeof adminListUsersInput>;
export type AdminGetUserInput = z.infer<typeof adminGetUserInput>;
export type AdminFindUsersInput = z.infer<typeof adminFindUsersInput>;
export type ConsoleListUsersInput = z.infer<typeof consoleListUsersInput>;
export type ConsoleGetUserInput = z.infer<typeof consoleGetUserInput>;

// ---- answers ----

export type WalletChain = 'stellar' | 'evm';
export type IdentityRole = 'root' | 'member';
/** `pending` until the link's `effectiveAt` (read at answer time), then `active`; `unlinked` / `cancelled` once removed. */
export type IdentityStatus = 'active' | 'pending' | 'unlinked' | 'cancelled';

export interface WalletView {
  chain: WalletChain;
  /** G… StrKey, or EIP-55. */
  address: string;
  /** First and last login that recorded it (not on-chain activity). */
  firstSeenAt: number;
  lastUsedAt: number;
}

export interface StaffWallet extends WalletView {
  keyIndex: number;
  /**
   * How many other users list this address. 0 normally: one path, one address. More is a reused or exported key, or a
   * record made from an approved raw EVM signature (D311's residual): never treat the address as proof of who owns it.
   */
  sharedWith: number;
}

export interface StaffIdentity {
  provider: string;
  /** As on chain; null for a member Hana only saw on chain (a link made by calling the contract directly). */
  sub: string | null;
  /** hex sha256 identity key (the contract's `ik`). */
  identityKey: string;
  role: IdentityRole;
  status: IdentityStatus;
  /** A member's link activation time; null for the root. */
  effectiveAt: number | null;
  firstSeenAt: number;
  /** When the API last confirmed this row on chain. */
  observedAt: number;
  /**
   * The join point for the email (D275): DirectoryRpc's key for this identity's row in the issuer's user directory,
   * `{provider, sub}`. Null without a sub. The API never reads the directory.
   */
  directoryKey: { provider: string; sub: string } | null;
}

export interface StaffUser {
  /** The User ID: the identity token's `sub`, `u1_…` (what the partner sees and stores). */
  userId: string;
  /** `HANA-XXXX-XXXX`, the User ID's short form. */
  supportId: string;
  /** `hu_…`, the usage ledger's uid (D312): staff only, the join to the ledger's events. */
  internalId: string;
  scopeId: string;
  /** The scope's org in the hot DB, or null for a scope it doesn't hold. */
  orgId: string | null;
  createdAt: number;
  lastSeenAt: number;
  identities: StaffIdentity[];
  wallets: StaffWallet[];
  /**
   * What happened to the user's keys (D428, D430; `user_events`, newest first, at most STAFF_USER_EVENTS_MAX of each
   * kind, so signatures can't push exports out): key exports (the API's own record) and mainnet demo signatures (the
   * vault's report, bound to the user's session). Set on a detail or a search answer (AdminRpc.getUser, findUsers,
   * supportLookup); never in a list or a partner's view.
   */
  events?: StaffUserEvent[];
}

/** The most `events` of each kind a staff user answer carries. */
export const STAFF_USER_EVENTS_MAX = 20;

export interface StaffUserEvent {
  kind: 'key_exported' | 'mainnet_signature';
  appId: string;
  /** Which chain's key was exported, or null (an older export window); the signature's chain. */
  chain: WalletChain | null;
  /** A mainnet signature's network: the EVM chain ID or `pubnet`. */
  network: string | null;
  /** A mainnet signature's wallet. */
  address: string | null;
  /** A mainnet signature's value as the vault assessed it, USD micros. */
  usdMicros: number | null;
  at: number;
}

/** A partner's view of a user: never the internal id (`hu_…`), a sub, an identity key or an email. */
export interface PartnerUser {
  /** The User ID: the identity token's `sub`, `u1_…`, the same value the partner's backend stores. */
  userId: string;
  /** `HANA-XXXX-XXXX`, the User ID's short form. */
  supportId: string;
  scopeId: string;
  createdAt: number;
  lastSeenAt: number;
  /** Connected account kinds ("google", "email"), active or pending; never a sub, key or address. */
  accounts: { kind: string; status: 'active' | 'pending' }[];
  wallets: WalletView[];
}
