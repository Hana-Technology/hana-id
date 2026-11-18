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
  // Only what is always true: a 4100 can also answer an action that was signed or sent (a sponsored action's refusal).
  [ErrorCode.unauthorized]: `${P} didn’t allow this. You may need to sign in again.`,
  [ErrorCode.unsupportedMethod]: `${P} can’t do this kind of request. ${NOTHING_SIGNED}`,
  [ErrorCode.disconnected]: `The connection to ${P} was lost. Reload the page and try again.`,
  [ErrorCode.chainNotConfigured]: `This app asked for a network it hasn’t set up with ${P}. ${NOTHING_SIGNED}`,
  // The JSON-RPC codes the SDK raises itself (client/errors.ts RpcCode).
  '-32602': `The app sent a request ${P} couldn’t read. ${NOTHING_SIGNED}`,
  '-32603': `Something went wrong in ${P}. If you sent something, check whether it went through before you try again.`,
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
  session_consumed: 'This sign-in was already used, perhaps in another window. If that wasn’t you, start again and tell the app’s support.',
  rate_limited: 'Too many attempts. Wait a minute and try again.',
  app_suspended: `This app is paused in ${P} right now.`,
  origin_not_allowed: `This site isn’t allowed to use this app’s ${P} sign-in. Tell the app’s team.`,
  // May follow a send whose outcome is unknown: never "try again" without "check first".
  api_unavailable: `${P} isn’t reachable right now. If you sent something, check whether it went through before you try again.`,
  busy: `${P} is finishing something else for this wallet. Wait a moment, then try again.`,
  identity_unavailable: `${P} can’t confirm your sign-in right now. Try again later.`,
  session_ended: `Your ${P} sign-in has ended. Sign in again.`,
  login_method_unavailable: 'This way of signing in isn’t available for this app. Choose another one.',
  code_invalid: 'The code was wrong. Sign in again to get a new one.',
  challenge_expired: 'The code expired. Sign in again to get a new one.',
  // D864: true for whoever made the link and for the email's holder who didn't (the window offers to cancel it).
  link_pending: `This email is waiting to be linked to a wallet. Sign in again and follow the steps in the ${P} window.`,
  link_refused: 'These sign-in methods can’t be linked. Sign in with the one that opened your wallet.',
  email_sharing_unavailable: `${P} can’t share your email right now. Try again later.`,
});

