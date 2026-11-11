// Profile names (D714, migration 0019): the name a user sets in Hana Home (GET/POST /v1/home/profile), sharing it per
// app (POST /v1/home/name-sharing), the identity token's `given_name`/`family_name`, the console's and the admin's
// Users screens, retention, and logs. Only the signed-in identity's own name; a share is per app × account (a linked
// member's through its root, confirmed on chain, D661), and counts only while that link holds; nothing shared by
// default; no name in a log line.
import { HOME_EMAIL_AUDIENCE, encodeHomeIdentity, homeMessage, homeNonce } from '@hana-id/core/home';
import { identitySub } from '@hana-id/core/identity';
import { KeyPair } from '@near-js/crypto';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { base64Decode } from '../src/bytes.ts';
import { HotDb } from '../src/changes/db.ts';
import { purgeDirectory } from '../src/changes/retention.ts';
import { adminProfileNames } from '../src/directory/read.ts';
import { HOME_NAME_SHARES_MAX, HOME_NAME_SHARING_ENDPOINT, HOME_PROFILE_ENDPOINT, HOME_PROFILE_WRITE_PER_KEY_MINUTE } from '../src/home/profile.ts';
import { mintName, storedName } from '../src/identity/name.ts';
import { clearIdentitySignerCache } from '../src/identity/signer.ts';
import { clearViewCaches } from '../src/views.ts';
import { GOOGLE_ISS, ORIGIN, type Chain, type SeededApp, call, chain, google, newKey, seedApp, uid } from './helpers.ts';
import { emailEnv, emailToken, ikSync, withEmail } from './email-helpers.ts';
import { mint, verifyToken } from './identity-helpers.ts';
import { type OrgApp, adminRpc, consoleRpc, hana, member, newOrg, orgApp, system } from './rpc-helpers.ts';
import { createShare } from './vault-helpers.ts';

const AUTH = env.AUTH_ORIGIN!;
const SHARED = 'shared-client.apps.googleusercontent.com';
const DAY = 86_400_000;

