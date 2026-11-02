// @hana-id/oidc: RS256 token checks for Hana's Workers (Web Crypto only, no Node API). Google ID tokens for the API
// and the console (`verifyIdToken`, with the isolate's JWKS cache), and Cloudflare Access application tokens for the
// admin Worker (`AccessJwtVerifier`). JWKS parsing and RSA key comparison stay in @hana-id/jwks, shared with the
// watchdog.
export {
  IDENTITY_TOKEN_TYP,
  ISSUER_PROVIDERS,
  JWKS_URLS,
  type KeyObserver,
  type VerifiedToken,
  type VerifyFailure,
  type VerifyOptions,
  type VerifyResult,
  clearJwksCache,
  providerForIssuer,
  publishedKeys,
  verifyIdToken,
} from './id-token.ts';
export {
  ACCESS_CERTS_MAX_TTL_MS,
  ACCESS_JWT_HEADER,
  ACCESS_SKEW_MS,
  type AccessFailure,
  type AccessIdentity,
  type AccessResult,
  AccessJwtVerifier,
  type AccessVerifierConfig,
  MAX_ACCESS_JWT_BYTES,
  accessCertsUrl,
} from './access.ts';
export { FETCH_TIMEOUT_MS, type Fetcher, JwksUnavailableError, MAX_BODY_BYTES, cacheMaxAgeS } from './jwks-cache.ts';
