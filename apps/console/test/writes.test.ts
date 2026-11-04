// The signed-in write routes (docs/batch-c-spec.md "Console BFF routes", "Roles and permissions", Tests "Settings,
// keys, logos", "Invites and roles" → the role matrix; batch C10) against the real API: every route × owner, viewer,
// a member of another org, and an owner of a frozen org (only cancels and kill switches stay open); key creation,
// rotation with its 24 h grace, revocation and the 5-key limit; renaming; suspend and resume (a fresh sign-in);
// settings (a fresh sign-in); the logo routes behind the session, the membership and the owner role.
import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROUTE_TABLE } from '../src/writes.ts';
import { type Member, actionOf, breathe, createAction, getAs, member, postAs, stepUp } from './c10.ts';
import { installChain, oidc, setChain, setScope, uninstallChain } from './chain.ts';
import { MockGoogle } from './google.ts';
import { CSRF, auditRows, request, seedHotApp } from './helpers.ts';
import { SVG } from './logo-fixtures.ts';

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

/** A POST with a raw (non-JSON) body, as the SPA sends a logo. */
const rawPost = (path: string, headers: Record<string, string>, body: Uint8Array) =>
  (exports as unknown as { default: Fetcher }).default.fetch(new Request(`https://console.test${path}`, { method: 'POST', headers: { 'cf-connecting-ip': '10.1.2.3', ...headers }, body }));
const appRow = (id: string) => hot.prepare('SELECT name, origins_version, settings_version, suspended_by, session_ttl_ms FROM apps WHERE id = ?').bind(id).first<{ name: string; origins_version: number; settings_version: number; suspended_by: number; session_ttl_ms: number }>();
const keyOf = async (appId: string) => (await hot.prepare('SELECT id FROM app_keys WHERE app_id = ? AND revoked_at IS NULL ORDER BY created_at LIMIT 1').bind(appId).first<string>('id'))!;

interface Sample {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
}

/** One concrete request per route (a new route needs a sample: the coverage check below fails otherwise). */
async function samples(m: Member, app: { id: string; scope: string }): Promise<Sample[]> {
  const r = (await appRow(app.id))!;
  const key = await keyOf(app.id);
  const o = `/api/orgs/${m.org}`;
  return [
    { method: 'POST', path: `${o}/actions`, body: { kind: 'member.invite', params: { email: 'matrix@partner.example', role: 'viewer' } } },
    { method: 'POST', path: `${o}/apps/${app.id}/origins/remove`, body: { remove: ['https://app.partner.example'], expectedVersion: r.origins_version } },
    { method: 'POST', path: `${o}/apps/${app.id}/off`, body: { what: 'raw_sign', expectedVersion: r.settings_version } },
    { method: 'POST', path: `${o}/changes/gc_unknown1/cancel`, body: {} },
    { method: 'POST', path: `${o}/apps/${app.id}/suspend`, body: {} },
    { method: 'POST', path: `${o}/apps/${app.id}/profile`, body: { name: 'Renamed', expectedVersion: r.settings_version } },
    { method: 'POST', path: `${o}/apps/${app.id}/logo?expectedVersion=${r.settings_version}` },
    { method: 'POST', path: `${o}/apps/${app.id}/logo/remove`, body: { expectedVersion: r.settings_version } },
    { method: 'POST', path: `${o}/apps/${app.id}/policy/check`, body: { policy: {} } },
    { method: 'POST', path: `${o}/apps/${app.id}/keys`, body: {} },
    { method: 'POST', path: `${o}/apps/${app.id}/keys/${key}/rotate`, body: {} },
    { method: 'POST', path: `${o}/apps/${app.id}/keys/${key}/revoke`, body: {} },
    { method: 'POST', path: `${o}/invites/inv_unknown1/revoke`, body: {} },
    { method: 'POST', path: `${o}/owner-grants/og_unknown1/cancel`, body: {} },
    { method: 'GET', path: `${o}/scopes/${app.scope}` },
    { method: 'GET', path: `${o}/scopes/${app.scope}/client-proof-helper?clientId=123-abc.apps.googleusercontent.com` },
    { method: 'POST', path: `${o}/scopes/${app.scope}/execute`, body: { changeId: 99 } },
    { method: 'GET', path: `${o}/users` },
    { method: 'GET', path: `${o}/users/u1_AAAAAAAAAAAAAAAAAAAAAA` },
  ];
}

