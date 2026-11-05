// The Support ID (batch C15; D96, D144, D276 as amended by D346, D394, D395): the `supportId` the session answers
// carry (/v1/login, /v1/sessions), always the code the wallet directory stores for the same user, and the staff lookup's
// hot-DB part, AdminRpc.supportLookup / userShares. Partners get neither the lookup nor anything beyond the code.
import { SUPPORT_MATCHES_MAX, formatSupportId, internalIdOf, supportCodeOf, supportIdOf, uid as uidOf } from '@hana-id/console-core';
import { identitySub } from '@hana-id/core/identity';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminRpc } from '../src/rpc/admin.ts';
import { ConsoleRpc } from '../src/rpc/console.ts';
import { withEmail } from './email-helpers.ts';
import { appHeaders, call, chain, seedApp, sessionBody, uid } from './helpers.ts';
import { hanaHeaders, loginBody, withCombinedCall } from './login-helpers.ts';
import { adminRpc, hana, member, newOrg, orgApp, rid, system } from './rpc-helpers.ts';
import { HOUR, createShare, setShare } from './vault-helpers.ts';

afterEach(() => vi.restoreAllMocks());

const G_SUB = '1234567890';
const json = async (res: Response): Promise<Record<string, unknown>> => (await res.json()) as Record<string, unknown>;
const b64Key = (v: string | undefined): Uint8Array => Uint8Array.from(atob(v!), (c) => c.charCodeAt(0));
const userIdOf = (scope: string, provider: string, sub: string): string => identitySub(b64Key(env.IDENTITY_SUB_KEY), scope, { provider, sub });
const internalIdFor = async (scope: string, provider: string, sub: string): Promise<string> => internalIdOf(await uidOf(b64Key(env.USER_ID_KEY), { scopeId: scope, provider, sub }));
const storedCode = async (scope: string): Promise<string[]> =>
  (await env.DB.prepare('SELECT support_code FROM end_users WHERE scope_id = ?1').bind(scope).all<{ support_code: string }>()).results.map((r) => formatSupportId(r.support_code));

async function loginSetup() {
  const app = await seedApp();
  const aud = `${uid()}.apps.googleusercontent.com`;
  const near = withEmail(withCombinedCall(chain({ [aud]: app.scope })), [app.scope]);
  return { app, aud, near };
}

