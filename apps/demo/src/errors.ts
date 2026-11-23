// Plain-language messages for what the SDK rejects with (docs/integration.md section 13). `hana.*` rejects with a
// HanaError (a numeric or string code), the EIP-1193 provider with a ProviderRpcError whose numeric code hides the
// Hana code in `data.code`; a network failure inside the SDK can surface as a TypeError. Either carries the Hana API
// request it came from in `data.requestId` (D405), when it came from one.
import { isApiRequestId } from '@hana-id/core';
import { userMessageFor } from '@hana-id/web';
import { displayText } from './near.ts';

/**
 * `near`: the NEAR card's guestbook write that Journear pays for (activate, sign, relay) and its reads from NEAR testnet. `gasFree`:
 * the gas-free check-in card's `hana.evm.sendSponsored` (gas-free-card.ts, D867).
 */
export type DemoAction = 'load' | 'login' | 'logout' | 'revoke' | 'sign' | 'export' | 'copy' | 'identity' | 'near' | 'gasFree';

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

const BASE58_HASH = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u;

/**
 * The transaction a refused relay or activation sent (the SDK's `data.transactionHash`, D788), only in its exact shape
 * (base58), else null. A `timeout` with one may still land.
 */
export function relayTransaction(e: unknown): string | null {
  const data = isObj(e) && isObj(e.data) ? e.data : null;
  return typeof data?.transactionHash === 'string' && BASE58_HASH.test(data.transactionHash) ? data.transactionHash : null;
}

const REPORT = 'If it keeps happening, use “Copy diagnostics” and send it to the Journear team.';

/** What the page says when Hana signed this device out (4900 with `data.reason` `signed_out`, D695). */
export const SIGNED_OUT_MESSAGE = 'You were signed out on this device (from Passport Home, another tab or another device). Sign in again.';

/**
 * Hana signed this device out: the `disconnect` event or a refused request with code 4900 and `data.reason`
 * `signed_out`. The vault is fine and no reload is needed, only a new login. A 4900 without the reason is a lost vault.
 */
export function isSignedOut(e: unknown): boolean {
  const { code, reason } = errorInfo(e);
  return code === 4900 && reason === 'signed_out';
}

const GASLESS = '“Write to the guestbook (no NEAR needed)”';
/** D889: where the person checks a NEAR write whose outcome Journear can't vouch for (the SDK's rule: check first). */
const CHECK_LIST = 'Check the guestbook list for your message before you try again';

/**
 * The vault's NEAR refusals (4100 with `data.reason`, docs/integration.md section 8), by reason. Each comes before the
 * approval window, so nothing was signed; the card reads its account and the network afresh for every attempt. D889:
 * plain words (no nonce, block, delegate, testnet), one sentence each so support can tell them apart.
 */
const NEAR_VAULT_REASONS: Readonly<Record<string, string>> = {
  near_key_unknown: `Your NEAR account isn’t set up yet, so nothing was signed. Click ${GASLESS} again: the demo sets up your account first.`,
  // The SDK's own sentence (userMessage), word for word.
  near_block_unknown: 'Journear Passport couldn’t check this request, so it wasn’t signed. Try again.',
  near_network_mismatch: `This request mixed up two NEAR networks, so Journear Passport stopped it. Nothing was signed. ${REPORT}`,
  // The key's number for this request is already used on chain: another request took its place (it may be this text).
  near_delegate_nonce_used: `Another request from your account just used this one’s place, perhaps from another tab, so this one wasn’t signed. ${CHECK_LIST}.`,
  // The SDK's own sentence, word for word.
  near_delegate_nonce_too_large: 'This request can’t be checked yet, so nothing was signed. Wait a few seconds and try again.',
  near_delegate_expiry: 'This request ran out of time before it was approved, or was set to last too long, so nothing was signed. Try again.',
  near_delegate_nonce_stale: 'This request was prepared too long ago, so nothing was signed. Try again: the demo prepares a new one.',
  near_relayed_delegate: 'Journear Passport stopped this: it asked to send on a request someone else had already approved, which Journear Passport never signs. Nothing was signed.',
  // A test app's requests that Journear pays for: only calls and transfers (…_action), to a .testnet account other than
  // the user's (…_receiver).
  near_delegate_test_app_action: 'Journear Passport stopped this: in a test app, a request that Journear pays for may only send NEAR or use an app on NEAR, never change your account’s keys or settings. Nothing was signed.',
  near_delegate_test_app_receiver: 'Journear Passport stopped this: in a test app, a request that Journear pays for may only go to another account on NEAR’s test network, not your own. Nothing was signed.',
};

