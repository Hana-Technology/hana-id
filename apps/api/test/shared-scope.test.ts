// D915 (docs/partner-platform-spec.md piece P0, finding H3): the shared-scope rules in the API. Staff mark a scope as
// shared (`AdminRpc.setScopeAppUserIds`, one way, refused while any app of it has a policy in force or waiting);
// `proposeChange` in AdminRpc and ConsoleRpc refuses a policy for an app on a marked scope or created by the platform
// (`policy_invalid`, the shared words), in its plan read and in its commit; an unmarked app is unchanged; the hourly
// drift check flags a policy found on such an app, however it got there; the app views carry the flags.
import { SHARED_SCOPE_POLICY_IN_THE_WAY, SHARED_SCOPE_TEST_ONLY, SHARED_WALLET_NO_AUTO_APPROVE, autoApproveRefused, newPublishableKey, nonceOf, settingsChangeDigest } from '@hana-id/console-core';
import { applyD1Migrations, createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sharedWallet } from '../src/changes/apps.ts';
import { detectDrift } from '../src/changes/drift.ts';
import { sharesWallet } from '../src/vault/settings.ts';
import { validatePolicy } from '../src/changes/policy.ts';
import { AdminRpc } from '../src/rpc/admin.ts';
import { clearViewCaches } from '../src/views.ts';
import { clearJwksCache } from '@hana-id/oidc';
import { uid } from './helpers.ts';
import { DELAY, type OrgApp, STEP_UP_SUB, adminRpc, appRow, consoleRpc, hana, ledgerCount, linkToken, member, orgApp, ownClock, ownerChain as near, rows, stepUp, system } from './rpc-helpers.ts';
import { autoApprovePolicy } from './vault-helpers.ts';

let clock: ReturnType<typeof ownClock>;
beforeEach(() => {
  clock = ownClock({ freeze: true });
  clearJwksCache();
  clearViewCaches();
});
afterEach(() => vi.restoreAllMocks());