describe('supportId in the session answers', () => {
  it('/v1/login carries the Support ID the directory stores for the user, which is the identity token sub’s short form', async () => {
    const { app, aud } = await loginSetup();
    const res = await call('/v1/login', { headers: hanaHeaders(app), body: await loginBody(app.scope, aud) });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    const b = await json(res);
    const userId = userIdOf(app.scope, 'google', G_SUB);
    expect(b.supportId).toBe(supportIdOf(userId));
    expect(b.supportId).toMatch(/^HANA-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/u);
    // The login's background sync wrote the user: the stored code is the one the user was handed.
    expect(await storedCode(app.scope)).toEqual([b.supportId]);
    // Only the code: never the sub, the User ID or the internal id.
    const text = JSON.stringify(b);
    for (const secret of [G_SUB, userId, await internalIdFor(app.scope, 'google', G_SUB)]) expect(text).not.toContain(secret);
  });

  it('a linked member’s login carries its account root’s Support ID', async () => {
    const { app, aud, near } = await loginSetup();
    near.identities.set(`google#${G_SUB}`, { status: 'member', opened: false, root: { provider: 'email', sub: 'e1.root' } });
    near.accounts.set('email#e1.root', { root: { provider: 'email', sub: 'e1.root' }, members: [{ provider: 'google', sub: G_SUB, active: true }], epoch: 1 });
    const res = await call('/v1/login', { headers: hanaHeaders(app), body: await loginBody(app.scope, aud) });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    const b = await json(res);
    expect(b.supportId).toBe(supportIdOf(userIdOf(app.scope, 'email', 'e1.root')));
    expect(await storedCode(app.scope)).toEqual([b.supportId]);
  });

  it('is left out when the env can’t write the directory (either key missing or malformed); the login still succeeds', async () => {
    for (const missing of [{ IDENTITY_SUB_KEY: undefined }, { IDENTITY_SUB_KEY: 'not-a-key' }, { USER_ID_KEY: undefined }]) {
      const { app, aud } = await loginSetup();
      const res = await call('/v1/login', { headers: hanaHeaders(app), body: await loginBody(app.scope, aud), env: missing });
      expect(res.status, JSON.stringify(missing)).toBe(200);
      expect(await json(res), JSON.stringify(missing)).not.toHaveProperty('supportId');
    }
  });

  it('is left out when the login’s standing is only the fail-open guess (a member’s root unknown)', async () => {
    const { app, aud, near } = await loginSetup();
    near.views.get_identity = () => {
      throw new Error('RPC down');
    };
    const res = await call('/v1/login', { headers: hanaHeaders(app), body: await loginBody(app.scope, aud) });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(await json(res)).not.toHaveProperty('supportId');
  });

  it('/v1/sessions carries the Support ID of the new session’s path root, beside result and nearTx', async () => {
    const app = await seedApp();
    const aud = `${uid()}.apps.googleusercontent.com`;
    chain({ [aud]: app.scope });
    const res = await call('/v1/sessions', { headers: appHeaders(app), body: await sessionBody(app.scope, aud, { keyIndex: 3 }) });
    expect(res.status).toBe(200);
    const b = await json(res);
    expect(Object.keys(b).sort()).toEqual(['nearTx', 'requestId', 'result', 'supportId']);
    // Every key index of the account shows the same code (it is per scope and account root).
    expect(b.supportId).toBe(supportIdOf(userIdOf(app.scope, 'google', G_SUB)));
    expect(JSON.stringify(b)).not.toContain(userIdOf(app.scope, 'google', G_SUB));
    const without = await call('/v1/sessions', { headers: appHeaders(app), body: await sessionBody(app.scope, aud), env: { IDENTITY_SUB_KEY: undefined } });
    expect(without.status).toBe(200);
    expect(await json(without)).not.toHaveProperty('supportId');
  });
});

// ---- the staff lookup ----

const staff = () => hana();

/** A directory user written as the API writes it (the three ids from the keys), its root identity and one wallet. */
async function directoryUser(scope: string, sub: string, o: { keyIndex?: number; lastSeen?: number } = {}) {
  const internalId = await internalIdFor(scope, 'google', sub);
  const userId = userIdOf(scope, 'google', sub);
  const at = o.lastSeen ?? Date.now();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO end_users (user_id, token_sub, support_code, scope_id, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)').bind(internalId, userId, supportCodeOf(userId), scope, at),
    env.DB.prepare("INSERT INTO end_user_identities (scope_id, identity_key, user_id, provider, sub, role, status, effective_at, first_seen_at, observed_at) VALUES (?1, ?2, ?3, 'google', ?4, 'root', 'active', NULL, ?5, ?5)").bind(
      scope,
      uid().padEnd(64, '0').slice(0, 64),
      internalId,
      sub,
      at,
    ),
    env.DB.prepare("INSERT INTO end_user_wallets (user_id, chain, address, key_index, first_seen_at, last_used_at) VALUES (?1, 'evm', ?2, ?3, ?4, ?4)").bind(internalId, `0x${uid().padEnd(40, '0').slice(0, 40)}`, o.keyIndex ?? 0, at),
  ]);
  return { internalId, userId, supportId: supportIdOf(userId) };
}

async function change(app: { id: string; scope: string; org: string }, kind: string, at: number): Promise<string> {
  const requestId = rid();
  await env.DB.prepare("INSERT INTO app_changes (at, org_id, app_id, scope_id, kind, detail_json, actor_kind, actor_id, request_id) VALUES (?1, ?2, ?3, ?4, ?5, '{}', 'hana', 'staff-1', ?6)")
    .bind(at, app.org, app.id, app.scope, kind, requestId)
    .run();
  return requestId;
}

