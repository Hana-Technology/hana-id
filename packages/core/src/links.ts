// Accounts and links, browser side (docs/email-login-spec.md "Automatic linking", "Link methods", "Byte layouts
// (new)"; docs/contract-interface.md "Accounts and links"): the identity key, the link nonces, the linked CKD payload,
// the `get_identity` / `get_account` views, and the two judgements the vault makes from its own chain reads:
//
// - pathIdentity: the identity whose own path a session of (provider, sub) derives (batch 7): itself when it is
//   "own", its account root when it is an active member; a pending member derives nothing (`link_pending`).
// - judgeAutoLink: what `create_session_and_derive` with a `link_jwt` will do (contracts/hana-signer/src/links.rs
//   `auto_link`, the same order as apps/api link-precheck.ts), and the `auto_link` nonce the link token must carry
//   for it (D133). The vault signs the linked CKD payload only when the token's nonce is exactly that one.
//
// test/links.test.ts checks every layout against contracts/hana-signer/src/email_fixture.json (written by
// scripts/gen-email-fixtures.mjs, an independent implementation).
import { hmac } from '@noble/hashes/hmac';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2';
import { type Bytes, base64UrlEncode, borshString, concatBytes, fromHex, sha256, toBytes, toHex, u64le, utf8 } from './bytes.ts';
import { type SessionNonceInput, relayIdFor, sessionNoncePreimage } from './layouts.ts';

export const IDENTITY_DOMAIN = 'hana-id/identity/v1';
export const LINK_NEW_DOMAIN = 'hana-id/link-new/v1';
export const LINK_ACCOUNT_DOMAIN = 'hana-id/link-account/v1';
export const LINK_CHANGE_DOMAIN = 'hana-id/link-change/v1';
export const AUTO_LINK_DOMAIN = 'hana-id/auto-link/v1';
export const CKD_LINK_PREFIX = 'hana-id-ckd-link-v1:';
/** `join` 1: the session identity joins the link identity's account (case A). */
export const JOIN_SESSION_IDENTITY = 1;
/** `join` 2: the link identity joins the session identity's account (cases B and C). */
export const JOIN_LINK_IDENTITY = 2;
/** The contract's `MAX_MEMBERS`: an account is its root and at most 3 members. */
export const MAX_MEMBERS = 3;

const ik32 = (ik: Uint8Array): Bytes => {
  if (ik.length !== 32) throw new Error('An identity key is 32 bytes');
  return toBytes(ik);
};
const nonceOf = (preimage: Uint8Array): string => base64UrlEncode(sha256(preimage));

/** `ik = sha256("hana-id/identity/v1" ‖ borsh(scope_id) ‖ borsh(provider) ‖ borsh(sub))`. */
export const identityKey = (scopeId: string, provider: string, sub: string): Bytes => sha256(concatBytes(utf8(IDENTITY_DOMAIN), borshString(scopeId), borshString(provider), borshString(sub)));
/** The identity key in the views' form: 64 lowercase hex characters. */
export const identityKeyHex = (scopeId: string, provider: string, sub: string): string => toHex(identityKey(scopeId, provider, sub));

/** link_new = "hana-id/link-new/v1" ‖ borsh(signer) ‖ borsh(scope_id) ‖ root_ik ‖ borsh(new provider) ‖ epoch u64 LE ‖ salt */
export const linkNewNonce = (signer: string, scopeId: string, rootIk: Uint8Array, newProvider: string, epoch: number, salt: Uint8Array): string =>
  nonceOf(concatBytes(utf8(LINK_NEW_DOMAIN), borshString(signer), borshString(scopeId), ik32(rootIk), borshString(newProvider), u64le(epoch), salt));

/** link_account = "hana-id/link-account/v1" ‖ borsh(signer) ‖ borsh(scope_id) ‖ root_ik ‖ new_ik ‖ epoch u64 LE ‖ salt */
export const linkAccountNonce = (signer: string, scopeId: string, rootIk: Uint8Array, newIk: Uint8Array, epoch: number, salt: Uint8Array): string =>
  nonceOf(concatBytes(utf8(LINK_ACCOUNT_DOMAIN), borshString(signer), borshString(scopeId), ik32(rootIk), ik32(newIk), u64le(epoch), salt));