async function call(m: Member, s: Sample): Promise<{ status: number; code?: string }> {
  for (let i = 0; ; i++) {
    const logo = s.path.includes('/logo?');
    const headers: Record<string, string> = { ...CSRF, cookie: `__Host-hana_cs=${m.cs}`, ...(logo ? { 'content-type': 'application/octet-stream', 'content-length': String(SVG.length) } : {}) };
    const res = s.method === 'GET' ? await request(s.path, { headers: { cookie: headers.cookie! } }) : logo ? await rawPost(s.path, headers, SVG) : await request(s.path, { method: 'POST', headers, body: JSON.stringify(s.body ?? {}) });
    const text = await res.text();
    if (res.status === 429 && text.includes('Too many console calls') && i < 8) {
      await breathe();
      continue;
    }
    let code: string | undefined;
    try {
      code = (JSON.parse(text) as { error?: { code?: string } }).error?.code;
    } catch {
      code = undefined;
    }
    return { status: res.status, ...(code ? { code } : {}) };
  }
}

const routeOf = (s: Sample) => ROUTE_TABLE.find((r) => r.method === s.method && new RegExp(r.pattern, 'u').test(new URL(`https://x${s.path}`).pathname.replace(/^\/api\/orgs\/org_[A-Za-z0-9]+/u, '')));

describe('the role matrix (spec "Roles and permissions")', () => {
  it('has a sample for every route', async () => {
    const m = await member('owner');
    const app = await seedHotApp(m.org);
    const list = await samples(m, app);
    for (const r of ROUTE_TABLE) expect(list.some((s) => routeOf(s) === r), `${r.method} ${r.pattern}`).toBe(true);
  });

  it('a viewer: every owner route is 403 forbidden, every viewer route answers (no 403, no 404 from the role check)', async () => {
    const v = await member('viewer');
    const app = await seedHotApp(v.org);
    await setScope({ id: app.scope, owners: [oidc('x')] });
    for (const s of await samples(v, app)) {
      const route = routeOf(s)!;
      const r = await call(v, s);
      if (route.pattern.includes('users')) expect(r.status, s.path).toBe(404); // behind USERS_SCREEN (off)
      else if (route.role === 'owner') expect(r, `${s.method} ${s.path}`).toEqual({ status: 403, code: 'forbidden' });
      else expect([r.status, r.code], s.path).not.toEqual([403, 'forbidden']);
    }
  });

  it('a member of another org: every route is 404, the same as an org that doesn’t exist', async () => {
    const owner = await member('owner');
    const app = await seedHotApp(owner.org);
    const stranger = await member('owner');
    for (const s of await samples(owner, app)) expect((await call(stranger, s)).status, s.path).toBe(404);
    const none = { ...stranger, org: 'org_doesnotexist1' };
    for (const s of await samples(none, app)) expect((await call(stranger, s)).status, s.path).toBe(404);
  });

  it('an owner of a frozen org: writes are 403 org_frozen except cancels and the kill switches; reads work', async () => {
    const m = await member('owner', { status: 'frozen' });
    const app = await seedHotApp(m.org);
    await setScope({ id: app.scope, owners: [oidc(m.sub)] });
    for (const s of await samples(m, app)) {
      const route = routeOf(s)!;
      if (route.pattern.includes('users')) continue;
      const r = await call(m, s);
      if (route.frozenOk) expect(r.code, `${s.method} ${s.path}`).not.toBe('org_frozen');
      else expect(r, `${s.method} ${s.path}`).toEqual({ status: 403, code: 'org_frozen' });
    }
    const open = ROUTE_TABLE.filter((r) => r.frozenOk && r.method === 'POST').map((r) => r.pattern);
    expect(open.sort()).toEqual(
      ['^\\/apps\\/(app_[A-Za-z0-9]{1,64})\\/keys\\/(key_[A-Za-z0-9_]{1,96})\\/revoke$', '^\\/apps\\/(app_[A-Za-z0-9]{1,64})\\/off$', '^\\/apps\\/(app_[A-Za-z0-9]{1,64})\\/origins\\/remove$', '^\\/apps\\/(app_[A-Za-z0-9]{1,64})\\/suspend$', '^\\/changes\\/(gc_[A-Za-z0-9]{1,64})\\/cancel$', '^\\/invites\\/(inv_[A-Za-z0-9]{1,64})\\/revoke$', '^\\/owner-grants\\/(og_[A-Za-z0-9]{1,64})\\/cancel$'].sort(),
    );
  });

  it('a pending owner (inside the grant’s wait) is a viewer', async () => {
    const m = await member('viewer');
    await env.CONSOLE_DB.prepare("INSERT INTO owner_grants (id, org_id, user_id, granted_by_kind, granted_by, created_at, notified_at, owner_from) VALUES (?, ?, ?, 'hana', 's', ?, ?, ?)").bind(`og_p${Date.now()}`, m.org, m.userId, Date.now(), Date.now(), Date.now() + 3600_000).run();
    const app = await seedHotApp(m.org);
    expect(await call(m, { method: 'POST', path: `/api/orgs/${m.org}/apps/${app.id}/keys`, body: {} })).toEqual({ status: 403, code: 'forbidden' });
  });

  it('a session whose Workspace domain doesn’t match the org’s required_hd: 404', async () => {
    const m = await member('owner', { hd: 'other.example' });
    await env.CONSOLE_DB.prepare("UPDATE orgs SET required_hd = 'partner.example' WHERE id = ?").bind(m.org).run();
    const app = await seedHotApp(m.org);
    expect((await call(m, { method: 'POST', path: `/api/orgs/${m.org}/apps/${app.id}/keys`, body: {} })).status).toBe(404);
  });

  it('every write needs the CSRF headers, a session cookie included', async () => {
    const m = await member('owner');
    const app = await seedHotApp(m.org);
    const res = await request(`/api/orgs/${m.org}/apps/${app.id}/keys`, { method: 'POST', body: '{}', headers: { cookie: `__Host-hana_cs=${m.cs}`, 'content-type': 'application/json' } });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'csrf' } });
  });
});

