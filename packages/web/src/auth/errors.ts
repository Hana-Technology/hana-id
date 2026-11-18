// Errors the auth pages show. Codes are the protocol's (docs/batch-b-spec.md "Envelope"); messages are for the user and
// never carry a token, key or request body.
import { BRAND } from '@hana-id/brand';
import { ApiError, type HanaErrorCode, type SessionKeyFailure } from '@hana-id/core';

export class PageError extends Error {
  constructor(
    readonly code: HanaErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PageError';
  }
}

/** The protocol code for an API failure (as the vault maps them). */
export function apiErrorCode(err: unknown): HanaErrorCode {
  if (!(err instanceof ApiError)) return 'api_unavailable';
  switch (err.code) {
    case 'no_google_client':
    case 'origin_not_allowed':
    case 'app_suspended':
    case 'token_has_pii':
      return err.code;
    case 'scope_conflict':
      return 'origin_not_allowed';
    case 'rate_limited':
      return 'rate_limited';
    default:
      return err.status === 429 ? 'rate_limited' : 'api_unavailable';
  }
}

/** D853: a wallet that couldn't be opened, in the user's words (the key and the key service are never named). */
const WALLET_NOT_OPENED = 'We couldn’t open your wallet. Try again.';

/**
 * D853: what a page says when one of its own checks stops a sign-in (another signer named, a nonce that doesn't commit
 * to its session): one plain sentence, the code line under it says which. `from`: where to start again.
 */
export const safetyStop = (from: string): string => `This sign-in didn’t pass ${BRAND.company}’s safety check, so it was stopped. Start again from ${from}.`;

/** D853: a sign-in whose check threw for a reason the page didn't name. */
export const uncheckedStop = (from: string): string => `This sign-in couldn’t be checked, so it was stopped. Start again from ${from}.`;

/** D853: the browser refused the storage a sign-in or export needs (sessionStorage blocked or full). */
export const STORAGE_BLOCKED = 'Your browser didn’t let this sign-in save what it needs. Allow this site to store data, or use another browser, then try again.';

const MESSAGES: Partial<Record<HanaErrorCode, string>> = {
  no_google_client: 'This app has no Google sign-in set up yet.',
  origin_not_allowed: 'This site isn’t allowed to sign in to this app.',
  app_suspended: `This app is suspended on ${BRAND.product}.`,
  rate_limited: 'Too many attempts. Wait a minute and try again.',
  api_unavailable: `${BRAND.company} isn’t reachable right now. Try again in a moment.`,
  config_mismatch: 'This sign-in didn’t match this app’s settings, so it was stopped. Start again from the app.',
  token_invalid: `${BRAND.company} couldn’t check your Google sign-in. Try again.`,
  token_has_pii: `Google sent more account details than ${BRAND.company} accepts, so the sign-in was stopped.`,
  google_error: 'Google didn’t finish the sign-in. Try again.',
  login_timeout: 'The sign-in took too long. Start again from the app.',
  ckd_failed: WALLET_NOT_OPENED,
  derive_failed: WALLET_NOT_OPENED,
  pairing_failed: `Something didn’t look right while opening your wallet, so ${BRAND.company} stopped to keep it safe. Try again.`,
  address_mismatch: `${BRAND.company} opened a different wallet from the one it expected, so it stopped. Nothing was shown or changed.`,
  session_consumed: 'This sign-in was already used, perhaps in another window. If that wasn’t you, start again and tell the app’s support.',
  popup_blocked: 'Your browser blocked the sign-in window. Allow pop-ups and try again.',
};

export const errorMessage = (code: HanaErrorCode): string => MESSAGES[code] ?? 'Something went wrong. Try again.';

/** What a page says when the browser can't make the session key (D385; core's sessionKeyFailure). */
export const sessionKeyText = (f: SessionKeyFailure): string =>
  f.reason === 'webcrypto_unsupported'
    ? `This browser is too old for ${BRAND.product}’s sign-in. Update it, or use another browser.`
    : 'This browser couldn’t finish setting up the sign-in. Try again.';
