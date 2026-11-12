// A scope on chain (`GET /api/orgs/:org/scopes/:scope`; docs/batch-c-spec.md "On-chain owner actions", "Owner drift"):
// its owners (members by address, never a Google account id), clients, shared login and pending changes, owner drift
// with a SetOwners proposal, and the owner actions (each a fresh sign-in whose token the contract checks). AddClient
// needs a client proof from the client itself: the helper is a download the partner opens on one of the client's own
// origins, and the pasted token is accepted only after the warning that it becomes public on chain. A pending change is
// judged on the server's clock, and the page re-reads once when the next one unlocks (D701, D713).
import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { postJson } from '../api.ts';
import { relative, useApi, useNow, useOrg, useStepUp, useWrite, when } from '../lib.tsx';
import { Callout, ConfirmButton, CopyButton, ErrorNote, Loading, PageHeader, Panel, StepUpHint, Why, WriteNote } from '../ui.tsx';
import { clockOffset, useReloadAt } from './Apps.tsx';

type Owner = { kind: 'near'; accountId: string } | { kind: 'member'; userId: string; email: string; orgOwner: boolean } | { kind: 'other_google' } | { kind: 'other'; provider: string };

interface ScopeAnswer {
  scope: {
    id: string;
    actionNonce: number;
    allowShared: boolean;
    clients: { provider: string; aud: string }[];
    owners: Owner[];
    pending: { id: number; change: Record<string, unknown>; unlockAt: number; executable: boolean }[];
  };
  drift: { hasDrift: boolean; missingOnChain: { userId: string; email: string }[]; notOrgOwners: { userId: string; email: string }[]; unknownOnChain: number };
  youAreOnChainOwner: boolean;
  /** The Worker's clock when it judged `executable` (D701). */
  now?: number;
}

function ownerText(o: Owner): string {
  if (o.kind === 'near') return `NEAR account ${o.accountId}`;
  if (o.kind === 'member') return `${o.email}${o.orgOwner ? '' : ' (not an owner in the console)'}`;
  if (o.kind === 'other_google') return 'A Google account that isn’t a member of this organisation';
  return `An owner of another kind (${o.provider})`;
}

function changeText(c: Record<string, unknown>): string {
  if (c.kind === 'AddClient' && c.provider === 'email') return `Add Journear’s email client ${String(c.aud)}`;
  if (c.kind === 'AddClient') return `Add client ${String(c.aud)}`;
  if (c.kind === 'SetAllowShared') return 'Turn shared login on';
  if (c.kind === 'SetOwners') return `Set owners: ${((c.owners as Owner[]) ?? []).map(ownerText).join('; ')}`;
  return 'Unknown change';
}

/** The pasted proof, the PII warning and the AddClient action. */
function AddClient({ org, scopeId, start, busy }: { org: string; scopeId: string; start: (kind: string, params: unknown) => Promise<void>; busy: boolean }) {
  const [aud, setAud] = useState('');
  const [proof, setProof] = useState('');
  const [accepted, setAccepted] = useState(false);
  const valid = /^[0-9]{1,32}-[0-9a-z]{1,64}\.apps\.googleusercontent\.com$/u.test(aud.trim());
  return (
    <div className="editor">
      <h3>Add your own Google client</h3>
      <p className="muted small">Your own client shows your app on Google’s consent screen (partner guide, section 6). Adding it is timelocked by the contract.</p>
      <ol className="steps">
        <li>
          <label>
            The client id <input className="jp-input mono" value={aud} onChange={(e) => setAud(e.target.value)} placeholder="123-abc.apps.googleusercontent.com" />
          </label>
        </li>
        <li>
          {valid ? (
            <a href={`/api/orgs/${org}/scopes/${scopeId}/client-proof-helper?clientId=${encodeURIComponent(aud.trim())}`} download>
              Download the client-proof helper
            </a>
          ) : (
            <span className="muted">Download the client-proof helper (enter the client id first)</span>
          )}
          , host it on one of that client’s origins, register its address as a redirect URI of the client, open it and sign in.
        </li>
        <li>
          <label>
            Paste the token it shows <textarea className="jp-input mono" rows={4} value={proof} onChange={(e) => setProof(e.target.value.trim())} />
          </label>
        </li>
      </ol>
      <Callout tone="warn" role="note">
        This token becomes <strong>public on the NEAR blockchain</strong> once the change is relayed. It identifies the Google account that signed in on the helper page (its account id for your client).
        Journear accepts it only without an email address, name or Workspace domain in it, but the account id stays public for good: use an account you are content to have recorded, such as a team
        account.
      </Callout>
      <label className="jp-check">
        <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} /> I understand the token becomes public on chain
      </label>
      <button
        type="button"
        className="jp-btn jp-btn-primary"
        disabled={busy || !valid || !proof || !accepted}
        onClick={() => void start('owner_action', { scopeId, method: 'propose_change', change: { kind: 'AddClient', aud: aud.trim(), clientProof: proof, piiWarningAccepted: true } })}
      >
        Propose adding the client (confirm with Google)
      </button>
    </div>
  );
}

