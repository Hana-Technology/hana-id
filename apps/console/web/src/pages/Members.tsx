// An org's members, open invites and pending owner grants (`GET /api/orgs/:org/members`). Owners (batch C10, D89):
// invite a viewer or an owner, change a role, remove a member and require a Workspace domain, each a fresh sign-in;
// revoke an open invite and cancel a pending owner grant at once (cancels work in a frozen org too). Controls the
// console would refuse aren't offered (the last owner's demotion or removal, promoting a disabled member, an 11th
// invite); one line says why. The invite's address is checked once the field is left; its role is a choice card (an
// owner can change everything); the Workspace domain is a setting row with the save bar.
import type { MembersAnswer, OrgAnswer } from '@hana-id/console-core';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { postJson } from '../api.ts';
import { relative, useApi, useOrg, useStepUp, useTouched, useWrite, when } from '../lib.tsx';
import { type Choice, ChoiceCards, Badge, ConfirmButton, Empty, ErrorNote, Field, Loading, PageHeader, Panel, SaveBar, SettingRow, StepUpHint, Why, WriteNote } from '../ui.tsx';

const MAX_OPEN_INVITES = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

const ROLES: readonly Choice<'viewer' | 'owner'>[] = [
  { value: 'viewer', title: 'Viewer', detail: 'Sees everything here and changes nothing.' },
  { value: 'owner', title: 'Owner', detail: 'Changes apps, keys and members. A viewer for the first 24 hours; any owner can cancel that.' },
];

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
  const touched = useTouched<'email'>();
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
  const savedHd = o.data?.org.requiredHd ?? '';
  const hdNow = hd ?? savedHd;
  const hdChanged = hdNow.trim() !== savedHd;
  const full = invites.length >= MAX_OPEN_INVITES;
  return (
    <>
      {head}
      <div className="stack">
        <Panel title="People">
          {!owner && <Why>You’re a viewer: only owners can invite people or change roles.</Why>}
          {owner && ctx?.frozen && <Why>Role changes and invites are paused while Journear has frozen the organisation. Revoking an invite or cancelling a new owner still works.</Why>}
          <div className="jp-table-wrap">
          <table className="jp-table">
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
                      {ctx?.email === m.email && (
                        <>
                          {' '}
                          <Badge>You</Badge>
                        </>
                      )}
                      {m.disabled && (
                        <>
                          {' '}
                          <Badge tone="warn">disabled</Badge>
                        </>
                      )}
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
                          <span className="muted small">Disabled by Journear</span>
                        ) : last ? (
                          <span className="muted small">The last owner: make someone else an owner first</span>
                        ) : (
                          <>
                            {m.role === 'viewer' && m.pendingOwnerFrom === undefined && (
                              <button type="button" className="jp-btn jp-btn-secondary jp-btn-sm" disabled={step.busy} onClick={() => void step.start('member.role', { userId: m.userId, role: 'owner' })}>
                                Make owner
                              </button>
                            )}
                            {m.role === 'owner' && (
                              <button type="button" className="jp-btn jp-btn-secondary jp-btn-sm" disabled={step.busy} onClick={() => void step.start('member.role', { userId: m.userId, role: 'viewer' })}>
                                Make viewer
                              </button>
                            )}
                          </>
                        )}
                        {!last && (
                          <button type="button" className="jp-btn jp-btn-ghost jp-btn-sm" disabled={step.busy} onClick={() => void step.start('member.remove', { userId: m.userId })}>
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
          </div>
          {writes && <StepUpHint email={ctx?.email} />}
          <WriteNote error={step.error} />
        </Panel>

        <Panel title="Open invites" description="An invite link works once, for the address it was sent to, and expires after 7 days. It works only after Journear has emailed every owner about it.">
          {invites.length === 0 ? (
            <p className="muted">No open invites.</p>
          ) : (
            <div className="jp-table-wrap">
            <table className="jp-table">
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
                    <td>{i.createdBy === 'hana' ? 'Journear' : (members.find((m) => m.userId === i.createdBy)?.email ?? 'a member')}</td>
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
            </div>
          )}
          {writes &&
            (full ? (
              <Why>The organisation has {MAX_OPEN_INVITES} open invites, the most it can have: revoke one to invite someone else.</Why>
            ) : (
              <form
                className="form editor"
                onSubmit={(e) => {
                  e.preventDefault();
                  touched.all();
                  if (emailOk) void step.start('member.invite', { email: email.trim(), role });
                }}
              >
                <h3>Invite someone</h3>
                <Field label="Google account email" hint="The invite works for this address only." error={touched.seen('email') && !emailOk ? 'Enter an email address, like name@company.com.' : undefined}>
                  {(c) => <input {...c} className="jp-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} onBlur={touched.blur('email')} placeholder="name@company.com" autoComplete="off" />}
                </Field>
                <ChoiceCards legend="Role" name="invite-role" value={role} options={ROLES} onChange={setRole} />
                <div className="form-actions">
                  <button type="submit" className="jp-btn jp-btn-primary" disabled={step.busy || !emailOk}>
                    Review and confirm with Google
                  </button>
                </div>
              </form>
            ))}
        </Panel>

        {grants.length > 0 && (
          <Panel title="Pending owners" description="A new owner of an organisation that has one is a viewer for 24 hours first, and any owner can cancel that.">
            <div className="jp-table-wrap">
            <table className="jp-table">
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
                    <td>{g.grantedByKind === 'hana' ? 'Journear' : 'an owner'}</td>
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
            </div>
          </Panel>
        )}
        <WriteNote error={w.error} />

        {o.data && (
          <Panel title="Google Workspace domain" description={o.data.org.requiredHd ? `Only Google accounts of ${o.data.org.requiredHd} can use this organisation.` : 'Any Google account a member was invited with can sign in.'}>
            {writes ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (hdChanged) void step.start('org.policy', { requiredHd: hdNow.trim() || null });
                }}
              >
                <div className="setting-list inset">
                  <SettingRow title="Required domain" optional description="Empty for none. It must be your own sign-in’s domain, so you don’t lock yourself out.">
                    {(c) => <input {...c} className="jp-input wide" value={hdNow} onChange={(e) => setHd(e.target.value)} placeholder="company.com" />}
                  </SettingRow>
                </div>
                <SaveBar count={hdChanged ? 1 : 0} busy={step.busy} saveLabel="Review and confirm with Google" note="Next you review the change, then confirm it with Google." onDiscard={() => setHd(null)} />
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