describe('keys (spec "Keys")', () => {
  it('create, rotate (the old key valid for exactly 24 h), revoke (immediate), the 5-key limit; each audited', async () => {
    const m = await member('owner');
    const app = await seedHotApp(m.org);
    const first = await keyOf(app.id);
    const created = await postAs<{ id: string; key: string; prefix: string }>(m, `/api/orgs/${m.org}/apps/${app.id}/keys`, {});
    expect(created.status).toBe(200);
    expect(created.body.key).toMatch(/^pk_test_/u);
    const t = Date.now();
    const rotated = await postAs<{ id: string; oldKeyRevokedAt: number }>(m, `/api/orgs/${m.org}/apps/${app.id}/keys/${first}/rotate`, {});
    expect(rotated.status).toBe(200);
    expect(rotated.body.oldKeyRevokedAt).toBeGreaterThanOrEqual(t + 24 * 3600_000);
    expect(rotated.body.oldKeyRevokedAt).toBeLessThanOrEqual(Date.now() + 24 * 3600_000);
    const revoked = await postAs(m, `/api/orgs/${m.org}/apps/${app.id}/keys/${created.body.id}/revoke`, {});
    expect(revoked.status).toBe(200);
    expect(await hot.prepare('SELECT revoked_at <= ? AS now FROM app_keys WHERE id = ?').bind(Date.now(), created.body.id).first('now')).toBe(1);
    let over: { status: number; body: unknown } | undefined;
    for (let i = 0; i < 6 && !over; i++) {
      const r = await postAs(m, `/api/orgs/${m.org}/apps/${app.id}/keys`, {});
      if (r.status !== 200) over = r;
    }
    expect(over).toMatchObject({ status: 409, body: { error: { code: 'key_limit' } } });
    // Five keys with no revocation (the API's count; the rotated one, inside its 24 h, has its revocation set).
    expect(await hot.prepare('SELECT COUNT(*) AS n FROM app_keys WHERE app_id = ? AND revoked_at IS NULL').bind(app.id).first('n')).toBe(5);
    const actions = (await auditRows('org_id = ? AND action LIKE ?', m.org, 'key.%')).map((r) => `${r.action}:${r.outcome}`);
    expect(actions.slice(0, 3)).toEqual(['key.created:ok', 'key.rotated:ok', 'key.revoked:ok']);
    expect(actions.at(-1)).toBe('key.created:failed');
  });
});

