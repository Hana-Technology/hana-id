// admin.ts app:settings: the per-app vault settings (docs/batch-b-spec.md "App settings", docs/batch-c-spec.md §CLI), in
// the `apps` columns of migration 0003. Every range is checked here and again by the migration's CHECKs;
// `--google-web-client` must be one of the scope's on-chain Google clients; an auto-approve policy must pass
// @hana-id/core's validateAutoApprovePolicy (the same validator the API and the vault run).
//
// Loosening is a guarded change, tightening is immediate (batch C, migration 0006): `--raw-sign approval` and a new or
// changed `--auto-approve` policy become staff proposals (`guarded_changes`; nothing in `apps` yet). They take effect
// `appChangeDelayMs` after their announcement: the admin Worker's notice, or, in an env without one,
// `app:changes:announce <id>`, which writes the pending column and its `*_effective_at`. `--raw-sign off` and
// `--auto-approve off` take effect at once, drop any pending value and end or cancel the guarded changes. Every write
// bumps `settings_version` and records an `app_changes` row.
//
// `--identity-email off|on_request|at_login` (D411, migration 0012's `apps.identity_email`): when Hana asks users to
// share their email with the app; immediate, like the persistence (turning it on shares nothing until a user agrees).
// On a hot D1 without migration 0012 the display says so and the flag is refused before anything is written.
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { canonicalJson, parseAutoApprovePolicy, policyId } from '@hana-id/core/policy';
import type { Manifest } from '@hana-id/env';
import {
  type ChangeRow,
  type CliActor,
  type HotWrite,
  closeChangesSql,
  openChangesSql,
  proposalSql,
  committed,
  settingsWrite,
  writeCommand,
} from './admin-sql.ts';
import { type Args, CliError } from './cli.ts';
import { GOOGLE_PROVIDER, tryView } from './contract.ts';
import { d1Execute } from './d1.ts';
import { NearRpc } from './near.ts';
import { sql, sqlValue } from './sql.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Ranges of migration 0003's CHECKs (and apps/api/src/vault/settings.ts). */
export const SESSION_TTL_MIN_MS = HOUR;
export const SESSION_TTL_MAX_MS = 23 * HOUR + 50 * MINUTE;
export const IDLE_TTL_MIN_MS = 15 * MINUTE;
/** Largest policy file read (the validator caps the canonical JSON at 16 KiB). */
export const POLICY_FILE_MAX_BYTES = 64 * 1024;
/** `--google-web-client default`: no pinned client, GET /v1/app uses the scope's first Google client. */
export const DEFAULT_WEB_CLIENT = 'default';

export const RAW_SIGN_WARNING =
  'WARNING: raw signing lets the app ask the user to sign arbitrary bytes, which can authorize any transaction on that chain. Every raw signature still needs an Approve click in a Hana popup.';

export type Persistence = 'session' | 'none';
export type RawSign = 'off' | 'approval';
/** D411: when Hana asks users to share their email with the app (migration 0012's CHECK). */
export type IdentityEmail = 'off' | 'on_request' | 'at_login';
export const IDENTITY_EMAIL_VALUES: readonly IdentityEmail[] = ['off', 'on_request', 'at_login'];
/** How the display names each value. */
export const IDENTITY_EMAIL_LABEL: Record<IdentityEmail, string> = { off: 'off', on_request: 'when the app asks', at_login: 'at first login' };
/** The refusal of `--identity-email` on a hot D1 without the column. */
export const IDENTITY_EMAIL_NEEDS_0012 = "--identity-email needs apps.identity_email, which this env's hot D1 doesn't have: apply migration 0012 (0012_email_sharing.sql) first";

export interface SettingsRow {
  id: string;
  name: string;
  scope_id: string;
  org_id: string;
  /** The scope's environment: raw signing is refused for test apps (D39, as amended 2026-10-28). */
  environment: 'test' | 'live';
  settings_version: number;
  deleted_at: number | null;
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
  /** Migration 0012 (D411); absent when the hot D1 doesn't have the column yet. */
  identity_email?: string;
}

/** A validated policy as it is stored: its canonical JSON (normalized by the validator) and its policyId. */
export interface StoredPolicy {
  json: string;
  id: string;
  label: string;
}

/** What one app:settings call asks for (only the flags given). */
export interface SettingsChange {
  persistence?: Persistence;
  sessionTtlMs?: number;
  idleTtlMs?: number;
  rawSign?: RawSign;
  /** A client id, or null to unpin (`--google-web-client default`). */
  googleWebClient?: string | null;
  /** The policy file's text, or 'off'. Validated in planSettings, against the session TTL that will be in force. */
  autoApprove?: { text: string; file: string } | 'off';
  identityEmail?: IdentityEmail;
}

