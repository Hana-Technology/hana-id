// admin.ts app:settings: the per-app vault settings (docs/batch-b-spec.md "App settings"), in the `apps` columns of
// migration 0003, until the batch C dashboard takes over. Every range is checked here and again by the migration's
// CHECKs; `--google-web-client` must be one of the scope's on-chain Google clients; an auto-approve policy must pass
// @hana-id/core's validateAutoApprovePolicy (the same validator the API and the vault run).
//
// Loosening is delayed, tightening is immediate: `--raw-sign approval` and a new or changed `--auto-approve` policy are
// written as pending values that apply from `effective_at` (24 h; the manifest's changeDelayMs in local*/sandbox*
// envs); `--raw-sign off` and `--auto-approve off` take effect at once and drop any pending value.
import { readFileSync, statSync } from 'node:fs';
import { canonicalJson, parseAutoApprovePolicy, policyId } from '@hana-id/core/policy';
import { isDevEnv, type Manifest } from '@hana-id/env';
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
/** Delay before `raw_sign = 'approval'` or a new auto-approve policy applies, outside `local*` and `sandbox*` envs. */
export const RAW_SIGN_DELAY_MS = 24 * HOUR;
/** Largest policy file read (the validator caps the canonical JSON at 16 KiB). */
export const POLICY_FILE_MAX_BYTES = 64 * 1024;
/** `--google-web-client default`: no pinned client, GET /v1/app uses the scope's first Google client. */
export const DEFAULT_WEB_CLIENT = 'default';

export const RAW_SIGN_WARNING =
  'WARNING: raw signing lets the app ask the user to sign arbitrary bytes, which can authorize any transaction on that chain. Every raw signature still needs an Approve click in a Hana popup.';

export type Persistence = 'session' | 'none';
export type RawSign = 'off' | 'approval';

export interface SettingsRow {
  id: string;
  name: string;
  scope_id: string;
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
}

/** The UPDATE to run (null when nothing changes) and what to print. */
export interface SettingsPlan {
  sql: string | null;
  lines: string[];
  warnings: string[];
}

const SETTINGS_COLUMNS =
  'persistence, session_ttl_ms, idle_ttl_ms, raw_sign, raw_sign_pending, raw_sign_effective_at, auto_approve_policy, auto_approve_pending, auto_approve_effective_at, google_web_client_id';

/** The app (by id or publishable key) with its settings columns. */
export function settingsSql(idOrKey: string): string {
  return `SELECT id, name, scope_id, ${SETTINGS_COLUMNS} FROM apps WHERE ${sql`id = ${idOrKey} OR publishable_key = ${idOrKey}`}`;
}

