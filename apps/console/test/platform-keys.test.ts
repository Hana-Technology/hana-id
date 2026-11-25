// D918 (docs/partner-platform-spec.md piece P2, A3, A11): platform keys in the partner console, over the real API. The
// routes (any member reads; an owner stops or cancels at once, frozen orgs too); the three step-ups (`platform.key_add`
// by an on-chain owner of each scope, `platform.key_accept` of a staff key, `platform.key_confirm`), each refused before
// any sign-in when it can't succeed (a private key pasted, not an owner of a scope, the registrant on a real-money setup)
// and executed inside the callback; four eyes' person checks (another console user, another email without dots and
// `+tags`, an owner since before the registration), at the action's creation and again in the callback; a GET (the
// key's page, the email's Confirm link, the link pages) never changes anything; the emailed links' POSTs under the
// CSRF rules.
import { b64url, newId, parsePlatformPublicKey } from '@hana-id/console-core';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Member, actionOf, breathe, createAction, getAs, member, postAs, stepUp } from './c10.ts';
import { installChain, oidc, setChain, setScope, uninstallChain } from './chain.ts';
import { MockGoogle } from './google.ts';
import { CSRF, DAY, auditRows, db, hana, post, request, seedHotApp, system } from './helpers.ts';

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

async function newPublicKey(): Promise<string> {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', kp.publicKey)) as JsonWebKey;
  return JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });
}

/** An owner of an org with a test app whose scope they own on chain (and `others` as co-owners there). */
async function ownerWithScope(others: Member[] = []) {
  const m = await member('owner');
  const app = await seedHotApp(m.org);
  await setScope({ id: app.scope, owners: [oidc(m.sub), ...others.map((o) => oidc(o.sub))] });
  return { m, app };
}

/** A second owner of `org`, an owner since `since` (default: an hour ago). */
async function coOwner(org: string, o: { email?: string; since?: number } = {}): Promise<Member> {
  const m = await member('owner', { org });
  if (o.email) await db.prepare('UPDATE console_users SET email = ? WHERE id = ?').bind(o.email, m.userId).run();
  await db.prepare('UPDATE members SET role_since = ? WHERE org_id = ? AND user_id = ?').bind(o.since ?? Date.now() - 3_600_000, org, m.userId).run();
  return { ...m, ...(o.email ? { email: o.email, account: { ...m.account, email: o.email } } : {}) };
}

/** The announcement's ack, as the admin Worker sends it after the emails went out. */
async function announce(keyId: string, atOnce = false) {
  const hash = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', crypto.getRandomValues(new Uint8Array(32)))));
  const r = await admin().ackPlatformKeyNotice({ ...system(), keyId, cancelTokenHash: hash, ...(atOnce ? { revokeTokenHash: hash.slice(0, 42) + 'A' } : {}) });
  expect(r).toMatchObject({ ok: true });
}

/** A key registered by `m` through the console's own action and the fresh sign-in. */
async function register(m: Member, scope: string, label = 'Backend key') {
  const publicKey = await newPublicKey();
  const a = await createAction(m, 'platform.key_add', { scopeIds: [scope], label, publicKey });
  await stepUp(google, m, a.id);
  const out = await actionOf(m, a.id);
  expect(out.body.status, JSON.stringify(out.body)).toBe('ok');
  return { keyId: out.body.outcome!.keyId as string, publicKey, action: a };
}

/** A four-eyes key (a real-money setup's), registered by `by`, written as the API writes one (the test API is on testnet). */
async function fourEyesKey(org: string, scope: string, by: Member, proposedAt = Date.now()) {
  const id = newId('platformKey');
  const p = await parsePlatformPublicKey(await newPublicKey());
  if (!p.ok) throw new Error(p.problem);
  await hot
    .prepare(
      `INSERT INTO platform_keys (id, org_id, label, alg, public_key, thumbprint, scopes_json, status, proposed_by_kind, proposed_by, proposer_sub, proposer_email_key, proposed_at, four_eyes, min_delay_ms, request_id)
       VALUES (?1, ?2, 'Real-money key', 'ES256', ?3, ?4, ?5, 'pending', 'member', ?6, ?7, ?8, ?9, 1, 86400000, ?10)`,
    )
    .bind(id, org, p.key.raw, p.key.thumbprint, JSON.stringify([scope]), by.userId, by.sub, by.email.toLowerCase(), proposedAt, `r_${id}`)
    .run();
  await announce(id);
  return id;
}

