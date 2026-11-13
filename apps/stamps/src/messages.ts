// Plain words for what can go wrong on the stamps site (D801): the SDK's refusals (a HanaError's code, `data.reason`
// and `data.status`, read by the demo's `errorInfo`), the vault's NEAR refusals, Journear's relayer's refusals of
// `POST /v1/near/relay` and `/activate`, the contract's `ERR_*` panics (from the relay's error text or NEAR's own
// failure), and the page's own NEAR reads. Every text is ours: what came from the chain or the network is never shown
// raw (only an `ERR_*` code is matched, and mapped).
import { errorInfo, isSignedOut, relayTransaction } from '../../demo/src/errors.ts';
import { CONTRACT_ERRORS, contractErrorCode } from './stamps.ts';

export { errorInfo, isSignedOut, relayTransaction };

export type StampsAction = 'load' | 'login' | 'logout' | 'collect' | 'copy' | 'read';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** The page's own failures (src/collector.ts), with codes this module maps. */
export type PageErrorCode = 'near_page_rpc_failed' | 'near_account_pending' | 'near_send_failed' | 'near_nonce_wait' | 'near_not_enough_balance' | 'stamps_contract_refused';

export const pageError = (code: PageErrorCode, message: string, data?: Record<string, unknown>): Error => Object.assign(new Error(message), { code, ...(data ? { data } : {}) });

export const SIGNED_OUT_MESSAGE = 'You were signed out on this device (from Passport Home, another tab or another device). Sign in again.';

/** The vault's NEAR refusals (4100 with `data.reason`). Each is about a request the page built: trying again reads afresh. */
const VAULT_REASONS: Readonly<Record<string, string>> = {
  near_key_unknown: 'Your NEAR account doesn’t exist on testnet yet. Try again: the site creates it first.',
  near_block_unknown: 'Journear couldn’t find this request’s block on NEAR testnet. Try again.',
  near_network_mismatch: 'Refused: this request names a block of another NEAR network.',
  near_delegate_nonce_used: 'That request’s number was already used (another tab?). Try again: the site reads a fresh one.',
  near_delegate_nonce_too_large: 'Journear refused the request’s number for NEAR testnet’s current block. Wait a few seconds and try again.',
  near_delegate_expiry: 'The request expired before it was approved. Try again.',
  near_delegate_nonce_stale: 'That request was prepared too long ago. Try again: the site reads a fresh one.',
  near_relayed_delegate: 'Refused: Journear doesn’t sign a transaction that relays someone else’s request.',
  near_delegate_test_app_action: 'Refused: a test app’s gasless request may only call a contract.',
  near_delegate_test_app_receiver: 'Refused: a test app’s gasless request may only go to a testnet contract.',
};

/** The relayer's refusals, by the API's code (docs/api.md "NEAR relay"). */
const RELAYER_REASONS: Readonly<Record<string, string>> = {
  near_account_unrecorded: 'Journear is still setting up your NEAR account (it takes a few seconds after you sign in). Try again in a moment.',
  directory_unavailable: 'Journear couldn’t check your NEAR account right now. Try again in a minute.',
  receiver_not_allowed: 'Journear’s relayer doesn’t pay for the stamps contract on this environment yet. Tell the Journear team.',
  action_not_allowed: 'Journear’s relayer pays only for contract calls, and refused this request.',
  deposit_not_allowed: 'Journear’s relayer refused a request that attaches NEAR: stamps need none.',
  gas_too_high: 'Journear’s relayer refused the request’s gas. Tell the Journear team.',
  sender_not_implicit: 'Journear’s relayer acts only for Journear Passport’s own NEAR accounts.',
  bad_delegate: 'Journear’s relayer could not read the signed request. Try again.',
  bad_delegate_signature: 'Journear’s relayer found the request’s signature invalid. Try again.',
  bad_request: 'Journear’s relayer could not read the request. Try again.',
  mainnet_not_allowed: 'Journear’s relayer works on NEAR testnet only.',
  account_not_activated: 'Your NEAR account doesn’t exist on testnet yet. Try again: the site creates it first.',
  access_key_missing: 'Your NEAR account has no Journear key on testnet any more, so the relayer can’t act for it.',
  delegate_nonce_used: 'That request’s number was already used (another tab?). Try again: the site reads a fresh one.',
  delegate_nonce_too_large: 'Journear’s relayer refused the request’s number for the current block. Wait a few seconds and try again.',
  delegate_expired: 'The signed request expired before the relayer sent it. Try again.',
  block_height_too_far: 'The signed request expires too far ahead for Journear’s relayer. Try again.',
  already_relayed: 'Journear’s relayer sent this exact request a moment ago. Refresh to see the stamp.',
  delegate_rejected: 'NEAR testnet refused the signed request. Try again: the site reads a fresh number and block.',
  near_rejected: 'NEAR testnet refused the relayed transaction. Try again; Refresh shows whether it landed.',
  near_error: 'NEAR testnet returned an error for the relayed transaction. Try again; Refresh shows whether it landed.',
  near_unavailable: 'Journear’s relayer couldn’t reach NEAR testnet. Try again in a minute.',
  timeout: 'NEAR testnet hasn’t confirmed the transaction yet: it may still land. Refresh in a moment to see.',
  app_budget_exhausted: 'The site has used up today’s free NEAR transactions. Try again tomorrow (UTC).',
  relay_budget_exhausted: 'Today’s free NEAR transactions are used up. Try again tomorrow (UTC).',
  relayer_busy: 'Journear’s relayer is busy. Try again in a moment.',
  not_enough_balance: 'Journear’s relayer is low on testnet NEAR right now. Tell the Journear team.',
  relayer_unavailable: 'Journear’s relayer is unavailable right now. Try again in a minute.',
  relayer_unconfigured: 'Journear’s relayer isn’t set up on this environment yet. Tell the Journear team.',
  rate_limiter_unavailable: 'Journear’s relayer is unavailable right now. Try again in a minute.',
};