/** The write to run (null when nothing changes) and what to print. */
export interface SettingsPlan {
  write: HotWrite | null;
  lines: string[];
  warnings: string[];
}

const SETTINGS_COLUMNS =
  'persistence, session_ttl_ms, idle_ttl_ms, raw_sign, raw_sign_pending, raw_sign_effective_at, auto_approve_policy, auto_approve_pending, auto_approve_effective_at, google_web_client_id';

/** 1 when the hot D1's `apps` has migration 0012's `identity_email` column, else 0 (the table's stored definition). */
export const IDENTITY_EMAIL_COLUMN_SQL = "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'apps' AND instr(sql, 'identity_email') > 0";

/** The settings columns this database has: migration 0012's `identity_email` only once applied. */
const settingsColumns = (identityEmail: boolean): string[] => [...SETTINGS_COLUMNS.split(', '), ...(identityEmail ? ['identity_email'] : [])];

/**
 * The app (by id or any of its publishable keys) with its settings columns, version and scope environment;
 * `identity_email` too when the database has it (`{identityEmail: true}`, the default: every database the tests build).
 */
export function settingsSql(idOrKey: string, opts: { identityEmail?: boolean } = {}): string {
  const columns = settingsColumns(opts.identityEmail ?? true).map((c) => `a.${c}`).join(', ');
  return `SELECT a.id, a.name, a.scope_id, a.org_id, a.settings_version, a.deleted_at, s.environment, ${columns} FROM apps a JOIN scopes s ON s.scope_id = a.scope_id WHERE ${sql`a.id = ${idOrKey} OR a.id IN (SELECT app_id FROM app_keys WHERE key = ${idOrKey})`}`;
}

/** Parses a duration such as `12h`, `23h50m`, `15m`, `90s` or `3600000ms`. A bare number is refused (ms or s?). */
export function parseDuration(value: string, flag: string): number {
  const m = /^(?:(\d{1,3})h)?(?:(\d{1,5})m)?(?:(\d{1,7})s)?$|^(\d{1,9})ms$/u.exec(value);
  if (!value || !m) throw new CliError(`--${flag} must be a duration such as 12h, 23h50m, 15m or 3600000ms, got ${JSON.stringify(value)}`);
  if (m[4] !== undefined) return Number(m[4]);
  return Number(m[1] ?? 0) * HOUR + Number(m[2] ?? 0) * MINUTE + Number(m[3] ?? 0) * 1000;
}

/** `43200000` → `12h`, `85800000` → `23h50m`, `900000` → `15m` (exact; leftover ms shown as such). */
export function formatDuration(ms: number): string {
  if (ms % 1000 !== 0) return `${ms}ms`;
  const h = Math.floor(ms / HOUR);
  const m = Math.floor((ms % HOUR) / MINUTE);
  const s = (ms % MINUTE) / 1000;
  return `${h ? `${h}h` : ''}${m ? `${m}m` : ''}${s ? `${s}s` : ''}` || '0s';
}

const at = (ms: number): string => new Date(ms).toISOString();

/**
 * The directory a relative `--auto-approve` path is relative to: where the operator ran the command. `pnpm --filter
 * @hana-id/scripts run admin …` runs the script from scripts/, and sets INIT_CWD to the directory pnpm was run from.
 */
export function invocationDir(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  return env.INIT_CWD && isAbsolute(env.INIT_CWD) ? env.INIT_CWD : cwd;
}

/** A policy path as given, made absolute against `baseDir` when relative. */
export function resolvePolicyPath(path: string, baseDir: string = invocationDir()): string {
  return resolve(baseDir, path);
}

/**
 * Reads the flags of one app:settings call. `readFile` returns the policy file's text; a relative policy path is
 * resolved against `baseDir` (default: where the command was run, see invocationDir).
 */
