// The console code-flow spike (docs/batch-c-spec.md open question 1, "to test"; batch C9; D295): does Google's
// authorization-code flow give the console client an ID token with no `email` (or any other claim outside the API's
// allow-list) for `scope=openid`? Step-ups and owner actions (batch C10) need exactly that: the API relays those tokens
// on chain and refuses any claim outside TOKEN_CLAIM_ALLOW_LIST (D271, D274, D277). The second leg checks sign-in's
// `openid email` token against what the console accepts (the allow-list plus email, email_verified, hd; D290). The
// allow-list holds `at_hash` since D342 (Google documents it on every server-flow ID token); a mismatched one fails.
//
// It runs the real flow with the console's own client and its only redirect URI (`<console.authOrigin>/callback`), so it
// tests exactly the production configuration and needs no extra redirect URI: the operator opens the printed URL, signs
// in, and Google sends the browser to the callback. Whether or not console-auth is deployed there, the code stays in the
// address bar unused (the console's callback answers a state it doesn't know with its static page and exchanges
// nothing); the operator pastes that address back, and this script exchanges the code with the client secret and its own
// PKCE verifier, verifies the ID token (RS256 against Google's JWKS, iss, aud, nonce, exp, iat) and reports.
//
// The report holds claim names and yes/no answers only, never a value: no token, no address, no `sub`, no code. The
// tokens are dropped when the report is made.
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { join } from 'node:path';
import type { Manifest } from '@hana-id/env';
import { readSecretJson, secretsDir } from './secrets.ts';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
/** The API's claim allow-list (@hana-id/core TOKEN_CLAIM_ALLOW_LIST; the test pins it to core's source). */
export const TOKEN_CLAIM_ALLOW_LIST: readonly string[] = ['iss', 'azp', 'aud', 'sub', 'iat', 'exp', 'nonce', 'nbf', 'jti', 'auth_time', 'at_hash'];
const SKEW_S = 60;

interface RsaJwk {
  kid: string;
  n: string;
  e: string;
}

/** Google's published RS256 keys. */
export async function fetchGoogleJwks(fetchFn: typeof fetch = fetch): Promise<RsaJwk[]> {
  const res = await fetchFn(GOOGLE_JWKS_URL, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Google's JWKS answered ${res.status}`);
  const body = (await res.json()) as { keys?: unknown };
  const keys = Array.isArray(body.keys) ? body.keys.filter((k): k is RsaJwk => typeof k?.kid === 'string' && typeof k?.n === 'string' && typeof k?.e === 'string' && k?.kty === 'RSA') : [];
  if (keys.length === 0) throw new Error("Google's JWKS has no RSA key");
  return keys;
}

/** The header and claims of a compact JWS, or null. */
function decode(jwt: string): { header: Record<string, unknown>; claims: Record<string, unknown>; input: string; sig: Buffer } | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as unknown;
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as unknown;
    if (typeof header !== 'object' || header === null || typeof claims !== 'object' || claims === null || Array.isArray(claims)) return null;
    return { header: header as Record<string, unknown>, claims: claims as Record<string, unknown>, input: `${parts[0]}.${parts[1]}`, sig: Buffer.from(parts[2]!, 'base64url') };
  } catch {
    return null;
  }
}

/** RS256 against `keys`, iss, aud, azp, nonce, exp and iat; null when it all holds, else a fixed reason. */
function checkToken(jwt: string, keys: readonly RsaJwk[], clientId: string, nonce: string, nowS: number): string | null {
  const d = decode(jwt);
  if (!d) return 'malformed token';
  if (d.header.alg !== 'RS256') return 'not RS256';
  const jwk = keys.find((k) => k.kid === d.header.kid);
  if (!jwk) return 'unknown signing key';
  const key = createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
  if (!verify('sha256', Buffer.from(d.input), key, d.sig)) return 'bad signature';
  const c = d.claims;
  if (typeof c.iss !== 'string' || !GOOGLE_ISSUERS.includes(c.iss)) return 'wrong issuer';
  if (c.aud !== clientId) return 'wrong audience';
  if (c.azp !== undefined && c.azp !== clientId) return 'wrong azp';
  if (c.nonce !== nonce) return 'wrong nonce';
  if (typeof c.exp !== 'number' || c.exp <= nowS - SKEW_S) return 'expired';
  if (typeof c.iat !== 'number' || c.iat > nowS + SKEW_S || c.iat < nowS - 600) return 'iat out of range';
  return null;
}
/** What the console's sign-in accepts beyond the allow-list (apps/console/src/auth-token.ts SIGN_IN_EXTRA_CLAIMS). */
export const SIGN_IN_EXTRA_CLAIMS: readonly string[] = ['email', 'email_verified', 'hd'];
/** Google's downloaded client JSON, saved as this file in `.secrets/<env>/` (0600). */
export const CONSOLE_CLIENT_FILE = 'console-google-client.json';

