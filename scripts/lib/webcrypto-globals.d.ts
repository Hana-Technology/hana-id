// WebCrypto's global types, which @types/node keeps under node:crypto's `webcrypto` (the global `crypto` is that
// WebCrypto at runtime). apps/email-issuer/src/signer.ts (imported by lib/admin-email-client.ts) names `CryptoKey`;
// @hana-id/email (imported by test/admin-email-client.test.ts through apps/email-issuer's contract fixture generator)
// names `HmacKeyAlgorithm`.
declare global {
  type CryptoKey = import('node:crypto').webcrypto.CryptoKey;
  type HmacKeyAlgorithm = import('node:crypto').webcrypto.HmacKeyAlgorithm;
}
export {};