/** The change delay for this env: 24 h, or the manifest's changeDelayMs in `local*` and `sandbox*` envs. */
export function changeDelayMsFor(m: Pick<Manifest, 'name' | 'changeDelayMs'>): number {
  return isDevEnv(m.name) ? m.changeDelayMs : RAW_SIGN_DELAY_MS;
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

/** Reads the flags of one app:settings call. `readFile` returns the policy file's text. */
export function parseSettingsArgs(args: Args, readFile: (path: string) => string = readPolicyFile): SettingsChange {
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
  const policy = args.str('auto-approve');
  if (policy !== undefined) {
    if (!policy) throw new CliError("--auto-approve needs a policy JSON file or 'off'");
    change.autoApprove = policy === 'off' ? 'off' : { text: readFile(policy), file: policy };
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
  delayMs: number;
  /** The scope's Google client ids on chain; read only when `--google-web-client` names a client. */
  scopeGoogleClients?: readonly string[];
}

/**
 * Checks a change against the row and builds the one UPDATE that applies it. Throws CliError for any value out of
 * range, and changes nothing then. Values already in force are reported and not rewritten, so re-running a command
 * never restarts a pending delay.
 */
export function planSettings(row: SettingsRow, change: SettingsChange, ctx: PlanContext): SettingsPlan {
  const { now, delayMs } = ctx;
  const set: string[] = [];
  const lines: string[] = [];
  const warnings: string[] = [];

  if (change.persistence !== undefined) {
    if (change.persistence === row.persistence) lines.push(`persistence: already ${row.persistence}`);
    else {
      set.push(sql`persistence = ${change.persistence}`);
      lines.push(`persistence: ${row.persistence} → ${change.persistence} (immediate)`);
      if (change.persistence === 'none') lines.push('  New logins store no share, so a reload needs a new login. Existing shares last until they expire or are revoked.');
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
  for (const [column, before, after] of [
    ['session_ttl_ms', row.session_ttl_ms, change.sessionTtlMs],
    ['idle_ttl_ms', row.idle_ttl_ms, change.idleTtlMs],
  ] as const) {
    if (after === undefined) continue;
    const name = column === 'session_ttl_ms' ? 'session TTL' : 'idle TTL';
    if (after === before) lines.push(`${name}: already ${formatDuration(before)}`);
    else {
      set.push(column === 'session_ttl_ms' ? sql`session_ttl_ms = ${after}` : sql`idle_ttl_ms = ${after}`);
      lines.push(`${name}: ${formatDuration(before)} → ${formatDuration(after)} (immediate; applies to logins from now on)`);
    }
  }

  if (change.rawSign === 'off') {
    if (row.raw_sign === 'off' && row.raw_sign_pending === null) lines.push('raw signing: already off');
    else {
      set.push(sql`raw_sign = ${'off'}`, 'raw_sign_pending = NULL', 'raw_sign_effective_at = NULL');
      lines.push(`raw signing: ${rawSignInForce(row, now)}${row.raw_sign_pending !== null && !matured(row.raw_sign_pending, row.raw_sign_effective_at, now) ? ' (approval pending)' : ''} → off (immediate)`);
    }
  } else if (change.rawSign === 'approval') {
    warnings.push(RAW_SIGN_WARNING);
    if (rawSignInForce(row, now) === 'approval') lines.push('raw signing: already approval');
    else if (row.raw_sign_pending === 'approval' && row.raw_sign_effective_at !== null) {
      lines.push(`raw signing: approval already pending, in force from ${at(row.raw_sign_effective_at)} (delay not restarted)`);
    } else {
      const effectiveAt = now + delayMs;
      set.push(sql`raw_sign_pending = ${'approval'}`, sql`raw_sign_effective_at = ${effectiveAt}`);
      lines.push(`raw signing: off → approval, pending until ${at(effectiveAt)} (${formatDuration(delayMs)} delay)`);
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
      lines.push(`Google web client: ${row.google_web_client_id ?? 'the scope’s first'} → ${client ?? 'the scope’s first Google client'} (immediate)`);
    }
  }

  // A new policy is validated against the session TTL in force after this change (maxConsentMs ≤ session_ttl_ms).
  const inForce = policyInForce(row, now);
  if (change.autoApprove === 'off') {
    if (row.auto_approve_policy === null && row.auto_approve_pending === null) lines.push('auto-approve: already off');
    else {
      set.push('auto_approve_policy = NULL', 'auto_approve_pending = NULL', 'auto_approve_effective_at = NULL');
      lines.push('auto-approve: policy removed (immediate); every request gets the approval popup, and users’ consents lapse');
    }
  } else if (change.autoApprove !== undefined) {
    const result = validatePolicy(change.autoApprove.text, sessionTtl);
    if (!result.ok) throw new CliError(`--auto-approve ${change.autoApprove.file} is not a valid AutoApprovePolicyV1:\n  ${result.problems.join('\n  ')}`);
    const policy = result.policy;
    const pendingOpen = row.auto_approve_pending !== null && !matured(row.auto_approve_pending, row.auto_approve_effective_at, now);
    if (storedPolicyId(inForce) === policy.id) {
      lines.push(`auto-approve: policy ${policy.id} ("${policy.label}") already in force`);
      if (pendingOpen) {
        // Re-setting the policy in force cancels a pending change to another one.
        set.push(sql`auto_approve_policy = ${inForce}`, 'auto_approve_pending = NULL', 'auto_approve_effective_at = NULL');
        lines.push('  The pending policy is dropped.');
      }
    } else if (pendingOpen && storedPolicyId(row.auto_approve_pending) === policy.id && row.auto_approve_effective_at !== null) {
      lines.push(`auto-approve: policy ${policy.id} ("${policy.label}") already pending, in force from ${at(row.auto_approve_effective_at)} (delay not restarted)`);
    } else {
      const effectiveAt = now + delayMs;
      // A pending policy that has matured is in force: it becomes the stored policy before the new one is pending
      // (in the statement itself, so the decision uses the row as D1 holds it).
      set.push(
        sql`auto_approve_policy = CASE WHEN auto_approve_pending IS NOT NULL AND auto_approve_effective_at <= ${now} THEN auto_approve_pending ELSE auto_approve_policy END`,
        sql`auto_approve_pending = ${policy.json}`,
        sql`auto_approve_effective_at = ${effectiveAt}`,
      );
      lines.push(`auto-approve: policy ${policy.id} ("${policy.label}") pending until ${at(effectiveAt)} (${formatDuration(delayMs)} delay)`);
      lines.push(inForce === null ? '  Until then no policy is in force.' : `  Until then the policy in force (${storedPolicyId(inForce) ?? 'unreadable'}) stays.`);
      lines.push('  Each user accepts the new policy in a Hana popup before it auto-approves anything.');
    }
  }

  // Policies that stay stored must fit a lowered session TTL too, or the API would stop serving them.
  if (change.sessionTtlMs !== undefined && change.autoApprove !== 'off') {
    const kept = [change.autoApprove === undefined ? row.auto_approve_pending : null, inForce].filter((t): t is string => t !== null);
    for (const text of kept) {
      if (validatePolicy(text, SESSION_TTL_MAX_MS).ok && !validatePolicy(text, sessionTtl).ok) {
        throw new CliError(`A stored auto-approve policy has maxConsentMs over the new session TTL ${formatDuration(sessionTtl)}: set a new policy (--auto-approve) or remove it (--auto-approve off) first`);
      }
    }
  }

  return { sql: set.length ? `UPDATE apps SET ${set.join(', ')} WHERE id = ${sqlValue(row.id)}` : null, lines, warnings };
}

/** The settings as stored and in force, for `app:settings <app>` with no setting flags. */
export function describeSettings(row: SettingsRow, now: number): string[] {
  const out = [
    `persistence: ${row.persistence}`,
    `session TTL: ${formatDuration(row.session_ttl_ms)}`,
    `idle TTL: ${formatDuration(row.idle_ttl_ms)}`,
    `raw signing: ${rawSignInForce(row, now)}${row.raw_sign_pending !== null && row.raw_sign_effective_at !== null && !matured(row.raw_sign_pending, row.raw_sign_effective_at, now) ? ` (approval pending until ${at(row.raw_sign_effective_at)})` : ''}`,
    `Google web client: ${row.google_web_client_id ?? 'the scope’s first Google client'}`,
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
  return out;
}

export interface AppSettingsDeps {
  /** Runs SQL on the env's D1 (local or remote) and returns the rows. */
  d1: (statement: string) => Record<string, unknown>[];
  /** The scope's [provider, aud] clients on chain, or null for an unregistered scope. */
  scopeClients: (scopeId: string) => Promise<[string, string][] | null>;
  readFile: (path: string) => string;
  now: () => number;
  log: (line: string) => void;
}

export function defaultAppSettingsDeps(m: Manifest, remote: boolean): AppSettingsDeps {
  return {
    d1: (statement) => d1Execute(m, statement, { remote }),
    scopeClients: async (scopeId) => {
      const scope = await tryView<{ clients?: unknown }>(new NearRpc(m.rpc), m.signer, 'get_scope', { scope_id: scopeId });
      if (!scope) return null;
      return (Array.isArray(scope.clients) ? scope.clients : []).filter(
        (c): c is [string, string] => Array.isArray(c) && c.length === 2 && typeof c[0] === 'string' && typeof c[1] === 'string',
      );
    },
    readFile: readPolicyFile,
    now: () => Date.now(),
    log: (line) => console.log(line),
  };
}

/** app:settings <app> [flags]: shows the settings, or checks and applies the flags given and prints what changed. */
export async function appSettings(m: Manifest, idOrKey: string, args: Args, where: string, deps: AppSettingsDeps): Promise<void> {
  const rows = deps.d1(settingsSql(idOrKey)) as unknown as SettingsRow[];
  if (rows.length !== 1 || !rows[0]) throw new Error(`No app ${idOrKey}`);
  const row = rows[0];
  const change = parseSettingsArgs(args, deps.readFile);
  const now = deps.now();
  const header = `${row.id} "${row.name}" (scope ${row.scope_id}, ${where})`;
  if (!Object.keys(change).length) {
    deps.log(header);
    for (const line of describeSettings(row, now)) deps.log(`  ${line}`);
    return;
  }

  let scopeGoogleClients: string[] | undefined;
  if (typeof change.googleWebClient === 'string' && change.googleWebClient !== row.google_web_client_id) {
    const clients = await deps.scopeClients(row.scope_id);
    if (clients === null) throw new Error(`Scope ${row.scope_id} is not registered on ${m.signer}`);
    scopeGoogleClients = clients.filter(([p]) => p === GOOGLE_PROVIDER).map(([, aud]) => aud);
  }
  const plan = planSettings(row, change, { now, delayMs: changeDelayMsFor(m), scopeGoogleClients });
  for (const w of plan.warnings) deps.log(w);
  if (plan.sql) deps.d1(plan.sql);
  // The change log: when, which app, where, and every line (no policy body, only its id and label).
  deps.log(`${at(now)} app:settings ${header}${plan.sql ? '' : ': no change'}`);
  for (const line of plan.lines) deps.log(`  ${line}`);
}
