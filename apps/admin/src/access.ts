// The staff check on every `/api/*` request (docs/batch-c-spec.md "Hana admin console", D88): the Cloudflare Access
// application token in `Cf-Access-Jwt-Assertion`, verified here with @hana-id/oidc's AccessJwtVerifier (RS256 against
// the team's certs, a `kid` in the set, `iss = https://<team domain>`, `aud = ACCESS_AUD`, unexpired, `type = 'app'`, a
// non-empty `sub`, so no service token, and an email), and then the lowercased email on the manifest's staff list: a
// second check behind the Access policy, so offboarding removes a person from both. Everything fails closed: no
// token or a bad one is 401, a good token of someone not on the list 403, a missing config or unreachable certs 503.
// `ctx.access` and the `CF_Authorization` cookie are never read: the header is the only input.
import { ACCESS_JWT_HEADER, AccessJwtVerifier, JwksUnavailableError } from '@hana-id/oidc';
import type { Env } from './env.ts';
import type { AdminErrorCode } from './http.ts';
import { errorName, log } from './log.ts';

/** The staff actor every RPC call carries (into `app_changes` and `audit_log`). */
export interface StaffActor {
  kind: 'hana';
  /** The Access `sub` (a per-identity UUID). */
  id: string;
  /** Lowercased. Personal data: never logged. */
  email: string;
}

/**
 * `exp`: the Access token's expiry (seconds since the epoch), when this sign-in ends. Only this number leaves the
 * Worker (`GET /api/me` `accessExp`, for the SPA's "your sign-in ends in N min"); the token itself never does.
 */
export type StaffCheck = { ok: true; actor: StaffActor; exp: number } | { ok: false; code: Extract<AdminErrorCode, 'unauthenticated' | 'not_staff' | 'access_unavailable'>; reason: string };

const AUD_RE = /^[0-9a-f]{64}$/u;

/** The staff list from `STAFF_EMAILS` (a JSON array of lowercased emails), or null when unusable (fail closed). */
export function staffEmails(raw: string | undefined): ReadonlySet<string> | null {
  if (!raw) return null;
  try {
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list) || list.length === 0) return null;
    if (!list.every((e) => typeof e === 'string' && e.length > 0 && e === e.toLowerCase() && e.includes('@'))) return null;
    return new Set(list as string[]);
  } catch {
    return null;
  }
}

/** One verifier per isolate (its certs cache lives in it), rebuilt only if the config changes. */
let cached: { key: string; verifier: AccessJwtVerifier } | null = null;

function verifierFor(env: Env): AccessJwtVerifier | null {
  if (!AUD_RE.test(env.ACCESS_AUD ?? '')) return null;
  const key = `${env.ACCESS_TEAM_DOMAIN}\n${env.ACCESS_AUD}`;
  if (cached?.key === key) return cached.verifier;
  try {
    // `fetch` is looked up at each call, so the certs request goes through whatever the isolate's fetch is.
    const verifier = new AccessJwtVerifier({ teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD, fetch: (url, init) => fetch(url, init) });
    cached = { key, verifier };
    return verifier;
  } catch {
    return null;
  }
}

/** Test hook: forget the isolate's verifier (and with it the certs cache). */
export function resetAccessVerifier(): void {
  cached = null;
}

export async function checkStaff(request: Request, env: Env, requestId: string, now = Date.now()): Promise<StaffCheck> {
  const staff = staffEmails(env.STAFF_EMAILS);
  const verifier = verifierFor(env);
  if (!staff || !verifier) {
    log({ event: 'access_refused', requestId, code: 'access_config_missing' }, 'error');
    return { ok: false, code: 'access_unavailable', reason: 'config' };
  }
  let result: Awaited<ReturnType<AccessJwtVerifier['verify']>>;
  try {
    result = await verifier.verify(request.headers.get(ACCESS_JWT_HEADER), now);
  } catch (err) {
    log({ event: 'access_refused', requestId, code: err instanceof JwksUnavailableError ? 'certs_unavailable' : 'verify_error', error: errorName(err) }, 'error');
    return { ok: false, code: 'access_unavailable', reason: 'certs' };
  }
  if (!result.ok) {
    log({ event: 'access_refused', requestId, code: result.code }, 'warn');
    return { ok: false, code: 'unauthenticated', reason: result.code };
  }
  const email = result.identity.email.trim().toLowerCase();
  if (!staff.has(email)) {
    log({ event: 'access_refused', requestId, code: 'not_staff' }, 'warn');
    return { ok: false, code: 'not_staff', reason: 'not_staff' };
  }
  return { ok: true, actor: { kind: 'hana', id: result.identity.sub, email }, exp: result.identity.exp };
}
