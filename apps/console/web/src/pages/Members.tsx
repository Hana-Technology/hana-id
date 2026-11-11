// An org's members, open invites and pending owner grants (`GET /api/orgs/:org/members`). Owners (batch C10, D89):
// invite a viewer or an owner, change a role, remove a member and require a Workspace domain, each a fresh sign-in;
// revoke an open invite and cancel a pending owner grant at once (cancels work in a frozen org too). Controls the
// console would refuse aren't offered (the last owner's demotion or removal, promoting a disabled member, an 11th
// invite); one line says why.
import type { MembersAnswer, OrgAnswer } from '@hana-id/console-core';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { postJson } from '../api.ts';
import { relative, useApi, useOrg, useStepUp, useWrite, when } from '../lib.tsx';
import { Badge, ConfirmButton, Empty, ErrorNote, Loading, PageHeader, Panel, StepUpHint, Why, WriteNote } from '../ui.tsx';

const MAX_OPEN_INVITES = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export function Members() {
  const { org } = useParams();
  const ctx = useOrg();
  const r = useApi<MembersAnswer>(`/api/orgs/${org}/members`);
  const o = useApi<OrgAnswer>(`/api/orgs/${org}`);
  const w = useWrite();
  const step = useStepUp(org!, { page: 'members' });
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'viewer' | 'owner'>('viewer');
  const [hd, setHd] = useState<string | null>(null);
  const head = <PageHeader title="Members" description="Owners can change apps, keys and members. Viewers can see everything here but change nothing. Everyone signs in with Google." />;
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
        <Loading />
      </>
    );
  const { members, invites, grants } = r.data;
  const owner = ctx?.role === 'owner';
  const writes = owner && !ctx?.frozen;
  const now = Date.now();
  const usableOwners = members.filter((m) => m.role === 'owner' && !m.disabled).length;
  const cancel = (path: string, msg: string) =>
    void w.run(async () => {
      await postJson(path, {});
      r.reload();
      return msg;
    });
  const emailOk = EMAIL_RE.test(email.trim());
  const full = invites.length >= MAX_OPEN_INVITES;
  return (
    <>
      {head}
      <div className="stack">
        <Panel title="People">
          {!owner && <Why>You’re a viewer: only owners can invite people or change roles.</Why>}
          {owner && ctx?.frozen && <Why>Role changes and invites are paused while Hana has frozen the organisation. Revoking an invite or cancelling a new owner still works.</Why>}
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Member</th>
                <th scope="col">Role</th>
                <th scope="col">Since</th>
                {writes && (
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {members.map((m) => {
                const last = m.role === 'owner' && !m.disabled && usableOwners <= 1;
                return (
                  <tr key={m.userId}>
                    <td>
                      {m.email}
                      {ctx?.email === m.email && <span className="badge badge-neutral">You</span>}
                      {m.disabled && <span className="badge badge-warn">disabled</span>}
                    </td>
                    <td>
                      <Badge tone={m.role === 'owner' ? 'accent' : 'neutral'}>{m.role === 'owner' ? 'Owner' : 'Viewer'}</Badge>
                      {m.pendingOwnerFrom !== undefined && (
                        <div className="muted small">
                          owner from {when(m.pendingOwnerFrom)} ({relative(m.pendingOwnerFrom, now)})
                        </div>
                      )}
                    </td>
                    <td>{when(m.roleSince)}</td>
                    {writes && (
                      <td className="cell-actions">
                        {m.disabled ? (
                          <span className="muted small">Disabled by Hana</span>
                        ) : last ? (
                          <span className="muted small">The last owner: make someone else an owner first</span>
                        ) : (
                          <>
                            {m.role === 'viewer' && m.pendingOwnerFrom === undefined && (
                              <button type="button" className="btn btn-small" disabled={step.busy} onClick={() => void step.start('member.role', { userId: m.userId, role: 'owner' })}>
                                Make owner
                              </button>
                            )}
                            {m.role === 'owner' && (
                              <button type="button" className="btn btn-small" disabled={step.busy} onClick={() => void step.start('member.role', { userId: m.userId, role: 'viewer' })}>
                                Make viewer
                              </button>
                            )}
                          </>
                        )}
                        {!last && (
                          <button type="button" className="btn btn-small btn-quiet" disabled={step.busy} onClick={() => void step.start('member.remove', { userId: m.userId })}>
                            Remove
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {writes && <StepUpHint email={ctx?.email} />}
          <WriteNote error={step.error} />
        </Panel>

        <Panel title="Open invites" description="An invite link works once, for the address it was sent to, and expires after 7 days. It works only after Hana has emailed every owner about it.">
          {invites.length === 0 ? (
            <p className="muted">No open invites.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Invitee</th>
                  <th scope="col">Role</th>
                  <th scope="col">Invited by</th>
                  <th scope="col">Expires</th>
                  {owner && (
                    <th scope="col">
                      <span className="visually-hidden">Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {invites.map((i) => (
                  <tr key={i.id}>
                    <td>
                      {i.email}
                      {!i.notified && <div className="muted small">Not announced yet: the link doesn’t work yet</div>}
                    </td>
                    <td>{i.role === 'owner' ? 'Owner' : 'Viewer'}</td>
                    <td>{i.createdBy === 'hana' ? 'Hana' : (members.find((m) => m.userId === i.createdBy)?.email ?? 'a member')}</td>
                    <td>{when(i.expiresAt)}</td>
                    {owner && (
                      <td className="cell-actions">
                        <ConfirmButton label="Revoke" confirm="Revoke the invite" detail="The link stops working at once." busy={w.busy} onConfirm={() => cancel(`/api/orgs/${org}/invites/${i.id}/revoke`, 'Invite revoked.')} />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {writes &&
            (full ? (
              <Why>The organisation has {MAX_OPEN_INVITES} open invites, the most it can have: revoke one to invite someone else.</Why>
            ) : (
              <form
                className="form form-inline"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (emailOk) void step.start('member.invite', { email: email.trim(), role });
                }}
              >
                <label className="field">
                  <span className="field-label">Invite</span>
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" autoComplete="off" />
                </label>
                <label className="field">
                  <span className="field-label">as</span>
                  <select value={role} onChange={(e) => setRole(e.target.value as 'viewer' | 'owner')}>
                    <option value="viewer">viewer</option>
                    <option value="owner">owner (a viewer for 24 hours first)</option>
                  </select>
                </label>
                <button type="submit" className="btn btn-primary" disabled={step.busy || !emailOk}>
                  Review and confirm with Google
                </button>
              </form>
            ))}
        </Panel>

        {grants.length > 0 && (
          <Panel title="Pending owners" description="A new owner of an organisation that has one is a viewer for 24 hours first, and any owner can cancel that.">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Who</th>
                  <th scope="col">Granted by</th>
                  <th scope="col">Owner from</th>
                  {owner && (
                    <th scope="col">
                      <span className="visually-hidden">Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {grants.map((g) => (
                  <tr key={g.id}>
                    <td>{(g.userId && members.find((m) => m.userId === g.userId)?.email) ?? (g.inviteId && invites.find((i) => i.id === g.inviteId)?.email) ?? '—'}</td>
                    <td>{g.grantedByKind === 'hana' ? 'Hana' : 'an owner'}</td>
                    <td>{g.ownerFrom === undefined ? (g.notifiedAt === undefined ? 'after the notice is sent' : 'after the invite is accepted') : `${when(g.ownerFrom)} (${relative(g.ownerFrom, now)})`}</td>
                    {owner && (
                      <td className="cell-actions">
                        <ConfirmButton label="Cancel" confirm="Cancel (they stay a viewer)" busy={w.busy} onConfirm={() => cancel(`/api/orgs/${org}/owner-grants/${g.id}/cancel`, 'Owner grant cancelled.')} />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}
        <WriteNote error={w.error} done={w.done} />

        {o.data && (
          <Panel title="Google Workspace domain" description={o.data.org.requiredHd ? `Only Google accounts of ${o.data.org.requiredHd} can use this organisation.` : 'Any Google account a member was invited with can sign in.'}>
            {writes ? (
              <form
                className="form form-inline"
                onSubmit={(e) => {
                  e.preventDefault();
                  void step.start('org.policy', { requiredHd: (hd ?? '').trim() || null });
                }}
              >
                <label className="field">
                  <span className="field-label">Required domain</span>
                  <input value={hd ?? o.data.org.requiredHd ?? ''} onChange={(e) => setHd(e.target.value)} placeholder="company.com" />
                  <span className="field-hint">Empty for none. It must be your own sign-in’s domain, so you don’t lock yourself out.</span>
                </label>
                <button type="submit" className="btn" disabled={step.busy || (hd ?? o.data.org.requiredHd ?? '').trim() === (o.data.org.requiredHd ?? '')}>
                  Review and confirm with Google
                </button>
              </form>
            ) : (
              !owner && <Why>Only owners can change this.</Why>
            )}
          </Panel>
        )}
      </div>
      {members.length === 1 && invites.length === 0 && writes && (
        <Empty title="You’re the only member">
          <p>Invite a teammate above. Make a second owner so the organisation never depends on one Google account.</p>
        </Empty>
      )}
    </>
  );
}
