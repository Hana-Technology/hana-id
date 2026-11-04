// An org's audit (`GET /api/orgs/:org/audit?cursor=`): the console's events and the API's applied app changes, merged
// newest first, a page at a time. Rows of one request (the same request id) are shown together.
import type { AuditAnswer, PartnerAuditEntry } from '@hana-id/console-core';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError, getJson } from '../api.ts';
import { ErrorNote, when } from '../lib.tsx';

function who(e: PartnerAuditEntry): string {
  if (e.actorKind === 'hana') return 'Hana';
  if (e.actorKind === 'system') return 'system';
  if (e.actorKind === 'link') return 'emailed link';
  return e.source === 'console' && e.actorEmail ? e.actorEmail : 'a member';
}

function what(e: PartnerAuditEntry): string {
  return e.source === 'console' ? e.action : e.kind;
}

function detail(e: PartnerAuditEntry): string {
  const d = e.source === 'console' ? e.details : e.detail;
  const parts = Object.entries(d).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  if (e.source === 'console' && e.target) parts.unshift(e.target);
  if (e.appId) parts.unshift(e.appId);
  return parts.join(' · ');
}

export function Audit() {
  const { org } = useParams();
  const navigate = useNavigate();
  const [entries, setEntries] = useState<PartnerAuditEntry[]>([]);
  const [next, setNext] = useState<string | undefined>(undefined);
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  const load = async (cursor?: string) => {
    setLoading(true);
    try {
      const page = await getJson<AuditAnswer>(`/api/orgs/${org}/audit${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
      setEntries((prev) => (cursor ? [...prev, ...page.entries] : page.entries));
      setNext(page.next);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) navigate('/signin', { replace: true });
      else setError(err instanceof ApiError ? err : new ApiError(0, 'network', 'The console could not be reached'));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    setEntries([]);
    setNext(undefined);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org]);

  if (error) return <ErrorNote error={error} />;
  return (
    <>
      <table className="audit">
        <thead>
          <tr>
            <th>When</th>
            <th>Who</th>
            <th>What</th>
            <th>Details</th>
            <th>Request</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={`${e.source}:${e.seq}`} className={e.source === 'console' && e.outcome === 'failed' ? 'failed' : undefined}>
              <td>{when(e.at)}</td>
              <td>{who(e)}</td>
              <td className="mono">{what(e)}</td>
              <td className="mono small">{detail(e)}</td>
              <td className="mono small muted">{e.requestId}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!loading && entries.length === 0 && <p className="muted">Nothing yet.</p>}
      {next && (
        <button type="button" onClick={() => void load(next)} disabled={loading}>
          {loading ? 'Loading…' : 'Load more'}
        </button>
      )}
    </>
  );
}
