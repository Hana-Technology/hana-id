// Email ID-token check on the vault's side (docs/email-login-spec.md "Vault, popup and SDK changes": "verifies email
// tokens against the on-chain email keys, defence in depth"). Hana's email issuer signs its tokens in the JWS General
// JSON Serialization (one payload, 1–3 signatures, D121). The vault runs this on the relayed token before it fixes the
// path, as it runs verifyGoogleIdToken on a Google token: the token must be exactly in the issuer's form, its `iss` the
// env's pinned issuer, `aud` this scope's email client, `nonce` the pending login's, unexpired, carrying exactly the
// issuer's claims, and every signature RS256-valid with an active key the contract lists for `email`
// (`get_issuer_keys("email")`), each kid under a signer of the policy (`get_self_issued("email")`), at least `required`
// distinct signers. The API (apps/api src/email-token.ts) and the contract check the same; the vault never trusts the
// API's word for it. Nothing here logs.
import { base64UrlDecode, utf8 } from './bytes.ts';
import { TOKEN_SKEW_MS } from './id-token.ts';

/** The email provider name, in every email path `{scope}#email#{sub}#{key_index}` (frozen). */
export const EMAIL_PROVIDER = 'email';
/** The contract's `MAX_JWS_SIGNATURES`. */
export const EMAIL_TOKEN_MAX_SIGNATURES = 3;
/** The contract's and the API's token size limit (bytes). */
export const EMAIL_TOKEN_MAX_BYTES = 7168;
/** Exactly the claims Hana's issuer puts in a token: no address, ever. */
export const EMAIL_TOKEN_CLAIMS: readonly string[] = Object.freeze(['iss', 'aud', 'sub', 'iat', 'exp', 'nonce', 'jti']);

/** An active email key on chain (`get_issuer_keys("email")`: `{kid, n, e}`, JWK base64url). */
export interface EmailChainKey {
  kid: string;
  n: string;
  e: string;
}

/** The signer policy on chain (`get_self_issued("email")`). */
export interface EmailSignerPolicy {
  signers: readonly { id: string; kids: readonly string[] }[];
  required: number;
}

export interface EmailTokenExpectations {
  /** The env's pinned email `iss` (manifest `emailIssuer.iss`). */
  iss: string;
  /** `email:<scopeId>`. */
  aud: string;
  /** The pending login's session nonce. */
  nonce: string;
  /** Server-corrected time in ms. */
  nowMs: number;
  /** The active email keys on chain. */
  keys: readonly EmailChainKey[];
  /** The signer policy on chain, or null when the chain has none (no email issuer there). */
  policy: EmailSignerPolicy | null;
}

export interface VerifiedEmailIdToken {
  iss: string;
  aud: string;
  sub: string;
  nonce: string;
  iat: number;
  exp: number;
  kids: string[];
}

export type EmailTokenResult =
  | { ok: true; token: VerifiedEmailIdToken }
  /** `key_pending`: a kid the chain doesn't list yet (still in its governance delay); everything else is `token_invalid`. */
  | { ok: false; code: 'token_invalid' | 'key_pending'; reason: string };

const invalid = (reason: string): EmailTokenResult => ({ ok: false, code: 'token_invalid', reason });

/** Whether `token` is in the JWS JSON form (the contract's `is_json_form`: it starts with `{`). */
export const isJsonFormToken = (token: string): boolean => token.startsWith('{');

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

