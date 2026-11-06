// Reads of the RPC (docs/batch-c-spec.md "RPC interfaces"): an org's apps, one app in detail, the org's change ledger,
// and the plan read every app write starts with. Every org-facing query has `WHERE org_id = ?`: org A asking for org
// B's app is `not_found`, exactly like an app that doesn't exist.
import type { AppDetail, AppSummary } from '@hana-id/console-core';
import { originDisplay } from '@hana-id/console-core';
import { type Writer, refuse, refuseReplay, replayRow } from './cas.ts';
import type { HotDb } from './db.ts';
import { policyInForce, rawSignInForce, storedPolicy } from './policy.ts';
import { type Q, q, raw } from './sql.ts';
import {
  APP_CHANGE_COLUMNS,
  APP_COLUMNS,
  type AppChangeRow,
  type AppRow,
  CHANGE_COLUMNS,
  CHANGE_JSON,
  type ChangeRow,
  KEY_COLUMNS,
  type KeyRow,
  appChangeView,
  changeView,
  jsonRows,
  keyView,
  summaryView,
} from './views.ts';

const orgFilter = (orgId: string | null): Q => (orgId === null ? raw('1') : q`a.org_id = ${orgId}`);

/** Active origins (in force now) and pending guarded changes of app `a`, for summaries. */
const COUNTS = (now: number): Q =>
  q`(SELECT COUNT(*) FROM app_origins o WHERE o.app_id = a.id AND o.active_from IS NOT NULL AND o.active_from <= ${now}) AS active_origins,
    (SELECT COUNT(*) FROM guarded_changes g WHERE g.app_id = a.id AND g.status = 'pending') AS pending_changes`;

export async function listApps(db: HotDb, orgId: string, now: number, filesOrigin?: string): Promise<AppSummary[]> {
  const rows = await db.all<AppRow & { active_origins: number; pending_changes: number }>(
    q`SELECT ${raw(APP_COLUMNS)}, ${COUNTS(now)} FROM apps a JOIN scopes s ON s.scope_id = a.scope_id WHERE a.org_id = ${orgId} ORDER BY a.created_at, a.id LIMIT 1000`,
  );
  return rows.map((r) => summaryView(r, filesOrigin));
}

export interface OriginRow {
  origin: string;
  active_from: number | null;
  change_id: string | null;
}

/** An app's detail: one batch of four indexed reads (the app, its origins, its open changes, its keys). */
export async function getApp(db: HotDb, appId: string, orgId: string | null, now: number, filesOrigin?: string, opts: { mainnetDemo?: boolean } = {}): Promise<AppDetail> {
  const [app, origins, changes, keys] = await db.batch([
    q`SELECT ${raw(APP_COLUMNS)}, ${COUNTS(now)} FROM apps a JOIN scopes s ON s.scope_id = a.scope_id WHERE a.id = ${appId} AND ${orgFilter(orgId)}`,
    q`SELECT o.origin, o.active_from, o.change_id FROM app_origins o JOIN apps a ON a.id = o.app_id WHERE o.app_id = ${appId} AND ${orgFilter(orgId)} ORDER BY o.origin`,
    q`SELECT ${raw(CHANGE_COLUMNS.split(', ').map((c) => `g.${c}`).join(', '))} FROM guarded_changes g JOIN apps a ON a.id = g.app_id
       WHERE g.app_id = ${appId} AND ${orgFilter(orgId)} AND g.status IN ('pending', 'active') ORDER BY g.proposed_at, g.id`,
    q`SELECT ${raw(KEY_COLUMNS.split(', ').map((c) => `k.${c}`).join(', '))} FROM app_keys k JOIN apps a ON a.id = k.app_id WHERE k.app_id = ${appId} AND ${orgFilter(orgId)} ORDER BY k.created_at, k.id`,
  ]);
  const row = app?.results[0] as (AppRow & { active_origins: number; pending_changes: number }) | undefined;
  if (!row) return refuse('not_found', 'No such app');
  const detail = await detailView(row, origins!.results as unknown as OriginRow[], changes!.results as unknown as ChangeRow[], keys!.results as unknown as KeyRow[], now, filesOrigin);
  // Staff only (AdminRpc): a partner's view never carries the mainnet demo switch (and keeps its read budget).
  return opts.mainnetDemo ? { ...detail, settings: { ...detail.settings, mainnetDemo: await storedMainnetDemo(db, appId) } } : detail;
}

/**
 * The app's mainnet demo switch as D1 holds it (D428, migration 0013), shown read-only; false when the column isn't
 * there yet (the migration not applied) or the read fails, so an app page never breaks on it.
 */
export async function storedMainnetDemo(db: HotDb, appId: string): Promise<boolean> {
  try {
    return (await db.first<{ mainnet_demo: number }>(q`SELECT mainnet_demo FROM apps WHERE id = ${appId}`))?.mainnet_demo === 1;
  } catch {
    return false;
  }
}