/**
 * Journear's NEAR relay's refusals of `POST /v1/near/relay` and `/v1/near/activate` (the SDK makes a 4xx 4100 and a
 * 5xx `api_unavailable`, with the API's code in `data.reason` and the HTTP status in `data.status`). The codes are those
 * of docs/api.md "NEAR relay"; add a row here for a new one. Anything else falls back to RELAY_REFUSED or RELAY_DOWN.
 *
 * D889: plain words (no relayer, nonce, delegate, testnet), one sentence per code. "Nothing was sent" only where the
 * API answers before anything is broadcast (apps/api/src/near/relay.ts: every check before `relayThrough`). A code the
 * API can also send after its transaction may have gone out (`relayer_busy`, `relayer_unavailable`, `near_unavailable`,
 * `near_error`, `timeout`; the API's `notSent` doesn't reach the page) says to check the guestbook list first, as the
 * SDK's `userMessage` does: a new approval could write the message twice. NEAR's own refusals (`near_rejected`,
 * `delegate_rejected`) never ran the guestbook call (the API's NOT_EXECUTED; a delegate's failure is in the sender's
 * receipt), so they say the message wasn't stored. Where the team has to act, {REPORT}, so diagnostics come with it.
 */
const RELAYER_REASONS: Readonly<Record<string, string>> = {
  // 409 until the vault has recorded the user's NEAR account in Hana's wallet directory (seconds after login); the
  // card retries for about 20 s (near-card.ts UNRECORDED_REASON) before it shows this.
  near_account_unrecorded: 'Journear is still setting up your NEAR account for this app (it takes a few seconds after you sign in). Try again in a moment.',
  directory_unavailable: 'Journear couldn’t check your NEAR account right now. Try again in a minute.',
  // The relay's policy: zero-deposit calls to an allowed contract, from an implicit account, with bounded gas. The page
  // only ever sends that, so these mean the env or the page is wrong: tell the team.
  receiver_not_allowed: `Journear isn’t set up to pay for this guestbook, so it refused this request. Nothing was sent. ${REPORT}`,
  action_not_allowed: `This request isn’t a kind Journear pays for, so it was refused. Nothing was sent. ${REPORT}`,
  deposit_not_allowed: `This request tried to send NEAR with your message, which the guestbook never needs, so Journear refused it. Nothing was sent. ${REPORT}`,
  gas_too_high: `Journear refused this request: its network fee could be more than the guestbook needs, and Journear pays only up to that. Nothing was sent. ${REPORT}`,
  sender_not_implicit: 'Journear pays only for Journear Passport’s own NEAR accounts, and this request came from another one. Nothing was sent.',
  bad_delegate: 'Journear couldn’t read your approved request. Nothing was sent. Try again.',
  bad_delegate_signature: 'Journear couldn’t check your approval of this request. Nothing was sent. Try again.',
  bad_request: 'Journear couldn’t read this request. Nothing was sent. Try again.',
  mainnet_not_allowed: 'Journear pays only on NEAR’s test network, so it refused this request. Nothing was sent.',
  // Checked on chain before relaying.
  account_not_activated: 'Your NEAR account isn’t set up yet. Nothing was sent. Try again: the demo sets it up first.',
  access_key_missing: `Your NEAR account no longer holds the key Journear Passport made for it (was it changed in another wallet?), so it can’t be used here. Nothing was sent. ${REPORT}`,
  // Refused before sending (relay.ts: the sender's floor or the chain's nonce): another request took its place, and it
  // may be this text (near-card.ts reads the list before its one automatic retry).
  delegate_nonce_used: `Another request from your account just used this one’s place, perhaps from another tab, so this one wasn’t sent. ${CHECK_LIST}.`,
  // The SDK's own sentence, word for word.
  delegate_nonce_too_large: 'This request can’t be used yet, so nothing was sent. Wait a few seconds and try again.',
  delegate_expired: 'Your approved request ran out of time before Journear could send it. Nothing was sent. Try again.',
  block_height_too_far: 'Your approved request was set to last too long, so Journear refused it. Nothing was sent. Try again.',
  already_relayed: `Journear sent this same request a moment ago. ${CHECK_LIST}.`,
  // After relaying. `contract_rejected` with the guestbook's own reason is nearMessage's; this is the table's row.
  contract_rejected: 'The guestbook refused the message (is it 1 to 200 characters?). Nothing was stored.',
  delegate_rejected: 'NEAR’s test network turned down your approved request, so your message wasn’t stored. Try again.',
  timeout: 'NEAR’s test network hasn’t confirmed your message yet: it may still arrive. Click Refresh on the guestbook list in a moment to see, before you try again.',
  near_rejected: 'NEAR’s test network turned this request down, so your message wasn’t stored. Try again.',
  near_error: `NEAR’s test network reported a problem with this request, so it may or may not have gone through. ${CHECK_LIST}.`,
  near_unavailable: `Journear couldn’t reach NEAR’s test network, so it can’t tell whether your request went through. ${CHECK_LIST} in a minute.`,
  // Capacity and limits.
  app_budget_exhausted: 'The demo app has used up today’s free NEAR transactions. Nothing was sent. Try again tomorrow (UTC).',
  relay_budget_exhausted: 'The demo’s free NEAR transactions are used up for today. Nothing was sent. Try again tomorrow (UTC).',
  relayer_busy: `Journear is busy right now. ${CHECK_LIST} in a moment.`,
  // Not a code the API sends today (a short relay account answers `near_rejected`); kept in case it comes back.
  not_enough_balance: `Journear can’t pay for NEAR transactions right now. Nothing was sent. ${REPORT}`,
  relayer_unavailable: `Journear couldn’t send this right now and can’t tell whether it went through. ${CHECK_LIST} in a minute.`,
  // Only a tester on a test version set up without the NEAR relay sees this (D881: plain words).
  relayer_unconfigured: `The demo’s free NEAR transactions aren’t set up on this test version yet. Nothing was sent. ${REPORT}`,
  rate_limiter_unavailable: 'Journear couldn’t take this request right now. Nothing was sent. Try again in a minute.',
  // The relay key's own check, answered without `notSent` (the SDK's NEAR_RELAY_REASON_NAMES has it): check first.
  method_not_allowed: `Journear couldn’t use this request. ${CHECK_LIST}. ${REPORT}`,
};
const RELAY_REFUSED = 'Journear refused this request';
const RELAY_DOWN = `Something went wrong while Journear was sending this. ${CHECK_LIST}.`;