const keyRow = (id: string) => hot.prepare('SELECT status, confirmed_kind, confirmed_by, active_from, revoked_at, cancelled_at FROM platform_keys WHERE id = ?').bind(id).first<Record<string, unknown>>();

describe('reads', () => {
  it('any member lists the org’s keys with the people named by their own address, staff as Journear; the org’s test scopes', async () => {
    const { m, app } = await ownerWithScope();
    const { keyId } = await register(m, app.scope);
    await admin().registerPlatformKey({ ...hana(), orgId: m.org, scopeIds: [app.scope], label: 'Staff key', publicKey: await newPublicKey(), reason: 'Checked the thumbprint by phone' });
    const viewer = await member('viewer', { org: m.org });
    const r = await getAs<{ keys: { id: string; proposedBy: string; state: string }[]; people: Record<string, string>; scopes: string[]; role: string }>(viewer, `/api/orgs/${m.org}/platform-keys`);
    expect(r.status).toBe(200);
    expect(r.body.role).toBe('viewer');
    expect(r.body.scopes).toEqual([app.scope]);
    expect(r.body.keys.find((k) => k.id === keyId)).toMatchObject({ proposedBy: m.userId, state: 'waiting' });
    expect(r.body.keys.find((k) => k.id !== keyId)).toMatchObject({ proposedBy: 'hana', state: 'awaiting_acceptance' });
    expect(r.body.people).toEqual({ [m.userId]: m.email });
    expect(JSON.stringify(r.body)).not.toMatch(/staff@hana|access-sub|proposerSub|"sub"/u);
    // Another org's member doesn't see it.
    const stranger = await member('owner');
    expect((await getAs(stranger, `/api/orgs/${m.org}/platform-keys`)).status).toBe(404);
    expect((await getAs(stranger, `/api/platform-keys/${keyId}/org`)).status).toBe(404);
    expect((await getAs<{ orgId: string }>(viewer, `/api/platform-keys/${keyId}/org`)).body).toEqual({ orgId: m.org });
  });
});

describe('people’s addresses stay within the organisation', () => {
  it('an id belonging to another org’s user, or to a member who left, yields no email through any route; four eyes still compares the former registrant’s', async () => {
    const { m, app } = await ownerWithScope();
    const stranger = await member('owner');
    const second = await coOwner(m.org);
    await setScope({ id: app.scope, owners: [oidc(m.sub), oidc(second.sub), oidc(stranger.sub)] });
    // A key whose registrant is another org's user (a bare write: no route makes one), and one whose registrant left.
    const foreign = await fourEyesKey(m.org, app.scope, stranger);
    const leaver = await coOwner(m.org);
    const left = await fourEyesKey(m.org, app.scope, leaver);
    await db.prepare('DELETE FROM members WHERE org_id = ? AND user_id = ?').bind(m.org, leaver.userId).run();
    const list = await getAs<{ people: Record<string, string> }>(m, `/api/orgs/${m.org}/platform-keys`);
    expect(JSON.stringify(list.body)).not.toContain(stranger.email);
    expect(JSON.stringify(list.body)).not.toContain(leaver.email);
    for (const id of [foreign, left]) {
      const page = await getAs<{ people: Record<string, string> }>(m, `/api/orgs/${m.org}/platform-keys/${id}`);
      expect(page.status).toBe(200);
      expect(page.body.people).toEqual({});
      expect(JSON.stringify(page.body)).not.toMatch(new RegExp(`${stranger.email}|${leaver.email}`, 'u'));
    }
    // A current member with the departed registrant's address (dots aside) still can't confirm their key.
    const twin = await coOwner(m.org, { email: leaver.email.replace('@', '+x@') });
    await setScope({ id: app.scope, owners: [oidc(m.sub), oidc(twin.sub)] });
    expect((await getAs<{ confirm: { allowed: boolean; reason?: string } }>(twin, `/api/orgs/${m.org}/platform-keys/${left}`)).body.confirm).toMatchObject({ allowed: false, reason: expect.stringMatching(/same email/u) });
    expect(JSON.stringify((await getAs(twin, `/api/orgs/${m.org}/platform-keys/${left}`)).body)).not.toContain(leaver.email);
  });
});