async function ok<T>(p: Promise<T>): Promise<Extract<T, { ok: true }>> {
  const r = await p;
  if (!(r as { ok: boolean }).ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
}

const SESSION_TTL = 24 * 60 * 60 * 1000 - 10 * 60 * 1000;
const policyIdOf = async (p: unknown) => {
  const v = await validatePolicy(p, SESSION_TTL);
  if (!v.ok) throw new Error('test policy invalid');
  return v.policy.id;
};
const settingsNonce = async (app: OrgApp, version: number, policyId: string) =>
  nonceOf(await settingsChangeDigest({ signer: env.SIGNER_ACCOUNT, appId: app.id, kind: 'policy_set', policyId, settingsVersion: version }));

const ack = async (changeId: string) => ok(adminRpc().ackNotice({ ...system(), changeId, cancelTokenHash: await linkToken().hash }));
const markScope = (app: OrgApp) => adminRpc().setScopeAppUserIds({ ...hana(), orgId: app.org, scopeId: app.scope });
const staffPolicy = (app: OrgApp, label: string, expectedVersion: number) =>
  adminRpc().proposeChange({ ...hana(), orgId: app.org, appId: app.id, kind: 'policy_set', policy: autoApprovePolicy(label), expectedVersion });
const memberPolicy = async (app: OrgApp, label: string, expectedVersion: number) => {
  const policy = autoApprovePolicy(label);
  const jwt = await stepUp(await settingsNonce(app, expectedVersion, await policyIdOf(policy)));
  return consoleRpc(clock).proposeChange({ ...member(), orgId: app.org, appId: app.id, kind: 'policy_set', policy, expectedVersion, stepUpJwt: jwt });
};

/** A second app on `of`'s scope, created by the platform (P4 will write these; until then only a direct insert does). */
async function platformApp(of: OrgApp): Promise<OrgApp> {
  const id = `app_${uid()}`;
  const env_ = (await env.DB.prepare('SELECT environment FROM scopes WHERE scope_id = ?1').bind(of.scope).first<{ environment: 'test' | 'live' }>())!.environment;
  const key = newPublishableKey(env_);
  await env.DB.prepare("INSERT INTO apps (id, name, scope_id, org_id, publishable_key, status, plan, created_by_kind) VALUES (?1, ?2, ?3, ?4, ?5, 'active', 'free', 'platform')")
    .bind(id, `Platform ${id}`, of.scope, of.org, key)
    .run();
  await env.DB.prepare("INSERT INTO app_keys (id, app_id, key, created_by, created_at) VALUES (?1, ?2, ?3, 'test', ?4)").bind(`key_${uid()}`, id, key, Date.now()).run();
  return { id, key, scope: of.scope, org: of.org };
}

/** The app's drift findings: the generic `drift` kind and, since 0027 (D916), the shared-scope findings' own kinds. */
const drifts = async (appId: string) =>
  (await rows<{ detail_json: string }>("SELECT detail_json FROM security_events WHERE kind IN ('drift', 'shared_wallet_policy', 'shared_scope_unmarked') AND app_id = ?1", appId)).map((e) => JSON.parse(e.detail_json) as Record<string, unknown>);

describe('AdminRpc.setScopeAppUserIds', () => {
  it('marks the scope once, with a ledger row listing its apps; again is no change; one way (no off)', async () => {
    const app = await orgApp();
    const second = await platformApp(app);
    const before = await ledgerCount();
    expect(await ok(markScope(app))).toMatchObject({ changed: true });
    expect(await env.DB.prepare('SELECT app_user_ids FROM scopes WHERE scope_id = ?1').bind(app.scope).first()).toEqual({ app_user_ids: 1 });
    const [row] = await rows<{ kind: string; org_id: string; app_id: string | null; scope_id: string; actor_kind: string; detail_json: string }>(
      "SELECT kind, org_id, app_id, scope_id, actor_kind, detail_json FROM app_changes WHERE kind = 'scope.app_user_ids' AND scope_id = ?1",
      app.scope,
    );
    expect(row).toMatchObject({ kind: 'scope.app_user_ids', org_id: app.org, app_id: null, scope_id: app.scope, actor_kind: 'hana' });
    const detail = JSON.parse(row!.detail_json) as { appUserIds: number; apps: string[] };
    expect(detail.appUserIds).toBe(1);
    expect([...detail.apps].sort()).toEqual([app.id, second.id].sort());
    expect(await ledgerCount()).toBe(before + 1);
    // Again: nothing written.
    expect(await ok(markScope(app))).toMatchObject({ changed: false });
    expect(await ledgerCount()).toBe(before + 1);
    // The input has no "off": an unknown field is refused before anything is read.
    expect(await adminRpc().setScopeAppUserIds({ ...hana(), orgId: app.org, scopeId: app.scope, on: false })).toMatchObject({ ok: false, code: 'bad_request' });
  });

  it('another org’s scope and an unknown scope are not_found; staff only; a replayed request id is already_applied', async () => {
    const app = await orgApp();
    const other = await orgApp();
    expect(await adminRpc().setScopeAppUserIds({ ...hana(), orgId: other.org, scopeId: app.scope })).toMatchObject({ ok: false, code: 'not_found' });
    expect(await adminRpc().setScopeAppUserIds({ ...hana(), orgId: app.org, scopeId: 'snosuchscope' })).toMatchObject({ ok: false, code: 'not_found' });
    expect(await adminRpc().setScopeAppUserIds({ ...system(), orgId: app.org, scopeId: app.scope })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await env.DB.prepare('SELECT app_user_ids FROM scopes WHERE scope_id = ?1').bind(app.scope).first()).toEqual({ app_user_ids: 0 });
    const call = hana();
    await ok(adminRpc().setScopeAppUserIds({ ...call, orgId: app.org, scopeId: app.scope }));
    expect(await adminRpc().setScopeAppUserIds({ ...call, orgId: app.org, scopeId: app.scope })).toMatchObject({ ok: false, code: 'already_applied' });
  });

  it('refused while an app of the scope has a policy proposed, waiting or in force; allowed once it is removed', async () => {
    const app = await orgApp();
    const p = await ok(staffPolicy(app, 'waiting', 0));
    // Proposed, not announced yet.
    expect(await markScope(app)).toEqual({ ok: false, code: 'conflict', error: SHARED_SCOPE_POLICY_IN_THE_WAY });
    // Announced: waiting in the app's columns.
    await ack(p.change.id);
    expect(await markScope(app)).toMatchObject({ ok: false, code: 'conflict' });
    // In force.
    clock.advance(DELAY + 1000);
    expect((await ok(adminRpc().getApp({ ...hana(), orgId: app.org, appId: app.id }))).app.settings.policy).not.toBeNull();
    expect(await markScope(app)).toMatchObject({ ok: false, code: 'conflict' });
    expect(await env.DB.prepare('SELECT app_user_ids FROM scopes WHERE scope_id = ?1').bind(app.scope).first()).toEqual({ app_user_ids: 0 });
    // The kill switch removes it; then the scope can be marked.
    const version = (await appRow(app.id)).settings_version as number;
    await ok(adminRpc().turnOff({ ...hana(), orgId: app.org, appId: app.id, what: 'policy', expectedVersion: version }));
    expect(await ok(markScope(app))).toMatchObject({ changed: true });
  });

  it('a policy proposed between its plan read and its commit stops it (the commit predicate): nothing written', async () => {
    const app = await orgApp();
    const before = await ledgerCount();
    // The D1 the call gets proposes a policy the instant before the write's batch runs (as a concurrent call would).
    const racing: D1Database = new Proxy(env.DB, {
      get(t, p) {
        if (p === 'batch')
          return async (stmts: D1PreparedStatement[]) => {
            await t
              .prepare("INSERT INTO guarded_changes (id, app_id, kind, policy_json, policy_id, status, proposed_by_kind, proposed_by, proposed_at, request_id) VALUES (?1, ?2, 'policy_set', '{}', ?3, 'pending', 'hana', 'staff', ?4, ?1)")
              .bind(`gc_${uid()}`, app.id, 'b'.repeat(64), Date.now())
              .run();
            return t.batch(stmts);
          };
        const v: unknown = Reflect.get(t, p);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    const rpc = new AdminRpc(createExecutionContext(), { ...env, DB: racing });
    expect(await rpc.setScopeAppUserIds({ ...hana(), orgId: app.org, scopeId: app.scope })).toMatchObject({ ok: false, code: 'version_conflict' });
    expect(await env.DB.prepare('SELECT app_user_ids FROM scopes WHERE scope_id = ?1').bind(app.scope).first()).toEqual({ app_user_ids: 0 });
    expect(await ledgerCount()).toBe(before);
  });
});

describe('proposeChange refuses a policy for an app that shares a wallet', () => {
  it('AdminRpc and ConsoleRpc, for an app on a marked scope: policy_invalid with the words, nothing written', async () => {
    near();
    const app = await orgApp();
    await ok(markScope(app));
    const before = await ledgerCount();
    expect(await staffPolicy(app, 'staff', 0)).toEqual({ ok: false, code: 'policy_invalid', error: SHARED_WALLET_NO_AUTO_APPROVE });
    expect(await memberPolicy(app, 'member', 0)).toEqual({ ok: false, code: 'policy_invalid', error: SHARED_WALLET_NO_AUTO_APPROVE });
    // Even a policy that wouldn't validate gets the same answer first.
    expect(await adminRpc().proposeChange({ ...hana(), orgId: app.org, appId: app.id, kind: 'policy_set', policy: { v: 2 }, expectedVersion: 0 })).toMatchObject({ ok: false, code: 'policy_invalid', error: SHARED_WALLET_NO_AUTO_APPROVE });
    expect(await ledgerCount()).toBe(before);
    expect(await rows('SELECT id FROM guarded_changes WHERE app_id = ?1', app.id)).toEqual([]);
    expect(await appRow(app.id)).toMatchObject({ settings_version: 0, auto_approve_policy: null, auto_approve_pending: null });
    // Raw signing on a (test) marked scope stays D39's refusal.
    expect(await adminRpc().proposeChange({ ...hana(), orgId: app.org, appId: app.id, kind: 'raw_sign_on', expectedVersion: 0 })).toMatchObject({ ok: false, code: 'env_mismatch' });
  });

  it('AdminRpc and ConsoleRpc, for an app the platform created on an unmarked scope', async () => {
    near();
    const app = await orgApp();
    const platform = await platformApp(app);
    expect(await staffPolicy(platform, 'staff', 0)).toEqual({ ok: false, code: 'policy_invalid', error: SHARED_WALLET_NO_AUTO_APPROVE });
    expect(await memberPolicy(platform, 'member', 0)).toEqual({ ok: false, code: 'policy_invalid', error: SHARED_WALLET_NO_AUTO_APPROVE });
    expect(await rows('SELECT id FROM guarded_changes WHERE app_id = ?1', platform.id)).toEqual([]);
    // The staff-created app beside it, on the same unmarked scope, is unchanged.
    await ok(staffPolicy(app, 'staff', 0));
  });

  it('an app on an unmarked scope is unchanged: staff and member proposals go through', async () => {
    near();
    const staffApp = await orgApp();
    expect(await ok(staffPolicy(staffApp, 'staff', 0))).toMatchObject({ change: { kind: 'policy_set', status: 'pending', proposedByKind: 'hana' } });
    const memberApp = await orgApp();
    expect(await ok(memberPolicy(memberApp, 'member', 0))).toMatchObject({ change: { kind: 'policy_set', status: 'pending', proposedByKind: 'member' } });
    // A marked scope elsewhere in the same org changes nothing here.
    const marked = await orgApp({ org: memberApp.org });
    await ok(markScope(marked));
    const v = (await appRow(memberApp.id)).settings_version as number;
    await ok(adminRpc().turnOff({ ...hana(), orgId: memberApp.org, appId: memberApp.id, what: 'policy', expectedVersion: v }));
    await ok(memberPolicy(memberApp, 'again', v + 1));
  });

  it('a scope marked between the plan read and the commit refuses it (the commit predicate): version_conflict, nothing written', async () => {
    const app = await orgApp();
    const racing: D1Database = new Proxy(env.DB, {
      get(t, p) {
        if (p === 'batch')
          return async (stmts: D1PreparedStatement[]) => {
            await t.prepare('UPDATE scopes SET app_user_ids = 1 WHERE scope_id = ?1').bind(app.scope).run();
            return t.batch(stmts);
          };
        const v: unknown = Reflect.get(t, p);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    const rpc = new AdminRpc(createExecutionContext(), { ...env, DB: racing });
    const before = await ledgerCount();
    expect(await rpc.proposeChange({ ...hana(), orgId: app.org, appId: app.id, kind: 'policy_set', policy: autoApprovePolicy('race'), expectedVersion: 0 })).toMatchObject({ ok: false, code: 'version_conflict' });
    expect(await ledgerCount()).toBe(before);
    expect(await rows('SELECT id FROM guarded_changes WHERE app_id = ?1', app.id)).toEqual([]);
    // Read again: the words.
    expect(await staffPolicy(app, 'race', 0)).toMatchObject({ ok: false, code: 'policy_invalid', error: SHARED_WALLET_NO_AUTO_APPROVE });
  });

  it('the kill switch still works on such an app (a policy found there by drift can be removed)', async () => {
    const app = await orgApp();
    await ok(markScope(app));
    await env.DB.prepare('UPDATE apps SET auto_approve_policy = ?2 WHERE id = ?1').bind(app.id, JSON.stringify(autoApprovePolicy('forged'))).run();
    await ok(adminRpc().turnOff({ ...hana(), orgId: app.org, appId: app.id, what: 'policy', expectedVersion: 0 }));
    expect(await appRow(app.id)).toMatchObject({ auto_approve_policy: null });
  });
});

describe('the app views', () => {
  it('carry the scope’s mark, who created the app, and whether auto-approve is off for it', async () => {
    const app = await orgApp();
    const platform = await platformApp(app);
    const view = async (a: OrgApp) => (await ok(consoleRpc(clock).getApp({ ...member(), orgId: a.org, appId: a.id }))).app;
    expect(await view(app)).toMatchObject({ sharedScope: false, createdByKind: 'hana', sharedWallet: false });
    expect(await view(platform)).toMatchObject({ sharedScope: false, createdByKind: 'platform', sharedWallet: true });
    await ok(markScope(app));
    expect(await view(app)).toMatchObject({ sharedScope: true, createdByKind: 'hana', sharedWallet: true });
    expect((await ok(adminRpc().getApp({ ...hana(), orgId: app.org, appId: app.id }))).app).toMatchObject({ sharedScope: true, sharedWallet: true });
  });
});

describe('drift: a policy on an app that shares a wallet', () => {
  it('a bare D1 write of a policy, a waiting policy and an open change on a marked scope: each flagged once', async () => {
    const app = await orgApp();
    await ok(markScope(app));
    const policy = JSON.stringify(autoApprovePolicy('bare'));
    await env.DB.prepare('UPDATE apps SET auto_approve_policy = ?2, auto_approve_pending = ?2, auto_approve_effective_at = ?3 WHERE id = ?1').bind(app.id, policy, Date.now() + DELAY).run();
    const gc = `gc_${uid()}`;
    await env.DB.prepare("INSERT INTO guarded_changes (id, app_id, kind, policy_json, policy_id, status, proposed_by_kind, proposed_by, proposed_at, request_id) VALUES (?1, ?2, 'policy_set', ?3, ?4, 'pending', 'hana', 'staff', ?5, ?1)")
      .bind(gc, app.id, policy, await policyIdOf(JSON.parse(policy)), Date.now())
      .run();
    await detectDrift(env);
    await detectDrift(env);
    const id = await policyIdOf(JSON.parse(policy));
    const shared = (await drifts(app.id)).filter((d) => d.what === 'shared_wallet_policy');
    expect(shared.sort((a, b) => String(a.source).localeCompare(String(b.source)))).toEqual([
      { what: 'shared_wallet_policy', source: 'change', changeId: gc },
      { what: 'shared_wallet_policy', source: 'policy', policyId: id, settingsVersion: 0 },
      { what: 'shared_wallet_policy', source: 'policy_pending', policyId: id, settingsVersion: 0 },
    ]);
  });

  it('flagged even when a forged announced change explains the value to the other checks', async () => {
    const app = await orgApp();
    await ok(markScope(app));
    // A forged guarded change, announced and in force, and the policy it names: the origin and setting checks see an
    // explained value, so only the shared-wallet rule reports it.
    const policy = JSON.stringify(autoApprovePolicy('explained'));
    const gc = `gc_${uid()}`;
    const t = Date.now() - 2 * DELAY;
    await env.DB.prepare(
      "INSERT INTO guarded_changes (id, app_id, kind, policy_json, policy_id, status, proposed_by_kind, proposed_by, proposed_at, notified_at, active_from, request_id) VALUES (?1, ?2, 'policy_set', ?3, ?4, 'active', 'hana', 'staff', ?5, ?5, ?6, ?1)",
    )
      .bind(gc, app.id, policy, await policyIdOf(JSON.parse(policy)), t, t + DELAY)
      .run();
    await env.DB.prepare('UPDATE apps SET auto_approve_policy = ?2 WHERE id = ?1').bind(app.id, policy).run();
    await detectDrift(env);
    const found = await drifts(app.id);
    expect(found.filter((d) => d.what === 'policy')).toEqual([]);
    expect(found.filter((d) => d.what === 'shared_wallet_policy').map((d) => d.source).sort()).toEqual(['change', 'policy']);
  });

  it('a bare D1 write of a policy on a platform-created app is flagged; a deleted app is not', async () => {
    const app = await orgApp();
    const platform = await platformApp(app);
    const gone = await platformApp(app);
    const policy = JSON.stringify(autoApprovePolicy('bare'));
    await env.DB.prepare('UPDATE apps SET auto_approve_policy = ?2 WHERE id IN (?1, ?3)').bind(platform.id, policy, gone.id).run();
    await env.DB.prepare('UPDATE apps SET deleted_at = ?2 WHERE id = ?1').bind(gone.id, Date.now()).run();
    await detectDrift(env);
    expect((await drifts(platform.id)).filter((d) => d.what === 'shared_wallet_policy')).toEqual([{ what: 'shared_wallet_policy', source: 'policy', policyId: await policyIdOf(JSON.parse(policy)), settingsVersion: 0 }]);
    expect(await drifts(gone.id)).toEqual([]);
  });

  it('an app on an unmarked scope with an explained policy gets no shared-wallet finding', async () => {
    const app = await orgApp();
    const p = await ok(staffPolicy(app, 'fine', 0));
    await ack(p.change.id);
    clock.advance(DELAY + 1000);
    await detectDrift(env);
    expect((await drifts(app.id)).filter((d) => d.what === 'shared_wallet_policy')).toEqual([]);
  });
});

// ---- after PR 145's review ----

const shared = async (appId: string) => (await drifts(appId)).filter((d) => d.what === 'shared_wallet_policy');
const freshScopeId = (): string => `s${[...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
const createApp = (org: string, scopeId: string, o: { environment?: 'test' | 'live'; appUserIds?: boolean } = {}) =>
  adminRpc().createApp({ ...hana(), orgId: org, scopeId, environment: o.environment ?? 'test', name: 'Partner app', origins: [], orgOwnerSubs: [STEP_UP_SUB], ...(o.appUserIds === undefined ? {} : { appUserIds: o.appUserIds }) });
const scopeMark = async (scopeId: string) => (await env.DB.prepare('SELECT app_user_ids FROM scopes WHERE scope_id = ?1').bind(scopeId).first<{ app_user_ids: number }>())?.app_user_ids;

/** Runs `body` with one of 0026's triggers dropped (a direct D1 write that also removed the backstop), then puts it back exactly. */
async function withoutTrigger(name: string, body: () => Promise<void>): Promise<void> {
  const sql = (await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?1").bind(name).first<{ sql: string }>())!.sql;
  await env.DB.prepare(`DROP TRIGGER ${name}`).run();
  try {
    await body();
  } finally {
    await env.DB.prepare(sql).run();
  }
}

describe('test scopes only, for now', () => {
  it('a live scope can’t be marked: env_mismatch with the words, nothing written; the trigger refuses a direct write too', async () => {
    const app = await orgApp({ live: true });
    const before = await ledgerCount();
    expect(await markScope(app)).toEqual({ ok: false, code: 'env_mismatch', error: SHARED_SCOPE_TEST_ONLY });
    expect(await ledgerCount()).toBe(before);
    expect(await scopeMark(app.scope)).toBe(0);
    await expect(env.DB.prepare('UPDATE scopes SET app_user_ids = 1 WHERE scope_id = ?1').bind(app.scope).run()).rejects.toThrow(/only a test scope/u);
  });
});

describe('createApp marks a new scope in the same write (appUserIds)', () => {
  it('a new test scope is created marked, with the mark’s ledger row beside app.created; a policy on its app is refused', async () => {
    near();
    const of = await orgApp();
    const scopeId = freshScopeId();
    const r = await ok(createApp(of.org, scopeId, { appUserIds: true }));
    expect(r.createdScope).toBe(true);
    expect(await scopeMark(scopeId)).toBe(1);
    const ledger = await rows<{ kind: string; app_id: string | null; detail_json: string }>('SELECT kind, app_id, detail_json FROM app_changes WHERE scope_id = ?1 ORDER BY seq', scopeId);
    expect(ledger.map((l) => l.kind).sort()).toEqual(['app.created', 'scope.app_user_ids']);
    expect(JSON.parse(ledger.find((l) => l.kind === 'scope.app_user_ids')!.detail_json)).toEqual({ appUserIds: 1, apps: [r.app.id], atCreate: true });
    expect(JSON.parse(ledger.find((l) => l.kind === 'app.created')!.detail_json)).toMatchObject({ appUserIds: true });
    expect(r.app).toMatchObject({ sharedScope: true, sharedWallet: true });
    expect(await memberPolicy({ ...of, id: r.app.id, scope: scopeId }, 'first', 0)).toEqual({ ok: false, code: 'policy_invalid', error: SHARED_WALLET_NO_AUTO_APPROVE });
  });

  it('an app created on an already-marked scope shares the wallet: no policy through either entrypoint', async () => {
    near();
    const first = await orgApp();
    await ok(markScope(first));
    const second = await ok(createApp(first.org, first.scope));
    expect(second.app).toMatchObject({ sharedScope: true, createdByKind: 'hana', sharedWallet: true });
    const app = { ...first, id: second.app.id };
    expect(await staffPolicy(app, 'second', 0)).toMatchObject({ ok: false, code: 'policy_invalid' });
    expect(await memberPolicy(app, 'second', 0)).toMatchObject({ ok: false, code: 'policy_invalid' });
    // Asking for the mark on a scope that already has it is fine.
    await ok(createApp(first.org, first.scope, { appUserIds: true }));
  });

  it('refused for a live scope, and for an existing scope that isn’t marked (mark it from an app, which checks policies)', async () => {
    near();
    const of = await orgApp();
    const before = await ledgerCount();
    expect(await createApp(of.org, freshScopeId(), { environment: 'live', appUserIds: true })).toEqual({ ok: false, code: 'env_mismatch', error: SHARED_SCOPE_TEST_ONLY });
    expect(await createApp(of.org, of.scope, { appUserIds: true })).toMatchObject({ ok: false, code: 'conflict' });
    expect(await ledgerCount()).toBe(before);
    expect(await scopeMark(of.scope)).toBe(0);
    // Without the option, a new scope is unmarked as before.
    const scopeId = freshScopeId();
    await ok(createApp(of.org, scopeId));
    expect(await scopeMark(scopeId)).toBe(0);
  });
});

describe('the one-way mark against direct D1 writes', () => {
  it('a marked scope can’t be deleted, replaced, upserted back to 0 or re-inserted unmarked', async () => {
    const app = await orgApp();
    await ok(markScope(app));
    const s = app.scope;
    await expect(env.DB.prepare('DELETE FROM scopes WHERE scope_id = ?1').bind(s).run()).rejects.toThrow(/never deleted/u);
    await expect(env.DB.prepare("INSERT OR REPLACE INTO scopes (scope_id, org_id, environment, first_session_at, created_at, assigned_at) VALUES (?1, ?2, 'test', NULL, 1, 1)").bind(s, app.org).run()).rejects.toThrow(/one way/u);
    await expect(env.DB.prepare("INSERT INTO scopes (scope_id, org_id, environment, first_session_at, created_at, assigned_at) VALUES (?1, ?2, 'test', NULL, 1, 1) ON CONFLICT (scope_id) DO UPDATE SET app_user_ids = 0").bind(s, app.org).run()).rejects.toThrow(/one way/u);
    expect(await scopeMark(s)).toBe(1);
    // An unmarked scope's row is untouched by these rules (an insert or ignore, as the e2e harness does, is still ignored).
    const plain = await orgApp();
    await env.DB.prepare("INSERT OR IGNORE INTO scopes (scope_id, org_id, environment, first_session_at, created_at, assigned_at) VALUES (?1, 'org_legacy', 'test', NULL, 1, 1)").bind(plain.scope).run();
    expect(await scopeMark(plain.scope)).toBe(0);
  });

  it('drift: the ledger’s mark counts when the column was put back to 0, and the scope itself is reported, once per mark', async () => {
    const app = await orgApp();
    await ok(markScope(app));
    await withoutTrigger('scopes_app_user_ids_one_way', async () => {
      await env.DB.prepare('UPDATE scopes SET app_user_ids = 0 WHERE scope_id = ?1').bind(app.scope).run();
    });
    await env.DB.prepare('UPDATE apps SET auto_approve_policy = ?2 WHERE id = ?1').bind(app.id, JSON.stringify(autoApprovePolicy('after unmark'))).run();
    await detectDrift(env);
    await detectDrift(env);
    expect((await drifts(app.id)).filter((d) => d.what === 'shared_wallet_policy').map((d) => d.source)).toEqual(['policy']);
    const scopeEvents = await rows<{ app_id: string | null; org_id: string; detail_json: string }>("SELECT app_id, org_id, detail_json FROM security_events WHERE kind = 'shared_scope_unmarked' AND scope_id = ?1 AND app_id IS NULL", app.scope);
    expect(scopeEvents.map((e) => ({ ...e, detail: JSON.parse(e.detail_json) as Record<string, unknown>, detail_json: undefined }))).toEqual([
      { app_id: null, org_id: app.org, detail_json: undefined, detail: { what: 'shared_scope_unmarked', markSeq: expect.any(Number), scopeRow: 'present' } },
    ]);
    // The vault reads the column only: it is the trigger set and drift that hold the line once a mark is undone by hand.
  });

  it('drift: a policy forged again after the kill switch is reported again', async () => {
    const app = await orgApp();
    await ok(markScope(app));
    const forge = () => env.DB.prepare('UPDATE apps SET auto_approve_policy = ?2 WHERE id = ?1').bind(app.id, JSON.stringify(autoApprovePolicy('again'))).run();
    await forge();
    await detectDrift(env);
    await ok(adminRpc().turnOff({ ...hana(), orgId: app.org, appId: app.id, what: 'policy', expectedVersion: 0 }));
    await forge();
    await detectDrift(env);
    expect((await shared(app.id)).map((d) => d.settingsVersion).sort()).toEqual([0, 1]);
  });

  it('drift: findings already recorded don’t crowd out new ones (more than one batch of standing findings)', async () => {
    const app = await orgApp();
    await ok(markScope(app));
    const policy = JSON.stringify(autoApprovePolicy('many'));
    const id = await policyIdOf(JSON.parse(policy));
    const stmts = Array.from({ length: 101 }, (_, k) =>
      env.DB.prepare("INSERT INTO guarded_changes (id, app_id, kind, policy_json, policy_id, status, proposed_by_kind, proposed_by, proposed_at, request_id) VALUES (?1, ?2, 'policy_set', ?3, ?4, 'pending', 'hana', 'staff', ?5, ?1)").bind(`gc_many${k}${uid().replace(/[^A-Za-z0-9]/gu, '')}`, app.id, policy, id, Date.now()),
    );
    await env.DB.batch(stmts);
    await detectDrift(env);
    expect(await shared(app.id)).toHaveLength(100);
    const other = await orgApp();
    await ok(markScope(other));
    await env.DB.prepare('UPDATE apps SET auto_approve_policy = ?2 WHERE id = ?1').bind(other.id, policy).run();
    await detectDrift(env);
    expect(await shared(app.id)).toHaveLength(101);
    expect((await shared(other.id)).map((d) => d.source)).toEqual(['policy']);
  });
});

describe('fail closed on unexpected values', () => {
  it('a missing scope row or an unknown creator counts as sharing a wallet, in the API, the vault and console-core', () => {
    expect(sharedWallet({ app_user_ids: null, created_by_kind: 'hana' })).toBe(true);
    expect(sharedWallet({ app_user_ids: 0, created_by_kind: 'other' as 'hana' })).toBe(true);
    expect(sharedWallet({ app_user_ids: 0, created_by_kind: 'hana' })).toBe(false);
    expect(sharesWallet({ app_user_ids: null, created_by_kind: 'hana' })).toBe(true);
    expect(sharesWallet({ app_user_ids: 0, created_by_kind: null })).toBe(true);
    expect(sharesWallet({ app_user_ids: 2, created_by_kind: 'hana' })).toBe(true);
    expect(sharesWallet({ app_user_ids: 0, created_by_kind: 'hana' })).toBe(false);
    expect(autoApproveRefused({ sharedScope: false, createdByKind: 'member' })).toBe(true);
  });

  it('drift: an app whose scope row is gone counts as shared', async () => {
    const app = await orgApp();
    await env.DB.prepare('UPDATE apps SET auto_approve_policy = ?2 WHERE id = ?1').bind(app.id, JSON.stringify(autoApprovePolicy('orphan'))).run();
    // Only possible with the backstops gone: the row deleted behind every check (the app's own triggers don't fire on it).
    // 0034's scopes_no_delete_with_apps is one of those backstops: dropped for this bare write, then put back.
    const trigger = (await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'scopes_no_delete_with_apps'").first<{ sql: string }>())!.sql;
    await env.DB.prepare('DROP TRIGGER scopes_no_delete_with_apps').run();
    try {
      await env.DB.prepare('DELETE FROM scopes WHERE scope_id = ?1').bind(app.scope).run();
    } finally {
      await env.DB.prepare(trigger).run();
    }
    await detectDrift(env);
    expect((await drifts(app.id)).filter((d) => d.what === 'shared_wallet_policy').map((d) => d.source)).toEqual(['policy']);
  });
});

describe('the shared-scope findings’ own event kinds (D916)', () => {
  it('a policy on a shared wallet is a shared_wallet_policy event, an undone mark a shared_scope_unmarked one; no generic drift event for either', async () => {
    const app = await orgApp();
    await ok(markScope(app));
    await env.DB.prepare('UPDATE apps SET auto_approve_policy = ?2 WHERE id = ?1').bind(app.id, JSON.stringify(autoApprovePolicy('own kind'))).run();
    await withoutTrigger('scopes_app_user_ids_one_way', async () => {
      await env.DB.prepare('UPDATE scopes SET app_user_ids = 0 WHERE scope_id = ?1').bind(app.scope).run();
    });
    await detectDrift(env);
    // The policy is also a plain `policy` drift finding (unexplained), which keeps the generic kind.
    const kinds = await rows<{ kind: string; app_id: string | null; what: string }>("SELECT kind, app_id, json_extract(detail_json, '$.what') AS what FROM security_events WHERE scope_id = ?1 AND json_extract(detail_json, '$.what') LIKE 'shared%' ORDER BY kind", app.scope);
    expect(kinds).toEqual([
      { kind: 'shared_scope_unmarked', app_id: null, what: 'shared_scope_unmarked' },
      { kind: 'shared_wallet_policy', app_id: app.id, what: 'shared_wallet_policy' },
    ]);
  });

  it('on a D1 without 0027 they stay drift events (never dropped by the CHECK), and are not recorded again once it applies', async () => {
    const db = env.FRESH_DB;
    const migrations = env.TEST_MIGRATIONS;
    const at = migrations.findIndex((m) => m.name === '0027_platform_actor.sql');
    await applyD1Migrations(db, migrations.slice(0, at));
    const now = Date.now();
    await db.prepare("INSERT INTO scopes (scope_id, org_id, environment, first_session_at, created_at, assigned_at, app_user_ids) VALUES ('s_sh', 'org_sh', 'test', 1, 1, 1, 1)").run();
    await db.prepare("INSERT INTO apps (id, name, scope_id, org_id, publishable_key) VALUES ('app_sh', 'Shared', 's_sh', 'org_sh', 'pk_test_Shhhhhhhhhhhhhhhhhhhhhhh')").run();
    await db.prepare('UPDATE apps SET auto_approve_policy = ?2 WHERE id = ?1').bind('app_sh', JSON.stringify(autoApprovePolicy('before 0027'))).run();
    await detectDrift({ DB: db }, now);
    const sharedRows = "SELECT kind, json_extract(detail_json, '$.what') AS what FROM security_events WHERE json_extract(detail_json, '$.what') = 'shared_wallet_policy'";
    expect((await db.prepare(sharedRows).all()).results).toEqual([{ kind: 'drift', what: 'shared_wallet_policy' }]);
    await applyD1Migrations(db, migrations);
    await detectDrift({ DB: db }, now + 1);
    expect((await db.prepare(sharedRows).all()).results).toEqual([{ kind: 'drift', what: 'shared_wallet_policy' }]);
    // A new finding after 0027 gets the kind of its own.
    // On a marked scope a new app gets its own User IDs (migration 0030, D919).
    await db.prepare("INSERT INTO apps (id, name, scope_id, org_id, publishable_key, auto_approve_policy, user_ids) VALUES ('app_sh2', 'Shared 2', 's_sh', 'org_sh', 'pk_test_Sh2hhhhhhhhhhhhhhhhhhhhh', ?1, 'app')").bind(JSON.stringify(autoApprovePolicy('after 0027'))).run();
    await detectDrift({ DB: db }, now + 2);
    expect((await db.prepare("SELECT kind FROM security_events WHERE app_id = 'app_sh2' AND json_extract(detail_json, '$.what') = 'shared_wallet_policy'").all()).results).toEqual([{ kind: 'shared_wallet_policy' }]);
  });
});