/**
 * The relay's activation answers whose relay-side sentence would talk about a message or a send (D889): during the
 * write's activation nothing was signed yet, so these say what is true of the account instead.
 */
const ACTIVATION_UNKNOWN: ReadonlySet<string> = new Set(['relayer_busy', 'relayer_unavailable', 'near_unavailable', 'near_error', 'near_rejected', 'method_not_allowed']);

/**
 * The error to show for a failure of the write's activation (`hana.near.activate`, before the approval): a page code
 * about the account (`near_activation_failed`, `near_activation_pending` for a timeout) keeping the API's reason and
 * request id for diagnostics, or the error itself when its sentence is already true of an activation.
 */
export function activationFailure(e: unknown): unknown {
  const { code, reason, requestId } = errorInfo(e);
  const fromRelay = isObj(e) && isObj(e.data) && typeof e.data.status === 'number';
  const data = { ...(reason !== null ? { reason } : {}), ...(requestId !== null ? { requestId } : {}) };
  const page = (c: string, message: string) => Object.assign(new Error(message), { code: c, data });
  if (reason === 'timeout') return page('near_activation_pending', 'The account activation is not confirmed yet');
  if (reason !== null && ACTIVATION_UNKNOWN.has(reason)) return page('near_activation_failed', `The account activation failed (${reason})`);
  if (code === 'api_unavailable' && (!fromRelay || reason === null || !Object.hasOwn(RELAYER_REASONS, reason))) return page('near_activation_failed', 'The account activation got no usable answer');
  return e;
}