export type SpikeScope = 'openid' | 'openid email';

export interface ConsoleClient {
  clientId: string;
  clientSecret: string;
  authOrigin: string;
}

const b64url = (b: Buffer): string => b.toString('base64url');

/**
 * The console's Google client: its id is the manifest's one `google` console audience, its secret is in Google's client
 * JSON (`{"web": {"client_id", "client_secret", …}}`) at `.secrets/<env>/console-google-client.json`, whose id must be
 * the manifest's. Throws without printing any secret.
 */
export function loadConsoleClient(m: Manifest, root?: string): ConsoleClient {
  if (!m.console) throw new Error(`envs/${m.name}.json has no console block (setup step 12)`);
  const google = m.consoleAudiences.filter(([p]) => p === 'google').map(([, a]) => a);
  if (google.length !== 1) throw new Error(`envs/${m.name}.json: consoleAudiences needs exactly one google client (setup step 11); it has ${google.length}`);
  const file = join(secretsDir(m.name, root), CONSOLE_CLIENT_FILE);
  const json = readSecretJson<{ web?: { client_id?: unknown; client_secret?: unknown } }>(file);
  if (!json) throw new Error(`${file} is missing: save the console client's JSON from Google Cloud there (chmod 600)`);
  const id = json.web?.client_id;
  const secret = json.web?.client_secret;
  if (typeof id !== 'string' || typeof secret !== 'string' || secret.length === 0) throw new Error(`${file} is not a Google web client JSON ({"web": {"client_id", "client_secret"}})`);
  if (id !== google[0]) throw new Error(`${file} is for another client than the manifest's console audience`);
  return { clientId: id, clientSecret: secret, authOrigin: m.console.authOrigin };
}

export interface Leg {
  scope: SpikeScope;
  state: string;
  nonce: string;
  verifier: string;
  url: string;
}

/** A leg's authorization request: response_type=code, PKCE S256, the account chooser, fresh state and nonce. */
export function newLeg(client: ConsoleClient, scope: SpikeScope): Leg {
  const state = b64url(randomBytes(32));
  const nonce = b64url(randomBytes(32));
  const verifier = b64url(randomBytes(32));
  const u = new URL(GOOGLE_AUTH_URL);
  u.searchParams.set('client_id', client.clientId);
  u.searchParams.set('redirect_uri', `${client.authOrigin}/callback`);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', scope);
  u.searchParams.set('prompt', 'select_account');
  u.searchParams.set('state', state);
  u.searchParams.set('nonce', nonce);
  u.searchParams.set('code_challenge', b64url(createHash('sha256').update(verifier).digest()));
  u.searchParams.set('code_challenge_method', 'S256');
  return { scope, state, nonce, verifier, url: u.toString() };
}

/** The code from the pasted callback address, after checking it is this leg's callback. Errors never echo the input. */
export function codeFrom(pasted: string, leg: Leg, client: ConsoleClient): string {
  let u: URL;
  try {
    u = new URL(pasted.trim());
  } catch {
    throw new Error('That is not a URL: paste the whole address from the browser');
  }
  if (`${u.origin}${u.pathname}` !== `${client.authOrigin}/callback`) throw new Error(`That address is not ${client.authOrigin}/callback`);
  const error = u.searchParams.get('error');
  if (error !== null) throw new Error(`Google answered with an error (${/^[a-z_]{1,64}$/u.test(error) ? error : 'unreadable'}): nothing to exchange`);
  if (u.hash && /id_token|access_token/u.test(u.hash)) throw new Error('That is an implicit-flow answer (a token in the fragment), not a code: start the leg again');
  if (u.searchParams.get('state') !== leg.state) throw new Error("That address is another sign-in's (the state differs): use the URL this leg printed");
  const code = u.searchParams.get('code');
  if (!code) throw new Error('That address has no code');
  return code;
}

export interface Tokens {
  idToken: string;
  accessToken: string | undefined;
}

