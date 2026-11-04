// An org's members, open invites and pending owner grants (`GET /api/orgs/:org/members`). Owners (batch C10, D89):
// invite a viewer or an owner, change a role, remove a member and require a Workspace domain, each a fresh sign-in;
// revoke an open invite and cancel a pending owner grant at once (cancels work in a frozen org too).
import type { MembersAnswer, OrgAnswer } from '@hana-id/console-core';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { postJson } from '../api.ts';
import { ConfirmButton, ErrorNote, Section, WriteNote, useApi, useOrg, useStepUp, useWrite, when } from '../lib.tsx';

export function Members() {
  const { org } = useParams();
  const ctx = useOrg();
  const r = useApi<MembersAnswer>(`/api/orgs/${org}/members`);
  const o = useApi<OrgAnswer>(`/api/orgs/${org}`);
  const w = useWrite();
  const step = useStepUp(org!);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'viewer' | 'owner'>('viewer');
  const [hd, setHd] = useState<string | null>(null);
  if (r.error) return <ErrorNote error={r.error} />;
  if (!r.data) return <p className="muted">Loading…</p>;
  const { members, invites, grants } = r.data;
  const owner = ctx?.role === 'owner';
  const writes = owner && !ctx?.frozen;
  const cancel = (path: string, msg: string) =>
    void w.run(async () => {
      await postJson(path, {});
      r.reload();
      return msg;
    });
  return (
    <>
      <Section title="Members">
        <table>
          <thead>
            <tr>
              <th>Member</th>
              <th>Role</th>
              <th>Since</th>
              {writes && <th />}
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.userId}>
                <td>
                  {m.email}
                  {m.disabled && <span className="badge badge-warn">disabled</span>}
                </td>
                <td>
                  {m.role}
                  {m.pendingOwnerFrom !== undefined && <div className="muted">owner from {when(m.pendingOwnerFrom)}</div>}
                </td>
                <td>{when(m.roleSince)}</td>
                {writes && (
                  <td>
                    {m.role === 'viewer' && m.pendingOwnerFrom === undefined && (
                      <button type="button" disabled={step.busy} onClick={() => void step.start('member.role', { userId: m.userId, role: 'owner' })}>
                        Make owner
                      </button>
                    )}
                    {m.role === 'owner' && (
                      <button type="button" disabled={step.busy} onClick={() => void step.start('member.role', { userId: m.userId, role: 'viewer' })}>
                        Make viewer
                      </button>
                    )}
                    <button type="button" disabled={step.busy} onClick={() => void step.start('member.remove', { userId: m.userId })}>
                      Remove
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        <WriteNote error={step.error} />
      </Section>
      <Section title="Open invites">
        {invites.length === 0 ? (
          <p className="muted">None.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Invitee</th>
                <th>Role</th>
                <th>Invited by</th>
                <th>Expires</th>
                {owner && <th />}
              </tr>
            </thead>
            <tbody>
              {invites.map((i) => (
                <tr key={i.id}>
                  <td>
                    {i.email}
                    {!i.notified && <div className="muted">notice not sent yet: the link doesn’t work yet</div>}
                  </td>
                  <td>{i.role}</td>
                  <td>{i.createdBy === 'hana' ? 'Hana' : (members.find((m) => m.userId === i.createdBy)?.email ?? 'a member')}</td>
                  <td>{when(i.expiresAt)}</td>
                  {owner && (
                    <td>
                      <ConfirmButton label="Revoke" confirm="Revoke the invite" busy={w.busy} onConfirm={() => cancel(`/api/orgs/${org}/invites/${i.id}/revoke`, 'Invite revoked.')} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {writes && (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              void step.start('member.invite', { email, role });
            }}
          >
            <label>
              Invite <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />
            </label>
            <label>
              as{' '}
              <select value={role} onChange={(e) => setRole(e.target.value as 'viewer' | 'owner')}>
                <option value="viewer">viewer</option>
                <option value="owner">owner (a viewer for 24 hours first)</option>
              </select>
            </label>
            <button type="submit" disabled={step.busy || !email.includes('@')}>
              Review and confirm with Google
            </button>
          </form>
        )}
      </Section>
      {grants.length > 0 && (
        <Section title="Pending owners">
          <p className="muted">A new owner of an organisation that has one is a viewer for 24 hours first, and any owner can cancel that.</p>
          <table>
            <thead>
              <tr>
                <th>Who</th>
                <th>Granted by</th>
                <th>Owner from</th>
                {owner && <th />}
              </tr>
            </thead>
            <tbody>
              {grants.map((g) => (
                <tr key={g.id}>
                  <td>{(g.userId && members.find((m) => m.userId === g.userId)?.email) ?? (g.inviteId && invites.find((i) => i.id === g.inviteId)?.email) ?? '—'}</td>
                  <td>{g.grantedByKind === 'hana' ? 'Hana' : 'an owner'}</td>
                  <td>{g.ownerFrom === undefined ? (g.notifiedAt === undefined ? 'after the notice is sent' : 'after the invite is accepted') : when(g.ownerFrom)}</td>
                  {owner && (
                    <td>
                      <ConfirmButton label="Cancel" confirm="Cancel (they stay a viewer)" busy={w.busy} onConfirm={() => cancel(`/api/orgs/${org}/owner-grants/${g.id}/cancel`, 'Owner grant cancelled.')} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
      <WriteNote error={w.error} done={w.done} />
      {writes && o.data && (
        <Section title="Google Workspace domain">
          <p className="muted">{o.data.org.requiredHd ? `Only Google accounts of ${o.data.org.requiredHd} can use this organisation.` : 'Any Google account a member was invited with can sign in.'}</p>
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              void step.start('org.policy', { requiredHd: (hd ?? '').trim() || null });
            }}
          >
            <label>
              Required domain (empty for none; must be your own sign-in’s) <input value={hd ?? o.data.org.requiredHd ?? ''} onChange={(e) => setHd(e.target.value)} placeholder="company.com" />
            </label>
            <button type="submit" disabled={step.busy}>
              Review and confirm with Google
            </button>
          </form>
        </Section>
      )}
    </>
  );
}
