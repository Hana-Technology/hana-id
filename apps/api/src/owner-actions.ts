// Off-chain checks for /v1/owner-actions and ConsoleRpc.ownerAction, run before anything is relayed. The endpoint has
// no app key (the proof is in the args), and every relayed transaction is paid from the relayer's allowance even when
// the contract rejects it, so a request is relayed only if it would plausibly succeed: a genuine (signature-checked),
// unexpired console token of an owner of an existing scope whose nonce commits to exactly this action at the scope's
// current `action_nonce` (`owner_nonce_mismatch` otherwise; docs/batch-c-spec.md "On-chain owner actions"), a change
// that exists (and, for execute_change, is unlocked), and a client proof for that client whose nonce is the scope's
// client-proof nonce. The scope is read uncached, so a nonce that moved since the console built the action is caught
// here, for free, rather than on chain. The contract still checks everything.
// Both tokens are relayed to the chain, where they are public, so both are held to the claim allow-list (claims.ts,
// `token_has_pii`) as login tokens are (D271, D274), on both paths (the endpoint and ConsoleRpc.ownerAction): an
// owner's email or Workspace domain is never relayed.
import { EMAIL_PROVIDER, verifyEmailToken } from './email-token.ts';
import { AUTHENTICATED_OWNER_METHODS, clientProofNonce, ownerActionNonce } from '@hana-id/console-core';
import { verifyIdToken } from '@hana-id/oidc';
import { hex } from './bytes.ts';
import { disallowedClaim } from './claims.ts';
import type { Env } from './env.ts';
import { logStaleJwks } from './log.ts';
import type { ContractCall } from './near/tx.ts';
import { getConfig, getScope, isSharedOrPending } from './views.ts';

export type OwnerPrecheck =
  | {
      ok: true;
      scopeId: string;
      authToken: { hash: string; expMs: number } | null;
      /** The OIDC owner the token proves (null for execute_change, which takes no auth): the per-owner caps' subject. */
      owner: { provider: string; sub: string } | null;
    }
  | { ok: false; status: number; code: string; error: string; data?: Record<string, unknown> };

const no = (status: number, code: string, error: string): OwnerPrecheck => ({ ok: false, status, code, error });

export interface PrecheckOptions {
  /**
   * ConsoleRpc.ownerAction: the owner token's optional claims are also checked strictly (D201). The claim allow-list
   * applies on every path, this one included (D274).
   */
  console?: boolean;
}

/** `token_has_pii` for a verified token with a claim outside the allow-list, else null (D274). */
function piiRefusal(jwt: string, which: string): OwnerPrecheck | null {
  const claim = disallowedClaim(jwt);
  return claim === null ? null : { ok: false, status: 400, code: 'token_has_pii', error: `${which} carries a claim outside the allow-list`, data: { claim } };
}

const isOidcOwner = (owner: unknown, provider: string, sub: string): boolean => {
  const o = (owner as { Oidc?: { provider?: unknown; sub?: unknown } } | null)?.Oidc;
  return !!o && o.provider === provider && o.sub === sub;
};

export async function sha256Hex(s: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
}

/**
 * `call` must already have passed `toOwnerAction`. Throws when a view or the issuer's JWKS can't be read (the caller
 * answers 5xx: fail closed). Order: the owner token (signature, issuer, expiry; console audience), the scope (uncached)
 * and its owners, the owner nonce, then the method's own checks (the client proof's signature, client and nonce for
 * AddClient). Nothing is reserved or counted before it passes.
 */
