// The local stack's stand-in for Cloudflare Access (D866, D873): one team domain answered only inside the stack's
// process (`e2e-access.invalid`: `.invalid` never resolves, RFC 6761), one application AUD tag, and one RS256 signing
// key made at each stack start (never written anywhere). The email issuer's staff routes (issuer.ts) and the staff
// admin portal (admin-lane.ts) verify these tokens with their OWN code, exactly as against the real Access: the JWT in
// `Cf-Access-Jwt-Assertion` against the certs at `https://<team>/cdn-cgi/access/certs`, which `installAccessCerts`
// answers in this thread's `fetch`. Nothing here is product code: it exists only under apps/e2e, and a deployed Worker
// has neither the key nor a way to reach this team domain.
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';

export const ACCESS_TEAM = 'e2e-access.invalid';
/** The application's AUD tag: 64 hex characters, as Access's are. */
export const ACCESS_AUD = 'e2e'.padEnd(64, '0');
export const ACCESS_KID = 'e2e-access-1';
export const ACCESS_CERTS_URL = `https://${ACCESS_TEAM}/cdn-cgi/access/certs`;

/** The one person on the stack's staff lists (the issuer's ACCESS_STAFF_EMAILS, the admin's STAFF_EMAILS). */
export const E2E_STAFF = 'staff@e2e.invalid';
/** A person Access lets in who is on no staff list: the negative tests' identity. */
export const E2E_OUTSIDER = 'outsider@e2e.invalid';
/** Their Access `sub`s (per-identity UUIDs on the real Access). */
export const ACCESS_SUBS: Readonly<Record<string, string>> = Object.freeze({
  [E2E_STAFF]: '00000000-0000-4000-8000-00000000e2e1',
  [E2E_OUTSIDER]: '00000000-0000-4000-8000-00000000e2e2',
});

export interface AccessKeys {
  /** PKCS#8 PEM of the team's signing key. */
  privatePem: string;
  /** The team's certs document (`{keys: [jwk]}`), as `/cdn-cgi/access/certs` serves it. */
  certs: string;
}

/** A new team key for this stack. */
export function newAccessKeys(): AccessKeys {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 });
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, string>;
  return {
    privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
    certs: JSON.stringify({ keys: [{ kty: 'RSA', n: jwk.n, e: jwk.e, kid: ACCESS_KID, alg: 'RS256', use: 'sig' }] }),
  };
}

const b64url = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

/**
 * An Access application token for `email`, as Access puts it in `Cf-Access-Jwt-Assertion` after a sign-in: RS256 by
 * the team key, `iss` the team, `aud` [the AUD tag], `type: 'app'`, the identity's `sub` and `email`, issued at `nowMs`
 * and valid for `ttlS` (Access's default session is 24 hours).
 */
export function signAccessJwt(keys: Pick<AccessKeys, 'privatePem'>, o: { email: string; nowMs?: number; ttlS?: number; aud?: string; expFromMs?: number }): string {
  const now = Math.floor((o.nowMs ?? Date.now()) / 1000);
  // `expFromMs`: the expiry counts from this time instead (an admin lane whose clock runs ahead: still valid there).
  const expFrom = o.expFromMs !== undefined ? Math.max(now, Math.floor(o.expFromMs / 1000)) : now;
  const head = b64url(JSON.stringify({ alg: 'RS256', kid: ACCESS_KID, typ: 'JWT' }));
  const sub = ACCESS_SUBS[o.email] ?? `00000000-0000-4000-8000-${Buffer.from(o.email).toString('hex').slice(0, 12).padEnd(12, '0')}`;
  const body = b64url(JSON.stringify({ iss: `https://${ACCESS_TEAM}`, aud: [o.aud ?? ACCESS_AUD], sub, email: o.email, type: 'app', identity_nonce: 'e2e', iat: now, nbf: now, exp: expFrom + (o.ttlS ?? 24 * 3600) }));
  return `${head}.${body}.${b64url(sign('sha256', Buffer.from(`${head}.${body}`), createPrivateKey(keys.privatePem)))}`;
}

let installed: string | null = null;

/** Answers the team's certs URL in this thread's `fetch` (the Workers' Access checks fetch it); everything else as before. */
export function installAccessCerts(certs: string): void {
  if (installed !== null) {
    if (installed !== certs) throw new Error('installAccessCerts: this thread already serves other Access certs');
    return;
  }
  installed = certs;
  const real = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === ACCESS_CERTS_URL) return new Response(certs, { headers: { 'content-type': 'application/json', 'cache-control': 'max-age=300' } });
    return real(input, init);
  }) as typeof fetch;
}
