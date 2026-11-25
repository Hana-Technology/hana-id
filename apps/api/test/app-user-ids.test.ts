// Per-app User IDs (D919; docs/partner-platform-spec.md piece P6, B2 to B4, B7). An app's `user_ids`, written once from
// its scope's mark, decides the User ID (the identity token's `sub`) and the Support ID its users get: the scope's for
// a 'scope' app (every app of before, every app on an unmarked scope), the app's own for an 'app' app. Checked through
// the real endpoints: the mint, `/v1/login` and `/v1/sessions` (whose `supportId` is what `hana.supportId` shows),
// `/v1/wallets/record`; the directory's `end_user_apps` rows after a login; createApp's mode; what stays per scope
// (email consents, name shares, Passport Home's Support ID); fail closed on an unknown mode. And the line not to cross:
// the derivation's inputs (what the login relays to the chain) are byte-identical for one person on every app, whatever
// its mode, before and after its scope is marked.
import { formatSupportId, supportCodeOf } from '@hana-id/console-core';
import { appSub, identitySub, identitySubBytes } from '@hana-id/core/identity';
import { supportIdFromSub } from '@hana-id/core/support-id';
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetCachedApps } from '../src/app-cache.ts';
import { appUserIds, scopeSupportId, sessionSupportId, upsertUserApp, userAppIds } from '../src/directory/store.ts';
import { syncAfterLogin } from '../src/directory/sync.ts';
import { AdminRpc } from '../src/rpc/admin.ts';
import { identitySubKey } from '../src/identity/signer.ts';
import { deriveWalletAddresses, withChainKey } from '@hana-id/core/derivation';
import { signWalletRecord, walletRecordSessionMessage, walletRecordStatement } from '@hana-id/core/wallet-record';
import { type SeededApp, appHeaders, call, chain, seedApp, sessionBody, sessionKeyPair, uid } from './helpers.ts';
import { mint, verifyToken } from './identity-helpers.ts';
import { hanaHeaders, loginBody, withCombinedCall } from './login-helpers.ts';
import { adminRpc, hana, newOrg, orgApp, rid } from './rpc-helpers.ts';
import { createShare, pathFor, spentSession, vaultHeaders } from './vault-helpers.ts';

afterEach(() => {
  vi.restoreAllMocks();
  forgetCachedApps();
});

const G_SUB = '1234567890';
const ROOT = { provider: 'google', sub: G_SUB };
const KEY = identitySubKey(env) as Uint8Array;
const body = async (res: Response): Promise<Record<string, unknown>> => (await res.json()) as Record<string, unknown>;
const newAud = (): string => `${uid()}.apps.googleusercontent.com`;
const scopeSub = (scope: string, root = ROOT): string => identitySub(KEY, scope, root);
const ownSub = (scope: string, appId: string, root = ROOT): string => appSub(KEY, scope, appId, identitySubBytes(KEY, scope, root));
const modeOf = async (appId: string) => (await env.DB.prepare('SELECT user_ids FROM apps WHERE id = ?1').bind(appId).first<{ user_ids: string }>())!.user_ids;
const markScope = (scope: string) => env.DB.prepare('UPDATE scopes SET app_user_ids = 1 WHERE scope_id = ?1').bind(scope).run();
const userApps = (scope: string) =>
  env.DB.prepare('SELECT e.app_id, e.app_sub, e.support_code, e.first_seen_at, e.last_seen_at FROM end_user_apps e JOIN end_users u ON u.user_id = e.user_id WHERE u.scope_id = ?1 ORDER BY e.app_id')
    .bind(scope)
    .all<{ app_id: string; app_sub: string; support_code: string; first_seen_at: number; last_seen_at: number }>()
    .then((r) => r.results);

/**
 * A scope with an app of before (created unmarked), then marked as shared, then two new apps on it; and an app on a
 * scope of its own that stays unmarked. One mock chain for all of them, whose Google client is the marked scope's.
 */
