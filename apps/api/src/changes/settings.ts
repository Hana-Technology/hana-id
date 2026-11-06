// Settings writes (docs/batch-c-spec.md "Other app settings, name and logo", "Policy and raw-signing input rules"),
// each a compare-and-swap on `settings_version` that bumps it:
// - updateSettings: persistence, session and idle TTLs (batch B's ranges), the Google web client (one of the scope's
//   on-chain Google clients, read uncached), the name, `identity_email` (D411: turning it on shares nothing until a
//   user agrees, off stops every email at once); immediate;
// - setLogo: the `logo_key` pointer only (the console uploads and re-encodes, batch C11); immediate;
// - turnOff: the policy removed or raw signing off, immediate, any pending value dropped and the guarded changes
//   ended or cancelled (a kill switch: no step-up, not counted by the breaker);
// - proposeChange: a policy set or raw-signing enable as a pending guarded change, nothing in `apps` until its notice
//   is acked (lifecycle.ts): a staff proposal (AdminRpc) or a member's with the API-verified step-up (ConsoleRpc,
//   changes/step-up.ts, the settings-change layout over the policyId and the stored settings_version).
import { LOGO_KEY_RE, newId, nonceOf, normaliseAppName, settingsChangeDigest } from '@hana-id/console-core';
import type { Env } from '../env.ts';
import { IDLE_TTL_MIN_MS, SESSION_TTL_MAX_MS, SESSION_TTL_MIN_MS } from '../vault/settings.ts';
import { expectVersion, planApp } from './apps.ts';
import { type Writer, actorId, closeChanges, commitOnApp, committed, NOT_YET, refuse, runWrite, expectReplay } from './cas.ts';
import { scopeGoogleClients } from './chain.ts';
import type { HotDb } from './db.ts';
import { requireChangeConfig } from './origins.ts';
import { fitsTtl, pendingPolicy, policyInForce, rawSignInForce, storedPolicy, validatePolicy } from './policy.ts';
import { type Q, join, q, raw } from './sql.ts';
import { type StepUpToken, confirmStepUp, releaseStepUp, verifyStepUpToken } from './step-up.ts';
import { type ChangeRow, changeView } from './views.ts';

/** An app name as stored: NFC, trimmed, 1..64 characters, one display-safe line (console-core normaliseAppName). */
export function appName(input: string): string {
  const r = normaliseAppName(input);
  return r.ok ? r.name : refuse('bad_request', r.problem);
}

export interface SettingsInput {
  orgId: string | null;
  appId: string;
  expectedVersion: number;
  persistence?: 'session' | 'none';
  sessionTtlMs?: number;
  idleTtlMs?: number;
  googleWebClientId?: string | null;
  name?: string;
  identityEmail?: 'off' | 'on_request' | 'at_login';
}