/** link_change = "hana-id/link-change/v1" ‖ borsh(signer) ‖ borsh(scope_id) ‖ borsh(action) ‖ root_ik ‖ member_ik ‖ epoch u64 LE ‖ salt */
export const linkChangeNonce = (signer: string, scopeId: string, action: 'cancel' | 'unlink', rootIk: Uint8Array, memberIk: Uint8Array, epoch: number, salt: Uint8Array): string =>
  nonceOf(concatBytes(utf8(LINK_CHANGE_DOMAIN), borshString(signer), borshString(scopeId), borshString(action), ik32(rootIk), ik32(memberIk), u64le(epoch), salt));

export interface AutoLinkInput {
  signer: string;
  scopeId: string;
  /** sha256 of the login's session nonce preimage. */
  sessionHash: Uint8Array;
  sessionIk: Uint8Array;
  join: typeof JOIN_SESSION_IDENTITY | typeof JOIN_LINK_IDENTITY;
  joinerIk: Uint8Array;
  targetRootIk: Uint8Array;
  /** The target account's epoch (0 for none yet). */
  targetEpoch: number;
  /** `link_immediate` (mode 1), else after `change_delay_ms` (mode 0). */
  immediate: boolean;
}

/**
 * auto_link = "hana-id/auto-link/v1" ‖ borsh(signer) ‖ borsh(scope_id) ‖ sha256(session nonce preimage) ‖ session_ik
 * ‖ join u8 ‖ joiner_ik ‖ target_root_ik ‖ target epoch u64 LE ‖ mode u8
 */
export function autoLinkNonce(i: AutoLinkInput): string {
  if (i.sessionHash.length !== 32) throw new Error('The session hash is 32 bytes');
  return nonceOf(
    concatBytes(
      utf8(AUTO_LINK_DOMAIN),
      borshString(i.signer),
      borshString(i.scopeId),
      toBytes(i.sessionHash),
      ik32(i.sessionIk),
      Uint8Array.of(i.join),
      ik32(i.joinerIk),
      ik32(i.targetRootIk),
      u64le(i.targetEpoch),
      Uint8Array.of(i.immediate ? 1 : 0),
    ),
  );
}

/** sha256 of a session's nonce preimage (what the `auto_link` nonce commits to). The preimage is zeroed. */
export function sessionHashOf(i: SessionNonceInput): Bytes {
  const preimage = sessionNoncePreimage(i);
  try {
    return sha256(preimage);
  } finally {
    preimage.fill(0);
  }
}

/** The linked CKD payload the session key signs (counter 1) in a login that carries `link_jwt` (D133). */
export const linkedCkdPayload = (pk1: string, pk2: string, linkJwt: string, immediate: boolean): Bytes =>
  concatBytes(utf8(CKD_LINK_PREFIX), sha256(utf8(linkJwt)), Uint8Array.of(immediate ? 1 : 0), utf8(`${pk1}:${pk2}`));

// ---- views ----

export interface IdentityRef {
  provider: string;
  sub: string;
}

/** `get_identity(scope_id, provider, sub)`. */
export interface IdentityView {
  /** Its identity key, hex. */
  key: string;
  status: 'own' | 'member' | 'pending';
  /** Its own path was derived once: it "has a wallet" (D130). */
  opened: boolean;
  /** The account root, for `member` and `pending`. */
  root: IdentityRef | null;
  effectiveAtMs: number | null;
  /** The epoch of its account (its root's), 0 without one. */
  accountEpoch: number;
}

export interface AccountMember {
  key: string;
  provider: string;
  effectiveAtMs: number;
  active: boolean;
  auto: boolean;
}

