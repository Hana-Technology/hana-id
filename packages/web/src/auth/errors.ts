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

const MESSAGES: Partial<Record<HanaErrorCode, string>> = {
  no_google_client: 'This app has no Google sign-in set up yet.',
  origin_not_allowed: 'This site isn’t allowed to sign in to this app.',
  app_suspended: `This app is suspended on ${BRAND.product}.`,
  rate_limited: 'Too many attempts. Wait a minute and try again.',
  api_unavailable: `${BRAND.company} isn’t reachable right now. Try again in a moment.`,
  config_mismatch: 'The sign-in request didn’t match this app’s settings, so it was stopped.',
  token_invalid: 'Google’s answer couldn’t be checked.',
  token_has_pii: `Google sent more account details than ${BRAND.company} accepts, so the sign-in was stopped.`,
  google_error: 'Google didn’t finish the sign-in.',
  login_timeout: 'The sign-in took too long. Start again from the app.',
  ckd_failed: 'Your wallet’s key couldn’t be made. Try again.',
  derive_failed: 'Your wallet’s key couldn’t be made. Try again.',
  pairing_failed: 'The key service sent an answer that failed its check, so it wasn’t used.',
  address_mismatch: 'The key that was made doesn’t match your wallet, so nothing is shown.',
  session_consumed: 'This sign-in was used by someone else. Start again.',
  popup_blocked: 'Your browser blocked the sign-in window. Allow pop-ups and try again.',
};

export const errorMessage = (code: HanaErrorCode): string => MESSAGES[code] ?? 'Something went wrong.';

/** What a page says when the browser can't make the session key (D385; core's sessionKeyFailure). */
export const sessionKeyText = (f: SessionKeyFailure): string =>
  f.reason === 'webcrypto_unsupported'
    ? 'This browser can’t create the key the sign-in needs. Update it, or use another browser.'
    : 'This browser couldn’t create the key the sign-in needs. Try again.';