let near: Chain;
let counter = 0;
/** The chain's links: `sub` → its root's sub and its status there (the contract's `get_identity`). Absent: its own root. */
let onChain: Map<string, { root: string; status: 'member' | 'pending' }>;
/** `get_identity` fails (an RPC outage). */
let identityDown = false;
beforeEach(() => {
  clearViewCaches();
  near = chain({}, { shared: [SHARED] });
  near.exit = [];
  onChain = new Map();
  identityDown = false;
  near.views.get_identity = (a) => {
    if (identityDown) throw new Error('rpc down');
    const link = onChain.get(a.sub as string);
    return { key: ikSync(a.scope_id as string, a.provider as string, a.sub as string), status: link ? link.status : 'own', opened: !link, root: link ? { provider: 'google', sub: link.root } : null, effective_at_ms: null, account_epoch: 0 };
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  clearIdentitySignerCache();
});

// ---- a Home identity (as home-devices.test.ts) ----

interface Identity {
  sub: string;
  send(method: string, path: string, body?: unknown, init?: { ip?: string; origin?: string | null; raw?: string; env?: Partial<typeof env> }): Promise<Response>;
}

async function home(sub = `${Date.now()}${Math.floor(Math.random() * 1e6)}`, o: { email?: boolean } = {}): Promise<Identity> {
  if (o.email) {
    // H10: an email Home identity counts while the issuer's Home audience is on the chain's exit list.
    withEmail(near, []);
    near.exit = [['email', HOME_EMAIL_AUDIENCE]];
    // The config view (and its exit list) may be cached from an earlier request of the test.
    clearViewCaches();
  }
  const kp = KeyPair.fromRandom('ed25519');
  const pub = Uint8Array.from(kp.getPublicKey().data);
  const expiresAtMs = Date.now() + 15 * 60_000;
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const nonce = homeNonce({ signer: env.SIGNER_ACCOUNT, homePublicKey: pub, expiresAtMs, salt });
  const jwt = o.email ? await emailToken({ aud: HOME_EMAIL_AUDIENCE, sub, nonce }) : await google.sign({ iss: GOOGLE_ISS, aud: SHARED, sub, nonce, exp: Math.floor(Date.now() / 1000) + 3600 });
  return {
    sub,
    async send(method, path, body, init = {}) {
      const text = init.raw ?? (body === undefined ? '' : JSON.stringify(body));
      const bytes = new TextEncoder().encode(text);
      const c = ++counter;
      const sig = kp.sign(homeMessage({ signer: env.SIGNER_ACCOUNT, counter: c, method, path, body: bytes })).signature;
      const headers: Record<string, string> = {
        'x-hana-home': encodeHomeIdentity({ jwt, key: pub, expiresAtMs, salt, counter: c, sig: Uint8Array.from(sig) }),
        'cf-connecting-ip': init.ip ?? `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
        ...(text === '' ? {} : { 'content-type': 'application/json' }),
      };
      const origin = init.origin === undefined ? AUTH : init.origin;
      if (origin !== null) headers.origin = origin;
      return call(path, { method, headers, ...(text === '' ? {} : { rawBody: text }), ...(o.email || init.env ? { env: { ...(o.email ? emailEnv() : {}), ...init.env } } : {}) });
    },
  };
}

type Body = Record<string, unknown>;
type Name = { givenName: string | null; familyName: string | null };
interface ProfileAnswer {
  name: Name | null;
  shares: { appId: string; name: string; scopeId: string; sharedAtMs: number }[];
  more: boolean;
  app: { appId: string; shared: boolean } | null;
}

/** A 200 answer's body without its `requestId` (every answer carries one). */
async function answer(res: Response): Promise<Body> {
  const { requestId, ...body } = (await res.json()) as Body;
  expect(typeof requestId).toBe('string');
  return body;
}

async function expectCode(res: Response, status: number, code: string): Promise<Body> {
  const body = (await res.json()) as Body;
  expect({ status: res.status, code: body.code }).toEqual({ status, code });
  return body;
}

const setName = (id: Identity, givenName: unknown, familyName: unknown) => id.send('POST', HOME_PROFILE_ENDPOINT, { givenName, familyName });
async function named(id: Identity, givenName: string | null, familyName: string | null): Promise<void> {
  const res = await setName(id, givenName, familyName);
  expect(res.status).toBe(200);
}
async function profile(id: Identity, query = ''): Promise<ProfileAnswer> {
  const res = await id.send('GET', `${HOME_PROFILE_ENDPOINT}${query}`);
  expect(res.status).toBe(200);
  return (await answer(res)) as unknown as ProfileAnswer;
}
const sharing = (id: Identity, appId: string, share = true) => id.send('POST', HOME_NAME_SHARING_ENDPOINT, { appId, share });
async function shares(id: Identity, app: { id: string }): Promise<void> {
  const res = await sharing(id, app.id);
  expect({ status: res.status, body: await answer(res) }).toEqual({ status: 200, body: { shared: true } });
}

// ---- the token side and the directory ----

const userSubOf = (scope: string, sub: string, provider = 'google'): string => identitySub(base64Decode(env.IDENTITY_SUB_KEY!), scope, { provider, sub });

/** The claims of an identity token minted by a fresh session of the account rooted at `rootSub`. */
async function claimsFor(app: SeededApp, rootSub: string): Promise<Body> {
  const share = await createShare(app, near, { sub: rootSub });
  const res = await mint(app, share.spk);
  expect(res.status).toBe(200);
  return (await verifyToken(((await res.json()) as { identityToken: string }).identityToken)).claims;
}
const nameClaims = (c: Body) => ({ given_name: c.given_name, family_name: c.family_name });

/** Another app of `app`'s org in `app`'s scope (orgApp makes a fresh scope; seedApp's lands in org_legacy). */
async function sameScopeApp(app: OrgApp): Promise<OrgApp> {
  const id = `app_${uid()}`;
  const key = newKey();
  const now = Date.now();
  await env.DB.prepare("INSERT INTO apps (id, name, scope_id, org_id, publishable_key, status, plan) VALUES (?1, ?2, ?3, ?4, ?5, 'active', 'free')").bind(id, `Test ${id}`, app.scope, app.org, key).run();
  await env.DB.prepare('UPDATE apps SET first_login_at = ?2 WHERE id = ?1').bind(id, now).run();
  await env.DB.prepare("INSERT INTO app_keys (id, app_id, key, created_by, created_at) VALUES (?1, ?2, ?3, 'test', ?4)").bind(`key_${uid()}`, id, key, now).run();
  await env.DB.prepare('INSERT INTO app_origins (app_id, origin, active_from) VALUES (?1, ?2, 0)').bind(id, ORIGIN).run();
  return { id, key, scope: app.scope, org: app.org };
}

const hex64 = (): string => [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
const b36 = (n: number): string => Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');

/**
 * An account in `scope` rooted at `root`, with `members` (each `[sub, status]`), in the directory and on chain. `stale`:
 * a member the directory still holds `active` but the chain no longer links (an unlink whose sync failed). Returns its
 * User ID (as home-devices.test.ts).
 */
async function account(scope: string, root: string, members: [string, 'active' | 'pending' | 'unlinked' | 'stale'][] = []): Promise<string> {
  for (const [sub, status] of members) if (status === 'active' || status === 'pending') onChain.set(sub, { root, status: status === 'active' ? 'member' : 'pending' });
  const now = Date.now();
  const userId = `hu_${b36(26)}`;
  const tokenSub = userSubOf(scope, root);
  await env.DB.prepare('INSERT INTO end_users (user_id, token_sub, support_code, scope_id, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)').bind(userId, tokenSub, 'ABCDEFGH', scope, now).run();
  const identity = (sub: string, role: string, status: string) =>
    env.DB.prepare('INSERT INTO end_user_identities (scope_id, identity_key, user_id, provider, sub, role, status, effective_at, first_seen_at, observed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?8)')
      .bind(scope, hex64(), userId, 'google', sub, role, status, now)
      .run();
  await identity(root, 'root', 'active');
  for (const [sub, status] of members) await identity(sub, 'member', status === 'stale' ? 'active' : status);
  return tokenSub;
}

/** The directory's row for a member `sub` in `scope` (what a sync after an unlink or a new link writes). */
const setMember = (scope: string, sub: string, status: string, effectiveAt: number | null) =>
  env.DB.prepare("UPDATE end_user_identities SET status = ?3, effective_at = ?4 WHERE scope_id = ?1 AND sub = ?2 AND role = 'member'").bind(scope, sub, status, effectiveAt).run();

const shareRows = (appId: string) => env.DB.prepare('SELECT user_sub, provider, sub, via, shared_at FROM name_shares WHERE app_id = ?1 ORDER BY user_sub').bind(appId).all<Body>().then((r) => r.results);
const sharesOf = (sub: string) => env.DB.prepare("SELECT app_id FROM name_shares WHERE provider = 'google' AND sub = ?1 ORDER BY app_id").bind(sub).all<{ app_id: string }>().then((r) => r.results.map((x) => x.app_id));
const profileRow = (sub: string, provider = 'google') => env.DB.prepare('SELECT given_name, family_name FROM home_profiles WHERE provider = ?1 AND sub = ?2').bind(provider, sub).first<Body>();
const identityReads = () => near.viewCalls.filter((c) => c.method === 'get_identity').length;

// ---- POST/GET /v1/home/profile ----

describe('the name: set, read, change, remove', () => {
  it('sets both parts, normalized (trimmed, inner spaces folded, NFC); GET answers exactly {name, shares, more, app}', async () => {
    const me = await home();
    expect(await profile(me)).toEqual({ name: null, shares: [], more: false, app: null });
    const res = await setName(me, '  Ada \u00a0  Mary\t', 'Lovelace\u0301');
    expect(res.status).toBe(200);
    expect(await answer(res)).toEqual({ name: { givenName: 'Ada Mary', familyName: 'Lovelac\u00e9' } });
    const got = await profile(me);
    expect(Object.keys(got)).toEqual(['name', 'shares', 'more', 'app']);
    expect(got).toEqual({ name: { givenName: 'Ada Mary', familyName: 'Lovelac\u00e9' }, shares: [], more: false, app: null });
    expect(await profileRow(me.sub)).toEqual({ given_name: 'Ada Mary', family_name: 'Lovelac\u00e9' });
    expect(res.headers.get('access-control-allow-origin')).toBe(AUTH);
  });

  it('one part only (the other null, empty or blank); a change replaces both parts', async () => {
    const me = await home();
    for (const [given, family, want] of [
      ['Ada', null, { givenName: 'Ada', familyName: null }],
      ['', 'Lovelace', { givenName: null, familyName: 'Lovelace' }],
      ['  Grace ', '   ', { givenName: 'Grace', familyName: null }],
    ] as const) {
      const res = await setName(me, given, family);
      expect(await answer(res)).toEqual({ name: want });
      expect((await profile(me)).name).toEqual(want);
    }
    expect(await profileRow(me.sub)).toEqual({ given_name: 'Grace', family_name: null });
  });

  it('a name of exactly 50 code points (astral ones count as one) passes; 51 is bad_name', async () => {
    const me = await home();
    const fifty = `${'\u{1F600}'.repeat(10)}${'a'.repeat(40)}`;
    expect((await setName(me, fifty, 'x'.repeat(50))).status).toBe(200);
    expect((await profile(me)).name).toEqual({ givenName: fifty, familyName: 'x'.repeat(50) });
    await expectCode(await setName(me, `${fifty}b`, null), 400, 'bad_name');
    await expectCode(await setName(me, null, 'y'.repeat(51)), 400, 'bad_name');
    // A refused write changes nothing.
    expect((await profile(me)).name).toEqual({ givenName: fifty, familyName: 'x'.repeat(50) });
  });

  it('bad_name: bidi, zero-width, control, new line, private use, or not a string, in either part; nothing is written', async () => {
    const me = await home();
    for (const bad of ['Ada\u202eecalevol', 'A\u200bda', 'Ada\u0007', 'Ada\nLovelace', 'Ada\u2066x', '\ue000Ada', 'A\ufeffda', 'Ada\u00adx', 7, true, ['Ada'], { first: 'Ada' }]) {
      for (const [given, family] of [[bad, 'Lovelace'], ['Ada', bad]]) {
        const res = await setName(me, given, family);
        expect({ status: res.status, code: ((await res.json()) as Body).code }, JSON.stringify(bad)).toEqual({ status: 400, code: 'bad_name' });
      }
    }
    expect(await profileRow(me.sub)).toBeNull();
    expect((await profile(me)).name).toBeNull();
  });

  it('the body is exactly {givenName, familyName}: a missing or extra key, an array, JSON null or not JSON is bad_request', async () => {
    const me = await home();
    for (const raw of ['{"givenName":"Ada"}', '{"familyName":"Lovelace"}', '{"givenName":"Ada","familyName":null,"middle":"X"}', '{}', '["Ada","Lovelace"]', 'null', '"Ada"', 'not json', '{"givenName":"Ada","familyName":null']) {
      await expectCode(await me.send('POST', HOME_PROFILE_ENDPOINT, undefined, { raw }), 400, 'bad_request');
    }
    await expectCode(await me.send('POST', HOME_PROFILE_ENDPOINT), 400, 'bad_request');
    expect(await profileRow(me.sub)).toBeNull();
  });

  it('removing (both null or empty) deletes the profile and every share of this identity’s name, and says how many', async () => {
    const me = await home();
    const a = await seedApp();
    const b = await seedApp();
    await named(me, 'Ada', 'Lovelace');
    await shares(me, a);
    await shares(me, b);
    const res = await setName(me, '', null);
    expect(await answer(res)).toEqual({ name: null, stopped: 2 });
    expect(await profileRow(me.sub)).toBeNull();
    expect(await sharesOf(me.sub)).toEqual([]);
    expect(await profile(me, `?appId=${a.id}`)).toEqual({ name: null, shares: [], more: false, app: { appId: a.id, shared: false } });
    // Setting a name again shares nothing by itself.
    await named(me, 'Ada', null);
    expect((await profile(me)).shares).toEqual([]);
    expect(nameClaims(await claimsFor(a, me.sub))).toEqual({ given_name: undefined, family_name: undefined });
    // Removing with nothing set is a no-op answer.
    expect(await answer(await setName(me, null, null))).toEqual({ name: null, stopped: 0 });
    expect(await answer(await setName(me, null, null))).toEqual({ name: null, stopped: 0 });
  });

  it('each identity has its own name: another’s set, change or removal never touches it, and never shows', async () => {
    const ada = await home(`e1.${uid()}`);
    const bob = await home();
    const app = await seedApp();
    await named(ada, 'Ada', 'Lovelace');
    await shares(ada, app);
    expect(await profile(bob, `?appId=${app.id}`)).toEqual({ name: null, shares: [], more: false, app: { appId: app.id, shared: false } });
    await named(bob, 'Bob', null);
    expect(await answer(await setName(bob, null, null))).toEqual({ name: null, stopped: 0 });
    expect((await profile(ada)).name).toEqual({ givenName: 'Ada', familyName: 'Lovelace' });
    expect(await sharesOf(ada.sub)).toEqual([app.id]);
    // The same string as an email login's sub is another person (provider and sub key the row).
    const asEmail = await home(ada.sub, { email: true });
    expect((await profile(asEmail)).name).toBeNull();
    await named(asEmail, 'Eve', null);
    expect(await profileRow(ada.sub, 'email')).toEqual({ given_name: 'Eve', family_name: null });
    expect(await profileRow(ada.sub)).toEqual({ given_name: 'Ada', family_name: 'Lovelace' });
  });

  it('a stored part that no longer passes the rule is never shown (read through normalizeProfileName again)', async () => {
    const me = await home();
    await env.DB.prepare("INSERT INTO home_profiles (provider, sub, given_name, family_name, updated_at) VALUES ('google', ?1, ?2, 'Lovelace', 1)").bind(me.sub, 'A\u202eda').run();
    expect((await profile(me)).name).toEqual({ givenName: null, familyName: 'Lovelace' });
    expect(storedName({ given_name: 'A\u200bda', family_name: null })).toBeNull();
    expect(storedName(null)).toBeNull();
  });
});

describe('the Home gate, routes and failures', () => {
  it('refuses without the Home identity, from another origin, and a scope client’s token; preflight only for AUTH_ORIGIN', async () => {
    const me = await home();
    for (const [method, path] of [
      ['GET', HOME_PROFILE_ENDPOINT],
      ['POST', HOME_PROFILE_ENDPOINT],
      ['POST', HOME_NAME_SHARING_ENDPOINT],
    ] as const) {
      await expectCode(await call(path, { method, headers: { origin: AUTH }, ...(method === 'POST' ? { body: { givenName: 'Ada', familyName: null } } : {}) }), 401, 'missing_home_identity');
      await expectCode(await me.send(method, path, method === 'POST' ? { givenName: 'Ada', familyName: null } : undefined, { origin: 'https://partner.example' }), 403, 'origin_not_allowed');
      expect((await call(path, { method: 'OPTIONS', headers: { origin: AUTH } })).status).toBe(204);
      expect((await call(path, { method: 'OPTIONS', headers: { origin: 'https://partner.example' } })).status).toBe(403);
    }
    expect(await profileRow(me.sub)).toBeNull();
    expect((await call(HOME_PROFILE_ENDPOINT, { method: 'PUT', headers: { origin: AUTH } })).status).toBe(405);
    expect((await call(HOME_NAME_SHARING_ENDPOINT, { method: 'GET', headers: { origin: AUTH } })).status).toBe(405);
  });

  it(`the two writes share one per-Home-key window (${HOME_PROFILE_WRITE_PER_KEY_MINUTE} a minute); the read keeps its own`, async () => {
    const { startOfMinuteClock } = await import('./helpers.ts');
    await startOfMinuteClock();
    const me = await home();
    for (let i = 0; i < HOME_PROFILE_WRITE_PER_KEY_MINUTE; i++) {
      const res = i % 2 ? await sharing(me, 'app_nosuchapp', false) : await setName(me, `Ada ${i}`, null);
      expect(res.status).toBe(i % 2 ? 404 : 200);
    }
    await expectCode(await setName(me, 'Late', null), 429, 'rate_limited');
    await expectCode(await sharing(me, 'app_nosuchapp'), 429, 'rate_limited');
    expect((await profile(me)).name).toEqual({ givenName: `Ada ${HOME_PROFILE_WRITE_PER_KEY_MINUTE - 2}`, familyName: null });
  });

  it('a D1 failure is 503 home_directory_unavailable; an env before migration 0019 answers 503 profile_unavailable', async () => {
    const me = await home();
    await named(me, 'Ada', null);
    vi.spyOn(env.DB, 'batch').mockRejectedValueOnce(new Error('D1 down'));
    await expectCode(await me.send('GET', HOME_PROFILE_ENDPOINT), 503, 'home_directory_unavailable');
    vi.spyOn(env.DB, 'batch').mockRejectedValueOnce(new Error('D1_ERROR: no such table: home_profiles: SQLITE_ERROR'));
    await expectCode(await me.send('GET', HOME_PROFILE_ENDPOINT), 503, 'profile_unavailable');
    vi.spyOn(env.DB, 'batch').mockRejectedValueOnce(new Error('D1_ERROR: no such table: name_shares: SQLITE_ERROR'));
    await expectCode(await setName(me, null, null), 503, 'profile_unavailable');
    expect(await profileRow(me.sub)).toEqual({ given_name: 'Ada', family_name: null });
  });
});

// ---- POST /v1/home/name-sharing and the identity token ----

describe('sharing the name with an app', () => {
  it('409 no_profile_name before a name is set; nothing is written', async () => {
    const me = await home();
    const app = await seedApp();
    await expectCode(await sharing(me, app.id), 409, 'no_profile_name');
    expect(await shareRows(app.id)).toEqual([]);
    // A stop with nothing shared is fine.
    expect(await answer(await sharing(me, app.id, false))).toEqual({ shared: false, stopped: 0 });
  });

  it('404 unknown_app for an unknown app, a deleted app and an app with no login yet; GET ?appId gives app: null for them', async () => {
    const me = await home();
    await named(me, 'Ada', null);
    const deleted = await seedApp();
    await env.DB.prepare('UPDATE apps SET deleted_at = ?2 WHERE id = ?1').bind(deleted.id, Date.now()).run();
    const unseen = await seedApp({ firstLogin: null });
    for (const appId of ['app_nosuchapp', deleted.id, unseen.id]) {
      await expectCode(await sharing(me, appId), 404, 'unknown_app');
      await expectCode(await sharing(me, appId, false), 404, 'unknown_app');
      expect((await profile(me, `?appId=${appId}`)).app).toBeNull();
    }
    expect(await sharesOf(me.sub)).toEqual([]);
  });

  it('an env without IDENTITY_SUB_KEY: a share or a stop is 503 name_sharing_unavailable and writes nothing; GET says not shared', async () => {
    const me = await home();
    const app = await seedApp();
    await named(me, 'Ada', null);
    const noKey = { env: { IDENTITY_SUB_KEY: '' } };
    for (const share of [true, false]) await expectCode(await me.send('POST', HOME_NAME_SHARING_ENDPOINT, { appId: app.id, share }, noKey), 503, 'name_sharing_unavailable');
    expect(await shareRows(app.id)).toEqual([]);
    const res = await me.send('GET', `${HOME_PROFILE_ENDPOINT}?appId=${app.id}`, undefined, noKey);
    expect(((await answer(res)) as unknown as ProfileAnswer).app).toEqual({ appId: app.id, shared: false });
  });

  it('the body is exactly {appId, share: boolean}; a malformed or doubled GET query is 400', async () => {
    const me = await home();
    await named(me, 'Ada', null);
    const app = await seedApp();
    for (const body of [{ appId: app.id }, { share: true }, { appId: app.id, share: 'yes' }, { appId: app.id, share: 1 }, { appId: app.id, share: true, extra: 1 }, { appId: 'not-an-app', share: true }, { appId: 7, share: true }, [app.id, true]]) {
      await expectCode(await me.send('POST', HOME_NAME_SHARING_ENDPOINT, body), 400, 'bad_request');
    }
    for (const q of ['?appId=', '?appId=app_', '?appId=APP_x', `?appId=${app.id}!`, `?appId=${app.id}&appId=${app.id}`, `?appId=${app.id}&x=1`, '?scopeId=x', `?appid=${app.id}`]) {
      await expectCode(await me.send('GET', `${HOME_PROFILE_ENDPOINT}${q}`), 400, 'bad_request');
    }
    expect(await shareRows(app.id)).toEqual([]);
  });

  it('a share puts given_name and family_name in that app’s tokens only; another app of the same scope gets none', async () => {
    const me = await home();
    const app = await seedApp();
    const twin = await seedApp({ scope: app.scope });
    await named(me, 'Ada', 'Lovelace');
    // Off by default: a name alone shares nothing.
    const before = await claimsFor(app, me.sub);
    expect(Object.keys(before)).toEqual(['iss', 'aud', 'sub', 'sid', 'iat', 'exp', 'jti', 'wallets', 'login_methods']);
    await shares(me, app);
    const claims = await claimsFor(app, me.sub);
    expect(Object.keys(claims)).toEqual(['iss', 'aud', 'sub', 'sid', 'iat', 'exp', 'jti', 'wallets', 'login_methods', 'given_name', 'family_name']);
    expect(nameClaims(claims)).toEqual({ given_name: 'Ada', family_name: 'Lovelace' });
    expect(await shareRows(app.id)).toEqual([{ user_sub: claims.sub, provider: 'google', sub: me.sub, via: 'own', shared_at: expect.any(Number) }]);
    const other = await claimsFor(twin, me.sub);
    expect(other.sub).toBe(claims.sub);
    expect(Object.keys(other)).not.toContain('given_name');
    expect(Object.keys(other)).not.toContain('family_name');
    // Another user of the shared app gets none.
    expect(Object.keys(await claimsFor(app, `other-${uid()}`))).not.toContain('given_name');
  });

  it('one part only: only that claim, the other key absent', async () => {
    const me = await home();
    const app = await seedApp();
    await named(me, null, 'Lovelace');
    await shares(me, app);
    const claims = await claimsFor(app, me.sub);
    expect(Object.hasOwn(claims, 'given_name')).toBe(false);
    expect(claims.family_name).toBe('Lovelace');
  });

  it('an edit reaches the next token; a stop takes it out; removing the name takes it out of every app', async () => {
    const me = await home();
    const a = await seedApp();
    const b = await seedApp();
    await named(me, 'Ada', 'Lovelace');
    await shares(me, a);
    await shares(me, b);
    await named(me, 'Augusta', null);
    expect(nameClaims(await claimsFor(a, me.sub))).toEqual({ given_name: 'Augusta', family_name: undefined });
    expect(nameClaims(await claimsFor(b, me.sub))).toEqual({ given_name: 'Augusta', family_name: undefined });
    expect(await answer(await sharing(me, a.id, false))).toEqual({ shared: false, stopped: 1 });
    expect(Object.keys(await claimsFor(a, me.sub))).not.toContain('given_name');
    expect((await claimsFor(b, me.sub)).given_name).toBe('Augusta');
    await named(me, null, null);
    expect(Object.keys(await claimsFor(b, me.sub))).not.toContain('given_name');
    expect(await sharesOf(me.sub)).toEqual([]);
  });

  it('app.shared needs the sharer’s profile: a share row left without one reads not shared, and carries no name', async () => {
    const me = await home();
    const app = await seedApp();
    await named(me, 'Ada', null);
    await shares(me, app);
    expect((await profile(me, `?appId=${app.id}`)).app).toEqual({ appId: app.id, shared: true });
    // Not reachable through the API (a removal deletes the shares in the same batch): a row orphaned by hand.
    await env.DB.prepare("DELETE FROM home_profiles WHERE provider = 'google' AND sub = ?1").bind(me.sub).run();
    expect(await profile(me, `?appId=${app.id}`)).toEqual({ name: null, shares: [], more: false, app: { appId: app.id, shared: false } });
    expect(Object.keys(await claimsFor(app, me.sub))).not.toContain('given_name');
  });

  it('sharing again is idempotent (one row a app × account, shared_at moves)', async () => {
    const me = await home();
    const app = await seedApp();
    await named(me, 'Ada', null);
    await shares(me, app);
    const [first] = await shareRows(app.id);
    await new Promise((r) => setTimeout(r, 5));
    await shares(me, app);
    const rows = await shareRows(app.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.shared_at as number).toBeGreaterThan(first!.shared_at as number);
  });

  it('GET lists the apps this identity shares with, newest first, and app.shared for ?appId; a deleted app leaves the list', async () => {
    const me = await home();
    const a = await seedApp();
    const b = await seedApp();
    const c = await seedApp();
    await named(me, 'Ada', null);
    await shares(me, a);
    await new Promise((r) => setTimeout(r, 5));
    await shares(me, b);
    const got = await profile(me, `?appId=${a.id}`);
    expect(got.shares).toEqual([
      { appId: b.id, name: `Test ${b.id}`, scopeId: b.scope, sharedAtMs: expect.any(Number) },
      { appId: a.id, name: `Test ${a.id}`, scopeId: a.scope, sharedAtMs: expect.any(Number) },
    ]);
    expect(got.app).toEqual({ appId: a.id, shared: true });
    expect(got.more).toBe(false);
    expect((await profile(me, `?appId=${c.id}`)).app).toEqual({ appId: c.id, shared: false });
    await env.DB.prepare('UPDATE apps SET deleted_at = ?2 WHERE id = ?1').bind(b.id, Date.now()).run();
    expect((await profile(me)).shares.map((s) => s.appId)).toEqual([a.id]);
  });

  it(`at most ${HOME_NAME_SHARES_MAX} shares in one answer, with more: true`, async () => {
    const me = await home();
    await named(me, 'Ada', null);
    const scope = `s${uid()}`;
    await seedApp({ scope });
    const ids = Array.from({ length: HOME_NAME_SHARES_MAX + 1 }, (_, k) => `app_many${k}${uid()}`);
    const now = Date.now();
    await env.DB.batch(ids.map((id) => env.DB.prepare("INSERT INTO apps (id, name, scope_id, publishable_key, status, plan) VALUES (?1, ?1, ?2, ?3, 'active', 'free')").bind(id, scope, `pk_test_${id.slice(4)}`)));
    await env.DB.batch(ids.map((id, k) => env.DB.prepare("INSERT INTO name_shares (app_id, user_sub, provider, sub, via, shared_at) VALUES (?1, ?2, 'google', ?3, 'own', ?4)").bind(id, userSubOf(scope, me.sub), me.sub, now - k)));
    const got = await profile(me);
    expect(got.shares).toHaveLength(HOME_NAME_SHARES_MAX);
    expect(got.shares[0]!.appId).toBe(ids[0]);
    expect(got.more).toBe(true);
  });
});

// ---- linked accounts (D661) ----

describe('a linked member’s share (D661)', () => {
  it('a member shares for its root’s account (via member, keyed by the root’s User ID), once the chain confirms it', async () => {
    const app = await seedApp();
    const root = await home();
    const mem = await home();
    const userSub = await account(app.scope, root.sub, [[mem.sub, 'active']]);
    await named(mem, 'Mia', 'Member');
    const reads = identityReads();
    await shares(mem, app);
    expect(identityReads() - reads).toBe(1);
    expect(await shareRows(app.id)).toEqual([{ user_sub: userSub, provider: 'google', sub: mem.sub, via: 'member', shared_at: expect.any(Number) }]);
    const claims = await claimsFor(app, root.sub);
    expect(claims.sub).toBe(userSub);
    expect(nameClaims(claims)).toEqual({ given_name: 'Mia', family_name: 'Member' });
    expect(await profile(mem, `?appId=${app.id}`)).toMatchObject({ app: { appId: app.id, shared: true }, shares: [{ appId: app.id }] });
    // The root sees the account's share for the app (whichever identity shared it, with or without a name of its own),
    // but not in its own list.
    expect(await profile(root, `?appId=${app.id}`)).toEqual({ name: null, shares: [], more: false, app: { appId: app.id, shared: true } });
    await named(root, 'Rita', null);
    expect(await profile(root, `?appId=${app.id}`)).toEqual({ name: { givenName: 'Rita', familyName: null }, shares: [], more: false, app: { appId: app.id, shared: true } });
    // The root reads no chain.
    const after = identityReads();
    await profile(root, `?appId=${app.id}`);
    expect(identityReads()).toBe(after);
    // Any identity of the account may stop it.
    expect(await answer(await sharing(root, app.id, false))).toEqual({ shared: false, stopped: 1 });
    expect(Object.keys(await claimsFor(app, root.sub))).not.toContain('given_name');
  });

  it('sharing again from another identity of the account names that identity’s name', async () => {
    const app = await seedApp();
    const root = await home();
    const mem = await home();
    const userSub = await account(app.scope, root.sub, [[mem.sub, 'active']]);
    await named(mem, 'Mia', null);
    await named(root, 'Rita', null);
    await shares(mem, app);
    await shares(root, app);
    expect(await shareRows(app.id)).toEqual([{ user_sub: userSub, provider: 'google', sub: root.sub, via: 'own', shared_at: expect.any(Number) }]);
    expect((await claimsFor(app, root.sub)).given_name).toBe('Rita');
    expect((await profile(mem)).shares).toEqual([]);
  });

  it('the chain contradicting the directory (a stale row): the share is the identity’s own, never the old account’s', async () => {
    const app = await seedApp();
    const root = await home();
    const removed = await home();
    const userSub = await account(app.scope, root.sub, [[removed.sub, 'stale']]);
    await named(removed, 'Rex', null);
    await shares(removed, app);
    expect(await shareRows(app.id)).toEqual([{ user_sub: userSubOf(app.scope, removed.sub), provider: 'google', sub: removed.sub, via: 'own', shared_at: expect.any(Number) }]);
    expect(Object.keys(await claimsFor(app, root.sub))).not.toContain('given_name');
    expect((await claimsFor(app, removed.sub)).given_name).toBe('Rex');
    // Its stop and its GET act for its own account too: the old account's share stays.
    await named(root, 'Rita', null);
    await shares(root, app);
    expect((await profile(removed, `?appId=${app.id}`)).app).toEqual({ appId: app.id, shared: true });
    expect(await answer(await sharing(removed, app.id, false))).toEqual({ shared: false, stopped: 1 });
    expect((await claimsFor(app, root.sub)).given_name).toBe('Rita');
    expect((await shareRows(app.id)).map((r) => r.user_sub)).toEqual([userSub]);
  });

  it('the chain down: 503 near_unavailable (retryable), nothing written or stopped; GET ?appId 503s too', async () => {
    const app = await seedApp();
    const root = await home();
    const mem = await home();
    await account(app.scope, root.sub, [[mem.sub, 'active']]);
    await named(mem, 'Mia', null);
    await shares(mem, app);
    const before = await shareRows(app.id);
    identityDown = true;
    const other = await seedApp({ scope: app.scope });
    for (const res of [await sharing(mem, other.id), await sharing(mem, app.id, false), await mem.send('GET', `${HOME_PROFILE_ENDPOINT}?appId=${app.id}`)]) {
      expect(res.headers.get('retry-after')).toBe('2');
      await expectCode(res, 503, 'near_unavailable');
    }
    expect(await shareRows(app.id)).toEqual(before);
    expect(await shareRows(other.id)).toEqual([]);
    // The rest needs no chain: GET without an app, the root's own writes.
    expect((await profile(mem)).shares.map((s) => s.appId)).toEqual([app.id]);
    await named(root, 'Rita', null);
    await shares(root, other);
  });

  it('once the directory marks the member unlinked its name is gone from tokens, the console and Home; a later link doesn’t bring it back', async () => {
    const org = newOrg();
    const app = await orgApp({ org });
    const own = await sameScopeApp(app);
    const root = await home();
    const mem = await home();
    const userSub = await account(app.scope, root.sub, [[mem.sub, 'active']]);
    await named(mem, 'Mia', 'Member');
    await named(root, 'Rita', 'Root');
    await shares(mem, app);
    await shares(root, own);
    const consoleName = async () => ((await consoleRpc().getUser({ ...member(), orgId: org, userId: userSub })) as unknown as { user: { name: Name | null } }).user.name;
    // Both live: the console shows the latest share of the org's apps (the root's, on `own`).
    expect(await consoleName()).toEqual({ givenName: 'Rita', familyName: 'Root' });
    await sharing(root, own.id, false);
    expect(await consoleName()).toEqual({ givenName: 'Mia', familyName: 'Member' });
    await shares(root, own);

    await setMember(app.scope, mem.sub, 'unlinked', null);
    onChain.delete(mem.sub);
    expect(Object.keys(await claimsFor(app, root.sub))).not.toContain('given_name');
    expect((await profile(mem)).shares).toEqual([]);
    expect((await profile(mem, `?appId=${app.id}`)).app).toEqual({ appId: app.id, shared: false });
    expect((await profile(root, `?appId=${app.id}`)).app).toEqual({ appId: app.id, shared: false });
    expect(await consoleName()).toEqual({ givenName: 'Rita', familyName: 'Root' });
    // The root's own share is unaffected.
    expect(nameClaims(await claimsFor(own, root.sub))).toEqual({ given_name: 'Rita', family_name: 'Root' });

    // Linked again later (the new link is newer than the share): still gone, until the member shares again.
    const [row] = await shareRows(app.id);
    await setMember(app.scope, mem.sub, 'active', (row!.shared_at as number) + 1);
    onChain.set(mem.sub, { root: root.sub, status: 'member' });
    while (Date.now() <= (row!.shared_at as number) + 1) await new Promise((r) => setTimeout(r, 1));
    expect(Object.keys(await claimsFor(app, root.sub))).not.toContain('given_name');
    expect((await profile(mem)).shares).toEqual([]);
    expect((await profile(mem, `?appId=${app.id}`)).app).toEqual({ appId: app.id, shared: false });
    await sharing(root, own.id, false);
    expect(await consoleName()).toBeNull();
    await shares(mem, app);
    expect((await claimsFor(app, root.sub)).given_name).toBe('Mia');
    expect(await consoleName()).toEqual({ givenName: 'Mia', familyName: 'Member' });
  });

  it('a pending member’s share counts only once its activation time has passed (the directory’s statusAt rule)', async () => {
    const app = await seedApp();
    const root = await home();
    const mem = await home();
    const userSub = await account(app.scope, root.sub, [[mem.sub, 'active']]);
    await named(mem, 'Mia', null);
    await shares(mem, app);
    const [row] = await shareRows(app.id);
    await setMember(app.scope, mem.sub, 'pending', Date.now() + 3_600_000);
    expect(Object.keys(await claimsFor(app, root.sub))).not.toContain('given_name');
    await setMember(app.scope, mem.sub, 'pending', (row!.shared_at as number) - 1);
    expect((await claimsFor(app, root.sub)).given_name).toBe('Mia');
    for (const status of ['cancelled', 'unlinked']) {
      await setMember(app.scope, mem.sub, status, null);
      expect(Object.keys(await claimsFor(app, root.sub)), status).not.toContain('given_name');
    }
    expect(userSub).toBe((await shareRows(app.id))[0]!.user_sub);
  });
});

// ---- the console's and the admin's Users screens ----

describe('ConsoleRpc and AdminRpc: the Users screens', () => {
  it('a partner sees the name only once shared with one of its live apps in the user’s scope; null otherwise', async () => {
    const org = newOrg();
    const app = await orgApp({ org });
    const twin = await sameScopeApp(app);
    const elsewhere = await orgApp({ org });
    const foreign = await orgApp();
    const me = await home();
    const userSub = await account(app.scope, me.sub);
    const asOrg = () => ({ ...member(), orgId: org });
    const listed = async () => ((await consoleRpc().listUsers(asOrg())) as unknown as { users: { userId: string; name: Name | null }[] }).users.find((u) => u.userId === userSub)!.name;
    const got = async () => ((await consoleRpc().getUser({ ...asOrg(), userId: userSub })) as unknown as { user: { name: Name | null } }).user.name;
    await named(me, 'Ada', 'Lovelace');
    // A name alone is never the partner's.
    expect([await listed(), await got()]).toEqual([null, null]);
    await shares(me, twin);
    expect([await listed(), await got()]).toEqual([
      { givenName: 'Ada', familyName: 'Lovelace' },
      { givenName: 'Ada', familyName: 'Lovelace' },
    ]);
    // An edit shows at once.
    await named(me, 'Augusta', null);
    expect(await listed()).toEqual({ givenName: 'Augusta', familyName: null });
    // Stopped: gone. A deleted app's share: gone.
    await sharing(me, twin.id, false);
    expect([await listed(), await got()]).toEqual([null, null]);
    await shares(me, twin);
    await env.DB.prepare('UPDATE apps SET deleted_at = ?2 WHERE id = ?1').bind(twin.id, Date.now()).run();
    expect([await listed(), await got()]).toEqual([null, null]);
    // A row naming the user's User ID under another scope's app of the org, or another org's app: never shown.
    for (const other of [elsewhere, foreign]) {
      await env.DB.prepare("INSERT INTO name_shares (app_id, user_sub, provider, sub, via, shared_at) VALUES (?1, ?2, 'google', ?3, 'own', ?4)").bind(other.id, userSub, me.sub, Date.now()).run();
    }
    expect([await listed(), await got()]).toEqual([null, null]);
    // The other org never lists the user at all.
    expect(((await consoleRpc().listUsers({ ...member(), orgId: foreign.org })) as unknown as { users: { userId: string }[] }).users.map((u) => u.userId)).not.toContain(userSub);
    // Removing the name: gone.
    await shares(me, app);
    expect(await got()).toEqual({ givenName: 'Augusta', familyName: null });
    await named(me, null, null);
    expect([await listed(), await got()]).toEqual([null, null]);
  });

  it('staff see each identity’s name and the account’s (the root’s first), whatever was shared', async () => {
    const org = newOrg();
    const app = await orgApp({ org });
    const root = await home();
    const mem = await home();
    const userSub = await account(app.scope, root.sub, [[mem.sub, 'active']]);
    type Staff = { userId: string; name: Name | null; identities: { sub: string | null; role: string; name: Name | null }[] };
    const viaList = async () => ((await adminRpc().listUsers({ ...hana(), orgId: org })) as unknown as { users: Staff[] }).users.find((u) => u.userId === userSub)!;
    const viaFind = async () => ((await adminRpc().findUsers({ ...hana(), query: userSub })) as unknown as { users: Staff[] }).users[0]!;
    const viaGet = async () => ((await adminRpc().getUser({ ...hana(), userId: userSub })) as unknown as { user: Staff }).user;
    const all = async () => [await viaList(), await viaFind(), await viaGet()];
    for (const u of await all()) {
      expect(u.name).toBeNull();
      expect(u.identities.map((i) => [i.role, i.name])).toEqual([
        ['root', null],
        ['member', null],
      ]);
    }
    // Only the member has a name, shared with nothing: the account's name is the member's.
    await named(mem, 'Mia', null);
    for (const u of await all()) {
      expect(u.name).toEqual({ givenName: 'Mia', familyName: null });
      expect(u.identities.map((i) => [i.sub, i.name])).toEqual([
        [root.sub, null],
        [mem.sub, { givenName: 'Mia', familyName: null }],
      ]);
    }
    // The root's comes first once set.
    await named(root, null, 'Root');
    for (const u of await all()) {
      expect(u.name).toEqual({ givenName: null, familyName: 'Root' });
      expect(u.identities[0]!.name).toEqual({ givenName: null, familyName: 'Root' });
    }
    expect(((await consoleRpc().listUsers({ ...member(), orgId: org })) as unknown as { users: { name: unknown }[] }).users[0]!.name).toBeNull();
  });

  it('AdminRpc.profileNames: the names of the identities given, ones with no name left out; staff only; bounded', async () => {
    const ada = await home(`e1.${uid()}`);
    const bob = await home();
    const none = await home();
    const asEmail = await home(ada.sub, { email: true });
    await named(ada, 'Ada', 'Lovelace');
    await named(bob, null, 'Builder');
    await named(asEmail, 'Eve', null);
    const ids = [
      { provider: 'google', sub: ada.sub },
      { provider: 'google', sub: bob.sub },
      { provider: 'google', sub: none.sub },
      { provider: 'email', sub: bob.sub },
      { provider: 'google', sub: 'unknown-sub' },
    ];
    const r = (await adminRpc().profileNames({ ...hana(), identities: ids })) as unknown as { ok: true; names: Body[] };
    expect(r.ok).toBe(true);
    expect(r.names).toEqual(
      [
        { provider: 'google', sub: ada.sub, givenName: 'Ada', familyName: 'Lovelace' },
        { provider: 'google', sub: bob.sub, givenName: null, familyName: 'Builder' },
      ].sort((x, y) => (x.sub < y.sub ? -1 : 1)),
    );
    const both = (await adminRpc().profileNames({ ...hana(), identities: [{ provider: 'email', sub: ada.sub }, { provider: 'google', sub: ada.sub }] })) as unknown as { names: Body[] };
    expect(both.names).toEqual([
      { provider: 'email', sub: ada.sub, givenName: 'Eve', familyName: null },
      { provider: 'google', sub: ada.sub, givenName: 'Ada', familyName: 'Lovelace' },
    ]);
    // Before migration 0019: nobody has a name (an empty answer); any other failure is not hidden.
    const failing = (message: string) => ({ all: () => Promise.reject(new Error(message)) }) as unknown as HotDb;
    expect(await adminProfileNames(failing('D1_ERROR: no such table: home_profiles: SQLITE_ERROR'), ids)).toEqual([]);
    await expect(adminProfileNames(failing('D1_ERROR: network'), ids)).rejects.toThrow('network');
    for (const actor of [member(), system()]) expect(await adminRpc().profileNames({ ...actor, identities: ids })).toMatchObject({ ok: false, code: 'forbidden' });
    for (const bad of [[], Array.from({ length: 51 }, (_, k) => ({ provider: 'google', sub: `s${k}` })), [{ provider: 'Google', sub: 'x' }], [{ provider: 'google', sub: '' }], [{ provider: 'google', sub: 'x', extra: 1 }]]) {
      expect(await adminRpc().profileNames({ ...hana(), identities: bad })).toMatchObject({ ok: false, code: 'bad_request' });
    }
  });
});

// ---- retention ----

describe('retention: purgeDirectory', () => {
  it('deletes the name shares of apps deleted 30+ days ago, and only those; the names stay', async () => {
    const me = await home();
    await named(me, 'Ada', null);
    const old = await seedApp();
    const old2 = await seedApp();
    const recent = await seedApp();
    const live = await seedApp();
    for (const a of [old, old2, recent, live]) await shares(me, a);
    const now = Date.now();
    const deleteAt = (a: SeededApp, at: number) => env.DB.prepare('UPDATE apps SET deleted_at = ?2 WHERE id = ?1').bind(a.id, at).run();
    await deleteAt(old, now - 31 * DAY);
    await deleteAt(old2, now - 40 * DAY);
    await deleteAt(recent, now - 10 * DAY);
    const db = new HotDb(env.DB);
    const total = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM name_shares').first<{ n: number }>())!.n;
    const before = await total();
    // In pages of `limit`.
    const first = await purgeDirectory(db, { before: now, limit: 1 }, now);
    expect(first.nameShares).toBe(1);
    const second = await purgeDirectory(db, { before: now, limit: 100 }, now);
    expect((first.nameShares ?? 0) + (second.nameShares ?? 0)).toBe(before - (await total()));
    expect(await sharesOf(me.sub)).toEqual([recent.id, live.id].sort());
    expect((await purgeDirectory(db, { before: now, limit: 100 }, now)).nameShares).toBe(0);
    expect(await profileRow(me.sub)).toEqual({ given_name: 'Ada', family_name: null });
  });
});

// ---- the mint's name read, and logs ----

describe('the mint’s name read and the logs', () => {
  it('a token without a shared name has no given_name/family_name key at all; a failing read mints without a name', async () => {
    const me = await home();
    const app = await seedApp();
    const plain = await claimsFor(app, me.sub);
    expect(Object.hasOwn(plain, 'given_name') || Object.hasOwn(plain, 'family_name')).toBe(false);
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((l: unknown) => void lines.push(String(l)));
    vi.spyOn(console, 'error').mockImplementation((l: unknown) => void lines.push(String(l)));
    vi.spyOn(console, 'warn').mockImplementation((l: unknown) => void lines.push(String(l)));
    const ctx = { requestId: 'req_test' } as Parameters<typeof mintName>[1];
    const failing = (message: string) => ({ DB: { prepare: () => ({ bind: () => ({ first: () => Promise.reject(new Error(message)) }) }) } as unknown as D1Database });
    const input = { appId: app.id, userSub: userSubOf(app.scope, me.sub), now: Date.now() };
    expect(await mintName(failing('D1_ERROR: no such table: name_shares: SQLITE_ERROR'), ctx, input)).toBeNull();
    expect(lines).toEqual([]);
    expect(await mintName(failing('D1_ERROR: network'), ctx, input)).toBeNull();
    expect(lines.join('\n')).toContain('identity_name_failed');
    expect(lines.join('\n')).not.toContain(input.userSub);
  });

  it('no name, sub, User ID or (on Home routes) app id reaches a log line', async () => {
    const spy = { log: vi.spyOn(console, 'log'), warn: vi.spyOn(console, 'warn'), error: vi.spyOn(console, 'error') };
    const logs = () => [...spy.log.mock.calls, ...spy.warn.mock.calls, ...spy.error.mock.calls].flat().join('\n');
    const org = newOrg();
    const app = await orgApp({ org });
    const root = await home(`secret${uid().replace(/[^0-9]/gu, '')}7`);
    const mem = await home(`secret${uid().replace(/[^0-9]/gu, '')}8`);
    const userSub = await account(app.scope, root.sub, [[mem.sub, 'active']]);
    const start = logs().length;
    await named(mem, 'Zebulon', 'Quixotic');
    await shares(mem, app);
    await profile(mem, `?appId=${app.id}`);
    await setName(mem, 'Bad\u202e', null);
    await sharing(mem, 'app_nosuchapp');
    identityDown = true;
    await sharing(mem, app.id, false);
    identityDown = false;
    const home_ = logs().slice(start);
    expect(home_).toContain(HOME_PROFILE_ENDPOINT);
    expect(home_).toContain(HOME_NAME_SHARING_ENDPOINT);
    expect(home_).not.toContain(app.id);
    expect(home_).not.toContain('app_nosuchapp');
    const mid = logs().length;
    expect((await claimsFor(app, root.sub)).given_name).toBe('Zebulon');
    await consoleRpc().listUsers({ ...member(), orgId: org });
    await adminRpc().listUsers({ ...hana(), orgId: org });
    await adminRpc().profileNames({ ...hana(), identities: [{ provider: 'google', sub: mem.sub }] });
    await named(mem, null, null);
    expect(logs().length).toBeGreaterThan(mid);
    const logged = logs().slice(start);
    for (const secret of ['Zebulon', 'Quixotic', root.sub, mem.sub, userSub]) expect(logged).not.toContain(secret);
  });
});
