// D931 (docs/partner-platform-spec.md piece P10, A11, A15): a second person's confirmation of web addresses in the
// partner console, over the real API. The page (`GET /api/orgs/:org/confirmations/:changeId`, any member; the
// email's Confirm link finds the org first) shows the request's web addresses and why this member may or may not
// confirm (a viewer, an owner who isn't an on-chain owner of the scope, nothing waiting); a GET changes nothing. The
// step-up `origin.confirm` is refused before any sign-in when it can't succeed, executed inside the callback (an owner
// demoted in between refused there), and its token is verified by the API; the audit row carries its id. The
// confirmation notice's removal link (`POST /api/remove/preview` and `POST /api/remove`, no session) under the CSRF
// rules, single use, audited.
import { b64url, newId, newPublishableKey } from '@hana-id/console-core';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Member, actionOf, breathe, createAction, getAs, member, postAs, stepUp } from './c10.ts';
import { installChain, oidc, setChain, setScope, uninstallChain } from './chain.ts';
import { MockGoogle } from './google.ts';
import { auditRows, db, hana, post, request, seedHotApp, system } from './helpers.ts';

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

const hot = env.HOT_DB;
const admin = () => env.API_ADMIN;
const randomHash = async () => b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', crypto.getRandomValues(new Uint8Array(32)))));

/** An owner of an org whose app is on a scope marked as shared, which they own on chain. */
async function ownerOfSharedApp() {
  const m = await member('owner');
  const app = await seedHotApp(m.org, []);
  await hot.prepare('UPDATE scopes SET app_user_ids = 1 WHERE scope_id = ?1').bind(app.scope).run();
  await setScope({ id: app.scope, owners: [oidc(m.sub)] });
  return { m, app };
}

/** Staff web addresses on the shared wallet's app (four eyes), announced, as AdminRpc writes and acks them. */
async function staffSet(app: { id: string; org: string }, origins: string[], frameOnly: string[] = []) {
  const ver = (await hot.prepare('SELECT origins_version AS v FROM apps WHERE id = ?1').bind(app.id).first<{ v: number }>())!.v;
  const r = (await admin().addOrigins({ ...hana(), orgId: app.org, appId: app.id, add: origins, ...(frameOnly.length ? { frameOnly } : {}), expectedVersion: ver })) as { ok: boolean; changes: { id: string; origin?: string }[] };
  if (!r.ok) throw new Error(JSON.stringify(r));
  for (const c of r.changes) expect(await admin().ackNotice({ ...system(), changeId: c.id, cancelTokenHash: await randomHash() })).toMatchObject({ ok: true });
  return r.changes.map((c) => ({ changeId: c.id, origin: c.origin! }));
}

const activeFrom = async (id: string) => (await hot.prepare('SELECT active_from FROM guarded_changes WHERE id = ?1').bind(id).first<{ active_from: number }>())!.active_from;

type Page = { confirmation: { app: { id: string; name: string }; changes: { changeId: string; state: string; confirmable: boolean }[]; proposedByKind: string }; ability: { allowed: boolean; reason?: string }; role: string };

describe('the confirmation page', () => {
  it('any member reads it; a viewer and an owner who isn’t an on-chain owner see why there’s no Confirm; the Confirm link finds the org; another org’s member gets 404; a GET changes nothing', async () => {
    const { m, app } = await ownerOfSharedApp();
    const set = await staffSet(app, ['https://shop.partner.example', 'https://www.partner.example']);
    const before = await Promise.all(set.map((c) => activeFrom(c.changeId)));
    const owner = await getAs<Page>(m, `/api/orgs/${m.org}/confirmations/${set[0]!.changeId}`);
    expect(owner.status).toBe(200);
    expect(owner.body.ability).toEqual({ allowed: true });
    expect(owner.body.confirmation.proposedByKind).toBe('hana');
    expect(owner.body.confirmation.changes.map((c) => c.changeId).sort()).toEqual(set.map((c) => c.changeId).sort());
    const viewer = await member('viewer', { org: m.org });
    expect((await getAs<Page>(viewer, `/api/orgs/${m.org}/confirmations/${set[0]!.changeId}`)).body.ability).toMatchObject({ allowed: false, reason: 'Only an owner of your organisation can confirm.' });
    const notOnChain = await member('owner', { org: m.org });
    expect((await getAs<Page>(notOnChain, `/api/orgs/${m.org}/confirmations/${set[0]!.changeId}`)).body.ability).toMatchObject({ allowed: false, reason: 'Only an owner of this wallet’s settings can confirm.' });
    expect((await getAs<{ orgId: string; appId: string }>(viewer, `/api/confirmations/${set[0]!.changeId}/org`)).body).toEqual({ orgId: m.org, appId: app.id });
    const stranger = await member('owner');
    expect((await getAs(stranger, `/api/orgs/${m.org}/confirmations/${set[0]!.changeId}`)).status).toBe(404);
    expect((await getAs(stranger, `/api/confirmations/${set[0]!.changeId}/org`)).status).toBe(404);
    expect((await request(`/api/orgs/${m.org}/confirmations/${set[0]!.changeId}`)).status).toBe(401);
    expect(await Promise.all(set.map((c) => activeFrom(c.changeId)))).toEqual(before);
  });
});

