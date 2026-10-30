// Off-chain checks for /v1/owner-actions, run before anything is relayed. The endpoint has no app key (the proof is
// in the args), and every relayed transaction is paid from the relayer's allowance even when the contract rejects
// it, so a request is relayed only if it would plausibly succeed: a genuine (signature-checked), unexpired console
// token of an owner of an existing scope, a change that exists (and, for execute_change, is unlocked), and a client
// proof that matches the change. The contract still checks everything, including the nonces.
import { hex } from './bytes.ts';
import type { Env } from './env.ts';
import { verifyIdToken } from './jwks.ts';
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
  | { ok: false; status: number; code: string; error: string };

const no = (status: number, code: string, error: string): OwnerPrecheck => ({ ok: false, status, code, error });

const isOidcOwner = (owner: unknown, provider: string, sub: string): boolean => {
  const o = (owner as { Oidc?: { provider?: unknown; sub?: unknown } } | null)?.Oidc;
  return !!o && o.provider === provider && o.sub === sub;
};

export async function sha256Hex(s: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
}

/**
 * `call` must already have passed `toOwnerAction`. Throws when a view or the issuer's JWKS can't be read (the caller
 * answers 5xx: fail closed).
 */
export async function precheckOwnerAction(env: Env, call: ContractCall, now: number = Date.now()): Promise<OwnerPrecheck> {
  const args = call.args;
  const scopeId = args.scope_id as string;

  let authToken: { hash: string; expMs: number } | null = null;
  let owner: { provider: string; sub: string } | null = null;
  if (call.method !== 'execute_change') {
    const jwt = (args.auth as { Oidc: { jwt: string } }).Oidc.jwt;
    const v = await verifyIdToken(jwt, now, { identityIssuer: env.IDENTITY_ISS });
    if (!v.ok) return no(v.code === 'unsupported_issuer' || v.code === 'bad_token' ? 400 : 401, v.code, v.error);
    const config = await getConfig(env);
    if (!config.console_audiences.some(([p, a]) => p === v.token.provider && a === v.token.aud)) return no(403, 'not_console_token', 'Token is not for the Hana console');
    owner = { provider: v.token.provider, sub: v.token.sub };
    authToken = { hash: await sha256Hex(jwt), expMs: v.token.exp * 1000 };
  }

  const scope = await getScope(env, scopeId);
  if (!scope) return no(404, 'unknown_scope', 'No such scope');
  if (owner && !scope.owners.some((o) => isOidcOwner(o, owner.provider, owner.sub))) return no(403, 'not_owner', 'Token is not from an owner of this scope');

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
      if (add) {
        const proof = await verifyIdToken(args.client_proof as string, now, { identityIssuer: env.IDENTITY_ISS });
        if (!proof.ok) return no(400, proof.code === 'bad_token' ? 'bad_token' : 'invalid_client_proof', `Client proof: ${proof.error}`);
        if (proof.token.provider !== add.provider || proof.token.aud !== add.aud) return no(400, 'invalid_client_proof', 'Client proof is for another client');
        if (scope.clients.some(([p, a]) => p === add.provider && a === add.aud)) return no(409, 'client_registered', 'Client is already in this scope');
        const config = await getConfig(env);
        if (isSharedOrPending(config, add.provider, add.aud)) return no(409, 'shared_client', 'This client is one of Hana’s shared login clients');
      }
      break;
    }
    default:
      return no(400, 'bad_request', 'Unsupported owner action');
  }
  return { ok: true, scopeId, authToken, owner };
}
