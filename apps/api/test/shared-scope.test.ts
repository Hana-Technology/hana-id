// D915 (docs/partner-platform-spec.md piece P0, finding H3): the shared-scope rules in the API. Staff mark a scope as
// shared (`AdminRpc.setScopeAppUserIds`, one way, refused while any app of it has a policy in force or waiting);
// `proposeChange` in AdminRpc and ConsoleRpc refuses a policy for an app on a marked scope or created by the platform
// (`policy_invalid`, the shared words), in its plan read and in its commit; an unmarked app is unchanged; the hourly
// drift check flags a policy found on such an app, however it got there; the app views carry the flags.
import { SHARED_SCOPE_POLICY_IN_THE_WAY, SHARED_WALLET_NO_AUTO_APPROVE, newPublishableKey, nonceOf, settingsChangeDigest } from '@hana-id/console-core';
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectDrift } from '../src/changes/drift.ts';
import { validatePolicy } from '../src/changes/policy.ts';
import { AdminRpc } from '../src/rpc/admin.ts';
import { clearViewCaches } from '../src/views.ts';
import { clearJwksCache } from '@hana-id/oidc';
import { uid } from './helpers.ts';
import { DELAY, type OrgApp, adminRpc, appRow, consoleRpc, hana, ledgerCount, linkToken, member, orgApp, ownClock, ownerChain as near, rows, stepUp, system } from './rpc-helpers.ts';
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

const drifts = async (appId: string) =>
  (await rows<{ detail_json: string }>("SELECT detail_json FROM security_events WHERE kind = 'drift' AND app_id = ?1", appId)).map((e) => JSON.parse(e.detail_json) as Record<string, unknown>);

describe('AdminRpc.setScopeAppUserIds', () => {
  it('marks the scope once, with a ledger row listing its apps; again is no change; one way (no off)', async () => {
    const app = await orgApp({ live: true });
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
    const app = await orgApp({ live: true });
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
    const app = await orgApp({ live: true });
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
    const app = await orgApp({ live: true });
    await ok(markScope(app));
    const before = await ledgerCount();
    expect(await staffPolicy(app, 'staff', 0)).toEqual({ ok: false, code: 'policy_invalid', error: SHARED_WALLET_NO_AUTO_APPROVE });
    expect(await memberPolicy(app, 'member', 0)).toEqual({ ok: false, code: 'policy_invalid', error: SHARED_WALLET_NO_AUTO_APPROVE });
    // Even a policy that wouldn't validate gets the same answer first.
    expect(await adminRpc().proposeChange({ ...hana(), orgId: app.org, appId: app.id, kind: 'policy_set', policy: { v: 2 }, expectedVersion: 0 })).toMatchObject({ ok: false, code: 'policy_invalid', error: SHARED_WALLET_NO_AUTO_APPROVE });
    expect(await ledgerCount()).toBe(before);
    expect(await rows('SELECT id FROM guarded_changes WHERE app_id = ?1', app.id)).toEqual([]);
    expect(await appRow(app.id)).toMatchObject({ settings_version: 0, auto_approve_policy: null, auto_approve_pending: null });
    // Raw signing is another rule (D39, and staff review): not refused by this one.
    await ok(adminRpc().proposeChange({ ...hana(), orgId: app.org, appId: app.id, kind: 'raw_sign_on', expectedVersion: 0 }));
  });

  it('AdminRpc and ConsoleRpc, for an app the platform created on an unmarked scope', async () => {
    near();
    const app = await orgApp({ live: true });
    const platform = await platformApp(app);
    expect(await staffPolicy(platform, 'staff', 0)).toEqual({ ok: false, code: 'policy_invalid', error: SHARED_WALLET_NO_AUTO_APPROVE });
    expect(await memberPolicy(platform, 'member', 0)).toEqual({ ok: false, code: 'policy_invalid', error: SHARED_WALLET_NO_AUTO_APPROVE });
    expect(await rows('SELECT id FROM guarded_changes WHERE app_id = ?1', platform.id)).toEqual([]);
    // The staff-created app beside it, on the same unmarked scope, is unchanged.
    await ok(staffPolicy(app, 'staff', 0));
  });

  it('an app on an unmarked scope is unchanged: staff and member proposals go through', async () => {
    near();
    const staffApp = await orgApp({ live: true });
    expect(await ok(staffPolicy(staffApp, 'staff', 0))).toMatchObject({ change: { kind: 'policy_set', status: 'pending', proposedByKind: 'hana' } });
    const memberApp = await orgApp({ live: true });
    expect(await ok(memberPolicy(memberApp, 'member', 0))).toMatchObject({ change: { kind: 'policy_set', status: 'pending', proposedByKind: 'member' } });
    // A marked scope elsewhere in the same org changes nothing here.
    const marked = await orgApp({ org: memberApp.org, live: true });
    await ok(markScope(marked));
    const v = (await appRow(memberApp.id)).settings_version as number;
    await ok(adminRpc().turnOff({ ...hana(), orgId: memberApp.org, appId: memberApp.id, what: 'policy', expectedVersion: v }));
    await ok(memberPolicy(memberApp, 'again', v + 1));
  });

  it('a scope marked between the plan read and the commit refuses it (the commit predicate): version_conflict, nothing written', async () => {
    const app = await orgApp({ live: true });
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
    const app = await orgApp({ live: true });
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
    const app = await orgApp({ live: true });
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
      { what: 'shared_wallet_policy', source: 'policy', policyId: id },
      { what: 'shared_wallet_policy', source: 'policy_pending', policyId: id },
    ]);
  });

  it('flagged even when a forged announced change explains the value to the other checks', async () => {
    const app = await orgApp({ live: true });
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
    const app = await orgApp({ live: true });
    const platform = await platformApp(app);
    const gone = await platformApp(app);
    const policy = JSON.stringify(autoApprovePolicy('bare'));
    await env.DB.prepare('UPDATE apps SET auto_approve_policy = ?2 WHERE id IN (?1, ?3)').bind(platform.id, policy, gone.id).run();
    await env.DB.prepare('UPDATE apps SET deleted_at = ?2 WHERE id = ?1').bind(gone.id, Date.now()).run();
    await detectDrift(env);
    expect((await drifts(platform.id)).filter((d) => d.what === 'shared_wallet_policy')).toEqual([{ what: 'shared_wallet_policy', source: 'policy', policyId: await policyIdOf(JSON.parse(policy)) }]);
    expect(await drifts(gone.id)).toEqual([]);
  });

  it('an app on an unmarked scope with an explained policy gets no shared-wallet finding', async () => {
    const app = await orgApp({ live: true });
    const p = await ok(staffPolicy(app, 'fine', 0));
    await ack(p.change.id);
    clock.advance(DELAY + 1000);
    await detectDrift(env);
    expect((await drifts(app.id)).filter((d) => d.what === 'shared_wallet_policy')).toEqual([]);
  });
});
