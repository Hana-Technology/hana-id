// An org's apps (`GET /api/orgs/:org/apps`) and one app (`/apps/:app`, `GET /api/orgs/:org/apps/:app`): the app's
// header (name, environment, status, the copyable App ID and publishable key) over its sections, each its own route:
// the overview with the getting-started checklist, origins, keys, login and sessions, signing, branding and suspend
// (pages/app/*). Owners get the write controls (batch C10): what the spec marks "fresh sign-in" (origin adds, the
// policy, raw signing on, settings, resume) goes through an action reviewed on `/actions/:id` and confirmed with
// Google; the immediate ones (removing an origin, turning the policy or raw signing off, cancelling a pending change,
// suspending, keys, the name and the logo) are a second click. A frozen org shows only the cancels and the kill
// switches; where a control isn't offered, one line says why.
import type { AppDetail, AppSummary, MembersAnswer } from '@hana-id/console-core';
import { useEffect } from 'react';
import { Link, NavLink, Outlet, useOutletContext, useParams } from 'react-router-dom';
import { type OrgContext, useApi, useOrg } from '../lib.tsx';
import { Badge, CopyField, Empty, ErrorNote, Loading, PageHeader, Why } from '../ui.tsx';
import { isWaiting } from './app/Changes.tsx';

const SUSPENDED = [
  [1, 'by Hana'],
  [2, 'with the organisation'],
  [4, 'by your organisation'],
] as const;

export function suspension(bits: number): string | null {
  const why = SUSPENDED.filter(([b]) => (bits & b) !== 0).map(([, w]) => w);
  return why.length ? `Suspended ${why.join(', ')}` : null;
}

export const envLabel = (e: 'test' | 'live'): string => (e === 'live' ? 'Live' : 'Test');

/** The app's square: its logo, or its initial. */
export function AppTile({ name, logoUrl, size = 'md' }: { name: string; logoUrl?: string | undefined; size?: 'md' | 'lg' }) {
  if (logoUrl) return <img className={`app-tile app-tile-${size}`} src={logoUrl} alt="" width={size === 'lg' ? 48 : 36} height={size === 'lg' ? 48 : 36} />;
  return (
    <span className={`app-tile app-tile-${size} app-tile-initial`} aria-hidden="true">
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
  );
}

function Status({ a }: { a: AppSummary }) {
  if (a.deleted) return <Badge tone="neutral">Deleted</Badge>;
  const s = suspension(a.suspendedBy);
  return s ? <Badge tone="danger">{s}</Badge> : <Badge tone="ok">Active</Badge>;
}