export async function updateSettings(db: HotDb, env: Env, w: Writer, i: SettingsInput): Promise<{ version: number }> {
  expectReplay(w, ['settings.changed', 'app.renamed']);
  const plan = await planApp(db, { appId: i.appId, orgId: i.orgId, w, with: { changes: true } });
  const a = plan.app;
  expectVersion(a.settings_version, i.expectedVersion);
  const set: Q[] = [];
  const changed: Record<string, unknown> = {};
  if (i.persistence !== undefined && i.persistence !== a.persistence) {
    set.push(q`persistence = ${i.persistence}`);
    changed.persistence = i.persistence;
  }
  const sessionTtl = i.sessionTtlMs ?? a.session_ttl_ms;
  const idleTtl = i.idleTtlMs ?? a.idle_ttl_ms;
  if (sessionTtl < SESSION_TTL_MIN_MS || sessionTtl > SESSION_TTL_MAX_MS) refuse('bad_request', `sessionTtlMs must be between ${SESSION_TTL_MIN_MS} and ${SESSION_TTL_MAX_MS}`);
  if (idleTtl < IDLE_TTL_MIN_MS || idleTtl > sessionTtl) refuse('bad_request', `idleTtlMs must be between ${IDLE_TTL_MIN_MS} and the session TTL (${sessionTtl})`);
  if (sessionTtl !== a.session_ttl_ms) {
    // Every stored or proposed policy must still fit the lowered TTL (maxConsentMs ≤ session_ttl_ms), or the API
    // would stop serving it: a policy must be replaced or removed first.
    const texts = [a.auto_approve_policy, a.auto_approve_pending, ...plan.openChanges.filter((c) => c.kind === 'policy_set').map((c) => c.policy_json)];
    for (const t of texts) if (t !== null && !(await fitsTtl(t, sessionTtl))) refuse('policy_invalid', 'A stored or proposed auto-approve policy has maxConsentMs over the new session TTL: replace or remove it first');
    set.push(q`session_ttl_ms = ${sessionTtl}`);
    changed.sessionTtlMs = sessionTtl;
  }
  if (idleTtl !== a.idle_ttl_ms) {
    set.push(q`idle_ttl_ms = ${idleTtl}`);
    changed.idleTtlMs = idleTtl;
  }
  if (i.googleWebClientId !== undefined && i.googleWebClientId !== a.google_web_client_id) {
    if (i.googleWebClientId !== null && !(await scopeGoogleClients(env, a.scope_id)).includes(i.googleWebClientId)) {
      refuse('bad_request', `${i.googleWebClientId} is not one of the scope's Google clients on chain`);
    }
    set.push(q`google_web_client_id = ${i.googleWebClientId}`);
    changed.googleWebClientId = i.googleWebClientId;
  }
  if (i.identityEmail !== undefined && i.identityEmail !== a.identity_email) {
    if (i.identityEmail !== 'off' && i.identityEmail !== 'on_request' && i.identityEmail !== 'at_login') refuse('bad_request', 'identityEmail must be off, on_request or at_login');
    set.push(q`identity_email = ${i.identityEmail}`);
    changed.identityEmail = i.identityEmail;
  }
  if (i.name !== undefined) {
    const name = appName(i.name);
    if (name !== a.name) {
      set.push(q`name = ${name}`);
      changed.name = name;
    }
  }
  if (!set.length) return { version: a.settings_version };
  const kind = Object.keys(changed).length === 1 && 'name' in changed ? 'app.renamed' : 'settings.changed';
  await runWrite(db, w, [
    commitOnApp(w, { kind, detail: changed }, i.appId, i.orgId, q`a.settings_version = ${i.expectedVersion} AND a.deleted_at IS NULL`),
    q`UPDATE apps SET settings_version = settings_version + 1, ${join(set, ', ')} WHERE id = ${i.appId} AND ${committed(w.requestId)}`,
  ]);
  return { version: i.expectedVersion + 1 };
}

export async function setLogo(db: HotDb, w: Writer, i: { orgId: string | null; appId: string; logoKey: string | null; expectedVersion: number }): Promise<{ version: number }> {
  expectReplay(w, ['app.logo_set', 'app.logo_removed']);
  if (i.logoKey !== null && LOGO_KEY_RE.exec(i.logoKey)?.[1] !== i.appId) refuse('bad_request', "The logo key is not this app's");
  const plan = await planApp(db, { appId: i.appId, orgId: i.orgId, w });
  expectVersion(plan.app.settings_version, i.expectedVersion);
  if (plan.app.logo_key === i.logoKey) return { version: plan.app.settings_version };
  await runWrite(db, w, [
    commitOnApp(w, { kind: i.logoKey === null ? 'app.logo_removed' : 'app.logo_set', detail: { logoKey: i.logoKey, previous: plan.app.logo_key } }, i.appId, i.orgId, q`a.settings_version = ${i.expectedVersion} AND a.deleted_at IS NULL`),
    q`UPDATE apps SET settings_version = settings_version + 1, logo_key = ${i.logoKey} WHERE id = ${i.appId} AND ${committed(w.requestId)}`,
  ]);
  return { version: i.expectedVersion + 1 };
}

