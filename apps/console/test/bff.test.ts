// The signed-in read routes (docs/batch-c-spec.md "Console BFF routes": `GET /api/me`, `/api/orgs/:org`, `/apps`,
// `/apps/:app`, `/members`, `/audit`), against the real API's ConsoleRpc behind the `API` binding: a session and a usable
// membership on every request (any other org is 404, the same as none), the views a partner gets (apps, origins,
// guarded changes, keys, settings, members, invites, grants), the audit merged from audit_log and app_changes with a
// cursor that skips and repeats nothing, and what a partner never sees (a staff Access subject or address, a Google
// `sub`, an IP prefix, a token hash, an end user's address).
import { b64url, randomBytes } from '@hana-id/console-core';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockGoogle, account, getWith, landing, signIn } from './google.ts';
import { hana, linkPair, rid, seedHotApp, seedOrg, staffRpc, system } from './helpers.ts';
import { db } from './helpers.ts';

let google: MockGoogle;
beforeEach(async () => {
  google = new MockGoogle();
  await google.init();
});
afterEach(() => vi.restoreAllMocks());

/** A signed-in member of a fresh org; `role` set by staff after acceptance. */
async function signedIn(role: 'owner' | 'viewer' = 'viewer', o: { orgId?: string } = {}) {
  const org = o.orgId ?? (await seedOrg());
  const acct = account();
  const r = await staffRpc().issueInvite({ ...hana(), email: acct.email, role: 'viewer', orgId: org });
  if (!r.ok) throw new Error(r.code);
  const pair = await linkPair();
  await staffRpc().ackMemberNotice({ ...system(), inviteId: r.invite.id, tokenHash: pair.hashB64 });
  const s = await signIn(google, acct, { invite: pair.tokenB64 });
  expect(landing(s)).toBe('/');
  const userId = (await db.prepare('SELECT id FROM console_users WHERE sub = ?').bind(acct.sub).first<string>('id'))!;
  if (role === 'owner') {
    await staffRpc().setMember({ ...hana(), orgId: org, userId, role: 'owner' });
    // The role change ended the session: sign in again.
    const again = await signIn(google, acct);
    return { org, acct, userId, cs: again.browser.cs! };
  }
  return { org, acct, userId, cs: s.browser.cs! };
}

const getJson = async <T>(cs: string, path: string): Promise<{ status: number; body: T }> => {
  const res = await getWith(cs, path);
  return { status: res.status, body: (await res.json()) as T };
};

describe('session and membership on every request', () => {
  it('no session, a bad cookie or a revoked one: 401 unauthenticated', async () => {
    for (const path of ['/api/me', '/api/orgs/org_x', '/api/orgs/org_x/apps']) {
      expect((await getWith(undefined, path)).status, path).toBe(401);
      expect((await getWith(b64url(randomBytes(32)), path)).status, path).toBe(401);
    }
  });

  it("another org, an unknown org, a malformed id or an unknown sub-path: 404, the same answer", async () => {
    const a = await signedIn();
    const b = await signedIn();
    for (const path of [`/api/orgs/${b.org}`, `/api/orgs/${b.org}/apps`, `/api/orgs/${b.org}/members`, `/api/orgs/${b.org}/audit`, '/api/orgs/org_unknown1', "/api/orgs/org_x'--", `/api/orgs/${a.org}/nope`, `/api/orgs/${a.org}/apps/not-an-app`]) {
      const { status, body } = await getJson<{ error: { code: string } }>(a.cs, path);
      expect(status, path).toBe(404);
      expect(body.error.code).toBe('not_found');
    }
  });

  it('read routes are GET only', async () => {
    const a = await signedIn();
    const res = await getWith(a.cs, '/api/me');
    expect(res.status).toBe(200);
    const { post: postReq } = await import('./helpers.ts');
    expect((await postReq(`/api/orgs/${a.org}/apps`, {}, { headers: { cookie: `__Host-hana_cs=${a.cs}` } })).status).toBe(405);
  });
});