export function parseSettingsArgs(args: Args, readFile: (path: string) => string = readPolicyFile, baseDir: string = invocationDir()): SettingsChange {
  const change: SettingsChange = {};
  const persistence = args.str('persistence');
  if (persistence !== undefined) {
    if (persistence !== 'session' && persistence !== 'none') throw new CliError("--persistence must be 'session' or 'none'");
    change.persistence = persistence;
  }
  const sessionTtl = args.str('session-ttl');
  if (sessionTtl !== undefined) change.sessionTtlMs = parseDuration(sessionTtl, 'session-ttl');
  const idleTtl = args.str('idle-ttl');
  if (idleTtl !== undefined) change.idleTtlMs = parseDuration(idleTtl, 'idle-ttl');
  const rawSign = args.str('raw-sign');
  if (rawSign !== undefined) {
    if (rawSign !== 'off' && rawSign !== 'approval') throw new CliError("--raw-sign must be 'off' or 'approval'");
    change.rawSign = rawSign;
  }
  const client = args.str('google-web-client');
  if (client !== undefined) {
    if (client === DEFAULT_WEB_CLIENT) change.googleWebClient = null;
    else if (!client || client.length > 255 || /\s/u.test(client)) throw new CliError(`Invalid --google-web-client: ${JSON.stringify(client)}`);
    else change.googleWebClient = client;
  }
  const share = args.str('identity-email');
  if (share !== undefined) {
    if (!(IDENTITY_EMAIL_VALUES as readonly string[]).includes(share)) throw new CliError("--identity-email must be 'off', 'on_request' or 'at_login'");
    change.identityEmail = share as IdentityEmail;
  }
  const policy = args.str('auto-approve');
  if (policy !== undefined) {
    if (!policy) throw new CliError("--auto-approve needs a policy JSON file or 'off'");
    if (policy === 'off') change.autoApprove = 'off';
    else {
      const file = resolvePolicyPath(policy, baseDir);
      change.autoApprove = { text: readFile(file), file };
    }
  }
  return change;
}

/** The policy file's text, refused when it is not a regular file or is over POLICY_FILE_MAX_BYTES. */
export function readPolicyFile(path: string): string {
  let size: number;
  try {
    const st = statSync(path);
    if (!st.isFile()) throw new CliError(`--auto-approve ${path} is not a file ('off' removes the policy)`);
    size = st.size;
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(`Can't read --auto-approve ${path} ('off' removes the policy)`);
  }
  if (size > POLICY_FILE_MAX_BYTES) throw new CliError(`--auto-approve ${path} is over ${POLICY_FILE_MAX_BYTES} bytes`);
  return readFileSync(path, 'utf8');
}

/** Validates a stored or given policy text against a session TTL: the stored form, or the validator's problems. */
function validatePolicy(text: string, sessionTtlMs: number): { ok: true; policy: StoredPolicy } | { ok: false; problems: readonly string[] } {
  const result = parseAutoApprovePolicy(text, { sessionTtlMs });
  if (!result.ok) return result;
  return { ok: true, policy: { json: canonicalJson(result.policy), id: policyId(result.policy, { sessionTtlMs }), label: result.policy.label } };
}

/** The id of a stored policy, or null when it doesn't validate (the API never serves it then). */
function storedPolicyId(text: string | null): string | null {
  if (text === null) return null;
  const r = validatePolicy(text, SESSION_TTL_MAX_MS);
  return r.ok ? r.policy.id : null;
}

const matured = (pending: unknown, effectiveAt: number | null, now: number): boolean => pending !== null && effectiveAt !== null && now >= effectiveAt;

/** The raw_sign value in force at `now`, as the API's effectiveSettings computes it. */
export function rawSignInForce(row: SettingsRow, now: number): RawSign {
  return row.raw_sign === 'approval' || (row.raw_sign_pending === 'approval' && matured(row.raw_sign_pending, row.raw_sign_effective_at, now)) ? 'approval' : 'off';
}

/** The policy text in force at `now` (the pending one once matured), as the API's effectiveSettings picks it. */
export function policyInForce(row: SettingsRow, now: number): string | null {
  return matured(row.auto_approve_pending, row.auto_approve_effective_at, now) ? row.auto_approve_pending : row.auto_approve_policy;
}

export interface PlanContext {
  now: number;
  /** The scope's Google client ids on chain; read only when `--google-web-client` names a client. */
  scopeGoogleClients?: readonly string[];
  /** The app's pending and active guarded changes (admin-sql.ts openChangesSql). */
  openChanges?: readonly ChangeRow[];
  actor?: CliActor;
  /** The write's request id (its `app_changes` commit row). */
  requestId?: string;
  /** A new guarded change id (`gc_…`). */
  newChangeId?: () => string;
  /** How a proposal is announced in this env, printed under it. */
  announceHint?: (changeId: string) => string;
}

const DEFAULT_ACTOR: CliActor = { id: 'cli' };

/**
 * Checks a change against the row and builds the one write that applies it. Throws CliError for any value out of
 * range, and changes nothing then. Values already in force or already proposed are reported and not rewritten, so
 * re-running a command never restarts a pending delay.
 */
