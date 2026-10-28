// Per-app vault settings (D1 `apps` columns from migration 0003). `raw_sign = 'approval'` and a new or changed
// auto-approve policy are written as pending values with an effective time (admin CLI, later the batch C dashboard);
// everything served here applies the pending value only once `now >= effective_at`. Turning raw signing off and
// removing a policy clear the pending value and take effect at once, so they need no rule here.
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
}

/** Settings in force at a given time, as the vault page inlines them. */
export interface AppSettings {
  persistence: Persistence;
  sessionTtlMs: number;
  idleTtlMs: number;
  rawSign: RawSign;
  /** The policy JSON in force (shape checked only: @hana-id/core's validator runs before it is written and in the vault). */
  autoApprovePolicy: Record<string, unknown> | null;
}

const SETTINGS_COLUMNS =
  'persistence, session_ttl_ms, idle_ttl_ms, raw_sign, raw_sign_pending, raw_sign_effective_at, auto_approve_policy, auto_approve_pending, auto_approve_effective_at, google_web_client_id';

export async function getSettingsRow(db: D1Database, appId: string): Promise<SettingsRow | null> {
  return db.prepare(`SELECT ${SETTINGS_COLUMNS} FROM apps WHERE id = ?1`).bind(appId).first<SettingsRow>();
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A stored policy as JSON, or null (with a log line) when it is not a JSON object: an unreadable policy never applies. */
function parsePolicy(text: string | null, appId: string): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (isPlainObject(value)) return value;
  } catch {
    // Fall through.
  }
  log({ event: 'auto_approve_policy_unreadable', appId }, 'error');
  return null;
}

const matured = (pending: unknown, effectiveAt: number | null, now: number): boolean => pending !== null && effectiveAt !== null && now >= effectiveAt;

/**
 * The settings in force at `now`. Values outside the migration's CHECKs can't be stored, but a row is still read
 * defensively: anything unexpected falls back to the most restrictive value ('none', 'off', no policy).
 */
export function effectiveSettings(row: SettingsRow, appId: string, now: number): AppSettings {
  const rawSign: RawSign = matured(row.raw_sign_pending, row.raw_sign_effective_at, now) && row.raw_sign_pending === 'approval' ? 'approval' : row.raw_sign === 'approval' ? 'approval' : 'off';
  const policyText = matured(row.auto_approve_pending, row.auto_approve_effective_at, now) ? row.auto_approve_pending : row.auto_approve_policy;
  return {
    persistence: row.persistence === 'session' ? 'session' : 'none',
    sessionTtlMs: row.session_ttl_ms,
    idleTtlMs: row.idle_ttl_ms,
    rawSign,
    autoApprovePolicy: parsePolicy(policyText, appId),
  };
}