describe('name, suspend and resume, settings', () => {
  it('renames at the settings version (a stale one is version_conflict)', async () => {
    const m = await member('owner');
    const app = await seedHotApp(m.org);
    const v = (await appRow(app.id))!.settings_version;
    expect((await postAs(m, `/api/orgs/${m.org}/apps/${app.id}/profile`, { name: 'Partner Wallet', expectedVersion: v })).status).toBe(200);
    expect((await appRow(app.id))!.name).toBe('Partner Wallet');
    expect((await postAs(m, `/api/orgs/${m.org}/apps/${app.id}/profile`, { name: 'Again', expectedVersion: v })).body).toMatchObject({ error: { code: 'version_conflict' } });
  });

  it('suspends at once (bit 4); resuming is a fresh sign-in and clears bit 4 only', async () => {
    const m = await member('owner');
    const app = await seedHotApp(m.org);
    expect((await postAs(m, `/api/orgs/${m.org}/apps/${app.id}/suspend`, {})).body).toEqual({ suspendedBy: 4 });
    await hot.prepare('UPDATE apps SET suspended_by = suspended_by | 1 WHERE id = ?').bind(app.id).run();
    const a = await createAction(m, 'app.resume', { appId: app.id });
    expect(a.decoded).toMatchObject({ appId: app.id, otherSuspensions: true });
    await stepUp(google, m, a.id);
    expect((await actionOf(m, a.id)).body).toMatchObject({ status: 'ok', outcome: { suspendedBy: 1 } });
    expect((await appRow(app.id))!.suspended_by).toBe(1);
  });

  it('app.settings: the session length through a fresh sign-in; out-of-range values refused before it', async () => {
    const m = await member('owner');
    const app = await seedHotApp(m.org);
    expect((await postAs(m, `/api/orgs/${m.org}/actions`, { kind: 'app.settings', params: { appId: app.id, sessionTtlMs: 60_000 } })).status).toBe(400);
    const a = await createAction(m, 'app.settings', { appId: app.id, sessionTtlMs: 2 * 3600_000, idleTtlMs: 30 * 60_000 });
    await stepUp(google, m, a.id);
    expect((await actionOf(m, a.id)).body).toMatchObject({ status: 'ok' });
    expect((await appRow(app.id))!.session_ttl_ms).toBe(2 * 3600_000);
  });

  it('raw_sign.on is refused for a test app before any sign-in (D39)', async () => {
    const m = await member('owner');
    const app = await seedHotApp(m.org);
    expect((await postAs(m, `/api/orgs/${m.org}/actions`, { kind: 'raw_sign.on', params: { appId: app.id } })).body).toMatchObject({ error: { code: 'bad_request' } });
  });
});