export function ScopePage() {
  const { org, scope } = useParams();
  const ctx = useOrg();
  const r = useApi<ScopeAnswer>(`/api/orgs/${org}/scopes/${scope}`);
  const step = useStepUp(org!, { page: 'scope' });
  const w = useWrite();
  useNow(30_000); // the countdowns
  // The server's clock (D701): one re-read when the next waiting change unlocks, so its Execute appears (D713).
  const offset = useMemo(() => clockOffset(r.data?.now, Date.now()), [r.data]);
  const answeredAt = typeof r.data?.now === 'number' ? r.data.now : Number.NEGATIVE_INFINITY;
  const locked = (r.data?.scope.pending ?? []).filter((p) => !p.executable && p.unlockAt > answeredAt).map((p) => p.unlockAt);
  useReloadAt(locked.length ? Math.min(...locked) : null, r.reload, offset);
  const head = (
    <PageHeader
      back={{ to: `/orgs/${org}`, label: 'Apps' }}
      title="Google clients and on-chain owners"
      description="Your apps’ scope as the hana-signer contract holds it: who may change it, which Google clients sign users in, and changes waiting on chain. Every change here is timelocked by the contract unless it says “at once”, and any on-chain owner can cancel it meanwhile."
    />
  );
  if (r.error)
    return (
      <>
        {head}
        <ErrorNote error={r.error} onRetry={r.reload} />
      </>
    );
  if (!r.data)
    return (
      <>
        {head}
        <Loading label="Reading the chain…" />
      </>
    );
  const { scope: s, drift, youAreOnChainOwner } = r.data;
  const owner = ctx?.role === 'owner' && !ctx.frozen;
  const can = owner && youAreOnChainOwner;
  const act = (params: Record<string, unknown>) => void step.start('owner_action', { scopeId: s.id, ...params });
  const now = Date.now() + offset;
  return (
    <>
      {head}
      <p className="muted small">
        Scope <code>{s.id}</code> <CopyButton value={s.id} label="scope ID" /> · read from the chain now (action nonce {s.actionNonce})
      </p>
      {owner && !youAreOnChainOwner && <Callout tone="info">Your Google account isn’t an on-chain owner of this scope, so you can’t sign owner actions. Ask an on-chain owner to add you (Set owners), or ask Journear.</Callout>}
      {ctx?.role !== 'owner' && <Why>You’re a viewer: only owners who are also on-chain owners can change the scope.</Why>}
      {ctx?.role === 'owner' && ctx.frozen && <Why>Owner actions are paused while Journear has frozen the organisation.</Why>}
      <div className="stack">
        <Panel title="On-chain owners" description="The Google accounts and NEAR accounts that may change this scope on chain.">
          <ul className="plain-list">
            {s.owners.map((o, i) => (
              <li key={i}>{ownerText(o)}</li>
            ))}
          </ul>
          {drift.hasDrift && (
            <Callout tone="warn" title="The scope’s on-chain owners differ from your organisation’s owners:">
              <ul>
                {drift.missingOnChain.map((m) => (
                  <li key={m.userId}>{m.email} is an owner here but not on chain</li>
                ))}
                {drift.notOrgOwners.map((m) => (
                  <li key={m.userId}>{m.email} is an owner on chain but not an owner here</li>
                ))}
                {drift.unknownOnChain > 0 && <li>{drift.unknownOnChain} on-chain owner(s) aren’t members of this organisation</li>}
              </ul>
              {can && (
                <button type="button" className="jp-btn jp-btn-secondary" disabled={step.busy} onClick={() => act({ method: 'propose_change', change: { kind: 'SetOwners' } })}>
                  Propose: set the on-chain owners to your organisation’s owners (confirm with Google)
                </button>
              )}
            </Callout>
          )}
        </Panel>
        <Panel title="Google clients" description="The Google OAuth clients users of this scope sign in through.">
          <ul className="plain-list">
            {s.clients.map((c) => (
              <li key={`${c.provider}:${c.aud}`} className="row-between">
                <span className="mono small">{c.aud}</span>
                {can && <ConfirmButton label="Remove" confirm="Remove at once (confirm with Google)" detail="Users of this client can’t sign in any more." busy={step.busy} onConfirm={() => act({ method: 'remove_client', aud: c.aud })} />}
              </li>
            ))}
            {s.clients.length === 0 && <li className="muted">None of its own.</li>}
          </ul>
          <p>Shared login (Journear’s shared Google clients): {s.allowShared ? 'on' : 'off'}</p>
          {can && s.allowShared && s.clients.length > 0 && <ConfirmButton label="Turn shared login off" confirm="Turn it off at once (confirm with Google)" detail="Users of Journear’s shared clients can’t sign in to this scope any more." busy={step.busy} onConfirm={() => act({ method: 'disable_shared_login' })} />}
          {can && s.allowShared && s.clients.length === 0 && <Why>Shared login can’t be turned off while the scope has no Google client of its own: users would have no way to sign in.</Why>}
          {can && !s.allowShared && (
            <button type="button" className="jp-btn jp-btn-secondary" disabled={step.busy} onClick={() => act({ method: 'propose_change', change: { kind: 'SetAllowShared' } })}>
              Propose turning shared login on (confirm with Google)
            </button>
          )}
          {can && <AddClient org={org!} scopeId={s.id} start={step.start} busy={step.busy} />}
        </Panel>
        <Panel title="Pending on-chain changes">
          {s.pending.length === 0 ? (
            <p className="muted">None.</p>
          ) : (
            <div className="jp-table-wrap">
            <table className="jp-table">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Change</th>
                  <th scope="col">Unlocks</th>
                  {owner && (
                    <th scope="col">
                      <span className="visually-hidden">Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {s.pending.map((p) => (
                  <tr key={p.id}>
                    <td>{p.id}</td>
                    <td>{changeText(p.change)}</td>
                    <td>
                      {when(p.unlockAt)}
                      <div className="muted small">{p.executable ? 'Unlocked: any owner can execute it' : relative(p.unlockAt, now)}</div>
                    </td>
                    {owner && (
                      <td className="cell-actions">
                        {can && <ConfirmButton label="Cancel" confirm="Cancel it (confirm with Google)" busy={step.busy} onConfirm={() => act({ method: 'cancel_change', changeId: p.id })} />}
                        {p.executable && (
                          <button
                            type="button"
                            className="jp-btn jp-btn-primary jp-btn-sm"
                            disabled={w.busy}
                            onClick={() =>
                              void w.run(async () => {
                                const out = await postJson<{ nearTx?: string }>(`/api/orgs/${org}/scopes/${s.id}/execute`, { changeId: p.id });
                                r.reload();
                                return `Executed${out.nearTx ? ` (NEAR transaction ${out.nearTx})` : ''}.`;
                              })
                            }
                          >
                            Execute
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </Panel>
        {can && <StepUpHint email={ctx?.email} />}
        <WriteNote error={step.error ?? w.error} />
      </div>
    </>
  );
}
