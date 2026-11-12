// POST /v1/home/login (docs/hana-home-spec.md "Tests", H3 of the build plan): a derive with no app gate. Every limit
// before the relay; a member's root path; a suspended, deleted and purged scope; nothing relayed on any failed check;
// the directory row (D500); `key_exported` with `chain` null and `app_id` NULL (D520); the Home pool; the exit client.
// H11: the derive's usage event and who pays for it (D461, D585, D586), with capture on and off; the Home keys in
// `AdminRpc.relayerKeys` (readiness 7.4a).
import { encodeHomeIdentity, HOME_EMAIL_AUDIENCE, homeMessage, homeNonce } from '@hana-id/core/home';
import { usageEventV1 } from '@hana-id/console-core';
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { KeyPair, type KeyPairString } from '@near-js/crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOME_DERIVES_PER_DAY_DEFAULT, HOME_DERIVES_PER_PATH_HOUR, HOME_DERIVES_PER_USER_DAY, HOME_DERIVES_PER_USER_HOUR, HOME_LOGIN_ENDPOINT, HOME_LOGIN_PER_IP_HOUR, HOME_SESSION_MAX_MS, checkHomeClientScope, countHomeDerive, homeDerivesPerDay, homeUnrecordedCeiling, toHomeLogin } from '../src/home/login.ts';
import { relayerKeys, relayerPools } from '../src/changes/admin.ts';
import { relayerKeyCount } from '../src/relayer-pool.ts';
import { HOME_PAYER, hanaOrgId, homeBillingOrg, homePayerOrg, homeScopeStanding } from '../src/home/billing.ts';
import { clearViewCaches } from '../src/views.ts';
import { syncAfterLogin } from '../src/directory/sync.ts';
import { checkClientScope } from '../src/handlers.ts';
import { clearLinkViewCaches } from '../src/link-views.ts';
import { sha256Hex } from '../src/owner-actions.ts';
import { parseRelayerKeys, POOL_METHODS, POOL_SECRET, poolAllows, poolsSharingAKey, relayerKeyName } from '../src/relayer-config.ts';
import { ckdPayload, sessionNonce } from '../src/session-crypto.ts';
import { adminRpc, system } from './rpc-helpers.ts';
import { emailAud, emailEnv, emailToken, withEmail, type EmailChain } from './email-helpers.ts';
import { GOOGLE_ISS, type Chain, call, chain, google, seedApp, signSession, startOfMinuteClock, uid } from './helpers.ts';
import { appKey, loginBody, withCombinedCall } from './login-helpers.ts';
import { ledger } from './usage-ledger.ts';

const AUTH = env.AUTH_ORIGIN!;
const SHARED = 'shared-client.apps.googleusercontent.com';
const EXIT = 'hana-exit.apps.googleusercontent.com';
const OWN = 'partner-own.apps.googleusercontent.com';

const homeKeys = parseRelayerKeys(env.HOME_RELAYER_KEYS, 'HOME_RELAYER_KEYS').map((k) => KeyPair.fromString(k as KeyPairString).getPublicKey().toString());

interface Identity {
  sign: (body: string, counter?: number) => string;
  /** A header for GET `path` (the app list), with a fresh counter. */
  get: (path: string) => string;
}

let counter = 0;

/** A Home identity: `jwt` is built from the Home nonce (a Google token by default). */
async function newIdentity(o: { sub?: string; aud?: string; jwt?: (nonce: string) => Promise<string> } = {}): Promise<Identity> {
  const kp = KeyPair.fromRandom('ed25519');
  const pub = Uint8Array.from(kp.getPublicKey().data);
  const expiresAtMs = Date.now() + 15 * 60_000;
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const nonce = homeNonce({ signer: env.SIGNER_ACCOUNT, homePublicKey: pub, expiresAtMs, salt });
  const jwt = o.jwt ? await o.jwt(nonce) : await google.sign({ iss: GOOGLE_ISS, aud: o.aud ?? SHARED, sub: o.sub ?? SUB, nonce, exp: Math.floor(Date.now() / 1000) + 3600 });
  return {
    get: (path) => {
      const c = ++counter;
      const sig = kp.sign(homeMessage({ signer: env.SIGNER_ACCOUNT, counter: c, method: 'GET', path, body: new Uint8Array(0) })).signature;
      return encodeHomeIdentity({ jwt, key: pub, expiresAtMs, salt, counter: c, sig: Uint8Array.from(sig) });
    },
    sign: (body, c = ++counter) => {
      const sig = kp.sign(homeMessage({ signer: env.SIGNER_ACCOUNT, counter: c, method: 'POST', path: HOME_LOGIN_ENDPOINT, body: new TextEncoder().encode(body) })).signature;
      return encodeHomeIdentity({ jwt, key: pub, expiresAtMs, salt, counter: c, sig: Uint8Array.from(sig) });
    },
  };
}

/** A Home derive body (one use, 15 minutes, key_index 0) for `scope`, its session token issued by `aud` to `sub`. */
const body = async (scope: string, aud: string, o: { sub?: string; maxUses?: number; expiresAtMs?: number; keyIndex?: number; extra?: Record<string, unknown>; claims?: Record<string, unknown>; key?: { pk1: string; pk2: string } } = {}): Promise<Record<string, unknown>> => {
  const b = await loginBody(
    scope,
    aud,
    { maxUses: o.maxUses ?? 1, expiresAtMs: o.expiresAtMs ?? Date.now() + 15 * 60_000, keyIndex: o.keyIndex ?? 0 },
    { sub: o.sub ?? SUB, ...o.claims },
    o.key ?? appKey(3n),
  );
  return { scopeId: scope, ...b, ...o.extra };
};

