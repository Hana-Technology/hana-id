// Whether the signed-in owner can propose the app's changes that need an on-chain owner of its scope: adding origins,
// setting an auto-approve policy and turning raw signing on. The API checks the fresh sign-in's Google account against
// the scope's owners on chain (an organisation owner who isn't one is refused, `not_owner`), so a form that would end
// that way is replaced by one line saying who the on-chain owners are and how to be added. Read from the scope page's
// own route (`GET /api/orgs/:org/scopes/:scope`, one NEAR view), and only for an owner of an active organisation.
import { Link } from 'react-router-dom';
import type { ApiError } from '../../api.ts';
import { useApi } from '../../lib.tsx';
import { ErrorNote, Loading, Why } from '../../ui.tsx';

type Owner = { kind: 'near'; accountId: string } | { kind: 'member'; userId: string; email: string; orgOwner: boolean } | { kind: 'other_google' } | { kind: 'other'; provider: string };

interface ScopeOwners {
  scope: { id: string; owners: Owner[] };
  youAreOnChainOwner: boolean;
}

export interface ChainOwner {
  state: 'off' | 'loading' | 'yes' | 'no' | 'error';
  owners: Owner[];
  error?: ApiError | undefined;
  reload: () => void;
}

/** The on-chain owner check for `scopeId`; `enabled` false (a viewer, a frozen org, a deleted app) reads nothing. */
export function useChainOwner(org: string, scopeId: string, enabled: boolean): ChainOwner {
  const r = useApi<ScopeOwners>(enabled ? `/api/orgs/${org}/scopes/${scopeId}` : null);
  if (!enabled) return { state: 'off', owners: [], reload: r.reload };
  if (r.error) return { state: 'error', owners: [], error: r.error, reload: r.reload };
  if (!r.data) return { state: 'loading', owners: [], reload: r.reload };
  return { state: r.data.youAreOnChainOwner ? 'yes' : 'no', owners: r.data.scope.owners, reload: r.reload };
}

function ownerName(o: Owner): string {
  if (o.kind === 'member') return o.email;
  if (o.kind === 'near') return `the NEAR account ${o.accountId}`;
  if (o.kind === 'other_google') return 'a Google account outside your organisation';
  return `an owner of another kind (${o.provider})`;
}

/**
 * What stands in for a control that needs an on-chain owner: loading, the read's error, or the one line (who the
 * on-chain owners are; an on-chain owner who is an owner here can add this account from the scope page, else Hana).
 */
export function ChainOwnerGate({ chain, org, scopeId, what }: { chain: ChainOwner; org: string; scopeId: string; what: string }) {
  if (chain.state === 'loading') return <Loading label="Checking the scope’s on-chain owners…" />;
  if (chain.state === 'error' && chain.error) return <ErrorNote error={chain.error} onRetry={chain.reload} />;
  const names = chain.owners.map(ownerName);
  const canAdd = chain.owners.some((o) => o.kind === 'member' && o.orgOwner);
  const scopeLink = <Link to={`/orgs/${org}/scopes/${scopeId}`}>scope page</Link>;
  return (
    <Why>
      {what} needs an on-chain owner of this app’s scope, and your Google account isn’t one (its on-chain {names.length === 1 ? 'owner is' : 'owners are'} {names.length ? names.join(', ') : 'unknown'}).{' '}
      {canAdd ? (
        <>An on-chain owner can add you on the {scopeLink} (“set the on-chain owners to your organisation’s owners”); you can do this once that change has taken effect.</>
      ) : (
        <>No owner of your organisation is an on-chain owner yet, so ask Hana to add you; the {scopeLink} shows who can sign.</>
      )}
    </Why>
  );
}