/** Closer sentences for some `data.reason` values, by code. */
const BY_REASON: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  [ErrorCode.unauthorized]: {
    mainnet_not_allowed: TEST_APP,
    raw_not_allowed_for_test_apps: TEST_APP,
    too_many_pending: `Too many requests are waiting for you in ${P}. Approve or reject those first, then try again.`,
    invalid_request: `${P} couldn’t use this request, so nothing was signed or sent. Try again, or tell the app’s team.`,
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

/**
 * The sponsored action's reasons (gas-free EVM actions: the vault's `evm-sponsor.ts` refusals and the API codes it passes
 * on as `data.reason`), each with the vault's own sentence (`SPONSOR_TEXT`), copied word for word so the partner's text
 * and the approval window agree. They come with 4100, `rate_limited`, `api_unavailable`, `session_ended` or `busy`, and
 * are read after the per-code reasons above. `reverted` and `not_executed` take the sentence that is true whether or
 * not the batch carried the one-time setup (the reason doesn't say). An unknown outcome says to check first.
 */
const SPONSOR = Object.freeze({
  notOffered: 'Free network fees aren’t offered on this network.',
  notForThis: 'Journear doesn’t pay network fees for this action.',
  delegatedElsewhere: 'Your account was set up by another wallet app, so Journear can’t pay network fees for it. Nothing was sent.',
  budgetUsed: 'Journear’s free network fees for this app are used up for today. Try again tomorrow.',
  notAvailable: 'Free network fees aren’t available for your account right now. Try again later.',
  tooBig: 'This action is too big for free network fees.',
  busy: 'Your last action is still going through. Wait for it to finish, then try again.',
  clockWrong: 'Your device’s clock is wrong. Set it to the right time, then try again.',
  notReady: 'Journear couldn’t get this action ready. Nothing was sent. Try again later.',
  tooSlow: 'This took too long, so nothing was sent. Please try again.',
  noSignIn: 'Journear can’t do this with your current sign-in. Sign in again, then try again.',
  signInEnded: 'Your sign-in has ended. Sign in again, then try again.',
  failedAfterSetup: 'The action didn’t go through. Your account’s one-time setup may still have been done. Nothing else changed.',
  wouldFail: 'This action would fail, so it wasn’t sent. Nothing changed.',
  notConfirmed: 'Your action was sent but isn’t confirmed yet. Check again in a minute before you try again.',
  unknownOutcome: 'Journear couldn’t tell whether your action went through. Check before you try again.',
  accountChanged: 'Your account changed while this was getting ready. Nothing was sent. Please try again.',
  alreadySending: 'This action is already being sent. Wait a moment, then check before you try again.',
  settingUp: 'Journear is still setting up your account. Try again in a few seconds.',
  tooMany: 'Too many actions right now. Wait a moment and try again.',
  tooManyFailed: 'Too many actions failed today. Try again tomorrow.',
  unavailable: 'Journear couldn’t send this action right now. Try again later.',
  paused: 'Free network fees are paused right now. Try again later.',
  feesHigh: 'Network fees are too high right now. Nothing was sent. Try again in a few minutes.',
  busyNow: 'Journear is busy with other actions right now. Nothing was sent. Try again in a few seconds.',
  wrongAccount: 'This isn’t the account you’re signed in with. Nothing was sent. Sign in again, then try again.',
  signInNotReady: 'Journear is still finishing your sign-in. Try again in a few seconds.',
  signInUnchecked: 'Journear couldn’t check your sign-in, so nothing was sent. Sign in again, then try again.',
});

export const SPONSOR_REASONS: Readonly<Record<string, string>> = Object.freeze({
  // The vault's own refusals.
  chain_not_sponsored: SPONSOR.notOffered,
  no_evm_account: SPONSOR.noSignIn,
  clock_wrong: SPONSOR.clockWrong,
  deadline_passed: SPONSOR.tooSlow,
  bad_answer: SPONSOR.notReady,
  unknown_outcome: SPONSOR.unknownOutcome,
  sponsor_in_flight: SPONSOR.busy,
  not_available: SPONSOR.notAvailable,
  // Prepare's `allowed: false` and the API's codes.
  delegated_elsewhere: SPONSOR.delegatedElsewhere,
  budget_exhausted: SPONSOR.budgetUsed,
  app_budget_exhausted: SPONSOR.budgetUsed,
  gas_too_high: SPONSOR.tooBig,
  chain_not_enabled: SPONSOR.notOffered,
  app_not_sponsored: SPONSOR.notForThis,
  call_not_sponsored: SPONSOR.notForThis,
  target_not_allowed: SPONSOR.notForThis,
  value_not_allowed: SPONSOR.notForThis,
  too_many_calls: SPONSOR.notForThis,
  reverted: SPONSOR.failedAfterSetup,
  not_executed: SPONSOR.failedAfterSetup,
  simulation_reverted: SPONSOR.wouldFail,
  timeout: SPONSOR.notConfirmed,
  nonce_stale: SPONSOR.accountChanged,
  authorization_nonce_stale: SPONSOR.accountChanged,
  delegation_required: SPONSOR.accountChanged,
  in_progress: SPONSOR.alreadySending,
  account_unrecorded: SPONSOR.settingUp,
  too_many_failures: SPONSOR.tooManyFailed,
  rate_limited: SPONSOR.tooMany,
  deadline_out_of_range: SPONSOR.tooSlow,
  session_ended: SPONSOR.signInEnded,
  api_unavailable: SPONSOR.unavailable,
  // The API's codes for what isn't the user's doing, and the session check's (D856).
  paused: SPONSOR.paused,
  sponsorship_paused: SPONSOR.paused,
  gas_price_too_high: SPONSOR.feesHigh,
  relayer_busy: SPONSOR.busyNow,
  account_mismatch: SPONSOR.wrongAccount,
  session_not_visible: SPONSOR.signInNotReady,
  stale_session_proof: SPONSOR.tooSlow,
  proof_replayed: SPONSOR.alreadySending,
  missing_session_proof: SPONSOR.signInUnchecked,
  bad_session_proof: SPONSOR.signInUnchecked,
  invalid_session_signature: SPONSOR.signInUnchecked,
  bad_wallet_proof: SPONSOR.signInUnchecked,
  scope_mismatch: SPONSOR.signInUnchecked,
  sponsorship_unconfigured: SPONSOR.notOffered,
  relayer_unavailable: SPONSOR.unavailable,
  evm_rpc_unavailable: SPONSOR.unavailable,
  near_unavailable: SPONSOR.unavailable,
  audit_unavailable: SPONSOR.unavailable,
  directory_unavailable: SPONSOR.unavailable,
  rate_limiter_unavailable: SPONSOR.unavailable,
  config_unavailable: SPONSOR.unavailable,
  internal_error: SPONSOR.unavailable,
  outcome_unknown: SPONSOR.unknownOutcome,
  account_busy: SPONSOR.busy,
  batch_too_large: SPONSOR.tooBig,
});

/** The codes a sponsored action's errors come with. */
const SPONSOR_CODES: ReadonlySet<string> = new Set([String(ErrorCode.unauthorized), 'rate_limited', 'api_unavailable', 'session_ended', 'busy']);

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
  const reasons = reasonOf(data);
  if (closer) for (const r of reasons) if (Object.hasOwn(closer, r)) return closer[r] as string;
  if (SPONSOR_CODES.has(key)) for (const r of reasons) if (Object.hasOwn(SPONSOR_REASONS, r)) return SPONSOR_REASONS[r] as string;
  return Object.hasOwn(BY_CODE, key) ? (BY_CODE[key] as string) : DEFAULT_USER_MESSAGE;
}
