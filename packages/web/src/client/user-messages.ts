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
const TEST_APP_KIND = `This app is a test version, and ${P} doesn’t sign this kind of request for it. ${NOTHING_SIGNED}`;
const OUT_OF_DATE_SIGNED = 'This request is out of date, so nothing was signed. Try again.';
const CANT_CHECK = `${P} couldn’t check this request right now, so nothing was signed. Try again later.`;
const APP_SETUP = `This app isn’t set up correctly with ${P}, so nothing was sent. Tell the app’s team.`;

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
  // D864: true for whoever made the link and for the email's holder who didn't (the window offers to cancel it); D881:
  // a waiting Google account gets it too, so it names the sign-in, not the email.
  link_pending: `This sign-in is waiting to be linked to a wallet, so it can’t open one yet. Sign in again and follow the steps in the ${P} window.`,
  link_refused: 'These sign-in methods can’t be linked. Sign in with the one that opened your wallet.',
  email_sharing_unavailable: `${P} can’t share your email right now. Try again later.`,
});

/** Closer sentences for some `data.reason` values, by code. */
const BY_REASON: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  // D865: the user chose to remove this sign-in from the wallet it was linked to; the window finishes the removal (its
  // code may still be to come), so the sentence is true either way.
  login_cancelled: {
    link_remove: `You chose to remove this sign-in from that wallet. Finish it in the ${P} window. Then sign in again when you’re ready.`,
    // D871: the window closed by the user, and a new Google user who didn't share their email address.
    popup_closed: `You closed the ${P} window, so nothing changed. Sign in again when you’re ready.`,
    email_consent_declined: 'You didn’t share your Google email address, so no wallet was opened. Sign in with email instead, or try Google again.',
    google_account_mismatch: 'You picked a different Google account, so nothing changed. Try again with the same account, or sign in with email instead.',
  },
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
    // D871: the vault's other NEAR refusals (before its window, nothing signed).
    near_key_unknown: 'Your account isn’t set up yet, so nothing was signed. Try again in a moment.',
    near_delegate_nonce_used: 'This request was already used, perhaps in another tab. Nothing new was signed. Check whether it went through before you try again.',
    near_delegate_nonce_stale: OUT_OF_DATE_SIGNED,
    near_delegate_nonce_too_large: 'This request can’t be checked yet, so nothing was signed. Wait a few seconds and try again.',
    near_delegate_expiry: OUT_OF_DATE_SIGNED,
    near_delegate_test_app_action: TEST_APP_KIND,
    near_delegate_test_app_receiver: TEST_APP_KIND,
    // D871: Journear's sandbox mainnet demo (Journear's own app; partner apps never see these).
    mainnet_demo_over_cap: 'This is over the limit for one payment in this test version. Nothing was signed. Try a smaller amount.',
    mainnet_demo_unknown_call: `${P} can’t tell how much money this could send, so nothing was signed.`,
    mainnet_demo_wrong_destination: 'This would send money to a wallet that isn’t yours, so it was stopped. Nothing was signed.',
    mainnet_demo_unpriced: 'Journear has no price for this token, so nothing was signed.',
    mainnet_demo_prices_stale: 'Journear’s prices for this test version are out of date, so nothing was signed. Try again later.',
    // D871: the app's setup with Journear Passport, from any call to Journear's service.
    missing_key: APP_SETUP,
    unknown_app: APP_SETUP,
    scope_conflict: APP_SETUP,
  },
  api_unavailable: {
    near_rpc_unavailable: CANT_CHECK,
    near_rpc_single_provider: CANT_CHECK,
    mainnet_demo_unconfirmed: 'Journear couldn’t check this just now, so nothing was signed. Try again in a few seconds.',
  },
  email_sharing_unavailable: {
    off: 'This app doesn’t ask for your email address. Nothing was shared.',
    no_address: `${P} has no email address for this sign-in. Sign in again, then try again.`,
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
 * The sponsored action's reasons (gas sponsorship for EVM actions: the vault's `evm-sponsor.ts` refusals and the API codes it passes
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
  accountPending: 'Your account has other actions waiting on the network, so this one couldn’t go through. Wait a moment, then try again.',
});

/**
 * Every `data.reason` a sponsored action's error can carry (`HanaSponsorError`), with the sentence `userMessage` gives
 * for it, so a page can branch on the known reasons; new ones may come, so keep a default.
 */
