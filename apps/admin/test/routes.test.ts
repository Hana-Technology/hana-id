// The staff screens' BFF over the real AdminRpc and StaffRpc (docs/batch-c-spec.md "Admin BFF routes", "Tests: Admin
// and email"): the staff actor lands in `app_changes` and `audit_log`; an AdminRpc suspension works with the console
// Worker down; createApp and assignScopeOrg get the org's owners' subs from listMembers; contacts, members, invites,
// owner grants, apps, changes, keys; the audit view and its CSV; no user export route (the Users screen: users.test.ts).
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.ts';
import { csvCell } from '../src/csv.ts';
import { ROUTE_TABLE } from '../src/routes.ts';
import { ADMIN, CSRF, STAFF_EMAIL, STAFF_SUB, adminRequest, downBinding, envWith, hotVersion, json, overrideBinding, seedConsoleMember, seedConsoleOrg, seedHotApp, staffJwt, stubNetwork, uid } from './helpers.ts';

beforeEach(async () => {
  await stubNetwork();
});
afterEach(() => vi.restoreAllMocks());

const lastChange = (appId: string) =>
  env.HOT_DB.prepare('SELECT kind, actor_kind, actor_id, request_id FROM app_changes WHERE app_id = ?1 ORDER BY seq DESC LIMIT 1').bind(appId).first<{ kind: string; actor_kind: string; actor_id: string; request_id: string }>();

describe('the staff actor', () => {
  it('lands in app_changes (an app suspension) and in audit_log (an org freeze), with the request id', async () => {
    const app = await seedHotApp();
    const res = await adminRequest(`/api/apps/${app.id}/suspend`, { body: { bit: 1 }, headers: { 'cf-ray': `ray-${uid()}-SIN` } });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ suspendedBy: 1 });
    const row = await lastChange(app.id);
    expect(row).toMatchObject({ actor_kind: 'hana', actor_id: STAFF_SUB });
    expect(row!.request_id).toMatch(/^ray-/u);
    expect(await json(await adminRequest(`/api/apps/${app.id}/resume`, { body: { bit: 1 } }))).toEqual({ suspendedBy: 0 });

    const org = await seedConsoleOrg();
    expect((await adminRequest(`/api/orgs/${org}/freeze`, { body: { frozen: true } })).status).toBe(200);
    const audit = await env.CONSOLE_TEST_DB.prepare("SELECT actor_kind, actor_id, actor_email FROM audit_log WHERE org_id = ? AND action LIKE 'org.%' ORDER BY seq DESC LIMIT 1").bind(org).first<{ actor_kind: string; actor_id: string; actor_email: string }>();
    expect(audit).toEqual({ actor_kind: 'hana', actor_id: STAFF_SUB, actor_email: STAFF_EMAIL });
  });

  it('the body cannot set the actor or the request id', async () => {
    const app = await seedHotApp();
    const res = await adminRequest(`/api/apps/${app.id}/suspend`, { body: { bit: 1, actor: { kind: 'system', id: 'x' }, requestId: 'req_forged_123' } });
    expect(res.status).toBe(200);
    const row = await lastChange(app.id);
    expect(row).toMatchObject({ actor_kind: 'hana', actor_id: STAFF_SUB });
    expect(row!.request_id).not.toBe('req_forged_123');
  });

  it('an AdminRpc suspension works with the console Worker down; a console route answers 503', async () => {
    const app = await seedHotApp();
    const down = envWith({ CONSOLE: downBinding() });
    const jwt = await staffJwt();
    const post = (path: string, body: unknown) => worker.fetch(new Request(`${ADMIN}${path}`, { method: 'POST', headers: { ...CSRF, 'cf-access-jwt-assertion': jwt }, body: JSON.stringify(body) }), down);
    const res = await post(`/api/apps/${app.id}/suspend`, { bit: 1 });
    expect(res.status).toBe(200);
    expect((await lastChange(app.id))!.kind).toMatch(/suspen/u);
    const org = await post(`/api/orgs/${app.org}/freeze`, { frozen: true });
    expect(org.status).toBe(503);
    expect(await json(org)).toMatchObject({ error: { code: 'upstream_unavailable' } });
  });

  it('RPC refusals keep their console-core status', async () => {
    const app = await seedHotApp();
    expect((await adminRequest(`/api/apps/${app.id}/origins`, { body: { orgId: app.org, add: ['https://x.partner.example'], expectedVersion: 999 } })).status).toBe(409);
    expect((await adminRequest(`/api/apps/${app.id}/origins`, { body: { orgId: app.org, add: ['javascript:alert(1)'], expectedVersion: (await hotVersion(app.id)).origins } })).status).toBe(400);
    expect((await adminRequest(`/api/apps/app_nope12345/delete`, { body: {} })).status).toBe(404);
    expect((await adminRequest(`/api/apps/${app.id}/suspend`, { body: { bit: 3 } })).status).toBe(400);
  });
});

