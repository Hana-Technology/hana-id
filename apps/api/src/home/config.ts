// GET /v1/home/config (docs/hana-home-spec.md "API changes"): what the /home page needs before a sign-in: the server
// clock, the signer account the nonce commits to, the Google clients to sign in with (the shared client, and the exit
// client Home falls back to where the normal route is gone, D490), and whether email sign-in is open (H10). `AUTH_ORIGIN` only; no
// identity (it can't have one yet), no secret in the answer. The D1 and chain state of apps is H2's.
import { HOME_EMAIL_AUDIENCE } from '@hana-id/core/home';
import { GOOGLE_PROVIDER } from '@hana-id/jwks';
import { EMAIL_PROVIDER } from '../email-token.ts';
import type { Env } from '../env.ts';
import { done, ipKey, limiter, newCtx, reject } from '../handlers.ts';
import { effectiveExitClients, effectiveSharedClients, getConfig, isExitClient } from '../views.ts';
import { homeCors, isHomeOrigin } from './identity.ts';

export const HOME_CONFIG_ENDPOINT = '/v1/home/config';
/** Per IP (docs/hana-home-spec.md "Rate limits"). */
export const HOME_CONFIG_PER_IP_MINUTE = 60;
const MINUTE = 60_000;

/** The env's issuer URL is absent (the issuer on the API's own origin) or an http(s) URL: a malformed one leaves Home's email sign-in off, as `/home`'s policy leaves the issuer out. */
const issuerUrlUsable = (url: string | undefined): boolean => {
  if (url === undefined || url === '') return true;
  try {
    return ['https:', 'http:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
};

export async function handleHomeConfig(request: Request, env: Env, requestId: string, now: number = Date.now()): Promise<Response> {
  const ctx = newCtx(env, requestId, HOME_CONFIG_ENDPOINT, request);
  if (!isHomeOrigin(request, env)) return reject(ctx, 403, 'origin_not_allowed', 'Origin not allowed');
  ctx.cors = homeCors(request.headers.get('origin') as string);
  try {
    const hit = await limiter(env, ipKey(request)).hit([{ name: 'home:config:ip', windowMs: MINUTE, max: HOME_CONFIG_PER_IP_MINUTE }], now);
    if (!hit.ok) return reject(ctx, 429, 'rate_limited', 'Rate limit exceeded (per IP per minute)', { 'retry-after': String(hit.retryAfterS) });
  } catch {
    return reject(ctx, 503, 'rate_limiter_unavailable', 'Try again');
  }
  let shared: [string, string] | undefined;
  let exit: [string, string] | undefined;
  let email = false;
  try {
    const config = await getConfig(env);
    shared = effectiveSharedClients(config, now).find(([provider]) => provider === GOOGLE_PROVIDER);
    // An old contract has no exit clients: null, and Home has no exit route (fail closed).
    exit = effectiveExitClients(config, now).find(([provider]) => provider === GOOGLE_PROVIDER);
    // Email sign-in (H10): only in an env with an email issuer, and while the email exit is in force, as homeGate requires.
    email = !!env.EMAIL_ISS && issuerUrlUsable(env.EMAIL_ISSUER_URL) && isExitClient(config, EMAIL_PROVIDER, HOME_EMAIL_AUDIENCE, now);
  } catch {
    return reject(ctx, 502, 'near_unavailable', 'Could not read the shared clients');
  }
  // The first shared and exit Google clients in force, as GET /v1/app's shared route picks one; null when none. The page
  // signs in with Google through the shared client, else the exit client (D490), and offers email when `emailSignIn`.
  return done(ctx, 200, { serverTimeMs: now, signer: env.SIGNER_ACCOUNT, sharedGoogleClientId: shared ? shared[1] : null, exitGoogleClientId: exit ? exit[1] : null, emailSignIn: email });
}
