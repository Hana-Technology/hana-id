// Plain-language messages for what the SDK rejects with (docs/integration.md section 13). `hana.*` rejects with a
// HanaError (a numeric or string code), the EIP-1193 provider with a ProviderRpcError whose numeric code hides the
// Hana code in `data.code`; a network failure inside the SDK can surface as a TypeError. Either carries the Hana API
// request it came from in `data.requestId` (D405), when it came from one.
import { isApiRequestId } from '@hana-id/core';

/** `near`: the NEAR card's gasless guestbook write (activate, sign, relay) and its reads from NEAR testnet. */
export type DemoAction = 'load' | 'login' | 'logout' | 'revoke' | 'sign' | 'export' | 'copy' | 'identity' | 'near';

export interface ErrorInfo {
  /** The most specific code: the Hana string code when there is one, else the numeric code, else null. */
  code: string | number | null;
  /** `data.reason` when the error carries one (`share_not_fresh`, `mainnet_not_allowed`, …). */
  reason: string | null;
  /** The error's own message (may name values: diagnostics scrub it). */
  message: string;
  /** `data.requestId`: the Hana API request the error came from (D405), only in its exact shape; else null. */
  requestId: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const CODE_RE = /^[a-z][a-z0-9_]{0,63}$/u;

export function errorInfo(e: unknown): ErrorInfo {
  const message = e instanceof Error ? e.message : isObj(e) && typeof e.message === 'string' ? e.message : String(e);
  if (!isObj(e)) return { code: null, reason: null, message, requestId: null };
  const data = isObj(e.data) ? e.data : null;
  const inner = typeof data?.code === 'string' && CODE_RE.test(data.code) ? data.code : null;
  const own = typeof e.code === 'number' && Number.isSafeInteger(e.code) ? e.code : typeof e.code === 'string' && CODE_RE.test(e.code) ? e.code : null;
  const reason = typeof data?.reason === 'string' && CODE_RE.test(data.reason) ? data.reason : null;
  const requestId = isApiRequestId(data?.requestId) ? data.requestId : null;
  return { code: inner ?? own, reason, message, requestId };
}

const REPORT = 'If it keeps happening, use “Copy diagnostics” and send it to the Hana team.';

/** What the page says when Hana signed this device out (4900 with `data.reason` `signed_out`, D695). */
export const SIGNED_OUT_MESSAGE = 'You were signed out on this device (from Hana Home, another tab or another device). Log in again.';

/**
 * Hana signed this device out: the `disconnect` event or a refused request with code 4900 and `data.reason`
 * `signed_out`. The vault is fine and no reload is needed, only a new login. A 4900 without the reason is a lost vault.
 */
export function isSignedOut(e: unknown): boolean {
  const { code, reason } = errorInfo(e);
  return code === 4900 && reason === 'signed_out';
}

const GASLESS = '“Write to the guestbook (no NEAR needed)”';

/**
 * The vault's NEAR refusals (4100 with `data.reason`, docs/integration.md section 8), by reason. Each is about a
 * request the page built, so the advice is to try again: the card reads a fresh nonce and block for every attempt.
 */
const NEAR_VAULT_REASONS: Readonly<Record<string, string>> = {
  near_key_unknown: `Your NEAR account doesn’t exist on testnet yet, so Hana can’t check this request. Click ${GASLESS} again: the demo creates the account first.`,
  near_block_unknown: 'Hana couldn’t find this transaction’s block on NEAR testnet. Try again: the demo reads a fresh block.',
  near_network_mismatch: 'Refused: this transaction names a block of another NEAR network than the one it claims.',
  near_delegate_nonce_used: 'That NEAR request’s nonce was already used (another tab or an earlier write?). Try again: the demo reads a fresh one.',
  near_delegate_nonce_too_large: 'Hana refused the request’s nonce for NEAR testnet’s current block. Wait a few seconds and try again.',
  near_delegate_expiry: 'The NEAR request expired before it was approved, or expires too far ahead. Try again.',
  near_delegate_nonce_stale: 'That NEAR request was prepared too long ago (its nonce is behind testnet’s current block). Try again: the demo reads a fresh one.',
  near_relayed_delegate: 'Refused: Hana doesn’t sign a transaction that relays someone else’s delegate action.',
};

/**
 * The relayer's refusals of `POST /v1/near/relay` and `/v1/near/activate` (the SDK makes a 4xx 4100 and a 5xx
 * `api_unavailable`, with the API's code in `data.reason` and the HTTP status in `data.status`). The codes are those of
 * docs/api.md "NEAR relay" on the relayer build's branch; add a row here for a new one. Anything else falls back to
 * RELAYER_REFUSED or RELAYER_DOWN.
 */
const RELAYER_REASONS: Readonly<Record<string, string>> = {
  // 409 until the vault has recorded the user's NEAR account in Hana's wallet directory (seconds after login); the
  // card retries for about 20 s (near-card.ts UNRECORDED_REASONS) before it shows these.
  near_account_unrecorded: 'Hana is still setting up your NEAR account for this app (it takes a few seconds after you sign in). Try again in a moment.',
  near_account_unknown: 'Hana doesn’t have your NEAR account on record for the demo app yet. Wait a few seconds and try again; if it keeps happening, log out and log in again.',
  directory_unavailable: 'Hana couldn’t check your NEAR account right now. Try again in a minute.',
  // The relayer's policy: zero-deposit calls to an allowed contract, from an implicit account, with bounded gas.
  receiver_not_allowed: 'Hana’s relayer pays only for calls to the demo guestbook, and refused this one.',
  action_not_allowed: 'Hana’s relayer pays only for function calls, and refused this request.',
  deposit_not_allowed: 'Hana’s relayer refused a request that attaches NEAR: the guestbook needs none.',
  gas_too_high: 'Hana’s relayer refused the request’s gas: it pays for at most what the guestbook needs.',
  sender_not_implicit: 'Hana’s relayer acts only for Hana’s own NEAR accounts, and refused this one.',
  bad_delegate: 'Hana’s relayer could not read the signed request. Try again.',
  bad_delegate_signature: 'Hana’s relayer found the request’s signature invalid. Try again.',
  bad_request: 'Hana’s relayer could not read the request. Try again.',
  mainnet_not_allowed: 'Hana’s relayer works on NEAR testnet only.',
  // Checked on chain before relaying.
  account_not_activated: 'Your NEAR account doesn’t exist on testnet yet. Try again: the demo creates it first.',
  access_key_missing: 'Your NEAR account has no Hana key on testnet any more (was it changed elsewhere?), so the relayer can’t act for it.',
  delegate_nonce_used: 'That NEAR request’s nonce was already used (another tab or an earlier write?). Try again: the demo reads a fresh one.',
  delegate_nonce_too_large: 'Hana’s relayer refused the request’s nonce for NEAR testnet’s current block. Wait a few seconds and try again.',
  delegate_expired: 'The signed request expired before the relayer sent it. Try again.',
  block_height_too_far: 'The signed request expires too far ahead for Hana’s relayer. Try again.',
  already_relayed: 'Hana’s relayer sent this exact request a moment ago. Check the guestbook list.',
  // After relaying.
  contract_rejected: 'The guestbook contract refused the message (is it 1 to 200 characters?). Nothing was stored.',
  delegate_rejected: 'NEAR testnet refused the signed request. Try again: the demo reads a fresh nonce and block.',
  timeout: 'NEAR testnet hasn’t confirmed the transaction yet. Refresh the guestbook list in a moment to see whether it landed.',
  near_rejected: 'NEAR testnet refused the relayed transaction. Try again; the guestbook list shows whether it landed.',
  near_error: 'NEAR testnet returned an error for the relayed transaction. Try again; the guestbook list shows whether it landed.',
  near_unavailable: 'Hana’s relayer couldn’t reach NEAR testnet. Try again in a minute.',
  // Capacity and limits.
  app_budget_exhausted: 'The demo app has used up today’s free NEAR relays. Try again tomorrow (UTC).',
  relay_budget_exhausted: 'Hana’s relayer has used up today’s testnet budget. Try again tomorrow (UTC).',
  relayer_busy: 'Hana’s relayer is busy. Wait a few seconds and try again.',
  relayer_unavailable: 'Hana’s relayer is unavailable right now. Try again in a minute.',
  relayer_unconfigured: 'Hana’s relayer isn’t set up on this environment yet. Tell the Hana team.',
  rate_limiter_unavailable: 'Hana’s relayer is unavailable right now. Try again in a minute.',
};
const RELAYER_REFUSED = 'Hana’s relayer refused this request';
const RELAYER_DOWN = 'Hana’s relayer is unavailable right now. Try again in a minute.';

/** The NEAR card's own failures (src/near.ts), and the NEAR answers of every action; null for any other error. */
function nearMessage(e: unknown, code: string | number | null, reason: string | null, action: DemoAction): string | null {
  if (code === 'near_page_rpc_failed') return 'This page couldn’t read NEAR testnet (its RPC didn’t answer). Check your connection and try again.';
  if (code === 'near_account_pending') return 'Hana’s relayer is still creating your NEAR account. Wait a few seconds and try again.';
  if (code === 'near_nonce_wait') return 'NEAR testnet needs a new block before this request. Wait a few seconds and try again.';
  if (code === 'near_send_failed') return 'NEAR testnet refused or failed the transaction. Use the gasless write instead.';
  if (code === 4100 && reason !== null && Object.hasOwn(NEAR_VAULT_REASONS, reason)) return NEAR_VAULT_REASONS[reason]!;
  if (code === 'api_unavailable' && reason === 'near_rpc_unavailable') return 'Hana couldn’t reach NEAR testnet to check this request. Try again in a minute.';
  // The relayer's answers carry their HTTP status in data.status (the SDK's relay and activate); the vault's don't.
  const fromRelayer = isObj(e) && isObj(e.data) && typeof e.data.status === 'number';
  if (action !== 'near' || !fromRelayer) return null;
  if (reason !== null && Object.hasOwn(RELAYER_REASONS, reason) && (code === 4100 || code === 'api_unavailable' || code === 'rate_limited')) return RELAYER_REASONS[reason]!;
  if (code === 4100) return `${RELAYER_REFUSED}${reason ? ` (${reason})` : ''}. ${REPORT}`;
  if (code === 'api_unavailable') return reason ? `${RELAYER_DOWN} (${reason})` : 'Could not reach Hana’s relayer. Check your connection and try again.';
  if (code === 'rate_limited') return 'Too many guestbook writes from this app in a short time. Wait a minute and try again.';
  return null;
}

/** What to tell the user, for an error of `action`. */
export function plainMessage(e: unknown, action: DemoAction): string {
  const { code, reason } = errorInfo(e);
  const near = nearMessage(e, code, reason, action);
  if (near !== null) return near;
  switch (code) {
    case 'popup_blocked':
      return 'Your browser blocked the Hana sign-in window. Allow pop-ups for this site and click “Log in with Google” again.';
    case 'login_cancelled':
      return 'Sign-in cancelled.';
    case 'login_method_unavailable':
      return 'Email login isn’t turned on for the demo app yet. Use “Log in with Google”, or ask the Hana team to turn email on.';
    case 'code_invalid':
      return 'Sign-in stopped after a wrong code. Click “Log in with email” to get a new one.';
    case 'challenge_expired':
      return 'The sign-in code expired. Click “Log in with email” to get a new one.';
    case 'coop_blocks_popup':
      return 'The Hana sign-in window closed before it finished loading. Try again and keep the window open.';
    case 'login_timeout':
      // data.stage (docs/integration.md section 13): 'connect', the window never connected (15 s); 'pending', the
      // sign-in was left unfinished for 5 minutes (the window left open; a closed one is login_cancelled, D347, D398).
      return isObj(e) && isObj(e.data) && e.data.stage === 'pending'
        ? 'The sign-in wasn’t finished within 5 minutes, so it stopped. Log in again when you’re ready.'
        : 'The Hana sign-in window did not respond in time. Try again.';
    case 'google_error':
      return isObj(e) && isObj(e.data) && e.data.error === 'access_denied' ? 'You declined the Google sign-in.' : `Google returned an error. Try again. ${REPORT}`;
    case 'vault_unavailable':
      // data.reason (the SDK's vault-connection.ts): which part of the vault's load failed, after its one retry.
      if (reason === 'csp_frame_src') return `This page’s security policy blocks the Hana vault frame. ${REPORT}`;
      if (reason === 'no_answer') return `The Hana vault loaded but didn’t answer (is this site on the demo app’s allowed origins?). Reload the page. ${REPORT}`;
      if (reason === 'ready_timeout') return 'Hana’s service was too slow to restore your session. Check your connection, then reload the page.';
      if (reason === 'frame_replaced') return 'Something replaced the Hana vault frame (an extension?). Reload the page.';
      return 'Could not load the Hana vault in time. Check your connection and any content blocker, then reload the page.';
    case 'api_unavailable':
      return 'Could not reach Hana’s service. Check your connection and try again.';
    case 'rate_limited':
      return action === 'export' ? 'Too many key exports in the last hour. Try again later.' : 'Too many attempts. Wait a minute and try again.';
    case 'origin_not_allowed':
      return 'This site is not on the demo app’s allowed origins yet: ask the Hana team to add it.';
    case 'app_suspended':
      return 'The demo app is suspended.';
    case 'no_google_client':
      return 'The demo app has no Google sign-in configured. Tell the Hana team.';
    case 'busy':
      return 'A key export is already open. Finish or close it first.';
    case 'email_sharing_unavailable':
      // D411: data.reason off (the app's identity_email setting), no_address (none for this session), unavailable.
      if (reason === 'off') return 'Email sharing is off for the demo app. The Hana team turns it on with app:settings --identity-email on_request.';
      if (reason === 'no_address') return 'Hana has no email address for this session. Log out and log in again, then try again.';
      return 'Hana couldn’t open email sharing right now. Try again in a minute.';
    case 'identity_unavailable':
      return 'Hana could not issue an identity token right now. Try again in a minute.';
    case 'session_ended':
      return 'Your Hana session has ended. Log in again.';
    case 'session_consumed':
      return 'Click “Continue signing in” on the Hana button at the bottom right to finish signing in.';
    case 'derive_failed':
      // D385: the browser couldn't make the sign-in's session key (Ed25519 in WebCrypto).
      if (reason === 'webcrypto_unsupported') return 'This browser can’t create the key Hana’s sign-in needs (no Ed25519 in WebCrypto). Update it, or use another browser.';
      if (reason === 'webcrypto_failed') return `This browser failed to create the key Hana’s sign-in needs. Try again. ${REPORT}`;
      return `Sign-in failed (${code}). Try again. ${REPORT}`;
    case 'token_invalid':
    case 'token_has_pii':
    case 'config_mismatch':
    case 'ckd_failed':
    case 'pairing_failed':
    case 'address_mismatch':
      return `Sign-in failed (${code}). Try again. ${REPORT}`;
    case 4001:
      if (action === 'login') return 'Sign-in did not complete (the window was closed or timed out).';
      if (action === 'export') return 'Export cancelled.';
      return 'Rejected in the Hana window: nothing was signed.';
    case 4100:
      if (reason === 'share_not_fresh') return '“Log out other devices” works only within 5 minutes of signing in. Log out, sign in again, then try it.';
      if (reason === 'mainnet_not_allowed') return 'Refused: this demo app signs for test networks only.';
      return 'Not allowed: you may have been logged out. Log in and try again.';
    case 4900:
      if (reason === 'signed_out') return SIGNED_OUT_MESSAGE;
      return 'The connection to the Hana vault was lost. Reload the page.';
    case 4902:
      return 'This EVM chain is not configured on the demo.';
    default:
      break;
  }
  if (e instanceof TypeError && /fetch|network|load failed/iu.test(e.message)) return 'Network error. Check your connection and try again.';
  if (action === 'copy') return 'Could not copy to the clipboard. Select the text and copy it yourself.';
  return `Something went wrong${code !== null ? ` (${code})` : ''}. ${REPORT}`;
}