async function sharedSetup() {
  const before = await seedApp();
  await markScope(before.scope);
  const own1 = await seedApp({ scope: before.scope });
  const own2 = await seedApp({ scope: before.scope });
  const plain = await seedApp();
  const aud = newAud();
  const plainAud = newAud();
  const near = withCombinedCall(chain({ [aud]: before.scope, [plainAud]: plain.scope }));
  return { before, own1, own2, plain, aud, plainAud, near };
}

/** A POST /v1/wallets/record as the vault sends it after a login on `app` (as wallet-directory.test.ts builds it). */
async function recordFor(app: SeededApp, near: ReturnType<typeof chain>): Promise<Response> {
  const spk = spentSession(near, app.scope, { sub: G_SUB });
  const prk = crypto.getRandomValues(new Uint8Array(32));
  const addresses = deriveWalletAddresses(prk);
  const issuedAtMs = Date.now();
  const path = pathFor(app.scope, G_SUB);
  const ctx = { env: env.ENV_NAME, signer: env.SIGNER_ACCOUNT, appId: app.id, scopeId: app.scope, path, sessionPublicKey: Uint8Array.from(spk), issuedAtMs };
  const wallets = Object.fromEntries(
    (['stellar', 'evm'] as const).map((c) => [c, { address: addresses[c], signature: [...withChainKey(prk, c, 0, (k) => signWalletRecord(c, k, walletRecordStatement(ctx, c, addresses[c])))] }]),
  ) as Record<'stellar' | 'evm', { address: string; signature: number[] }>;
  const proofs = { stellar: { address: wallets.stellar.address, signature: Uint8Array.from(wallets.stellar.signature) }, evm: { address: wallets.evm.address, signature: Uint8Array.from(wallets.evm.signature) } };
  const sessionSignature = [...sessionKeyPair(spk).sign(walletRecordSessionMessage(ctx, proofs)).signature];
  return call('/v1/wallets/record', { headers: vaultHeaders(app), body: { sessionPublicKey: spk, issuedAtMs, path, wallets, sessionSignature } });
}

const subOf = async (app: SeededApp, spk: number[]) => (await verifyToken((await body(await mint(app, spk))).identityToken as string)).claims.sub as string;

describe("the app's mode, from its scope's mark at creation", () => {
  it("'scope' for an app of before and on an unmarked scope, 'app' for an app created on a marked scope", async () => {
    const s = await sharedSetup();
    expect([await modeOf(s.before.id), await modeOf(s.own1.id), await modeOf(s.own2.id), await modeOf(s.plain.id)]).toEqual(['scope', 'app', 'app', 'scope']);
  });

  it("AdminRpc.createApp writes it with INSERT … SELECT of the mark: 'app' on a marked scope, 'scope' otherwise; getApp shows it", async () => {
    const org = newOrg();
    const first = await orgApp({ org });
    const near = chain();
    near.views.get_scope = (a) => ({ id: a.scope_id, owners: [{ Near: { account_id: 'owner.test.near' } }], clients: [], pending: [], action_nonce: 0, allow_shared: false });
    const create = (scopeId: string) => adminRpc().createApp({ ...hana(), orgId: org, scopeId, environment: 'test', name: `App ${uid()}`, origins: [], orgOwnerSubs: [] });
    const unmarked = (await create(first.scope)) as { ok: boolean; app?: { id: string; userIds?: string } };
    expect(unmarked, JSON.stringify(unmarked)).toMatchObject({ ok: true, app: { userIds: 'scope' } });
    await markScope(first.scope);
    const marked = (await create(first.scope)) as { ok: boolean; app?: { id: string; userIds?: string } };
    expect(marked, JSON.stringify(marked)).toMatchObject({ ok: true, app: { userIds: 'app' } });
    expect(await modeOf(marked.app!.id)).toBe('app');
    expect(await modeOf(first.id)).toBe('scope');
    const view = (await adminRpc().getApp({ ...hana(), orgId: org, appId: first.id })) as { ok: boolean; app: { userIds?: string } };
    expect(view.app.userIds).toBe('scope');
    // The ledger's app.created row records the mode each create gave (PR 148's review).
    const detail = async (appId: string) => JSON.parse((await env.DB.prepare("SELECT detail_json FROM app_changes WHERE app_id = ?1 AND kind = 'app.created'").bind(appId).first<{ detail_json: string }>())!.detail_json) as { userIds?: string };
    expect((await detail(unmarked.app!.id)).userIds).toBe('scope');
    expect((await detail(marked.app!.id)).userIds).toBe('app');
  });
});

