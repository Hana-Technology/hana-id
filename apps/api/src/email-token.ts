// Email tokens (docs/email-login-spec.md "The token", "API changes"): Hana's email issuer signs them in the JWS General
// JSON Serialization, one payload with 1–3 signatures (two-signer-ready, D121). The API prechecks them before it relays
// one, as the contract will check them (contracts/hana-signer/src/oidc.rs `parse_json`, self_issued.rs
// `verify_self_issued_signatures`): the env's email `iss`, every signature RS256-valid with a published key, distinct
// kids, each an active key of a signer the on-chain policy lists (`get_self_issued("email")`), at least `required`
// distinct signers; then the claim checks. The keys are the manifest's `emailIssuer.publicKeys` (EMAIL_PUBLIC_KEYS, the
// keys the issuer's JWKS serves, D196), never fetched: the API doesn't depend on the issuer's HTTP, and the chain is the
// authority anyway. Nothing of a token is ever logged.
import { base64UrlDecode } from './bytes.ts';
import type { Env } from './env.ts';
import { type SelfIssuedView, getSelfIssued } from './link-views.ts';
import { MAX_JWT } from './validate.ts';

/** The email provider name: in every email path (`{scope}#email#{sub}#{key_index}`), frozen. */
export const EMAIL_PROVIDER = 'email';
/** The contract's `MAX_JWS_SIGNATURES`. */
export const MAX_SIGNATURES = 3;
/** Exactly the claims Hana's issuer puts in a token (docs/email-login-spec.md "The token"): no address, ever. */
export const EMAIL_CLAIMS: ReadonlySet<string> = new Set(['iss', 'aud', 'sub', 'iat', 'exp', 'nonce', 'jti']);

export interface VerifiedEmailToken {
  provider: typeof EMAIL_PROVIDER;
  /** The signatures' kids (each listed under a counting signer on chain). */
  kids: string[];
  iss: string;
  aud: string;
  sub: string;
  exp: number;
  nonce: string | null;
}

export type EmailVerifyFailure =
  /** Malformed, a bad signature, an unknown key, not enough signers, or a claim outside the issuer's set. */
  | 'invalid_token'
  /** No email issuer in this env, or none on chain (a pre-v3 contract, or before `mark_self_issued`). */
  | 'unsupported_issuer'
  | 'token_expired'
  /** A published key that isn't active on chain yet (still in its governance delay): retry later. */
  | 'issuer_key_pending';

export type EmailVerifyResult = { ok: true; token: VerifiedEmailToken } | { ok: false; code: EmailVerifyFailure; error: string };

const fail = (code: EmailVerifyFailure, error: string): EmailVerifyResult => ({ ok: false, code, error });

/** Whether `token` is in the JWS JSON form (the contract's `is_json_form`: it starts with `{`). */
export const isJsonForm = (token: string): boolean => token.startsWith('{');

interface PublicKey {
  kid: string;
  n: string;
  e: string;
}

let keysCache: { raw: string; keys: Map<string, PublicKey> } | null = null;

