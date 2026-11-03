// A client proof for a scope's email client (docs/contract-interface.md "Client proof (`propose_change` with
// `AddClient`)"): an email token for ("email", "email:" + scope_id) whose nonce is
// b64url(sha256("hana-id/client-proof/v1" ‖ borsh(signer) ‖ borsh(scope_id) ‖ action_nonce u64 LE)), `sub`
// "hana-client-proof" (never an `e1.` sub, so never an email user's identity). One definition of its claims for the
// issuer's staff route (handlers.ts `handleClientProof`), the dev-env CLI's local mint (scripts/lib/admin-email-client.ts,
// D253) and the contract fixture (scripts/gen-contract-fixture.ts, checked by the contract's tests/email/issuer_tokens.rs).
import { type EmailClaims, TOKEN_LIFETIME_S, mintJws } from './jws.ts';
import { EMAIL_PROVIDER, clientProofPreimage, nonceOf } from './layouts.ts';
import type { IssuerSigner, PublicJwk } from './signer.ts';

/** The `sub` of a client proof. */
export const CLIENT_PROOF_SUB = 'hana-client-proof';

/** The scope's email client `aud`: "email:" + scope_id. */
export const emailClientAud = (scopeId: string): string => `email:${scopeId}`;

/** The scope's email client, as `get_scope` lists it. */
export const emailClient = (scopeId: string): [string, string] => [EMAIL_PROVIDER, emailClientAud(scopeId)];

/** client_proof_nonce(signer, scope_id, action_nonce), as the contract computes it in `propose_change`. */
export const clientProofNonce = (signer: string, scopeId: string, actionNonce: number): string => nonceOf(clientProofPreimage(signer, scopeId, actionNonce));

export interface ClientProofInput {
  /** The issuer's `iss` (EMAIL_ISS, the manifest's `emailIssuer.iss`). */
  iss: string;
  /** The signer contract account (SIGNER_ACCOUNT). */
  signerAccount: string;
  scopeId: string;
  /** The scope's current `action_nonce` (`get_scope`). */
  actionNonce: number;
  /** Seconds. */
  iat: number;
  jti: string;
}

/** The claims of a client proof: the email token's claims, valid TOKEN_LIFETIME_S. */
export const clientProofClaims = (p: ClientProofInput): EmailClaims => ({
  iss: p.iss,
  aud: emailClientAud(p.scopeId),
  sub: CLIENT_PROOF_SUB,
  iat: p.iat,
  exp: p.iat + TOKEN_LIFETIME_S,
  nonce: clientProofNonce(p.signerAccount, p.scopeId, p.actionNonce),
  jti: p.jti,
});

/** Mints a client proof (JWS JSON, each signature self-checked against `published`). */
export const mintClientProof = (p: ClientProofInput, signers: readonly IssuerSigner[], published: readonly PublicJwk[]): Promise<string> =>
  mintJws(clientProofClaims(p), signers, published);
