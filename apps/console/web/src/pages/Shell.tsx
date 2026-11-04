// The signed-in frame: the header (the member's address, the org switcher, sign out) and, inside an org, its tabs.
// `/` lists the member's organisations (straight to the only one). Inside an org the pages get the member's role and
// whether the org is frozen (the outlet context), and show the write controls an owner has (batch C10). The usage,
// statements and pending-upgrades tabs are reads for any member, frozen orgs included (D370).
import type { MeAnswer, OrgAnswer } from '@hana-id/console-core';
import { type ReactNode, useEffect } from 'react';
import { Link, NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import { postJson } from '../api.ts';
import { ErrorNote, type OrgContext, useApi } from '../lib.tsx';

/** A signed-in page outside an org (a fresh sign-in's action page). */
export function Framed({ children }: { children: ReactNode }) {
  const me = useApi<MeAnswer>('/api/me');
  return (
    <>
      <Header me={me.data} />
      {children}
    </>
  );
}

export function Header({ me }: { me: MeAnswer | undefined }) {
  const navigate = useNavigate();
  const signOut = async () => {
    try {
      await postJson('/api/auth/logout', {});
    } finally {
      navigate('/signin', { replace: true });
    }
  };
  return (
    <header className="topbar">
      <Link to="/" className="brand">
        Hana ID console
      </Link>
      {me && (
        <div className="who">
          <span>{me.user.email}</span>
          <button type="button" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      )}
    </header>
  );
}

export function Home() {
  const me = useApi<MeAnswer>('/api/me');
  const navigate = useNavigate();
  const only = me.data?.memberships.length === 1 ? me.data.memberships[0] : undefined;
  useEffect(() => {
    if (only) navigate(`/orgs/${only.orgId}`, { replace: true });
  }, [only, navigate]);
  return (
    <>
      <Header me={me.data} />
      <main>
        {me.error && <ErrorNote error={me.error} />}
        {me.data && me.data.memberships.length === 0 && <p className="note">You aren’t a member of an organisation any more. Ask an owner for an invite.</p>}
        {me.data && me.data.memberships.length > 1 && (
          <>
            <h1>Your organisations</h1>
            <ul className="cards">
              {me.data.memberships.map((m) => (
                <li key={m.orgId}>
                  <Link to={`/orgs/${m.orgId}`}>{m.orgName}</Link>
                  <span className="muted">
                    {m.role}
                    {m.status === 'frozen' ? ' · frozen' : ''}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </main>
    </>
  );
}

export function OrgShell() {
  const { org } = useParams();
  const me = useApi<MeAnswer>('/api/me');
  const o = useApi<OrgAnswer>(`/api/orgs/${org}`);
  return (
    <>
      <Header me={me.data} />
      <main>
        {o.error && <ErrorNote error={o.error} />}
        {o.data && (
          <>
            <div className="org-head">
              <h1>{o.data.org.name}</h1>
              <span className="badge">{o.data.role}</span>
              {o.data.org.requiredHd && <span className="muted">Google Workspace: {o.data.org.requiredHd}</span>}
            </div>
            {o.data.org.status === 'frozen' && <p className="note note-warn">Hana has frozen this organisation: only cancels and kill switches (removing an origin, turning the policy or raw signing off, suspending, revoking a key) work until it is unfrozen.</p>}
            <nav className="tabs">
              <NavLink to={`/orgs/${org}`} end>
                Apps
              </NavLink>
              <NavLink to={`/orgs/${org}/members`}>Members</NavLink>
              <NavLink to={`/orgs/${org}/usage`}>Usage</NavLink>
              <NavLink to={`/orgs/${org}/statements`}>Statements</NavLink>
              <NavLink to={`/orgs/${org}/upgrades`}>Pending upgrades</NavLink>
              {me.data?.features?.users === true && <NavLink to={`/orgs/${org}/users`}>Users</NavLink>}
              <NavLink to={`/orgs/${org}/audit`}>Audit</NavLink>
            </nav>
            <Outlet context={{ org: org!, role: o.data.role, frozen: o.data.org.status === 'frozen' } satisfies OrgContext} />
          </>
        )}
      </main>
    </>
  );
}