/** EMAIL_PUBLIC_KEYS (a JSON array of public RSA JWKs) by kid; empty when unset or malformed (fail closed). */
export function emailPublicKeys(raw: string | undefined): Map<string, PublicKey> {
  if (!raw) return new Map();
  if (keysCache?.raw === raw) return keysCache.keys;
  const keys = new Map<string, PublicKey>();
  try {
    const list: unknown = JSON.parse(raw);
    if (Array.isArray(list)) {
      for (const k of list) {
        const j = k as Record<string, unknown>;
        if (j && j.kty === 'RSA' && typeof j.kid === 'string' && typeof j.n === 'string' && typeof j.e === 'string' && !('d' in j)) keys.set(j.kid, { kid: j.kid, n: j.n, e: j.e });
      }
    }
  } catch {
    keys.clear();
  }
  keysCache = { raw, keys };
  return keys;
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

function jsonSegment(b64: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(utf8.decode(base64UrlDecode(b64)));
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function verifyRs256(key: PublicKey, signingInput: string, signature: string): Promise<boolean> {
  try {
    const k = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: key.n, e: key.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', k, base64UrlDecode(signature), new TextEncoder().encode(signingInput));
  } catch {
    return false;
  }
}

/** The contract's `valid_sub`: 1–255 bytes, no `#`. */
const validSub = (s: string): boolean => s.length > 0 && new TextEncoder().encode(s).length <= 255 && !s.includes('#');
const validAud = (s: string): boolean => s.length > 0 && new TextEncoder().encode(s).length <= 256;

interface Parsed {
  claims: Record<string, unknown>;
  signatures: { kid: string; input: string; signature: string }[];
}

/**
 * The token's parts, or why it is malformed. Stricter than the contract on one point: the token must be exactly in the
 * form the issuer writes (`JSON.stringify` of `{payload, signatures: [{protected, signature}]}`), which also refuses
 * duplicate members and unknown ones, as the contract does, without a JSON parser that reports duplicates.
 */
function parse(token: string): Parsed | string {
  if (new TextEncoder().encode(token).length > MAX_JWT) return 'Token too large';
  let body: unknown;
  try {
    body = JSON.parse(token);
  } catch {
    return 'Malformed token';
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'Malformed token';
  const { payload, signatures } = body as Record<string, unknown>;
  if (typeof payload !== 'string' || !Array.isArray(signatures)) return 'Malformed token';
  const canonical = JSON.stringify({
    payload,
    signatures: signatures.map((s) => (typeof s === 'object' && s !== null ? { protected: (s as Record<string, unknown>).protected, signature: (s as Record<string, unknown>).signature } : s)),
  });
  if (canonical !== token) return 'Malformed token';
  if (signatures.length < 1) return 'Malformed token';
  if (signatures.length > MAX_SIGNATURES) return 'Too many signatures';
  const claims = jsonSegment(payload);
  if (!claims) return 'Malformed token claims';
  const out: Parsed['signatures'] = [];
  for (const entry of signatures as Record<string, unknown>[]) {
    if (typeof entry.protected !== 'string' || typeof entry.signature !== 'string') return 'Malformed token';
    const header = jsonSegment(entry.protected);
    if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string' || 'crit' in header) return 'Unsupported token header';
    out.push({ kid: header.kid, input: `${entry.protected}.${payload}`, signature: entry.signature });
  }
  return { claims, signatures: out };
}

/**
 * Whether the signatures' kids satisfy the policy: each kid an active key of a listed signer, at least `required`
 * distinct signers. A kid no signer lists answers `pending` (it may still be in its governance delay). A token that
 * only the previous policy of an overlap would accept is refused here (the view doesn't give that policy, D191): the
 * popup gets a fresh token, which the current policy accepts.
 */
export function policyAccepts(policy: SelfIssuedView, kids: readonly string[]): 'ok' | 'pending' | 'not_enough' {
  const signers = new Set<string>();
  for (const kid of kids) {
    const signer = policy.signers.find((s) => s.kids.includes(kid));
    if (!signer) return 'pending';
    signers.add(signer.id);
  }
  return signers.size >= policy.required ? 'ok' : 'not_enough';
}

/**
 * Verifies an email token as the contract will (see the top of this file). Throws only when the chain can't be read
 * (callers answer 502 near_unavailable). `aud`, `nonce` and the app's login methods are the caller's to check.
 */
export async function verifyEmailToken(env: Env, token: string, now: number, skewMs: number): Promise<EmailVerifyResult> {
  if (!env.EMAIL_ISS) return fail('unsupported_issuer', 'Email login is not set up in this environment');
  const parsed = parse(token);
  if (typeof parsed === 'string') return fail('invalid_token', parsed);
  const { claims, signatures } = parsed;
  const { iss, aud, sub, exp, nonce } = claims;
  if (typeof iss !== 'string' || typeof aud !== 'string' || typeof sub !== 'string' || typeof exp !== 'number' || !Number.isSafeInteger(exp) || exp < 0) {
    return fail('invalid_token', 'Malformed token claims');
  }
  if (iss !== env.EMAIL_ISS) return fail('unsupported_issuer', 'Unsupported token issuer');
  if (Object.keys(claims).some((c) => !EMAIL_CLAIMS.has(c))) return fail('invalid_token', 'The email token carries a claim outside the issuer’s set');
  if (nonce !== undefined && typeof nonce !== 'string') return fail('invalid_token', 'Malformed token claims');
  const nonceValue = typeof nonce === 'string' ? nonce : null;
  if (!validSub(sub) || !validAud(aud)) return fail('invalid_token', 'Malformed token claims');
  if (exp * 1000 + skewMs <= now) return fail('token_expired', 'The token has expired');
  const kids = signatures.map((s) => s.kid);
  if (new Set(kids).size !== kids.length) return fail('invalid_token', 'Duplicate signature kid');
  const keys = emailPublicKeys(env.EMAIL_PUBLIC_KEYS);
  for (const s of signatures) {
    const key = keys.get(s.kid);
    if (!key) return fail('invalid_token', 'Unknown token signing key');
    if (!(await verifyRs256(key, s.input, s.signature))) return fail('invalid_token', 'Invalid token signature');
  }
  const policy = await getSelfIssued(env, EMAIL_PROVIDER, kids, now);
  if (!policy) return fail('unsupported_issuer', 'Email login is not set up on chain');
  const judged = policyAccepts(policy, kids);
  if (judged === 'pending') return fail('issuer_key_pending', 'The token’s signing key is not active on chain yet, try again shortly');
  if (judged === 'not_enough') return fail('invalid_token', 'Not enough signatures');
  return { ok: true, token: { provider: EMAIL_PROVIDER, kids, iss, aud, sub, exp, nonce: nonceValue } };
}