/** turnOff: the policy removed, or raw signing off; immediate. Nothing to turn off answers the current version unchanged. */
export async function turnOff(db: HotDb, w: Writer, i: { orgId: string | null; appId: string; what: 'policy' | 'raw_sign'; expectedVersion: number }): Promise<{ version: number }> {
  expectReplay(w, ['policy.removed', 'raw_sign.off']);
  const plan = await planApp(db, { appId: i.appId, orgId: i.orgId, w, with: { changes: true } });
  const a = plan.app;
  expectVersion(a.settings_version, i.expectedVersion);
  const kind = i.what === 'policy' ? 'policy_set' : 'raw_sign_on';
  const open = plan.openChanges.filter((c) => c.kind === kind);
  const isOn = i.what === 'policy' ? a.auto_approve_policy !== null || a.auto_approve_pending !== null : a.raw_sign !== 'off' || a.raw_sign_pending !== null;
  if (!isOn && !open.length) return { version: a.settings_version };
  const cancelled = open.filter((c) => c.status === 'pending' && (c.active_from === null || c.active_from > w.now)).map((c) => c.id);
  const clear =
    i.what === 'policy'
      ? q`auto_approve_policy = NULL, auto_approve_pending = NULL, auto_approve_effective_at = NULL`
      : q`raw_sign = 'off', raw_sign_pending = NULL, raw_sign_effective_at = NULL`;
  await runWrite(db, w, [
    commitOnApp(w, { kind: i.what === 'policy' ? 'policy.removed' : 'raw_sign.off', detail: { cancelled } }, i.appId, i.orgId, q`a.settings_version = ${i.expectedVersion} AND a.deleted_at IS NULL`),
    q`UPDATE apps SET settings_version = settings_version + 1, ${clear} WHERE id = ${i.appId} AND ${committed(w.requestId)}`,
    closeChanges(q`app_id = ${i.appId} AND kind = ${kind}`, w),
  ]);
  return { version: i.expectedVersion + 1 };
}

/** ConsoleRpc.proposeChange: a member's policy set or raw-signing enable, bound to the member's step-up token. */
export async function proposeSettingByMember(
  db: HotDb,
  env: Env,
  w: Writer,
  i: { orgId: string; appId: string; kind: 'policy_set' | 'raw_sign_on'; policy?: unknown; expectedVersion: number; stepUpJwt: string },
): Promise<{ version: number; change: ReturnType<typeof changeView> }> {
  const token = await verifyStepUpToken(env, i.stepUpJwt, w.actor, w.now);
  return proposeSetting(db, env, w, i, token);
}

/**
 * A proposal of a policy set or a raw-signing enable: Hana staff's (AdminRpc.proposeChange, `token` null) or a member's
 * with a verified step-up token. Refused for raw signing on a test app (D39), for a value already in force, and while
 * another change of the same kind is pending (cancel it first); a staff proposal also within `appChangeDelayMs` of a
 * scope assignment. Staff proposals never get a waiver and are never expedited.
 */
