// Email tokens: JWS General JSON Serialization (RFC 7515 §7.2.1), two-signer-ready from day one (spec "The token",
// D121). Each entry signs ASCII(protected_i ‖ "." ‖ payload) on its own; the protected header is exactly
// {"alg":"RS256","kid":…}; no unprotected `header`, no `crit`; at most 3 entries with distinct kids (what the contract
// parses, docs/contract-interface.md "Token verification"). Every signature is verified with its published public key
// before the token leaves the issuer, so a KMS or wiring fault never reaches the chain.
import { base64UrlEncode, utf8 } from './bytes.ts';
import { type IssuerSigner, type PublicJwk, SignerUnavailable, verifyRs256 } from './signer.ts';

/** The contract's limits. */
export const MAX_SIGNATURES = 3;
export const MAX_TOKEN_BYTES = 7168;
/** Token lifetime: only needs to land in one `create_session*` (the vault retries within it). */
export const TOKEN_LIFETIME_S = 600;

/** Exactly the claims of the spec's table, in this order; no email, email_verified or name claim ever. */
export interface EmailClaims {
  iss: string;
  aud: string;
  sub: string;
  iat: number;
  exp: number;
  nonce: string;
  jti: string;
}

export const b64urlJson = (v: unknown): string => base64UrlEncode(utf8(JSON.stringify(v)));

export async function mintJws(claims: EmailClaims, signers: readonly IssuerSigner[], published: readonly PublicJwk[]): Promise<string> {
  if (signers.length < 1 || signers.length > MAX_SIGNATURES) throw new SignerUnavailable(`a token takes 1 to ${MAX_SIGNATURES} signatures`);
  if (new Set(signers.map((s) => s.kid)).size !== signers.length) throw new SignerUnavailable('duplicate signature kid');
  const ordered: EmailClaims = { iss: claims.iss, aud: claims.aud, sub: claims.sub, iat: claims.iat, exp: claims.exp, nonce: claims.nonce, jti: claims.jti };
  const payload = b64urlJson(ordered);
  const signatures: { protected: string; signature: string }[] = [];
  for (const s of signers) {
    const key = published.find((k) => k.kid === s.kid);
    if (!key) throw new SignerUnavailable('the signing key is not published');
    const prot = b64urlJson({ alg: 'RS256', kid: s.kid });
    const input = utf8(`${prot}.${payload}`);
    let sig: Uint8Array;
    try {
      sig = await s.sign(input);
    } catch (err) {
      if (err instanceof SignerUnavailable) throw err;
      throw new SignerUnavailable('sign failed');
    }
    // Self-check: the signature verifies against the key the JWKS (and the chain) holds for this kid.
    if (!(await verifyRs256(key, input, sig))) throw new SignerUnavailable('self-check failed');
    signatures.push({ protected: prot, signature: base64UrlEncode(sig) });
  }
  const token = JSON.stringify({ payload, signatures });
  if (utf8(token).length > MAX_TOKEN_BYTES) throw new SignerUnavailable('token too large');
  return token;
}
