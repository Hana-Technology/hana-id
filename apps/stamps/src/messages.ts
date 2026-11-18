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
export type PageErrorCode = 'near_page_rpc_failed' | 'near_account_pending' | 'near_send_failed' | 'near_nonce_wait' | 'near_not_enough_balance' | 'stamps_contract_refused' | 'stamps_contract_storage';

export const pageError = (code: PageErrorCode, message: string, data?: Record<string, unknown>): Error => Object.assign(new Error(message), { code, ...(data ? { data } : {}) });

export const SIGNED_OUT_MESSAGE = 'You were signed out on this device (from Passport Home, another tab or another device). Sign in again.';

/**
 * D853: every error in one pattern: what happened, whether anything was lost or sent, and what to do. No chain words
 * (relayer, gas, block, faucet, storage balance): the code a support person needs is `Error code (for support)`.
 */
const REPORT = 'If it keeps happening, tell the Journear team.';
const NOT_SET_UP = 'Your NEAR account isn’t set up yet. Nothing was lost. Try again: the site sets it up first.';
const NUMBER_USED = 'This request was already used, perhaps in another tab. Nothing was lost. Try again.';
const NOT_YET = 'Journear couldn’t accept this request yet. Nothing was sent. Wait a few seconds and try again.';
const TEST_SITE_ONLY = 'Journear stopped this request: on a test site, free requests can only use a program on NEAR’s test network. Nothing was sent.';
const CANT_SEND = 'Journear can’t send stamps right now. Nothing was lost. Try again in a minute.';

/** The vault's NEAR refusals (4100 with `data.reason`). Each is about a request the page built: trying again reads afresh. */
const VAULT_REASONS: Readonly<Record<string, string>> = {
  near_key_unknown: NOT_SET_UP,
  near_block_unknown: 'Journear couldn’t check this request. Nothing was sent. Try again.',
  near_network_mismatch: 'This request was for another NEAR network, so Journear stopped it. Nothing was sent. Try again.',
  near_delegate_nonce_used: NUMBER_USED,
  near_delegate_nonce_too_large: NOT_YET,
  near_delegate_expiry: 'The request expired before you approved it. Nothing was sent. Try again.',
  near_delegate_nonce_stale: 'This request was prepared too long ago. Nothing was sent. Try again.',
  near_relayed_delegate: 'Journear doesn’t sign a request that passes on someone else’s. Nothing was sent.',
  near_delegate_test_app_action: TEST_SITE_ONLY,
  near_delegate_test_app_receiver: TEST_SITE_ONLY,
};

/** The refusals of Journear's free sending (the relay), by the API's code (docs/api.md "NEAR relay"). */
const RELAYER_REASONS: Readonly<Record<string, string>> = {
  near_account_unrecorded: 'Journear is still setting up your NEAR account (it takes a few seconds after you sign in). Nothing was lost. Try again in a moment.',
  directory_unavailable: 'Journear couldn’t check your NEAR account right now. Nothing was lost. Try again in a minute.',
  receiver_not_allowed: 'Journear can’t pay for stamps on this site yet. Nothing was lost. Tell the Journear team.',
  action_not_allowed: `Journear pays only for stamps, and refused this request. Nothing was sent. ${REPORT}`,
  deposit_not_allowed: 'This request tried to send NEAR, which stamps never need, so Journear refused it. Nothing was sent. Try again.',
  gas_too_high: 'This request would cost more than Journear pays for, so it was refused. Nothing was sent. Tell the Journear team.',
  sender_not_implicit: 'Journear pays only for Journear Passport’s own NEAR accounts. Nothing was sent.',
  bad_delegate: 'Journear couldn’t read this request. Nothing was sent. Try again.',
  bad_delegate_signature: 'Journear couldn’t check your approval. Nothing was sent. Try again.',
  bad_request: 'Journear couldn’t read this request. Nothing was sent. Try again.',
  mainnet_not_allowed: 'Journear pays only on NEAR’s test network. Nothing was sent.',
  account_not_activated: NOT_SET_UP,
  access_key_missing: 'Your NEAR account no longer holds Journear Passport’s key, so Journear can’t send for it. Nothing was lost. Tell the Journear team.',
  delegate_nonce_used: NUMBER_USED,
  delegate_nonce_too_large: NOT_YET,
  delegate_expired: 'Your approved request expired before Journear could send it. Nothing was sent. Try again.',
  block_height_too_far: 'Your approved request was set to last too long, so Journear refused it. Nothing was sent. Try again.',
  already_relayed: 'Journear sent this exact stamp a moment ago. Nothing was lost. Refresh to see it.',
  delegate_rejected: 'NEAR refused this stamp. Nothing was lost. Try again.',
  near_rejected: 'NEAR refused this stamp. Nothing was lost. Try again; Refresh shows whether it went through.',
  near_error: 'NEAR reported an error for this stamp, so it may not have gone through. Refresh to check, then try again.',
  near_unavailable: 'Journear couldn’t reach NEAR. Nothing was sent. Try again in a minute.',
  timeout: 'NEAR hasn’t confirmed this stamp yet: it may still arrive. Refresh in a moment to see.',
  app_budget_exhausted: 'This site has used up today’s free stamps. Nothing was lost. Try again tomorrow (UTC).',
  relay_budget_exhausted: 'Today’s free stamps are used up. Nothing was lost. Try again tomorrow (UTC).',
  relayer_busy: 'Journear is busy. Nothing was lost. Try again in a moment.',
  not_enough_balance: 'Journear can’t pay for stamps right now. Nothing was lost. Tell the Journear team.',
  relayer_unavailable: CANT_SEND,
  relayer_unconfigured: 'Journear can’t send stamps on this site yet. Nothing was lost. Tell the Journear team.',
  rate_limiter_unavailable: CANT_SEND,
};

