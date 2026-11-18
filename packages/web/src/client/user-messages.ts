// D861: a plain sentence for the partner's user, beside the developer's `message`. Partners show errors to people who
// may never have used a wallet (D853); `message` stays developer-facing (it names the CSP, origins, keys and reasons a
// developer needs, and partners may log or match it), and `userMessage` is the one to show. It is worked out here, in
// the SDK, from the error's `code` and `data.reason` only: never from `message` or any other text the vault, the API or
// the network sent, so nothing a page receives can put words in front of the user. Each sentence says what happened,
// whether anything was done, and what to do (D853 rule 7); no code, key or chain word.
import { ErrorCode } from '@hana-id/core';

const P = 'Journear Passport';

const NOTHING_SIGNED = 'Nothing was signed.';
const WALLET_NOT_OPENED = 'We couldn’t open your wallet. Try again.';
const CHECK_STOP = `This didn’t pass ${P}’s safety check, so it was stopped. Nothing was signed. Try again.`;
const TEST_APP = `This app is a test version, so ${P} lets it use only test networks. ${NOTHING_SIGNED}`;

/** The sentence for a code, when `data.reason` doesn't pick a closer one. */
const BY_CODE: Readonly<Record<string, string>> = Object.freeze({
  [ErrorCode.userRejected]: `You rejected this in ${P}, or closed it. Nothing was approved.`,
  [ErrorCode.unauthorized]: `${P} didn’t allow this. You may need to sign in again. ${NOTHING_SIGNED}`,
  [ErrorCode.unsupportedMethod]: `${P} can’t do this kind of request. ${NOTHING_SIGNED}`,
  [ErrorCode.disconnected]: `The connection to ${P} was lost. Reload the page and try again.`,
  [ErrorCode.chainNotConfigured]: `This app asked for a network it hasn’t set up with ${P}. ${NOTHING_SIGNED}`,
  // The JSON-RPC codes the SDK raises itself (client/errors.ts RpcCode).
  '-32602': `The app sent a request ${P} couldn’t read. ${NOTHING_SIGNED}`,
  '-32603': `Something went wrong in ${P}. Try again in a moment.`,
  '-32005': 'Too many requests. Wait a minute and try again.',
  vault_unavailable: `${P} couldn’t load on this page. Reload the page and try again.`,
  popup_blocked: `Your browser blocked the ${P} window. Allow pop-ups for this site and try again.`,
  coop_blocks_popup: `The ${P} window couldn’t connect to this site, so the sign-in stopped. Tell the app’s team.`,
  storage_unavailable: `Your browser didn’t let ${P} save what it needs. Allow this site to store data, or use another browser.`,
  login_timeout: `The ${P} window didn’t open in time. Try again.`,
  login_cancelled: 'The sign-in was cancelled. Nothing was changed.',
  google_error: 'Google didn’t finish the sign-in. Try again.',
  no_google_client: 'This app’s Google sign-in isn’t set up yet.',
  token_invalid: 'Journear couldn’t check your Google sign-in. Try again.',
  token_has_pii: 'Google sent more account details than Journear accepts, so the sign-in was stopped.',
  config_mismatch: `This sign-in didn’t pass ${P}’s safety check, so it was stopped. Start again.`,
  ckd_failed: WALLET_NOT_OPENED,
  derive_failed: WALLET_NOT_OPENED,
  pairing_failed: 'Something didn’t look right while opening your wallet, so Journear stopped to keep it safe. Try again.',
  address_mismatch: 'Journear opened a different wallet from the one it expected, so it stopped. Nothing was changed.',
  session_consumed: 'This sign-in was already used, perhaps in another window. Start again.',
  rate_limited: 'Too many attempts. Wait a minute and try again.',
  app_suspended: `This app is paused in ${P} right now.`,
  origin_not_allowed: `This site isn’t allowed to use this app’s ${P} sign-in. Tell the app’s team.`,
  api_unavailable: `${P} isn’t reachable right now. Try again in a moment.`,
  busy: `${P} is already showing a key for this wallet. Finish that first.`,
  identity_unavailable: `${P} can’t confirm your sign-in right now. Try again later.`,
  session_ended: `Your ${P} sign-in has ended. Sign in again.`,
  login_method_unavailable: 'This way of signing in isn’t available for this app. Choose another one.',
  code_invalid: 'The code was wrong. Sign in again to get a new one.',
  challenge_expired: 'The code expired. Sign in again to get a new one.',
  link_pending: 'This sign-in method was added to a wallet recently and can’t open it yet. Use the wallet’s other sign-in method for now.',
  link_refused: 'These sign-in methods can’t be linked. Sign in with the one that opened your wallet.',
  email_sharing_unavailable: `${P} can’t share your email right now. Try again later.`,
});

/** Closer sentences for some `data.reason` values, by code. */
const BY_REASON: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  [ErrorCode.unauthorized]: {
    mainnet_not_allowed: TEST_APP,
    raw_not_allowed_for_test_apps: TEST_APP,
    too_many_pending: `Too many requests are waiting for you in ${P}. Approve or reject those first, then try again.`,
    invalid_request: `${P} couldn’t show this request, so it wasn’t signed. Try again, or tell the app’s team.`,
    raw_sign_off: `This app can’t ask for this kind of signature. ${NOTHING_SIGNED}`,
    raw_reserved_domain: CHECK_STOP,
    near_network_mismatch: CHECK_STOP,
    near_block_unknown: `${P} couldn’t check this request, so it wasn’t signed. Try again.`,
    near_relayed_delegate: CHECK_STOP,
  },
  [ErrorCode.disconnected]: {
    signed_out: `You were signed out of ${P} on this device. Sign in again.`,
  },
  login_timeout: {
    pending: 'The sign-in wasn’t finished in time, so it stopped. Sign in again when you’re ready.',
  },
  derive_failed: {
    webcrypto_unsupported: `This browser is too old for ${P}. Update it, or use another browser.`,
    webcrypto_failed: 'This browser couldn’t finish setting up the sign-in. Try again.',
  },
  google_error: {
    access_denied: 'You cancelled the Google sign-in. Nothing was changed.',
  },
  session_ended: {
    signed_out: `You were signed out of ${P} on this device. Sign in again.`,
  },
});

export const DEFAULT_USER_MESSAGE = `Something went wrong in ${P}. Try again.`;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `data.reason`, `data.stage` or `data.error` (Google's), when one is a short code; else null. */
function reasonOf(data: unknown): string[] {
  if (!isObj(data)) return [];
  return [data.reason, data.stage, data.error].filter((v): v is string => typeof v === 'string' && /^[a-z0-9_]{1,64}$/u.test(v));
}

/**
 * The plain sentence for an error of `code` with `data` (a HanaError's, or a ProviderRpcError's inner `data` with the
 * Journear Passport code): from these two only, a closer one for a known `data.reason`, else the code's, else a generic one.
 */
export function userMessageFor(code: unknown, data: unknown): string {
  const key = String(code);
  const closer = Object.hasOwn(BY_REASON, key) ? BY_REASON[key] : undefined;
  if (closer) for (const r of reasonOf(data)) if (Object.hasOwn(closer, r)) return closer[r] as string;
  return Object.hasOwn(BY_CODE, key) ? (BY_CODE[key] as string) : DEFAULT_USER_MESSAGE;
}