describe("createApp's commit holds the mark it read (PR 148's review)", () => {
  it('a scope marked between the plan read and the batch creates nothing: version_conflict, no app, no ledger row', async () => {
    const org = newOrg();
    const first = await orgApp({ org });
    const near = chain();
    near.views.get_scope = (a) => ({ id: a.scope_id, owners: [{ Near: { account_id: 'owner.test.near' } }], clients: [], pending: [], action_nonce: 0, allow_shared: false });
    const racing: D1Database = new Proxy(env.DB, {
      get(t, p) {
        if (p === 'batch')
          return async (stmts: D1PreparedStatement[]) => {
            await t.prepare('UPDATE scopes SET app_user_ids = 1 WHERE scope_id = ?1').bind(first.scope).run();
            return t.batch(stmts);
          };
        const v: unknown = Reflect.get(t, p);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    const rpc = new AdminRpc(createExecutionContext(), { ...env, DB: racing });
    const count = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM apps WHERE scope_id = ?1').bind(first.scope).first<{ n: number }>())!.n;
    const before = await count();
    expect(await rpc.createApp({ ...hana(), orgId: org, scopeId: first.scope, environment: 'test', name: `Raced ${uid()}`, origins: [], orgOwnerSubs: [] })).toMatchObject({ ok: false, code: 'version_conflict' });
    expect(await count()).toBe(before);
  });
});

describe('the identity token’s sub and the Support ID', () => {
  it("an app on an unmarked scope, and an app of before on a marked one, give today's sub; each new app its own", async () => {
    const s = await sharedSetup();
    const subs: Record<string, string> = {};
    for (const [name, app] of Object.entries({ before: s.before, own1: s.own1, own2: s.own2, plain: s.plain })) subs[name] = await subOf(app, (await createShare(app, s.near, { sub: G_SUB })).spk);
    expect(subs.plain).toBe(scopeSub(s.plain.scope));
    expect(subs.before).toBe(scopeSub(s.before.scope));
    expect(subs.own1).toBe(ownSub(s.before.scope, s.own1.id));
    expect(subs.own2).toBe(ownSub(s.before.scope, s.own2.id));
    // Two apps of one marked scope: different IDs for one person, neither the scope's.
    expect(new Set([subs.before, subs.own1, subs.own2]).size).toBe(3);
    for (const v of Object.values(subs)) expect(v).toMatch(/^u1_[A-Za-z0-9_-]{21}[AQgw]$/u);
  });

  it("/v1/login's Support ID (hana.supportId) is supportIdFromSub of the same app's token sub, for each mode", async () => {
    const s = await sharedSetup();
    for (const [app, aud] of [[s.before, s.aud], [s.own1, s.aud], [s.own2, s.aud], [s.plain, s.plainAud]] as const) {
      const res = await call('/v1/login', { headers: hanaHeaders(app), body: await loginBody(app.scope, aud) });
      expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
      const supportId = (await body(res)).supportId as string;
      const sub = await subOf(app, (await createShare(app, s.near, { sub: G_SUB })).spk);
      expect(supportId, app.id).toBe(supportIdFromSub(sub));
    }
  });

  it("/v1/sessions' Support ID follows the app's mode too", async () => {
    const s = await sharedSetup();
    const supportIdOf = async (app: SeededApp, aud: string) => {
      const res = await call('/v1/sessions', { headers: appHeaders(app), body: await sessionBody(app.scope, aud) });
      expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
      return (await body(res)).supportId as string;
    };
    expect(await supportIdOf(s.before, s.aud)).toBe(supportIdFromSub(scopeSub(s.before.scope)));
    expect(await supportIdOf(s.own1, s.aud)).toBe(supportIdFromSub(ownSub(s.before.scope, s.own1.id)));
    expect(await supportIdOf(s.plain, s.plainAud)).toBe(supportIdFromSub(scopeSub(s.plain.scope)));
  });

  it('what stays per scope: Passport Home’s Support ID, and the email consents’ and name shares’ key at mint', async () => {
    const s = await sharedSetup();
    expect(await scopeSupportId(env, s.before.scope, ROOT)).toBe(formatSupportId(supportCodeOf(scopeSub(s.before.scope))));
    expect(await sessionSupportId(env, { id: s.own1.id, scope_id: s.own1.scope, user_ids: 'app' }, ROOT)).not.toBe(await scopeSupportId(env, s.before.scope, ROOT));
    // The mint reads the email consent and the name share by the scope-level User ID (B3), never the app's own.
    const reads: unknown[][] = [];
    const prepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, 'prepare').mockImplementation((sql: string) => {
      const stmt = prepare(sql);
      if (!/FROM (email_consents|name_shares)/u.test(sql)) return stmt;
      const bind = stmt.bind.bind(stmt);
      return Object.assign(stmt, { bind: (...v: unknown[]) => (reads.push(v), bind(...v)) });
    });
    await subOf(s.own1, (await createShare(s.own1, s.near, { sub: G_SUB })).spk);
    const flat = reads.flat();
    expect(flat).toContain(scopeSub(s.before.scope));
    expect(flat).not.toContain(ownSub(s.before.scope, s.own1.id));
  });

  it('fails closed on a mode that is neither: no Support ID, no IDs, no row', async () => {
    const s = await sharedSetup();
    for (const bad of ['pairwise', 'APP', '', 'scope ']) {
      expect(appUserIds(KEY, { id: s.own1.id, scope_id: s.own1.scope, user_ids: bad }, ROOT), bad).toBeNull();
      expect(await sessionSupportId(env, { id: s.own1.id, scope_id: s.own1.scope, user_ids: bad }, ROOT), bad).toBeUndefined();
    }
    // Without the sub key: no IDs to write and no Support ID.
    expect(userAppIds({ IDENTITY_SUB_KEY: undefined }, { id: s.own1.id, scope_id: s.own1.scope }, ROOT)).toBeNull();
    expect(await sessionSupportId({ ...env, IDENTITY_SUB_KEY: undefined }, { id: s.own1.id, scope_id: s.own1.scope, user_ids: 'app' }, ROOT)).toBeUndefined();
  });
});

describe('end_user_apps: which apps of a shared scope a person signed in on', () => {
  it('after /v1/login: one row per app of the marked scope with that app’s IDs; none on an unmarked scope; times only move forward', async () => {
    const s = await sharedSetup();
    for (const app of [s.before, s.own1]) expect((await call('/v1/login', { headers: hanaHeaders(app), body: await loginBody(app.scope, s.aud) })).status).toBe(200);
    expect((await call('/v1/login', { headers: hanaHeaders(s.plain), body: await loginBody(s.plain.scope, s.plainAud) })).status).toBe(200);
    const rows = await userApps(s.before.scope);
    const want = [
      { app_id: s.before.id, app_sub: scopeSub(s.before.scope), support_code: supportCodeOf(scopeSub(s.before.scope)) },
      { app_id: s.own1.id, app_sub: ownSub(s.before.scope, s.own1.id), support_code: supportCodeOf(ownSub(s.before.scope, s.own1.id)) },
    ].sort((a, b) => (a.app_id < b.app_id ? -1 : 1));
    expect(rows.map(({ app_id, app_sub, support_code }) => ({ app_id, app_sub, support_code }))).toEqual(want);
    expect(await userApps(s.plain.scope)).toEqual([]);
    // A later login moves last_seen_at, never first_seen_at.
    const first = rows.find((r) => r.app_id === s.own1.id)!;
    await new Promise((r) => setTimeout(r, 5));
    expect((await call('/v1/login', { headers: hanaHeaders(s.own1), body: await loginBody(s.own1.scope, s.aud) })).status).toBe(200);
    const later = (await userApps(s.before.scope)).find((r) => r.app_id === s.own1.id)!;
    expect(later.first_seen_at).toBe(first.first_seen_at);
    expect(later.last_seen_at).toBeGreaterThan(first.last_seen_at);
  });

  it('after /v1/wallets/record too (the vault’s report after a login): the same row', async () => {
    const s = await sharedSetup();
    const res = await recordFor(s.own2, s.near);
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect((await userApps(s.before.scope)).map((r) => [r.app_id, r.app_sub])).toEqual([[s.own2.id, ownSub(s.before.scope, s.own2.id)]]);
  });

  it('never for a login with no app (Passport Home), nor for an app whose scope isn’t marked, whatever the caller passes', async () => {
    const s = await sharedSetup();
    const standing = { pending: false, path: pathFor(s.before.scope), confirmed: true };
    expect(await syncAfterLogin(env, s.before.scope, ROOT, null, standing, { requestId: rid(), endpoint: 'home' })).toBe(true);
    expect(await userApps(s.before.scope)).toEqual([]);
    // An unmarked scope's app: the statement itself finds no mark and writes nothing (a stale cached app can't either).
    const plainIds = userAppIds(env, { id: s.plain.id, scope_id: s.plain.scope }, ROOT)!;
    expect(await syncAfterLogin(env, s.plain.scope, ROOT, null, { ...standing, path: pathFor(s.plain.scope) }, { requestId: rid(), endpoint: 'test', appId: s.plain.id })).toBe(true);
    expect(await userApps(s.plain.scope)).toEqual([]);
    // Another scope's app named for this scope's user: nothing either.
    const r = await upsertUserApp(env.DB, 'hu_xxxxxxxxxxxxxxxxxxxxxxxxxx', { id: s.own1.id, scope_id: s.plain.scope }, plainIds, Date.now()).run();
    expect(r.meta.changes).toBe(0);
  });

  it("rewrites the app's IDs with every write, so a re-key of IDENTITY_SUB_KEY never leaves stale ones (PR 148's review)", async () => {
    const s = await sharedSetup();
    const standing = { pending: false, path: pathFor(s.before.scope), confirmed: true };
    const at = { requestId: rid(), endpoint: 'test', appId: s.own1.id };
    expect(await syncAfterLogin(env, s.before.scope, ROOT, null, standing, at)).toBe(true);
    const [first] = await userApps(s.before.scope);
    expect(first!.app_sub).toBe(ownSub(s.before.scope, s.own1.id));
    const otherKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));
    expect(await syncAfterLogin({ ...env, IDENTITY_SUB_KEY: otherKey }, s.before.scope, ROOT, null, standing, at)).toBe(true);
    const [second] = await userApps(s.before.scope);
    const k2 = new Uint8Array(32).fill(5);
    const want = appSub(k2, s.before.scope, s.own1.id, identitySubBytes(k2, s.before.scope, ROOT));
    expect(second!.app_sub).toBe(want);
    expect(second!.support_code).toBe(supportCodeOf(want));
    expect(second!.first_seen_at).toBe(first!.first_seen_at);
  });

  it('the per-login write reads few D1 rows, on a marked scope and an unmarked one, however many apps and rows exist (pinned)', async () => {
    const s = await sharedSetup();
    // Noise: more apps on the marked scope and more people with rows.
    for (let i = 0; i < 5; i++) await seedApp({ scope: s.before.scope });
    for (const app of [s.before, s.own1, s.own2]) expect((await call('/v1/login', { headers: hanaHeaders(app), body: await loginBody(app.scope, s.aud) })).status).toBe(200);
    const internal = (await env.DB.prepare('SELECT user_id FROM end_users WHERE scope_id = ?1').bind(s.before.scope).first<{ user_id: string }>())!.user_id;
    const rowsRead = async (app: SeededApp) => {
      const ids = userAppIds(env, { id: app.id, scope_id: app.scope }, ROOT)!;
      return (await upsertUserApp(env.DB, internal, { id: app.id, scope_id: app.scope }, ids, Date.now()).run()).meta.rows_read;
    };
    // The app's row and its scope's (the join), the insert trigger's reads, the foreign keys' and the conflict's row:
    // 7 rows, the same on a repeat (pinned, so a change that adds a read is seen).
    expect([await rowsRead(s.own1), await rowsRead(s.own1)]).toEqual([7, 7]);
    // An unmarked scope's app (every login on every other app): the app's row and its scope's, nothing written: 3.
    expect([await rowsRead(s.plain), await rowsRead(s.plain)]).toEqual([3, 3]);
  });

  it('holds no Google sub, email, address or internal id: only the app, its two IDs and two times', async () => {
    const s = await sharedSetup();
    expect((await call('/v1/login', { headers: hanaHeaders(s.own1), body: await loginBody(s.own1.scope, s.aud) })).status).toBe(200);
    const cols = (await env.DB.prepare("SELECT name FROM pragma_table_info('end_user_apps') ORDER BY cid").all<{ name: string }>()).results.map((c) => c.name);
    expect(cols).toEqual(['user_id', 'app_id', 'app_sub', 'support_code', 'first_seen_at', 'last_seen_at']);
    const [row] = await userApps(s.before.scope);
    expect(JSON.stringify(row)).not.toContain(G_SUB);
  });
});

