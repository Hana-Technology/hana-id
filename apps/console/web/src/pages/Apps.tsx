// An org's apps (`GET /api/orgs/:org/apps`) and one app (`/apps/:app`): origins (with the Unicode form and an IDN flag
// for punycode hosts), pending and active guarded changes, publishable keys, and settings. Read-only.
import type { AppDetail, AppSummary, GuardedChange } from '@hana-id/console-core';
import { Link, useParams } from 'react-router-dom';
import { ErrorNote, Section, duration, useApi, when } from '../lib.tsx';

const SUSPENDED = [
  [1, 'by Hana'],
  [2, 'with the organisation'],
  [4, 'by your organisation'],
] as const;

export function suspension(bits: number): string | null {
  const why = SUSPENDED.filter(([b]) => (bits & b) !== 0).map(([, w]) => w);
  return why.length ? `Suspended ${why.join(', ')}` : null;
}

export function AppsList() {
  const { org } = useParams();
  const apps = useApi<{ apps: AppSummary[] }>(`/api/orgs/${org}/apps`);
  if (apps.error) return <ErrorNote error={apps.error} />;
  if (!apps.data) return <p className="muted">Loading…</p>;
  if (apps.data.apps.length === 0) return <p className="note">No apps yet. Hana creates apps for your organisation.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>App</th>
          <th>Environment</th>
          <th>Status</th>
          <th>Origins</th>
          <th>Pending changes</th>
        </tr>
      </thead>
      <tbody>
        {apps.data.apps.map((a) => (
          <tr key={a.id}>
            <td>
              <Link to={`/orgs/${org}/apps/${a.id}`}>{a.name}</Link>
              <div className="muted mono">{a.id}</div>
            </td>
            <td>{a.environment}</td>
            <td>{a.deleted ? 'Deleted' : (suspension(a.suspendedBy) ?? 'Active')}</td>
            <td>{a.activeOrigins}</td>
            <td>{a.pendingChanges}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const CHANGE_LABEL: Record<GuardedChange['kind'], string> = { origin_add: 'Add origin', policy_set: 'Set auto-approve policy', raw_sign_on: 'Turn raw signing on' };

function changeWhat(c: GuardedChange): string {
  if (c.kind === 'origin_add') return c.display && c.display !== c.origin ? `${c.display} (${c.origin})` : (c.origin ?? '');
  if (c.kind === 'policy_set') return c.policyId ? `policy ${c.policyId.slice(0, 12)}…` : '';
  return '';
}

function changeState(c: GuardedChange): string {
  if (c.status === 'pending') return c.notifiedAt === undefined ? 'Pending: notice not sent yet' : `Pending: active from ${when(c.activeFrom)}`;
  if (c.status === 'active') return `Active since ${when(c.activeFrom)}`;
  return c.status === 'cancelled' ? `Cancelled ${when(c.cancelledAt)}` : 'Ended';
}

export function AppPage() {
  const { org, app } = useParams();
  const r = useApi<{ app: AppDetail }>(`/api/orgs/${org}/apps/${app}`);
  if (r.error) return <ErrorNote error={r.error} />;
  if (!r.data) return <p className="muted">Loading…</p>;
  const a = r.data.app;
  const s = a.settings;
  return (
    <>
      <p>
        <Link to={`/orgs/${org}`}>← Apps</Link>
      </p>
      <h2 className="app-title">
        {a.name} <span className="badge">{a.environment}</span>
      </h2>
      <p className="muted mono">
        {a.id} · scope {a.scopeId}
      </p>
      {suspension(a.suspendedBy) && <p className="note note-warn">{suspension(a.suspendedBy)}</p>}

      <Section title="Origins">
        {a.origins.length === 0 ? (
          <p className="muted">No origins.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Origin</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {a.origins.map((o) => (
                <tr key={o.origin}>
                  <td>
                    {o.display}
                    {o.idn && (
                      <span className="badge badge-warn" title={o.origin}>
                        IDN
                      </span>
                    )}
                    {o.display !== o.origin && <div className="muted mono">{o.origin}</div>}
                  </td>
                  <td>{o.activeFrom === null ? 'Pending' : o.activeFrom <= Date.now() ? 'Active' : `Active from ${when(o.activeFrom)}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Guarded changes">
        {a.changes.length === 0 ? (
          <p className="muted">No pending or active changes.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Change</th>
                <th>Proposed</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {a.changes.map((c) => (
                <tr key={c.id}>
                  <td>
                    {CHANGE_LABEL[c.kind]} <span className="mono">{changeWhat(c)}</span>
                    {c.idn && <span className="badge badge-warn">IDN</span>}
                  </td>
                  <td>
                    {when(c.proposedAt)} by {c.proposedByKind === 'hana' ? 'Hana' : c.proposedByKind}
                    {c.requestCountry ? ` (${c.requestCountry})` : ''}
                  </td>
                  <td>{changeState(c)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Publishable keys">
        <table>
          <thead>
            <tr>
              <th>Key</th>
              <th>Created</th>
              <th>Revoked</th>
            </tr>
          </thead>
          <tbody>
            {a.keys.map((k) => (
              <tr key={k.id}>
                <td className="mono">{k.key}</td>
                <td>{when(k.createdAt)}</td>
                <td>{k.revokedAt === undefined ? '—' : when(k.revokedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Settings">
        <dl className="settings">
          <dt>Session persistence</dt>
          <dd>{s.persistence === 'session' ? 'Kept across reloads' : 'None (log in on every load)'}</dd>
          <dt>Session length</dt>
          <dd>{duration(s.sessionTtlMs)}</dd>
          <dt>Idle timeout</dt>
          <dd>{duration(s.idleTtlMs)}</dd>
          <dt>Google web client</dt>
          <dd className="mono">{s.googleWebClientId ?? 'Hana’s shared client'}</dd>
          <dt>Raw signing</dt>
          <dd>{s.rawSign === 'off' ? 'Off' : 'On, with approval'}</dd>
          <dt>Auto-approve policy</dt>
          <dd>{s.policy ? `${s.policy.label} (${s.policy.policyId.slice(0, 12)}…)` : 'None'}</dd>
        </dl>
      </Section>
    </>
  );
}