export async function detailView(
  row: AppRow & { active_origins: number; pending_changes: number },
  origins: OriginRow[],
  changes: ChangeRow[],
  keys: KeyRow[],
  now: number,
  filesOrigin?: string,
): Promise<AppDetail> {
  const policyText = policyInForce(row, now);
  const policy = policyText === null ? null : await storedPolicy(policyText, row.session_ttl_ms);
  return {
    ...summaryView(row, filesOrigin),
    orgId: row.org_id,
    originsVersion: row.origins_version,
    settingsVersion: row.settings_version,
    origins: origins.map((o) => ({ ...originDisplay(o.origin), activeFrom: o.active_from, ...(o.change_id === null ? {} : { changeId: o.change_id }) })),
    settings: {
      persistence: row.persistence === 'session' ? 'session' : 'none',
      sessionTtlMs: row.session_ttl_ms,
      idleTtlMs: row.idle_ttl_ms,
      googleWebClientId: row.google_web_client_id,
      rawSign: rawSignInForce(row, now),
      policy: policy && { policyId: policy.id, label: policy.label, json: JSON.parse(policy.json) as unknown },
    },
    changes: changes.map(changeView),
    keys: keys.map(keyView),
  };
}

export async function listChanges(db: HotDb, orgId: string, beforeSeq: number | undefined, limit: number) {
  const before = beforeSeq === undefined ? raw('1') : q`seq < ${beforeSeq}`;
  const rows = await db.all<AppChangeRow>(q`SELECT ${raw(APP_CHANGE_COLUMNS)} FROM app_changes WHERE org_id = ${orgId} AND ${before} ORDER BY seq DESC LIMIT ${limit}`);
  return rows.map(appChangeView);
}

/** What an app write plans from: the app (with its scope), optionally its origins, open changes and keys, and the replay check. */
export interface AppPlan {
  app: AppRow;
  origins: OriginRow[];
  openChanges: ChangeRow[];
  keys: KeyRow[];
}

/**
 * The plan read of an app write: one query. `not_found` for no such app in the org (or a deleted one, unless
 * `allowDeleted`), `already_applied` for a request id used before.
 */
export async function planApp(
  db: HotDb,
  i: { appId: string; orgId: string | null; w: Writer; with?: { origins?: boolean; changes?: boolean; keys?: boolean }; allowDeleted?: boolean },
): Promise<AppPlan> {
  const extra: Q[] = [];
  if (i.with?.origins) {
    extra.push(raw(`(SELECT json_group_array(json_object('origin', o.origin, 'active_from', o.active_from, 'change_id', o.change_id)) FROM app_origins o WHERE o.app_id = a.id) AS origins_json`));
  }
  if (i.with?.changes) {
    extra.push(raw(`(SELECT json_group_array(${CHANGE_JSON('g')}) FROM guarded_changes g WHERE g.app_id = a.id AND g.status IN ('pending', 'active')) AS changes_json`));
  }
  if (i.with?.keys) {
    extra.push(raw(`(SELECT json_group_array(json_object('id', k.id, 'app_id', k.app_id, 'key', k.key, 'created_by', k.created_by, 'created_at', k.created_at, 'revoked_at', k.revoked_at)) FROM app_keys k WHERE k.app_id = a.id) AS keys_json`));
  }
  const cols = extra.length ? q`, ${{ sql: extra.map((e) => e.sql).join(', '), args: [] }}` : raw('');
  // The replay check is a scalar subquery: it is answered even when the app doesn't match (another org's, deleted).
  const r = await db.first<AppRow & { replay: string | null; app_id: string | null; origins_json?: string; changes_json?: string; keys_json?: string }>(
    q`SELECT ${replayRow(i.w.requestId)} AS replay, a.id AS app_id, ${raw(APP_COLUMNS)}${cols}
        FROM (SELECT 1) LEFT JOIN apps a ON a.id = ${i.appId} AND ${orgFilter(i.orgId)} LEFT JOIN scopes s ON s.scope_id = a.scope_id`,
  );
  if (i.w.expect && i.w.expect.appId === undefined) i.w.expect.appId = i.appId;
  refuseReplay(r?.replay, i.w);
  if (!r || r.app_id === null) return refuse('not_found', 'No such app');
  if (r.deleted_at !== null && !i.allowDeleted) return refuse('not_found', 'The app is deleted');
  return { app: r, origins: jsonRows<OriginRow>(r.origins_json), openChanges: jsonRows<ChangeRow>(r.changes_json), keys: jsonRows<KeyRow>(r.keys_json) };
}

/** The expected version must be the stored one (the console read it; a moved one is `version_conflict`). */
export function expectVersion(stored: number, expected: number): void {
  if (stored !== expected) refuse('version_conflict', `The version is ${stored}, not ${expected}: read the app again`);
}