describe('orgs, contacts, members, invites, grants', () => {
  it('GET /api/orgs/:org: the org, members, invites, live grants, contacts, apps and the owner/contact flag', async () => {
    const app = await seedHotApp(undefined, { contacts: ['sec@partner.example'] });
    await seedConsoleOrg(app.org, 'Acme');
    const owner = await seedConsoleMember(app.org, 'owner');
    const viewer = await seedConsoleMember(app.org, 'viewer');
    expect((await adminRequest(`/api/orgs/${app.org}/members/${viewer.id}`, { body: { role: 'owner' } })).status).toBe(200);
    const d = await json<{ org: { name: string }; members: unknown[]; grants: { userId: string }[]; securityContacts: string[]; apps: { id: string }[]; flags: { noSecurityContacts: boolean; ownersNotContacts: string[] } }>(await adminRequest(`/api/orgs/${app.org}`));
    expect(d.org.name).toBe('Acme');
    expect(d.members).toHaveLength(2);
    expect(d.grants.map((g) => g.userId)).toEqual([viewer.id]);
    expect(d.securityContacts).toEqual(['sec@partner.example']);
    expect(d.apps.map((a) => a.id)).toEqual([app.id]);
    expect(d.flags).toEqual({ noSecurityContacts: false, ownersNotContacts: [owner.email] });
    expect(JSON.stringify(d)).not.toMatch(/hash|token/iu);
    const members = await json<{ grants: unknown[] }>(await adminRequest(`/api/orgs/${app.org}/members`));
    expect(members.grants).toHaveLength(1);
    const grantId = (members.grants[0] as { id: string }).id;
    expect((await adminRequest(`/api/owner-grants/${grantId}/cancel`, { body: {} })).status).toBe(200);
    expect((await json<{ grants: unknown[] }>(await adminRequest(`/api/orgs/${app.org}/members`))).grants).toEqual([]);
  });

  it('PUT security-contacts lowercases and replaces; the API writes old and new into app_changes', async () => {
    const app = await seedHotApp(undefined, { contacts: ['old@partner.example'] });
    const res = await adminRequest(`/api/orgs/${app.org}/security-contacts`, { method: 'PUT', body: { emails: [' New@Partner.Example ', 'other@partner.example'] } });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ emails: ['new@partner.example', 'other@partner.example'] });
    const row = await env.HOT_DB.prepare("SELECT detail_json, actor_id FROM app_changes WHERE org_id = ?1 AND kind = 'org.security_contacts'").bind(app.org).first<{ detail_json: string; actor_id: string }>();
    expect(JSON.parse(row!.detail_json)).toEqual({ old: ['old@partner.example'], new: ['new@partner.example', 'other@partner.example'] });
    expect(row!.actor_id).toBe(STAFF_SUB);
  });

  it('invites: issue (no token in the answer), revoke; members: remove, disable', async () => {
    const org = await seedConsoleOrg();
    await seedConsoleMember(org, 'owner');
    const v = await seedConsoleMember(org, 'viewer');
    const issued = await adminRequest('/api/invites', { body: { email: `p-${uid()}@partner.example`, role: 'viewer', orgId: org } });
    expect(issued.status).toBe(200);
    const { invite } = await json<{ invite: { id: string; notifiedAt?: number } }>(issued);
    expect(invite.notifiedAt).toBeUndefined();
    expect((await adminRequest(`/api/invites/${invite.id}/revoke`, { body: {} })).status).toBe(200);
    expect((await adminRequest(`/api/invites/${invite.id}/revoke`, { body: {} })).status).toBe(409);
    expect((await adminRequest(`/api/users/${v.id}/disable`, { body: { disabled: true } })).status).toBe(200);
    expect((await adminRequest(`/api/orgs/${org}/members/${v.id}`, { body: { role: null } })).status).toBe(200);
    const left = await json<{ members: unknown[] }>(await adminRequest(`/api/orgs/${org}/members`));
    expect(left.members).toHaveLength(1);
  });
});

