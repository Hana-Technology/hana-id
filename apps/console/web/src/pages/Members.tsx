// An org's members, open invites and pending owner grants (`GET /api/orgs/:org/members`). Read-only.
import type { MembersAnswer } from '@hana-id/console-core';
import { useParams } from 'react-router-dom';
import { ErrorNote, Section, useApi, when } from '../lib.tsx';

export function Members() {
  const { org } = useParams();
  const r = useApi<MembersAnswer>(`/api/orgs/${org}/members`);
  if (r.error) return <ErrorNote error={r.error} />;
  if (!r.data) return <p className="muted">Loading…</p>;
  const { members, invites, grants } = r.data;
  return (
    <>
      <Section title="Members">
        <table>
          <thead>
            <tr>
              <th>Member</th>
              <th>Role</th>
              <th>Since</th>
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
              </tr>
            ))}
          </tbody>
        </table>
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
                </tr>
              ))}
            </tbody>
          </table>
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
              </tr>
            </thead>
            <tbody>
              {grants.map((g) => (
                <tr key={g.id}>
                  <td>{(g.userId && members.find((m) => m.userId === g.userId)?.email) ?? (g.inviteId && invites.find((i) => i.id === g.inviteId)?.email) ?? '—'}</td>
                  <td>{g.grantedByKind === 'hana' ? 'Hana' : 'an owner'}</td>
                  <td>{g.ownerFrom === undefined ? (g.notifiedAt === undefined ? 'after the notice is sent' : 'after the invite is accepted') : when(g.ownerFrom)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
    </>
  );
}