/** The NEAR card's own failures (src/near.ts), and the NEAR answers of every action; null for any other error. */
function nearMessage(e: unknown, code: string | number | null, reason: string | null, action: DemoAction): string | null {
  // A read before any approval (the send has its own codes below).
  if (code === 'near_page_rpc_failed') return 'This page couldn’t reach NEAR’s test network. Check your connection and try again.';
  // "Sign a transaction"'s send (near.ts sendTx, D889): definitely not run by this transaction, or unknown.
  if (code === 'near_send_failed') return `NEAR’s test network refused this transaction, or it failed there: it didn’t go through. Check the guestbook list, then use ${GASLESS} if your message isn’t there.`;
  if (code === 'near_send_unconfirmed') return 'NEAR’s test network didn’t confirm this transaction, so it may or may not have gone through. Check the guestbook list before you try again.';
  // The write's activation, before anything was signed (near-card.ts, D889): about the account, never the message.
  if (code === 'near_activation_failed') return 'Journear couldn’t finish setting up your NEAR account. Nothing was signed. Try again in a minute.';
  if (code === 'near_activation_pending') return 'Your NEAR account is still being set up. Wait a few seconds and try again.';
  if (code === 'near_account_pending') return 'Journear is still creating your NEAR account. Wait a few seconds and try again.';
  if (code === 'near_nonce_wait') return 'NEAR’s test network isn’t ready for this request yet, so nothing was signed. Wait a few seconds and try again.';
  if (code === 4100 && reason !== null && Object.hasOwn(NEAR_VAULT_REASONS, reason)) return NEAR_VAULT_REASONS[reason]!;
  if (code === 'api_unavailable' && reason === 'near_rpc_unavailable') return 'Journear Passport couldn’t reach NEAR’s test network to check this request, so nothing was signed. Try again in a minute.';
  if (code === 'api_unavailable' && reason === 'near_rpc_single_provider') return `This test version of Journear Passport isn’t set up to check this request yet, so nothing was signed. ${REPORT}`;
  // The relay's answers carry their HTTP status in data.status (the SDK's relay and activate); the vault's don't.
  const fromRelayer = isObj(e) && isObj(e.data) && typeof e.data.status === 'number';
  // No answer at all (the SDK's fetch failed or timed out: `api_unavailable` with no status or reason). In the write,
  // that is activate or the relay, and the relay may have gone out: check first (D889).
  if (action === 'near' && !fromRelayer && code === 'api_unavailable' && reason === null) return 'Couldn’t reach Journear, so this may or may not have been sent. Check your connection, then check the guestbook list for your message before you try again.';
  if (action !== 'near' || !fromRelayer) return null;
  // The contract's own panic text (the API's `error`, the SDK's message): from the chain, so shown made safe and short.
  if (reason === 'contract_rejected') {
    const why = displayText(errorInfo(e).message, 160).trim();
    return `The guestbook refused the message${why ? `: ${why}` : ''}. Nothing was stored.`;
  }
  if (reason !== null && Object.hasOwn(RELAYER_REASONS, reason) && (code === 4100 || code === 'api_unavailable' || code === 'rate_limited')) return RELAYER_REASONS[reason]!;
  if (code === 4100) return `${RELAY_REFUSED}${reason ? ` (${reason})` : ''}. ${REPORT}`;
  if (code === 'api_unavailable') return reason ? `${RELAY_DOWN} (${reason})` : `Journear didn’t answer properly, so it can’t tell whether this was sent. ${CHECK_LIST}.`;
  if (code === 'rate_limited') return 'Too many guestbook writes from this app in a short time. Wait a minute and try again.';
  return null;
}

/**
 * The SDK's plain sentence for an error (`userMessage`, D861: worked out in the SDK from the code and `data.reason`
 * only), or the same sentence from `userMessageFor` when the error doesn't carry one.
 */
export function sdkUserMessage(e: unknown): string {
  if (isObj(e) && typeof e.userMessage === 'string' && e.userMessage) return e.userMessage;
  return userMessageFor(isObj(e) ? e.code : undefined, isObj(e) ? e.data : undefined);
}

