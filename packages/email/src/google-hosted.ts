// The Google-hosted rule (docs/email-login-spec.md "The four cases", D119): decides whether automatic linking happens
// at once (cases A and B) or needs a code (A) / waits change_delay_ms (B). Computed by the issuer from Google's
// userinfo at each google-match call, never stored. Not address-defining. Every doubt answers "not Google-hosted",
// the safe side: a code first or the 24 h delay (D158).

import { EMAIL_V1 } from './constants.ts';
import { isNormalizedEmail } from './normalize.ts';

export interface GoogleHostedInput {
  /** The Google account's address from userinfo `email`, already through `normalizeEmail`. */
  email: string;
  /** userinfo's `email_verified`: only the literal `true` counts. */
  emailVerified: boolean;
  /** userinfo's `hd` (the Workspace domain), absent for a personal account. */
  hd?: string | null | undefined;
}

/**
 * Google hosts the mailbox in the same account. Needs `emailVerified === true`, then:
 * - `hd` absent (`undefined` or `null`): the normalized domain is `gmail.com` (so `googlemail.com` too, after the
 *   Gmail canonical form);
 * - `hd` present: it must be **exactly** equal to the normalized domain (not lowercased, IDNA-mapped or trimmed
 *   first, D158); a present `hd` that differs is "not Google-hosted", even for a `gmail.com` address.
 *
 * Throws a `TypeError` when `email` is not a normalized address.
 */
export function isGoogleHosted({ email, emailVerified, hd }: GoogleHostedInput): boolean {
  if (!isNormalizedEmail(email)) throw new TypeError('isGoogleHosted needs a normalized address (normalizeEmail)');
  if (emailVerified !== true) return false;
  const domain = email.slice(email.lastIndexOf('@') + 1);
  if (hd === undefined || hd === null) return domain === EMAIL_V1.gmailCanonicalDomain;
  return typeof hd === 'string' && hd.length > 0 && hd === domain;
}
