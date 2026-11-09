// The token of a session request (/v1/sessions, /v1/login) and of a link relay: a Google ID token (compact JWT,
// @hana-id/oidc) or an email token (JWS JSON, email-token.ts), by its form, as the contract dispatches it
// (`verify_token`: `is_json_form`). Either answers the same shape; the caller then checks the nonce and the scope.
// A Google token is always held to the claim allow-list (claims.ts, `token_has_pii`), with no option to skip it: every
// caller relays the token to the chain, where it is public (D25, D271).
import { JwksUnavailableError, verifyIdToken } from '@hana-id/oidc';
import { disallowedClaim } from './claims.ts';
import { EMAIL_PROVIDER, isJsonForm, verifyEmailToken } from './email-token.ts';
import type { Env } from './env.ts';
import { TOKEN_EXP_SKEW_MS } from './handlers.ts';
import { keyObserver } from './key-observations.ts';
import { appLoginMethods } from './login-methods.ts';
import { logStaleJwks } from './log.ts';

export interface LoginToken {
  provider: string;
  aud: string;
  sub: string;
  nonce: string | null;
  /** A Google token's kid, which chainGate checks is active on chain; null for an email token (its policy is checked here). */
  kid: string | null;
  email: boolean;
}

export type LoginTokenResult = { ok: true; token: LoginToken } | { ok: false; status: number; code: string; error: string; data?: Record<string, unknown>; retryAfterS?: number };

/** Retry-After of an email token whose key isn't active on chain yet (as handlers.ts ISSUER_KEY_PENDING_RETRY_S). */
const EMAIL_KEY_PENDING_RETRY_S = 30;

/**
 * Either for one app (`appId`: an email token needs `email` in its login methods), or `anyLoginMethod`: an email token is
 * accepted whatever any app's `login_methods` say. `/v1/link/cancel` and `/unlink` only remove a sign-in method, which
 * must stay possible after a partner turns email off (review L6), and Hana Home has no app at all (a Home identity
 * outlives a suspended or deleted app, D463), so there `appId` is simply not given. It is required otherwise, so the
 * app-less case can't be reached by forgetting it.
 */
export type LoginTokenOptions = ({ appId: string; anyLoginMethod?: boolean } | { appId?: undefined; anyLoginMethod: true }) & { exec?: ExecutionContext | undefined };

/**
 * Verifies `jwt` (see the top of this file). Every refusal is an answer (a chain read that fails is 502
 * near_unavailable, a D1 read 503 config_unavailable); it throws only on an unexpected error. An email token is refused (`login_method_disabled`) for an app whose
 * `login_methods` doesn't list `email`: until a partner turns email on, no email token reaches the chain through it.
 */
export async function verifyLoginToken(env: Env, jwt: string, now: number, opts: LoginTokenOptions): Promise<LoginTokenResult> {
  if (isJsonForm(jwt)) {
    let v;
    try {
      v = await verifyEmailToken(env, jwt, now, TOKEN_EXP_SKEW_MS);
    } catch {
      // The signer policy view (a contract before v3 has none: `MethodNotFound`) or the RPC failed.
      return { ok: false, status: 502, code: 'near_unavailable', error: 'Could not read the email signer policy' };
    }
    if (!v.ok) {
      if (v.code === 'issuer_key_pending') return { ok: false, status: 503, code: v.code, error: v.error, retryAfterS: EMAIL_KEY_PENDING_RETRY_S };
      return { ok: false, status: v.code === 'invalid_token' || v.code === 'token_stale' ? 401 : 400, code: v.code, error: v.error };
    }
    let methods;
    try {
      methods = opts.anyLoginMethod ? ['email'] : await appLoginMethods(env.DB, opts.appId as string);
    } catch {
      return { ok: false, status: 503, code: 'config_unavailable', error: 'App config is unavailable, try again' };
    }
    if (!methods.includes('email')) return { ok: false, status: 403, code: 'login_method_disabled', error: 'Email sign-in is not turned on for this app' };
    const t = v.token;
    return { ok: true, token: { provider: EMAIL_PROVIDER, aud: t.aud, sub: t.sub, nonce: t.nonce, kid: null, email: true } };
  }
  let verified;
  try {
    verified = await verifyIdToken(jwt, now, { skewMs: TOKEN_EXP_SKEW_MS, observer: keyObserver(env, opts.exec), onStaleKeys: logStaleJwks, identityIssuer: env.IDENTITY_ISS });
  } catch (err) {
    if (err instanceof JwksUnavailableError) return { ok: false, status: 503, code: 'issuer_keys_unavailable', error: 'Could not read the token issuer keys, try again' };
    throw err;
  }
  if (!verified.ok) return { ok: false, status: verified.code === 'invalid_token' ? 401 : 400, code: verified.code, error: verified.error };
  // Only Google is a compact-JWT provider today; the email provider can never arrive in that form.
  if (verified.token.provider === EMAIL_PROVIDER) return { ok: false, status: 400, code: 'unsupported_issuer', error: 'Unsupported token issuer' };
  // The claim allow-list, unconditionally (D271): no email, name or Workspace domain is ever relayed. An email token is
  // held to its own claim set by verifyEmailToken.
  const claim = disallowedClaim(jwt);
  if (claim !== null) return { ok: false, status: 400, code: 'token_has_pii', error: 'The ID token carries a claim outside the allow-list', data: { claim } };
  const t = verified.token;
  return { ok: true, token: { provider: t.provider, aud: t.aud, sub: t.sub, nonce: t.nonce, kid: t.kid, email: false } };
}