type Lookup = { ok: true; query: Record<string, string>; since: number; truncated: boolean; matches: { user: { userId: string; internalId: string; supportId: string }; apps: Record<string, unknown>[]; shares: Record<string, unknown>[]; changes: { requestId: string; kind: string }[] }[] };
const lookup = async (input: Record<string, unknown>): Promise<Lookup> => (await adminRpc().supportLookup({ ...staff(), ...input })) as unknown as Lookup;

describe('AdminRpc.supportLookup', () => {
  it('resolves a Support ID typed any way, a User ID and an internal id to the same user', async () => {
    const app = await orgApp();
    const u = await directoryUser(app.scope, `sub-${uid()}`);
    const code = u.supportId.slice(5).replace('-', '');
    for (const query of [u.supportId, u.supportId.toLowerCase(), code, code.toLowerCase(), `hana ${code}`, u.userId, u.internalId, u.internalId.toUpperCase().replace('HU_', 'hu_')]) {
      const r = await lookup({ query });
      expect(r.ok, query).toBe(true);
      expect(r.matches.map((m) => m.user.userId), query).toEqual([u.userId]);
    }
    const r = await lookup({ query: u.supportId });
    expect(r.query).toEqual({ kind: 'supportId', code: supportCodeOf(u.userId) });
    expect(r.truncated).toBe(false);
    expect(r.matches[0]!.user).toMatchObject({ supportId: u.supportId, internalId: u.internalId, scopeId: app.scope, orgId: app.org });
    expect(r.matches[0]!.apps).toEqual([{ appId: app.id, name: expect.any(String), orgId: app.org, environment: 'test', persistence: 'session', deletedAt: null }]);
  });

  it('lists every user sharing a code (40-bit collisions), newest first, at most SUPPORT_MATCHES_MAX with `truncated`', async () => {
    const app = await orgApp();
    const code = 'Z'.repeat(8);
    const ids: string[] = [];
    for (let i = 0; i <= SUPPORT_MATCHES_MAX; i++) {
      const internalId = `hu_${uid().toLowerCase().replace(/[^0-9a-hjkmnp-tv-z]/gu, '0').padEnd(26, '0').slice(0, 26)}`;
      const userId = `u1_${uid().replace(/[^A-Za-z0-9]/gu, 'A').padEnd(21, 'A').slice(0, 21)}A`;
      await env.DB.prepare('INSERT INTO end_users (user_id, token_sub, support_code, scope_id, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, 1, ?5)').bind(internalId, userId, code, app.scope, 1000 + i).run();
      ids.push(userId);
    }
    const r = await lookup({ query: 'HANA-ZZZZ-ZZZZ' });
    expect(r.truncated).toBe(true);
    expect(r.matches.map((m) => m.user.userId)).toEqual(ids.reverse().slice(0, SUPPORT_MATCHES_MAX));
    const two = await orgApp();
    const c2 = 'Y'.repeat(8);
    for (const n of [1, 2]) {
      await env.DB.prepare('INSERT INTO end_users (user_id, token_sub, support_code, scope_id, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, 1, ?5)').bind(`hu_${String(n).repeat(26)}`, `u1_${String(n).repeat(21)}A`, c2, two.scope, n).run();
    }
    const both = await lookup({ query: 'HANA-YYYY-YYYY' });
    expect([both.truncated, both.matches.length]).toEqual([false, 2]);
  });

  it('shows the user’s shares that haven’t expired (live or not), at each key index its wallets show, never another user’s', async () => {
    const app = await orgApp();
    const near = chain();
    const sub = `sub-${uid()}`;
    const u = await directoryUser(app.scope, sub);
    const live = await createShare(app, near, { sub });
    const revoked = await createShare(app, near, { sub });
    const expired = await createShare(app, near, { sub });
    await createShare(app, near, { sub: `other-${uid()}` });
    await setShare(revoked.shareId, { revoked_at: Date.now() - 1000 });
    await setShare(expired.shareId, { abs_expires_at: Date.now() - 1000, idle_until: Date.now() - 1000 });
    const r = await lookup({ query: u.userId });
    const shares = r.matches[0]!.shares;
    expect(shares).toHaveLength(2);
    expect(shares.map((s) => s.live).sort()).toEqual([false, true]);
    for (const s of shares) {
      expect(Object.keys(s).sort()).toEqual(['absExpiresAt', 'appId', 'createdAt', 'idleUntil', 'keyIndex', 'live', 'revokedAt']);
      expect(s).toMatchObject({ appId: app.id, keyIndex: 0 });
    }
    expect(shares.find((s) => s.live)!.absExpiresAt).toBe(live.absExpiresAtMs);
    // AdminRpc.userShares: the same rows for one path (the spec's planned shape: no app id, key index or flag).
    const one = (await adminRpc().userShares({ ...staff(), appId: app.id, path: `${app.scope}#google#${sub}#0` })) as unknown as { ok: true; shares: Record<string, unknown>[] };
    expect(one.shares).toHaveLength(2);
    expect(Object.keys(one.shares[0]!).sort()).toEqual(['absExpiresAt', 'createdAt', 'idleUntil', 'revokedAt']);
    const none = (await adminRpc().userShares({ ...staff(), appId: app.id, path: `${app.scope}#google#nobody#0` })) as unknown as { shares: unknown[] };
    expect(none.shares).toEqual([]);
  });

  it('lists the scope’s apps’ changes in the window, newest first, and not another scope’s or older ones', async () => {
    const org = newOrg();
    const app = await orgApp({ org });
    const other = await orgApp({ org });
    const u = await directoryUser(app.scope, `sub-${uid()}`);
    const now = Date.now();
    const recent = await change(app, 'origin.added', now - HOUR);
    const newer = await change(app, 'settings.changed', now - 1000);
    const old = await change(app, 'origin.removed', now - 40 * 24 * HOUR);
    const elsewhere = await change(other, 'origin.added', now - HOUR);
    const r = await lookup({ query: u.supportId });
    const ids = r.matches[0]!.changes.map((c) => c.requestId);
    expect(ids.indexOf(newer)).toBeLessThan(ids.indexOf(recent));
    expect(ids).toContain(recent);
    expect(ids).not.toContain(old);
    expect(ids).not.toContain(elsewhere);
    const wide = await lookup({ query: u.supportId, days: 60 });
    expect(wide.matches[0]!.changes.map((c) => c.requestId)).toContain(old);
    expect(wide.since).toBeLessThan(r.since);
  });

  it('answers no matches for a code nobody has, and refuses what isn’t a Support ID, User ID or internal id', async () => {
    expect((await lookup({ query: 'HANA-0000-0001' })).matches).toEqual([]);
    for (const query of ['0x' + 'a'.repeat(40), 'some-google-sub', 'HANA-ABC', 'a@b.example', '']) {
      expect(((await adminRpc().supportLookup({ ...staff(), query })) as unknown as { code: string }).code, query).toBe('bad_request');
    }
    expect(((await adminRpc().supportLookup({ ...staff(), query: 'HANA-0000-0001', days: 0 })) as unknown as { code: string }).code).toBe('bad_request');
    expect(((await adminRpc().supportLookup({ ...staff(), query: 'HANA-0000-0001', days: 732 })) as unknown as { code: string }).code).toBe('bad_request');
  });

  it('is staff only: a system or member actor is forbidden, and ConsoleRpc has no lookup at all', async () => {
    for (const ctx of [system(), member()]) {
      expect(((await adminRpc().supportLookup({ ...ctx, query: 'HANA-0000-0001' })) as unknown as { code: string }).code).toBe('forbidden');
      expect(((await adminRpc().userShares({ ...ctx, appId: 'app_x', path: 's#google#x#0' })) as unknown as { code: string }).code).toBe('forbidden');
    }
    for (const m of ['supportLookup', 'userShares']) {
      expect(m in ConsoleRpc.prototype, m).toBe(false);
      expect(m in AdminRpc.prototype, m).toBe(true);
    }
  });
});
