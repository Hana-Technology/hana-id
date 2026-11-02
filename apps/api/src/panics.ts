// hana-signer panics the API turns into errors a client can act on (docs/api.md "Errors"). Only a failure in the
// signer's own receipt (`contract_rejected`, executor SIGNER_ACCOUNT) is read, and only its known messages
// (docs/contract-interface.md "Panics"); the panic text itself is returned as `error`, as for every contract refusal,
// and never logged.
import type { Env } from './env.ts';
import type { RelayResult } from './relayer-key.ts';

type Failure = Extract<RelayResult, { ok: false }>;

/** Panics that are a state of the user's sign-in methods, not a bad request: their own code, 409. */
const STATE_PANICS: readonly [string, string][] = [
  // D135: after the v3 migration every link waits until the owner accepts the wallets opened before v3.
  ['Links wait until the owner accepts the wallets opened before v3', 'links_unavailable'],
  // D136: the session's own path identity joined an account since the session opened; the vault signs in again.
  ['Sign-in method is linked to an account', 'identity_linked'],
  // The session's (or an acting) identity is a pending member: refused until the link activates or is cancelled.
  ['Sign-in method link is pending', 'link_pending'],
];

/** Link refusals (contract_rejected, 422), each with a `reason` (docs/api.md "Links"). */
const LINK_PANICS: readonly [string, string][] = [
  ['Link token nonce doesn', 'link_mismatch'],
  ['Link nonce doesn', 'link_mismatch'],
  ['This link must be immediate', 'link_mismatch'],
  ['Link token must come from a self-issued issuer', 'link_mismatch'],
  ['Both sign-in methods already have a wallet', 'both_wallets'],
  ['This sign-in method was unlinked', 'unlinked'],
  ['Account is full', 'account_full'],
  ['Account already has a sign-in method of this kind', 'provider_taken'],
  ['Sign-in method is already linked', 'already_linked'],
  ['Sign-in method already has a wallet', 'has_wallet'],
  ['Identities must differ', 'same_identity'],
  ['Wrong epoch', 'stale_epoch'],
  ['No such member', 'no_such_member'],
  ['Sign-in method is not in this account', 'not_in_account'],
  ['Only the root or the member itself can unlink', 'not_allowed'],
  ['Cannot unlink the root', 'cannot_unlink_root'],
];

export interface MappedPanic {
  status: number;
  body: { error: string; code: string; reason?: string };
}

/** The error for a known signer panic of the email-login methods, or null (the caller keeps its own answer). */
export function signerPanic(env: Pick<Env, 'SIGNER_ACCOUNT'>, result: Failure): MappedPanic | null {
  if (result.code !== 'contract_rejected' || result.executor !== env.SIGNER_ACCOUNT) return null;
  const state = STATE_PANICS.find(([needle]) => result.error.includes(needle));
  if (state) return { status: 409, body: { error: result.error, code: state[1] } };
  const link = LINK_PANICS.find(([needle]) => result.error.includes(needle));
  if (link) return { status: 422, body: { error: result.error, code: 'contract_rejected', reason: link[1] } };
  return null;
}