const post = (rawBody: string, header: string | null, init: { origin?: string | null; ip?: string; env?: Partial<typeof env> } = {}) =>
  call(HOME_LOGIN_ENDPOINT, {
    method: 'POST',
    rawBody,
    headers: {
      ...(init.origin === null ? {} : { origin: init.origin ?? AUTH }),
      ...(header === null ? {} : { 'x-hana-home': header }),
      'content-type': 'application/json',
      'cf-connecting-ip': init.ip ?? `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
    },
    ...(init.env ? { env: init.env } : {}),
  });

/** One full derive by `identity` (a fresh one by default), from its own IP. */
const derive = async (b: Record<string, unknown>, identity?: Identity, init: { ip?: string; env?: Partial<typeof env>; sub?: string } = {}) => {
  const id = identity ?? (await newIdentity({ sub: init.sub ?? SUB }));
  const raw = JSON.stringify(b);
  return post(raw, id.sign(raw), { ...(init.ip ? { ip: init.ip } : {}), ...(init.env ? { env: init.env } : {}) });
};

const json = (r: Response): Promise<Record<string, unknown>> => r.json() as Promise<Record<string, unknown>>;

let near: Chain;
let scope: string;
let SUB: string;

/** Chain state changed under cached views: read them fresh, as a later request would after their TTL. */
const fresh = (): void => {
  clearViewCaches();
  clearLinkViewCaches();
};

// Date.now, not `new Date()`: the Worker's clock, which startOfMinuteClock moves (and `new Date()` doesn't follow).
const today = (): string => new Date(Date.now()).toISOString().slice(0, 10);
const usage = async (): Promise<number> => (await env.DB.prepare('SELECT derives FROM home_usage WHERE day = ?1').bind(today()).first<{ derives: number }>())?.derives ?? 0;
const events = async (scopeId: string) =>
  (await env.DB.prepare("SELECT kind, app_id, user_id, chain, request_id FROM user_events WHERE scope_id = ?1 AND kind = 'key_exported' ORDER BY id").bind(scopeId).all<Record<string, unknown>>()).results;
const relays = () => near.sent.filter((t) => t.method === 'create_session_and_derive');
/** The directory holds `sub` as an active user of `scopeId`, as a partner login would have written it. */
const hasRow = (scopeId: string, sub: string) => syncAfterLogin(env, scopeId, { provider: 'google', sub }, null, { pending: false, path: `${scopeId}#google#${sub}#0`, confirmed: true }, { requestId: 'seed', endpoint: 'test' });
const newScope = (): string => {
  const s = `x${uid()}`.toLowerCase().replace(/[^a-z0-9]/gu, '').slice(0, 60);
  near.allowShared.add(s);
  return s;
};
const budgetEvents = async () => (await env.DB.prepare("SELECT id, kind, scope_id, detail_json FROM security_events WHERE kind = 'home_budget_high'").all<Record<string, unknown>>()).results;

beforeEach(async () => {
  SUB = `sub-${uid()}`;
  near = chain({}, { shared: [SHARED] });
  withCombinedCall(near, { ckd: 'ok' });
  scope = `s${uid()}`.toLowerCase().replace(/[^a-z0-9]/gu, '').slice(0, 60);
  near.allowShared.add(scope);
  near.install();
  await env.DB.exec('DELETE FROM home_usage');
  await env.DB.exec("DELETE FROM security_events WHERE kind = 'home_budget_high'");
});
afterEach(() => vi.restoreAllMocks());

describe('POST /v1/home/login: what it opens', () => {
  it('a shared-login scope, through the Home pool only, with no app and no publishable key', async () => {
    const before = near.sent.length;
    const r = await derive(await body(scope, SHARED));
    expect(r.status).toBe(200);
    const b = await json(r);
    expect(b.result).toEqual({ big_y: 'bls12381g1:Y', big_c: 'bls12381g1:C' });
    expect(b.session).toMatchObject({ scope_id: scope, max_uses: 1, used: 1 });
    expect(near.sent.length).toBe(before + 1);
    const tx = near.sent.at(-1)!;
    expect(tx.method).toBe('create_session_and_derive');
    expect(homeKeys).toContain(tx.publicKey);
    expect(tx.args.scope_id).toBe(scope);
  });

  it('a suspended app’s scope, a deleted app’s scope and a scope with no D1 row (D461, D463: Home is keyed by scope)', async () => {
    const suspended = await seedApp({ scope, status: 'suspended', suspendedBy: 1 });
    expect((await derive(await body(suspended.scope, SHARED))).status).toBe(200);

    const deleted = `del${uid()}`.toLowerCase().replace(/[^a-z0-9]/gu, '').slice(0, 60);
    near.allowShared.add(deleted);
    const app = await seedApp({ scope: deleted });
    await env.DB.prepare('UPDATE apps SET deleted_at = ?2 WHERE id = ?1').bind(app.id, Date.now()).run();
    expect((await derive(await body(deleted, SHARED))).status).toBe(200);

    // A scope only the chain knows (purged from D1, or never in it): the derive works; the directory write just notes it.
    const chainOnly = `chn${uid()}`.toLowerCase().replace(/[^a-z0-9]/gu, '').slice(0, 60);
    near.allowShared.add(chainOnly);
    expect((await derive(await body(chainOnly, SHARED))).status).toBe(200);
  });

  it('the scope’s own client, an exit client for a scope that refused shared login, and the email routes', async () => {
    const own = `own${uid()}`.toLowerCase().replace(/[^a-z0-9]/gu, '').slice(0, 60);
    near.clients[OWN] = own;
    expect((await derive(await body(own, OWN))).status).toBe(200);

    // The exit client: registered scope, whatever its clients and allow_shared (D468); the contract fake accepts it.
    near.exit = [EXIT];
    near.contract.create_session_and_derive = () => ({ big_y: 'bls12381g1:Y', big_c: 'bls12381g1:C' });
    fresh();
    const closed = `cls${uid()}`.toLowerCase().replace(/[^a-z0-9]/gu, '').slice(0, 60);
    near.clients[OWN] = closed; // the scope has only a partner-held client and allow_shared is false
    fresh();
    expect((await derive(await body(closed, EXIT), await newIdentity({ aud: EXIT }))).status).toBe(200);

    // Email: the scope's own email client.
    const mail = `eml${uid()}`.toLowerCase().replace(/[^a-z0-9]/gu, '').slice(0, 60);
    const e: EmailChain = withEmail(near, [mail]);
    e.exit = [['email', HOME_EMAIL_AUDIENCE]];
    fresh();
    const sub = `e1.${uid()}`;
    e.identities.set(`email#${sub}`, { status: 'own', opened: true });
    const emailIdentity = await newIdentity({ jwt: (nonce) => emailToken({ aud: HOME_EMAIL_AUDIENCE, sub, nonce }) });
    const b = await loginBody(mail, emailAud(mail), { maxUses: 1, expiresAtMs: Date.now() + 10 * 60_000 }, {}, appKey(3n));
    const jwt = await emailToken({ aud: emailAud(mail), sub, nonce: await sessionNonce({ signer: env.SIGNER_ACCOUNT, scopeId: mail, sessionPublicKey: b.sessionPublicKey as number[], expiresAtMs: b.expiresAtMs as number, keyIndex: 0, maxUses: 1, salt: b.salt as number[] }) });
    const r = await derive({ ...b, jwt, scopeId: mail }, emailIdentity, { env: emailEnv() });
    expect(r.status).toBe(200);
    expect((await events(mail)).length).toBe(1);
  });

  it('a linked member’s derive reaches its root: same limit bucket, its row in the directory, the root’s user in key_exported', async () => {
    const e = withEmail(near, [scope]);
    e.identities.set(`google#${SUB}`, { status: 'member', opened: false, root: { provider: 'email', sub: 'e1.root' } });
    e.accounts.set('email#e1.root', { root: { provider: 'email', sub: 'e1.root' }, members: [{ provider: 'google', sub: SUB, active: true }], epoch: 1 });
    await seedApp({ scope });
    const r = await derive(await body(scope, SHARED), undefined, { env: emailEnv() });
    expect(r.status).toBe(200);

    // The member's directory row (D500): `active`, under the root's user, with the root's own row.
    const rows = (await env.DB.prepare('SELECT provider, sub, role, status FROM end_user_identities WHERE scope_id = ?1 ORDER BY role').bind(scope).all<Record<string, unknown>>()).results;
    expect(rows).toEqual([
      expect.objectContaining({ provider: 'google', sub: SUB, role: 'member', status: 'active' }),
      expect.objectContaining({ provider: 'email', sub: 'e1.root', role: 'root', status: 'active' }),
    ]);
    // key_exported names the root's internal id (the account's user), chain null, no app.
    const ev = await events(scope);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: 'key_exported', app_id: null, chain: null });
    const internal = (await env.DB.prepare('SELECT user_id FROM end_user_identities WHERE scope_id = ?1 AND role = ?2').bind(scope, 'root').first<{ user_id: string }>())!.user_id;
    expect(ev[0]!.user_id).toBe(internal);
  });

  it('a pending member is refused (409), with nothing relayed', async () => {
    const e = withEmail(near, [scope]);
    e.identities.set(`google#${SUB}`, { status: 'pending', opened: false, root: { provider: 'email', sub: 'e1.root' } });
    const before = relays().length;
    const r = await derive(await body(scope, SHARED), undefined, { env: emailEnv() });
    expect(r.status).toBe(409);
    expect((await json(r)).code).toBe('link_pending');
    expect(relays().length).toBe(before);
  });

  it('a standing the chain didn’t confirm fails closed: the per-wallet limit needs the real path', async () => {
    const e = withEmail(near, [scope]);
    e.views.get_identity = () => {
      throw new Error('rpc down');
    };
    const before = relays().length;
    const r = await derive(await body(scope, SHARED), undefined, { env: emailEnv() });
    expect(r.status).toBe(502);
    expect((await json(r)).code).toBe('near_unavailable');
    expect(relays().length).toBe(before);
  });

  it('a stranger’s derive records key_exported (chain null, app_id NULL) but no directory row, no Support ID, and leaves apps unlaunched (D462, D520, D527)', async () => {
    const app = await seedApp({ scope, firstLogin: null, firstSession: null });
    const r = await derive(await body(scope, SHARED));
    expect(r.status).toBe(200);
    expect((await json(r)).supportId).toBeUndefined();
    const ev = await events(scope);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: 'key_exported', app_id: null, chain: null });
    expect(ev[0]!.user_id).toMatch(/^hu_/u);
    // No identity row, and no end_users row a partner's console could join.
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM end_user_identities WHERE scope_id = ?1').bind(scope).first<{ n: number }>())!.n).toBe(0);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM end_users WHERE scope_id = ?1').bind(scope).first<{ n: number }>())!.n).toBe(0);
    // Nothing marked the app or the scope as launched, and no session marker.
    const a = await env.DB.prepare('SELECT first_login_at FROM apps WHERE id = ?1').bind(app.id).first<{ first_login_at: number | null }>();
    expect(a!.first_login_at).toBeNull();
    const s = await env.DB.prepare('SELECT first_session_at FROM scopes WHERE scope_id = ?1').bind(scope).first<{ first_session_at: number | null }>();
    expect(s!.first_session_at).toBeNull();
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM session_markers WHERE app_id = ?1').bind(app.id).first<{ n: number }>())!.n).toBe(0);
  });

  const appList = async (identity: Identity, scopeId: string) => {
    const path = `/v1/home/apps?scopeId=${scopeId}`;
    const r = await call(path, { headers: { origin: AUTH, 'x-hana-home': identity.get(path) } });
    expect(r.status).toBe(200);
    return ((await json(r)).scopes as { scopeId: string; mine: boolean; apps: unknown[] }[]).filter((x) => x.scopeId === scopeId);
  };

  it('a stranger who derives in an unlaunched scope sees no `mine` and none of its apps (D462, D527)', async () => {
    await seedApp({ scope, firstLogin: null });
    const home = await newIdentity();
    expect((await derive(await body(scope, SHARED), home)).status).toBe(200);
    expect(await appList(home, scope)).toEqual([]);
  });

  it('an identity the directory already holds as active keeps its row fresh and gets its Support ID', async () => {
    await seedApp({ scope });
    await syncAfterLogin(env, scope, { provider: 'google', sub: SUB }, null, { pending: false, path: `${scope}#google#${SUB}#0`, confirmed: true }, { requestId: 'seed', endpoint: 'test' });
    const before = (await env.DB.prepare('SELECT last_seen_at FROM end_users WHERE scope_id = ?1').bind(scope).first<{ last_seen_at: number }>())!.last_seen_at;
    await env.DB.prepare('UPDATE end_users SET last_seen_at = created_at WHERE scope_id = ?1').bind(scope).run();
    const r = await derive(await body(scope, SHARED));
    expect((await json(r)).supportId).toMatch(/^HANA-/u);
    expect((await env.DB.prepare('SELECT last_seen_at FROM end_users WHERE scope_id = ?1').bind(scope).first<{ last_seen_at: number }>())!.last_seen_at).toBeGreaterThanOrEqual(before);
  });

  it('an identity whose row is unlinked or cancelled isn’t brought back by a derive', async () => {
    await seedApp({ scope });
    await syncAfterLogin(env, scope, { provider: 'google', sub: SUB }, null, { pending: false, path: `${scope}#google#${SUB}#0`, confirmed: true }, { requestId: 'seed', endpoint: 'test' });
    await env.DB.prepare("UPDATE end_user_identities SET status = 'cancelled', role = 'member' WHERE scope_id = ?1").bind(scope).run();
    const r = await derive(await body(scope, SHARED));
    expect((await json(r)).supportId).toBeUndefined();
    expect((await env.DB.prepare('SELECT status FROM end_user_identities WHERE scope_id = ?1').bind(scope).first<{ status: string }>())!.status).toBe('cancelled');
  });

  it('a linked member of a shut-down app turns `mine` after a derive (D500)', async () => {
    const e = withEmail(near, [scope]);
    const root = { provider: 'email', sub: `e1.${uid()}` };
    e.identities.set(`google#${SUB}`, { status: 'member', opened: false, root });
    e.accounts.set(`email#${root.sub}`, { root, members: [{ provider: 'google', sub: SUB, active: true }], epoch: 1 });
    await seedApp({ scope, status: 'suspended', suspendedBy: 1 });
    const home = await newIdentity();
    expect((await appList(home, scope)).filter((x) => x.mine)).toEqual([]);
    expect((await derive(await body(scope, SHARED), home, { env: emailEnv() })).status).toBe(200);
    const [row] = await appList(home, scope);
    expect(row).toMatchObject({ mine: true });
    expect(row!.apps).toHaveLength(1);
  });

  it('never logs the token, the sub or the path', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
    const b = await body(scope, SHARED);
    const raw = JSON.stringify(b);
    const r = await post(raw, (await newIdentity()).sign(raw));
    expect(r.status).toBe(200);
    const all = logs.join('\n');
    expect(all).not.toContain(SUB);
    expect(all).not.toContain(b.jwt as string);
    expect(all).not.toContain(`${scope}#google`);
  });

  it('a contract rejection is answered as /v1/login’s and stays counted; a relay that never ran is given back', async () => {
    near.contract.create_session_and_derive = () => {
      throw new Error('some contract panic');
    };
    const r = await derive(await body(scope, SHARED));
    expect(r.status).toBe(422);
    expect((await json(r)).code).toBe('contract_rejected');
    expect(await usage()).toBe(1);

    // No Home key configured: 503, and the day's count is given back.
    near.contract.create_session_and_derive = () => ({ big_y: 'bls12381g1:Y', big_c: 'bls12381g1:C' });
    const noKey = await derive(await body(scope, SHARED), undefined, { env: { HOME_RELAYER_KEYS: '[]' } });
    expect(noKey.status).toBe(503);
    expect((await json(noKey)).code).toBe('relayer_unconfigured');
    expect(await usage()).toBe(1);
  });
});

