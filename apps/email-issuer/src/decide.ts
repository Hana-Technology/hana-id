// The four cases (spec "The four cases"; D119, D122, D132, D133), computed from the chain exactly as the contract's
// `auto_link` will judge them (contracts/hana-signer/src/links.rs), so a token the issuer mints can only make the join
// it decided: a change of chain state makes the contract refuse it (`Link token nonce doesn't match`), never makes it do
// something else. Pure: the chain reads are the caller's.
import { fromHex, toHex } from './bytes.ts';
import type { AccountView, IdentityView } from './chain.ts';
import { type AutoLinkJoin, EMAIL_PROVIDER, JOIN_LINK_IDENTITY, JOIN_SESSION_IDENTITY, identityKey } from './layouts.ts';

/** The contract's account size (root + 3 members). */
export const MAX_MEMBERS = 3;

export type Decision =
  /** No match: the Google account's address isn't verified, or neither identity has a wallet (case C). */
  | 'none'
  /** G and E are already in one account. */
  | 'linked'
  /** One of them is a pending member: its logins are refused until the link activates (`link_pending`). */
  | 'pending'
  /** Both have a wallet (case D: can't arise after v3; nothing merges them). */
  | 'both_wallets'
  /** The pair was unlinked: automatic linking never re-matches it (an explicit link still can). */
  | 'unlinked'
  /** E has a wallet, G none: G joins E's account (at once). */
  | 'case_a'
  /** G has a wallet, E none: E joins G's account (at once if Google-hosted, else after change_delay_ms). */
  | 'case_b';

export interface Side {
  sub: string;
  identity: IdentityView;
  account: AccountView | null;
}

export interface Judgement {
  decision: Decision;
  /** The contract would accept the join (room in the account, no other member of the provider, joiner unlinked). */
  linkable: boolean;
  /** The join and its target, for the auto_link nonce (case_a and case_b when linkable). */
  join: Omit<AutoLinkJoin, 'mode'> | null;
}

/** An active member reaches its root's wallet; a pending one none; an identity outside every account its own. */
const reaches = (i: IdentityView): boolean => i.status === 'member' || (i.status === 'own' && i.opened);

/** The root identity key (hex) of an identity: its account's root, or itself. */
function rootIk(scopeId: string, s: Side): string {
  if (s.identity.status === 'own') return s.identity.key;
  const r = s.identity.root;
  if (!r) throw new Error('a member without a root');
  return toHex(identityKey(scopeId, r.provider, r.sub));
}

/** In an account: a member (pending or active), or a root that has members (links.rs `is_linked`). */
const isLinked = (s: Side): boolean => s.identity.status !== 'own' || (s.account !== null && s.account.members.length > 0);

/** The account record whose root is `ik`, if this side's account is it. */
const accountRootedAt = (scopeId: string, s: Side, ik: string): AccountView | null =>
  s.account && toHex(identityKey(scopeId, s.account.root.provider, s.account.root.sub)) === ik ? s.account : null;

export function judge(scopeId: string, google: Side, email: Side): Judgement {
  const none = (decision: Decision, linkable = false): Judgement => ({ decision, linkable, join: null });
  if (google.identity.status === 'pending' || email.identity.status === 'pending') return none('pending');
  const gRoot = rootIk(scopeId, google);
  const eRoot = rootIk(scopeId, email);
  if (gRoot === eRoot) return none('linked');
  const gHas = reaches(google.identity);
  const eHas = reaches(email.identity);
  if (gHas && eHas) return none('both_wallets');
  if (!gHas && !eHas) return none('none');

  // Case A: G (the session identity) joins E's account. Case B: E (the link identity) joins G's.
  const caseA = eHas;
  const [joiner, joinerProvider, target, targetSide, joinerSide] = caseA
    ? [google.identity.key, 'google', eRoot, email, google]
    : [email.identity.key, EMAIL_PROVIDER, gRoot, google, email];
  const targetAccount = accountRootedAt(scopeId, targetSide, target);
  const joinerAccount = accountRootedAt(scopeId, joinerSide, joiner);
  // links.rs `unlinked_pair`: either was unlinked from the other's account.
  if (targetAccount?.unlinked.includes(joiner) || joinerAccount?.unlinked.includes(target)) return none('unlinked');
  const decision: Decision = caseA ? 'case_a' : 'case_b';
  // links.rs: the joiner is in no account; the target account has room and no sign-in method of the joiner's kind.
  const rootProvider = targetAccount?.root.provider ?? (caseA ? EMAIL_PROVIDER : 'google');
  const members = targetAccount?.members ?? [];
  const linkable = !isLinked(joinerSide) && members.length < MAX_MEMBERS && rootProvider !== joinerProvider && !members.some((m) => m.provider === joinerProvider);
  if (!linkable) return none(decision);
  return {
    decision,
    linkable,
    join: {
      join: caseA ? JOIN_SESSION_IDENTITY : JOIN_LINK_IDENTITY,
      joinerIk: fromHex(joiner),
      targetRootIk: fromHex(target),
      targetEpoch: targetSide.identity.accountEpoch,
    },
  };
}
