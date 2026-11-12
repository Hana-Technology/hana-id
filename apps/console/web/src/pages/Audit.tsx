// An org's audit (`GET /api/orgs/:org/audit?cursor=`): the console's events and the API's applied app changes, merged
// newest first, a page at a time. Rows of one request (the same request id) are shown together.
import type { AuditAnswer, PartnerAuditEntry } from '@hana-id/console-core';
// The subpath, not the package root: the SPA bundles only these functions, not the schemas.
import { actionLabel, detailFields as coreDetailFields, detailValue as coreDetailValue } from '@hana-id/console-core/audit-words';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError, getJson } from '../api.ts';
import { when } from '../lib.tsx';
import { Badge, Empty, ErrorNote, Loading, PageHeader } from '../ui.tsx';

function who(e: PartnerAuditEntry): string {
  if (e.actorKind === 'hana') return 'Journear';
  if (e.actorKind === 'system') return 'system';
  if (e.actorKind === 'link') return 'emailed link';
  return e.source === 'console' && e.actorEmail ? e.actorEmail : 'a member';
}

function what(e: PartnerAuditEntry): string {
  return e.source === 'console' ? e.action : e.kind;
}

// The words for codes, keys and values are shared with the admin's feed digests (D704): `@hana-id/console-core`
// audit-words.ts. Times here are the browser's local time (`when`).
export { actionLabel };

/** One detail value as plain text (`@hana-id/console-core` `detailValue`, times as local dates). */
export const detailValue = (k: string, v: unknown): string | null => coreDetailValue(k, v, when);

/** An object's fields as "label: value", empty ones left out. */
export const detailFields = (d: Record<string, unknown>): string[] => coreDetailFields(d, when);

export function detail(e: PartnerAuditEntry): string {
  const parts = detailFields(e.source === 'console' ? e.details : e.detail);
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

  const head = <PageHeader title="Audit" description="Everything done in this organisation, newest first: sign-ins, member changes, and every change to your apps, by whom. Quote the request ID to Journear about any row." />;
  if (error)
    return (
      <>
        {head}
        <ErrorNote
          error={error}
          onRetry={() => {
            setError(undefined);
            void load();
          }}
        />
      </>
    );
  return (
    <>
      {head}
      {loading && entries.length === 0 && <Loading />}
      <div className="jp-table-wrap tall">
      <table className="jp-table audit">
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Who</th>
            <th scope="col">What</th>
            <th scope="col">Details</th>
            <th scope="col">Request ID</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={`${e.source}:${e.seq}`} className={e.source === 'console' && e.outcome === 'failed' ? 'failed' : undefined}>
              <td>{when(e.at)}</td>
              <td>{who(e)}</td>
              <td>
                <span className="audit-what">{actionLabel(what(e))}</span>
                {e.source === 'console' && e.outcome === 'failed' && <Badge tone="danger">Failed</Badge>}
                <div>
                  <code className="small muted">{what(e)}</code>
                </div>
              </td>
              <td className="mono small">{detail(e)}</td>
              <td className="mono small muted">{e.requestId}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {!loading && entries.length === 0 && <Empty title="Nothing yet">Actions in this organisation show here as they happen.</Empty>}
      {next && (
        <button type="button" className="jp-btn jp-btn-secondary load-more" onClick={() => void load(next)} disabled={loading}>
          {loading ? 'Loading…' : 'Load more'}
        </button>
      )}
    </>
  );
}