describe('POST /v1/home/login: nothing to rescue (D544)', () => {
  // Hour and UTC-day windows, and day rows keyed by the clock: start each test a second into a minute that isn't its
  // hour's last (helpers.ts startOfMinuteClock), so none straddles a boundary.
  beforeEach(startOfMinuteClock);

  it('an identity that never opened a wallet here is refused: nothing relayed, counted or spent', async () => {
    withEmail(near, [scope]);
    fresh();
    const before = near.sent.length;
    const r = await derive(await body(scope, SHARED), undefined, { env: emailEnv() });
    expect(r.status).toBe(404);
    expect((await json(r)).code).toBe('home_no_wallet');
    expect(near.sent.length).toBe(before);
    expect(await usage()).toBe(0);
    expect(await events(scope)).toEqual([]);
    const user = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`home-user:${await sha256Hex(`google#${SUB}`)}`));
    expect((await user.hit([{ name: 'home:user:hour', windowMs: 3_600_000, max: 1 }])).ok).toBe(true);
  });

  it('an identity the chain shows as opened proceeds and counts as known, row or no row', async () => {
    const e = withEmail(near, [scope]);
    e.identities.set(`google#${SUB}`, { status: 'own', opened: true });
    fresh();
    // A ceiling of 1 leaves the unrecorded share nothing, so only a known identity gets through.
    const r = await derive(await body(scope, SHARED), undefined, { env: { ...emailEnv(), HOME_DERIVES_PER_DAY: '1' } });
    expect(r.status).toBe(200);
    expect(await env.DB.prepare('SELECT derives, unrecorded FROM home_usage WHERE day = ?1').bind(today()).first()).toEqual({ derives: 1, unrecorded: 0 });
    // Known for the share only: D527 still writes no directory row without one already there.
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM end_users WHERE scope_id = ?1').bind(scope).first<{ n: number }>())!.n).toBe(0);
  });

  it('while links aren’t open nothing is refused and the derive stays in the unrecorded share', async () => {
    const e = withEmail(near, [scope]);
    e.unrecordedWallets = true;
    fresh();
    const r = await derive(await body(scope, SHARED), undefined, { env: emailEnv() });
    expect(r.status).toBe(200);
    expect(await env.DB.prepare('SELECT derives, unrecorded FROM home_usage WHERE day = ?1').bind(today()).first()).toEqual({ derives: 1, unrecorded: 1 });
  });

  it('a confirmed member proceeds though it never opened a wallet of its own', async () => {
    const e = withEmail(near, [scope]);
    e.identities.set(`google#${SUB}`, { status: 'member', opened: false, root: { provider: 'email', sub: `e1.${uid()}` } });
    fresh();
    expect((await derive(await body(scope, SHARED), undefined, { env: emailEnv() })).status).toBe(200);
    expect(await env.DB.prepare('SELECT unrecorded FROM home_usage WHERE day = ?1').bind(today()).first()).toEqual({ unrecorded: 0 });
  });

  it('a directory read that fails answers a retryable 503: nothing relayed, counted or charged to the smaller share', async () => {
    const DB = new Proxy(env.DB, {
      get(t, k) {
        if (k === 'prepare') return (sql: string) => {
          if (sql.includes('FROM end_user_identities')) throw new Error('D1 down');
          return t.prepare(sql);
        };
        const v = Reflect.get(t, k) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    const before = near.sent.length;
    const r = await derive(await body(scope, SHARED), undefined, { env: { DB } });
    expect(r.status).toBe(503);
    expect((await json(r)).code).toBe('home_directory_unavailable');
    expect(r.headers.get('retry-after')).toBe('1');
    expect(near.sent.length).toBe(before);
    expect(await usage()).toBe(0);
  });
});

describe('POST /v1/home/login: what a relay that didn’t release a key spends', () => {
  // Hour and UTC-day windows, and day rows keyed by the clock: start each test a second into a minute that isn't its
  // hour's last (helpers.ts startOfMinuteClock), so none straddles a boundary.
  beforeEach(startOfMinuteClock);

  it('ckd_failed gives the wallet window back and keeps the per-user and daily counts (D528)', async () => {
    withCombinedCall(near, { ckd: 'fail' });
    for (let i = 0; i < HOME_DERIVES_PER_PATH_HOUR + 1; i++) {
      const r = await derive(await body(scope, SHARED));
      expect(r.status).toBe(422);
      expect((await json(r)).code).toBe('ckd_failed');
    }
    expect(await usage()).toBe(HOME_DERIVES_PER_PATH_HOUR + 1);
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`home-user:${await sha256Hex(`google#${SUB}`)}`));
    // The hour's window holds the four failures: a fifth hit fits a max of 5 only once.
    expect((await stub.hit([{ name: 'home:user:hour', windowMs: 3_600_000, max: HOME_DERIVES_PER_PATH_HOUR + 2 }])).ok).toBe(true);
    expect((await stub.hit([{ name: 'home:user:hour', windowMs: 3_600_000, max: HOME_DERIVES_PER_PATH_HOUR + 2 }])).ok).toBe(false);
  });

  it('a copy the relayer already relayed answers session_exists and gives back what it took', async () => {
    const b = await body(scope, SHARED);
    expect((await derive(b)).status).toBe(200);
    expect(await usage()).toBe(1);
    // A second isolate that didn't see the session yet: the views say free, the relayer object knows the claim.
    near.sessions.delete(JSON.stringify(b.sessionPublicKey));
    fresh();
    const sent = near.sent.length;
    const r = await derive(b);
    expect(r.status).toBe(409);
    expect((await json(r)).code).toBe('session_exists');
    expect(near.sent.length).toBe(sent);
    expect(await usage()).toBe(1);
    // Two more derives fit the wallet's three: the copy spent none of it.
    expect((await derive(await body(scope, SHARED))).status).toBe(200);
    expect((await derive(await body(scope, SHARED))).status).toBe(200);
  });
});

describe('POST /v1/home/login: nothing relayed on any failed check', () => {
  const refused = async (make: () => Promise<Response>, status: number, code?: string) => {
    const before = near.sent.length;
    const r = await make();
    expect(r.status).toBe(status);
    if (code) expect((await json(r)).code).toBe(code);
    expect(near.sent.length).toBe(before);
  };

  it('every refusal: shape, token, identity, scope, in use, pause, issuer key, signature, app key, origin, replay', async () => {
    const good = await body(scope, SHARED);
    const raw = JSON.stringify(good);
    const home = await newIdentity();
    // Origin: only AUTH_ORIGIN.
    await refused(() => post(raw, home.sign(raw), { origin: 'https://wallet.example.com' }), 403, 'origin_not_allowed');
    await refused(() => post(raw, null), 401, 'missing_home_identity');
    // Shape.
    await refused(() => derive({ ...good, scopeId: 'BAD SCOPE' }), 400, 'bad_request');
    await refused(async () => derive(await body(scope, SHARED, { keyIndex: 1 })), 400, 'bad_request');
    await refused(async () => derive(await body(scope, SHARED, { maxUses: 2 })), 400, 'bad_request');
    await refused(async () => derive(await body(scope, SHARED, { expiresAtMs: Date.now() + HOME_SESSION_MAX_MS + 60_000 })), 400, 'bad_request');
    await refused(async () => derive(await body(scope, SHARED, { extra: { linkJwt: 'x' } })), 400, 'bad_request');
    await refused(async () => derive(await body(scope, SHARED, { extra: { exportChain: 'evm' } })), 400, 'bad_request');
    await refused(async () => derive({ ...(await body(scope, SHARED)), unknown: 1 }), 400, 'bad_request');
    // The token's nonce must commit to this session in this scope.
    await refused(async () => derive({ ...(await body(scope, SHARED, { claims: { nonce: 'wrong' } })) }), 400, 'nonce_mismatch');
    // The token is for another scope than the body says.
    const otherScope = `oth${uid()}`.toLowerCase().replace(/[^a-z0-9]/gu, '').slice(0, 60);
    near.allowShared.add(otherScope);
    fresh();
    const forOther = await body(otherScope, SHARED);
    await refused(() => derive({ ...forOther, scopeId: scope }), 400, 'nonce_mismatch');
    // A Home identity for someone else.
    await refused(async () => derive(await body(scope, SHARED, { sub: 'someone-else' })), 403, 'home_account_mismatch');
    // A token with a PII claim.
    await refused(async () => derive(await body(scope, SHARED, { claims: { email: 'a@b.c' } })), 400, 'token_has_pii');

    // Cross-scope and client rules.
    const ownScope = `ows${uid()}`.toLowerCase().replace(/[^a-z0-9]/gu, '').slice(0, 60);
    near.clients[OWN] = ownScope;
    near.allowShared.add(ownScope);
    fresh();
    await refused(async () => derive(await body(scope, OWN)), 403, 'scope_mismatch');
    near.allowShared.delete(scope);
    fresh();
    await refused(async () => derive(await body(scope, SHARED)), 403, 'shared_login_disabled');
    near.allowShared.add(scope);
    fresh();
    await refused(async () => derive(await body(scope, 'stranger.apps.googleusercontent.com')), 403, 'unregistered_client');
    near.missingScopes.add(scope);
    fresh();
    await refused(async () => derive(await body(scope, SHARED)), 403, 'unknown_scope');
    near.missingScopes.delete(scope);
    fresh();

    // Session key in use, pause, an inactive signing key.
    const used = await body(scope, SHARED);
    near.sessions.set(JSON.stringify(used.sessionPublicKey), { expires_at_ms: Date.now() + 3_600_000, path: 'p', scope_id: scope, max_uses: 1, used: 1 });
    await refused(() => derive(used), 409, 'session_exists');
    near.paused = true;
    fresh();
    await refused(async () => derive(await body(scope, SHARED)), 503, 'paused');
    near.paused = false;
    fresh();
    const kids = near.activeKids;
    near.activeKids = new Set();
    fresh();
    await refused(async () => derive(await body(scope, SHARED)), 503, 'issuer_key_pending');
    near.activeKids = kids;
    fresh();

    // The session key's signature and the app key.
    const badSig = await body(scope, SHARED);
    await refused(() => derive({ ...badSig, signature: new Array(64).fill(1) }), 401, 'invalid_signature');
    const mismatched = await body(scope, SHARED, { key: appKey(5n) });
    await refused(() => derive({ ...mismatched, pk2: appKey(9n).pk2 }), 401, 'invalid_signature');
    const degenerate = await body(scope, SHARED);
    const bad = 'bls12381g1:A';
    const degenerateSigned = await signSession(degenerate.sessionPublicKey as number[], 1, ckdPayload(bad, degenerate.pk2 as string));
    await refused(() => derive({ ...degenerate, pk1: bad, signature: degenerateSigned }), 400, 'invalid_app_key');
    expect(await usage()).toBe(0);
  });

  it('a Home identity can be used only once for a given signature (counter single use), and its body can’t be swapped', async () => {
    const home = await newIdentity();
    const b = await body(scope, SHARED);
    const raw = JSON.stringify(b);
    const header = home.sign(raw, 7);
    const first = await post(raw, header);
    expect(first.status).toBe(200);
    const before = near.sent.length;
    expect((await post(raw, header)).status).toBe(409);
    // The signature covers the body: a different body under the old signature is refused.
    const other = JSON.stringify(await body(scope, SHARED));
    const refusedResp = await post(other, home.sign(raw, 8));
    expect(refusedResp.status).toBe(401);
    expect((await json(refusedResp)).code).toBe('invalid_signature');
    expect(near.sent.length).toBe(before);
  });

  it('a partner-held client’s token never becomes a Home identity: the gate refuses it', async () => {
    near.clients[OWN] = scope;
    const b = await body(scope, SHARED);
    const before = near.sent.length;
    const r = await derive(b, await newIdentity({ aud: OWN }));
    expect(r.status).toBe(401);
    expect((await json(r)).code).toBe('not_a_home_client');
    expect(near.sent.length).toBe(before);
  });
});

describe('POST /v1/home/login: the limits, all before the relay', () => {
  // Hour and UTC-day windows, and day rows keyed by the clock: start each test a second into a minute that isn't its
  // hour's last (helpers.ts startOfMinuteClock), so none straddles a boundary.
  beforeEach(startOfMinuteClock);

  it('per IP: ten an hour, counted before anything is parsed', async () => {
    const ip = `10.99.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    const raw = JSON.stringify(await body(scope, SHARED));
    const home = await newIdentity();
    for (let i = 0; i < HOME_LOGIN_PER_IP_HOUR; i++) {
      // Each one refused by a real check, and still counted: it reached the per-IP limit first.
      const r = await post(raw, null, { ip });
      expect(r.status).toBe(401);
    }
    const before = near.sent.length;
    const r = await post(raw, home.sign(raw), { ip });
    expect(r.status).toBe(429);
    expect((await json(r)).code).toBe('rate_limited');
    expect(near.sent.length).toBe(before);
  });

  it('per wallet: two members of one account share their root’s three an hour', async () => {
    const e = withEmail(near, [scope]);
    const root = { provider: 'email', sub: `e1.${uid()}` };
    const other = `sub-${uid()}`;
    for (const sub of [SUB, other]) e.identities.set(`google#${sub}`, { status: 'member', opened: false, root });
    fresh();
    for (const sub of [SUB, other, SUB]) expect((await derive(await body(scope, SHARED, { sub }), undefined, { sub })).status).toBe(200);
    const before = relays().length;
    const r = await derive(await body(scope, SHARED, { sub: other }), undefined, { sub: other });
    expect(r.status).toBe(429);
    expect((await json(r)).error).toMatch(/per wallet/u);
    expect(relays().length).toBe(before);
  });

  it('per wallet: three an hour for one path', async () => {
    for (let i = 0; i < HOME_DERIVES_PER_PATH_HOUR; i++) expect((await derive(await body(scope, SHARED))).status).toBe(200);
    const before = relays().length;
    const r = await derive(await body(scope, SHARED));
    expect(r.status).toBe(429);
    expect((await json(r)).code).toBe('rate_limited');
    expect(relays().length).toBe(before);
    // The budget wasn't spent by the refusal.
    expect(await usage()).toBe(HOME_DERIVES_PER_PATH_HOUR);
    expect(HOME_DERIVES_PER_PATH_HOUR).toBeLessThan(HOME_DERIVES_PER_USER_HOUR);
  });

  it('per user: ten an hour across scopes, and a refusal gives the per-wallet window back', async () => {
    const sub = `user-${uid()}`;
    const scopes = Array.from({ length: HOME_DERIVES_PER_USER_HOUR + 1 }, (_, i) => `u${i}${uid()}`.toLowerCase().replace(/[^a-z0-9]/gu, '').slice(0, 60));
    for (const s of scopes) near.allowShared.add(s);
    for (let i = 0; i < HOME_DERIVES_PER_USER_HOUR; i++) expect((await derive(await body(scopes[i]!, SHARED, { sub }), undefined, { sub })).status).toBe(200);
    const before = relays().length;
    const refused = await derive(await body(scopes[HOME_DERIVES_PER_USER_HOUR]!, SHARED, { sub }), undefined, { sub });
    expect(refused.status).toBe(429);
    expect((await json(refused)).code).toBe('rate_limited');
    expect(relays().length).toBe(before);
    // The refused scope's per-wallet window was taken back: it can still derive once the user's hour is over.
    const windows = await env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`home-path:${scopes[HOME_DERIVES_PER_USER_HOUR]!}:${await sha256Hex(`${scopes[HOME_DERIVES_PER_USER_HOUR]!}#google#${sub}#0`)}`)).hit([{ name: 'home:path:hour', windowMs: 3_600_000, max: 1 }]);
    expect(windows.ok).toBe(true);
  });

  it('per user: twenty a UTC day', async () => {
    const sub = `user-${uid()}`;
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`home-user:${await sha256Hex(`google#${sub}`)}`));
    const dayLimit = [{ name: 'home:user:day', windowMs: 86_400_000, max: HOME_DERIVES_PER_USER_DAY }];
    for (let i = 0; i < HOME_DERIVES_PER_USER_DAY; i++) await stub.hit(dayLimit);
    const before = relays().length;
    const r = await derive(await body(scope, SHARED, { sub }), undefined, { sub });
    expect(r.status).toBe(429);
    expect((await json(r)).error).toMatch(/per user per day/u);
    expect(relays().length).toBe(before);
  });

  it('globally: HOME_DERIVES_PER_DAY, answered 429 home_busy, and the user’s windows are taken back', async () => {
    const max = 2;
    await env.DB.prepare('INSERT INTO home_usage (day, derives) VALUES (?1, ?2)').bind(today(), max).run();
    const sub = `user-${uid()}`;
    const before = near.sent.length;
    const b = await body(scope, SHARED, { sub });
    const r = await derive(b, undefined, { sub, env: { HOME_DERIVES_PER_DAY: String(max) } });
    expect(r.status).toBe(429);
    const j = await json(r);
    expect(j.code).toBe('home_busy');
    expect(j.error).toBe('Passport Home is busy, try again tomorrow');
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(near.sent.length).toBe(before);
    expect(await usage()).toBe(max);
    // The user's windows were given back: per-user hour count is 0 again, so a fresh window accepts `max`.
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`home-user:${await sha256Hex(`google#${sub}`)}`));
    expect((await stub.hit([{ name: 'home:user:hour', windowMs: 3_600_000, max: 1 }])).ok).toBe(true);
  });

  it('identities with no directory row stop at 20% while a user with a row still gets through (unrecorded, D540)', async () => {
    const e = { HOME_DERIVES_PER_DAY: '10' };
    for (let i = 0; i < 2; i++) {
      const sub = `burner-${uid()}`;
      expect((await derive(await body(newScope(), SHARED, { sub }), undefined, { sub, env: e })).status).toBe(200);
    }
    const before = relays().length;
    const sub = `burner-${uid()}`;
    const r = await derive(await body(newScope(), SHARED, { sub }), undefined, { sub, env: e });
    expect(r.status).toBe(429);
    expect((await json(r)).code).toBe('home_busy');
    expect(relays().length).toBe(before);

    const owner = `owner-${uid()}`;
    const mine = newScope();
    await hasRow(mine, owner);
    expect((await derive(await body(mine, SHARED, { sub: owner }), undefined, { sub: owner, env: e })).status).toBe(200);
    expect(await env.DB.prepare('SELECT derives, unrecorded FROM home_usage WHERE day = ?1').bind(today()).first()).toEqual({ derives: 3, unrecorded: 2 });
  });

  it('parallel requests can’t pass the unrecorded share', async () => {
    const e = { HOME_DERIVES_PER_DAY: '10' };
    const people = Array.from({ length: 6 }, () => ({ sub: `burner-${uid()}`, scope: newScope() }));
    const bodies = await Promise.all(people.map((p) => body(p.scope, SHARED, { sub: p.sub })));
    const before = relays().length;
    const results = await Promise.all(bodies.map((b, i) => derive(b, undefined, { sub: people[i]!.sub, env: e })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 429, 429, 429, 429]);
    expect(relays().length).toBe(before + 2);
  });

  it('the share rounds sensibly and always leaves one for people with records', async () => {
    expect([1, 2, 4, 5, 9, 10, 11, 500].map(homeUnrecordedCeiling)).toEqual([0, 1, 1, 1, 1, 2, 2, 100]);
    const day = '2026-11-13';
    await env.DB.prepare('DELETE FROM home_usage WHERE day = ?1').bind(day).run();
    expect(await countHomeDerive(env, day, 1, true)).toBeNull();
    expect(await env.DB.prepare('SELECT derives FROM home_usage WHERE day = ?1').bind(day).first()).toBeNull();
    expect(await countHomeDerive(env, day, 1, false)).toBe(1);
  });

  it('a relay that never ran gives the unrecorded share back too', async () => {
    const r = await derive(await body(scope, SHARED), undefined, { env: { HOME_RELAYER_KEYS: '[]' } });
    expect(r.status).toBe(503);
    expect(await env.DB.prepare('SELECT derives, unrecorded FROM home_usage WHERE day = ?1').bind(today()).first()).toEqual({ derives: 0, unrecorded: 0 });
  });

  it('80% of the ceiling writes one home_budget_high event, counts only, that the admin can read (D541)', async () => {
    const e = { HOME_DERIVES_PER_DAY: '10' };
    await env.DB.prepare('INSERT INTO home_usage (day, derives) VALUES (?1, 6)').bind(today()).run();
    const owner = async () => {
      const sub = `owner-${uid()}`;
      const s = newScope();
      await hasRow(s, sub);
      return { sub, r: await derive(await body(s, SHARED, { sub }), undefined, { sub, env: e }) };
    };
    expect((await owner()).r.status).toBe(200);
    expect(await budgetEvents()).toEqual([]);
    const crossing = await owner();
    expect(crossing.r.status).toBe(200);
    expect((await owner()).r.status).toBe(200);
    const rows = await budgetEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.scope_id).toBeNull();
    expect(JSON.parse(rows[0]!.detail_json as string)).toEqual({ day: today(), derives: 8, ceiling: 10, thresholdPct: 80 });
    expect(rows[0]!.detail_json as string).not.toContain(crossing.sub);
    const listed = await adminRpc().securityEvents({ ...system(), unnotifiedOnly: false, limit: 500 });
    expect(listed.ok && listed.events.some((x) => x.kind === 'home_budget_high')).toBe(true);
  });

  it('a ceiling of 0 is a kill switch: nothing relayed, nothing counted', async () => {
    expect(homeDerivesPerDay({ HOME_DERIVES_PER_DAY: '0' })).toBe(0);
    const before = near.sent.length;
    const r = await derive(await body(scope, SHARED), undefined, { env: { HOME_DERIVES_PER_DAY: '0' } });
    expect(r.status).toBe(429);
    expect((await json(r)).code).toBe('home_busy');
    expect(near.sent.length).toBe(before);
    expect(await usage()).toBe(0);
    expect(await countHomeDerive(env, '2026-11-12', 0)).toBeNull();
    expect(await env.DB.prepare("SELECT derives FROM home_usage WHERE day = '2026-11-12'").first()).toBeNull();
  });

  it('parallel requests can’t pass a wallet’s window', async () => {
    const bodies = await Promise.all(Array.from({ length: 8 }, () => body(scope, SHARED)));
    const before = relays().length;
    const statuses = (await Promise.all(bodies.map((b) => derive(b)))).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 200, 429, 429, 429, 429, 429]);
    expect(relays().length).toBe(before + HOME_DERIVES_PER_PATH_HOUR);
    expect(await usage()).toBe(HOME_DERIVES_PER_PATH_HOUR);
  });

  it('parallel requests can’t pass the daily ceiling, and the refused ones spend nothing', async () => {
    const max = 2;
    const scopes = Array.from({ length: 6 }, (_, i) => `p${i}${uid()}`.toLowerCase().replace(/[^a-z0-9]/gu, '').slice(0, 60));
    for (const s of scopes) near.allowShared.add(s);
    fresh();
    const subs = scopes.map(() => `sub-${uid()}`);
    for (const [i, s] of scopes.entries()) await hasRow(s, subs[i]!);
    const bodies = await Promise.all(scopes.map((s, i) => body(s, SHARED, { sub: subs[i]! })));
    const before = relays().length;
    const results = await Promise.all(bodies.map((b, i) => derive(b, undefined, { sub: subs[i]!, env: { HOME_DERIVES_PER_DAY: String(max) } })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 429, 429, 429, 429]);
    expect(relays().length).toBe(before + max);
    expect(await usage()).toBe(max);
  });

  it('the default ceiling, a bad override, and the atomic count', async () => {
    expect(homeDerivesPerDay({})).toBe(HOME_DERIVES_PER_DAY_DEFAULT);
    expect(homeDerivesPerDay({ HOME_DERIVES_PER_DAY: 'lots' })).toBe(HOME_DERIVES_PER_DAY_DEFAULT);
    expect(homeDerivesPerDay({ HOME_DERIVES_PER_DAY: '42' })).toBe(42);
    const day = '2026-11-11';
    await env.DB.prepare('DELETE FROM home_usage WHERE day = ?1').bind(day).run();
    expect(await countHomeDerive(env, day, 2)).toBe(1);
    expect(await countHomeDerive(env, day, 2)).toBe(2);
    expect(await countHomeDerive(env, day, 2)).toBeNull();
    expect((await env.DB.prepare('SELECT derives FROM home_usage WHERE day = ?1').bind(day).first<{ derives: number }>())!.derives).toBe(2);
  });

  it('a limiter that can’t answer refuses (fail closed), and nothing is relayed', async () => {
    const before = near.sent.length;
    const spy = vi.spyOn(env.RATE_LIMITER, 'idFromName').mockImplementation(() => {
      throw new Error('no limiter');
    });
    const r = await derive(await body(scope, SHARED));
    spy.mockRestore();
    expect(r.status).toBe(503);
    expect((await json(r)).code).toBe('rate_limiter_unavailable');
    expect(near.sent.length).toBe(before);
  });
});