export function planSettings(row: SettingsRow, change: SettingsChange, ctx: PlanContext): SettingsPlan {
  const { now } = ctx;
  const open = ctx.openChanges ?? [];
  const actor = ctx.actor ?? DEFAULT_ACTOR;
  const requestId = ctx.requestId ?? `cli_${now}`;
  const newChangeId = ctx.newChangeId ?? (() => `gc_${now}`);
  const to = row.settings_version + 1;
  const when = committed(requestId);
  const set: string[] = [];
  const after: string[] = [];
  const lines: string[] = [];
  const warnings: string[] = [];
  const changed: Record<string, unknown> = {};
  const ledgerRows: { kind: string; detail: Record<string, unknown> }[] = [];
  // Pending and not yet in force (a change whose clock has passed is in force by predicate until the cron records it).
  const pendingOf = (kind: ChangeRow['kind']) => open.filter((c) => c.kind === kind && c.status === 'pending' && (c.active_from === null || c.active_from > now));
  const hint = (id: string) => {
    if (ctx.announceHint) lines.push(`  ${ctx.announceHint(id)}`);
  };

  if (change.persistence !== undefined) {
    if (change.persistence === row.persistence) lines.push(`persistence: already ${row.persistence}`);
    else {
      set.push(sql`persistence = ${change.persistence}`);
      changed.persistence = change.persistence;
      lines.push(`persistence: ${row.persistence} → ${change.persistence} (immediate)`);
      if (change.persistence === 'none') lines.push('  New logins store no share, so a reload needs a new login. Existing shares are revoked on their next unlock or touch.');
    }
  }

  const sessionTtl = change.sessionTtlMs ?? row.session_ttl_ms;
  const idleTtl = change.idleTtlMs ?? row.idle_ttl_ms;
  if (change.sessionTtlMs !== undefined && (sessionTtl < SESSION_TTL_MIN_MS || sessionTtl > SESSION_TTL_MAX_MS)) {
    throw new CliError(`--session-ttl must be between ${formatDuration(SESSION_TTL_MIN_MS)} and ${formatDuration(SESSION_TTL_MAX_MS)} (got ${formatDuration(sessionTtl)})`);
  }
  if (idleTtl < IDLE_TTL_MIN_MS || idleTtl > sessionTtl) {
    throw new CliError(
      change.idleTtlMs !== undefined
        ? `--idle-ttl must be between ${formatDuration(IDLE_TTL_MIN_MS)} and the session TTL ${formatDuration(sessionTtl)} (got ${formatDuration(idleTtl)})`
        : `The idle TTL ${formatDuration(idleTtl)} would exceed --session-ttl ${formatDuration(sessionTtl)}: pass --idle-ttl too`,
    );
  }
  for (const [column, before, value] of [
    ['session_ttl_ms', row.session_ttl_ms, change.sessionTtlMs],
    ['idle_ttl_ms', row.idle_ttl_ms, change.idleTtlMs],
  ] as const) {
    if (value === undefined) continue;
    const name = column === 'session_ttl_ms' ? 'session TTL' : 'idle TTL';
    if (value === before) lines.push(`${name}: already ${formatDuration(before)}`);
    else {
      set.push(column === 'session_ttl_ms' ? sql`session_ttl_ms = ${value}` : sql`idle_ttl_ms = ${value}`);
      changed[column === 'session_ttl_ms' ? 'sessionTtlMs' : 'idleTtlMs'] = value;
      lines.push(`${name}: ${formatDuration(before)} → ${formatDuration(value)} (immediate; ${column === 'session_ttl_ms' ? value < before ? 'live shares also end at their creation + the new TTL' : 'live shares keep their expiry; new logins get the new TTL' : 'applies from each share’s next unlock or touch'})`);
    }
  }

  const rawPending = pendingOf('raw_sign_on');
  if (change.rawSign === 'off') {
    if (row.raw_sign === 'off' && row.raw_sign_pending === null && !open.some((c) => c.kind === 'raw_sign_on')) lines.push('raw signing: already off');
    else {
      set.push(sql`raw_sign = ${'off'}`, 'raw_sign_pending = NULL', 'raw_sign_effective_at = NULL');
      after.push(closeChangesSql(row.id, 'raw_sign_on', 'all', { now, actor }, when));
      ledgerRows.push({ kind: 'raw_sign.off', detail: { cancelled: rawPending.map((c) => c.id) } });
      const waiting = (row.raw_sign_pending !== null && !matured(row.raw_sign_pending, row.raw_sign_effective_at, now)) || rawPending.length > 0;
      lines.push(`raw signing: ${rawSignInForce(row, now)}${waiting ? ' (approval pending)' : ''} → off (immediate)`);
    }
  } else if (change.rawSign === 'approval') {
    if (row.environment === 'test') throw new CliError('--raw-sign approval is refused for a test app: test apps never sign raw (D39, as amended 2026-10-28)');
    warnings.push(RAW_SIGN_WARNING);
    if (rawSignInForce(row, now) === 'approval') lines.push('raw signing: already approval');
    else if (row.raw_sign_pending === 'approval' && row.raw_sign_effective_at !== null) {
      lines.push(`raw signing: approval already pending, in force from ${at(row.raw_sign_effective_at)} (delay not restarted)`);
    } else if (rawPending.length) {
      lines.push(`raw signing: approval already proposed as ${rawPending[0]!.id}, waiting for its announcement (delay not restarted)`);
    } else {
      const changeId = newChangeId();
      after.push(proposalSql({ changeId, appId: row.id, kind: 'raw_sign_on', policyJson: null, policyId: null }, { now, actor, requestId }, when));
      ledgerRows.push({ kind: 'raw_sign.proposed', detail: { changeId } });
      lines.push(`raw signing: off → approval proposed as ${changeId} (a staff proposal: in force appChangeDelayMs after it is announced)`);
      hint(changeId);
    }
  }

  if (change.googleWebClient !== undefined) {
    const client = change.googleWebClient;
    if (client === row.google_web_client_id) lines.push(`Google web client: already ${client ?? 'the scope’s first Google client'}`);
    else {
      if (client !== null && !(ctx.scopeGoogleClients ?? []).includes(client)) {
        const known = ctx.scopeGoogleClients?.length ? ctx.scopeGoogleClients.join(', ') : 'none';
        throw new CliError(`${client} is not one of scope ${row.scope_id}'s Google clients on chain (${known})`);
      }
      set.push(sql`google_web_client_id = ${client}`);
      changed.googleWebClientId = client;
      lines.push(`Google web client: ${row.google_web_client_id ?? 'the scope’s first'} → ${client ?? 'the scope’s first Google client'} (immediate)`);
    }
  }

  if (change.identityEmail !== undefined) {
    if (row.identity_email === undefined) throw new CliError(IDENTITY_EMAIL_NEEDS_0012);
    const before = identityEmailOf(row);
    if (change.identityEmail === row.identity_email) lines.push(`email sharing: already ${IDENTITY_EMAIL_LABEL[before]}`);
    else {
      set.push(sql`identity_email = ${change.identityEmail}`);
      changed.identityEmail = change.identityEmail;
      lines.push(
        `email sharing: ${IDENTITY_EMAIL_LABEL[before]} → ${IDENTITY_EMAIL_LABEL[change.identityEmail]} (immediate; ${
          change.identityEmail === 'off'
            ? 'Hana stops asking and new identity tokens carry no email, the vault’s 30 s app cache aside'
            : 'nothing is shared until a user agrees on Hana’s sheet'
        })`,
      );
    }
  }

  // A new policy is validated against the session TTL in force after this change (maxConsentMs ≤ session_ttl_ms).
  const inForce = policyInForce(row, now);
  const policyPending = pendingOf('policy_set');
  if (change.autoApprove === 'off') {
    if (row.auto_approve_policy === null && row.auto_approve_pending === null && !open.some((c) => c.kind === 'policy_set')) lines.push('auto-approve: already off');
    else {
      set.push('auto_approve_policy = NULL', 'auto_approve_pending = NULL', 'auto_approve_effective_at = NULL');
      after.push(closeChangesSql(row.id, 'policy_set', 'all', { now, actor }, when));
      ledgerRows.push({ kind: 'policy.removed', detail: { cancelled: policyPending.map((c) => c.id) } });
      lines.push('auto-approve: policy removed (immediate); every request gets the approval popup, and users’ consents lapse');
    }
  } else if (change.autoApprove !== undefined) {
    const result = validatePolicy(change.autoApprove.text, sessionTtl);
    if (!result.ok) throw new CliError(`--auto-approve ${change.autoApprove.file} is not a valid AutoApprovePolicyV1:\n  ${result.problems.join('\n  ')}`);
    const policy = result.policy;
    const pendingOpen = row.auto_approve_pending !== null && !matured(row.auto_approve_pending, row.auto_approve_effective_at, now);
    const proposedSame = policyPending.find((c) => c.policy_id === policy.id);
    if (storedPolicyId(inForce) === policy.id) {
      lines.push(`auto-approve: policy ${policy.id} ("${policy.label}") already in force`);
      if (pendingOpen || policyPending.length) {
        // Re-setting the policy in force cancels a pending change to another one. The policy in force may be a
        // matured pending one the cron hasn't promoted yet: it becomes the stored one before the pending columns are
        // cleared (in the statement itself, from the row as D1 holds it; SET expressions all read the old row), so
        // clearing them never brings an older stored policy back with no delay.
        set.push(
          sql`auto_approve_policy = CASE WHEN auto_approve_pending IS NOT NULL AND auto_approve_effective_at <= ${now} THEN auto_approve_pending ELSE auto_approve_policy END`,
          'auto_approve_pending = NULL',
          'auto_approve_effective_at = NULL',
        );
        after.push(closeChangesSql(row.id, 'policy_set', 'not_in_force', { now, actor }, when));
        ledgerRows.push({ kind: 'policy.pending_dropped', detail: { cancelled: policyPending.map((c) => c.id) } });
        lines.push('  The pending policy is dropped.');
      }
    } else if (proposedSame) {
      lines.push(
        proposedSame.active_from !== null
          ? `auto-approve: policy ${policy.id} ("${policy.label}") already pending as ${proposedSame.id}, in force from ${at(proposedSame.active_from)} (delay not restarted)`
          : `auto-approve: policy ${policy.id} ("${policy.label}") already proposed as ${proposedSame.id}, waiting for its announcement (delay not restarted)`,
      );
    } else if (policyPending.length) {
      throw new CliError(
        `Another policy is pending (${policyPending.map((c) => c.id).join(', ')}): at most one per app. Cancel it first (--auto-approve off, or set the policy in force again).`,
      );
    } else if (pendingOpen && storedPolicyId(row.auto_approve_pending) === policy.id && row.auto_approve_effective_at !== null) {
      lines.push(`auto-approve: policy ${policy.id} ("${policy.label}") already pending, in force from ${at(row.auto_approve_effective_at)} (delay not restarted)`);
    } else {
      const changeId = newChangeId();
      after.push(proposalSql({ changeId, appId: row.id, kind: 'policy_set', policyJson: policy.json, policyId: policy.id }, { now, actor, requestId }, when));
      ledgerRows.push({ kind: 'policy.proposed', detail: { changeId, policyId: policy.id } });
      lines.push(`auto-approve: policy ${policy.id} ("${policy.label}") from ${change.autoApprove.file}, proposed as ${changeId} (a staff proposal: in force appChangeDelayMs after it is announced)`);
      lines.push(inForce === null ? '  Until then no policy is in force.' : `  Until then the policy in force (${storedPolicyId(inForce) ?? 'unreadable'}) stays.`);
      lines.push('  Each user accepts the new policy in a Hana popup before it auto-approves anything.');
      hint(changeId);
    }
  }

  // Policies that stay stored or proposed must fit a lowered session TTL too, or the API would stop serving them.
  if (change.sessionTtlMs !== undefined && change.autoApprove !== 'off') {
    const kept = [inForce, ...(change.autoApprove === undefined ? [row.auto_approve_pending, ...policyPending.map((c) => c.policy_json)] : [])].filter((t): t is string => t !== null);
    for (const text of kept) {
      if (validatePolicy(text, SESSION_TTL_MAX_MS).ok && !validatePolicy(text, sessionTtl).ok) {
        throw new CliError(`A stored or proposed auto-approve policy has maxConsentMs over the new session TTL ${formatDuration(sessionTtl)}: set a new policy (--auto-approve) or remove it (--auto-approve off) first`);
      }
    }
  }

  if (Object.keys(changed).length) ledgerRows.unshift({ kind: 'settings.changed', detail: changed });
  if (!set.length && !after.length) return { write: null, lines, warnings };
  // The guard: this app, its version and every settings column still as read. The write's one app_changes row is
  // inserted only while it holds; then the UPDATE (the version bump and the immediate values) and the rest run only if
  // that row exists (admin-sql.ts "writes").
  const guard = { where: `${unchangedSince(row)} AND ${sql`settings_version = ${row.settings_version}`} AND deleted_at IS NULL`, set: [sql`settings_version = ${to}`, ...set] };
  const commitRow = ledgerRows.length === 1 ? ledgerRows[0]! : { kind: 'settings.changed', detail: { parts: ledgerRows } };
  return { write: settingsWrite(row, guard, commitRow, after, { now, actor, requestId }), lines, warnings };
}

