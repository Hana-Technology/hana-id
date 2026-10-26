// Google JWKS → hana-signer issuer keys. Same diff the API cron does: add kids Google publishes that the contract
// lacks, remove kids the contract has that Google no longer publishes.
import { GOOGLE_JWKS_URL } from './contract.ts';

export interface Jwk {
  kid: string;
  kty: string;
  alg?: string;
  use?: string;
  n: string;
  e: string;
}

export interface JwksDiff {
  set: { kid: string; n: string; e: string }[];
  remove: string[];
}

const B64URL = /^[A-Za-z0-9_-]+$/u;

/** RS256 signing keys only, validated (kid without '#', base64url n/e). */
export function usableKeys(jwks: { keys?: unknown }): Jwk[] {
  if (!Array.isArray(jwks.keys)) throw new Error('JWKS has no keys array');
  return (jwks.keys as Partial<Jwk>[]).filter(
    (k): k is Jwk =>
      k.kty === 'RSA' &&
      (k.alg === undefined || k.alg === 'RS256') &&
      (k.use === undefined || k.use === 'sig') &&
      typeof k.kid === 'string' &&
      k.kid.length > 0 &&
      k.kid.length <= 128 &&
      !k.kid.includes('#') &&
      typeof k.n === 'string' &&
      B64URL.test(k.n) &&
      typeof k.e === 'string' &&
      B64URL.test(k.e),
  );
}

export function diffJwks(chainKids: readonly string[], jwks: { keys?: unknown }): JwksDiff {
  const keys = usableKeys(jwks);
  // Refuse to wipe the contract's keys if Google returns nothing usable (outage, format change).
  if (keys.length === 0) throw new Error('Google JWKS has no usable RS256 keys; refusing to sync');
  const published = new Set(keys.map((k) => k.kid));
  const onChain = new Set(chainKids);
  return {
    set: keys.filter((k) => !onChain.has(k.kid)).map(({ kid, n, e }) => ({ kid, n, e })),
    remove: chainKids.filter((kid) => !published.has(kid)),
  };
}

export async function fetchGoogleJwks(url: string = GOOGLE_JWKS_URL): Promise<{ keys?: unknown }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return (await res.json()) as { keys?: unknown };
}