describe('Home shape and pool rules', () => {
  it('toHomeLogin takes /v1/login’s body plus scopeId, and refuses what a Home derive can’t carry', async () => {
    const now = Date.now();
    const b = (x: Record<string, unknown> = {}) => ({ scopeId: 's1', jwt: 'a.b.c', sessionPublicKey: new Array(32).fill(1), expiresAtMs: now + 10_000, salt: new Array(16).fill(1), keyIndex: 0, maxUses: 1, signature: new Array(64).fill(1), pk1: 'bls12381g1:x', pk2: 'bls12381g2:x', ...x });
    expect(toHomeLogin(b(), now)).toMatchObject({ scopeId: 's1', method: 'create_session_and_derive' });
    expect(toHomeLogin('x', now)).toEqual({ error: expect.any(String) });
    expect(toHomeLogin(b({ scopeId: undefined }), now)).toEqual({ error: expect.any(String) });
    expect(toHomeLogin(b({ keyIndex: 1 }), now)).toEqual({ error: 'A Home derive uses keyIndex 0' });
    expect(toHomeLogin(b({ maxUses: 5 }), now)).toEqual({ error: 'A Home derive uses maxUses 1' });
    expect(toHomeLogin(b({ linkImmediate: true }), now)).toEqual({ error: 'Unexpected field linkImmediate' });
    expect(toHomeLogin(b({ exportChain: 'evm' }), now)).toEqual({ error: 'Unexpected field exportChain' });
  });

  it('only an exit client in force reaches a scope through the exit route, never a stranger’s client; checkClientScope stays closed', async () => {
    near.exit = [EXIT];
    near.clients[OWN] = 'other';
    fresh();
    const e = env;
    expect(await checkHomeClientScope(e, 'google', EXIT, scope, Date.now())).toBeNull();
    near.missingScopes.add(scope);
    fresh();
    expect(await checkHomeClientScope(e, 'google', EXIT, scope, Date.now())).toMatchObject({ code: 'unknown_scope' });
    // A partner-held client is not an exit client: it stays bound to its scope.
    expect(await checkHomeClientScope(e, 'google', OWN, 'mine', Date.now())).toMatchObject({ code: 'scope_mismatch' });
  });

  it('the Home pool relays exactly create_session_and_derive, keyed by its own object name', () => {
    expect(POOL_METHODS.home).toEqual(['create_session_and_derive']);
    expect(POOL_SECRET.home).toBe('HOME_RELAYER_KEYS');
    expect(poolAllows('home', 'create_session_and_derive')).toBe(true);
    expect(poolAllows('home', 'derive_key')).toBe(false);
    expect(poolAllows('home', 'create_session')).toBe(false);
    expect(relayerKeyName('home', 0)).toBe('home-relayer-key-0');
    expect(relayerKeyName('session', 0)).toBe('relayer-key-0');
  });

  it('a preflight allows AUTH_ORIGIN only; GET is 405', async () => {
    const ok = await call(HOME_LOGIN_ENDPOINT, { method: 'OPTIONS', headers: { origin: AUTH } });
    expect(ok.status).toBe(204);
    const no = await call(HOME_LOGIN_ENDPOINT, { method: 'OPTIONS', headers: { origin: 'https://wallet.example.com' } });
    expect(no.status).toBe(403);
    expect((await call(HOME_LOGIN_ENDPOINT, { method: 'GET', headers: { origin: AUTH } })).status).toBe(405);
  });
});