describe('registration', () => {
  it('an on-chain owner registers a key through the fresh sign-in; the action names the fingerprint; the audit row has no key', async () => {
    const { m, app } = await ownerWithScope();
    const { keyId, publicKey, action } = await register(m, app.scope);
    const p = await parsePlatformPublicKey(publicKey);
    expect(action.decoded).toMatchObject({ scopeIds: [app.scope], label: 'Backend key', thumbprint: p.ok ? p.key.thumbprint : '', fourEyes: false });
    expect(await keyRow(keyId)).toMatchObject({ status: 'pending' });
    const [row] = await auditRows("action = 'platform_key.proposed' AND org_id = ?", m.org);
    expect(JSON.parse(row!.details_json)).toEqual({ keyId });
    expect(row!.details_json).not.toContain(JSON.parse(publicKey).x);
    const stored = (await db.prepare('SELECT action_json FROM pending_actions WHERE id = ?').bind(action.id).first<{ action_json: string }>())!.action_json;
    expect(stored).not.toMatch(/"d"/u);
  });

  it('refused before any sign-in: a private key, not an owner of the scope on chain, a live or foreign scope, a viewer', async () => {
    const { m, app } = await ownerWithScope();
    const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const priv = JSON.stringify(await crypto.subtle.exportKey('jwk', kp.privateKey));
    const r = await postAs<{ error: { code: string; message: string } }>(m, `/api/orgs/${m.org}/actions`, { kind: 'platform.key_add', params: { scopeIds: [app.scope], label: 'K', publicKey: priv } });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/private key/u);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM pending_actions WHERE org_id = ? AND kind = 'platform.key_add'").bind(m.org).first('n')).toBe(0);
    await setScope({ id: app.scope, owners: [oidc('someone-else')] });
    expect((await postAs<{ error: { code: string } }>(m, `/api/orgs/${m.org}/actions`, { kind: 'platform.key_add', params: { scopeIds: [app.scope], label: 'K', publicKey: await newPublicKey() } })).body.error.code).toBe('not_owner');
    const other = await seedHotApp();
    expect((await postAs<{ error: { code: string } }>(m, `/api/orgs/${m.org}/actions`, { kind: 'platform.key_add', params: { scopeIds: [other.scope], label: 'K', publicKey: await newPublicKey() } })).body.error.code).toBe('not_found');
    const viewer = await member('viewer', { org: m.org });
    expect((await postAs<{ error: { code: string } }>(viewer, `/api/orgs/${m.org}/actions`, { kind: 'platform.key_add', params: { scopeIds: [app.scope], label: 'K', publicKey: await newPublicKey() } })).status).toBe(403);
  });
});

describe('a staff key’s acceptance', () => {
  it('an owner accepts it through the fresh sign-in; it counts as the confirmation, in force once announced', async () => {
    const { m, app } = await ownerWithScope();
    const reg = await admin().registerPlatformKey({ ...hana(), orgId: m.org, scopeIds: [app.scope], label: 'Staff key', publicKey: await newPublicKey(), reason: 'Checked the thumbprint by phone' });
    const keyId = (reg as unknown as { key: { id: string } }).key.id;
    const page = await getAs<{ accept: { allowed: boolean }; confirm: { allowed: boolean } }>(m, `/api/orgs/${m.org}/platform-keys/${keyId}`);
    expect(page.body.accept).toEqual({ allowed: true });
    expect(page.body.confirm.allowed).toBe(false);
    const a = await createAction(m, 'platform.key_accept', { keyId });
    await stepUp(google, m, a.id);
    expect((await actionOf(m, a.id)).body.status).toBe('ok');
    expect(await keyRow(keyId)).toMatchObject({ status: 'pending', confirmed_kind: 'acceptance', confirmed_by: m.userId });
    await announce(keyId, true);
    expect(await keyRow(keyId)).toMatchObject({ status: 'active' });
  });
});

