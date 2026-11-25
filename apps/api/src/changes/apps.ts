// Reads of the RPC (docs/batch-c-spec.md "RPC interfaces"): an org's apps, one app in detail, the org's change ledger,
// and the plan read every app write starts with. Every org-facing query has `WHERE org_id = ?`: org A asking for org
// B's app is `not_found`, exactly like an app that doesn't exist.
import type { AppDetail, AppSummary, GuardedChange } from '@hana-id/console-core';
import { autoApproveRefused, originDisplay } from '@hana-id/console-core';
import { NOT_YET, type Writer, refuse, refuseReplay, replayRow } from './cas.ts';
import type { HotDb } from './db.ts';
import { policyInForce, rawSignInForce, storedPolicy } from './policy.ts';
import { type Q, join, q, raw } from './sql.ts';
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

/**
 * Active origins (in force now) and the guarded changes of app `a` still waiting (pending and not yet in force:
 * cas.ts NOT_YET; one whose clock has passed is in force, though the hourly job records it later), for summaries.
 */
const COUNTS = (now: number): Q =>
  q`(SELECT COUNT(*) FROM app_origins o WHERE o.app_id = a.id AND o.active_from IS NOT NULL AND o.active_from <= ${now}) AS active_origins,
    (SELECT COUNT(*) FROM guarded_changes g WHERE g.app_id = a.id AND ${NOT_YET(now, 'g')}) AS pending_changes`;

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

/**
 * D930: who holds the partner bit (migration 0033) and, for an app the platform created, the platform key that created
 * it: the creator of its first publishable key, which the create's own batch writes with the key's id (an app's keys are
 * never deleted while it lives). Read in the app's own row, so no extra read.
 */
const DETAIL_EXTRA = raw(`a.partner_bit_by AS partner_bit_by,
  CASE WHEN a.created_by_kind = 'platform' THEN (SELECT k.created_by FROM app_keys k WHERE k.app_id = a.id ORDER BY k.created_at, k.id LIMIT 1) END AS first_key_by`);

/** An app's detail: one batch of four indexed reads (the app, its origins, its open changes, its keys). */
export async function getApp(db: HotDb, appId: string, orgId: string | null, now: number, filesOrigin?: string, opts: { mainnetDemo?: boolean } = {}): Promise<AppDetail> {
  const [app, origins, changes, keys] = await db.batch([
    q`SELECT ${raw(APP_COLUMNS)}, ${COUNTS(now)}, ${DETAIL_EXTRA} FROM apps a JOIN scopes s ON s.scope_id = a.scope_id WHERE a.id = ${appId} AND ${orgFilter(orgId)}`,
    q`SELECT o.origin, o.active_from, o.change_id FROM app_origins o JOIN apps a ON a.id = o.app_id WHERE o.app_id = ${appId} AND ${orgFilter(orgId)} ORDER BY o.origin`,
    q`SELECT ${raw(CHANGE_COLUMNS.split(', ').map((c) => `g.${c}`).join(', '))} FROM guarded_changes g JOIN apps a ON a.id = g.app_id
       WHERE g.app_id = ${appId} AND ${orgFilter(orgId)} AND g.status IN ('pending', 'active') ORDER BY g.proposed_at, g.id`,
    q`SELECT ${raw(KEY_COLUMNS.split(', ').map((c) => `k.${c}`).join(', '))} FROM app_keys k JOIN apps a ON a.id = k.app_id WHERE k.app_id = ${appId} AND ${orgFilter(orgId)} ORDER BY k.created_at, k.id`,
  ]);
  const row = app?.results[0] as (AppRow & { active_origins: number; pending_changes: number } & DetailExtra) | undefined;
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

/** The detail's extra columns (DETAIL_EXTRA); absent when the row came from a plan read. */
export interface DetailExtra {
  partner_bit_by?: 'member' | 'platform' | null;
  first_key_by?: string | null;
}

export async function detailView(
  row: AppRow & { active_origins: number; pending_changes: number } & DetailExtra,
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
      identityEmail: row.identity_email === 'on_request' || row.identity_email === 'at_login' ? row.identity_email : 'off',
      loginMethods: row.login_methods === 'email' || row.login_methods === 'google,email' ? row.login_methods : 'google',
    },
    // D915: the scope's shared flag and the app's creator, and the rule the screens hide the policy editor by.
    sharedScope: row.app_user_ids !== 0,
    createdByKind: row.created_by_kind,
    sharedWallet: sharedWallet(row),
    // D919: the User ID the app gives its users ('app': its own; anything unexpected is shown as its own too, the
    // stricter reading, as the token mint refuses it).
    userIds: row.user_ids === 'scope' ? 'scope' : 'app',
    // D930: the platform key that created it (a platform-created app), and who holds the partner bit while it is set
    // (a bit set before migration 0033, with no holder recorded, reads as a member's, as the writers read it).
    ...(row.created_by_kind === 'platform' && typeof row.first_key_by === 'string' && row.first_key_by.startsWith('pkc_') ? { createdByKey: row.first_key_by } : {}),
    ...((row.suspended_by & 4) !== 0 && row.partner_bit_by !== undefined ? { partnerBitBy: row.partner_bit_by === 'platform' ? ('platform' as const) : ('member' as const) } : {}),
    // Each change's status as it is in force now (changeView), so a page never offers Cancel on a change in force.
    changes: latestPolicyOnly(changes.map((c) => changeView(c, now))),
    keys: keys.map(keyView),
  };
}