describe('POST /v1/home/login: the usage event and who pays (H11; D461, D585, D586)', () => {
  const PARTNER = 'org_partnerH11';
  const HANA = 'org_hanaH11';
  /** A derive in `s` by another user, so no test here meets the per-wallet or per-user windows. */
  const deriveAs = async (s: string, sub: string, bindings?: Partial<typeof env>) => derive(await body(s, SHARED, { sub }), undefined, { sub, ...(bindings ? { env: bindings } : {}) });
  const homeEvents = (scopeId: string) => ledger.events.filter((e) => e.endpoint === 'home_login' && e.scope_id === scopeId);
  /** A scope of its own in the partner's org, with one app. */
  const partnerScope = async (o: { status?: string; suspendedBy?: number } = {}, second = false) => {
    const s = newScope();
    const app = await seedApp({ scope: s, ...o });
    // A second, running app in the same scope (seeded before the scope moves: a new app takes its scope's org).
    const other = second ? await seedApp({ scope: s }) : undefined;
    await env.DB.prepare('UPDATE scopes SET org_id = ?2 WHERE scope_id = ?1').bind(s, PARTNER).run();
    return { scope: s, app, other };
  };

  it('an active app: one event for the partner’s org, with the Home key and nonce that signed it, no app, no uid and nothing of the user', async () => {
    const { scope: s } = await partnerScope();
    const r = await derive(await body(s, SHARED), undefined, { env: { HANA_ORG_ID: HANA } });
    expect(r.status).toBe(200);
    const b = await json(r);
    const [e, ...rest] = homeEvents(s);
    expect(rest).toEqual([]);
    expect(usageEventV1.safeParse(e).success).toBe(true);
    expect(e).toMatchObject({ v: 1, request_id: b.requestId, endpoint: 'home_login', org_id: PARTNER, app_id: null, scope_id: s, outcome: 'ok', code: null, status: 200, relayed: true, near_tx: b.nearTx });
    // Signed by the Home pool's key, at the nonce the ledger records: what settlement and the nonce check hold it to.
    const tx = near.sent.at(-1)!;
    expect(homeKeys).toContain(e!.relayer_pk);
    expect(e!.relayer_pk).toBe(tx.publicKey);
    expect(e!.relayer_nonce).toMatch(/^[1-9]\d*$/u);
    expect(e!.uid).toBeUndefined();
    const text = JSON.stringify(e);
    expect(text).not.toContain(SUB);
    expect(text).not.toContain('#google#');
    expect(Object.keys(e!).sort()).toEqual(['app_id', 'at_ms', 'code', 'endpoint', 'latency_ms', 'near_tx', 'org_id', 'outcome', 'relay_gas_burnt', 'relay_tokens_burnt_yocto', 'relayed', 'relayer_nonce', 'relayer_pk', 'request_id', 'scope_id', 'status', 'v'].filter((k) => k in e!));
    // It is no app's event: nothing was recorded under the scope's app.
    expect(ledger.events.filter((x) => x.app_id !== null && x.scope_id === s)).toEqual([]);
  });

  it('Hana’s own org once the app is gone: a deleted app’s scope and a scope the hot DB doesn’t hold', async () => {
    const { scope: deleted, app } = await partnerScope();
    await env.DB.prepare('UPDATE apps SET deleted_at = ?2 WHERE id = ?1').bind(app.id, Date.now()).run();
    expect((await deriveAs(deleted, `g1-${uid()}`, { HANA_ORG_ID: HANA })).status).toBe(200);
    expect(homeEvents(deleted).map((e) => [e.org_id, e.app_id, e.outcome])).toEqual([[HANA, null, 'ok']]);

    const chainOnly = newScope();
    expect((await deriveAs(chainOnly, `g2-${uid()}`, { HANA_ORG_ID: HANA })).status).toBe(200);
    expect(homeEvents(chainOnly).map((e) => e.org_id)).toEqual([HANA]);

    // No HANA_ORG_ID in the env (or a malformed one): the legacy org, never the partner's.
    const other = await partnerScope();
    await env.DB.prepare('UPDATE apps SET deleted_at = ?2 WHERE id = ?1').bind(other.app.id, Date.now()).run();
    expect((await deriveAs(other.scope, `g3-${uid()}`)).status).toBe(200);
    expect(homeEvents(other.scope).map((e) => e.org_id)).toEqual(['org_legacy']);
    expect(hanaOrgId({ HANA_ORG_ID: 'not an org' })).toBe('org_legacy');
    expect(hanaOrgId({ HANA_ORG_ID: HANA })).toBe(HANA);
    expect(hanaOrgId({})).toBe('org_legacy');
  });

  it('a suspended app, by the single rule: Hana pays (HOME_PAYER.suspended); an app still running in the scope keeps it the partner’s', async () => {
    // The rule itself, in one table. Changing who pays for a suspended app is changing this line and this test.
    expect(HOME_PAYER).toEqual({ active: 'partner', suspended: 'hana', gone: 'hana' });

    for (const o of [{ status: 'suspended', suspendedBy: 1 }, { status: 'suspended', suspendedBy: 2 }, { status: 'suspended', suspendedBy: 4 }]) {
      const { scope: s } = await partnerScope(o);
      expect((await deriveAs(s, `s${o.suspendedBy}-${uid()}`, { HANA_ORG_ID: HANA })).status).toBe(200);
      expect(homeEvents(s).map((e) => e.org_id), JSON.stringify(o)).toEqual([HOME_PAYER.suspended === 'hana' ? HANA : PARTNER]);
    }
    // Two apps in one scope, one suspended and one running: the scope still has an active app.
    const mixed = await partnerScope({ status: 'suspended', suspendedBy: 1 }, true);
    expect((await deriveAs(mixed.scope, `mx-${uid()}`, { HANA_ORG_ID: HANA })).status).toBe(200);
    expect(homeEvents(mixed.scope).map((e) => e.org_id)).toEqual([PARTNER]);
    // A deleted app beside a suspended one doesn't count as running.
    const both = await partnerScope({ status: 'suspended', suspendedBy: 1 }, true);
    await env.DB.prepare('UPDATE apps SET deleted_at = ?2 WHERE id = ?1').bind(both.other!.id, Date.now()).run();
    expect((await deriveAs(both.scope, `bt-${uid()}`, { HANA_ORG_ID: HANA })).status).toBe(200);
    expect(homeEvents(both.scope).map((e) => e.org_id)).toEqual([HANA]);

    // The pure pieces: standing from the app counts, and the org from the rule.
    expect(homeScopeStanding(null)).toBe('gone');
    expect(homeScopeStanding({ live: 0, active: 0 })).toBe('gone');
    expect(homeScopeStanding({ live: 2, active: 0 })).toBe('suspended');
    expect(homeScopeStanding({ live: 2, active: 1 })).toBe('active');
    expect(homePayerOrg({ HANA_ORG_ID: HANA }, PARTNER, 'active')).toBe(PARTNER);
    expect(homePayerOrg({ HANA_ORG_ID: HANA }, PARTNER, 'suspended')).toBe(HANA);
    expect(homePayerOrg({ HANA_ORG_ID: HANA }, PARTNER, 'gone')).toBe(HANA);
    expect(homePayerOrg({ HANA_ORG_ID: HANA }, null, 'active')).toBe(HANA);
  });

  it('when the hot DB can’t say where the scope stands, Hana pays: a partner is never billed on a guess', async () => {
    const broken = { prepare: () => { throw new Error('D1 down'); } } as unknown as D1Database;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await homeBillingOrg({ DB: broken, HANA_ORG_ID: HANA }, 'anyscope', { requestId: 'req-billing-0001', endpoint: HOME_LOGIN_ENDPOINT })).toBe(HANA);
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('usage_org_unavailable');
  });

  it('a relay that ran and failed is one relayed event (rejected or error); a request refused before the relay writes none', async () => {
    const { scope: s } = await partnerScope();
    near.contract.create_session_and_derive = () => {
      throw new Error('some contract panic');
    };
    const rejected = await derive(await body(s, SHARED));
    expect(rejected.status).toBe(422);
    expect(homeEvents(s).map((e) => [e.org_id, e.outcome, e.code, e.status, e.relayed, typeof e.near_tx, homeKeys.includes(e.relayer_pk ?? '')])).toEqual([[PARTNER, 'rejected', 'contract_rejected', 422, true, 'string', true]]);

    // Refused before the relay: a bad shape and the kill switch.
    const before = ledger.events.length;
    const sent = near.sent.length;
    const bad = JSON.stringify({ scopeId: s });
    expect((await post(bad, (await newIdentity()).sign(bad))).status).toBe(400);
    expect((await deriveAs(s, `k-${uid()}`, { HOME_DERIVES_PER_DAY: '0' })).status).toBe(429);
    expect(near.sent.length).toBe(sent);
    expect(ledger.events.length).toBe(before);
    // A relay that never left (no key in the pool) is an event that isn't relayed: nothing to settle or explain.
    const noKey = await deriveAs(s, `u-${uid()}`, { HOME_RELAYER_KEYS: '[]' });
    expect(noKey.status).toBe(503);
    expect(ledger.events.slice(before).map((e) => [e.endpoint, e.outcome, e.code, e.relayed, e.near_tx])).toEqual([['home_login', 'error', 'relayer_unconfigured', false, undefined]]);
    // A wallet that was never opened, where links are open (D544): refused before the relay, no event.
    withEmail(near, [s]);
    fresh();
    expect((await deriveAs(s, `n-${uid()}`, emailEnv())).status).toBe(404);
    expect(near.sent.length).toBe(sent);
    expect(ledger.events.length).toBe(before + 1);
  });

  it('ckd_failed (the session was committed, no key came back) is a relayed event that isn’t ok: no Home login is counted for it', async () => {
    const { scope: s } = await partnerScope();
    withCombinedCall(near, { ckd: 'fail' });
    expect((await derive(await body(s, SHARED))).status).toBe(422);
    expect(homeEvents(s).map((e) => [e.outcome, e.code, e.relayed])).toEqual([['rejected', 'ckd_failed', true]]);
  });

  it('with usage capture off (no USAGE_DB, as on sandbox-dev) a derive answers the same and nothing is built, read or sent', async () => {
    const { scope: s } = await partnerScope();
    const prepared: string[] = [];
    const spy = vi.spyOn(env.DB, 'prepare');
    const off = await derive(await body(s, SHARED), undefined, { env: { USAGE_DB: undefined, HANA_ORG_ID: HANA } });
    for (const c of spy.mock.calls) prepared.push(String(c[0]));
    spy.mockRestore();
    expect(off.status).toBe(200);
    expect(ledger.calls).toEqual([]);
    expect(ledger.events).toEqual([]);
    // The rule's read never ran: who pays is only asked when an event is written.
    expect(prepared.filter((q) => q.includes('FROM scopes s WHERE s.scope_id'))).toEqual([]);

    // The same derive with capture on, for another user: the same answer's shape, and one event.
    const on = await deriveAs(s, `on-${uid()}`, { HANA_ORG_ID: HANA });
    expect(on.status).toBe(200);
    const strip = ({ requestId: _r, nearTx: _t, session: _s, supportId: _i, ...rest }: Record<string, unknown>) => rest;
    expect(strip(await json(on))).toEqual(strip(await json(off)));
    expect(homeEvents(s)).toHaveLength(1);
    // The failures with capture off are the same too, and write nothing.
    near.contract.create_session_and_derive = () => {
      throw new Error('some contract panic');
    };
    expect((await deriveAs(s, `off-${uid()}`, { USAGE_DB: undefined })).status).toBe(422);
    expect(homeEvents(s)).toHaveLength(1);
  });

  it('a ledger that refuses the event (0008 not applied yet) or can’t be reached never changes the answer', async () => {
    const { scope: s } = await partnerScope();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ledger.fail = () => new Error('connect ECONNREFUSED');
    const r = await derive(await body(s, SHARED));
    expect(r.status).toBe(200);
    expect((await json(r)).result).toEqual({ big_y: 'bls12381g1:Y', big_c: 'bls12381g1:C' });
    const lines = errors.mock.calls.map((c) => String(c[0])).join('\n');
    expect(lines).toContain('usage_write_failed');
    expect(lines).not.toContain(SUB);
  });

  it('AdminRpc.relayerKeys lists the Home pool’s public keys, tagged, beside the session and owner pools’ (readiness 7.4a)', async () => {
    const r = await adminRpc().relayerKeys({ ...system() });
    if (!r.ok) throw new Error('relayerKeys refused');
    const home = r.keys.filter((k) => k.pool === 'home').map((k) => k.publicKey);
    expect(home).toEqual(homeKeys);
    expect(home.length).toBeGreaterThan(0);
    expect(new Set(r.keys.map((k) => k.pool))).toEqual(new Set(['session', 'owner', 'home']));
    // Public keys only, and a Home key is no other pool's.
    for (const secret of parseRelayerKeys(env.HOME_RELAYER_KEYS, 'HOME_RELAYER_KEYS')) expect(JSON.stringify(r)).not.toContain(secret.slice(8, 30));
    expect(r.keys.filter((k) => k.pool !== 'home').map((k) => k.publicKey).filter((k) => homeKeys.includes(k))).toEqual([]);
    // An env with no Home key lists none.
    expect(relayerKeys({ ...env, HOME_RELAYER_KEYS: undefined }).some((k) => k.pool === 'home')).toBe(false);
    expect(relayerKeys(env).filter((k) => k.pool === 'home').map((k) => k.publicKey)).toEqual(homeKeys);
  });

  it('relayerKeys says whether usage capture is on, and GET /v1/health says it too (for deploy-check)', async () => {
    const r = await adminRpc().relayerKeys({ ...system() });
    if (!r.ok) throw new Error('relayerKeys refused');
    expect(r.capture).toBe(true);
    expect(r.unreadablePools).toEqual([]);
    expect(relayerPools({ ...env, USAGE_DB: undefined }).capture).toBe(false);
    expect((await json(await call('/v1/health'))).usageCapture).toBe(true);
    expect((await json(await call('/v1/health', { env: { USAGE_DB: undefined } }))).usageCapture).toBe(false);
  });

  it('a malformed pool secret loses only its own pool: the other pools’ keys are still listed, so their nonce check and settlement go on', async () => {
    const all = relayerPools(env);
    for (const [name, pool] of [['HOME_RELAYER_KEYS', 'home'], ['OWNER_RELAYER_KEYS', 'owner'], ['RELAYER_KEYS', 'session']] as const) {
      for (const bad of ['not json', '["ed25519:"]', '{"a":1}', '["ed25519:1111"]']) {
        const v = relayerPools({ ...env, [name]: bad });
        expect(v.unreadablePools, `${name}=${bad}`).toEqual([pool]);
        expect(v.keys).toEqual(all.keys.filter((k) => k.pool !== pool));
      }
    }
    // Nothing of a secret in the answer, readable or not.
    expect(JSON.stringify(relayerPools({ ...env, HOME_RELAYER_KEYS: 'not json' }))).not.toContain(parseRelayerKeys(env.RELAYER_KEYS, 'RELAYER_KEYS')[0]!.slice(8, 30));
  });

  it('one key in two pools is refused: neither pool lists a key or relays, and the third pool is untouched', async () => {
    const session = parseRelayerKeys(env.RELAYER_KEYS, 'RELAYER_KEYS');
    const dup = { RELAYER_KEYS: env.RELAYER_KEYS, OWNER_RELAYER_KEYS: env.OWNER_RELAYER_KEYS, HOME_RELAYER_KEYS: JSON.stringify([session[0]]) };
    expect(poolsSharingAKey(dup)).toEqual(['session', 'home']);
    expect(poolsSharingAKey(env)).toEqual([]);
    // A pool that doesn't parse shares nothing (it is refused on its own account).
    expect(poolsSharingAKey({ ...dup, HOME_RELAYER_KEYS: 'not json' })).toEqual([]);
    const v = relayerPools({ ...env, ...dup });
    expect(v.unreadablePools).toEqual(['session', 'home']);
    expect(v.keys.map((k) => k.pool)).toEqual(relayerKeys(env).filter((k) => k.pool === 'owner').map(() => 'owner'));
    // The relay refuses the pools involved before anything is signed.
    const before = near.sent.length;
    const r = await derive(await body(scope, SHARED), undefined, { env: dup });
    expect(r.status).toBe(503);
    expect((await json(r)).code).toBe('relayer_unconfigured');
    expect(near.sent.length).toBe(before);
    expect(() => relayerKeyCount({ ...env, ...dup }, 'session')).toThrow(/another pool/u);
    expect(relayerKeyCount({ ...env, ...dup }, 'owner')).toBeGreaterThan(0);
    expect(relayerKeyCount(env, 'home')).toBe(homeKeys.length);
  });
});