const REPORT = 'If it keeps happening, tell the Journear team.';

/** What to tell the user, for an error of `action`. */
export function plainMessage(e: unknown, action: StampsAction): string {
  const info = errorInfo(e);
  const { code, reason } = info;
  // The contract's own refusal, wherever it came from (the relay's 422 `contract_rejected`, NEAR's failure of an
  // own-fare transaction): only a known ERR_* code is shown, in our words.
  if (reason === 'contract_rejected' || code === 'stamps_contract_refused') {
    const err = contractErrorCode(info.message);
    return err ? CONTRACT_ERRORS[err]! : 'The stamps contract refused this stamp. Nothing was stored.';
  }
  switch (code) {
    case 'near_page_rpc_failed':
      return 'This page couldn’t read NEAR testnet (its RPC didn’t answer). Check your connection and try again.';
    case 'near_account_pending':
      return 'Journear’s relayer is still creating your NEAR account. Wait a few seconds and try again.';
    case 'near_nonce_wait':
      return 'NEAR testnet needs a new block before this request. Wait a few seconds and try again.';
    case 'near_send_failed':
      return 'NEAR testnet refused or failed the transaction. Refresh to check, then try again.';
    case 'near_not_enough_balance':
      return 'Your account doesn’t hold enough testnet NEAR for the fee. Get some from the faucet, then try again.';
    default:
      break;
  }
  if (code === 4100 && reason !== null && Object.hasOwn(VAULT_REASONS, reason)) return VAULT_REASONS[reason]!;
  if (code === 'api_unavailable' && reason === 'near_rpc_unavailable') return 'Journear couldn’t reach NEAR testnet to check this request. Try again in a minute.';
  // The relayer's answers carry their HTTP status in data.status (the SDK's relay and activate); the vault's don't.
  const fromRelayer = isObj(e) && isObj(e.data) && typeof e.data.status === 'number';
  if (fromRelayer) {
    if (reason !== null && Object.hasOwn(RELAYER_REASONS, reason)) return RELAYER_REASONS[reason]!;
    if (code === 'rate_limited') return 'Too many stamps from this site in a short time. Wait a minute and try again.';
    if (code === 4100) return `Journear’s relayer refused this request${reason ? ` (${reason})` : ''}. ${REPORT}`;
    if (code === 'api_unavailable') return 'Could not reach Journear’s relayer. Check your connection and try again.';
  }
  switch (code) {
    case 'popup_blocked':
      return 'Your browser blocked the Journear Passport window. Allow pop-ups for this site and try again.';
    case 'login_cancelled':
      return 'Sign-in cancelled.';
    case 'login_method_unavailable':
      return 'That sign-in method isn’t turned on for this site yet. Choose another one.';
    case 'code_invalid':
      return 'Sign-in stopped after a wrong code. Sign in again to get a new one.';
    case 'challenge_expired':
      return 'The sign-in code expired. Sign in again to get a new one.';
    case 'login_timeout':
      return isObj(e) && isObj(e.data) && e.data.stage === 'pending' ? 'The sign-in wasn’t finished within 5 minutes, so it stopped. Sign in again when you’re ready.' : 'The Journear Passport window did not respond in time. Try again.';
    case 'google_error':
      return isObj(e) && isObj(e.data) && e.data.error === 'access_denied' ? 'You declined the Google sign-in.' : `Google returned an error. Try again. ${REPORT}`;
    case 'vault_unavailable':
      if (reason === 'no_answer') return 'Journear Passport didn’t answer this site (is it on the app’s allowed origins?). Reload the page.';
      return 'Could not load Journear Passport in time. Check your connection and any content blocker, then reload the page.';
    case 'api_unavailable':
      return 'Could not reach Journear Passport’s service. Check your connection and try again.';
    case 'rate_limited':
      return 'Too many attempts. Wait a minute and try again.';
    case 'origin_not_allowed':
      return 'This site is not on the app’s allowed origins yet: ask the Journear team to add it.';
    case 'app_suspended':
      return 'This site’s app is suspended.';
    case 'session_ended':
      return 'Your session has ended. Sign in again.';
    case 4001:
      if (action === 'login') return 'Sign-in did not complete (the window was closed or timed out).';
      return 'Declined in the Journear Passport window: nothing was signed, no stamp was collected.';
    case 4100:
      if (reason === 'mainnet_not_allowed') return 'Refused: this site signs for NEAR testnet only.';
      return 'Not allowed: you may have been signed out. Sign in and try again.';
    case 4900:
      if (reason === 'signed_out') return SIGNED_OUT_MESSAGE;
      return 'The connection to Journear Passport was lost. Reload the page.';
    default:
      break;
  }
  if (e instanceof TypeError && /fetch|network|load failed/iu.test(e.message)) return 'Network error. Check your connection and try again.';
  if (action === 'copy') return 'Could not copy to the clipboard. Select the text and copy it yourself.';
  return `Something went wrong${code !== null ? ` (${code})` : ''}. ${REPORT}`;
}