describe('an owner’s confirmation', () => {
  it('a GET of the key’s page, the email’s Confirm link or the link pages changes nothing', async () => {
    const { m, app } = await ownerWithScope();
    const { keyId } = await register(m, app.scope);
    await announce(keyId);
    const before = await keyRow(keyId);
    for (const path of [`/api/orgs/${m.org}/platform-keys/${keyId}`, `/api/platform-keys/${keyId}/org`, `/confirm-platform-key/${keyId}`, `/cancel-platform-key/${keyId}`, `/revoke-platform-key/${keyId}`]) {
      const res = await request(path, { headers: { cookie: `__Host-hana_cs=${m.cs}` } });
      expect(res.status, path).toBeLessThan(500);
    }
    expect(await keyRow(keyId)).toEqual(before);
    // Nor does a GET to the confirm or link POST routes.
    expect((await request(`/api/platform-keys/cancel`, { headers: { cookie: `__Host-hana_cs=${m.cs}` } })).status).toBe(405);
    expect(await keyRow(keyId)).toEqual(before);
  });

  it('on a dev env any owner who owns the scope on chain may confirm, the registrant too: in force at once', async () => {
    const { m, app } = await ownerWithScope();
    const { keyId } = await register(m, app.scope);
    const early = await getAs<{ confirm: { allowed: boolean; reason?: string } }>(m, `/api/orgs/${m.org}/platform-keys/${keyId}`);
    expect(early.body.confirm).toMatchObject({ allowed: false, reason: expect.stringMatching(/email has gone out/u) });
    await announce(keyId);
    expect((await getAs<{ confirm: { allowed: boolean } }>(m, `/api/orgs/${m.org}/platform-keys/${keyId}`)).body.confirm).toEqual({ allowed: true });
    const a = await createAction(m, 'platform.key_confirm', { keyId });
    await stepUp(google, m, a.id);
    expect((await actionOf(m, a.id)).body.status).toBe('ok');
    expect(await keyRow(keyId)).toMatchObject({ status: 'active', confirmed_kind: 'confirm', confirmed_by: m.userId });
    const [row] = await auditRows("action = 'platform_key.confirmed' AND org_id = ?", m.org);
    expect(row!.outcome).toBe('ok');
  });

  it('on a real-money setup: the registrant, another account with the same email, and an owner newer than the key are refused before the sign-in; a second owner confirms', async () => {
    const { m, app } = await ownerWithScope();
    const dotted = await coOwner(m.org, { email: m.email.replace('@', '+alt@').replace(/^m-/u, 'm.-') });
    const newer = await coOwner(m.org, { since: Date.now() + 60_000 });
    const second = await coOwner(m.org);
    await setScope({ id: app.scope, owners: [oidc(m.sub), oidc(dotted.sub), oidc(newer.sub), oidc(second.sub)] });
    const keyId = await fourEyesKey(m.org, app.scope, m);
    const ability = async (who: Member) => (await getAs<{ confirm: { allowed: boolean; reason?: string } }>(who, `/api/orgs/${m.org}/platform-keys/${keyId}`)).body.confirm;
    expect(await ability(m)).toMatchObject({ allowed: false, reason: expect.stringMatching(/You registered this key/u) });
    expect(await ability(dotted)).toMatchObject({ allowed: false, reason: expect.stringMatching(/same email/u) });
    expect(await ability(newer)).toMatchObject({ allowed: false, reason: expect.stringMatching(/already an owner when the key was registered/u) });
    for (const who of [m, dotted, newer]) expect((await postAs(who, `/api/orgs/${m.org}/actions`, { kind: 'platform.key_confirm', params: { keyId } })).status).toBe(403);
    expect(await ability(second)).toEqual({ allowed: true });
    const a = await createAction(second, 'platform.key_confirm', { keyId });
    await stepUp(google, second, a.id);
    expect((await actionOf(second, a.id)).body.status).toBe('ok');
    expect(await keyRow(keyId)).toMatchObject({ status: 'active', confirmed_by: second.userId });
  });

  it('the person checks run again in the callback: an owner whose owner rights became newer than the key in between is refused', async () => {
    const { m, app } = await ownerWithScope();
    const second = await coOwner(m.org);
    await setScope({ id: app.scope, owners: [oidc(m.sub), oidc(second.sub)] });
    const keyId = await fourEyesKey(m.org, app.scope, m);
    const a = await createAction(second, 'platform.key_confirm', { keyId });
    await db.prepare('UPDATE members SET role_since = ? WHERE org_id = ? AND user_id = ?').bind(Date.now() + 60_000, m.org, second.userId).run();
    await stepUp(google, second, a.id);
    const out = await actionOf(second, a.id);
    expect(out.body).toMatchObject({ status: 'failed', outcome: { code: 'forbidden' } });
    expect(await keyRow(keyId)).toMatchObject({ status: 'pending', confirmed_kind: null });
  });

  it('a confirmation with a Google account other than the session’s is refused (the step-up’s sub)', async () => {
    const { m, app } = await ownerWithScope();
    const { keyId } = await register(m, app.scope);
    await announce(keyId);
    const a = await createAction(m, 'platform.key_confirm', { keyId });
    await stepUp(google, m, a.id, { account: { sub: '9999', email: 'x@partner.example' } });
    expect((await actionOf(m, a.id)).body).toMatchObject({ status: 'failed' });
    expect((await keyRow(keyId))!.confirmed_kind).toBeNull();
  });
});