describe('migration 0018', () => {
  const noApp = (db: D1Database) =>
    db.prepare("INSERT INTO user_events (kind, app_id, scope_id, user_id, request_id, at) VALUES ('key_exported', NULL, 's1', ?1, 'r', 1)").bind(`hu_${'a'.repeat(26)}`).run();

  it('a key_exported row may have no app; a mainnet_signature row still may not', async () => {
    await noApp(env.DB);
    await expect(env.DB.prepare("INSERT INTO user_events (kind, app_id, scope_id, user_id, chain, network, address, usd_micros, request_id, at) VALUES ('mainnet_signature', NULL, 's1', ?1, 'evm', '8453', ?2, 1, 'r', 1)").bind(`hu_${'a'.repeat(26)}`, `0x${'1'.repeat(40)}`).run()).rejects.toThrow();
    await env.DB.prepare("DELETE FROM user_events WHERE app_id IS NULL AND scope_id = 's1'").run();
  });

  it('keeps every row, id and index through the rebuild, and home_usage refuses a malformed day', async () => {
    const db = env.PRE_0018_DB;
    const before = env.TEST_MIGRATIONS.filter((m) => m.name < '0018');
    await applyD1Migrations(db, before);
    await db
      .prepare("INSERT INTO user_events (id, kind, app_id, scope_id, user_id, chain, network, address, usd_micros, request_id, at) VALUES (7, 'mainnet_signature', 'app_x', 's1', ?1, 'evm', '8453', ?2, 5, 'rs', 11), (8, 'key_exported', 'app_y', 's2', ?1, 'stellar', NULL, NULL, NULL, 're', 12)")
      .bind(`hu_${'b'.repeat(26)}`, `0x${'a'.repeat(40)}`)
      .run();
    await db.prepare("INSERT INTO security_events (id, detected_at, kind, detail_json, notified_at) VALUES ('se1', 5, 'drift', '{}', 6)").run();
    await applyD1Migrations(db, env.TEST_MIGRATIONS.filter((m) => m.name.startsWith('0018')));
    expect(await db.prepare("SELECT id, kind, notified_at FROM security_events").all().then((r) => r.results)).toEqual([{ id: 'se1', kind: 'drift', notified_at: 6 }]);
    await db.prepare("INSERT INTO security_events (id, detected_at, kind, detail_json) VALUES ('se2', 7, 'home_budget_high', '{}')").run();
    await expect(db.prepare("INSERT INTO security_events (id, detected_at, kind, detail_json) VALUES ('se3', 7, 'nonsense', '{}')").run()).rejects.toThrow();
    await expect(db.prepare("INSERT INTO home_usage (day, derives, unrecorded) VALUES ('2026-01-01', 1, 2)").run()).rejects.toThrow();
    const rows = (await db.prepare('SELECT id, kind, app_id, scope_id, chain, usd_micros, request_id, at FROM user_events ORDER BY id').all<Record<string, unknown>>()).results;
    expect(rows).toEqual([
      { id: 7, kind: 'mainnet_signature', app_id: 'app_x', scope_id: 's1', chain: 'evm', usd_micros: 5, request_id: 'rs', at: 11 },
      { id: 8, kind: 'key_exported', app_id: 'app_y', scope_id: 's2', chain: 'stellar', usd_micros: null, request_id: 're', at: 12 },
    ]);
    const indexes = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'user_events' AND name LIKE 'user_events_%' ORDER BY name").all<{ name: string }>()).results.map((r) => r.name);
    expect(indexes).toEqual(['user_events_address', 'user_events_app', 'user_events_user']);
    await noApp(db);
    await expect(db.prepare("INSERT INTO home_usage (day, derives) VALUES ('today', 1)").run()).rejects.toThrow();
  });
});

