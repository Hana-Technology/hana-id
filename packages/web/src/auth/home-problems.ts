// What Hana Home says when something is refused or fails (home-page.ts, home-export.ts): one sentence per code, in
// Hana's own words. The API's message is never shown: only its code picks the sentence, so an odd answer can't put
// text on the page.
import { ApiError } from '@hana-id/core';

export interface HomeProblem {
  code: string;
  text: string;
  requestId: string | null;
  /** The sign-in itself was refused: the page asks for a new one instead of showing this. */
  signInAgain: boolean;
}

export const UNREACHABLE = 'Hana Home is not reachable right now. Nothing on screen was lost. Try again in a moment.';
const NOT_COVERED = 'Hana can’t open this wallet from here. If the app still runs, use the app itself.';
const TOKEN_REFUSED = 'Google’s answer could not be verified. Sign in again to retry.';

/** The sentence for a code: the API's refusals, and the codes the page itself gives to what it stops. */
const PROBLEM_TEXT: Readonly<Record<string, string>> = Object.freeze({
  rate_limited: 'Too many requests. Wait a minute and try again.',
  home_busy: 'Hana Home has reached its limit for today. Try again tomorrow.',
  home_no_wallet: 'There is no wallet for this sign-in in that app.',
  home_account_mismatch: 'Sign in as the same account you used in Hana Home.',
  not_covered: NOT_COVERED,
  shared_login_disabled: NOT_COVERED,
  unregistered_client: NOT_COVERED,
  scope_mismatch: NOT_COVERED,
  link_pending: 'A sign-in method is still being added to this wallet. Try again once that has finished.',
  unknown_scope: 'Hana doesn’t know that app.',
  counter_reused: 'That request was already sent. Try again.',
  bad_request: 'Hana Home couldn’t read that request. Try again.',
  origin_not_allowed: 'Hana Home can’t be used from this address.',
  bad_response: 'Hana Home got an answer it couldn’t read. Try again in a moment.',
  home_directory_unavailable: UNREACHABLE,
  rate_limiter_unavailable: UNREACHABLE,
  near_unavailable: UNREACHABLE,
  api_unavailable: UNREACHABLE,
  // Opening a wallet (home-export.ts). Each says whether anything was shown: nothing ever is on a refusal.
  session_exists: 'That sign-in was already used. Sign in again to retry.',
  session_consumed: 'That sign-in was already used. Nothing was shown. Sign in again to retry.',
  ckd_failed: 'The key service didn’t produce the key this time. Nothing was shown. Sign in again to retry.',
  derive_failed: 'The wallet could not be opened. Nothing was shown. Sign in again to retry.',
  contract_rejected: 'The sign-in was refused on NEAR. Nothing was shown.',
  address_mismatch: 'The wallet this sign-in opened is not the one Hana has on record for you in this app, so nothing is shown. Try again later.',
  pairing_failed: 'The key service returned an answer that failed its check, so it was not used. Nothing was shown.',
  invalid_token: TOKEN_REFUSED,
  nonce_mismatch: TOKEN_REFUSED,
  token_expired: TOKEN_REFUSED,
  wrong_audience: TOKEN_REFUSED,
  token_invalid: TOKEN_REFUSED,
  token_has_pii: 'Google returned more account details than Hana accepts, so the sign-in was stopped.',
  google_error: 'Google did not complete the sign-in. Try again.',
  stale_sign_in: 'Google did not ask you to sign in again. Try again.',
  login_cancelled: 'The sign-in window closed before it finished. Try again.',
  login_timeout: 'The sign-in took too long. Try again.',
  popup_blocked: 'Your browser blocked the sign-in window. Allow pop-ups for this page and try again.',
  home_signing_in: 'Finish signing in to Hana Home in the other window first, then try again.',
  home_signed_out: 'Your sign-in to Hana Home has ended. Sign in to Hana Home again, then try once more.',
  path_disputed: 'NEAR providers disagree about which wallet this sign-in opens, so Hana Home opened nothing. Try again later.',
  path_unconfirmed: 'Hana Home couldn’t confirm on NEAR which wallet this sign-in opens, so it opened nothing. Try again in a moment.',
  near_unreadable: 'Hana Home couldn’t read NEAR to check this app. Nothing was opened. Try again in a moment.',
  root_unsupported: 'This wallet belongs to a sign-in method Hana Home can’t open yet.',
  // Email (home-email.ts).
  home_email_unavailable: 'Email sign-in to Hana Home isn’t available right now. Try again later.',
  email_token_invalid: 'The email sign-in could not be checked. Nothing was shown. Try again.',
  no_sign_in: 'Hana Home can’t sign you in right now. Try again later.',
});

/** A code as the page may show it: the API's lowercase snake case only. */
const shownCode = (code: string): string => (/^[a-z][a-z0-9_]{0,63}$/u.test(code) ? code : 'error');
const shownRequestId = (id: string | null): string | null => (id !== null && /^[A-Za-z0-9_-]{1,64}$/u.test(id) ? id : null);

/** A problem the page itself names, with one of the sentences above or its own. */
export const plainProblem = (code: string, text?: string): HomeProblem => ({ code, text: text ?? PROBLEM_TEXT[code] ?? 'Something went wrong. Try again.', requestId: null, signInAgain: false });

/** What the page says for a failed Home API call. Never the API's own message: only a code picks the sentence. */
export function homeProblem(err: unknown): HomeProblem {
  if (!(err instanceof ApiError)) return { code: 'api_unavailable', text: UNREACHABLE, requestId: null, signInAgain: false };
  const code = shownCode(err.code);
  const requestId = shownRequestId(err.requestId);
  // Every credential refusal is a 401: the sign-in has ended, whatever the code.
  if (err.status === 401) return { code, text: 'Your sign-in to Hana Home has ended. Sign in again to go on.', requestId, signInAgain: true };
  const known = Object.hasOwn(PROBLEM_TEXT, code) ? PROBLEM_TEXT[code] : undefined;
  if (known !== undefined) return { code, text: known, requestId, signInAgain: false };
  if (err.status === 429) return { code, text: PROBLEM_TEXT.rate_limited as string, requestId, signInAgain: false };
  if (err.status >= 500) return { code, text: UNREACHABLE, requestId, signInAgain: false };
  return { code, text: 'Something went wrong. Try again.', requestId, signInAgain: false };
}

/**
 * Opening a wallet is limited by the hour and by the day, not the minute, so the same code reads differently there: the
 * sentence says how long the API asked to wait (`retry-after`, in seconds), or claims no time when it didn't say.
 */
export function deriveRateLimited(retryAfterS: unknown): string {
  const start = 'This wallet was opened too many times.';
  if (typeof retryAfterS !== 'number' || !Number.isFinite(retryAfterS) || retryAfterS <= 0) return `${start} Try again later.`;
  const minutes = Math.ceil(retryAfterS / 60);
  if (minutes <= 60) return `${start} Try again in about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
  const hours = Math.ceil(retryAfterS / 3600);
  return `${start} Try again in about ${hours} hours.`;
}
