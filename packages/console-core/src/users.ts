// End users and their wallets (D310, D312–D315): the user id and the Support ID, the search a staff or partner query
// is read as, the RPC inputs of AdminRpc's and ConsoleRpc's user methods, and what each side gets back. The API is the
// only writer (apps/api/src/directory/), from the vault's wallet record and the API's own chain reads.
//
// - **User id** (D312): "hu_" ‖ Crockford base32, lowercase, of the 16-byte uid (layouts.ts `uid`: HMAC-SHA256 of
//   USER_ID_KEY over the scope and the account root's provider and sub, the usage ledger's pseudonym, D96). Stable per
//   scope and account; a linked member shares its root's. 26 characters after the prefix (130 bits: the last 2 zero).
// - **Support ID** (D276): "HANA-XXXX-XXXX", the first 8 of those characters, uppercase: the uid's first 40 bits
//   (exactly 5 bytes), so it is the user id's short form and the ledger's uid prefix at once.
//
// Partners get the user id, the Support ID, times, connected account kinds and wallet addresses (`PartnerUser`), never
// a sub, an identity key or an email. Staff get the identities with their subs (`StaffUser`); the email comes from the
// issuer's directory through D275's DirectoryRpc, keyed by `directoryKey` (the join point; this package and the API
// never read the issuer).
import { z } from 'zod';
import { ctx } from './types.ts';
import { orgIdInput, scopeIdInput } from './rpc.ts';

export const USER_ID_PREFIX = 'hu_';
export const SUPPORT_ID_PREFIX = 'HANA-';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const USER_ID_RE = /^hu_[0-9a-hjkmnp-tv-z]{26}$/u;
/** The stored form of a Support ID (8 Crockford characters, uppercase, no prefix or dash). */
export const SUPPORT_CODE_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/u;

/** Crockford base32 (uppercase), most significant bit first, the last group zero-padded. */
export function crockford32(bytes: Uint8Array): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += CROCKFORD[(acc << (5 - bits)) & 31];
  return out;
}

/** The user id of a 16-byte uid. */
export function userIdOf(uidBytes: Uint8Array): string {
  if (!(uidBytes instanceof Uint8Array) || uidBytes.length !== 16) throw new TypeError('A uid is 16 bytes');
  return USER_ID_PREFIX + crockford32(uidBytes).toLowerCase();
}

/**
 * The 16-byte uid of a user id (userIdOf's inverse; the erasure script, D361), or null when it isn't one: wrong
 * prefix, length or alphabet, or the last character's two padding bits set (no uid encodes to it).
 */
export function uidOfUserId(userId: string): Uint8Array | null {
  if (!USER_ID_RE.test(userId)) return null;
  const out = new Uint8Array(16);
  let acc = 0;
  let bits = 0;
  let n = 0;
  for (const ch of userId.slice(USER_ID_PREFIX.length).toUpperCase()) {
    acc = (acc << 5) | CROCKFORD.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out[n++] = (acc >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
    acc &= (1 << bits) - 1;
  }
  return n === 16 && acc === 0 ? out : null;
}

/** The stored Support code of a user id (its first 8 characters, uppercase). */
export function supportCodeOf(userId: string): string {
  if (!USER_ID_RE.test(userId)) throw new TypeError('Not a user id');
  return userId.slice(USER_ID_PREFIX.length, USER_ID_PREFIX.length + 8).toUpperCase();
}

/** `HANA-XXXX-XXXX` as shown to people. */
export const formatSupportId = (code: string): string => `${SUPPORT_ID_PREFIX}${code.slice(0, 4)}-${code.slice(4, 8)}`;
export const supportIdOf = (userId: string): string => formatSupportId(supportCodeOf(userId));

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
  | { kind: 'supportId'; code: string }
  | { kind: 'sub'; sub: string };

const STELLAR_RE = /^G[A-Z2-7]{55}$/u;
const EVM_RE = /^0x[0-9a-fA-F]{40}$/u;

/**
 * What a search string names: a Stellar `G…` or EVM `0x…` address (the API canonicalizes it), a user id, a Support ID,
 * else (staff only) a sub. Null when it can be nothing (empty, too long, whitespace inside a sub).
 */
export function parseUserSearch(input: string, opts: { allowSub: boolean }): UserSearch | null {
  if (typeof input !== 'string') return null;
  const q = input.trim();
  if (!q || q.length > 255) return null;
  if (STELLAR_RE.test(q)) return { kind: 'address', chain: 'stellar', address: q };
  if (EVM_RE.test(q)) return { kind: 'address', chain: 'evm', address: q };
  if (USER_ID_RE.test(q.toLowerCase())) return { kind: 'userId', userId: q.toLowerCase() };
  const code = /^hana[\s-]?/iu.test(q) || /^[0-9a-z]{4}-?[0-9a-z]{4}$/iu.test(q) ? parseSupportId(q) : null;
  if (code) return { kind: 'supportId', code };
  if (!opts.allowSub || /\s/u.test(q)) return null;
  return { kind: 'sub', sub: q };
}

// ---- RPC inputs ----

const userIdInput = z.string().regex(USER_ID_RE);
const limit = (max: number) => z.number().int().min(1).max(max);
/** A page cursor: the last row's `lastSeenAt` and user id, as the previous answer's `nextCursor` gave them. */
export const USER_CURSOR_RE = /^\d{1,16}:hu_[0-9a-hjkmnp-tv-z]{26}$/u;
const cursor = z.string().regex(USER_CURSOR_RE);
const search = z.string().min(1).max(255);

export const USER_PAGE_MAX = 200;
export const PARTNER_USER_PAGE_MAX = 100;

export const adminListUsersInput = ctx.extend({ orgId: orgIdInput.optional(), scopeId: scopeIdInput.optional(), cursor: cursor.optional(), limit: limit(USER_PAGE_MAX).optional() }).strict();
export const adminGetUserInput = ctx.extend({ userId: userIdInput }).strict();
/** Wallet address, user id, Support ID or sub; `provider` narrows a sub search. */
export const adminFindUsersInput = ctx.extend({ query: search, provider: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/u).optional() }).strict();
export const consoleListUsersInput = ctx
  .extend({ orgId: orgIdInput, scopeId: scopeIdInput.optional(), search: search.optional(), cursor: cursor.optional(), limit: limit(PARTNER_USER_PAGE_MAX).optional() })
  .strict();
export const consoleGetUserInput = ctx.extend({ orgId: orgIdInput, userId: userIdInput }).strict();

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
  userId: string;
  supportId: string;
  scopeId: string;
  /** The scope's org in the hot DB, or null for a scope it doesn't hold. */
  orgId: string | null;
  createdAt: number;
  lastSeenAt: number;
  identities: StaffIdentity[];
  wallets: StaffWallet[];
}

export interface PartnerUser {
  userId: string;
  supportId: string;
  scopeId: string;
  createdAt: number;
  lastSeenAt: number;
  /** Connected account kinds ("google", "email"), active or pending; never a sub, key or address. */
  accounts: { kind: string; status: 'active' | 'pending' }[];
  wallets: WalletView[];
}