describe('apps, changes, keys', () => {
  it('createApp and assignScopeOrg pass the org’s usable owners’ subs from listMembers (not viewers, not disabled)', async () => {
    const org = await seedConsoleOrg();
    const o1 = await seedConsoleMember(org, 'owner');
    await seedConsoleMember(org, 'viewer');
    await seedConsoleMember(org, 'owner', { disabled: true });
    const calls: Record<string, unknown>[] = [];
    const api = overrideBinding(env.API, {
      createApp: async (c) => {
        calls.push(c as Record<string, unknown>);
        return { ok: true, app: { id: 'app_new' }, publishableKey: 'pk_test_x', createdScope: false };
      },
      assignScopeOrg: async (c) => {
        calls.push(c as Record<string, unknown>);
        return { ok: true, apps: 2 };
      },
    });
    const jwt = await staffJwt();
    const post = (path: string, body: unknown) => worker.fetch(new Request(`${ADMIN}${path}`, { method: 'POST', headers: { ...CSRF, 'cf-access-jwt-assertion': jwt }, body: JSON.stringify(body) }), envWith({ API: api }));
    const res = await post('/api/apps', { orgId: org, scopeId: 'sabc', environment: 'test', name: 'App', origins: ['https://a.partner.example'], orgOwnerSubs: ['forged'] });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ app: { id: 'app_new' }, publishableKey: 'pk_test_x', createdScope: false });
    expect(calls[0]).toMatchObject({ orgId: org, scopeId: 'sabc', environment: 'test', name: 'App', origins: ['https://a.partner.example'], orgOwnerSubs: [o1.sub], actor: { kind: 'hana', id: STAFF_SUB } });
    expect((await post('/api/scopes/sabc/assign', { orgId: org })).status).toBe(200);
    expect(calls[1]).toMatchObject({ scopeId: 'sabc', orgId: org, orgOwnerSubs: [o1.sub] });
    // The real API refuses an app for an org with no security contact before it reads the chain.
    const real = await adminRequest('/api/apps', { body: { orgId: org, scopeId: 'sabc', environment: 'test', name: 'App', origins: [] } });
    expect(real.status).toBe(409);
    expect(await json(real)).toMatchObject({ error: { code: 'no_security_contact' } });
  });

  it('origins: propose and remove; changes: cancel and the expedite rules; keys: revoke; app detail and the org’s changes', async () => {
    const app = await seedHotApp();
    const v = await hotVersion(app.id);
    const added = await json<{ changes: { id: string; status: string }[] }>(await adminRequest(`/api/apps/${app.id}/origins`, { body: { orgId: app.org, add: ['https://new.partner.example'], expectedVersion: v.origins } }));
    expect(added.changes[0]).toMatchObject({ status: 'pending' });
    const id = added.changes[0]!.id;
    // A staff proposal is never expedited.
    expect((await adminRequest(`/api/changes/${id}/expedite`, { body: { reason: 'Confirmed with the contact by phone today' } })).status).toBe(403);
    expect((await adminRequest(`/api/changes/${id}/cancel`, { body: { orgId: app.org } })).status).toBe(200);
    const detail = await json<{ app: { origins: { origin: string }[]; keys: { id: string }[]; originsVersion: number } }>(await adminRequest(`/api/apps/${app.id}?org=${app.org}`));
    expect(detail.app.origins.map((o) => o.origin)).toEqual(['https://app.partner.example']);
    expect((await adminRequest(`/api/apps/${app.id}?org=org_other12345`)).status).toBe(404);
    const removed = await adminRequest(`/api/apps/${app.id}/origins/remove`, { body: { orgId: app.org, remove: ['https://app.partner.example'], expectedVersion: detail.app.originsVersion } });
    expect(removed.status).toBe(200);
    expect((await adminRequest(`/api/apps/${app.id}/keys/${detail.app.keys[0]!.id}/revoke`, { body: { orgId: app.org } })).status).toBe(200);
    expect((await adminRequest(`/api/apps/${app.id}/off`, { body: { orgId: app.org, what: 'policy', expectedVersion: (await hotVersion(app.id)).settings } })).status).toBe(200);
    const changes = await json<{ changes: { kind: string; actorId: string }[] }>(await adminRequest(`/api/orgs/${app.org}/changes`));
    expect(changes.changes.map((c) => c.kind)).toEqual(expect.arrayContaining(['origin.proposed', 'change.cancelled', 'origin.removed', 'key.revoked']));
    expect(changes.changes.every((c) => c.actorId === STAFF_SUB || c.actorId !== '')).toBe(true);
    expect((await adminRequest(`/api/apps/${app.id}/delete`, { body: {} })).status).toBe(200);
  });
});

