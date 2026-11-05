// Plain-language messages for what the SDK rejects with (docs/integration.md section 13). `hana.*` rejects with a
// HanaError (a numeric or string code), the EIP-1193 provider with a ProviderRpcError whose numeric code hides the
// Hana code in `data.code`; a network failure inside the SDK can surface as a TypeError. Either carries the Hana API
// request it came from in `data.requestId` (D405), when it came from one.
import { isApiRequestId } from '@hana-id/core';

export type DemoAction = 'load' | 'login' | 'logout' | 'revoke' | 'sign' | 'export' | 'copy' | 'identity';

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

/** What to tell the user, for an error of `action`. */
export function plainMessage(e: unknown, action: DemoAction): string {
  const { code, reason } = errorInfo(e);
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
