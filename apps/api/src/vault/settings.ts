// Per-app vault settings (D1 `apps` columns from migration 0003). `raw_sign = 'approval'` and a new or changed
// auto-approve policy are written as pending values with an effective time (admin CLI, later the batch C dashboard);
// everything served here applies the pending value only once `now >= effective_at`. Turning raw signing off and
// removing a policy clear the pending value and take effect at once, so they need no rule here. A stored policy is
// served only if @hana-id/core's validateAutoApprovePolicy accepts it (the same check the admin CLI and the vault run).
// The validator (with @stellar/stellar-base) is imported only when an app has a policy, so it adds nothing to cold starts.
// D915 after PR 145's review: no policy is ever served for an app that shares a wallet (its scope marked as shared, no
// scope row, or a creator other than Journear staff), whatever D1 holds: such a policy can only be a direct D1 write.
import type { AutoApprovePolicyV1 } from '@hana-id/core/policy';
import { log } from '../log.ts';

export type Persistence = 'session' | 'none';
export type RawSign = 'off' | 'approval';

/** Ranges the migration's CHECKs enforce (the admin CLI validates the same). */
export const SESSION_TTL_MIN_MS = 60 * 60 * 1000;
export const SESSION_TTL_MAX_MS = 23 * 60 * 60 * 1000 + 50 * 60 * 1000;
export const IDLE_TTL_MIN_MS = 15 * 60 * 1000;

export interface SettingsRow {
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
  /** Migration 0026 (D915): who created the app. */
  created_by_kind: string | null;
  /** Migration 0026 (D915): the scope's mark; NULL when the scope row is missing (read as marked). */
  app_user_ids: number | null;
}

/** Settings in force at a given time, as the vault page inlines them. */
export interface AppSettings {
  persistence: Persistence;
  sessionTtlMs: number;
  idleTtlMs: number;
  rawSign: RawSign;
  /** The policy in force, normalized by @hana-id/core's validator (which the vault runs again before using it). */
  autoApprovePolicy: AutoApprovePolicyV1 | null;
}

const SETTINGS_COLUMNS =
  'persistence, session_ttl_ms, idle_ttl_ms, raw_sign, raw_sign_pending, raw_sign_effective_at, auto_approve_policy, auto_approve_pending, auto_approve_effective_at, google_web_client_id';

const SETTINGS_SELECT = `${SETTINGS_COLUMNS.split(', ').map((c) => `a.${c}`).join(', ')}, a.created_by_kind, s.app_user_ids`;

export async function getSettingsRow(db: D1Database, appId: string): Promise<SettingsRow | null> {
  return db.prepare(`SELECT ${SETTINGS_SELECT} FROM apps a LEFT JOIN scopes s ON s.scope_id = a.scope_id WHERE a.id = ?1`).bind(appId).first<SettingsRow>();
}

/** D915: the app shares a wallet, so no policy may apply. Fails closed: a missing scope row or an unknown creator counts. */
export const sharesWallet = (row: Pick<SettingsRow, 'created_by_kind' | 'app_user_ids'>): boolean => row.app_user_ids !== 0 || row.created_by_kind !== 'hana';

/**
 * A stored policy, validated against the app's session_ttl_ms, or null when there is none. A policy the validator
 * refuses (a bare D1 edit, or a validator that has since become stricter) never applies: it is logged and dropped, so
 * every request gets the approval popup.
 */
async function parsePolicy(text: string | null, appId: string, sessionTtlMs: number): Promise<AutoApprovePolicyV1 | null> {
  if (text === null) return null;
  const { parseAutoApprovePolicy } = await import('@hana-id/core/policy');
  const result = parseAutoApprovePolicy(text, { sessionTtlMs });
  if (result.ok) return result.policy;
  // The problems name paths and limits (the policy itself is the app owner's, not secret); bounded for the log line.
  log({ event: 'auto_approve_policy_invalid', appId, problems: result.problems.slice(0, 5).map((p) => p.slice(0, 200)) }, 'error');
  return null;
}

const matured = (pending: unknown, effectiveAt: number | null, now: number): boolean => pending !== null && effectiveAt !== null && now >= effectiveAt;

/**
 * The settings in force at `now`. Values outside the migration's CHECKs can't be stored, but a row is still read
 * defensively: anything unexpected falls back to the most restrictive value ('none', 'off', no policy).
 */
export async function effectiveSettings(row: SettingsRow, appId: string, now: number): Promise<AppSettings> {
  const rawSign: RawSign = matured(row.raw_sign_pending, row.raw_sign_effective_at, now) && row.raw_sign_pending === 'approval' ? 'approval' : row.raw_sign === 'approval' ? 'approval' : 'off';
  let policyText = matured(row.auto_approve_pending, row.auto_approve_effective_at, now) ? row.auto_approve_pending : row.auto_approve_policy;
  if (policyText !== null && sharesWallet(row)) {
    // Only the app and why (the policy text is not logged); drift reports the same write as a security event.
    log({ event: 'auto_approve_policy_shared_wallet', appId, code: row.app_user_ids === null ? 'no_scope_row' : row.app_user_ids !== 0 ? 'scope_marked' : 'not_staff_created' }, 'error');
    policyText = null;
  }
  return {
    persistence: row.persistence === 'session' ? 'session' : 'none',
    sessionTtlMs: row.session_ttl_ms,
    idleTtlMs: row.idle_ttl_ms,
    rawSign,
    autoApprovePolicy: await parsePolicy(policyText, appId, row.session_ttl_ms),
  };
}
