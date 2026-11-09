// POST /v1/home/login (docs/hana-home-spec.md "Tests", H3 of the build plan): a derive with no app gate. Every limit
// before the relay; a member's root path; a suspended, deleted and purged scope; nothing relayed on any failed check;
// the directory row (D500); `key_exported` with `chain` null and `app_id` NULL (D520); the Home pool; the exit client.
import { encodeHomeIdentity, HOME_EMAIL_AUDIENCE, homeMessage, homeNonce } from '@hana-id/core/home';
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { KeyPair, type KeyPairString } from '@near-js/crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOME_DERIVES_PER_DAY_DEFAULT, HOME_DERIVES_PER_PATH_HOUR, HOME_DERIVES_PER_USER_DAY, HOME_DERIVES_PER_USER_HOUR, HOME_LOGIN_ENDPOINT, HOME_LOGIN_PER_IP_HOUR, HOME_SESSION_MAX_MS, checkHomeClientScope, countHomeDerive, homeDerivesPerDay, toHomeLogin } from '../src/home/login.ts';
import { clearViewCaches } from '../src/views.ts';
import { clearLinkViewCaches } from '../src/link-views.ts';
import { sha256Hex } from '../src/owner-actions.ts';
import { parseRelayerKeys, POOL_METHODS, POOL_SECRET, poolAllows, relayerKeyName } from '../src/relayer-config.ts';
import { ckdPayload, sessionNonce } from '../src/session-crypto.ts';
import { emailAud, emailEnv, emailToken, withEmail, type EmailChain } from './email-helpers.ts';
import { GOOGLE_ISS, type Chain, call, chain, google, seedApp, signSession, uid } from './helpers.ts';
import { appKey, loginBody, withCombinedCall } from './login-helpers.ts';

const AUTH = env.AUTH_ORIGIN!;
const SHARED = 'shared-client.apps.googleusercontent.com';
const EXIT = 'hana-exit.apps.googleusercontent.com';
const OWN = 'partner-own.apps.googleusercontent.com';

const homeKeys = parseRelayerKeys(env.HOME_RELAYER_KEYS, 'HOME_RELAYER_KEYS').map((k) => KeyPair.fromString(k as KeyPairString).getPublicKey().toString());

interface Identity {
  sign: (body: string, counter?: number) => string;
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

const today = (): string => new Date().toISOString().slice(0, 10);
const usage = async (): Promise<number> => (await env.DB.prepare('SELECT derives FROM home_usage WHERE day = ?1').bind(today()).first<{ derives: number }>())?.derives ?? 0;
const events = async (scopeId: string) =>
  (await env.DB.prepare("SELECT kind, app_id, user_id, chain, request_id FROM user_events WHERE scope_id = ?1 AND kind = 'key_exported' ORDER BY id").bind(scopeId).all<Record<string, unknown>>()).results;
const relays = () => near.sent.filter((t) => t.method === 'create_session_and_derive');

beforeEach(async () => {
  SUB = `sub-${uid()}`;
  near = chain({}, { shared: [SHARED] });
  withCombinedCall(near, { ckd: 'ok' });
  scope = `s${uid()}`.toLowerCase().replace(/[^a-z0-9]/gu, '').slice(0, 60);
  near.allowShared.add(scope);
  near.install();
  await env.DB.exec('DELETE FROM home_usage');
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

  it('records key_exported with chain null, app_id NULL, the directory row, and leaves apps unlaunched (D462, D520)', async () => {
    const app = await seedApp({ scope, firstLogin: null, firstSession: null });
    const r = await derive(await body(scope, SHARED));
    expect(r.status).toBe(200);
    expect((await json(r)).supportId).toMatch(/^HANA-/u);
    const ev = await events(scope);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: 'key_exported', app_id: null, chain: null });
    expect(ev[0]!.user_id).toMatch(/^hu_/u);
    // The directory row, as /v1/login writes it (D500).
    const rows = (await env.DB.prepare('SELECT provider, sub, role, status FROM end_user_identities WHERE scope_id = ?1').bind(scope).all<Record<string, unknown>>()).results;
    expect(rows).toEqual([expect.objectContaining({ provider: 'google', sub: SUB, role: 'root', status: 'active' })]);
    // Nothing marked the app or the scope as launched, and no session marker.
    const a = await env.DB.prepare('SELECT first_login_at FROM apps WHERE id = ?1').bind(app.id).first<{ first_login_at: number | null }>();
    expect(a!.first_login_at).toBeNull();
    const s = await env.DB.prepare('SELECT first_session_at FROM scopes WHERE scope_id = ?1').bind(scope).first<{ first_session_at: number | null }>();
    expect(s!.first_session_at).toBeNull();
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM session_markers WHERE app_id = ?1').bind(app.id).first<{ n: number }>())!.n).toBe(0);
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

  it('per wallet: three an hour for one path, across the member and root (the path is the root’s)', async () => {
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
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(near.sent.length).toBe(before);
    expect(await usage()).toBe(max);
    // The user's windows were given back: per-user hour count is 0 again, so a fresh window accepts `max`.
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`home-user:${await sha256Hex(`google#${sub}`)}`));
    expect((await stub.hit([{ name: 'home:user:hour', windowMs: 3_600_000, max: 1 }])).ok).toBe(true);
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
    await applyD1Migrations(db, env.TEST_MIGRATIONS.filter((m) => m.name.startsWith('0018')));
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
