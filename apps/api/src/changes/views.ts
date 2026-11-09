// Hot-DB rows → the RPC views of docs/batch-c-spec.md "Types" (console-core). Views carry allowlisted columns only:
// never `cancel_token_hash`, never a policy's request id or anything a partner of another org could use.
import {
  type AppChange,
  type AppSummary,
  type GuardedChange,
  type KeyView,
  type ScopeRow,
  type SecurityEvent,
  originDisplay,
} from '@hana-id/console-core';
import { q } from './sql.ts';

export interface ChangeRow {
  id: string;
  app_id: string;
  kind: 'origin_add' | 'policy_set' | 'raw_sign_on';
  origin: string | null;
  policy_json: string | null;
  policy_id: string | null;
  status: 'pending' | 'active' | 'cancelled' | 'ended';
  proposed_by_kind: 'member' | 'hana' | 'system';
  proposed_by: string;
  proposer_sub: string | null;
  proposed_at: number;
  request_country: string | null;
  waiver: 'loopback' | 'no_session' | null;
  notified_at: number | null;
  active_from: number | null;
  expedited_by: string | null;
  cancelled_by: string | null;
  cancelled_at: number | null;
  request_id: string;
}

export const CHANGE_COLUMNS =
  'id, app_id, kind, origin, policy_json, policy_id, status, proposed_by_kind, proposed_by, proposer_sub, proposed_at, request_country, waiver, notified_at, active_from, expedited_by, cancelled_by, cancelled_at, request_id';

/** The same columns as a JSON object, for plan reads that aggregate an app's changes into one value. */
export const CHANGE_JSON = (alias: string): string =>
  `json_object(${CHANGE_COLUMNS.split(', ')
    .map((c) => `'${c}', ${alias}.${c}`)
    .join(', ')})`;

export function changeView(r: ChangeRow): GuardedChange {
  const v: GuardedChange = {
    id: r.id,
    appId: r.app_id,
    kind: r.kind,
    status: r.status,
    proposedByKind: r.proposed_by_kind,
    proposedBy: r.proposed_by,
    proposedAt: r.proposed_at,
    activeFrom: r.active_from,
  };
  if (r.origin !== null) Object.assign(v, originDisplay(r.origin));
  if (r.policy_id !== null) v.policyId = r.policy_id;
  if (r.request_country !== null) v.requestCountry = r.request_country;
  if (r.waiver !== null) v.waiver = r.waiver;
  if (r.notified_at !== null) v.notifiedAt = r.notified_at;
  if (r.expedited_by !== null) v.expeditedBy = r.expedited_by;
  if (r.cancelled_by !== null) v.cancelledBy = r.cancelled_by;
  if (r.cancelled_at !== null) v.cancelledAt = r.cancelled_at;
  return v;
}

export interface KeyRow {
  id: string;
  app_id: string;
  key: string;
  created_by: string;
  created_at: number;
  revoked_at: number | null;
}

export const KEY_COLUMNS = 'id, app_id, key, created_by, created_at, revoked_at';

export function keyView(r: KeyRow): KeyView {
  const v: KeyView = { id: r.id, prefix: r.key.startsWith('pk_live_') ? 'pk_live_' : 'pk_test_', key: r.key, createdBy: r.created_by, createdAt: r.created_at };
  if (r.revoked_at !== null) v.revokedAt = r.revoked_at;
  return v;
}

/** The apps columns the RPC reads (with the scope's environment), for summaries, details and every plan read. */
export interface AppRow {
  id: string;
  name: string;
  scope_id: string;
  org_id: string;
  suspended_by: number;
  deleted_at: number | null;
  logo_key: string | null;
  created_at: number;
  origins_version: number;
  settings_version: number;
  persistence: string;
  session_ttl_ms: number;
  idle_ttl_ms: number;
  raw_sign: string;
  raw_sign_pending: string | null;
  raw_sign_effective_at: number | null;
  auto_approve_policy: string | null;
  auto_approve_pending: string | null;
  auto_approve_effective_at: number | null;
  google_web_client_id: string | null;
  /** Migration 0014 (D411). */
  identity_email: string;
  environment: 'test' | 'live';
  first_session_at: number | null;
  assigned_at: number;
}

