// The on-chain reads the RPC writers make, always uncached (docs/batch-c-spec.md "Apps, scopes", "Other app
// settings"): a scope's owners (createApp, assignScopeOrg) and its Google clients (updateSettings'
// googleWebClientId). NEAR RPC down is `near_unavailable`, never a guess.
import type { Env } from '../env.ts';
import { type ScopeView, getScope } from '../views.ts';
import { refuse } from './cas.ts';

export async function scopeOnChain(env: Env, scopeId: string): Promise<ScopeView | null> {
  try {
    return await getScope(env, scopeId, { fresh: true });
  } catch {
    return refuse('near_unavailable', 'NEAR RPC is unavailable: try again');
  }
}

/** The `Owner::Oidc` owners of a scope as `[provider, sub]`; other owner kinds (`Near`) are not members' identities. */
export function oidcOwners(scope: ScopeView): [string, string][] {
  return scope.owners.flatMap((o) => {
    const oidc = (o as { Oidc?: { provider?: unknown; sub?: unknown } } | null)?.Oidc;
    return oidc && typeof oidc.provider === 'string' && typeof oidc.sub === 'string' ? [[oidc.provider, oidc.sub] as [string, string]] : [];
  });
}

/**
 * createApp and assignScopeOrg (spec "Apps, scopes"): the scope must exist on chain and every `Owner::Oidc` of it must
 * be the Google sub of an owner of the org (`orgOwnerSubs`, from StaffRpc.listMembers). Otherwise `scope_conflict`.
 */
export async function requireOwnersInOrg(env: Env, scopeId: string, orgOwnerSubs: readonly string[]): Promise<void> {
  const scope = await scopeOnChain(env, scopeId);
  if (!scope) refuse('scope_conflict', `Scope ${scopeId} is not registered on ${env.SIGNER_ACCOUNT}`);
  const subs = new Set(orgOwnerSubs);
  const strangers = oidcOwners(scope!).filter(([provider, sub]) => provider !== 'google' || !subs.has(sub));
  if (strangers.length) refuse('scope_conflict', `The scope has ${strangers.length} on-chain OIDC owner(s) who are not owners of this org`);
}

/** The scope's Google client ids on chain (what `googleWebClientId` may name). */
export async function scopeGoogleClients(env: Env, scopeId: string): Promise<string[]> {
  const scope = await scopeOnChain(env, scopeId);
  if (!scope) return refuse('bad_request', `Scope ${scopeId} is not registered on chain`);
  return scope.clients.filter(([p]) => p === 'google').map(([, aud]) => aud);
}
