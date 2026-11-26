// Platform activity (D930; docs/partner-platform-spec.md A11): every request your organisation's backend made with its
// platform keys that Journear accepted (`GET /api/orgs/:org/platform-activity?app=&before=`), newest first, a page at
// a time, narrowed to one app if you like. Any member reads it, as the Audit; it changes nothing. Requests that failed
// before Journear could tell which key sent them aren't recorded here (they are only counted, docs/partner-platform-spec.md
// A7 "What isn't stored"). Plain words: what each request did, whether it worked, and its request ID for support.
import type { PlatformCallView } from '@hana-id/console-core';
import { platformRouteWords } from '@hana-id/console-core/platform-words';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { when, useApi } from '../lib.tsx';
import { Badge, Callout, Empty, ErrorNote, Loading, PageHeader } from '../ui.tsx';

interface ActivityAnswer {
  calls: PlatformCallView[];
  next?: number;
  keyLabels: Record<string, string>;
  apps: { id: string; name: string }[];
  appNames: Record<string, string>;
  platform: { enabled: boolean } | null;
}

/** A call's outcome in words: worked, or refused with its code. */
export function outcome(c: PlatformCallView): { label: string; tone: 'ok' | 'warn' | 'danger' } {
  if (c.status < 300) return { label: 'Worked', tone: 'ok' };
  if (c.status === 429) return { label: 'Limit reached', tone: 'warn' };
  return { label: 'Refused', tone: 'danger' };
}

export function PlatformActivity() {
  const { org } = useParams();
  const [app, setApp] = useState('');
  const [before, setBefore] = useState<number[]>([]);
  const cursor = before[before.length - 1];
  const q = new URLSearchParams();
  if (app) q.set('app', app);
  if (cursor !== undefined) q.set('before', String(cursor));
  const r = useApi<ActivityAnswer>(`/api/orgs/${org}/platform-activity${q.size ? `?${q.toString()}` : ''}`);
  const head = (
    <PageHeader
      title="Platform activity"
      back={{ to: `/orgs/${org}/platform-keys`, label: 'Platform keys' }}
      description="What your organisation’s backend did with its platform keys, newest first. Requests Journear couldn’t match to one of your keys aren’t listed. Quote the request ID to Journear about any row."
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
        <Loading />
      </>
    );
  const d = r.data;
  const keyName = (id: string) => (d.keyLabels[id] ? `“${d.keyLabels[id]}”` : id);
  return (
    <>
      {head}
      <div className="stack">
        {d.platform && !d.platform.enabled && <Callout tone="info">Journear hasn’t switched platform keys on for your organisation, so your backend’s requests are refused until it does.</Callout>}
        {d.apps.length > 0 && (
          <div className="filter-row">
            <label className="jp-label" htmlFor="activity-app">
              Show
            </label>
            <select
              id="activity-app"
              className="jp-input"
              value={app}
              onChange={(e) => {
                setApp(e.target.value);
                setBefore([]);
              }}
            >
              <option value="">Every app</option>
              {d.apps.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {d.calls.length === 0 ? (
          <Empty title={app ? 'Nothing for this app here' : 'No requests yet'}>
            {app && d.next !== undefined ? 'Nothing among these requests: look further back with Older.' : 'Requests your backend makes with its platform keys show here.'}
          </Empty>
        ) : (
          <div className="jp-table-wrap tall">
            <table className="jp-table activity">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">What</th>
                  <th scope="col">App</th>
                  <th scope="col">Key</th>
                  <th scope="col">Result</th>
                  <th scope="col">Request ID</th>
                </tr>
              </thead>
              <tbody>
                {d.calls.map((c) => {
                  const o = outcome(c);
                  return (
                    <tr key={c.seq}>
                      <td>{when(c.at)}</td>
                      <td>
                        {platformRouteWords(c.method, c.route)}
                        <div>
                          <code className="small muted">
                            {c.method} {c.route}
                          </code>
                        </div>
                      </td>
                      <td>{c.appId ? <Link to={`/orgs/${org}/apps/${c.appId}`}>{d.appNames[c.appId] ?? c.appId}</Link> : <span className="muted">—</span>}</td>
                      <td>{keyName(c.keyId)}</td>
                      <td>
                        <Badge tone={o.tone}>{o.label}</Badge>
                        {c.code && <div className="mono small muted">{c.code}</div>}
                      </td>
                      <td className="mono small muted">{c.requestId}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="form-actions">
          {before.length > 0 && (
            <button type="button" className="jp-btn jp-btn-secondary" onClick={() => setBefore(before.slice(0, -1))}>
              Newer
            </button>
          )}
          {d.next !== undefined && (
            <button type="button" className="jp-btn jp-btn-secondary" onClick={() => setBefore([...before, d.next!])}>
              Older
            </button>
          )}
        </div>
      </div>
    </>
  );
}
