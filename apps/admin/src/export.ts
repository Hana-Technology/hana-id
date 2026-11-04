// `GET /api/audit.csv` (docs/batch-c-spec.md "Admin BFF routes": `queryAudit` + `changesSince`; D278): the console's
// audit rows matching the filters and, when the filters name an org, that org's `app_changes` rows filtered the same
// way, merged newest first into one CSV with a `source` column, so a console action and the API change it made sit
// side by side (same `request_id`). At most MAX_EXPORT_ROWS per source; past that the answer says so in
// `x-hana-truncated: 1` and the staffer narrows the filters.
import type { AppChange, AuditRow } from '@hana-id/console-core';
import { csvRow } from './csv.ts';
import type { Env } from './env.ts';
import { errorResponse } from './http.ts';
import { errorName, log } from './log.ts';
import { type StaffRequest, staffCtx } from './rpc.ts';

export const MAX_EXPORT_ROWS = 5000;
export const EXPORT_COLUMNS = ['source', 'seq', 'at', 'org_id', 'app_id', 'scope_id', 'action', 'actor_kind', 'actor_id', 'actor_email', 'target', 'outcome', 'request_id', 'near_tx', 'country', 'detail'] as const;

interface Line {
  at: number;
  cells: unknown[];
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** Whether an app_changes row passes the audit filters (applied here: listChanges filters by org only). */
function changeMatches(r: AppChange, f: Record<string, unknown>): boolean {
  if (typeof f.appId === 'string' && r.appId !== f.appId) return false;
  if (typeof f.actorKind === 'string' && r.actorKind !== f.actorKind) return false;
  if (typeof f.actorId === 'string' && r.actorId !== f.actorId) return false;
  if (typeof f.action === 'string' && r.kind !== f.action) return false;
  if (typeof f.from === 'number' && r.at < f.from) return false;
  if (typeof f.to === 'number' && r.at >= f.to) return false;
  return true;
}

export async function auditCsv(env: Env, staff: StaffRequest, filters: Record<string, unknown>): Promise<Response> {
  const ctx = staffCtx(staff);
  const lines: Line[] = [];
  let truncated = false;
  try {
    // The console's audit_log, newest first, keyset-paged.
    let cursor: string | undefined;
    let n = 0;
    for (;;) {
      const r = await env.CONSOLE.queryAudit({ ...ctx, filters, limit: 500, ...(cursor ? { cursor } : {}) });
      if (!r.ok) return errorResponse(r.code, r.error);
      for (const a of r.rows as AuditRow[]) {
        lines.push({ at: a.at, cells: ['audit_log', a.seq, iso(a.at), a.orgId, a.appId, null, a.action, a.actorKind, a.actorId, a.actorEmail, a.target, a.outcome, a.requestId, a.nearTx, a.country, a.details] });
      }
      n += r.rows.length;
      if (!r.next) break;
      if (n >= MAX_EXPORT_ROWS) {
        truncated = true;
        break;
      }
      cursor = r.next;
    }
    // The org's app_changes (the API's authoritative record), newest first.
    if (typeof filters.orgId === 'string') {
      let before: number | undefined;
      let scanned = 0;
      for (;;) {
        const r = await env.API.listChanges({ ...ctx, orgId: filters.orgId, limit: 200, ...(before !== undefined ? { beforeSeq: before } : {}) });
        if (!r.ok) return errorResponse(r.code, r.error);
        for (const ch of r.changes) {
          if (typeof filters.from === 'number' && ch.at < filters.from) continue;
          if (!changeMatches(ch, filters)) continue;
          lines.push({ at: ch.at, cells: ['app_changes', ch.seq, iso(ch.at), ch.orgId, ch.appId, ch.scopeId, ch.kind, ch.actorKind, ch.actorId, null, null, 'ok', ch.requestId, null, null, ch.detail] });
        }
        scanned += r.changes.length;
        const last = r.changes[r.changes.length - 1];
        // Rows come newest first: once past `from`, nothing older matches.
        if (r.changes.length < 200 || !last || (typeof filters.from === 'number' && last.at < filters.from)) break;
        if (scanned >= MAX_EXPORT_ROWS) {
          truncated = true;
          break;
        }
        before = last.seq;
      }
    }
  } catch (err) {
    log({ event: 'bff', route: 'GET /api/audit.csv', requestId: staff.requestId, outcome: 'error', code: 'upstream_unavailable', error: errorName(err) }, 'error');
    return errorResponse('upstream_unavailable');
  }
  lines.sort((a, b) => b.at - a.at);
  const body = csvRow(EXPORT_COLUMNS) + lines.map((l) => csvRow(l.cells)).join('');
  log({ event: 'bff', route: 'GET /api/audit.csv', requestId: staff.requestId, outcome: 'ok', count: lines.length });
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="audit-${env.ENV_NAME}-${new Date().toISOString().slice(0, 10)}.csv"`,
      ...(truncated ? { 'x-hana-truncated': '1' } : {}),
    },
  });
}