/**
 * The guard's condition: this app, with every settings column still as it was read. The read and the write are
 * separate `wrangler d1 execute` calls, so another operator's change in between (say `--auto-approve off`) would
 * otherwise be overwritten with values planned from the old row, putting a removed policy back in force with no
 * delay. With the guard such a write changes nothing, and appSettings reports it.
 */
export function unchangedSince(row: SettingsRow): string {
  const columns = settingsColumns(row.identity_email !== undefined) as (keyof SettingsRow)[];
  return [`id = ${sqlValue(row.id)}`, ...columns.map((c) => `${c} IS ${sqlValue(row[c] as string | number | null)}`)].join(' AND ');
}

/** The error when the guarded UPDATE matched no row. */
export const SETTINGS_CHANGED = "The app's settings changed since they were read (another admin:settings or a D1 edit): nothing was written. Run the command again to see and change the current settings.";

/** The row's email sharing setting; anything but the two others reads as off (as the API reads it). */
const identityEmailOf = (row: SettingsRow): IdentityEmail => (row.identity_email === 'on_request' || row.identity_email === 'at_login' ? row.identity_email : 'off');

/** The settings as stored and in force, for `app:settings <app>` with no setting flags. */
export function describeSettings(row: SettingsRow, now: number, openChanges: readonly ChangeRow[] = []): string[] {
  const out = [
    `persistence: ${row.persistence}`,
    `session TTL: ${formatDuration(row.session_ttl_ms)}`,
    `idle TTL: ${formatDuration(row.idle_ttl_ms)}`,
    `raw signing: ${rawSignInForce(row, now)}${row.raw_sign_pending !== null && row.raw_sign_effective_at !== null && !matured(row.raw_sign_pending, row.raw_sign_effective_at, now) ? ` (approval pending until ${at(row.raw_sign_effective_at)})` : ''}`,
    `Google web client: ${row.google_web_client_id ?? 'the scope’s first Google client'}`,
    `Email sharing: ${row.identity_email === undefined ? 'not available (migration 0012 not applied to this hot D1)' : IDENTITY_EMAIL_LABEL[identityEmailOf(row)]}`,
  ];
  const inForce = policyInForce(row, now);
  const policyText = (text: string) => {
    const r = validatePolicy(text, row.session_ttl_ms);
    return r.ok ? `${r.policy.id} ("${r.policy.label}")` : `INVALID, not served (${r.problems[0] ?? 'unknown problem'})`;
  };
  out.push(`auto-approve: ${inForce === null ? 'off' : policyText(inForce)}`);
  if (row.auto_approve_pending !== null && row.auto_approve_effective_at !== null && !matured(row.auto_approve_pending, row.auto_approve_effective_at, now)) {
    out.push(`  pending until ${at(row.auto_approve_effective_at)}: ${policyText(row.auto_approve_pending)}`);
  }
  for (const c of openChanges) {
    if (c.status !== 'pending' || c.kind === 'origin_add') continue;
    const what = c.kind === 'policy_set' ? `policy ${c.policy_id}` : 'raw signing approval';
    out.push(`proposed: ${c.id} ${what}, ${c.active_from === null ? 'not announced yet' : `in force from ${at(c.active_from)}`}`);
  }
  return out;
}

