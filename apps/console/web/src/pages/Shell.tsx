// The signed-in frame: a sidebar with the organisation (a switcher when the member has several), the org's sections
// and the member's account (sign out); a fresh sign-in's action page gets the same frame without the sections. `/`
// lists the member's organisations (straight to the only one). Inside an org the pages get the member's role and
// whether the org is frozen (the outlet context), and show the write controls an owner has (batch C10). The usage,
// statements and pending-upgrades sections are reads for any member, frozen orgs included (D370).
import type { MeAnswer, OrgAnswer } from '@hana-id/console-core';
import { type ReactNode, useEffect } from 'react';
import { Link, NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import { postJson } from '../api.ts';
import { type OrgContext, useApi } from '../lib.tsx';
import { SessionBanner } from '../session.tsx';
import { Badge, Callout, Empty, ErrorNote, Loading, Mark } from '../ui.tsx';

function SkipLink() {
  return (
    <a className="skip" href="#main">
      Skip to content
    </a>
  );
}

function Account({ me }: { me: MeAnswer | undefined }) {
  const navigate = useNavigate();
  const signOut = async () => {
    try {
      await postJson('/api/auth/logout', {});
    } finally {
      navigate('/signin', { replace: true });
    }
  };
  if (!me) return null;
  return (
    <div className="account">
      <span className="account-email" title={me.user.email}>
        {me.user.email}
      </span>
      <button type="button" className="btn btn-quiet btn-small" onClick={() => void signOut()}>
        Sign out
      </button>
    </div>
  );
}

function Brand() {
  return (
    <Link to="/" className="brand">
      <Mark />
      <span>
        Hana ID <span className="brand-sub">console</span>
      </span>
    </Link>
  );
}

/** The org switcher: a plain select of the member's organisations (shown only when there is more than one). */
function OrgSwitcher({ me, org, name }: { me: MeAnswer | undefined; org: string; name: string | undefined }) {
  const navigate = useNavigate();
  const many = (me?.memberships.length ?? 0) > 1;
  if (!many) return <p className="org-name">{name ?? ' '}</p>;
  return (
    <div className="org-switch">
      <select aria-label="Organisation" value={org} onChange={(e) => navigate(`/orgs/${e.target.value}`)}>
        {me!.memberships.map((m) => (
          <option key={m.orgId} value={m.orgId}>
            {m.orgName}
            {m.status === 'frozen' ? ' (frozen)' : ''}
          </option>
        ))}
      </select>
    </div>
  );
}

function Layout({ me, side, children }: { me: MeAnswer | undefined; side?: ReactNode; children: ReactNode }) {
  return (
    <div className="frame">
      <SkipLink />
      <aside className="sidebar">
        <Brand />
        {side}
        <Account me={me} />
      </aside>
      <main id="main" className="content" tabIndex={-1}>
        <SessionBanner />
        {children}
      </main>
    </div>
  );
}

/** A signed-in page outside an org (a fresh sign-in's action page). */
export function Framed({ children }: { children: (me: MeAnswer | undefined) => ReactNode }) {
  const me = useApi<MeAnswer>('/api/me');
  return <Layout me={me.data}>{children(me.data)}</Layout>;
}

export function Home() {
  const me = useApi<MeAnswer>('/api/me');
  const navigate = useNavigate();
  const only = me.data?.memberships.length === 1 ? me.data.memberships[0] : undefined;
  useEffect(() => {
    if (only) navigate(`/orgs/${only.orgId}`, { replace: true });
  }, [only, navigate]);
  return (
    <Layout me={me.data}>
      {me.error && <ErrorNote error={me.error} onRetry={me.reload} />}
      {!me.data && !me.error && <Loading />}
      {me.data && me.data.memberships.length === 0 && (
        <Empty title="You aren’t a member of an organisation any more">
          <p>An owner removed you, or your organisation requires a Google Workspace domain this account isn’t in. Ask an owner of your organisation for a new invite, then open the link in its email.</p>
        </Empty>
      )}
      {me.data && me.data.memberships.length > 1 && (
        <>
          <header className="page-head">
            <h1>Your organisations</h1>
            <p className="lede">Pick the organisation to work in. You can switch at any time from the top of the sidebar.</p>
          </header>
          <ul className="org-list">
            {me.data.memberships.map((m) => (
              <li key={m.orgId}>
                <Link to={`/orgs/${m.orgId}`} className="org-card">
                  <span className="org-card-name">{m.orgName}</span>
                  <span className="org-card-meta">
                    <Badge tone={m.role === 'owner' ? 'accent' : 'neutral'}>{m.role === 'owner' ? 'Owner' : 'Viewer'}</Badge>
                    {m.status === 'frozen' && <Badge tone="danger">Frozen</Badge>}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </Layout>
  );
}

export function OrgShell() {
  const { org } = useParams();
  const me = useApi<MeAnswer>('/api/me');
  const o = useApi<OrgAnswer>(`/api/orgs/${org}`);
  const base = `/orgs/${org}`;
  const nav = (
    <>
      <OrgSwitcher me={me.data} org={org!} name={o.data?.org.name} />
      {o.data && (
        <p className="org-role">
          {o.data.role === 'owner' ? 'You’re an owner' : 'You’re a viewer'}
          {o.data.org.requiredHd ? ` · ${o.data.org.requiredHd} accounts only` : ''}
        </p>
      )}
      <nav className="side-nav" aria-label="Main">
        <NavLink to={base} end>
          Apps
        </NavLink>
        <NavLink to={`${base}/members`}>Members</NavLink>
        {me.data?.features?.users === true && <NavLink to={`${base}/users`}>Users</NavLink>}
        <span className="side-nav-group">Billing and reports</span>
        <NavLink to={`${base}/usage`}>Usage</NavLink>
        <NavLink to={`${base}/statements`}>Statements</NavLink>
        <span className="side-nav-group">Security</span>
        <NavLink to={`${base}/upgrades`}>Pending upgrades</NavLink>
        <NavLink to={`${base}/audit`}>Audit</NavLink>
      </nav>
    </>
  );
  return (
    <Layout me={me.data} side={nav}>
      {o.error && <ErrorNote error={o.error} onRetry={o.reload} />}
      {!o.data && !o.error && <Loading />}
      {o.data && (
        <>
          {o.data.org.status === 'frozen' && (
            <Callout tone="danger" title="This organisation is frozen" className="frozen-note">
              <p>Hana has frozen this organisation: only cancels and kill switches (removing an origin, turning the policy or raw signing off, suspending, revoking a key) work until it is unfrozen. Everything stays readable. Contact Hana to find out why.</p>
            </Callout>
          )}
          <Outlet context={{ org: org!, role: o.data.role, frozen: o.data.org.status === 'frozen', email: me.data?.user.email } satisfies OrgContext} />
        </>
      )}
    </Layout>
  );
}
