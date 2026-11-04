// The token of a session request (/v1/sessions, /v1/login) and of a link relay: a Google ID token (compact JWT,
// @hana-id/oidc) or an email token (JWS JSON, email-token.ts), by its form, as the contract dispatches it
// (`verify_token`: `is_json_form`). Either answers the same shape; the caller then checks the nonce and the scope.
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

export interface LoginTokenOptions {
  /** Refuse a Google token with a claim outside the allow-list (claims.ts). Email tokens are always held to theirs. */
  claimAllowList: boolean;
  /** The app the request is for: an email token needs `email` in its login methods (unless `anyLoginMethod`). */
  appId: string;
  /**
   * Accept an email token whatever the app's `login_methods` say (review L6): `/v1/link/cancel` and `/unlink` only
   * remove a sign-in method, which must stay possible after a partner turns email off.
   */
  anyLoginMethod?: boolean;
  exec?: ExecutionContext | undefined;
}

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
      methods = opts.anyLoginMethod ? ['email'] : await appLoginMethods(env.DB, opts.appId);
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
  const claim = opts.claimAllowList ? disallowedClaim(jwt) : null;
  if (claim) return { ok: false, status: 400, code: 'token_has_pii', error: 'The ID token carries a claim outside the allow-list', data: { claim } };
  const t = verified.token;
  return { ok: true, token: { provider: t.provider, aud: t.aud, sub: t.sub, nonce: t.nonce, kid: t.kid, email: false } };
}