export interface AppSettingsDeps {
  /** Runs SQL on the env's D1 (local or remote) and returns the rows. */
  d1: (statement: string) => Record<string, unknown>[];
  /** The scope's [provider, aud] clients on chain, or null for an unregistered scope. */
  scopeClients: (scopeId: string) => Promise<[string, string][] | null>;
  readFile: (path: string) => string;
  /** The directory relative `--auto-approve` paths are resolved against (default: invocationDir()). */
  baseDir?: string;
  now: () => number;
  log: (line: string) => void;
  /** Who writes (`cli:<login>`), a new request id and a new guarded change id (admin-apps.ts cliIds). */
  actor?: CliActor;
  newRequestId?: () => string;
  newChangeId?: () => string;
  /** Throws unless the deployed API reads the batch C3 schema; asked only before a write that proposes (admin-apps.ts). */
  requireC3Api?: () => Promise<void>;
}

/**
 * `get_scope`'s answer → the scope's `[provider, aud]` clients: null for an unregistered scope (a null view), and only
 * well-formed string pairs (anything else in `clients` is dropped, a missing or non-array `clients` is none).
 */
export function scopeClientsFrom(scope: unknown): [string, string][] | null {
  if (scope === null || scope === undefined) return null;
  const clients = typeof scope === 'object' && !Array.isArray(scope) ? (scope as { clients?: unknown }).clients : undefined;
  return (Array.isArray(clients) ? clients : []).filter(
    (c): c is [string, string] => Array.isArray(c) && c.length === 2 && typeof c[0] === 'string' && typeof c[1] === 'string',
  );
}

