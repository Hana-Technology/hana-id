// Reads (does NOT verify) an ID token's payload so the API can reject tokens for other apps before relaying.
// The contract verifies the signature, issuer, audience, expiry and nonce.
import { base64UrlDecode } from './bytes.ts';

/** `iss` claim → issuer provider name in hana-signer (`set_issuer(provider, iss_values)`). */
export const ISSUER_PROVIDERS: Readonly<Record<string, string>> = {
  'https://accounts.google.com': 'google',
  'accounts.google.com': 'google',
};

export interface UnverifiedClaims {
  iss: string;
  aud: string;
  exp: number | null;
}

export function decodeUnverifiedClaims(jwt: string): UnverifiedClaims | null {
  const parts = jwt.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])));
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;
  const { iss, aud, exp } = payload as Record<string, unknown>;
  // Google ID tokens carry a single string `aud`; the contract only accepts that form.
  if (typeof iss !== 'string' || typeof aud !== 'string') return null;
  return { iss, aud, exp: typeof exp === 'number' ? exp : null };
}

export function providerForIssuer(iss: string): string | null {
  return Object.hasOwn(ISSUER_PROVIDERS, iss) ? (ISSUER_PROVIDERS[iss] ?? null) : null;
}