/** `get_account(scope_id, provider, sub)`: the account an identity is in (as root or member), or null. */
export interface AccountView {
  root: IdentityRef;
  members: AccountMember[];
  epoch: number;
  /** Identity keys (hex) unlinked from it: automatic linking never re-adds them. */
  unlinked: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isHex32 = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/u.test(v);
const isSubLike = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= 255 && !v.includes('#');
const isRef = (v: unknown): v is IdentityRef => isObj(v) && typeof v.provider === 'string' && /^[a-z]{1,16}$/u.test(v.provider) && isSubLike(v.sub);
const isU64 = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/** A view answer without the documented shape (a contract older than v3, or a broken RPC). */
export class ViewShapeError extends Error {}

export function parseIdentityView(raw: unknown): IdentityView {
  if (!isObj(raw) || !isHex32(raw.key) || !['own', 'member', 'pending'].includes(raw.status as string) || typeof raw.opened !== 'boolean' || !isU64(raw.account_epoch)) {
    throw new ViewShapeError('get_identity');
  }
  const root = raw.root === null || raw.root === undefined ? null : isRef(raw.root) ? { provider: raw.root.provider, sub: raw.root.sub } : undefined;
  if (root === undefined) throw new ViewShapeError('get_identity root');
  const status = raw.status as IdentityView['status'];
  if ((status === 'own') !== (root === null)) throw new ViewShapeError('get_identity root');
  const eff = raw.effective_at_ms;
  if (eff !== undefined && eff !== null && !isU64(eff)) throw new ViewShapeError('get_identity effective_at_ms');
  return { key: raw.key, status, opened: raw.opened, root, effectiveAtMs: isU64(eff) ? eff : null, accountEpoch: raw.account_epoch };
}

export function parseAccountView(raw: unknown): AccountView | null {
  if (raw === null) return null;
  if (!isObj(raw) || !isRef(raw.root) || !Array.isArray(raw.members) || raw.members.length > MAX_MEMBERS || !isU64(raw.epoch) || !Array.isArray(raw.unlinked)) {
    throw new ViewShapeError('get_account');
  }
  const members = raw.members.map((m) => {
    if (!isObj(m) || !isHex32(m.key) || typeof m.provider !== 'string' || !isU64(m.effective_at_ms) || typeof m.active !== 'boolean' || typeof m.auto !== 'boolean') {
      throw new ViewShapeError('get_account member');
    }
    return { key: m.key, provider: m.provider, effectiveAtMs: m.effective_at_ms, active: m.active, auto: m.auto };
  });
  if (raw.unlinked.length > 8 || !raw.unlinked.every(isHex32)) throw new ViewShapeError('get_account unlinked');
  return { root: { provider: raw.root.provider, sub: raw.root.sub }, members, epoch: raw.epoch, unlinked: raw.unlinked as string[] };
}

// ---- judgements ----

/** The path identity of a session of `self` (D119, contract `open_session`), or `pending` (no session opens). */
export type PathIdentity = { kind: 'path'; identity: IdentityRef; linked: boolean } | { kind: 'pending'; effectiveAtMs: number | null };

/**
 * Which identity's own path a session of `self` derives, from `get_identity` on the vault's own RPC. The view's key
 * must be the one computed here (a wrong view could only point the vault at another path, which the CKD pairing
 * check would then refuse; it is refused first).
 */
export function pathIdentity(scopeId: string, self: IdentityRef, view: IdentityView): PathIdentity {
  if (view.key !== identityKeyHex(scopeId, self.provider, self.sub)) throw new ViewShapeError('get_identity key');
  if (view.status === 'pending') return { kind: 'pending', effectiveAtMs: view.effectiveAtMs };
  if (view.status === 'member') return { kind: 'path', identity: view.root as IdentityRef, linked: true };
  return { kind: 'path', identity: { provider: self.provider, sub: self.sub }, linked: false };
}

/** One side of a link judgement: an identity, its `get_identity` and its `get_account`. */
export interface LinkSide {
  ref: IdentityRef;
  identity: IdentityView;
  account: AccountView | null;
}

export type LinkRefusalReason = 'pending' | 'same_identity' | 'already_linked' | 'both_wallets' | 'unlinked' | 'account_full' | 'provider_taken' | 'not_immediate';

export type AutoLinkJudgement =
  | {
      ok: true;
      /** 1: the session identity joins the link identity's account (case A); 2: the link identity joins (B, C). */
      join: typeof JOIN_SESSION_IDENTITY | typeof JOIN_LINK_IDENTITY;
      /** The `auto_link` nonce the link token must carry for this join, this session and `immediate`. */
      nonce: string;
      /** The identity whose own path the login derives once the link is made (the account's root). */
      pathIdentity: IdentityRef;
    }
  | { ok: false; reason: LinkRefusalReason };

/** links.rs `reaches_wallet`: an active member reaches its root's wallet, a pending one none, any other its own. */
const reaches = (i: IdentityView): boolean => i.status === 'member' || (i.status === 'own' && i.opened);
/** links.rs `is_linked`: a member (pending or active), or a root whose account has members. */
const isLinked = (s: LinkSide): boolean => s.identity.status !== 'own' || (s.account !== null && s.account.members.length > 0);
const rootRef = (s: LinkSide): IdentityRef => (s.identity.status === 'own' ? s.ref : (s.identity.root as IdentityRef));

export interface AutoLinkCheck {
  signer: string;
  scopeId: string;
  sessionHash: Uint8Array;
  /** The login's own identity (its token signs the session). */
  session: LinkSide;
  /** The link token's identity (an email identity). */
  link: LinkSide;
  immediate: boolean;
}

/**
 * What the contract will do with this login's link, judged from the vault's own reads (links.rs `auto_link` after
 * `open_session`, in its order), and the nonce the link token must carry for it. Every key the views report is checked
 * against the one computed here. A judgement can only refuse: the contract re-checks all of it.
 */
export function judgeAutoLink(c: AutoLinkCheck): AutoLinkJudgement {
  const { session: x, link: e, scopeId } = c;
  for (const s of [x, e]) if (s.identity.key !== identityKeyHex(scopeId, s.ref.provider, s.ref.sub)) throw new ViewShapeError('get_identity key');
  if (x.identity.status === 'pending' || e.identity.status === 'pending') return { ok: false, reason: 'pending' };
  if (x.identity.key === e.identity.key) return { ok: false, reason: 'same_identity' };
  const xRoot = rootRef(x);
  const eRoot = rootRef(e);
  const xRootIk = identityKeyHex(scopeId, xRoot.provider, xRoot.sub);
  const eRootIk = identityKeyHex(scopeId, eRoot.provider, eRoot.sub);
  if (xRootIk === eRootIk) return { ok: false, reason: 'already_linked' };
  const xHas = reaches(x.identity);
  const eHas = reaches(e.identity);
  if (xHas && eHas) return { ok: false, reason: 'both_wallets' };
  const caseA = eHas;
  const joinerSide = caseA ? x : e;
  const targetSide = caseA ? e : x;
  const target = caseA ? eRoot : xRoot;
  const targetIk = caseA ? eRootIk : xRootIk;
  if (isLinked(joinerSide)) return { ok: false, reason: 'already_linked' };
  if (caseA && !c.immediate) return { ok: false, reason: 'not_immediate' };
  const joiner = joinerSide.identity.key;
  const targetAccount = targetSide.account;
  const joinerAccount = joinerSide.account;
  const joinerRootsOwn = joinerAccount !== null && identityKeyHex(scopeId, joinerAccount.root.provider, joinerAccount.root.sub) === joiner;
  if (targetAccount?.unlinked.includes(joiner) || (joinerRootsOwn && joinerAccount?.unlinked.includes(targetIk))) return { ok: false, reason: 'unlinked' };
  const members = targetAccount?.members ?? [];
  if (members.length >= MAX_MEMBERS) return { ok: false, reason: 'account_full' };
  const rootProvider = targetAccount?.root.provider ?? target.provider;
  if (rootProvider === joinerSide.ref.provider || members.some((m) => m.provider === joinerSide.ref.provider)) return { ok: false, reason: 'provider_taken' };
  const nonce = autoLinkNonce({
    signer: c.signer,
    scopeId,
    sessionHash: c.sessionHash,
    sessionIk: fromHex(x.identity.key),
    join: caseA ? JOIN_SESSION_IDENTITY : JOIN_LINK_IDENTITY,
    joinerIk: fromHex(joiner),
    targetRootIk: fromHex(targetIk),
    targetEpoch: targetSide.identity.accountEpoch,
    immediate: c.immediate,
  });
  return { ok: true, join: caseA ? JOIN_SESSION_IDENTITY : JOIN_LINK_IDENTITY, nonce, pathIdentity: target };
}

// ---- the login popup's follow-up slots (vault ↔ popup after Google's answer) ----

export const RELAY_FOLLOW_DOMAIN = 'hana-id/relay-follow/v1';
export const FOLLOW_KEY_BYTES = 32;
/** Follow-up slots per login. */
export const FOLLOW_SLOTS = 12;

/**
 * Slot `n` (1..FOLLOW_SLOTS) of a login's follow-up channel: its read key `HMAC-SHA256(followKey, "hana-id/relay-
 * follow/v1" ‖ u8 n)` and its relay id `b64url(sha256(read key))`. The vault and the popup both hold `followKey`;
 * each slot is a write-once, read-once relay slot like the login's first one, its value encrypted under the login's
 * relayKey with the slot's own AAD (so a value can't be moved to another slot).
 */
export function followSlot(followKey: Uint8Array, n: number): { readKey: Bytes; id: string } {
  if (followKey.length !== FOLLOW_KEY_BYTES) throw new Error(`followKey must be ${FOLLOW_KEY_BYTES} bytes`);
  if (!Number.isInteger(n) || n < 1 || n > FOLLOW_SLOTS) throw new RangeError(`A follow-up slot is 1..${FOLLOW_SLOTS}`);
  const readKey = toBytes(hmac(nobleSha256, followKey, concatBytes(utf8(RELAY_FOLLOW_DOMAIN), Uint8Array.of(n))));
  return { readKey, id: relayIdFor(readKey) };
}