export const APP_COLUMNS =
  'a.id, a.name, a.scope_id, a.org_id, a.suspended_by, a.deleted_at, a.logo_key, a.created_at, a.origins_version, a.settings_version, a.persistence, a.session_ttl_ms, a.idle_ttl_ms, a.raw_sign, a.raw_sign_pending, a.raw_sign_effective_at, a.auto_approve_policy, a.auto_approve_pending, a.auto_approve_effective_at, a.google_web_client_id, a.identity_email, s.environment, s.first_session_at, s.assigned_at';

/** `<FILES_ORIGIN>/<logo_key>`, or none (no logo, or no files origin in this env). */
export function logoUrl(filesOrigin: string | undefined, logoKey: string | null): string | undefined {
  return filesOrigin && logoKey ? `${filesOrigin}/${logoKey}` : undefined;
}

export function summaryView(r: AppRow & { active_origins: number; pending_changes: number }, filesOrigin: string | undefined): AppSummary {
  const v: AppSummary = {
    id: r.id,
    name: r.name,
    scopeId: r.scope_id,
    environment: r.environment,
    suspendedBy: r.suspended_by,
    deleted: r.deleted_at !== null,
    activeOrigins: r.active_origins,
    pendingChanges: r.pending_changes,
    createdAt: r.created_at,
  };
  const url = logoUrl(filesOrigin, r.logo_key);
  if (url) v.logoUrl = url;
  return v;
}

export interface AppChangeRow {
  seq: number;
  at: number;
  org_id: string;
  app_id: string | null;
  scope_id: string | null;
  kind: string;
  detail_json: string;
  actor_kind: AppChange['actorKind'];
  actor_id: string;
  actor_sub: string | null;
  request_id: string;
}

export const APP_CHANGE_COLUMNS = 'seq, at, org_id, app_id, scope_id, kind, detail_json, actor_kind, actor_id, actor_sub, request_id';

function parseDetail(text: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v };
  } catch {
    return {};
  }
}

export function appChangeView(r: AppChangeRow): AppChange {
  const v: AppChange = { seq: r.seq, at: r.at, orgId: r.org_id, kind: r.kind, detail: parseDetail(r.detail_json), actorKind: r.actor_kind, actorId: r.actor_id, requestId: r.request_id };
  if (r.app_id !== null) v.appId = r.app_id;
  if (r.scope_id !== null) v.scopeId = r.scope_id;
  if (r.actor_sub !== null) v.actorSub = r.actor_sub;
  return v;
}

export interface SecurityEventRow {
  id: string;
  detected_at: number;
  kind: SecurityEvent['kind'];
  org_id: string | null;
  app_id: string | null;
  scope_id: string | null;
  detail_json: string;
  notified_at: number | null;
}

export function securityEventView(r: SecurityEventRow): SecurityEvent {
  const v: SecurityEvent = { id: r.id, detectedAt: r.detected_at, kind: r.kind, detail: parseDetail(r.detail_json) };
  if (r.org_id !== null) v.orgId = r.org_id;
  if (r.app_id !== null) v.appId = r.app_id;
  if (r.scope_id !== null) v.scopeId = r.scope_id;
  if (r.notified_at !== null) v.notifiedAt = r.notified_at;
  return v;
}

export const scopeView = (r: { scope_id: string; org_id: string; environment: 'test' | 'live'; assigned_at: number }): ScopeRow => ({
  scopeId: r.scope_id,
  orgId: r.org_id,
  environment: r.environment,
  assignedAt: r.assigned_at,
});

/** The change by id (read back after a write; AdminRpc only, or within the console's batch budget). */
export const changeByIdSql = (id: string) => q`SELECT ${{ sql: CHANGE_COLUMNS, args: [] }} FROM guarded_changes WHERE id = ${id}`;

/** Parses a JSON array column of a plan read (`json_group_array`), or []. */
export function jsonRows<T>(text: string | null | undefined): T[] {
  if (!text) return [];
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}
