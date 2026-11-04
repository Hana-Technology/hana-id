// Prechecks of the email-login link calls (docs/email-login-spec.md "API changes", D133): each recomputes, from the
// API's own chain reads, what the contract will check (contracts/hana-signer/src/links.rs), in the contract's order,
// so a malformed, swapped, replayed or stale link is refused before any gas is spent. The contract re-checks all of
// it; a precheck can only refuse, never make a link the contract would refuse succeed.
import type { AccountView, IdentityView } from './link-views.ts';
import { JOIN_LINK_IDENTITY, JOIN_SESSION_IDENTITY, autoLinkNonce, identityKey } from './session-crypto.ts';
import { fromHex, hex } from './bytes.ts';

/** The contract's `MAX_MEMBERS`: an account is its root and at most 3 members. */
export const MAX_MEMBERS = 3;

export interface Side {
  provider: string;
  sub: string;
  identity: IdentityView;
  /** `get_account` of this identity: the account it is in (as root or member), or null. */
  account: AccountView | null;
}

export type LinkRefusal = { status: number; code: string; reason?: string; error: string };

const refused = (reason: string, error: string): LinkRefusal => ({ status: 422, code: 'link_refused', reason, error });
const pending = (error: string): LinkRefusal => ({ status: 409, code: 'link_pending', error });

/** links.rs `reaches_wallet`: an active member reaches its root's wallet, a pending one none, any other its own. */
const reaches = (i: IdentityView): boolean => i.status === 'member' || (i.status === 'own' && i.opened);
/** links.rs `is_linked`: a member (pending or active), or a root whose account has members. */
const isLinked = (s: Side): boolean => s.identity.status !== 'own' || (s.account !== null && s.account.members.length > 0);

/** The account root's identity key (hex) of `s`: its root's, or its own when it is in no account as a member. */
async function rootIk(scopeId: string, s: Side): Promise<string> {
  if (s.identity.status === 'own') return s.identity.key;
  const r = s.identity.root;
  if (!r) throw new Error('a member without a root');
  return hex(await identityKey(scopeId, r.provider, r.sub));
}

/** The identity key the view reports must be the one the API computes (a wrong view would only make the chain refuse). */
export async function checkKey(scopeId: string, s: Side): Promise<boolean> {
  return hex(await identityKey(scopeId, s.provider, s.sub)) === s.identity.key;
}

export interface AutoLinkCheck {
  signer: string;
  scopeId: string;
  /** sha256 of the login's session nonce preimage. */
  sessionHash: Uint8Array;
  /** The session identity (the login's token: Google, or an email token in an email-to-email case never minted). */
  session: Side;
  /** The link token's identity (the email identity). */
  link: Side;
  linkNonce: string | null;
  immediate: boolean;
}

/**
 * `create_session_and_derive` with `link_jwt` (links.rs `auto_link` after `open_session`'s settle), judged from the
 * chain reads in `c`: null when the contract would make the link the token commits to, else why not.
 */
export async function precheckAutoLink(c: AutoLinkCheck): Promise<LinkRefusal | null> {
  const { session: x, link: e, scopeId } = c;
  // open_session: the session identity may not be a pending member.
  if (x.identity.status === 'pending') return pending('This sign-in method’s link is pending');
  if (e.identity.status === 'pending') return pending('The other sign-in method’s link is pending');
  if (x.identity.key === e.identity.key) return refused('same_identity', 'Identities must differ');
  const [xRoot, eRoot] = await Promise.all([rootIk(scopeId, x), rootIk(scopeId, e)]);
  if (xRoot === eRoot) return refused('already_linked', 'Sign-in method is already linked');
  const xHas = reaches(x.identity);
  const eHas = reaches(e.identity);
  if (xHas && eHas) return refused('both_wallets', 'Both sign-in methods already have a wallet');
  // Case A: the session identity joins the link identity's account; otherwise (B, C) the link identity joins.
  const caseA = eHas;
  const [joiner, joinerSide, target, targetSide] = caseA ? [x.identity.key, x, eRoot, e] : [e.identity.key, e, xRoot, x];
  if (isLinked(joinerSide)) return refused('already_linked', 'Sign-in method is already linked');
  const targetEpoch = targetSide.identity.accountEpoch;
  const expected = await autoLinkNonce({
    signer: c.signer,
    scopeId,
    sessionHash: c.sessionHash,
    sessionIk: fromHex(x.identity.key),
    join: caseA ? JOIN_SESSION_IDENTITY : JOIN_LINK_IDENTITY,
    joinerIk: fromHex(joiner),
    targetRootIk: fromHex(target),
    targetEpoch,
    immediate: c.immediate,
  });
  if (c.linkNonce !== expected) return refused('link_mismatch', 'The link token doesn’t commit to this login, its link or the chain state now');
  if (caseA && !c.immediate) return refused('link_mismatch', 'This link must be immediate');
  // The target side's account record is the one rooted at `target` (get_account answers the account an identity is in).
  const targetAccount = targetSide.account;
  const joinerAccount = joinerSide.account;
  if (targetAccount?.unlinked.includes(joiner) || (joinerAccount && (await accountRootIk(scopeId, joinerAccount)) === joiner && joinerAccount.unlinked.includes(target))) {
    return refused('unlinked', 'This sign-in method was unlinked');
  }
  const rootProvider = targetAccount?.root.provider ?? targetSide.provider;
  return roomFor(targetAccount, rootProvider, joinerSide.provider);
}

/** links.rs `assert_room`: fewer than MAX_MEMBERS members and no sign-in method of `provider` yet (the root's included). */
export function roomFor(account: AccountView | null, rootProvider: string, provider: string): LinkRefusal | null {
  const members = account?.members ?? [];
  if (members.length >= MAX_MEMBERS) return refused('account_full', 'Account is full');
  if (rootProvider === provider || members.some((m) => m.provider === provider)) return refused('provider_taken', 'Account already has a sign-in method of this kind');
  return null;
}

/** The identity key (hex) of an account's root. */
export async function accountRootIk(scopeId: string, a: AccountView): Promise<string> {
  return hex(await identityKey(scopeId, a.root.provider, a.root.sub));
}
