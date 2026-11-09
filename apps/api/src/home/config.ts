// GET /v1/home/config (docs/hana-home-spec.md "API changes"): what the /home page needs before a sign-in: the server
// clock, the signer account the nonce commits to, and the Google clients to sign in with (the shared client, and the exit
// client Home falls back to where a scope's normal route is gone, D490). `AUTH_ORIGIN` only; no
// identity (it can't have one yet), no secret in the answer. The D1 and chain state of apps is H2's.
import { GOOGLE_PROVIDER } from '@hana-id/jwks';
import type { Env } from '../env.ts';
import { done, ipKey, limiter, newCtx, reject } from '../handlers.ts';
import { effectiveExitClients, effectiveSharedClients, getConfig } from '../views.ts';
import { homeCors, isHomeOrigin } from './identity.ts';

export const HOME_CONFIG_ENDPOINT = '/v1/home/config';
/** Per IP (docs/hana-home-spec.md "Rate limits"). */
export const HOME_CONFIG_PER_IP_MINUTE = 60;
const MINUTE = 60_000;

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
  try {
    const config = await getConfig(env);
    shared = effectiveSharedClients(config, now).find(([provider]) => provider === GOOGLE_PROVIDER);
    // An old contract has no exit clients: null, and Home has no exit route (fail closed).
    exit = effectiveExitClients(config, now).find(([provider]) => provider === GOOGLE_PROVIDER);
  } catch {
    return reject(ctx, 502, 'near_unavailable', 'Could not read the shared clients');
  }
  // The first shared and exit Google clients in force, as GET /v1/app's shared route picks one; null when none (an email user still signs in, H10).
  return done(ctx, 200, { serverTimeMs: now, signer: env.SIGNER_ACCOUNT, sharedGoogleClientId: shared ? shared[1] : null, exitGoogleClientId: exit ? exit[1] : null });
}
