// The Google-hosted rule (docs/email-login-spec.md "The four cases", D119): decides whether automatic linking happens
// at once (cases A and B) or needs a code (A) / waits change_delay_ms (B). Computed by the issuer from Google's
// userinfo at each google-match call, never stored. Not address-defining.

import { EMAIL_V1 } from './constants.ts';
import { isNormalizedEmail } from './normalize.ts';

export interface GoogleHostedInput {
  /** The Google account's verified address, already through `normalizeEmail`. */
  email: string;
  /** userinfo's `hd` (the Workspace domain), absent for a personal account. */
  hd?: string | null | undefined;
}

/**
 * Google hosts the mailbox in the same account: the normalized domain is `gmail.com` (so `googlemail.com` too, after
 * the Gmail canonical form), or `hd` is present and **exactly** equal to the normalized domain (D158: `hd` is not
 * normalized or case-folded first; any other `hd` reads as "not Google-hosted", the safe side). Throws a `TypeError`
 * when `email` is not a normalized address.
 */
export function isGoogleHosted({ email, hd }: GoogleHostedInput): boolean {
  if (!isNormalizedEmail(email)) throw new TypeError('isGoogleHosted needs a normalized address (normalizeEmail)');
  const domain = email.slice(email.lastIndexOf('@') + 1);
  if (domain === EMAIL_V1.gmailCanonicalDomain) return true;
  return typeof hd === 'string' && hd.length > 0 && hd === domain;
}
