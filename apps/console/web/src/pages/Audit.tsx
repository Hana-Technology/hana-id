// An org's audit (`GET /api/orgs/:org/audit?cursor=`): the console's events and the API's applied app changes, merged
// newest first, a page at a time. Rows of one request (the same request id) are shown together.
import type { AuditAnswer, PartnerAuditEntry } from '@hana-id/console-core';
// The subpath, not the package root: the SPA bundles only these functions, not the schemas.
import { actionLabel, detailFields as coreDetailFields, detailValue as coreDetailValue, entryLabel } from '@hana-id/console-core/audit-words';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError, getJson } from '../api.ts';
import { when } from '../lib.tsx';
import { Badge, Empty, ErrorNote, Loading, PageHeader } from '../ui.tsx';

/** Who did it, as the Who column says it. Exhaustive over the actor kinds, so a new kind can't show as "a member". */
export function who(e: PartnerAuditEntry, keyLabels?: Record<string, string>): string {
  switch (e.actorKind) {
    case 'hana':
      return 'Journear';
    case 'system':
      return 'system';
    case 'link':
      return 'emailed link';
    // D916, D930: the org's own platform key (its backend through the platform API), by its label when known.
    case 'platform':
      return keyLabels?.[e.actorId] ? `your backend (platform key “${keyLabels[e.actorId]}”)` : `your backend (platform key ${e.actorId})`;
    case 'member':
      return e.source === 'console' && e.actorEmail ? e.actorEmail : 'a member';
    default: {
      // A kind this build doesn't know (a newer API's) reads as itself; the type check makes a new kind a compile error.
      const unknown: never = e;
      return String((unknown as { actorKind: string }).actorKind);
    }
  }
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
  const [keyLabels, setKeyLabels] = useState<Record<string, string>>({});
  const [onlyBackend, setOnlyBackend] = useState(false);
  const [next, setNext] = useState<string | undefined>(undefined);
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  const load = async (cursor?: string) => {
    setLoading(true);
    try {
      const page = await getJson<AuditAnswer>(`/api/orgs/${org}/audit${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
      setEntries((prev) => (cursor ? [...prev, ...page.entries] : page.entries));
      if (page.keyLabels) setKeyLabels((prev) => ({ ...prev, ...page.keyLabels }));
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
      {entries.some((e) => e.actorKind === 'platform') && (
        <label className="jp-check audit-filter">
          <input type="checkbox" checked={onlyBackend} onChange={(e) => setOnlyBackend(e.target.checked)} />
          <span>Only what your backend did with its platform key</span>
        </label>
      )}
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
          {entries.filter((e) => !onlyBackend || e.actorKind === 'platform').map((e) => (
            <tr key={`${e.source}:${e.seq}`} className={e.source === 'console' && e.outcome === 'failed' ? 'failed' : undefined}>
              <td>{when(e.at)}</td>
              <td>
                {who(e, keyLabels)}
                {e.actorKind === 'platform' && <div className="mono small muted">{e.actorId}</div>}
              </td>
              <td>
                <span className="audit-what">{entryLabel(what(e), e.source === 'console' ? e.details : e.detail)}</span>
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