/** The Google client ids among a scope's clients (what `--google-web-client` may name). */
export function googleClientIds(clients: readonly [string, string][]): string[] {
  return clients.filter(([p]) => p === GOOGLE_PROVIDER).map(([, aud]) => aud);
}

/**
 * The app an app:settings call names: positionally (`app:settings <app>`) or with `--app`, exactly one of the two.
 * `rest` is the positionals after `<env> <command>`.
 */
export function settingsAppArg(rest: readonly string[], appFlag: string | undefined): string {
  if (rest.length > 1) throw new CliError(`Unexpected argument ${rest.slice(1).join(' ')}`);
  const positional = rest[0];
  if (positional !== undefined && appFlag !== undefined) throw new CliError('app:settings takes one app: <app id | publishable key> or --app, not both');
  const app = positional ?? appFlag;
  if (!app) throw new CliError('app:settings takes one app: <app id | publishable key> or --app');
  return app;
}

export function defaultAppSettingsDeps(m: Manifest, remote: boolean): AppSettingsDeps {
  return {
    d1: (statement) => d1Execute(m, statement, { remote }),
    scopeClients: async (scopeId) => scopeClientsFrom(await tryView<unknown>(new NearRpc(m.rpc), m.signer, 'get_scope', { scope_id: scopeId })),
    readFile: readPolicyFile,
    now: () => Date.now(),
    log: (line) => console.log(line),
  };
}