/** Exchanges the code at Google's token endpoint with the client secret and the leg's verifier. */
export async function exchange(code: string, leg: Leg, client: ConsoleClient, fetchFn: typeof fetch = fetch): Promise<Tokens> {
  const res = await fetchFn(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: client.clientId, client_secret: client.clientSecret, redirect_uri: `${client.authOrigin}/callback`, code_verifier: leg.verifier }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`Google's token endpoint answered ${res.status}${typeof json.error === 'string' && /^[a-z_]{1,64}$/u.test(json.error) ? ` (${json.error})` : ''}: a code works once and for a few minutes; start the leg again`);
  if (typeof json.id_token !== 'string') throw new Error("Google's answer has no ID token");
  return { idToken: json.id_token, accessToken: typeof json.access_token === 'string' ? json.access_token : undefined };
}

export interface LegReport {
  scope: SpikeScope;
  /** Signature (Google's JWKS), iss, aud (the console client), nonce, exp and iat all checked. */
  verified: boolean;
  /** Why not, when not (a fixed reason, never a value). */
  failure?: string;
  /** Every claim name the ID token carries, sorted. */
  claims: string[];
  /** Claims outside the API's TOKEN_CLAIM_ALLOW_LIST. */
  outsideApiAllowList: string[];
  hasEmailClaims: boolean;
  hasHd: boolean;
  hasAtHash: boolean;
  /** `at_hash` equals the hash of the access token issued with it (null without one of the two). */
  atHashMatches: boolean | null;
  /**
   * `openid` leg: the token passes the API's allow-list as is (step-ups and owner actions work with no change).
   * `openid email` leg: the token passes the console's sign-in rule (allow-list + email, email_verified, hd).
   */
  passes: boolean;
  verdict: string;
}

const EMAIL_CLAIMS = ['email', 'email_verified'];

/** Verifies the leg's ID token and reports on its claims, by name only. */
export async function reportLeg(tokens: Tokens, leg: Leg, client: ConsoleClient, o: { now?: number; jwks?: () => Promise<RsaJwk[]> } = {}): Promise<LegReport> {
  const keys = await (o.jwks ?? (() => fetchGoogleJwks()))();
  const failure = checkToken(tokens.idToken, keys, client.clientId, leg.nonce, Math.floor((o.now ?? Date.now()) / 1000));
  const verified = failure === null;
  const decoded = decode(tokens.idToken);
  const claims = decoded ? Object.keys(decoded.claims).sort() : [];
  const outside = claims.filter((c) => !TOKEN_CLAIM_ALLOW_LIST.includes(c));
  const hasAtHash = claims.includes('at_hash');
  let atHashMatches: boolean | null = null;
  if (hasAtHash && tokens.accessToken) {
    atHashMatches = decoded!.claims.at_hash === b64url(createHash('sha256').update(tokens.accessToken).digest().subarray(0, 16));
  }
  const hasEmailClaims = claims.some((c) => EMAIL_CLAIMS.includes(c));
  const hasHd = claims.includes('hd');
  let passes: boolean;
  let verdict: string;
  if (!verified) {
    passes = false;
    verdict = 'NOT VERIFIED: the token failed the signature or claim checks; nothing can be concluded from this leg';
  } else if (leg.scope === 'openid') {
    passes = outside.length === 0 && atHashMatches !== false;
    if (passes) verdict = `PASS: openid-only, exactly within the API allow-list${hasAtHash ? ' (at_hash included, D342)' : ''}; step-ups and owner actions need no change`;
    else if (outside.length === 0) verdict = 'FAIL: at_hash does not match the access token';
    else if (hasEmailClaims || hasHd) verdict = 'FAIL: Google added email or hd for scope=openid; step-ups and owner actions stop until decided (spec open question 1 fallback)';
    else verdict = `FAIL: claims outside the allow-list (${outside.join(', ')})`;
  } else {
    const signInAllowed = [...TOKEN_CLAIM_ALLOW_LIST, ...SIGN_IN_EXTRA_CLAIMS];
    const extra = claims.filter((c) => !signInAllowed.includes(c));
    const emailVerified = decoded?.claims.email_verified === true || decoded?.claims.email_verified === 'true';
    passes = extra.length === 0 && claims.includes('email') && emailVerified && atHashMatches !== false;
    verdict = passes ? 'PASS: the console accepts this sign-in token' : `FAIL: ${extra.length ? `claims the console refuses (${extra.join(', ')})` : !claims.includes('email') || !emailVerified ? 'no verified email' : 'at_hash does not match the access token'}`;
  }
  return {
    scope: leg.scope,
    verified,
    ...(failure !== null ? { failure } : {}),
    claims,
    outsideApiAllowList: outside,
    hasEmailClaims,
    hasHd,
    hasAtHash,
    atHashMatches,
    passes,
    verdict,
  };
}