/** What a new organisation does first: Hana creates apps during the pilot, so the steps say what to send. */
function FirstApp() {
  return (
    <Empty title="No apps yet">
      <p>During the pilot, Hana creates your apps. Send Hana these three things and your app appears here with its publishable key:</p>
      <ol className="steps">
        <li>
          <strong>The app’s name</strong>, as your users will see it when they sign in.
        </li>
        <li>
          <strong>Every origin your app runs on</strong>, exactly (<code>https://app.example.com</code>, no path). For development on a test app, add <code>http://localhost:5173</code> (your port).
        </li>
        <li>
          <strong>Which Google client to use</strong>: Hana’s shared one (nothing to set up) or your own (partner guide, section 6).
        </li>
      </ol>
      <p className="muted">Then you install the SDK, create the client with your key and add a sign-in button. The app’s page walks you through it.</p>
    </Empty>
  );
}

export function AppsList() {
  const { org } = useParams();
  const apps = useApi<{ apps: AppSummary[] }>(`/api/orgs/${org}/apps`);
  return (
    <>
      <PageHeader title="Apps" description="Each app has its own origins, keys and settings. Users get the same wallet in every app that shares a scope." />
      {apps.error && <ErrorNote error={apps.error} onRetry={apps.reload} />}
      {!apps.data && !apps.error && <Loading />}
      {apps.data && apps.data.apps.length === 0 && (
        <FirstApp />
      )}
      {apps.data && apps.data.apps.length > 0 && (
        <ul className="app-list">
          {apps.data.apps.map((a) => (
            <li key={a.id}>
              <Link to={`/orgs/${org}/apps/${a.id}`} className="app-row">
                <AppTile name={a.name} logoUrl={a.logoUrl} />
                <span className="app-row-main">
                  <span className="app-row-name">{a.name}</span>
                  <span className="app-row-id mono">{a.id}</span>
                </span>
                <span className="app-row-meta">
                  <Badge tone={a.environment === 'live' ? 'accent' : 'neutral'}>{envLabel(a.environment)}</Badge>
                  <Status a={a} />
                </span>
                <span className="app-row-num">
                  {a.activeOrigins} {a.activeOrigins === 1 ? 'origin' : 'origins'}
                </span>
                <span className="app-row-num">{a.pendingChanges > 0 ? <Badge tone="warn">{a.pendingChanges} waiting</Badge> : <span className="muted">No changes waiting</span>}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** What an app's sections know: the org context, the app, who may write, and member names for "requested by". */
export interface AppCtl extends OrgContext {
  app: AppDetail;
  owner: boolean;
  reload: () => void;
  /** A member's address by user id (for "requested by"), or undefined. */
  nameOf: (userId: string) => string | undefined;
}

export const useApp = (): AppCtl => useOutletContext<AppCtl>();

const SECTIONS = [
  ['', 'Overview'],
  ['origins', 'Origins'],
  ['keys', 'Keys'],
  ['sessions', 'Login & sessions'],
  ['email', 'Email login'],
  ['signing', 'Signing'],
  ['branding', 'Branding'],
  ['suspend', 'Suspend'],
] as const;

/** The next time after `now` that one of the app's waiting changes or origins takes effect, or null. */
export function nextEffectAt(a: AppDetail, now: number): number | null {
  const times = [...a.changes.filter((c) => c.status === 'pending').map((c) => c.activeFrom), ...a.origins.map((o) => o.activeFrom)].filter((t): t is number => typeof t === 'number' && t > now);
  return times.length ? Math.min(...times) : null;
}

/** setTimeout's longest wait (about 24.8 days); a later time is waited for in steps (the delays are at most 7 days). */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * While the page is open, one timer to the next time something of the app takes effect, then one re-read of the app
 * (1 s after, so the server's clock has passed it too). No polling: the re-read's answer sets the next timer, if any.
 */
export function useReloadAtNextEffect(a: AppDetail | undefined, reload: () => void): void {
  const at = a ? nextEffectAt(a, Date.now()) : null;
  useEffect(() => {
    if (at === null) return;
    const t = setTimeout(reload, Math.min(Math.max(at - Date.now(), 0) + 1_000, MAX_TIMEOUT_MS));
    return () => clearTimeout(t);
  }, [at, reload]);
}

export function AppLayout() {
  const { org, app } = useParams();
  const ctx = useOrg();
  const r = useApi<{ app: AppDetail }>(`/api/orgs/${org}/apps/${app}`);
  const m = useApi<MembersAnswer>(`/api/orgs/${org}/members`);
  useReloadAtNextEffect(r.data?.app, r.reload);
  const back = { to: `/orgs/${org}`, label: 'Apps' };
  if (r.error)
    return (
      <>
        <PageHeader title="App" back={back} />
        <ErrorNote error={r.error} onRetry={r.reload} />
      </>
    );
  if (!r.data) return <Loading />;
  const a = r.data.app;
  const ctl: AppCtl = {
    ...ctx,
    app: a,
    owner: ctx?.role === 'owner' && !a.deleted,
    reload: r.reload,
    nameOf: (id) => m.data?.members.find((x) => x.userId === id)?.email,
  };
  const base = `/orgs/${org}/apps/${a.id}`;
  const key = a.keys.filter((k) => k.revokedAt === undefined).sort((x, y) => y.createdAt - x.createdAt)[0];
  const now = Date.now();
  const waiting = a.changes.filter((c) => isWaiting(c, now));
  return (
    <>
      <PageHeader
        back={back}
        title={
          <span className="app-title">
            <AppTile name={a.name} logoUrl={a.logoUrl} size="lg" />
            <span>{a.name}</span>
          </span>
        }
        actions={
          <span className="badges">
            <Badge tone={a.environment === 'live' ? 'accent' : 'neutral'} title={a.environment === 'live' ? 'Live: mainnet chains allowed' : 'Test: test networks only'}>
              {envLabel(a.environment)}
            </Badge>
            <Status a={a} />
          </span>
        }
      >
        <div className="id-row">
          <CopyField label="App ID" value={a.id} />
          {key ? <CopyField label="Publishable key" value={key.key} /> : <Why>This app has no active publishable key: {ctl.owner && !ctl.frozen ? 'create one under Keys.' : 'an owner can create one under Keys.'}</Why>}
        </div>
      </PageHeader>
      {a.deleted && <Why>This app was deleted. Its setup stays readable; nothing can be changed.</Why>}
      {!a.deleted && ctx?.role !== 'owner' && <Why>You’re a viewer: you can see this app’s setup, and only owners can change it.</Why>}
      <nav className="tabs" aria-label="App sections">
        {SECTIONS.map(([path, label]) => (
          <NavLink key={path} to={path ? `${base}/${path}` : base} end={!path}>
            {label}
            {path === 'origins' && waiting.some((c) => c.kind === 'origin_add') && <span className="tab-dot" aria-label="(changes waiting)" />}
            {path === 'signing' && waiting.some((c) => c.kind !== 'origin_add') && <span className="tab-dot" aria-label="(changes waiting)" />}
          </NavLink>
        ))}
      </nav>
      <Outlet context={ctl} />
    </>
  );
}