/**
 * Only one `policy_set` is in force at a time. Between a waiver or an expedite and the hourly job, two can read `active`
 * (the older recorded, or both past `active_from`); the latest by `active_from` (then proposal time, then id) is the one
 * in force, and the others read `ended`, which is what the job records for them (guarded/cron.ts ends the replaced one).
 */
export function latestPolicyOnly(views: GuardedChange[]): GuardedChange[] {
  const active = views.filter((v) => v.kind === 'policy_set' && v.status === 'active');
  if (active.length < 2) return views;
  const key = (v: GuardedChange): [number, number, string] => [v.activeFrom ?? 0, v.proposedAt, v.id];
  const latest = active.reduce((a, b) => {
    const [x, y] = [key(a), key(b)];
    return x[0] !== y[0] ? (x[0] > y[0] ? a : b) : x[1] !== y[1] ? (x[1] > y[1] ? a : b) : x[2] >= y[2] ? a : b;
  });
  return views.map((v) => (v.kind === 'policy_set' && v.status === 'active' && v !== latest ? { ...v, status: 'ended' } : v));
}

export async function listChanges(db: HotDb, orgId: string, beforeSeq: number | undefined, limit: number) {
  const before = beforeSeq === undefined ? raw('1') : q`seq < ${beforeSeq}`;
  const rows = await db.all<AppChangeRow>(q`SELECT ${raw(APP_CHANGE_COLUMNS)} FROM app_changes WHERE org_id = ${orgId} AND ${before} ORDER BY seq DESC LIMIT ${limit}`);
  return rows.map(appChangeView);
}

/** What an app write plans from: the app (with its scope), optionally its origins, open changes and keys, and the replay check. */
export interface AppPlan {
  /** `partner_bit_by` (migration 0033, D929) only when the plan asked for it (`with.partnerBit`). */
  app: AppRow & { partner_bit_by?: 'member' | 'platform' | null };
  origins: OriginRow[];
  openChanges: ChangeRow[];
  keys: KeyRow[];
}

/**
 * The plan read of an app write: one query. `not_found` for no such app in the org (or a deleted one, unless
 * `allowDeleted`), or outside the platform's reach when the writer has one (D929, H1), `already_applied` for a
 * request id used before.
 */