export async function precheckOwnerAction(env: Env, call: ContractCall, now: number = Date.now(), opts: PrecheckOptions = {}): Promise<OwnerPrecheck> {
  const args = call.args;
  const scopeId = args.scope_id as string;

  let authToken: { hash: string; expMs: number } | null = null;
  let owner: { provider: string; sub: string } | null = null;
  let tokenNonce: string | null = null;
  if (call.method !== 'execute_change') {
    const jwt = (args.auth as { Oidc: { jwt: string } }).Oidc.jwt;
    const v = await verifyIdToken(jwt, now, { onStaleKeys: logStaleJwks, identityIssuer: env.IDENTITY_ISS, ...(opts.console ? { optionalClaims: 'strict' as const } : {}) });
    if (!v.ok) return no(v.code === 'unsupported_issuer' || v.code === 'bad_token' ? 400 : 401, v.code, v.error);
    const pii = piiRefusal(jwt, 'The owner token');
    if (pii) return pii;
    const config = await getConfig(env);
    if (!config.console_audiences.some(([p, a]) => p === v.token.provider && a === v.token.aud)) return no(403, 'not_console_token', 'Token is not for the Journear Passport console');
    owner = { provider: v.token.provider, sub: v.token.sub };
    tokenNonce = v.token.nonce;
    authToken = { hash: await sha256Hex(jwt), expMs: v.token.exp * 1000 };
  }

  // Uncached: the nonces below commit to the scope's action_nonce now, not as a cached view had it.
  const scope = await getScope(env, scopeId, { fresh: true });
  if (!scope) return no(404, 'unknown_scope', 'No such scope');
  if (owner && !scope.owners.some((o) => isOidcOwner(o, owner.provider, owner.sub))) return no(403, 'not_owner', 'Token is not from an owner of this scope');
  const actionNonce = scope.action_nonce;
  if (!Number.isSafeInteger(actionNonce) || actionNonce < 0) throw new Error('get_scope returned no action_nonce');
  if (owner && (AUTHENTICATED_OWNER_METHODS as readonly string[]).includes(call.method)) {
    let expected: string;
    try {
      expected = await ownerActionNonce({ signer: env.SIGNER_ACCOUNT, method: call.method, args, actionNonce });
    } catch {
      return no(400, 'bad_request', 'Malformed owner action arguments');
    }
    if (tokenNonce !== expected) return no(409, 'owner_nonce_mismatch', `The owner token is not for this action at the scope's action_nonce ${actionNonce}: rebuild the action and sign it again`);
  }

  switch (call.method) {
    case 'execute_change':
    case 'cancel_change': {
      const pending = scope.pending.find((p) => p.id === args.change_id);
      if (!pending) return no(404, 'unknown_change', 'No such change');
      if (call.method === 'execute_change' && pending.unlock_at_ms > now) return no(409, 'change_locked', 'Change is still timelocked');
      break;
    }
    case 'remove_client': {
      if (!scope.clients.some(([p, a]) => p === args.provider && a === args.aud)) return no(404, 'unknown_client', 'Client is not in this scope');
      // The last client may go only while shared login keeps the scope usable.
      if (scope.clients.length <= 1 && !scope.allow_shared) return no(409, 'last_client', 'Cannot remove the last client');
      break;
    }
    case 'disable_shared_login': {
      if (!scope.allow_shared) return no(409, 'shared_login_disabled', 'Shared login is already disabled for this scope');
      if (scope.clients.length === 0) return no(409, 'last_client', 'A scope without its own client must keep shared login');
      break;
    }
    case 'propose_change': {
      const change = args.change as { AddClient?: { provider: string; aud: string }; SetAllowShared?: { allow: boolean } };
      if (change.SetAllowShared && scope.allow_shared) return no(409, 'shared_login_enabled', 'Shared login is already enabled for this scope');
      const add = change.AddClient;
      if (add?.provider === EMAIL_PROVIDER) {
        // The scope's email client (D447): the issuer's JWS JSON proof, checked against the published keys and the on-chain signer policy.
        const proof = await verifyEmailToken(env, args.client_proof as string, now, 0);
        if (!proof.ok) return no(400, proof.code === 'invalid_token' ? 'bad_token' : 'invalid_client_proof', `Client proof: ${proof.error}`);
        if (proof.token.aud !== add.aud) return no(400, 'invalid_client_proof', 'Client proof is for another client');
        if (proof.token.sub !== 'hana-client-proof') return no(400, 'invalid_client_proof', 'Not a client proof');
        if (proof.token.nonce !== (await clientProofNonce({ signer: env.SIGNER_ACCOUNT, scopeId, actionNonce }))) {
          return no(400, 'invalid_client_proof', `Client proof nonce is not this scope's client-proof nonce at action_nonce ${actionNonce}`);
        }
        if (scope.clients.some(([p, a]) => p === add.provider && a === add.aud)) return no(409, 'client_registered', 'Client is already in this scope');
      } else if (add) {
        const proof = await verifyIdToken(args.client_proof as string, now, { onStaleKeys: logStaleJwks, identityIssuer: env.IDENTITY_ISS });
        if (!proof.ok) return no(400, proof.code === 'bad_token' ? 'bad_token' : 'invalid_client_proof', `Client proof: ${proof.error}`);
        const proofPii = piiRefusal(args.client_proof as string, 'The client proof');
        if (proofPii) return proofPii;
        if (proof.token.provider !== add.provider || proof.token.aud !== add.aud) return no(400, 'invalid_client_proof', 'Client proof is for another client');
        if (proof.token.nonce !== (await clientProofNonce({ signer: env.SIGNER_ACCOUNT, scopeId, actionNonce }))) {
          return no(400, 'invalid_client_proof', `Client proof nonce is not this scope's client-proof nonce at action_nonce ${actionNonce}`);
        }
        if (scope.clients.some(([p, a]) => p === add.provider && a === add.aud)) return no(409, 'client_registered', 'Client is already in this scope');
        const config = await getConfig(env);
        if (isSharedOrPending(config, add.provider, add.aud)) return no(409, 'shared_client', 'This client is one of Journear’s shared login clients');
      }
      break;
    }
    default:
      return no(400, 'bad_request', 'Unsupported owner action');
  }
  return { ok: true, scopeId, authToken, owner };
}
