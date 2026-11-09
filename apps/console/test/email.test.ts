// The app's Email login page (build plan batch 9, D444, D447) through the real routes and API: `GET …/email` (the state,
// the deliverability, a viewer, another org's app, NEAR down), turning email on (a fresh sign-in, through updateSettings)
// and off (the kill switch: a second click, a frozen org too), and the scope's email client as an owner action (the
// issuer mints the proof, a fresh sign-in sends it; refused when it can't work).
import { ownerActionNonce } from '@hana-id/console-core';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { actionOf, breathe, createAction, getAs, member, postAs, stepUp } from './c10.ts';
import { installChain, oidc, setChain, setScope, uninstallChain } from './chain.ts';
import { MockGoogle } from './google.ts';
import { auditRows, seedHotApp } from './helpers.ts';

let google: MockGoogle;
beforeEach(async () => {
  await breathe(600);
  installChain();
  google = new MockGoogle();
  await google.init();
  await setChain(google);
});
afterEach(() => {
  vi.restoreAllMocks();
  uninstallChain();
});

const hot = env.HOT_DB;
const loginMethods = (appId: string) => hot.prepare('SELECT login_methods AS m, settings_version AS v FROM apps WHERE id = ?').bind(appId).first<{ m: string; v: number }>();
const putIssuer = (key: string, value: unknown) =>
  env.FAKE_UPSTREAM.prepare('INSERT INTO upstream (key, json) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET json = excluded.json').bind(key, JSON.stringify(value)).run();

async function ownerWithApp(o: { onChain?: boolean; clients?: [string, string][]; pending?: { id: number; change: unknown; unlock_at_ms: number }[] } = {}) {
  const m = await member('owner');
  const app = await seedHotApp(m.org);
  await setScope({ id: app.scope, owners: o.onChain === false ? [oidc('someone-else')] : [oidc(m.sub)], action_nonce: 3, ...(o.clients ? { clients: o.clients } : {}), ...(o.pending ? { pending: o.pending } : {}) });
  return { m, app };
}
const emailAud = (scope: string) => `email:${scope}`;

describe('GET /apps/:app/email (D444)', () => {
  it('answers the login method, the chain state and the deliverability for a member', async () => {
    const { m, app } = await ownerWithApp({ clients: [['google', 'c.apps.googleusercontent.com'], ['email', `email:placeholder`]] });
    await setScope({ id: app.scope, owners: [oidc(m.sub)], action_nonce: 3, clients: [['email', emailAud(app.scope)]] });
    await hot.prepare("UPDATE apps SET login_methods = 'google,email' WHERE id = ?").bind(app.id).run();
    await putIssuer(`issuer:deliverability:${app.id}`, { ok: true, days: [{ day: '2026-11-08', sent: 40, bounced: 1, complained: 0, refused: 2 }] });
    const r = await getAs(m, `/api/orgs/${m.org}/apps/${app.id}/email`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ emailOn: true, scopeId: app.scope, available: true, scope: { clientOnChain: true, pending: null, youAreOnChainOwner: true }, otherAppsEmailOn: 0, deliverability: { days: [{ sent: 40, bounced: 1 }] } });
  });

  it('reports a pending AddClient with its unlock time and whether it can run, and sibling apps with email on', async () => {
    const m = await member('owner');
    const app = await seedHotApp(m.org);
    const sibling = await seedHotApp(m.org);
    await hot.prepare('UPDATE apps SET scope_id = ? WHERE id = ?').bind(app.scope, sibling.id).run();
    await hot.prepare("UPDATE apps SET login_methods = 'google,email' WHERE id = ?").bind(sibling.id).run();
    await setScope({ id: app.scope, owners: [oidc(m.sub)], action_nonce: 2, pending: [{ id: 9, change: { AddClient: { provider: 'email', aud: emailAud(app.scope) } }, unlock_at_ms: Date.now() + 3600_000 }] });
    const r = await getAs(m, `/api/orgs/${m.org}/apps/${app.id}/email`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ emailOn: false, scope: { clientOnChain: false, pending: { changeId: 9, executable: false }, youAreOnChainOwner: true }, otherAppsEmailOn: 1 });
  });

  it('a viewer sees it; a member of another org gets 404 and no data', async () => {
    const { m, app } = await ownerWithApp();
    const viewer = await member('viewer', { org: m.org });
    expect((await getAs(viewer, `/api/orgs/${m.org}/apps/${app.id}/email`)).status).toBe(200);
    const stranger = await member('owner');
    expect((await getAs(stranger, `/api/orgs/${stranger.org}/apps/${app.id}/email`)).status).toBe(404);
  });

  it('NEAR unavailable still answers, the chain part marked unavailable; an issuer error leaves deliverability unavailable', async () => {
    const { m, app } = await ownerWithApp();
    await env.FAKE_UPSTREAM.prepare('DELETE FROM upstream WHERE key = ?').bind(`get_scope:${app.scope}`).run();
    await putIssuer(`issuer:deliverability:${app.id}`, { ok: false, code: 'internal' });
    const r = await getAs(m, `/api/orgs/${m.org}/apps/${app.id}/email`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ scope: { unavailable: true }, deliverability: { unavailable: true } });
  });
});