describe('audit and CSV', () => {
  it('GET /api/audit: console rows by filter, and with an org filter its app changes', async () => {
    const app = await seedHotApp();
    await seedConsoleOrg(app.org);
    await adminRequest(`/api/orgs/${app.org}/freeze`, { body: { frozen: true } });
    await adminRequest(`/api/apps/${app.id}/suspend`, { body: { bit: 1 } });
    const d = await json<{ rows: { action: string; orgId: string }[]; changes: { kind: string }[] | null }>(await adminRequest(`/api/audit?orgId=${app.org}`));
    expect(d.rows.map((r) => r.action)).toContain('org.frozen');
    expect(d.rows.every((r) => r.orgId === app.org)).toBe(true);
    expect(d.changes!.length).toBeGreaterThan(0);
    const all = await json<{ changes: unknown }>(await adminRequest('/api/audit'));
    expect(all.changes).toBeNull();
    expect((await adminRequest('/api/audit?from=abc')).status).toBe(400);
  });

  it('GET /api/audit.csv merges both sources newest first, safe against formula injection', async () => {
    const app = await seedHotApp();
    await seedConsoleOrg(app.org, '=HYPERLINK("http://evil.example")');
    await adminRequest(`/api/orgs/${app.org}/freeze`, { body: { frozen: true } });
    // A partner-controlled value in a detail: the app's name.
    await env.HOT_DB.prepare('UPDATE apps SET name = ?1 WHERE id = ?2').bind('@SUM(1+1)', app.id).run();
    await adminRequest(`/api/apps/${app.id}/delete`, { body: {} });
    const res = await adminRequest(`/api/audit.csv?orgId=${app.org}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="audit-sandbox-test-\d{4}-\d{2}-\d{2}\.csv"$/u);
    const text = await res.text();
    const lines = text.split('\r\n');
    expect(lines[0]).toBe('source,seq,at,org_id,app_id,scope_id,action,actor_kind,actor_id,actor_email,target,outcome,request_id,near_tx,country,detail');
    expect(text).toContain('app_changes');
    expect(text).toContain('audit_log');
    expect(text).toContain('app.deleted');
    // The detail JSON is one quoted cell: the name inside it can't start a cell.
    expect(text).not.toMatch(/(^|,)@SUM/mu);
    const ats = lines.slice(1).filter(Boolean).map((l) => l.split(',')[2]!);
    expect([...ats].sort().reverse()).toEqual(ats);
  });

  it('csvCell: quoting and the formula prefix, numbers untouched', () => {
    expect(csvCell('=cmd|calc')).toBe("'=cmd|calc");
    expect(csvCell('@x')).toBe("'@x");
    expect(csvCell('-x')).toBe("'-x");
    expect(csvCell('+1+1')).toBe("'+1+1");
    expect(csvCell('-12')).toBe('-12');
    expect(csvCell(-12)).toBe('-12');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
    expect(csvCell(null)).toBe('');
  });
});

describe('the route table', () => {
  it('is the spec’s C8 routes, C12’s, C13’s, C14’s, C8b’s Users routes, C15’s lookup (POST) and the System status (D425); no user export', () => {
    expect(ROUTE_TABLE).toMatchInlineSnapshot(`
      [
        "GET /api/me",
        "GET /api/status",
        "GET /api/orgs",
        "GET /api/orgs/:org",
        "POST /api/orgs/:org/freeze",
        "POST /api/orgs/:org/suspend",
        "PUT /api/orgs/:org/security-contacts",
        "GET /api/orgs/:org/members",
        "POST /api/orgs/:org/members/:user",
        "GET /api/orgs/:org/changes",
        "POST /api/invites",
        "POST /api/invites/:id/revoke",
        "POST /api/users/:user/disable",
        "POST /api/owner-grants/:id/cancel",
        "POST /api/apps",
        "POST /api/scopes/:scope/assign",
        "GET /api/apps/:app",
        "POST /api/apps/:app/suspend",
        "POST /api/apps/:app/resume",
        "POST /api/apps/:app/delete",
        "POST /api/apps/:app/origins",
        "POST /api/apps/:app/origins/remove",
        "POST /api/apps/:app/changes",
        "POST /api/apps/:app/off",
        "POST /api/apps/:app/mainnet-demo",
        "POST /api/apps/:app/keys/:key/revoke",
        "POST /api/changes/:id/cancel",
        "POST /api/changes/:id/expedite",
        "GET /api/audit",
        "GET /api/audit.csv",
        "GET /api/security",
        "GET /api/monitoring",
        "GET /api/monitoring/alerts",
        "GET /api/monitoring/actions",
        "POST /api/monitoring/alerts/:id/ack",
        "GET /api/governance/pending-upgrades",
        "GET /api/playbooks",
        "GET /api/playbooks/:id",
        "GET /api/reports",
        "GET /api/statements",
        "GET /api/statements/:org/:month",
        "POST /api/statements/:org/:month/issue",
        "POST /api/exports/:org/:month",
        "GET /api/exports/:org/:month/:file",
        "GET /api/rates",
        "PUT /api/rates/:day",
        "GET /api/retention",
        "GET /api/email/issuer",
        "GET /api/email/links",
        "POST /api/users/search",
        "POST /api/users/find",
        "POST /api/users/get",
        "POST /api/support/lookup",
      ]
    `);
    // The only exports are C12's ledger CSVs (/api/exports/:org/:month): no user export.
    expect(ROUTE_TABLE.join('\n')).not.toMatch(/users?\/export|export\/users?|\.csv.*users|users.*\.csv|GET \/api\/support/u);
    // The Users routes and the Support ID lookup are POST only: no address, sub or code in a URL.
    expect(ROUTE_TABLE.filter((x) => /\/api\/(users\/(search|find|get)|support\/lookup)$/u.test(x)).every((x) => x.startsWith('POST '))).toBe(true);
  });
});
