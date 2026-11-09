// Fresh sign-in (docs/batch-c-spec.md "Fresh sign-in", "On-chain owner actions", "Guarded changes" → "API
// verification"; batch C10), end to end through the real routes and the real API: the action's digest and Google nonce
// per layout, the step-up flow (openid only, the session's sub as login_hint), the callback executing the stored action
// with the token (which the API verifies again against the fake chain), single use, and every refusal the spec lists:
// a digest for another action or session, a stale iat, a sub mismatch, reuse, an expired action, a revoked session
// between creation and callback, a flow finished in another browser; console-only kinds consume, change and audit
// atomically, and a lost race writes nothing.
import { originChangeDigest, ownerActionNonce, nonceOf, stepUpDigest } from '@hana-id/console-core';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { actionOf, breathe, createAction, getAs, member, postAs, stepUp } from './c10.ts';
import { installChain, oidc, setChain, setScope, uninstallChain } from './chain.ts';
import { MockGoogle, account, signIn } from './google.ts';
import { auditRows, db, seedHotApp, shiftClock } from './helpers.ts';

/** An auto-approve policy the validator accepts (apps/api/test/vault-helpers.ts autoApprovePolicy's shape). */
const policyJson = () => ({
  v: 1,
  label: 'Swaps on Example',
  maxConsentMs: 12 * 3600_000,
  limits: { perDayCount: 5 },
  evm: {
    chains: [
      {
        chainId: 8453,
        maxValueWei: '100000',
        maxValueWeiPerDay: '100000',
        maxFeeWei: '100000',
        contracts: [{ address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', name: 'USDC', selectors: [{ selector: '0x095ea7b3', signature: 'approve(address,uint256)', addressArgs: 'self-or-listed' }] }],
      },
    ],
  },
});

let google: MockGoogle;
beforeEach(async () => {
  await breathe(700);
  installChain();
  google = new MockGoogle();
  await google.init();
  await setChain(google);
});
afterEach(() => {
  vi.restoreAllMocks();
  uninstallChain();
});

/** An owner of a fresh org with one app, who is the scope's on-chain owner. */
async function ownerWithApp(o: { onChain?: boolean } = {}) {
  const m = await member('owner');
  const app = await seedHotApp(m.org);
  await setScope({ id: app.scope, owners: o.onChain === false ? [oidc('someone-else')] : [oidc(m.sub)], action_nonce: 3 });
  return { m, app };
}

const hotChanges = (appId: string) => env.HOT_DB.prepare("SELECT kind, origin, status FROM guarded_changes WHERE app_id = ? ORDER BY proposed_at").bind(appId).all<{ kind: string; origin: string; status: string }>().then((r) => r.results);

describe('origin.add: build, confirm with Google, the API verifies and proposes', () => {
  it('the nonce is the origin-change layout at the app’s version; the step-up asks for openid with the session’s sub', async () => {
    const { m, app } = await ownerWithApp();
    const a = await createAction(m, 'origin.add', { appId: app.id, add: ['https://New.Partner.example/'] });
    expect(a.decoded).toMatchObject({ appId: app.id, add: [{ origin: 'https://new.partner.example', display: 'https://new.partner.example', idn: false }], remove: [] });
    const version = (await env.HOT_DB.prepare('SELECT origins_version AS v FROM apps WHERE id = ?').bind(app.id).first<number>('v'))!;
    const expected = nonceOf(await originChangeDigest({ signer: 'signer.test.near', appId: app.id, add: ['https://new.partner.example'], remove: [], originsVersion: version }));
    const s = await stepUp(google, m, a.id);
    expect(s.nonce).toBe(expected);
    expect(s.scope).toBe('openid');
    expect(s.loginHint).toBe(m.sub);
    expect(s.callback!.status).toBe(303);
    expect(s.landing).toBe(`/actions/${a.id}#`);
    const out = await actionOf(m, a.id);
    expect(out.body).toMatchObject({ status: 'ok', kind: 'origin.add' });
    expect(await hotChanges(app.id)).toEqual([{ kind: 'origin_add', origin: 'https://new.partner.example', status: 'pending' }]);
    const rows = await auditRows("action = 'origin.proposed' AND org_id = ?", m.org);
    expect(rows).toHaveLength(1);
    expect(await db.prepare("SELECT step_up_id FROM audit_log WHERE action = 'origin.proposed' AND org_id = ?").bind(m.org).first('step_up_id')).toBe(a.id);
    // The ID token was never stored: not in the action, not in the audit, not in the flow.
    const dump = JSON.stringify([await db.prepare('SELECT * FROM pending_actions WHERE id = ?').bind(a.id).first(), await auditRows('org_id = ?', m.org)]);
    for (const t of google.issued) expect(dump).not.toContain(t);
  });

  it('is single use: a second fresh sign-in for the same action is refused before Google', async () => {
    const { m, app } = await ownerWithApp();
    const a = await createAction(m, 'origin.add', { appId: app.id, add: ['https://one.partner.example'] });
    await stepUp(google, m, a.id);
    const again = await stepUp(google, m, a.id);
    expect(again.start.status).toBe(409);
    expect(again.start.body).toMatchObject({ error: { code: 'step_up_expired' } });
    expect(await hotChanges(app.id)).toHaveLength(1);
  });

  it('a non-owner sub is refused by the API itself (the console’s callback passed it on): nothing proposed', async () => {
    const { m, app } = await ownerWithApp({ onChain: false });
    const a = await createAction(m, 'origin.add', { appId: app.id, add: ['https://two.partner.example'] });
    await stepUp(google, m, a.id);
    expect((await actionOf(m, a.id)).body).toMatchObject({ status: 'failed', outcome: { code: 'not_owner' } });
    expect(await hotChanges(app.id)).toEqual([]);
  });

  it('a version that moved since the action was built is refused (version_conflict)', async () => {
    const { m, app } = await ownerWithApp();
    const a = await createAction(m, 'origin.add', { appId: app.id, add: ['https://three.partner.example'] });
    await env.HOT_DB.prepare('UPDATE apps SET origins_version = origins_version + 1 WHERE id = ?').bind(app.id).run();
    await stepUp(google, m, a.id);
    expect((await actionOf(m, a.id)).body).toMatchObject({ status: 'failed', outcome: { code: 'version_conflict' } });
  });

  it('refuses before the sign-in: a Hana origin, plain http, an origin already there', async () => {
    const { m, app } = await ownerWithApp();
    for (const [add, code] of [
      [['https://console.test'], 'origin_refused'],
      [['http://plain.partner.example'], 'origin_refused'],
      [['https://app.partner.example'], 'bad_request'],
    ] as const) {
      const r = await postAs(m, `/api/orgs/${m.org}/actions`, { kind: 'origin.add', params: { appId: app.id, add } });
      expect([r.status, (r.body as { error: { code: string } }).error.code], add[0]).toEqual([code === 'bad_request' ? 400 : 400, code]);
    }
  });
});

describe('policy.set: validated in the console, the consent preview data, proposed through the API', () => {
  it('builds the settings-change nonce over the policyId and the API stores the pending policy', async () => {
    const { settingsChangeDigest } = await import('@hana-id/console-core');
    const { m, app } = await ownerWithApp();
    await env.HOT_DB.prepare('UPDATE apps SET session_ttl_ms = ? WHERE id = ?').bind(12 * 3600_000, app.id).run();
    const check = await postAs<{ policyId: string; label: string }>(m, `/api/orgs/${m.org}/apps/${app.id}/policy/check`, { policy: policyJson() });
    expect(check.status).toBe(200);
    const a = await createAction(m, 'policy.set', { appId: app.id, policy: policyJson() });
    expect(a.decoded).toMatchObject({ appId: app.id, label: 'Swaps on Example', policyId: check.body.policyId, parentOrigin: 'https://app.partner.example', sessionTtlMs: 12 * 3600_000 });
    const v = (await env.HOT_DB.prepare('SELECT settings_version AS v FROM apps WHERE id = ?').bind(app.id).first<number>('v'))!;
    const s = await stepUp(google, m, a.id);
    expect(s.nonce).toBe(nonceOf(await settingsChangeDigest({ signer: 'signer.test.near', appId: app.id, kind: 'policy_set', policyId: check.body.policyId, settingsVersion: v })));
    expect((await actionOf(m, a.id)).body).toMatchObject({ status: 'ok' });
    expect(await env.HOT_DB.prepare("SELECT kind, policy_id, status FROM guarded_changes WHERE app_id = ? AND kind = 'policy_set'").bind(app.id).first()).toEqual({ kind: 'policy_set', policy_id: check.body.policyId, status: 'pending' });
  });

  it('an invalid policy is policy_invalid, before any sign-in', async () => {
    const { m, app } = await ownerWithApp();
    const r = await postAs(m, `/api/orgs/${m.org}/actions`, { kind: 'policy.set', params: { appId: app.id, policy: { ...policyJson(), label: '' } } });
    expect(r).toMatchObject({ status: 400, body: { error: { code: 'policy_invalid' } } });
    const c = await postAs(m, `/api/orgs/${m.org}/apps/${app.id}/policy/check`, { policy: { v: 2 } });
    expect(c.status).toBe(400);
  });
});

describe('bad action bodies answer zod 3\u2019s words (D470)', () => {
  const errorOf = (r: { body: unknown }) => (r.body as { error: { code: string; message: string } }).error;

  it('a missing params is the kind\u2019s own refusal, not a body refusal; missing fields say Required', async () => {
    const { m, app } = await ownerWithApp();
    const r = await postAs(m, `/api/orgs/${m.org}/actions`, { kind: 'origin.add' });
    expect(r.status).toBe(400);
    expect(errorOf(r)).toMatchObject({ code: 'bad_request', message: 'Bad params for origin.add: params: Required' });
    const add = await postAs(m, `/api/orgs/${m.org}/actions`, { kind: 'origin.add', params: { appId: app.id } });
    expect(errorOf(add)).toMatchObject({ code: 'bad_request', message: 'Bad params for origin.add: add: Required' });
  });

  it('a policy.set with no policy key reaches the policy check, as it did', async () => {
    const { m, app } = await ownerWithApp();
    const r = await postAs(m, `/api/orgs/${m.org}/actions`, { kind: 'policy.set', params: { appId: app.id } });
    expect(r.status).toBe(400);
    expect(errorOf(r).code).toBe('policy_invalid');
  });

  it('wrong values and unknown keys read as before, one issue per field', async () => {
    const { m, app } = await ownerWithApp();
    const enumBad = await postAs(m, `/api/orgs/${m.org}/actions`, { kind: 'app.settings', params: { appId: app.id, persistence: 'x' } });
    expect(errorOf(enumBad)).toMatchObject({ code: 'bad_request', message: "Bad params for app.settings: persistence: Invalid enum value. Expected 'session' | 'none', received 'x'" });
    const extra = await postAs(m, `/api/orgs/${m.org}/actions`, { kind: 'raw_sign.on', params: { appId: app.id, zz: 1 } });
    expect(errorOf(extra)).toMatchObject({ code: 'bad_request', message: "Bad params for raw_sign.on: params: Unrecognized key(s) in object: 'zz'" });
    const wrongType = await postAs(m, `/api/orgs/${m.org}/actions`, { kind: 'app.settings', params: { appId: app.id, googleWebClientId: [] } });
    expect(errorOf(wrongType).message).toBe('Bad params for app.settings: googleWebClientId: Expected string, received array');
    const float = await postAs(m, `/api/orgs/${m.org}/actions`, { kind: 'app.settings', params: { appId: app.id, sessionTtlMs: 1.5 } });
    expect(errorOf(float).message).toBe('Bad params for app.settings: sessionTtlMs: Expected integer, received float');
  });
});

describe('refusals (spec "Fresh sign-in")', () => {
  it('a sub mismatch (another Google account confirms): the action fails and nothing is applied', async () => {
    const { m, app } = await ownerWithApp();
    const a = await createAction(m, 'origin.add', { appId: app.id, add: ['https://four.partner.example'] });
    await stepUp(google, m, a.id, { account: account() });
    expect((await actionOf(m, a.id)).body).toMatchObject({ status: 'failed', outcome: { code: 'sub_mismatch' } });
    expect(await hotChanges(app.id)).toEqual([]);
    expect(await auditRows("action = 'step_up.failed' AND target = ?", a.id)).toHaveLength(1);
  });

  it('a digest for another action (the token carries another nonce), a stale iat, a token with email: the static page, nothing applied', async () => {
    for (const edits of [{ nonce: 'A'.repeat(43) }, { iat: Math.floor(Date.now() / 1000) - 200 }, { email: 'x@partner.example', email_verified: true }]) {
      const { m, app } = await ownerWithApp();
      const a = await createAction(m, 'origin.add', { appId: app.id, add: ['https://five.partner.example'] });
      const s = await stepUp(google, m, a.id, { edits });
      expect(s.callback!.status, JSON.stringify(edits)).toBe(400);
      expect(s.callback!.headers.get('location')).toBeNull();
      expect(await hotChanges(app.id)).toEqual([]);
      expect((await actionOf(m, a.id)).body.status).toBe('pending');
    }
  });

  it('a flow finished in another browser (no or another flow cookie) consumes nothing', async () => {
    const { m, app } = await ownerWithApp();
    const a = await createAction(m, 'origin.add', { appId: app.id, add: ['https://six.partner.example'] });
    const s = await stepUp(google, m, a.id, { afCookie: null });
    expect(s.callback!.status).toBe(400);
    const t = await stepUp(google, m, a.id, { afCookie: 'B'.repeat(43) });
    expect(t.callback!.status).toBe(400);
    expect((await actionOf(m, a.id)).body.status).toBe('pending');
    expect(await hotChanges(app.id)).toEqual([]);
  });

  it('an expired action: refused at the start, and if it expires between the start and the callback', async () => {
    const { m, app } = await ownerWithApp();
    const a = await createAction(m, 'origin.add', { appId: app.id, add: ['https://seven.partner.example'] });
    await db.prepare('UPDATE pending_actions SET expires_at = ? WHERE id = ?').bind(Date.now() - 1, a.id).run();
    expect((await stepUp(google, m, a.id)).start).toMatchObject({ status: 409, body: { error: { code: 'step_up_expired' } } });
    const b = await createAction(m, 'origin.add', { appId: app.id, add: ['https://eight.partner.example'] });
    await stepUp(google, m, b.id, { beforeCallback: () => db.prepare('UPDATE pending_actions SET expires_at = ? WHERE id = ?').bind(Date.now() - 1, b.id).run().then(() => undefined) });
    expect((await actionOf(m, b.id)).body).toMatchObject({ status: 'failed', outcome: { code: 'step_up_expired' } });
    expect(await hotChanges(app.id)).toEqual([]);
  });

  it('a session revoked or expired between creation and the callback: the action fails', async () => {
    for (const end of ['UPDATE console_sessions SET revoked_at = 1 WHERE id_hash = ?', 'UPDATE console_sessions SET last_seen_at = 1 WHERE id_hash = ?']) {
      const { m, app } = await ownerWithApp();
      const a = await createAction(m, 'origin.add', { appId: app.id, add: ['https://nine.partner.example'] });
      const s = await stepUp(google, m, a.id, { beforeCallback: () => db.prepare(end).bind(m.idHash).run().then(() => undefined) });
      expect(s.landing).toBe(`/actions/${a.id}#`);
      const row = await db.prepare('SELECT used_at, outcome FROM pending_actions WHERE id = ?').bind(a.id).first<{ used_at: number | null; outcome: string }>();
      expect(row?.used_at).not.toBeNull();
      expect(JSON.parse(row!.outcome)).toMatchObject({ status: 'failed', code: 'session_ended' });
      expect(await hotChanges(app.id)).toEqual([]);
    }
  });

  it('another session of the same user can’t start it; another user can’t read it', async () => {
    const { m, app } = await ownerWithApp();
    const a = await createAction(m, 'origin.add', { appId: app.id, add: ['https://ten.partner.example'] });
    const other = await member('owner', { org: m.org });
    expect((await postAs(other, `/api/actions/${a.id}/google`, {})).status).toBe(404);
    expect((await getAs(other, `/api/actions/${a.id}`)).status).toBe(404);
  });

  it('a member demoted between creation and the callback: refused', async () => {
    const { m, app } = await ownerWithApp();
    await member('owner', { org: m.org });
    const a = await createAction(m, 'origin.add', { appId: app.id, add: ['https://eleven.partner.example'] });
    await stepUp(google, m, a.id, { beforeCallback: () => db.prepare("UPDATE members SET role = 'viewer' WHERE user_id = ?").bind(m.userId).run().then(() => undefined) });
    expect((await actionOf(m, a.id)).body).toMatchObject({ status: 'failed', outcome: { code: 'forbidden' } });
  });

  it('each purpose’s nonce is refused for the others: a step-up nonce at a login, a login nonce at a step-up', async () => {
    const { m, app } = await ownerWithApp();
    const a = await createAction(m, 'origin.add', { appId: app.id, add: ['https://twelve.partner.example'] });
    const s = await stepUp(google, m, a.id, { edits: { nonce: 'C'.repeat(43) } });
    expect(s.callback!.status).toBe(400);
    const login = await signIn(google, account(), { edits: { nonce: s.nonce } });
    expect(login.callback!.status).toBe(400);
  });
});

describe('console-only kinds: consume, change and audit in one batch', () => {
  it('member.role promotes a viewer through an owner grant, audited with the step-up id; the generic digest is bound to the session', async () => {
    const m = await member('owner');
    const v = await member('viewer', { org: m.org });
    const a = await createAction(m, 'member.role', { userId: v.userId, role: 'owner' });
    const action = { v: 1 as const, env: 'sandbox-test', org_id: m.org, kind: 'member.role', user_id: v.userId, role: 'owner' };
    const s = await stepUp(google, m, a.id);
    expect(s.nonce).toBe(nonceOf(await stepUpDigest({ sessionHash: m.idHash, action })));
    expect((await actionOf(m, a.id)).body).toMatchObject({ status: 'ok', outcome: { grantId: expect.stringMatching(/^og_/u) } });
    expect(await db.prepare('SELECT step_up_id, granted_by_kind FROM owner_grants WHERE org_id = ? AND user_id = ?').bind(m.org, v.userId).first()).toEqual({ step_up_id: a.id, granted_by_kind: 'member' });
    expect(await db.prepare("SELECT step_up_id FROM audit_log WHERE org_id = ? AND action = 'owner_grant.created'").bind(m.org).first('step_up_id')).toBe(a.id);
  });

  it('a lost race (the action used meanwhile) writes nothing', async () => {
    const m = await member('owner');
    const v = await member('viewer', { org: m.org });
    const a = await createAction(m, 'member.remove', { userId: v.userId });
    // The consumption is the batch's guard: mark the action used just before the callback runs.
    await stepUp(google, m, a.id, { beforeCallback: () => db.prepare("UPDATE pending_actions SET used_at = ?, outcome = '{\"status\":\"failed\",\"code\":\"raced\"}' WHERE id = ?").bind(Date.now(), a.id).run().then(() => undefined) });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM members WHERE org_id = ? AND user_id = ?').bind(m.org, v.userId).first('n')).toBe(1);
    expect(await auditRows("org_id = ? AND action = 'member.removed'", m.org)).toEqual([]);
  });

  it('member.invite issues an invite created by the member with the step-up id (unusable until its notice)', async () => {
    const m = await member('owner');
    const a = await createAction(m, 'member.invite', { email: 'New.Person@Partner.example', role: 'viewer' });
    expect(a.decoded).toEqual({ email: 'new.person@partner.example', role: 'viewer', ownerWait: false });
    await stepUp(google, m, a.id);
    const inv = await db.prepare('SELECT created_by_kind, created_by, step_up_id, token_hash FROM invites WHERE org_id = ?').bind(m.org).first();
    expect(inv).toEqual({ created_by_kind: 'member', created_by: m.userId, step_up_id: a.id, token_hash: null });
  });

  it('org.policy sets required_hd only to the session’s own domain', async () => {
    const m = await member('owner', { hd: 'partner.example' });
    expect((await postAs(m, `/api/orgs/${m.org}/actions`, { kind: 'org.policy', params: { requiredHd: 'other.example' } })).status).toBe(409);
    const a = await createAction(m, 'org.policy', { requiredHd: 'Partner.Example' });
    await stepUp(google, m, a.id, { account: { ...m.account, hd: 'partner.example' } });
    expect(await db.prepare('SELECT required_hd FROM orgs WHERE id = ?').bind(m.org).first('required_hd')).toBe('partner.example');
    expect(await db.prepare("SELECT step_up_id, details_json FROM audit_log WHERE org_id = ? AND action = 'org.policy'").bind(m.org).first()).toEqual({ step_up_id: a.id, details_json: '{"requiredHd":"partner.example"}' });
  });
});

describe('owner actions (spec "On-chain owner actions")', () => {
  it('cancel_change: built at the scope’s action_nonce with the contract’s layout; relayed byte-identical (the API’s precheck accepts the nonce)', async () => {
    const { m, app } = await ownerWithApp();
    await setScope({ id: app.scope, owners: [oidc(m.sub)], action_nonce: 7, pending: [{ id: 2, change: { AddClient: { provider: 'google', aud: 'x-y.apps.googleusercontent.com' } }, unlock_at_ms: Date.now() + 3600_000 }] });
    const a = await createAction(m, 'owner_action', { scopeId: app.scope, method: 'cancel_change', changeId: 2 });
    expect(a.decoded).toMatchObject({ scopeId: app.scope, actionNonce: 7, method: 'cancel_change', changeId: 2, change: { kind: 'AddClient', aud: 'x-y.apps.googleusercontent.com' } });
    const s = await stepUp(google, m, a.id);
    expect(s.scope).toBe('openid');
    expect(s.nonce).toBe(await ownerActionNonce({ signer: 'signer.test.near', method: 'cancel_change', args: { scope_id: app.scope, change_id: 2 }, actionNonce: 7 }));
    const out = (await actionOf(m, a.id)).body;
    // The test API has no owner-pool key, so the relay itself can't run; every check before it passed.
    expect(out.status).toBe('failed');
    expect(['owner_nonce_mismatch', 'forbidden', 'not_owner', 'nonce_moved'], JSON.stringify(out.outcome)).not.toContain(out.outcome!.code);
    expect(await auditRows("action = 'owner_action.relayed' AND org_id = ?", m.org)).toHaveLength(1);
  });

  it('a moved action_nonce between build and callback fails the action without calling the API', async () => {
    const { m, app } = await ownerWithApp();
    await setScope({ id: app.scope, owners: [oidc(m.sub)], action_nonce: 1, allow_shared: true, clients: [['google', 'c-1.apps.googleusercontent.com']] });
    const a = await createAction(m, 'owner_action', { scopeId: app.scope, method: 'disable_shared_login' });
    await stepUp(google, m, a.id, { beforeCallback: () => setScope({ id: app.scope, owners: [oidc(m.sub)], action_nonce: 2, allow_shared: true, clients: [['google', 'c-1.apps.googleusercontent.com']] }) });
    expect((await actionOf(m, a.id)).body).toMatchObject({ status: 'failed', outcome: { code: 'nonce_moved' } });
    expect(await auditRows("action = 'owner_action.relayed' AND org_id = ?", m.org)).toEqual([]);
  });

  it('refused before the sign-in: not an on-chain owner, a scope of another org, a client that isn’t the scope’s', async () => {
    const { m, app } = await ownerWithApp({ onChain: false });
    expect((await postAs(m, `/api/orgs/${m.org}/actions`, { kind: 'owner_action', params: { scopeId: app.scope, method: 'disable_shared_login' } })).status).toBe(403);
    const other = await seedHotApp();
    expect((await postAs(m, `/api/orgs/${m.org}/actions`, { kind: 'owner_action', params: { scopeId: other.scope, method: 'disable_shared_login' } })).status).toBe(404);
    await setScope({ id: app.scope, owners: [oidc(m.sub)] });
    expect((await postAs(m, `/api/orgs/${m.org}/actions`, { kind: 'owner_action', params: { scopeId: app.scope, method: 'remove_client', aud: 'nope.apps.googleusercontent.com' } })).status).toBe(404);
  });
});

describe('clock', () => {
  it('an action lives 5 minutes', async () => {
    const m = await member('owner');
    const a = await createAction(m, 'member.invite', { email: 'later@partner.example', role: 'viewer' });
    expect(a.expiresAt - Date.now()).toBeLessThanOrEqual(5 * 60_000);
    shiftClock(5 * 60_000 + 1000);
    expect((await actionOf(m, a.id)).body.status).toBe('expired');
  });
});