/** The stamps contract is out of storage balance (LackBalanceForState): Journear has to top it up. */
export const STORAGE_MESSAGE = 'The stamps program is full right now, so it can’t keep new stamps until Journear makes room. Nothing was lost. Try again later.';

/** D853: an error's code for support, after the plain sentence; only a code of the API's shape is shown. */
const supportCode = (code: string | number | null): string => (code !== null && /^[a-z0-9_-]{1,64}$/iu.test(String(code)) ? ` Error code (for support): ${code}.` : '');

/** What to tell the user, for an error of `action`. */
export function plainMessage(e: unknown, action: StampsAction): string {
  const info = errorInfo(e);
  const { code, reason } = info;
  // The contract's own refusal, wherever it came from (the relay's 422 `contract_rejected`, NEAR's failure of an
  // own-fare transaction): only a known ERR_* code is shown, in our words.
  // The stamps contract's own balance can't pay for the new stamp's storage (NEAR's LackBalanceForState on its
  // receipt): anyone can fill it, and a plain transfer tops it up. Nothing was stored, nothing is lost.
  if (code === 'stamps_contract_storage' || (reason === 'contract_rejected' && /LackBalanceForState/u.test(info.message))) return STORAGE_MESSAGE;
  if (reason === 'contract_rejected' || code === 'stamps_contract_refused') {
    const err = contractErrorCode(info.message);
    return err ? CONTRACT_ERRORS[err]! : 'The stamps program refused this stamp. Nothing was lost. Try again; if it keeps happening, tell the Journear team.';
  }
  switch (code) {
    case 'near_page_rpc_failed':
      return 'This page couldn’t reach NEAR. Nothing was lost. Check your connection and try again.';
    case 'near_account_pending':
      return 'Journear is still creating your NEAR account. Nothing was lost. Wait a few seconds and try again.';
    case 'near_nonce_wait':
      return 'NEAR isn’t ready for this request yet. Nothing was sent. Wait a few seconds and try again.';
    case 'near_send_failed':
      return 'NEAR refused or failed this stamp. Refresh to check whether it went through, then try again.';
    case 'near_not_enough_balance':
      return 'Your account doesn’t hold enough test NEAR for the network fee. Nothing was sent. Get some free from NEAR’s free test-money site, then try again.';
    default:
      break;
  }
  if (code === 4100 && reason !== null && Object.hasOwn(VAULT_REASONS, reason)) return VAULT_REASONS[reason]!;
  if (code === 'api_unavailable' && reason === 'near_rpc_unavailable') return 'Journear couldn’t reach NEAR to check this request. Nothing was sent. Try again in a minute.';
  // The relayer's answers carry their HTTP status in data.status (the SDK's relay and activate); the vault's don't.
  const fromRelayer = isObj(e) && isObj(e.data) && typeof e.data.status === 'number';
  if (fromRelayer) {
    if (reason !== null && Object.hasOwn(RELAYER_REASONS, reason)) return RELAYER_REASONS[reason]!;
    if (code === 'rate_limited') return 'Too many stamps from this site in a short time. Nothing was lost. Wait a minute and try again.';
    if (code === 4100) return `Journear refused this stamp. Nothing was sent. ${REPORT}${supportCode(reason)}`;
    if (code === 'api_unavailable') return 'Couldn’t reach Journear. Nothing was sent. Check your connection and try again.';
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
      return isObj(e) && isObj(e.data) && e.data.error === 'access_denied' ? 'You cancelled the Google sign-in.' : `Google couldn’t finish the sign-in. Try again. ${REPORT}`;
    case 'vault_unavailable':
      if (reason === 'no_answer') return `Journear Passport didn’t answer this site. Reload the page. ${REPORT}`;
      return 'Could not load Journear Passport in time. Check your connection and any content blocker, then reload the page.';
    case 'api_unavailable':
      return 'Couldn’t reach Journear Passport. Nothing was lost. Check your connection and try again.';
    case 'rate_limited':
      return 'Too many attempts. Wait a minute and try again.';
    case 'origin_not_allowed':
      return 'This site isn’t allowed to use Journear Passport yet. Tell the Journear team.';
    case 'app_suspended':
      return 'This site is paused in Journear Passport right now.';
    case 'session_ended':
      return 'Your session has ended. Sign in again.';
    case 4001:
      if (action === 'login') return 'The sign-in didn’t finish: its window was closed or took too long. Sign in again.';
      return 'You rejected it in the Journear Passport window. Nothing was signed, and no stamp was collected.';
    case 4100:
      if (reason === 'mainnet_not_allowed') return 'Journear Passport stopped this: this site works only on NEAR’s test network. Nothing was signed.';
      return 'Journear Passport didn’t allow this. You may have been signed out. Sign in and try again.';
    case 4900:
      if (reason === 'signed_out') return SIGNED_OUT_MESSAGE;
      return 'The connection to Journear Passport was lost. Reload the page.';
    default:
      break;
  }
  if (e instanceof TypeError && /fetch|network|load failed/iu.test(e.message)) return 'Network error. Check your connection and try again.';
  if (action === 'copy') return 'Could not copy to the clipboard. Select the text and copy it yourself.';
  return `Something went wrong. Try again. ${REPORT}${supportCode(code)}`;
}
