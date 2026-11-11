// An org's audit (`GET /api/orgs/:org/audit?cursor=`): the console's events and the API's applied app changes, merged
// newest first, a page at a time. Rows of one request (the same request id) are shown together.
import type { AuditAnswer, PartnerAuditEntry } from '@hana-id/console-core';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError, getJson } from '../api.ts';
import { when } from '../lib.tsx';
import { Badge, Empty, ErrorNote, Loading, PageHeader } from '../ui.tsx';

function who(e: PartnerAuditEntry): string {
  if (e.actorKind === 'hana') return 'Hana';
  if (e.actorKind === 'system') return 'system';
  if (e.actorKind === 'link') return 'emailed link';
  return e.source === 'console' && e.actorEmail ? e.actorEmail : 'a member';
}

function what(e: PartnerAuditEntry): string {
  return e.source === 'console' ? e.action : e.kind;
}

/** An action code in words: `key.created` → "Key created", `step_up.failed` → "Step up failed". */
export function actionLabel(code: string): string {
  const words = code.replace(/[._]+/gu, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : code;
}

/** A detail key in words: `activeFrom` → "active from", `scope_id` → "scope id". Unknown keys stay recognisable. */
export const keyLabel = (k: string): string => k.replace(/_/gu, ' ').replace(/([a-z0-9])([A-Z])/gu, '$1 $2').toLowerCase();

/** A time in ms under a key that names one (`…At`, `…From`, `…Until`): shown as a date. */
const isTime = (k: string, v: unknown): v is number => typeof v === 'number' && /(At|From|Until)$/u.test(k) && v > 1e12;

/**
 * One detail value as plain text: times as dates, yes or no, lists joined, an object as its fields; empty (null,
 * undefined) gives null and the field is left out. Nothing else is dropped.
 */
export function detailValue(k: string, v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (isTime(k, v)) return when(v);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) {
    const items = v.map((x) => detailValue(k, x)).filter((x): x is string => x !== null);
    return items.length ? items.join('; ') : 'none';
  }
  if (typeof v === 'object') {
    const fields = detailFields(v as Record<string, unknown>);
    return fields.length ? fields.join(', ') : 'none';
  }
  return JSON.stringify(v) ?? null;
}

/** An object's fields as "label: value", empty ones left out. */
export const detailFields = (d: Record<string, unknown>): string[] =>
  Object.entries(d).flatMap(([k, v]) => {
    const text = detailValue(k, v);
    return text === null ? [] : [`${keyLabel(k)}: ${text}`];
  });

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

  const head = <PageHeader title="Audit" description="Everything done in this organisation, newest first: sign-ins, member changes, and every change to your apps, by whom. Quote the request ID to Hana about any row." />;
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
      <div className="table-wrap">
      <table className="table audit">
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
        <button type="button" className="btn load-more" onClick={() => void load(next)} disabled={loading}>
          {loading ? 'Loading…' : 'Load more'}
        </button>
      )}
    </>
  );
}