const SPONSOR_REASON_TEXT = {
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
  account_pending: SPONSOR.accountPending,
  account_busy: SPONSOR.busy,
  batch_too_large: SPONSOR.tooBig,
  // D871: the vault's own refusal of calls it can't use (sponsorPreflight): the vault's words.
  invalid_request: SPONSOR.notForThis,
} satisfies Record<string, string>;

/** A sponsored action's known reason (SPONSOR_REASONS). */
export type KnownSponsorReason = keyof typeof SPONSOR_REASON_TEXT;
/** Internal (tests and the SDK's own lookups): the sentences are reached through `userMessage` and `userMessageFor` only. */
export const SPONSOR_REASONS: Readonly<Record<KnownSponsorReason, string>> = Object.freeze(SPONSOR_REASON_TEXT);
/** Every known sponsored-action reason name, to branch on (the sentences may be reworded at any time). */
export const SPONSOR_REASON_NAMES: readonly KnownSponsorReason[] = Object.freeze(Object.keys(SPONSOR_REASON_TEXT) as KnownSponsorReason[]);
/** `data.reason` of a HanaSponsorError: a known reason, or one a later release adds (keep a default branch). */
export type SponsorReason = KnownSponsorReason | (string & {});

/** The reasons `hana.evm.sponsorship()` answers with when `available` is false. */
export const SPONSORSHIP_REASON_NAMES = Object.freeze(['chain_not_enabled', 'app_not_sponsored', 'paused', 'budget_exhausted', 'not_available'] as const);
/** A reason `hana.evm.sponsorship()` knows. */
export type KnownSponsorshipReason = (typeof SPONSORSHIP_REASON_NAMES)[number];
/** `SponsorshipStatus.reason`: a known reason, or one a later release adds. */
export type SponsorshipReason = KnownSponsorshipReason | (string & {});

const table = (t: object): Readonly<Record<string, string>> => t as Readonly<Record<string, string>>;

// D871. The reasons of Journear Passport's NEAR relay (below).
/**
 * The reasons of Journear Passport's NEAR relay (`hana.near.relay`, `activate`: the API's codes it passes on as
 * `data.reason` with 4100, `rate_limited` or `api_unavailable`). Some names are also a sponsored action's
 * (`gas_too_high`, `app_budget_exhausted`, `timeout`, `relayer_busy`, …): which sentence is meant depends on the error's
 * source (`userMessageFor`'s third argument), never on the name alone. A result the relay can answer after its
 * transaction may have gone out (the API's key object returns it without `notSent`) says to check first: retrying
 * with a new signature could run the request twice (tested against the API's source).
 */