/** What to tell the user, for an error of `action`. */
export function plainMessage(e: unknown, action: DemoAction): string {
  // The gas-free check-in shows the SDK's own words for every refusal (D867): no sentence of the demo's own.
  if (action === 'gasFree') return isSignedOut(e) ? SIGNED_OUT_MESSAGE : sdkUserMessage(e);
  const { code, reason } = errorInfo(e);
  const near = nearMessage(e, code, reason, action);
  if (near !== null) return near;
  switch (code) {
    case 'popup_blocked':
      return 'Your browser blocked the Journear sign-in window. Allow pop-ups for this site and click “Sign in with Google” again.';
    case 'login_cancelled':
      return 'Sign-in cancelled.';
    case 'login_method_unavailable':
      return 'Email login isn’t turned on for the demo app yet. Use “Sign in with Google”, or ask the Journear team to turn email on.';
    case 'code_invalid':
      return 'Sign-in stopped after a wrong code. Click “Sign in with email” to get a new one.';
    case 'challenge_expired':
      return 'The sign-in code expired. Click “Sign in with email” to get a new one.';
    case 'link_pending':
      // D864/D881: an email (or a Google account) that is still waiting to join another wallet; the sign-in window
      // shows what to do (cancel or keep the link) or when it starts working.
      return 'This sign-in is waiting to be linked to a wallet, so it can’t open one yet. The Journear sign-in window says what to do.';
    case 'coop_blocks_popup':
      return 'The Journear sign-in window closed before it finished loading. Try again and keep the window open.';
    case 'login_timeout':
      // data.stage (docs/integration.md section 13): 'connect', the window never connected (15 s); 'pending', the
      // sign-in was left unfinished for 5 minutes (the window left open; a closed one is login_cancelled, D347, D398).
      return isObj(e) && isObj(e.data) && e.data.stage === 'pending'
        ? 'The sign-in wasn’t finished within 5 minutes, so it stopped. Sign in again when you’re ready.'
        : 'The Journear sign-in window did not respond in time. Try again.';
    case 'google_error':
      return isObj(e) && isObj(e.data) && e.data.error === 'access_denied' ? 'You declined the Google sign-in.' : `Google returned an error. Try again. ${REPORT}`;
    case 'vault_unavailable':
      // data.reason (the SDK's vault-connection.ts): which part of the vault's load failed, after its one retry.
      if (reason === 'csp_frame_src') return `This page’s security policy blocks the Journear vault frame. ${REPORT}`;
      if (reason === 'no_answer') return `The Journear vault loaded but didn’t answer (is this site on the demo app’s allowed origins?). Reload the page. ${REPORT}`;
      if (reason === 'ready_timeout') return 'Journear’s service was too slow to restore your session. Check your connection, then reload the page.';
      if (reason === 'frame_replaced') return 'Something replaced the Journear vault frame (an extension?). Reload the page.';
      return 'Could not load the Journear vault in time. Check your connection and any content blocker, then reload the page.';
    case 'api_unavailable':
      return 'Could not reach Journear’s service. Check your connection and try again.';
    case 'rate_limited':
      return action === 'export' ? 'Too many key exports in the last hour. Try again later.' : 'Too many attempts. Wait a minute and try again.';
    case 'origin_not_allowed':
      return 'This site is not on the demo app’s allowed origins yet: ask the Journear team to add it.';
    case 'app_suspended':
      return 'The demo app is suspended.';
    case 'no_google_client':
      return 'The demo app has no Google sign-in configured. Tell the Journear team.';
    case 'busy':
      return 'A key export is already open. Finish or close it first.';
    case 'email_sharing_unavailable':
      // D411: data.reason off (the app's identity_email setting), no_address (none for this session), unavailable.
      if (reason === 'off') return 'Email sharing is off for the demo app. The Journear team turns it on with app:settings --identity-email on_request.';
      if (reason === 'no_address') return 'Journear has no email address for this session. Sign out and sign in again, then try again.';
      return 'Journear couldn’t open email sharing right now. Try again in a minute.';
    case 'identity_unavailable':
      return 'Journear could not issue an identity token right now. Try again in a minute.';
    case 'session_ended':
      return 'Your Journear session has ended. Sign in again.';
    case 'session_consumed':
      return 'Click “Continue signing in” on the Journear button at the bottom right to finish signing in.';
    case 'derive_failed':
      // D385: the browser couldn't make the sign-in's session key (Ed25519 in WebCrypto).
      if (reason === 'webcrypto_unsupported') return 'This browser can’t create the key Journear’s sign-in needs (no Ed25519 in WebCrypto). Update it, or use another browser.';
      if (reason === 'webcrypto_failed') return `This browser failed to create the key Journear’s sign-in needs. Try again. ${REPORT}`;
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
      return 'Rejected in the Journear Passport window: nothing was signed.';
    case 4100:
      if (reason === 'share_not_fresh') return '“Sign out other devices” works only within 5 minutes of signing in. Sign out, sign in again, then try it.';
      if (reason === 'mainnet_not_allowed') return 'Refused: this demo app signs for test networks only.';
      return 'Not allowed: you may have been signed out. Sign in and try again.';
    case 4900:
      if (reason === 'signed_out') return SIGNED_OUT_MESSAGE;
      return 'The connection to the Journear vault was lost. Reload the page.';
    case 4902:
      return 'This EVM chain is not configured on the demo.';
    default:
      break;
  }
  if (e instanceof TypeError && /fetch|network|load failed/iu.test(e.message)) return 'Network error. Check your connection and try again.';
  if (action === 'copy') return 'Could not copy to the clipboard. Select the text and copy it yourself.';
  return `Something went wrong${code !== null ? ` (${code})` : ''}. ${REPORT}`;
}