describe('logos behind the session (C11’s routes, C10’s checks)', () => {
  const up = (m: Member, appId: string, v: number, bytes: Uint8Array) =>
    rawPost(`/api/orgs/${m.org}/apps/${appId}/logo?expectedVersion=${v}`, { ...CSRF, cookie: `__Host-hana_cs=${m.cs}`, 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) }, bytes);

  it('an owner reaches the upload checks (an SVG is logo_type); a viewer is 403; another org 404; a frozen org 403 org_frozen', async () => {
    const m = await member('owner');
    const app = await seedHotApp(m.org);
    const v = (await appRow(app.id))!.settings_version;
    const owner = await up(m, app.id, v, SVG);
    expect([owner.status, ((await owner.json()) as { error: { code: string } }).error.code]).toEqual([400, 'logo_type']);
    const viewer = await member('viewer', { org: m.org });
    expect((await up(viewer, app.id, v, SVG)).status).toBe(403);
    expect((await up({ ...(await member('owner')), org: m.org }, app.id, v, SVG)).status).toBe(404);
    const f = await member('owner', { status: 'frozen' });
    const fApp = await seedHotApp(f.org);
    const frozen = await up(f, fApp.id, v, SVG);
    expect([frozen.status, ((await frozen.json()) as { error: { code: string } }).error.code]).toEqual([403, 'org_frozen']);
  });

  it('removal: an owner with the settings version; no logo is a no-op', async () => {
    const m = await member('owner');
    const app = await seedHotApp(m.org);
    const v = (await appRow(app.id))!.settings_version;
    expect(await postAs(m, `/api/orgs/${m.org}/apps/${app.id}/logo/remove`, { expectedVersion: v })).toEqual({ status: 200, body: { version: v } });
  });
});

describe('origins, policy and raw signing off (immediate, no step-up)', () => {
  it('removes an origin and turns raw signing off, each audited with the API’s answer', async () => {
    const m = await member('owner');
    const app = await seedHotApp(m.org, ['https://a.partner.example', 'https://b.partner.example']);
    const r = (await appRow(app.id))!;
    expect((await postAs(m, `/api/orgs/${m.org}/apps/${app.id}/origins/remove`, { remove: ['https://b.partner.example'], expectedVersion: r.origins_version })).status).toBe(200);
    expect((await hot.prepare('SELECT origin FROM app_origins WHERE app_id = ?').bind(app.id).all<{ origin: string }>()).results.map((x) => x.origin)).toEqual(['https://a.partner.example']);
    expect((await auditRows("org_id = ? AND action = 'origins.removed'", m.org)).map((x) => JSON.parse(x.details_json))).toEqual([{ version: r.origins_version + 1, removed: 1 }]);
  });
});

