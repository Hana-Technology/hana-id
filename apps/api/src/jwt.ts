// ID-token issuers the API knows. Tokens are verified in jwks.ts; the contract verifies them again.

/** `iss` claim → issuer provider name in hana-signer (`set_issuer(provider, iss_values)`). */
export const ISSUER_PROVIDERS: Readonly<Record<string, string>> = {
  'https://accounts.google.com': 'google',
  'accounts.google.com': 'google',
};

export function providerForIssuer(iss: string): string | null {
  return Object.hasOwn(ISSUER_PROVIDERS, iss) ? (ISSUER_PROVIDERS[iss] ?? null) : null;
}