describe('POST /v1/home/login: email (H10, D463, D485)', () => {
  /** A Home identity of email `sub` (the issuer's `hana-home` token over the Home nonce). */
  const emailIdentity = (sub: string) => newIdentity({ jwt: (nonce) => emailToken({ aud: HOME_EMAIL_AUDIENCE, sub, nonce }) });
  /** A Home derive body for `scopeId` whose session token is the issuer's for `aud`, of email `sub`. */
  async function emailBody(scopeId: string, aud: string, sub: string): Promise<Record<string, unknown>> {
    const b = await loginBody(scopeId, emailAud(scopeId), { maxUses: 1, expiresAtMs: Date.now() + 10 * 60_000 }, {}, appKey(3n));
    const nonce = await sessionNonce({ signer: env.SIGNER_ACCOUNT, scopeId, sessionPublicKey: b.sessionPublicKey as number[], expiresAtMs: b.expiresAtMs as number, keyIndex: 0, maxUses: 1, salt: b.salt as number[] });
    return { ...b, jwt: await emailToken({ aud, sub, nonce }), scopeId };
  }
  const named = (prefix: string) => `${prefix}${uid()}`.toLowerCase().replace(/[^a-z0-9]/gu, '').slice(0, 60);

  it('a Home identity token can never open a session: as the derive’s token its nonce commits to no session', async () => {
    const mail = named('eid');
    const e = withEmail(near, [mail]);
    e.exit = [['email', HOME_EMAIL_AUDIENCE]];
    fresh();
    const sub = `e1.${uid()}`;
    e.identities.set(`email#${sub}`, { status: 'own', opened: true });
    // The identity's own token (aud hana-home, nonce = homeNonce) put where the session token goes.
    let identityJwt = '';
    const home = await newIdentity({ jwt: async (nonce) => (identityJwt = await emailToken({ aud: HOME_EMAIL_AUDIENCE, sub, nonce })) });
    const b = { ...(await emailBody(mail, emailAud(mail), sub)), jwt: identityJwt };
    const before = relays().length;
    const r = await derive(b, home, { env: emailEnv() });
    expect(r.status).toBe(400);
    expect((await json(r)).code).toBe('nonce_mismatch');
    // A Google Home identity's token the same.
    let googleJwt = '';
    const gHome = await newIdentity({ jwt: async (nonce) => (googleJwt = await google.sign({ iss: GOOGLE_ISS, aud: SHARED, sub: SUB, nonce, exp: Math.floor(Date.now() / 1000) + 3600 })) });
    const rg = await derive({ ...(await body(scope, SHARED)), jwt: googleJwt }, gHome);
    expect(rg.status).toBe(400);
    expect((await json(rg)).code).toBe('nonce_mismatch');
    expect(relays().length).toBe(before);
  });

  it('the email exit token opens a session for its own user in a scope that dropped its email client, only while the exit is in force', async () => {
    // A registered scope with no email client (the owner removed it) and shared login off.
    const dropped = named('drp');
    near.clients[OWN] = dropped;
    const e = withEmail(near, []);
    e.exit = [['email', HOME_EMAIL_AUDIENCE]];
    near.contract.create_session_and_derive = () => ({ big_y: 'bls12381g1:Y', big_c: 'bls12381g1:C' });
    fresh();
    const sub = `e1.${uid()}`;
    e.identities.set(`email#${sub}`, { status: 'own', opened: true });
    const before = relays().length;
    const r = await derive(await emailBody(dropped, HOME_EMAIL_AUDIENCE, sub), await emailIdentity(sub), { env: emailEnv() });
    expect(r.status).toBe(200);
    expect(relays().length).toBe(before + 1);
    const tx = relays().at(-1)!;
    expect(tx.args.scope_id).toBe(dropped);
    expect(homeKeys).toContain(tx.publicKey);

    // Its own user only: another email user's Home identity can't use it.
    const other = `e1.${uid()}`;
    e.identities.set(`email#${other}`, { status: 'own', opened: true });
    const mismatch = await derive(await emailBody(dropped, HOME_EMAIL_AUDIENCE, sub), await emailIdentity(other), { env: emailEnv() });
    expect(mismatch.status).toBe(403);
    expect((await json(mismatch)).code).toBe('home_account_mismatch');
    // A Google Home identity whose id equals the email id is another account.
    const sameId = await derive(await emailBody(dropped, HOME_EMAIL_AUDIENCE, sub), await newIdentity({ sub }), { env: emailEnv() });
    expect(sameId.status).toBe(403);
    expect((await json(sameId)).code).toBe('home_account_mismatch');

    // Removed from the exit list: the identity isn't a Home identity any more (D494), and nothing is relayed.
    e.exit = [];
    fresh();
    const off = await derive(await emailBody(dropped, HOME_EMAIL_AUDIENCE, sub), await emailIdentity(sub), { env: emailEnv() });
    expect(off.status).toBe(401);
    expect((await json(off)).code).toBe('not_a_home_client');
    expect(relays().length).toBe(before + 1);
  });

  it('the exit token opens no scope through a partner login: checkClientScope stays closed to it', async () => {
    const e = withEmail(near, []);
    e.exit = [['email', HOME_EMAIL_AUDIENCE]];
    fresh();
    const closed = named('cls');
    near.clients[OWN] = closed;
    expect(await checkHomeClientScope(env, 'email', HOME_EMAIL_AUDIENCE, closed, Date.now())).toBeNull();
    expect(await checkClientScope(env, 'email', HOME_EMAIL_AUDIENCE, closed, Date.now())).not.toBeNull();
  });
});