describe('stop and cancel', () => {
  it('an owner stops a key at once (also in a frozen org) and cancels a waiting one; a viewer can’t; each audited', async () => {
    const { m, app } = await ownerWithScope();
    const { keyId } = await register(m, app.scope);
    const viewer = await member('viewer', { org: m.org });
    expect((await postAs(viewer, `/api/orgs/${m.org}/platform-keys/${keyId}/cancel`, {})).status).toBe(403);
    expect((await postAs(m, `/api/orgs/${m.org}/platform-keys/${keyId}/cancel`, {})).status).toBe(200);
    expect((await keyRow(keyId))!.status).toBe('cancelled');
    const k2 = (await register(m, app.scope, 'Second key')).keyId;
    await announce(k2);
    await db.prepare("UPDATE orgs SET status = 'frozen' WHERE id = ?").bind(m.org).run();
    expect((await postAs(m, `/api/orgs/${m.org}/platform-keys/${k2}/revoke`, { reason: 'Laptop lost' })).status).toBe(200);
    expect((await keyRow(k2))!.status).toBe('revoked');
    expect((await auditRows("action IN ('platform_key.cancelled', 'platform_key.revoked') AND org_id = ? AND outcome = 'ok'", m.org)).map((r) => r.action).sort()).toEqual(['platform_key.cancelled', 'platform_key.revoked']);
    // A frozen org can't confirm or register.
    expect((await postAs(m, `/api/orgs/${m.org}/actions`, { kind: 'platform.key_add', params: { scopeIds: [app.scope], label: 'K', publicKey: await newPublicKey() } })).status).toBe(403);
  });

  it('the CSRF rules hold on every platform key POST, the link ones included', async () => {
    const { m, app } = await ownerWithScope();
    const { keyId } = await register(m, app.scope);
    for (const path of [`/api/orgs/${m.org}/platform-keys/${keyId}/revoke`, `/api/orgs/${m.org}/platform-keys/${keyId}/cancel`, '/api/platform-keys/cancel', '/api/platform-keys/revoke']) {
      const res = await request(path, { method: 'POST', body: { keyId, token: 'A'.repeat(43) }, headers: { cookie: `__Host-hana_cs=${m.cs}`, 'content-type': 'application/json', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } });
      expect(res.status, path).toBe(403);
    }
    expect((await keyRow(keyId))!.status).toBe('pending');
  });

  it('the emailed links: a wrong token is refused (not audited); the cancel link stops a waiting key once', async () => {
    const { m, app } = await ownerWithScope();
    const { keyId } = await register(m, app.scope);
    const token = crypto.getRandomValues(new Uint8Array(32));
    const hash = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', token)));
    expect(await admin().ackPlatformKeyNotice({ ...system(), keyId, cancelTokenHash: hash })).toMatchObject({ ok: true });
    const wrong = await post('/api/platform-keys/cancel', { keyId, token: 'A'.repeat(43) });
    expect(wrong.status).toBe(403);
    expect(await auditRows("action = 'platform_key.link_cancel' AND target = ?", keyId)).toHaveLength(0);
    const right = await post('/api/platform-keys/cancel', { keyId, token: b64url(token) });
    expect(right.status).toBe(200);
    expect((await keyRow(keyId))!.status).toBe('cancelled');
    expect((await post('/api/platform-keys/cancel', { keyId, token: b64url(token) })).status).toBe(409);
    expect((await auditRows("action = 'platform_key.link_cancel' AND target = ?", keyId)).map((r) => r.outcome).sort()).toEqual(['failed', 'ok']);
    expect((await post('/api/platform-keys/revoke', { keyId: 'not-a-key', token: 'A'.repeat(43) })).status).toBe(400);
    expect(CSRF['x-hana-console']).toBe('1');
    expect(DAY).toBeGreaterThan(0);
  });
});