describe('address impact: none', () => {
  /** What reaches the chain for a login, without the request's own fresh values (token, session key, salt, signatures, CKD key, time). */
  const derivationInputs = (args: Record<string, unknown>) => {
    const { jwt: _j, session_public_key: _k, salt: _s, signature: _g, pk1: _p1, pk2: _p2, expires_at_ms: _e, ...rest } = args;
    return rest;
  };
  const googleSubOf = (jwt: unknown) => JSON.parse(atob(String(jwt).split('.')[1]!.replace(/-/gu, '+').replace(/_/gu, '/'))).sub as string;

  it('one person’s login relays the same derivation inputs on the app of before (before and after the mark) and on each new app', async () => {
    const before = await seedApp();
    const aud = newAud();
    const near = withCombinedCall(chain({ [aud]: before.scope }));
    const sent = async (app: SeededApp) => {
      const n = near.sent.length;
      expect((await call('/v1/login', { headers: hanaHeaders(app), body: await loginBody(app.scope, aud) })).status).toBe(200);
      const tx = near.sent[n]!;
      expect(tx.method).toBe('create_session_and_derive');
      const args = tx.args as Record<string, unknown>;
      // Nothing of the app, its mode or any User ID is in what the contract and the MPC derive from.
      const text = JSON.stringify(args);
      expect(text).not.toContain(app.id);
      expect(text).not.toMatch(/u1_|user_ids|"app"|"scope"/u);
      return { inputs: derivationInputs(args), googleSub: googleSubOf(args.jwt) };
    };
    const unmarked = await sent(before);
    await markScope(before.scope);
    forgetCachedApps();
    const own = await seedApp({ scope: before.scope });
    expect(await modeOf(own.id)).toBe('app');
    const after = await sent(before);
    const ownLogin = await sent(own);
    expect(after).toEqual(unmarked);
    expect(ownLogin).toEqual(unmarked);
    expect(unmarked).toEqual({ inputs: { scope_id: before.scope, key_index: 0, max_uses: 1 }, googleSub: G_SUB });
  });
});