export async function proposeSetting(
  db: HotDb,
  env: Env,
  w: Writer,
  i: { orgId: string; appId: string; kind: 'policy_set' | 'raw_sign_on'; policy?: unknown; expectedVersion: number },
  token: StepUpToken | null = null,
): Promise<{ version: number; change: ReturnType<typeof changeView> }> {
  expectReplay(w, ['policy.proposed', 'raw_sign.proposed']);
  const config = requireChangeConfig(env);
  const plan = await planApp(db, { appId: i.appId, orgId: i.orgId, w, with: { changes: true } });
  const a = plan.app;
  expectVersion(a.settings_version, i.expectedVersion);
  if (!token && a.assigned_at > w.now - config.delayMs) refuse('conflict', 'The scope was assigned to this org less than appChangeDelayMs ago: staff proposals wait for it');
  let policy: { json: string; id: string } | null = null;
  if (i.kind === 'raw_sign_on') {
    if (i.policy !== undefined) refuse('bad_request', 'raw_sign_on takes no policy');
    if (a.environment === 'test') refuse('env_mismatch', 'Test apps never sign raw (D39)');
  } else {
    if (i.policy === undefined) refuse('bad_request', 'policy_set needs a policy');
    const r = await validatePolicy(i.policy, a.session_ttl_ms);
    if (!r.ok) return refuse('policy_invalid', r.problems.slice(0, 10).join('; '));
    policy = r.policy;
  }
  // The input is valid: now the app's state (one pending change per kind, nothing already in force).
  const pending = plan.openChanges.filter((c) => c.kind === i.kind && c.status === 'pending' && (c.active_from === null || c.active_from > w.now));
  if (pending.length) refuse('conflict', `Another ${i.kind} change is pending (${pending.map((c) => c.id).join(', ')}): cancel it first`);
  if (i.kind === 'raw_sign_on' && rawSignInForce(a, w.now) === 'approval') refuse('conflict', 'Raw signing is already on');
  if (policy) {
    const inForce = policyInForce(a, w.now);
    if (inForce !== null && (await storedPolicy(inForce, a.session_ttl_ms))?.id === policy.id) refuse('conflict', 'This policy is already in force');
    const stillPending = pendingPolicy(a, w.now);
    if (stillPending !== null && (await storedPolicy(stillPending, a.session_ttl_ms))?.id === policy.id) refuse('conflict', 'This policy is already pending');
  }
  if (token) {
    // Steps 4–6 of the API verification, after the version check and every input and state check.
    const expectedNonce = nonceOf(
      await settingsChangeDigest({ signer: env.SIGNER_ACCOUNT, appId: i.appId, kind: i.kind, ...(policy ? { policyId: policy.id } : {}), settingsVersion: a.settings_version }),
    );
    await confirmStepUp(env, token, { expectedNonce, scopeId: a.scope_id });
    w.sub = token.sub;
  }
  const by = token ? { kind: 'member' as const, sub: token.sub } : { kind: 'hana' as const, sub: null };
  const changeId = newId('guardedChange');
  try {
    await runWrite(db, w, [
      commitOnApp(
        w,
        { kind: i.kind === 'policy_set' ? 'policy.proposed' : 'raw_sign.proposed', detail: policy ? { changeId, policyId: policy.id } : { changeId } },
        i.appId,
        i.orgId,
        q`a.settings_version = ${i.expectedVersion} AND a.deleted_at IS NULL
          AND (${token ? raw('1') : q`(SELECT assigned_at FROM scopes WHERE scope_id = a.scope_id) <= ${w.now - config.delayMs}`})
          AND NOT EXISTS (SELECT 1 FROM guarded_changes g WHERE g.app_id = a.id AND g.kind = ${i.kind} AND ${NOT_YET(w.now, 'g')})`,
      ),
      q`UPDATE apps SET settings_version = settings_version + 1 WHERE id = ${i.appId} AND ${committed(w.requestId)}`,
      q`INSERT INTO guarded_changes (id, app_id, kind, policy_json, policy_id, status, proposed_by_kind, proposed_by, proposer_sub, proposed_at, request_id)
        SELECT ${changeId}, ${i.appId}, ${i.kind}, ${policy?.json ?? null}, ${policy?.id ?? null}, 'pending', ${by.kind}, ${actorId(w.actor)}, ${by.sub}, ${w.now}, ${w.requestId} WHERE ${committed(w.requestId)}`,
    ]);
  } catch (err) {
    // Nothing was written (the batch is all or nothing): the token may be used again.
    if (token && !w.wrote) await releaseStepUp(env, token);
    throw err;
  }
  const row: ChangeRow = {
    id: changeId,
    app_id: i.appId,
    kind: i.kind,
    origin: null,
    policy_json: policy?.json ?? null,
    policy_id: policy?.id ?? null,
    status: 'pending',
    proposed_by_kind: by.kind,
    proposed_by: actorId(w.actor),
    proposer_sub: by.sub,
    proposed_at: w.now,
    request_country: null,
    waiver: null,
    notified_at: null,
    active_from: null,
    expedited_by: null,
    cancelled_by: null,
    cancelled_at: null,
    request_id: w.requestId,
  };
  return { version: i.expectedVersion + 1, change: changeView(row) };
}