/** app:settings <app> [flags]: shows the settings, or checks and applies the flags given and prints what changed. */
export async function appSettings(m: Manifest, idOrKey: string, args: Args, where: string, deps: AppSettingsDeps): Promise<void> {
  const identityEmail = Number(deps.d1(IDENTITY_EMAIL_COLUMN_SQL)[0]?.n ?? 0) > 0;
  const rows = deps.d1(settingsSql(idOrKey, { identityEmail })) as unknown as SettingsRow[];
  if (rows.length !== 1 || !rows[0]) throw new Error(`No app ${idOrKey}`);
  const row = rows[0];
  const change = parseSettingsArgs(args, deps.readFile, deps.baseDir ?? invocationDir());
  const now = deps.now();
  const header = `${row.id} "${row.name}" (scope ${row.scope_id}, ${where})`;
  const openChanges = deps.d1(openChangesSql(row.id)) as unknown as ChangeRow[];
  if (!Object.keys(change).length) {
    deps.log(header);
    for (const line of describeSettings(row, now, openChanges)) deps.log(`  ${line}`);
    return;
  }
  if (row.deleted_at !== null) throw new Error(`App ${row.id} is deleted`);

  let scopeGoogleClients: string[] | undefined;
  if (typeof change.googleWebClient === 'string' && change.googleWebClient !== row.google_web_client_id) {
    const clients = await deps.scopeClients(row.scope_id);
    if (clients === null) throw new Error(`Scope ${row.scope_id} is not registered on ${m.signer}`);
    scopeGoogleClients = googleClientIds(clients);
  }
  const plan = planSettings(row, change, {
    now,
    scopeGoogleClients,
    openChanges,
    actor: deps.actor,
    requestId: deps.newRequestId?.(),
    newChangeId: deps.newChangeId,
    announceHint: (id) => announceHint(m, id),
  });
  for (const w of plan.warnings) deps.log(w);
  if (plan.write) {
    // A proposal needs the deployed API at batch C3 or later (admin-apps.ts requireC3ApiFor).
    if (plan.write.statements.some((st) => st.startsWith('INSERT INTO guarded_changes'))) await deps.requireC3Api?.();
    const result = deps.d1(writeCommand(plan.write));
    if (Number(result[result.length - 1]?.committed ?? 0) !== 1) throw new Error(SETTINGS_CHANGED);
  }
  // The change log: when, which app, where, and every line (no policy body, only its id and label).
  deps.log(`${at(now)} app:settings ${header}${plan.write ? '' : ': no change'}`);
  for (const line of plan.lines) deps.log(`  ${line}`);
}

/** How a staff proposal is announced in this env (printed with it). */
export function announceHint(m: Pick<Manifest, 'name' | 'admin'>, changeId: string): string {
  return m.admin
    ? 'The admin Worker emails the notice; the appChangeDelayMs clock starts once it is accepted.'
    : `No admin Worker in ${m.name}: announce it with admin.ts ${m.name} app:changes:announce ${changeId} (nobody is emailed).`;
}
