// @hana-id/email: the email login's identity rules, shared by the email issuer (apps/email-issuer), the API and the
// popup. Pure functions over Web Crypto; no I/O, no Node API. Normalization and `sub` are FROZEN at the address freeze
// (vectors/email-v1.json, test/vectors.test.ts).

export { EMAIL_V1 } from './constants.ts';
export {
  isNormalizedEmail,
  normalizeDomain,
  normalizeEmail,
  type InvalidEmailReason,
  type NormalizeDomainResult,
  type NormalizeResult,
} from './normalize.ts';
export { emailSub, importSubKey, isEmailSub, subMessage } from './sub.ts';
export { isGoogleHosted, type GoogleHostedInput } from './google-hosted.ts';
export { disposableDomains, isDisposableDomain } from './disposable.ts';
export { DISPOSABLE_DOMAINS_SOURCE } from './disposable-domains.ts';
