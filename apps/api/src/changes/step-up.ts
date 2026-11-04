// The API's own check of a member's step-up token for a guarded change (docs/batch-c-spec.md "Guarded changes" → "API
// verification", for ConsoleRpc.changeOrigins and proposeChange). The console's callback checked the token too, but a
// compromised console must not be able to propose a change no owner approved, so the API verifies it itself, in the
// spec's order, failing closed:
//   1. RS256 signature (@hana-id/oidc, optional claims strict, D201), issuer, expiry;
//   2. (provider, aud) is one of the on-chain `console_audiences` in force (get_config, read fresh);
//   3. `iat` at most 300 s old (and not in the future beyond the clock skew);
//   4. `nonce` equals the origin-change or settings-change layout recomputed from the request and the stored version
//      (the caller checks the version against `expectedVersion` first: `version_conflict`);
//   5. `sub` is an `Owner::Oidc` of the app's scope, read with an uncached get_scope (`near_unavailable` if NEAR RPC
//      is down);
//   6. sha256(jwt) is reserved in the `owner-actions:tokens` limiter until `exp` (`token_used`).
// Besides the spec (D235): the token's `sub` must be the member actor's (the console's callback already requires it),
// and a token with a claim outside the claim allow-list (claims.ts: `email`, `email_verified`, `hd`, a name, …) is
// refused, the rule every other Google token the API verifies is held to (D271, D274; the step-up asks for
// `scope=openid`, so a well-formed one has none). The token is never logged, returned or stored; only the verified
// `sub` is (`proposer_sub`, `actor_sub`).
import { type Actor } from '@hana-id/console-core';
import { JwksUnavailableError, verifyIdToken } from '@hana-id/oidc';
import type { Env } from '../env.ts';
import { log, logStaleJwks } from '../log.ts';
import { disallowedClaim } from '../claims.ts';
import { sha256Hex } from '../owner-actions.ts';
import { placedStub } from '../placement.ts';
import { getConfig } from '../views.ts';
import { refuse } from './cas.ts';
import { oidcOwners, scopeOnChain } from './chain.ts';

/** Step 3: the oldest `iat` accepted. */
export const STEP_UP_MAX_AGE_MS = 300_000;
/** An `iat` this far ahead of the API's clock is still accepted (Google's and Cloudflare's clocks differ slightly). */
export const STEP_UP_IAT_SKEW_MS = 60_000;
/** The limiter object owner tokens are reserved in (shared with /v1/owner-actions: one token, one use, anywhere). */
export const TOKEN_LIMITER = 'owner-actions:tokens';

export interface StepUpToken {
  provider: string;
  sub: string;
  nonce: string | null;
  /** sha256 of the JWT (hex): the reservation key. */
  hash: string;
  expMs: number;
}

/** Steps 1–3 (and the actor and personal-data rules). Throws an RpcRefusal; never returns an unverified token. */
export async function verifyStepUpToken(env: Env, jwt: string, actor: Actor, now: number): Promise<StepUpToken> {
  if (actor.kind !== 'member') return refuse('forbidden', 'Only a member proposes with a step-up');
  let v;
  try {
    v = await verifyIdToken(jwt, now, { onStaleKeys: logStaleJwks, identityIssuer: env.IDENTITY_ISS, optionalClaims: 'strict' });
  } catch (err) {
    if (err instanceof JwksUnavailableError) return refuse('near_unavailable', "Google's signing keys could not be read: try again");
    throw err;
  }
  if (!v.ok) return refuse('forbidden', `The step-up token is not valid (${v.code})`);
  const t = v.token;
  let config;
  try {
    config = await getConfig(env, { fresh: true });
  } catch {
    return refuse('near_unavailable', 'NEAR RPC is unavailable: try again');
  }
  if (!config.console_audiences.some(([p, a]) => p === t.provider && a === t.aud)) return refuse('forbidden', 'The step-up token is not for a Hana console audience');
  if (t.iat === undefined) return refuse('forbidden', 'The step-up token has no iat');
  const iatMs = t.iat * 1000;
  if (iatMs < now - STEP_UP_MAX_AGE_MS) return refuse('forbidden', 'The step-up token is older than 300 s: sign in again');
  if (iatMs > now + STEP_UP_IAT_SKEW_MS) return refuse('forbidden', 'The step-up token is issued in the future');
  if (t.sub !== actor.sub) return refuse('forbidden', "The step-up token is not the signed-in member's");
  const claim = disallowedClaim(jwt);
  if (claim !== null) return refuse('forbidden', `The step-up token carries a claim outside the allow-list (${claim}): sign in with scope=openid`);
  return { provider: t.provider, sub: t.sub, nonce: t.nonce, hash: await sha256Hex(jwt), expMs: t.exp * 1000 };
}

const tokens = (env: Env) => placedStub(env, env.RATE_LIMITER, TOKEN_LIMITER);

/**
 * Steps 4–6, once the plan read has checked the version and built the change: the nonce, the on-chain owner, then the
 * single-use reservation (last, so a refusal never uses the token up).
 */
export async function confirmStepUp(env: Env, t: StepUpToken, c: { expectedNonce: string; scopeId: string }): Promise<void> {
  if (t.nonce !== c.expectedNonce) refuse('forbidden', 'The step-up token is for another change or an older version of the app: sign in again');
  const scope = await scopeOnChain(env, c.scopeId);
  if (!scope || !oidcOwners(scope).some(([p, s]) => p === t.provider && s === t.sub)) refuse('not_owner', `The step-up token is not from an on-chain owner of scope ${c.scopeId}`);
  if (!(await tokens(env).reserve(t.hash, t.expMs))) refuse('token_used', 'This step-up token was already used: sign in again');
}

/** Gives a reserved token back after a write that certainly changed nothing (a refused or failed batch). Never throws. */
export async function releaseStepUp(env: Env, t: StepUpToken): Promise<void> {
  try {
    await tokens(env).release(t.hash);
  } catch {
    log({ event: 'owner_token_release_failed', endpoint: 'step_up' }, 'warn');
  }
}