describe('D934: a frame-only web address on the confirmation page and in its step-up', () => {
  it('the page marks the one the app may use only inside its other web addresses, from the app’s own rows; the review says so too', async () => {
    const { m, app } = await ownerOfSharedApp();
    const set = await staffSet(app, ['https://shop.partner.example', 'https://widget.partner.example'], ['https://widget.partner.example']);
    const page = await getAs<{ confirmation: { changes: { origin: string; frameOnly?: true }[] } }>(m, `/api/orgs/${m.org}/confirmations/${set[0]!.changeId}`);
    expect(page.body.confirmation.changes.map((c) => [c.origin, c.frameOnly ?? false]).sort()).toEqual([
      ['https://shop.partner.example', false],
      ['https://widget.partner.example', true],
    ]);
    const a = await createAction(m, 'origin.confirm', { appId: app.id, changeIds: set.map((c) => c.changeId) });
    const shown = (a.decoded as { changes: { origin: string; frameOnly?: true }[] }).changes;
    expect(shown.map((c) => [c.origin, c.frameOnly ?? false]).sort()).toEqual([
      ['https://shop.partner.example', false],
      ['https://widget.partner.example', true],
    ]);
  });
});

describe('the step-up `origin.confirm`', () => {
  it('an on-chain owner ticks both, signs in fresh: in force at once; the audit row carries the step-up’s id; the confirmation records it', async () => {
    const { m, app } = await ownerOfSharedApp();
    const set = await staffSet(app, ['https://shop.partner.example', 'https://www.partner.example']);
    const a = await createAction(m, 'origin.confirm', { appId: app.id, changeIds: set.map((c) => c.changeId) });
    expect(a.decoded).toMatchObject({ appId: app.id, proposedByKind: 'hana' });
    const s = await stepUp(google, m, a.id);
    expect(s.landing).toBe(`/actions/${a.id}#`);
    const out = await actionOf(m, a.id);
    expect(out.body.status, JSON.stringify(out.body)).toBe('ok');
    for (const c of set) expect(await activeFrom(c.changeId)).toBeLessThanOrEqual(Date.now());
    const rows = await hot.prepare('SELECT step_up_id, confirmed_by, confirmed_sub FROM origin_confirmations WHERE app_id = ?1').bind(app.id).all<{ step_up_id: string; confirmed_by: string; confirmed_sub: string }>();
    expect(rows.results).toEqual(set.map(() => ({ step_up_id: a.id, confirmed_by: m.userId, confirmed_sub: m.sub })));
    const audit = await auditRows("action = 'origin.confirmed' AND org_id = ?", m.org);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_kind: 'member', actor_id: m.userId, outcome: 'ok' });
    expect(JSON.parse(audit[0]!.details_json)).toMatchObject({ confirmed: 2 });
    // The API's ledger row names the member and the step-up's sub.
    expect(await hot.prepare("SELECT actor_kind, actor_id, actor_sub FROM app_changes WHERE app_id = ?1 AND kind = 'origin.confirmed'").bind(app.id).first()).toEqual({ actor_kind: 'member', actor_id: m.userId, actor_sub: m.sub });
  });

  it('refused before any sign-in: a viewer (the route matrix), an owner who isn’t an on-chain owner, nothing confirmable, two requests, another app', async () => {
    const { m, app } = await ownerOfSharedApp();
    const one = await staffSet(app, ['https://a.partner.example']);
    const two = await staffSet(app, ['https://b.partner.example']);
    const viewer = await member('viewer', { org: m.org });
    expect((await postAs(viewer, `/api/orgs/${m.org}/actions`, { kind: 'origin.confirm', params: { appId: app.id, changeIds: [one[0]!.changeId] } })).status).toBe(403);
    const notOnChain = await member('owner', { org: m.org });
    const r = await postAs<{ error: { code: string } }>(notOnChain, `/api/orgs/${m.org}/actions`, { kind: 'origin.confirm', params: { appId: app.id, changeIds: [one[0]!.changeId] } });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('not_owner');
    const mixed = await postAs<{ error: { code: string } }>(m, `/api/orgs/${m.org}/actions`, { kind: 'origin.confirm', params: { appId: app.id, changeIds: [one[0]!.changeId, two[0]!.changeId] } });
    expect(mixed.body.error.code).toBe('bad_request');
    const otherApp = await seedHotApp(m.org, []);
    const wrongApp = await postAs<{ error: { code: string } }>(m, `/api/orgs/${m.org}/actions`, { kind: 'origin.confirm', params: { appId: otherApp.id, changeIds: [one[0]!.changeId] } });
    expect(wrongApp.body.error.code).toBe('not_found');
    // Not announced yet: nothing confirmable.
    const ver = (await hot.prepare('SELECT origins_version AS v FROM apps WHERE id = ?1').bind(app.id).first<{ v: number }>())!.v;
    const quiet = (await admin().addOrigins({ ...hana(), orgId: app.org, appId: app.id, add: ['https://c.partner.example'], expectedVersion: ver })) as { ok: boolean; code?: string; changes: { id: string }[] };
    if (!quiet.ok) throw new Error(quiet.code);
    const q = await postAs<{ error: { code: string; message: string } }>(m, `/api/orgs/${m.org}/actions`, { kind: 'origin.confirm', params: { appId: app.id, changeIds: [quiet.changes[0]!.id] } });
    expect(q.body.error.code).toBe('not_pending');
    expect(await hot.prepare('SELECT COUNT(*) AS n FROM origin_confirmations WHERE app_id = ?1').bind(app.id).first()).toEqual({ n: 0 });
  });

  it('an owner demoted to viewer between the action and the sign-in: refused in the callback, nothing confirmed', async () => {
    const { m, app } = await ownerOfSharedApp();
    const set = await staffSet(app, ['https://shop.partner.example']);
    const a = await createAction(m, 'origin.confirm', { appId: app.id, changeIds: [set[0]!.changeId] });
    await stepUp(google, m, a.id, { beforeCallback: async () => void (await db.prepare("UPDATE members SET role = 'viewer' WHERE org_id = ? AND user_id = ?").bind(m.org, m.userId).run()) });
    expect((await actionOf(m, a.id)).body).toMatchObject({ status: 'failed', outcome: { code: 'forbidden' } });
    expect(await activeFrom(set[0]!.changeId)).toBeGreaterThan(Date.now());
  });

  it('a POST without the console’s CSRF headers creates nothing', async () => {
    const { m, app } = await ownerOfSharedApp();
    const set = await staffSet(app, ['https://shop.partner.example']);
    const res = await request(`/api/orgs/${m.org}/actions`, { method: 'POST', body: { kind: 'origin.confirm', params: { appId: app.id, changeIds: [set[0]!.changeId] } }, headers: { cookie: `__Host-hana_cs=${m.cs}`, 'content-type': 'application/json' } });
    expect(res.status).toBe(403);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM pending_actions WHERE kind = 'origin.confirm' AND user_id = ?").bind(m.userId).first()).toEqual({ n: 0 });
  });
});