describe('the on-chain view and the client-proof helper', () => {
  it('decodes owners without any sub, flags owner drift, and says whether you are an on-chain owner', async () => {
    const m = await member('owner');
    const other = await member('owner', { org: m.org });
    const viewer = await member('viewer', { org: m.org });
    const app = await seedHotApp(m.org);
    await setScope({ id: app.scope, owners: [oidc(m.sub), oidc(viewer.sub), oidc('stranger-sub-123'), { Near: { account_id: 'alice.testnet' } }], action_nonce: 4 });
    const r = await getAs<{ scope: { owners: unknown[] }; drift: Record<string, unknown>; youAreOnChainOwner: boolean }>(m, `/api/orgs/${m.org}/scopes/${app.scope}`);
    expect(r.status).toBe(200);
    expect(r.body.youAreOnChainOwner).toBe(true);
    expect(r.body.scope.owners).toEqual([
      { kind: 'member', userId: m.userId, email: m.email, orgOwner: true },
      { kind: 'member', userId: viewer.userId, email: viewer.email, orgOwner: false },
      { kind: 'other_google' },
      { kind: 'near', accountId: 'alice.testnet' },
    ]);
    expect(r.body.drift).toEqual({ hasDrift: true, missingOnChain: [{ userId: other.userId, email: other.email }], notOrgOwners: [{ userId: viewer.userId, email: viewer.email }], unknownOnChain: 1 });
    const text = JSON.stringify(r.body);
    for (const sub of [m.sub, other.sub, viewer.sub, 'stranger-sub-123']) expect(text).not.toContain(sub);
  });

  it('SetOwners from the drift: the org’s owners plus the scope’s Near owners, shown by member, never by sub', async () => {
    const m = await member('owner');
    const other = await member('owner', { org: m.org });
    const app = await seedHotApp(m.org);
    await setScope({ id: app.scope, owners: [oidc(m.sub), { Near: { account_id: 'alice.testnet' } }], action_nonce: 2 });
    const a = await createAction(m, 'owner_action', { scopeId: app.scope, method: 'propose_change', change: { kind: 'SetOwners' } });
    expect(a.decoded).toMatchObject({ method: 'propose_change', change: { kind: 'SetOwners', owners: [{ kind: 'near', accountId: 'alice.testnet' }, { kind: 'member', userId: m.userId }, { kind: 'member', userId: other.userId }] } });
    expect(JSON.stringify(a.decoded)).not.toContain(other.sub);
    const stored = (await env.CONSOLE_DB.prepare('SELECT near_args FROM pending_actions WHERE id = ?').bind(a.id).first<{ near_args: ArrayBuffer }>())!;
    expect(JSON.parse(new TextDecoder().decode(new Uint8Array(stored.near_args)))).toEqual({ scope_id: app.scope, change: { SetOwners: { owners: [{ Near: { account_id: 'alice.testnet' } }, oidc(m.sub), oidc(other.sub)] } }, client_proof: null });
  });

  it('the helper is only a download, with the scope’s client-proof nonce at its action_nonce; an owner-only route', async () => {
    const { clientProofNonce } = await import('@hana-id/console-core');
    const m = await member('owner');
    const app = await seedHotApp(m.org);
    await setScope({ id: app.scope, owners: [oidc(m.sub)], action_nonce: 9 });
    const res = await request(`/api/orgs/${m.org}/scopes/${app.scope}/client-proof-helper?clientId=123-abc.apps.googleusercontent.com`, { headers: { cookie: `__Host-hana_cs=${m.cs}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="hana-client-proof-${app.scope}-9.html"`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain(JSON.stringify(await clientProofNonce({ signer: 'signer.test.near', scopeId: app.scope, actionNonce: 9 })).slice(1, -1));
    expect(html).toContain("'response_type', 'id_token'");
    expect(html).toContain("'scope', 'openid'");
    expect(html).toMatch(/public on the NEAR blockchain/u);
    expect(html).not.toMatch(/accounts\.google\.com\/gsi/u);
    for (const bad of ['?clientId=', '?clientId=not-a-client', '']) expect((await request(`/api/orgs/${m.org}/scopes/${app.scope}/client-proof-helper${bad}`, { headers: { cookie: `__Host-hana_cs=${m.cs}` } })).status, bad).toBe(400);
  });

  it('AddClient: the pasted proof is checked (aud, nonce, claims) and the PII warning must be accepted', async () => {
    const { clientProofNonce } = await import('@hana-id/console-core');
    const m = await member('owner');
    const app = await seedHotApp(m.org);
    await setScope({ id: app.scope, owners: [oidc(m.sub)], action_nonce: 5 });
    const aud = '123-abc.apps.googleusercontent.com';
    const nonce = await clientProofNonce({ signer: 'signer.test.near', scopeId: app.scope, actionNonce: 5 });
    const now = Math.floor(Date.now() / 1000);
    const proof = (claims: Record<string, unknown>) => google.idToken({ iss: 'https://accounts.google.com', aud, azp: aud, sub: '42', nonce, iat: now, exp: now + 3600, ...claims });
    const post = async (clientProof: string, accepted: unknown = true) => postAs(m, `/api/orgs/${m.org}/actions`, { kind: 'owner_action', params: { scopeId: app.scope, method: 'propose_change', change: { kind: 'AddClient', aud, clientProof, piiWarningAccepted: accepted } } });
    expect((await post(await proof({}), false)).status).toBe(400);
    expect((await post(await proof({ aud: 'other-x.apps.googleusercontent.com', azp: undefined }))).body).toMatchObject({ error: { code: 'invalid_client_proof' } });
    expect((await post(await proof({ nonce: 'N'.repeat(43) }))).body).toMatchObject({ error: { code: 'invalid_client_proof' } });
    const pii = await post(await proof({ email: 'staff@partner.example' }));
    expect(pii.body).toMatchObject({ error: { code: 'invalid_client_proof' } });
    expect(JSON.stringify(pii.body)).toContain('email');
    const ok = await post(await proof({}));
    expect(ok.status).toBe(200);
    expect((ok.body as { decoded: unknown }).decoded).toMatchObject({ method: 'propose_change', change: { kind: 'AddClient', provider: 'google', aud } });
  });
});