describe('turning email on and off (D444)', () => {
  it('on: a fresh sign-in through updateSettings; the action names the change; off: immediate for an owner, audited', async () => {
    const { m, app } = await ownerWithApp();
    const a = await createAction(m, 'app.settings', { appId: app.id, loginMethods: 'google,email' });
    expect(a.decoded).toMatchObject({ appId: app.id, changes: { loginMethods: 'google,email' } });
    await stepUp(google, m, a.id);
    expect((await loginMethods(app.id))!.m).toBe('google,email');
    const v = (await loginMethods(app.id))!.v;
    const off = await postAs(m, `/api/orgs/${m.org}/apps/${app.id}/off`, { what: 'email', expectedVersion: v });
    expect(off.status).toBe(200);
    expect((await loginMethods(app.id))!.m).toBe('google');
    expect(await auditRows("action = 'app.turned_off' AND org_id = ?", m.org)).toHaveLength(1);
  });

  it('a viewer can’t turn it on or off; a frozen org’s owner can still turn it off', async () => {
    const { m, app } = await ownerWithApp();
    const viewer = await member('viewer', { org: m.org });
    expect((await postAs(viewer, `/api/orgs/${m.org}/actions`, { kind: 'app.settings', params: { appId: app.id, loginMethods: 'google,email' } })).status).toBe(403);
    expect((await postAs(viewer, `/api/orgs/${m.org}/apps/${app.id}/off`, { what: 'email', expectedVersion: 0 })).status).toBe(403);
    const frozen = await member('owner', { status: 'frozen' });
    const app2 = await seedHotApp(frozen.org);
    await hot.prepare("UPDATE apps SET login_methods = 'google,email' WHERE id = ?").bind(app2.id).run();
    expect((await postAs(frozen, `/api/orgs/${frozen.org}/actions`, { kind: 'app.settings', params: { appId: app2.id, loginMethods: 'google' } })).status).toBe(403);
    const v = (await loginMethods(app2.id))!.v;
    const off = await postAs(frozen, `/api/orgs/${frozen.org}/apps/${app2.id}/off`, { what: 'email', expectedVersion: v });
    expect(off.status).toBe(200);
    expect((await loginMethods(app2.id))!.m).toBe('google');
  });
});