describe('after PR 149’s review: owner since, and the acceptance screen', () => {
  const grant = (org: string, userId: string, o: { ownerFrom: number; appliedAt?: number | null }) =>
    db
      .prepare("INSERT INTO owner_grants (id, org_id, user_id, granted_by_kind, granted_by, created_at, notified_at, owner_from, applied_at) VALUES (?, ?, ?, 'hana', 's', ?, ?, ?, ?)")
      .bind(`og_${Math.random().toString(36).slice(2, 12)}`, org, userId, o.ownerFrom - 1000, o.ownerFrom - 1000, o.ownerFrom, o.appliedAt ?? null)
      .run();

  it('an owner since before the key counts only without a break: an old applied grant, a demotion, a removal and re-adding all reset it', async () => {
    const { m, app } = await ownerWithScope();
    const now = Date.now();
    // Promoted by a grant long ago (applied), later demoted to viewer; a new grant matured after the key's registration.
    const demoted = await member('viewer', { org: m.org });
    await grant(m.org, demoted.userId, { ownerFrom: now - 90 * DAY, appliedAt: now - 90 * DAY });
    await db.prepare('UPDATE members SET role_since = ? WHERE org_id = ? AND user_id = ?').bind(now - 10 * DAY, m.org, demoted.userId).run();
    await grant(m.org, demoted.userId, { ownerFrom: now - 5_000 });
    // Removed and added again (as a viewer, now), with its old applied grant still on file and a new matured one.
    const readded = await member('viewer', { org: m.org });
    await grant(m.org, readded.userId, { ownerFrom: now - 200 * DAY, appliedAt: now - 200 * DAY });
    await db.prepare('DELETE FROM members WHERE org_id = ? AND user_id = ?').bind(m.org, readded.userId).run();
    await db.prepare("INSERT INTO members (org_id, user_id, role, role_since, added_by, added_at) VALUES (?, ?, 'viewer', ?, 'test', ?)").bind(m.org, readded.userId, now - 3_000, now - 3_000).run();
    await grant(m.org, readded.userId, { ownerFrom: now - 2_000 });
    // A viewer whose grant matured before the key: an owner since then.
    const steady = await member('viewer', { org: m.org });
    await db.prepare('UPDATE members SET role_since = ? WHERE org_id = ? AND user_id = ?').bind(now - 30 * DAY, m.org, steady.userId).run();
    await grant(m.org, steady.userId, { ownerFrom: now - 20 * DAY });
    await setScope({ id: app.scope, owners: [oidc(m.sub), oidc(demoted.sub), oidc(readded.sub), oidc(steady.sub)] });
    const keyId = await fourEyesKey(m.org, app.scope, m, now - 60_000);
    const ability = async (who: Member) => (await getAs<{ confirm: { allowed: boolean; reason?: string } }>(who, `/api/orgs/${m.org}/platform-keys/${keyId}`)).body.confirm;
    expect(await ability(demoted)).toMatchObject({ allowed: false, reason: expect.stringMatching(/already an owner when the key was registered/u) });
    expect(await ability(readded)).toMatchObject({ allowed: false, reason: expect.stringMatching(/already an owner when the key was registered/u) });
    expect(await ability(steady)).toEqual({ allowed: true });
  });

  it('on a real-money setup the acceptance screen refuses an owner with the registering staffer’s email before any sign-in', async () => {
    const { m, app } = await ownerWithScope();
    // A staff key under four eyes (as the API writes one on mainnet), registered by staff whose email this owner shares.
    const p = await parsePlatformPublicKey(await newPublicKey());
    if (!p.ok) throw new Error(p.problem);
    const id = newId('platformKey');
    await hot
      .prepare(
        `INSERT INTO platform_keys (id, org_id, label, alg, public_key, thumbprint, scopes_json, status, proposed_by_kind, proposed_by, proposer_email_key, proposer_email, proposal_note, proposed_at, four_eyes, min_delay_ms, request_id)
         VALUES (?1, ?2, 'Staff key', 'ES256', ?3, ?4, ?5, 'awaiting_acceptance', 'hana', 'access-sub', ?6, ?6, 'phone', ?7, 1, 86400000, ?8)`,
      )
      .bind(id, m.org, p.key.raw, p.key.thumbprint, JSON.stringify([app.scope]), m.email.replace(/^m-/u, 'm'), Date.now(), `r_${id}`)
      .run();
    await db.prepare('UPDATE console_users SET email = ? WHERE id = ?').bind(m.email.replace(/^m-/u, 'm.'), m.userId).run();
    const page = await getAs<{ accept: { allowed: boolean; reason?: string } }>(m, `/api/orgs/${m.org}/platform-keys/${id}`);
    expect(page.body.accept).toMatchObject({ allowed: false, reason: expect.stringMatching(/same email address as the person who registered/u) });
    expect((await postAs(m, `/api/orgs/${m.org}/actions`, { kind: 'platform.key_accept', params: { keyId: id } })).status).toBe(403);
  });
});