describe('the confirmation notice’s removal link', () => {
  async function confirmed(m: Member, app: { id: string; org: string }) {
    const set = await staffSet(app, ['https://shop.partner.example']);
    const a = await createAction(m, 'origin.confirm', { appId: app.id, changeIds: [set[0]!.changeId] });
    await stepUp(google, m, a.id);
    expect((await actionOf(m, a.id)).body.status).toBe('ok');
    const req = (await hot.prepare('SELECT request_id FROM origin_confirmations WHERE change_id = ?1').bind(set[0]!.changeId).first<{ request_id: string }>())!.request_id;
    const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const hash = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(atob(token.replace(/-/gu, '+').replace(/_/gu, '/')), (c) => c.charCodeAt(0)))));
    expect(await admin().armConfirmationLinks({ ...system(), requestId: req, removals: [{ changeId: set[0]!.changeId, removalTokenHash: hash }] })).toMatchObject({ ok: true });
    expect(await admin().ackConfirmationNotice({ ...system(), requestId: req })).toMatchObject({ ok: true });
    return { changeId: set[0]!.changeId, token };
  }

  it('the preview names the app, the web address and who confirmed (a member of the org by their address); the removal stops it at once, once; audited; CSRF rules', async () => {
    const { m, app } = await ownerOfSharedApp();
    const { changeId, token } = await confirmed(m, app);
    const pv = await post('/api/remove/preview', { changeId, token });
    expect(pv.status).toBe(200);
    expect(await pv.json()).toMatchObject({ changeId, origin: 'https://shop.partner.example', confirmedBy: m.email, confirmedByKind: 'member', removable: true });
    expect(await hot.prepare('SELECT COUNT(*) AS n FROM app_origins WHERE change_id = ?1').bind(changeId).first()).toEqual({ n: 1 });
    // Without the CSRF headers, refused before anything.
    expect((await request('/api/remove', { method: 'POST', body: { changeId, token }, headers: { 'content-type': 'application/json' } })).status).toBe(403);
    const wrong = await post('/api/remove', { changeId, token: b64url(new Uint8Array(32)) });
    expect(wrong.status).toBe(403);
    const ok = await post('/api/remove', { changeId, token });
    expect(ok.status).toBe(200);
    expect(await hot.prepare('SELECT COUNT(*) AS n FROM app_origins WHERE change_id = ?1').bind(changeId).first()).toEqual({ n: 0 });
    const again = await post('/api/remove', { changeId, token });
    expect(again.status).toBe(409);
    const audit = await auditRows("action = 'origin.link_remove' AND target = ?", changeId);
    expect(audit.map((r) => [r.actor_kind, r.outcome])).toEqual([
      ['link', 'ok'],
      ['link', 'failed'],
    ]);
    expect(JSON.stringify(audit)).not.toContain(token);
  });

  it('a platform key’s web address too: the owner confirms it with the same step-up, and the removal link removes it', async () => {
    const { m, app } = await ownerOfSharedApp();
    // A platform-created app, a key in force and the switch on, written as the API writes them.
    const pApp = `app_${newId('app').slice(4)}`;
    const pk = newPublishableKey('test');
    await hot.prepare("INSERT INTO apps (id, name, scope_id, org_id, publishable_key, status, plan, created_at, origins_version, user_ids, created_by_kind) VALUES (?1, 'Partner shop', ?2, ?3, ?4, 'active', 'free', ?5, 0, 'app', 'platform')").bind(pApp, app.scope, m.org, pk, Date.now()).run();
    const keyId = newId('platformKey');
    const raw = new Uint8Array(65).fill(9);
    raw[0] = 4;
    await hot.prepare("INSERT INTO platform_keys (id, org_id, label, alg, public_key, thumbprint, scopes_json, status, proposed_by_kind, proposed_by, proposer_sub, proposer_email_key, proposed_at, four_eyes, min_delay_ms, request_id) VALUES (?1, ?2, 'Backend key', 'ES256', ?3, ?4, ?5, 'pending', 'member', 'usr_reg', 'sub-reg', 'reg@partner.example', ?6, 0, 60000, ?7)")
      .bind(keyId, m.org, raw, 'K'.repeat(43), JSON.stringify([app.scope]), Date.now() - 200_000, `r_${keyId}`)
      .run();
    const t = Date.now();
    await hot.prepare('UPDATE platform_keys SET notified_at = ?2, unconfirmed_active_from = ?3, active_from = ?3, expires_at = ?3 + 31536000000 WHERE id = ?1').bind(keyId, t - 110_000, t - 50_000).run();
    await hot.prepare("UPDATE platform_keys SET status = 'active', activated_recorded_at = ?2 WHERE id = ?1").bind(keyId, t).run();
    await hot.prepare("INSERT OR IGNORE INTO platform_orgs (org_id, set_by, set_at) VALUES (?1, 's', 1)").bind(m.org).run();
    await hot.prepare("UPDATE platform_orgs SET enabled = 1, review_json = ?2 WHERE org_id = ?1").bind(m.org, JSON.stringify([keyId])).run();
    const changeId = newId('guardedChange');
    const origin = 'https://partner-shop.example';
    await hot.prepare('INSERT INTO platform_origin_waits (change_id, app_id, origin, key_id, min_delay_ms, at) VALUES (?1, ?2, ?3, ?4, 86400000, ?5)').bind(changeId, pApp, origin, keyId, t).run();
    await hot.prepare("INSERT INTO guarded_changes (id, app_id, kind, origin, status, proposed_by_kind, proposed_by, proposed_at, request_id) VALUES (?1, ?2, 'origin_add', ?3, 'pending', 'platform', ?4, ?5, 'pf_shop')").bind(changeId, pApp, origin, keyId, t).run();
    await hot.prepare('INSERT INTO app_origins (app_id, origin, active_from, change_id) VALUES (?1, ?2, NULL, ?3)').bind(pApp, origin, changeId).run();
    expect(await admin().ackNotice({ ...system(), changeId, cancelTokenHash: await randomHash() })).toMatchObject({ ok: true });
    const page = await getAs<Page>(m, `/api/orgs/${m.org}/confirmations/${changeId}`);
    expect(page.body.confirmation).toMatchObject({ proposedByKind: 'platform', app: { id: pApp, name: 'Partner shop' } });
    expect(page.body.ability).toEqual({ allowed: true });
    const a = await createAction(m, 'origin.confirm', { appId: pApp, changeIds: [changeId] });
    await stepUp(google, m, a.id);
    expect((await actionOf(m, a.id)).body.status).toBe('ok');
    expect(await activeFrom(changeId)).toBeLessThanOrEqual(Date.now());
  });
});