const NEAR_OUT_OF_DATE = 'This request is out of date, so nothing was sent. Try again.';
const NEAR_NOT_PAID = 'Journear doesn’t pay the fee for this kind of request. Nothing was sent.';
const NEAR_UNUSABLE = 'Journear couldn’t use this request, so nothing was sent. Try again, or tell the app’s team.';
const NEAR_UNAVAILABLE = 'Journear couldn’t send this right now. Try again later.';
const NEAR_REFUSED = 'The network refused this request, so it didn’t go through. Try again.';
const NEAR_UNKNOWN = 'Journear couldn’t tell whether your request went through. Check before you try again.';
const NEAR_RELAY_REASON_TEXT = {
  near_account_unrecorded: 'Journear is still setting up your account for this app. Try again in a few seconds.',
  delegate_nonce_used: 'This request was already sent, perhaps in another tab. Check whether it went through before you try again.',
  delegate_nonce_too_large: 'This request can’t be used yet, so nothing was sent. Wait a few seconds and try again.',
  delegate_expired: NEAR_OUT_OF_DATE,
  block_height_too_far: NEAR_OUT_OF_DATE,
  action_not_allowed: NEAR_NOT_PAID,
  deposit_not_allowed: NEAR_NOT_PAID,
  receiver_not_allowed: NEAR_NOT_PAID,
  gas_too_high: NEAR_NOT_PAID,
  bad_request: NEAR_UNUSABLE,
  bad_delegate: NEAR_UNUSABLE,
  bad_delegate_signature: NEAR_UNUSABLE,
  sender_not_implicit: NEAR_UNUSABLE,
  account_not_activated: 'Your account isn’t set up yet, so nothing was sent. Try again in a moment.',
  access_key_missing: `${P} can’t act for this account any more, so nothing was sent. Tell the app’s team.`,
  already_relayed: 'This request was already sent. Check whether it went through before you try again.',
  contract_rejected: 'This didn’t finish, but part of it may have gone through. Check before you try again, or tell the app’s team.',
  delegate_rejected: NEAR_REFUSED,
  rate_limited: 'Too many requests right now. Wait a moment and try again.',
  // The sponsored action's sentences where the meaning is the same.
  app_budget_exhausted: SPONSOR.budgetUsed,
  relay_budget_exhausted: 'Journear’s free network fees are used up for today. Try again tomorrow.',
  timeout: 'Your request was sent but isn’t confirmed yet. Check again in a minute before you try again.',
  // After a broadcast (a dropped transaction, a nonce lost to it) as well as before: check first.
  relayer_busy: 'Journear is busy right now. Check whether your request went through before you try again.',
  // The key object unreachable, or failing after its send began, and NEAR unreachable on a retry: outcome unknown.
  relayer_unavailable: NEAR_UNKNOWN,
  near_unavailable: NEAR_UNKNOWN,
  directory_unavailable: NEAR_UNAVAILABLE,
  rate_limiter_unavailable: NEAR_UNAVAILABLE,
  // NEAR refused the transaction itself (an invalid transaction is never included), so it never ran.
  near_rejected: NEAR_REFUSED,
  near_error: NEAR_UNKNOWN,
  relayer_unconfigured: SPONSOR.notOffered,
  // The key object's own pool check (returned without `notSent`, so the rule above applies).
  method_not_allowed: 'Journear couldn’t use this request. Check whether it went through before you try again, or tell the app’s team.',
} satisfies Record<string, string>;

/** A NEAR relay reason. */
export type NearRelayReason = keyof typeof NEAR_RELAY_REASON_TEXT;
/** Internal, as SPONSOR_REASONS. */
export const NEAR_RELAY_REASONS: Readonly<Record<NearRelayReason, string>> = Object.freeze(NEAR_RELAY_REASON_TEXT);
/** Every known NEAR relay reason name, to branch on (the sentences may be reworded at any time). */
export const NEAR_RELAY_REASON_NAMES: readonly NearRelayReason[] = Object.freeze(Object.keys(NEAR_RELAY_REASON_TEXT) as NearRelayReason[]);

/**
 * Where an error came from, when a reason's name alone can't say (`userMessageFor`'s third argument): a sponsored EVM
 * action (`HanaSponsorError`, and the EIP-1193 provider's error for one), or a call that isn't one (any other
 * `HanaError`: a shared name there is the NEAR relay's). Without it, a shared name reads as the sponsored action's.
 */
export type UserMessageSource = 'sponsored_action' | 'near_relay';

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
 * `source` says where it came from when a reason's name is shared (UserMessageSource); a HanaError's and a
 * HanaSponsorError's own `userMessage` pass it.
 */
export function userMessageFor(code: unknown, data: unknown, source?: UserMessageSource): string {
  const key = String(code);
  const reasons = reasonOf(data);
  const actionCode = SPONSOR_CODES.has(key);
  const sponsor = table(SPONSOR_REASONS);
  const near = table(NEAR_RELAY_REASONS);
  // A sponsored action's reasons are the vault's words, first (`invalid_request` reads as the vault says).
  if (source === 'sponsored_action' && actionCode) for (const r of reasons) if (Object.hasOwn(sponsor, r)) return sponsor[r] as string;
  const closer = Object.hasOwn(BY_REASON, key) ? BY_REASON[key] : undefined;
  if (closer) for (const r of reasons) if (Object.hasOwn(closer, r)) return closer[r] as string;
  if (actionCode) {
    if (source !== 'sponsored_action') for (const r of reasons) if (Object.hasOwn(near, r) && (source === 'near_relay' || !Object.hasOwn(sponsor, r))) return near[r] as string;
    for (const r of reasons) if (Object.hasOwn(sponsor, r)) return sponsor[r] as string;
  }
  return Object.hasOwn(BY_CODE, key) ? (BY_CODE[key] as string) : DEFAULT_USER_MESSAGE;
}
