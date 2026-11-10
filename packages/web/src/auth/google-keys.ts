// Google's signing keys for the pages that check an ID token themselves (the export window, Hana Home): read from
// Google's JWKS, the only other origin in those pages' connect-src besides the API and the NEAR RPC.
import { type Jwk, fetchGoogleJwks } from '@hana-id/core';

/** Google's keys with one refetch on an unknown kid (key rotation). */
export function googleKeys(): (kid: string) => Promise<Jwk | null> {
  let keys: Jwk[] | null = null;
  return async (kid) => {
    keys ??= await fetchGoogleJwks();
    let k = keys.find((j) => j.kid === kid);
    if (!k) {
      keys = await fetchGoogleJwks();
      k = keys.find((j) => j.kid === kid);
    }
    return k ?? null;
  };
}