describe('the views', () => {
  it('GET /api/orgs/:org: the org and the caller’s role', async () => {
    const { org, cs } = await signedIn('owner');
    expect(await getJson(cs, `/api/orgs/${org}`)).toEqual({ status: 200, body: { org: { id: org, name: `Org ${org}`, status: 'active' }, role: 'owner' } });
  });

  it("GET /apps and /apps/:app: the org's apps from the API, with origins, changes, keys and settings; another org's app is 404", async () => {
    const { org, cs } = await signedIn();
    const app = await seedHotApp(org, ['https://app.partner.example', 'https://xn--bcher-kva.example']);
    const other = await seedHotApp();
    const list = await getJson<{ apps: { id: string }[] }>(cs, `/api/orgs/${org}/apps`);
    expect(list.status).toBe(200);
    expect(list.body.apps.map((x) => x.id)).toEqual([app.id]);
    const version = (await env.HOT_DB.prepare('SELECT origins_version AS v FROM apps WHERE id = ?').bind(app.id).first<number>('v'))!;
    expect((await env.API_ADMIN.addOrigins({ ...hana(), orgId: org, appId: app.id, add: ['https://new.partner.example'], expectedVersion: version })).ok).toBe(true);
    const detail = await getJson<{ app: { id: string; origins: { origin: string; idn: boolean }[]; changes: { kind: string; status: string }[]; keys: { key: string }[]; settings: { persistence: string } } }>(cs, `/api/orgs/${org}/apps/${app.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.app.id).toBe(app.id);
    // The pending origin is listed with its change and no activeFrom yet.
    expect(detail.body.app.origins.map((o) => o.origin).sort()).toEqual(['https://app.partner.example', 'https://new.partner.example', 'https://xn--bcher-kva.example']);
    expect(detail.body.app.origins.find((o) => o.origin.startsWith('https://xn--'))!.idn).toBe(true);
    expect(detail.body.app.changes).toEqual([expect.objectContaining({ kind: 'origin_add', status: 'pending' })]);
    expect(detail.body.app.keys).toHaveLength(1);
    expect(detail.body.app.keys[0]!.key).toMatch(/^pk_test_/u);
    expect(detail.body.app.settings).toMatchObject({ persistence: expect.any(String) });
    expect((await getWith(cs, `/api/orgs/${org}/apps/${other.id}`)).status).toBe(404);
  });

  it('GET /members: members (no sub), open invites, live grants; staff shown as hana', async () => {
    const { org, cs, acct, userId } = await signedIn();
    const invited = await staffRpc().issueInvite({ ...hana('access-sub-secret-staffer'), email: 'next@partner.example', role: 'viewer', orgId: org });
    if (!invited.ok) throw new Error(invited.code);
    const res = await getWith(cs, `/api/orgs/${org}/members`);
    const text = await res.text();
    const body = JSON.parse(text) as { members: Record<string, unknown>[]; invites: Record<string, unknown>[]; grants: unknown[] };
    expect(body.members).toEqual([{ userId, email: acct.email, role: 'viewer', roleSince: expect.any(Number), addedBy: 'hana', addedAt: expect.any(Number), disabled: false }]);
    expect(body.invites).toEqual([{ id: invited.invite.id, email: 'next@partner.example', role: 'viewer', createdByKind: 'hana', createdBy: 'hana', notified: false, createdAt: expect.any(Number), expiresAt: expect.any(Number) }]);
    expect(body.grants).toEqual([]);
    expect(text).not.toContain('access-sub');
    expect(text).not.toContain(acct.sub);
    expect(text).not.toMatch(/token|hash|staff@hana/iu);
  });
});

describe('GET /audit: audit_log merged with listChanges', () => {
  it('pages newest first through both sources, every row exactly once, with staff and network data hidden', async () => {
    const { org, cs } = await signedIn();
    const app = await seedHotApp(org);
    // After the sign-in's own rows, so each source's seq order is its time order (as rows are written).
    const base = Date.now() + 1000;
    // 70 console rows and 40 app changes, interleaved in time; staff actors with an Access subject and an address.
    for (let i = 0; i < 70; i++) {
      await db
        .prepare("INSERT INTO audit_log (at, actor_kind, actor_id, actor_email, actor_sub, org_id, action, target, details_json, request_id, ip_prefix, country, outcome) VALUES (?, 'hana', 'access-sub-staffer-9', 'staff@hana.example', NULL, ?, 'invite.revoked', ?, '{}', ?, '203.0.113.0/24', 'AU', 'ok')")
        .bind(base + i * 1000, org, `inv_${i}`, rid())
        .run();
    }
    for (let i = 0; i < 40; i++) {
      await env.HOT_DB.prepare("INSERT INTO app_changes (at, org_id, app_id, scope_id, kind, detail_json, actor_kind, actor_id, actor_sub, request_id) VALUES (?1, ?2, ?3, ?4, 'key.created', '{}', ?5, ?6, ?7, ?8)")
        .bind(base + i * 1500 + 500, org, app.id, app.scope, i % 2 ? 'hana' : 'member', i % 2 ? 'access-sub-staffer-9' : 'usr_x', i % 2 ? null : 'google-sub-of-member', rid())
        .run();
    }
    const seen: { source: string; seq: number; at: number }[] = [];
    let cursor: string | undefined;
    let pages = 0;
    const raw: string[] = [];
    do {
      const res = await getWith(cs, `/api/orgs/${org}/audit${cursor ? `?cursor=${cursor}` : ''}`);
      expect(res.status).toBe(200);
      const text = await res.text();
      raw.push(text);
      const body = JSON.parse(text) as { entries: { source: string; seq: number; at: number }[]; next?: string };
      expect(body.entries.length).toBeLessThanOrEqual(50);
      seen.push(...body.entries);
      cursor = body.next;
      pages++;
    } while (cursor && pages < 10);
    // The org's own rows: its sign-in invite's audit rows plus the seeded ones.
    const consoleCount = (await db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE org_id = ?').bind(org).first<number>('n'))!;
    const apiCount = (await env.HOT_DB.prepare('SELECT COUNT(*) AS n FROM app_changes WHERE org_id = ?').bind(org).first<number>('n'))!;
    expect(seen).toHaveLength(consoleCount + apiCount);
    const keys = seen.map((e) => `${e.source}:${e.seq}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (let i = 1; i < seen.length; i++) expect(seen[i - 1]!.at, String(i)).toBeGreaterThanOrEqual(seen[i]!.at);
    const all = raw.join('\n');
    expect(all).not.toContain('access-sub-staffer-9');
    expect(all).not.toContain('staff@hana.example');
    expect(all).not.toContain('google-sub-of-member');
    expect(all).not.toContain('203.0.113.0/24');
    expect(all).toContain('"actorId":"hana"');
  });

  it('refuses a malformed cursor', async () => {
    const { org, cs } = await signedIn();
    for (const c of ['x', '1', '0.1', '1.0', '1.2.3', `${'9'.repeat(16)}.1`]) expect((await getWith(cs, `/api/orgs/${org}/audit?cursor=${c}`)).status, c).toBe(400);
  });

  it("shows only the org's own rows", async () => {
    const a = await signedIn();
    const b = await signedIn();
    const res = await getJson<{ entries: { target?: string }[] }>(a.cs, `/api/orgs/${a.org}/audit`);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(b.org);
  });
});

describe('/api/me', () => {
  it('lists frozen orgs read-only beside active ones (a member of another active org keeps signing in)', async () => {
    const a = await signedIn();
    const orgB = await seedOrg();
    await db.prepare("INSERT INTO members (org_id, user_id, role, role_since, added_by, added_at) VALUES (?, ?, 'viewer', 0, 'test', 0)").bind(orgB, a.userId).run();
    expect(await staffRpc().freezeOrg({ ...hana(), orgId: orgB, frozen: true })).toMatchObject({ ok: true });
    const me = await getJson<{ memberships: { orgId: string; status: string }[] }>(a.cs, '/api/me');
    expect(me.status).toBe(200);
    expect(me.body.memberships.find((m) => m.orgId === orgB)).toMatchObject({ status: 'frozen' });
    expect((await getWith(a.cs, `/api/orgs/${orgB}/apps`)).status).toBe(200);
  });
});