function jsonSegment(b64: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(decoder.decode(base64UrlDecode(b64)));
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function verifyRs256(key: EmailChainKey, signingInput: string, signature: string): Promise<boolean> {
  try {
    const k = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: key.n, e: key.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', k, base64UrlDecode(signature) as Uint8Array<ArrayBuffer>, utf8(signingInput) as Uint8Array<ArrayBuffer>);
  } catch {
    return false;
  }
}

const utf8Length = (s: string): number => utf8(s).length;

/**
 * Verifies an email token for the pending login (see the top of this file). Never throws for a bad token. The
 * signatures are checked before the claims are trusted. A kid the chain doesn't list answers `key_pending` (refused,
 * worded "try again later"), anything else wrong `token_invalid`.
 */
export async function verifyEmailIdToken(token: string, expect: EmailTokenExpectations): Promise<EmailTokenResult> {
  if (utf8Length(token) > EMAIL_TOKEN_MAX_BYTES) return invalid('Token too large');
  let body: unknown;
  try {
    body = JSON.parse(token);
  } catch {
    return invalid('Malformed token');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return invalid('Malformed token');
  const { payload, signatures } = body as Record<string, unknown>;
  if (typeof payload !== 'string' || !Array.isArray(signatures) || signatures.length < 1 || signatures.length > EMAIL_TOKEN_MAX_SIGNATURES) return invalid('Malformed token');
  // Exactly the form the issuer writes (JSON.stringify of {payload, signatures: [{protected, signature}]}): no extra or
  // duplicate member, no unprotected header, no whitespace.
  const canonical = JSON.stringify({
    payload,
    signatures: signatures.map((s) => (typeof s === 'object' && s !== null ? { protected: (s as Record<string, unknown>).protected, signature: (s as Record<string, unknown>).signature } : s)),
  });
  if (canonical !== token) return invalid('Malformed token');
  const entries: { kid: string; input: string; signature: string }[] = [];
  for (const raw of signatures as Record<string, unknown>[]) {
    if (typeof raw.protected !== 'string' || typeof raw.signature !== 'string') return invalid('Malformed token');
    const header = jsonSegment(raw.protected);
    if (!header || Object.keys(header).some((k) => k !== 'alg' && k !== 'kid') || header.alg !== 'RS256' || typeof header.kid !== 'string') return invalid('Unsupported token header');
    entries.push({ kid: header.kid, input: `${raw.protected}.${payload}`, signature: raw.signature });
  }
  const kids = entries.map((e) => e.kid);
  if (new Set(kids).size !== kids.length) return invalid('Duplicate signature kid');
  for (const e of entries) {
    const key = expect.keys.find((k) => k.kid === e.kid);
    // A kid the chain doesn't hold yet: a key still in its governance delay (or a forged kid). Refused either way;
    // only the wording differs (try again later).
    if (!key) return { ok: false, code: 'key_pending', reason: 'The token’s signing key is not active on chain yet' };
    if (!(await verifyRs256(key, e.input, e.signature))) return invalid('Invalid token signature');
  }

  const claims = jsonSegment(payload);
  if (!claims) return invalid('Malformed token claims');
  if (Object.keys(claims).some((c) => !EMAIL_TOKEN_CLAIMS.includes(c))) return invalid('The token carries a claim outside the issuer’s set');
  const { iss, aud, sub, nonce, iat, exp } = claims;
  if (typeof iss !== 'string' || iss !== expect.iss) return invalid('Wrong token issuer');
  if (typeof aud !== 'string' || aud !== expect.aud) return invalid('Wrong token audience');
  if (typeof nonce !== 'string' || nonce !== expect.nonce) return invalid('Wrong token nonce');
  if (typeof exp !== 'number' || !Number.isSafeInteger(exp) || exp * 1000 <= expect.nowMs - TOKEN_SKEW_MS) return invalid('The token has expired');
  if (typeof iat !== 'number' || !Number.isSafeInteger(iat) || iat * 1000 > expect.nowMs + TOKEN_SKEW_MS) return invalid('The token is issued in the future');
  if (typeof sub !== 'string' || sub.length === 0 || utf8Length(sub) > 255 || sub.includes('#')) return invalid('Malformed sub claim');
  if (typeof claims.jti !== 'string') return invalid('Malformed jti claim');

  // The signer policy: every kid under a signer, at least `required` distinct signers.
  const policy = expect.policy;
  if (!policy) return invalid('No email issuer on chain');
  const signers = new Set<string>();
  for (const kid of kids) {
    const signer = policy.signers.find((s) => s.kids.includes(kid));
    if (!signer) return invalid('The token’s signing key belongs to no signer');
    signers.add(signer.id);
  }
  if (signers.size < Math.max(1, policy.required)) return invalid('Not enough signatures');
  return { ok: true, token: { iss, aud, sub, nonce, iat, exp, kids } };
}