describe('the scope’s email client as an owner action (D447)', () => {
  it('builds AddClient with the issuer’s proof at the current action_nonce; a fresh sign-in sends it (the API refuses the fake proof)', async () => {
    const { m, app } = await ownerWithApp();
    await hot.prepare("UPDATE apps SET login_methods = 'google,email' WHERE id = ?").bind(app.id).run();
    const a = await createAction(m, 'owner_action', { scopeId: app.scope, method: 'propose_change', change: { kind: 'AddEmailClient' } });
    expect(a.decoded).toMatchObject({ scopeId: app.scope, actionNonce: 3, method: 'propose_change', change: { kind: 'AddClient', provider: 'email', aud: emailAud(app.scope) } });
    const s = await stepUp(google, m, a.id);
    expect(s.scope).toBe('openid');
    const proof = JSON.stringify({ payload: 'p', signatures: [{ protected: 'h', signature: 's' }] });
    expect(s.nonce).toBe(await ownerActionNonce({ signer: 'signer.test.near', method: 'propose_change', args: { scope_id: app.scope, change: { AddClient: { provider: 'email', aud: emailAud(app.scope) } }, client_proof: proof }, actionNonce: 3 }));
    const out = (await actionOf(m, a.id)).body;
    expect(out.status).toBe('failed');
    expect(['forbidden', 'not_owner', 'owner_nonce_mismatch', 'nonce_moved']).not.toContain(out.outcome!.code);
    expect(await auditRows("action = 'owner_action.relayed' AND org_id = ?", m.org)).toHaveLength(1);
  });

  it('refused before the sign-in: not an on-chain owner, another org’s scope, no email app yet, already added or pending', async () => {
    const { m, app } = await ownerWithApp({ onChain: false });
    const params = (scopeId: string) => ({ scopeId, method: 'propose_change', change: { kind: 'AddEmailClient' } });
    expect((await postAs(m, `/api/orgs/${m.org}/actions`, { kind: 'owner_action', params: params(app.scope) })).status).toBe(403);

    const other = await seedHotApp();
    await setScope({ id: other.scope, owners: [oidc(m.sub)], action_nonce: 1 });
    expect((await postAs(m, `/api/orgs/${m.org}/actions`, { kind: 'owner_action', params: params(other.scope) })).status).toBe(404);

    const { m: o2, app: a2 } = await ownerWithApp();
    await putIssuer('issuer:clientProof', { ok: false, code: 'email_not_enabled' });
    const notEnabled = await postAs<{ error: { code: string; message: string } }>(o2, `/api/orgs/${o2.org}/actions`, { kind: 'owner_action', params: params(a2.scope) });
    expect(notEnabled.status).toBe(409);
    expect(notEnabled.body.error.message).toMatch(/Turn email login on/u);
    await env.FAKE_UPSTREAM.prepare("DELETE FROM upstream WHERE key = 'issuer:clientProof'").run();

    await setScope({ id: a2.scope, owners: [oidc(o2.sub)], action_nonce: 3, clients: [['email', emailAud(a2.scope)]] });
    expect((await postAs(o2, `/api/orgs/${o2.org}/actions`, { kind: 'owner_action', params: params(a2.scope) })).status).toBe(409);
    await setScope({ id: a2.scope, owners: [oidc(o2.sub)], action_nonce: 3, pending: [{ id: 1, change: { AddClient: { provider: 'email', aud: emailAud(a2.scope) } }, unlock_at_ms: Date.now() + 1000 }] });
    expect((await postAs(o2, `/api/orgs/${o2.org}/actions`, { kind: 'owner_action', params: params(a2.scope) })).status).toBe(409);
  });

  it('remove_client takes the email aud, as provider email; the last client rule holds', async () => {
    const { m, app } = await ownerWithApp({ clients: [['google', 'c.apps.googleusercontent.com']] });
    await setScope({ id: app.scope, owners: [oidc(m.sub)], action_nonce: 3, clients: [['google', 'c.apps.googleusercontent.com'], ['email', emailAud(app.scope)]] });
    const a = await createAction(m, 'owner_action', { scopeId: app.scope, method: 'remove_client', aud: emailAud(app.scope) });
    expect(a.decoded).toMatchObject({ method: 'remove_client', provider: 'email', aud: emailAud(app.scope), immediate: true });
    await setScope({ id: app.scope, owners: [oidc(m.sub)], action_nonce: 3, clients: [['email', emailAud(app.scope)]], allow_shared: false });
    expect((await postAs(m, `/api/orgs/${m.org}/actions`, { kind: 'owner_action', params: { scopeId: app.scope, method: 'remove_client', aud: emailAud(app.scope) } })).status).toBe(409);
  });
});
