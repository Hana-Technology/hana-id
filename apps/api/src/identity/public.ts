// The identity token's public endpoints (docs/identity-token-spec.md "JWKS and discovery"): the JWKS partners verify
// against and an OpenID-style discovery document. Both come from the manifest's key list (IDENTITY_PUBLIC_KEYS), never
// from D1 or a secret, so they hold public members only. `max-age=600` matches `jose`'s createRemoteJWKSet default
// cache (10 minutes; it refetches on an unknown kid at most every 30 s). CORS `*`, no cookies.
import type { Env } from '../env.ts';
import { corsHeaders, json } from '../http.ts';
import { log } from '../log.ts';
import { publicIdentityConfig } from './signer.ts';

export const IDENTITY_JWKS_ENDPOINT = '/v1/identity/jwks.json';
export const IDENTITY_DISCOVERY_ENDPOINT = '/v1/identity/.well-known/openid-configuration';
export const IDENTITY_PUBLIC_ENDPOINTS: readonly string[] = [IDENTITY_JWKS_ENDPOINT, IDENTITY_DISCOVERY_ENDPOINT];
export const JWKS_MAX_AGE_S = 600;

/** The claims a token may carry (the email pair only for apps and users that opted in, build steps 5–6). */
export const IDENTITY_CLAIMS_SUPPORTED = ['iss', 'aud', 'sub', 'sid', 'iat', 'exp', 'jti', 'wallets', 'login_methods', 'email', 'email_verified'] as const;

const publicHeaders = (requestId: string): Record<string, string> => ({
  ...corsHeaders('*', 'content-type', 'GET, HEAD, OPTIONS'),
  'cache-control': `public, max-age=${JWKS_MAX_AGE_S}`,
  'x-request-id': requestId,
});

/** GET (and HEAD) of the JWKS or the discovery document. 503 identity_unavailable in an env without the configuration. */
export function handleIdentityPublic(request: Request, env: Env, pathname: string, requestId: string): Response {
  const config = publicIdentityConfig(env);
  if (typeof config === 'string') {
    log({ event: 'identity_unavailable', requestId, endpoint: pathname, code: config }, config === 'no_identity_config' ? 'warn' : 'error');
    return json(503, { error: 'Identity tokens are unavailable in this environment', code: 'identity_unavailable', requestId }, { ...corsHeaders('*', 'content-type', 'GET, HEAD, OPTIONS'), 'x-request-id': requestId });
  }
  const body =
    pathname === IDENTITY_JWKS_ENDPOINT
      ? { keys: config.keys }
      : {
          issuer: config.iss,
          jwks_uri: `${config.iss}/jwks.json`,
          id_token_signing_alg_values_supported: ['ES256'],
          subject_types_supported: ['pairwise'],
          claims_supported: IDENTITY_CLAIMS_SUPPORTED,
        };
  const res = json(200, body, publicHeaders(requestId));
  return request.method === 'HEAD' ? new Response(null, { status: 200, headers: res.headers }) : res;
}