export async function planApp(
  db: HotDb,
  i: { appId: string; orgId: string | null; w: Writer; with?: { origins?: boolean; changes?: boolean; keys?: boolean; partnerBit?: boolean }; keyId?: string; allowDeleted?: boolean },
): Promise<AppPlan> {
  const extra: Q[] = [];
  if (i.with?.origins) {
    extra.push(raw(`(SELECT json_group_array(json_object('origin', o.origin, 'active_from', o.active_from, 'change_id', o.change_id)) FROM app_origins o WHERE o.app_id = a.id) AS origins_json`));
  }
  if (i.with?.changes) {
    extra.push(raw(`(SELECT json_group_array(${CHANGE_JSON('g')}) FROM guarded_changes g WHERE g.app_id = a.id AND g.status IN ('pending', 'active')) AS changes_json`));
  }
  if (i.with?.partnerBit) extra.push(raw('a.partner_bit_by AS partner_bit_by'));
  if (i.with?.keys) {
    // D929: only the keys a key write needs, never the app's whole history (revoked keys pile up; one JSON value of
    // them all would grow without bound): those unrevoked or still in their rotation grace at the write's time, and
    // the key the write names (three disjoint parts, in no particular order: every reader finds or counts). Each part is a seek: on `app_keys_app_revoked` (migration 0033), and on the key's id.
    const cols3 = `k.id, k.app_id, k.key, k.created_by, k.created_at, k.revoked_at`;
    extra.push(
      q`(SELECT json_group_array(json_object('id', k.id, 'app_id', k.app_id, 'key', k.key, 'created_by', k.created_by, 'created_at', k.created_at, 'revoked_at', k.revoked_at))
          FROM (SELECT ${raw(cols3)} FROM app_keys k WHERE k.app_id = a.id AND k.revoked_at IS NULL
                UNION ALL SELECT ${raw(cols3)} FROM app_keys k WHERE k.app_id = a.id AND k.revoked_at > ${i.w.now}
                ${i.keyId === undefined ? raw('') : q`UNION ALL SELECT ${raw(cols3)} FROM app_keys k WHERE k.id = ${i.keyId} AND k.app_id = a.id AND k.revoked_at <= ${i.w.now}`}) k) AS keys_json`,
    );
  }
  const cols = extra.length ? q`, ${join(extra, ', ')}` : raw('');
  // The replay check is a scalar subquery: it is answered even when the app doesn't match (another org's, deleted).
  const r = await db.first<AppRow & { replay: string | null; app_id: string | null; origins_json?: string; changes_json?: string; keys_json?: string }>(
    q`SELECT ${replayRow(i.w.requestId)} AS replay, a.id AS app_id, ${raw(APP_COLUMNS)}${cols}
        FROM (SELECT 1) LEFT JOIN apps a ON a.id = ${i.appId} AND ${orgFilter(i.orgId)}${i.w.reach ? q` AND ${i.w.reach.app}` : raw('')} LEFT JOIN scopes s ON s.scope_id = a.scope_id`,
  );
  if (i.w.expect && i.w.expect.appId === undefined) i.w.expect.appId = i.appId;
  refuseReplay(r?.replay, i.w);
  if (!r || r.app_id === null) return refuse('not_found', 'No such app');
  if (r.deleted_at !== null && !i.allowDeleted) return refuse('not_found', 'The app is deleted');
  return { app: r, origins: jsonRows<OriginRow>(r.origins_json), openChanges: jsonRows<ChangeRow>(r.changes_json), keys: jsonRows<KeyRow>(r.keys_json) };
}

/**
 * D915: the app may never have an auto-approve policy (its scope is shared, or the platform created it). Fails closed:
 * a scope flag that isn't 0 (a missing scope row reads NULL) and any creator but `hana` count as shared.
 */
export const sharedWallet = (row: Pick<AppRow, 'app_user_ids' | 'created_by_kind'>): boolean =>
  autoApproveRefused({ sharedScope: row.app_user_ids !== 0, createdByKind: row.created_by_kind });

/** The expected version must be the stored one (the console read it; a moved one is `version_conflict`). */
export function expectVersion(stored: number, expected: number): void {
  if (stored !== expected) refuse('version_conflict', `The version is ${stored}, not ${expected}: read the app again`);
}
