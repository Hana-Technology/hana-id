// Hana Home H9 (docs/hana-home-spec.md "Home: list and revoke", "Tests"): GET /v1/home/devices and the three stops. Only
// the signed-in identity's own rows, a member's through its root; another user's id is a 404 that changes nothing; a stop
// is what the vault's status read sees next (D465: auto-signing stops within about 10 s); a 'session'-mode logout reads
// as not active (D534); paging and bounds; every refusal; nothing identifying in a log line.
import { consentRegisterPayload, encodeHomeIdentity, HOME_EMAIL_AUDIENCE, homeMessage, homeNonce } from '@hana-id/core/home';
import { identitySub } from '@hana-id/core/identity';
import { policyId as computePolicyId } from '@hana-id/core/policy';
import { KeyPair } from '@near-js/crypto';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { base64Decode, base64UrlEncode, fromHex } from '../src/bytes.ts';
import { HOME_CONSENTS_PER_SCOPE, HOME_DEVICES_ENDPOINT, HOME_DEVICES_PAGE, HOME_DEVICES_PER_SCOPE, HOME_MEMBER_READS, HOME_MEMBER_READ_BATCH } from '../src/home/devices.ts';
import { HOME_REVOKE_ENDPOINTS, HOME_REVOKE_PER_KEY_MINUTE } from '../src/home/revoke.ts';
import { clearKekCache } from '../src/vault/kek.ts';
import { NO_SHARE_ID } from '../src/vault/message.ts';
import { clearViewCaches } from '../src/views.ts';
import { GOOGLE_ISS, ORIGIN, type Chain, type SeededApp, call, chain, google, seedApp, uid } from './helpers.ts';
import { emailEnv, emailToken, ikSync, withEmail } from './email-helpers.ts';
import { HOUR, VAULT, act, autoApprovePolicy, pathFor, pathHash, setSettings, setShare, signVault, spentSession, storedShare, vaultHeaders } from './vault-helpers.ts';

const AUTH = env.AUTH_ORIGIN!;
const SHARED = 'shared-client.apps.googleusercontent.com';
const SESSION_TTL = 12 * HOUR;
const POLICY = autoApprovePolicy('Swaps on Base');
const POLICY_ID = [...fromHex(computePolicyId(POLICY, { sessionTtlMs: SESSION_TTL }))];

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
  clearKekCache();
});

// ---- a Home identity ----

interface Identity {
  sub: string;
  send(method: 'GET' | 'POST', path: string, body?: unknown, init?: { ip?: string; origin?: string | null; env?: Partial<typeof env> }): Promise<Response>;
}

/**
 * A signed-in Home identity. Default: Google through the shared client. `aud`: another Google client (the exit client);
 * `email`: an email sign-in (H10: the issuer's Home audience), whose requests carry the issuer's keys in the env.
 */
async function home(sub = `${Date.now()}${Math.floor(Math.random() * 1e6)}`, o: { aud?: string; email?: boolean } = {}): Promise<Identity> {
  const kp = KeyPair.fromRandom('ed25519');
  const pub = Uint8Array.from(kp.getPublicKey().data);
  const expiresAtMs = Date.now() + 15 * 60_000;
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const nonce = homeNonce({ signer: env.SIGNER_ACCOUNT, homePublicKey: pub, expiresAtMs, salt });
  const jwt = o.email ? await emailToken({ aud: HOME_EMAIL_AUDIENCE, sub, nonce }) : await google.sign({ iss: GOOGLE_ISS, aud: o.aud ?? SHARED, sub, nonce, exp: Math.floor(Date.now() / 1000) + 3600 });
  const baseEnv = o.email ? emailEnv() : undefined;
  return {
    sub,
    async send(method, path, body, init = {}) {
      if (baseEnv) init = { ...init, env: { ...baseEnv, ...init.env } };
      const bytes = body === undefined ? new Uint8Array(0) : new TextEncoder().encode(JSON.stringify(body));
      const c = ++counter;
      const sig = kp.sign(homeMessage({ signer: env.SIGNER_ACCOUNT, counter: c, method, path, body: bytes })).signature;
      const headers: Record<string, string> = {
        'x-hana-home': encodeHomeIdentity({ jwt, key: pub, expiresAtMs, salt, counter: c, sig: Uint8Array.from(sig) }),
        'cf-connecting-ip': init.ip ?? `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      };
      const origin = init.origin === undefined ? AUTH : init.origin;
      if (origin !== null) headers.origin = origin;
      return call(path, { method, headers, ...(body === undefined ? {} : { rawBody: new TextDecoder().decode(bytes) }), ...(init.env ? { env: init.env } : {}) });
    },
  };
}

interface Device {
  shareId: string;
  appId: string;
  partnerOrigin: string;
  label: string | null;
  signedInAtMs: number;
  lastUsedAtMs: number | null;
  idleUntilMs: number;
  expiresAtMs: number;
  consent: { consentId: string; label: string; grantedAtMs: number; expiresAtMs: number } | null;
}
interface ScopeAnswer {
  scopeId: string;
  apps: { appId: string; name: string; status: string }[];
  devices: Device[];
  consents: { consentId: string; appId: string; partnerOrigin: string; label: string }[];
  email: { appId: string; addresses: string[] }[] | null;
  more: boolean;
  canStop: boolean;
}
interface DevicesAnswer {
  scopes: ScopeAnswer[];
  nextCursor: string | null;
}

async function devices(id: Identity, query = ''): Promise<DevicesAnswer> {
  const res = await id.send('GET', `${HOME_DEVICES_ENDPOINT}${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as DevicesAnswer;
}
const ofScope = async (id: Identity, scope: string): Promise<ScopeAnswer> => (await devices(id, `?scopeId=${scope}`)).scopes[0] as ScopeAnswer;

const stop = (id: Identity, what: keyof typeof HOME_REVOKE_ENDPOINTS, body: unknown, init?: { ip?: string }) => id.send('POST', HOME_REVOKE_ENDPOINTS[what], body, init);

async function expectCode(res: Response, status: number, code: string): Promise<Record<string, unknown>> {
  const body = (await res.json()) as Record<string, unknown>;
  expect({ status: res.status, code: body.code }).toEqual({ status, code });
  return body;
}

// ---- the vault's side: shares and consents, through the real endpoints ----

async function policyApp(o: Parameters<typeof seedApp>[0] = {}): Promise<SeededApp> {
  const app = await seedApp(o);
  await setSettings(app.id, { auto_approve_policy: JSON.stringify(POLICY) });
  return app;
}

/** A device signed in as `sub` with a share, optionally its label, and optionally an auto-approve consent. */
async function device(app: SeededApp, sub: string, o: { consent?: boolean; label?: string; provider?: string } = {}): Promise<{ shareId: number[]; spk: number[]; consentId: number[] | null }> {
  const spk = spentSession(near, app.scope, { sub });
  // Another login method's session: the same path layout with its provider (`{scope}#email#{sub}#0`).
  if (o.provider) near.sessions.get(JSON.stringify(spk))!.path = `${app.scope}#${o.provider}#${sub}#0`;
  const signature = await signVault(spk, app.id, NO_SHARE_ID, 0, (await import('../src/vault/message.ts')).createSharePayload(ORIGIN));
  const res = await call('/v1/vault/shares', { headers: vaultHeaders(app), body: { sessionPublicKey: spk, signature, ...(o.label ? { deviceLabel: o.label } : {}) } });
  expect(res.status).toBe(201);
  const { shareId } = (await res.json()) as { shareId: number[] };
  if (!o.consent) return { shareId, spk, consentId: null };
  return { shareId, spk, consentId: await registerConsent(app, spk, shareId) };
}

async function registerConsent(app: SeededApp, spk: number[], shareId: number[] | null): Promise<number[]> {
  const consentId = [...crypto.getRandomValues(new Uint8Array(16))];
  const expiresAtMs = Date.now() + HOUR;
  const counter = shareId ? 1 : 0;
  const payload = consentRegisterPayload({ consentId: Uint8Array.from(consentId), policyId: Uint8Array.from(POLICY_ID), expiresAtMs, parentOrigin: ORIGIN });
  const signature = await signVault(spk, app.id, shareId ? Uint8Array.from(shareId) : NO_SHARE_ID, counter, payload);
  const res = await call('/v1/vault/consents', { headers: vaultHeaders(app), body: { ...(shareId ? { shareId } : {}), sessionPublicKey: spk, counter, signature, consentId, policyId: POLICY_ID, expiresAtMs } });
  expect(res.status).toBe(201);
  return consentId;
}

/** The vault's status read (GET /v1/app with `x-hana-consent`), the read an open tab makes before an auto-signature. */
async function vaultSees(app: SeededApp, consentId: number[]): Promise<unknown> {
  near.clients[`client-${app.scope}`] = app.scope;
  const res = await call('/v1/app', { method: 'GET', headers: { 'x-hana-key': app.key, origin: VAULT, 'x-hana-parent-origin': ORIGIN, 'x-hana-consent': base64UrlEncode(Uint8Array.from(consentId)) } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { consent?: unknown }).consent;
}

const b64 = (v: number[]): string => base64UrlEncode(Uint8Array.from(v));
const consentRow = (consentId: number[]) => env.DB.prepare('SELECT revoked_at, revoked_by FROM vault_consents WHERE consent_id = ?1').bind(Uint8Array.from(consentId)).first<{ revoked_at: number | null; revoked_by: string | null }>();

// ---- the directory (migration 0011's rows) ----

const hex64 = (): string => [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
const b36 = (n: number): string => Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
const userSubKey = (): Uint8Array => base64Decode(env.IDENTITY_SUB_KEY!);

/**
 * An account in `scope` rooted at `root`, with `members` (each `[sub, status]`), in the directory and on chain. `stale`:
 * a member the directory still holds `active` but the chain no longer links (an unlink whose sync failed). Returns its
 * User ID.
 */
async function account(scope: string, root: string, members: [string, 'active' | 'pending' | 'unlinked' | 'stale'][] = []): Promise<string> {
  for (const [sub, status] of members) if (status === 'active' || status === 'pending') onChain.set(sub, { root, status: status === 'active' ? 'member' : 'pending' });
  const now = Date.now();
  const userId = `hu_${b36(26)}`;
  const tokenSub = identitySub(userSubKey(), scope, { provider: 'google', sub: root });
  await env.DB.prepare('INSERT INTO end_users (user_id, token_sub, support_code, scope_id, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)').bind(userId, tokenSub, 'ABCDEFGH', scope, now).run();
  const identity = (sub: string, role: string, status: string) =>
    env.DB.prepare('INSERT INTO end_user_identities (scope_id, identity_key, user_id, provider, sub, role, status, effective_at, first_seen_at, observed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?8)')
      .bind(scope, hex64(), userId, 'google', sub, role, status, now)
      .run();
  await identity(root, 'root', 'active');
  for (const [sub, status] of members) await identity(sub, 'member', status === 'stale' ? 'active' : status);
  return tokenSub;
}

const shareEmail = (app: SeededApp, userSub: string, email: string, state: 'granted' | 'declined' = 'granted') =>
  env.DB.prepare('INSERT INTO email_consents (app_id, user_sub, email_mac, state, email, scope_id, decided_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
    .bind(app.id, userSub, crypto.getRandomValues(new Uint8Array(32)), state, state === 'granted' ? email : null, app.scope, Date.now())
    .run();
const emailRows = (app: SeededApp, userSub: string) => env.DB.prepare('SELECT state, email FROM email_consents WHERE app_id = ?1 AND user_sub = ?2').bind(app.id, userSub).all<{ state: string; email: string | null }>();

// ---- GET /v1/home/devices ----

describe('GET /v1/home/devices', () => {
  it('lists the user’s live devices with their label, origin and times, and each one’s auto-approve consent with its label', async () => {
    const app = await policyApp();
    const me = await home();
    const a = await device(app, me.sub, { consent: true, label: 'Chrome on macOS' });
    const b = await device(app, me.sub);
    const s = await ofScope(me, app.scope);
    expect(s.devices.map((d) => d.shareId).sort()).toEqual([b64(a.shareId), b64(b.shareId)].sort());
    const da = s.devices.find((d) => d.shareId === b64(a.shareId))!;
    expect(da).toMatchObject({ appId: app.id, partnerOrigin: ORIGIN, label: 'Chrome on macOS', consent: { consentId: b64(a.consentId!), label: 'Swaps on Base' } });
    expect(da.signedInAtMs).toBeLessThanOrEqual(Date.now());
    expect(da.expiresAtMs).toBeGreaterThan(Date.now());
    expect(da.lastUsedAtMs).toBe(da.signedInAtMs);
    expect(s.devices.find((d) => d.shareId === b64(b.shareId))).toMatchObject({ label: null, consent: null });
    expect(s.apps).toEqual([{ appId: app.id, name: `Test ${app.id}`, status: 'active' }]);
    expect(s.consents).toEqual([]);
    expect(s.more).toBe(false);
  });

  it('another user’s devices in the same app never show, in any way of asking', async () => {
    const app = await policyApp();
    const me = await home();
    const other = await home();
    await device(app, other.sub, { consent: true, label: 'Firefox on Linux' });
    await account(app.scope, other.sub);
    expect((await ofScope(me, app.scope)).devices).toEqual([]);
    expect((await devices(me)).scopes).toEqual([]);
    expect((await ofScope(other, app.scope)).devices).toHaveLength(1);
    expect((await devices(other)).scopes.map((x) => x.scopeId)).toEqual([app.scope]);
  });

  it('a session-mode logout (the share revoked by the device) reads as not active, though the consent’s revoked_at stays NULL (D534)', async () => {
    const app = await policyApp();
    const me = await home();
    const d = await device(app, me.sub, { consent: true });
    expect((await act(app, { spk: d.spk, shareId: d.shareId }, 'revoke', 2)).status).toBe(200);
    expect((await consentRow(d.consentId!))!.revoked_at).toBeNull();
    const s = await ofScope(me, app.scope);
    expect(s.devices).toEqual([]);
    expect(s.consents).toEqual([]);
    expect(await vaultSees(app, d.consentId!)).toBe('revoked');
  });

  it('a share past its idle limit, its end, or under an origin the app removed is not listed; nor is its consent', async () => {
    const app = await policyApp();
    const me = await home();
    const idle = await device(app, me.sub, { consent: true });
    const ended = await device(app, me.sub, { consent: true });
    await setShare(idle.shareId, { idle_until: Date.now() - 1 });
    await setShare(ended.shareId, { abs_expires_at: Date.now() - 1 });
    expect((await ofScope(me, app.scope)).devices).toEqual([]);
    const live = await device(app, me.sub, { consent: true });
    expect((await ofScope(me, app.scope)).devices).toHaveLength(1);
    await env.DB.prepare('DELETE FROM app_origins WHERE app_id = ?1').bind(app.id).run();
    const { forgetCachedApps } = await import('../src/app-cache.ts');
    forgetCachedApps();
    expect((await ofScope(me, app.scope)).devices).toEqual([]);
    // The vault can't read it either: its gate refuses the parent now, so no fresh 'active' and no auto-signature.
    const res = await call('/v1/app', { method: 'GET', headers: { 'x-hana-key': app.key, origin: VAULT, 'x-hana-parent-origin': ORIGIN, 'x-hana-consent': b64(live.consentId!) } });
    expect(res.status).toBe(403);
  });

  it('an app that stopped keeping logins shows no device', async () => {
    const app = await policyApp();
    const me = await home();
    await device(app, me.sub, { consent: true });
    await setSettings(app.id, { persistence: 'none' });
    expect((await ofScope(me, app.scope)).devices).toEqual([]);
  });

  it('an app with no share (persistence none): its consent is listed on its own', async () => {
    const app = await policyApp();
    await setSettings(app.id, { persistence: 'none' });
    const me = await home();
    const spk = spentSession(near, app.scope, { sub: me.sub });
    const consentId = await registerConsent(app, spk, null);
    const s = await ofScope(me, app.scope);
    expect(s.devices).toEqual([]);
    expect(s.consents).toEqual([{ consentId: b64(consentId), appId: app.id, partnerOrigin: ORIGIN, label: 'Swaps on Base', grantedAtMs: expect.any(Number), expiresAtMs: expect.any(Number) }]);
  });

  it('a linked member sees its account root’s devices; a pending or unlinked member doesn’t', async () => {
    const app = await policyApp();
    const root = await home();
    const member = await home();
    const pending = await home();
    const gone = await home();
    await account(app.scope, root.sub, [
      [member.sub, 'active'],
      [pending.sub, 'pending'],
      [gone.sub, 'unlinked'],
    ]);
    const d = await device(app, root.sub, { consent: true });
    expect((await ofScope(member, app.scope)).devices.map((x) => x.shareId)).toEqual([b64(d.shareId)]);
    expect((await devices(member)).scopes[0]!.devices.map((x) => x.shareId)).toEqual([b64(d.shareId)]);
    expect((await ofScope(pending, app.scope)).devices).toEqual([]);
    expect((await ofScope(gone, app.scope)).devices).toEqual([]);
  });

  it('no parameter: the user’s own scopes from the directory, a page at a time, in scope order', async () => {
    const me = await home();
    const scopes: string[] = [];
    for (let i = 0; i < HOME_DEVICES_PAGE + 2; i++) {
      const app = await policyApp();
      await account(app.scope, me.sub);
      scopes.push(app.scope);
    }
    scopes.sort();
    const first = await devices(me);
    expect(first.scopes.map((s) => s.scopeId)).toEqual(scopes.slice(0, HOME_DEVICES_PAGE));
    expect(first.nextCursor).toBe(scopes[HOME_DEVICES_PAGE - 1]);
    const second = await devices(me, `?cursor=${first.nextCursor}`);
    expect(second.scopes.map((s) => s.scopeId)).toEqual(scopes.slice(HOME_DEVICES_PAGE));
    expect(second.nextCursor).toBeNull();
  });

  it(`at most ${HOME_DEVICES_PER_SCOPE} devices a scope, the most recent, with more: true`, async () => {
    const app = await policyApp();
    const me = await home();
    for (let i = 0; i < HOME_DEVICES_PER_SCOPE + 1; i++) await device(app, me.sub);
    const s = await ofScope(me, app.scope);
    expect(s.devices).toHaveLength(HOME_DEVICES_PER_SCOPE);
    expect(s.more).toBe(true);
  });

  it('lists the addresses the account shares with each app; a declined one is not shared', async () => {
    const app = await policyApp();
    const other = await seedApp({ scope: app.scope });
    const me = await home();
    const userSub = await account(app.scope, me.sub);
    await shareEmail(app, userSub, 'ada@example.com');
    await shareEmail(other, userSub, 'ada@work.example', 'declined');
    const s = await ofScope(me, app.scope);
    expect(s.email).toEqual([{ appId: app.id, addresses: ['ada@example.com'] }]);
    expect(s.apps.map((a) => a.appId)).toEqual([app.id]);
  });

  it('email sharing is unknown (null) without IDENTITY_SUB_KEY for a user the directory doesn’t hold, and its stop is 503', async () => {
    const app = await policyApp();
    const me = await home();
    const res = await me.send('GET', `${HOME_DEVICES_ENDPOINT}?scopeId=${app.scope}`, undefined, { env: { IDENTITY_SUB_KEY: undefined } });
    expect(((await res.json()) as DevicesAnswer).scopes[0]!.email).toBeNull();
    expect((await ofScope(me, app.scope)).email).toEqual([]);
    await expectCode(await me.send('POST', HOME_REVOKE_ENDPOINTS.email, { appId: app.id }, { env: { IDENTITY_SUB_KEY: undefined } }), 503, 'email_sharing_unavailable');
  });

  it('a malformed or doubled query is 400; a scope with nothing of this user’s is an empty answer', async () => {
    const me = await home();
    for (const q of ['?scopeId=A!', '?cursor=UPPER', '?scopeId=a&cursor=b', '?appId=app_x']) await expectCode(await me.send('GET', `${HOME_DEVICES_ENDPOINT}${q}`), 400, 'bad_request');
    expect(await ofScope(me, 'nosuchscope')).toMatchObject({ scopeId: 'nosuchscope', devices: [], consents: [], apps: [] });
  });

  it('refuses without the Home identity or from another origin', async () => {
    const me = await home();
    await expectCode(await call(HOME_DEVICES_ENDPOINT, { method: 'GET', headers: { origin: AUTH } }), 401, 'missing_home_identity');
    await expectCode(await me.send('GET', HOME_DEVICES_ENDPOINT, undefined, { origin: 'https://partner.example' }), 403, 'origin_not_allowed');
  });

  it('a D1 failure is 503, never a partial list', async () => {
    const me = await home();
    const app = await policyApp();
    await account(app.scope, me.sub);
    vi.spyOn(env.DB, 'batch').mockRejectedValueOnce(new Error('D1 down'));
    await expectCode(await me.send('GET', HOME_DEVICES_ENDPOINT), 503, 'home_directory_unavailable');
  });

  it('reads no chain and relays nothing', async () => {
    const app = await policyApp();
    const me = await home();
    await device(app, me.sub, { consent: true });
    const before = near.viewCalls.length;
    await ofScope(me, app.scope);
    expect(near.viewCalls.slice(before).filter((c) => c.method !== 'get_config')).toEqual([]);
    expect(near.sent).toHaveLength(0);
  });
});

// ---- the stops ----

describe('POST /v1/home/consents/revoke', () => {
  it('stops the user’s own consent; the vault’s next status read says revoked, so auto-signing stops within about 10 s (D465)', async () => {
    const app = await policyApp();
    const me = await home();
    const d = await device(app, me.sub, { consent: true });
    expect(await vaultSees(app, d.consentId!)).toBe('active');
    const res = await stop(me, 'consent', { consentId: b64(d.consentId!) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ revoked: true });
    expect(await consentRow(d.consentId!)).toMatchObject({ revoked_by: 'home', revoked_at: expect.any(Number) });
    expect(await vaultSees(app, d.consentId!)).toBe('revoked');
    // The device stays signed in; only the consent is gone from the list.
    const s = await ofScope(me, app.scope);
    expect(s.devices).toHaveLength(1);
    expect(s.devices[0]!.consent).toBeNull();
    // A repeat changes nothing.
    expect(await (await stop(me, 'consent', { consentId: b64(d.consentId!) })).json()).toMatchObject({ revoked: false });
  });

  it('another user’s consent id is 404, the same as an unknown one, and changes nothing', async () => {
    const app = await policyApp();
    const me = await home();
    const other = await home();
    const theirs = await device(app, other.sub, { consent: true });
    const a = await expectCode(await stop(me, 'consent', { consentId: b64(theirs.consentId!) }), 404, 'unknown_consent');
    const b = await expectCode(await stop(me, 'consent', { consentId: b64([...crypto.getRandomValues(new Uint8Array(16))]) }), 404, 'unknown_consent');
    expect(a.error).toBe(b.error);
    expect((await consentRow(theirs.consentId!))!.revoked_at).toBeNull();
    expect(await vaultSees(app, theirs.consentId!)).toBe('active');
  });

  it('a linked member stops its root’s consent; a pending member gets 404', async () => {
    const app = await policyApp();
    const root = await home();
    const member = await home();
    const pending = await home();
    await account(app.scope, root.sub, [
      [member.sub, 'active'],
      [pending.sub, 'pending'],
    ]);
    const d = await device(app, root.sub, { consent: true });
    await expectCode(await stop(pending, 'consent', { consentId: b64(d.consentId!) }), 404, 'unknown_consent');
    expect((await stop(member, 'consent', { consentId: b64(d.consentId!) })).status).toBe(200);
    expect(await vaultSees(app, d.consentId!)).toBe('revoked');
  });

  it('stops a consent of an app with no share', async () => {
    const app = await policyApp();
    await setSettings(app.id, { persistence: 'none' });
    const me = await home();
    const consentId = await registerConsent(app, spentSession(near, app.scope, { sub: me.sub }), null);
    expect((await stop(me, 'consent', { consentId: b64(consentId) })).status).toBe(200);
    expect(await vaultSees(app, consentId)).toBe('revoked');
    expect((await ofScope(me, app.scope)).consents).toEqual([]);
  });
});

describe('POST /v1/home/shares/revoke ("Sign out this device")', () => {
  it('ends the user’s own share and its consent: the status read says revoked, and the device’s next touch is 410', async () => {
    const app = await policyApp();
    const me = await home();
    const d = await device(app, me.sub, { consent: true });
    const res = await stop(me, 'share', { shareId: b64(d.shareId) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ revoked: true });
    expect((await storedShare(d.shareId))!.revoked_at).not.toBeNull();
    expect(await consentRow(d.consentId!)).toMatchObject({ revoked_by: 'share' });
    expect(await vaultSees(app, d.consentId!)).toBe('revoked');
    await expectCode(await act(app, { spk: d.spk, shareId: d.shareId }, 'touch', 2), 410, 'share_revoked');
    expect((await ofScope(me, app.scope)).devices).toEqual([]);
    expect(await (await stop(me, 'share', { shareId: b64(d.shareId) })).json()).toMatchObject({ revoked: false });
  });

  it('another user’s share id is 404 and changes nothing; the other device keeps signing', async () => {
    const app = await policyApp();
    const me = await home();
    const other = await home();
    const theirs = await device(app, other.sub, { consent: true });
    await expectCode(await stop(me, 'share', { shareId: b64(theirs.shareId) }), 404, 'unknown_share');
    await expectCode(await stop(me, 'share', { shareId: b64([...crypto.getRandomValues(new Uint8Array(16))]) }), 404, 'unknown_share');
    expect((await storedShare(theirs.shareId))!.revoked_at).toBeNull();
    expect(await vaultSees(app, theirs.consentId!)).toBe('active');
  });

  it('a linked member signs out its root’s device', async () => {
    const app = await policyApp();
    const root = await home();
    const member = await home();
    await account(app.scope, root.sub, [[member.sub, 'active']]);
    const d = await device(app, root.sub);
    expect((await stop(member, 'share', { shareId: b64(d.shareId) })).status).toBe(200);
    expect((await storedShare(d.shareId))!.revoked_at).not.toBeNull();
  });

  it('works while the contract is paused: stopping never waits on an incident', async () => {
    const app = await policyApp();
    const me = await home();
    const d = await device(app, me.sub);
    near.paused = true;
    clearViewCaches();
    expect((await stop(me, 'share', { shareId: b64(d.shareId) })).status).toBe(200);
  });
});

describe('POST /v1/home/email-sharing/revoke', () => {
  it('stops sharing every address of the account with that app, and only that app', async () => {
    const app = await policyApp();
    const sibling = await seedApp({ scope: app.scope });
    const me = await home();
    const userSub = await account(app.scope, me.sub);
    await shareEmail(app, userSub, 'ada@example.com');
    await shareEmail(app, userSub, 'ada@work.example');
    await shareEmail(sibling, userSub, 'ada@example.com');
    const res = await stop(me, 'email', { appId: app.id });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: 'declined', revoked: 2 });
    expect((await emailRows(app, userSub)).results).toEqual([
      { state: 'declined', email: null },
      { state: 'declined', email: null },
    ]);
    expect((await emailRows(sibling, userSub)).results).toEqual([{ state: 'granted', email: 'ada@example.com' }]);
    expect((await ofScope(me, app.scope)).email).toEqual([{ appId: sibling.id, addresses: ['ada@example.com'] }]);
    // A repeat: nothing shared any more, nothing changes.
    expect(await (await stop(me, 'email', { appId: app.id })).json()).toMatchObject({ revoked: 0 });
  });

  it('a member stops its account’s sharing; another user’s sharing is untouched and reads 404 for this user', async () => {
    const app = await policyApp();
    const root = await home();
    const member = await home();
    const stranger = await home();
    const userSub = await account(app.scope, root.sub, [[member.sub, 'active']]);
    await shareEmail(app, userSub, 'ada@example.com');
    await expectCode(await stop(stranger, 'email', { appId: app.id }), 404, 'unknown_email_share');
    expect((await emailRows(app, userSub)).results).toEqual([{ state: 'granted', email: 'ada@example.com' }]);
    expect((await stop(member, 'email', { appId: app.id })).status).toBe(200);
    expect((await emailRows(app, userSub)).results).toEqual([{ state: 'declined', email: null }]);
  });

  it('an unknown app is 404 with the same answer', async () => {
    const me = await home();
    const a = await expectCode(await stop(me, 'email', { appId: 'app_nosuchapp' }), 404, 'unknown_email_share');
    expect(a.error).toBe('Nothing shared with this app');
  });

  it('works for an unlinked user Hana has no directory row for, from the User ID it computes', async () => {
    const app = await policyApp();
    const me = await home();
    const userSub = identitySub(userSubKey(), app.scope, { provider: 'google', sub: me.sub });
    await shareEmail(app, userSub, 'ada@example.com');
    expect((await ofScope(me, app.scope)).email).toEqual([{ appId: app.id, addresses: ['ada@example.com'] }]);
    expect((await stop(me, 'email', { appId: app.id })).status).toBe(200);
  });
});

describe('a stale directory row (D661): an unlink whose sync failed', () => {
  it('a removed login the directory still holds active gets no addresses and no stops: the chain says it is its own now', async () => {
    const app = await policyApp();
    const root = await home();
    const removed = await home();
    const userSub = await account(app.scope, root.sub, [[removed.sub, 'stale']]);
    await shareEmail(app, userSub, 'ada@example.com');
    const d = await device(app, root.sub, { consent: true });
    // The chain contradicts the row: the list is the removed login's own (nothing), never the account's.
    for (const s of [await ofScope(removed, app.scope), (await devices(removed)).scopes[0]!]) {
      expect(s.devices).toEqual([]);
      expect(s.email).toEqual([]);
    }
    await expectCode(await stop(removed, 'share', { shareId: b64(d.shareId) }), 404, 'unknown_share');
    await expectCode(await stop(removed, 'consent', { consentId: b64(d.consentId!) }), 404, 'unknown_consent');
    await expectCode(await stop(removed, 'email', { appId: app.id }), 404, 'unknown_email_share');
    expect((await storedShare(d.shareId))!.revoked_at).toBeNull();
    expect((await emailRows(app, userSub)).results).toEqual([{ state: 'granted', email: 'ada@example.com' }]);
  });

  it('a genuine member, confirmed on chain, gets its account’s addresses and stops (one get_identity a member scope)', async () => {
    const app = await policyApp();
    const root = await home();
    const member = await home();
    const userSub = await account(app.scope, root.sub, [[member.sub, 'active']]);
    await shareEmail(app, userSub, 'ada@example.com');
    await device(app, root.sub);
    const reads = () => near.viewCalls.filter((c) => c.method === 'get_identity').length;
    const before = reads();
    const s = await ofScope(member, app.scope);
    expect(reads() - before).toBe(1);
    expect(s).toMatchObject({ canStop: true, email: [{ appId: app.id, addresses: ['ada@example.com'] }] });
    expect(s.devices).toHaveLength(1);
    // The root itself reads no chain.
    const after = reads();
    await ofScope(root, app.scope);
    expect(reads()).toBe(after);
  });

  it('the chain read failing fails closed: devices listed, no addresses, no stops; a stop answers a retryable 503 and writes nothing', async () => {
    const app = await policyApp();
    const root = await home();
    const member = await home();
    const userSub = await account(app.scope, root.sub, [[member.sub, 'active']]);
    await shareEmail(app, userSub, 'ada@example.com');
    const d = await device(app, root.sub, { consent: true });
    identityDown = true;
    const s = await ofScope(member, app.scope);
    expect(s).toMatchObject({ canStop: false, email: null });
    expect(s.devices).toHaveLength(1);
    for (const [what, body] of [
      ['share', { shareId: b64(d.shareId) }],
      ['consent', { consentId: b64(d.consentId!) }],
      ['email', { appId: app.id }],
    ] as const) {
      const res = await stop(member, what, body);
      expect(res.headers.get('retry-after')).toBe('2');
      await expectCode(res, 503, 'near_unavailable');
    }
    expect((await storedShare(d.shareId))!.revoked_at).toBeNull();
    expect(await consentRow(d.consentId!)).toMatchObject({ revoked_at: null });
    expect((await emailRows(app, userSub)).results).toEqual([{ state: 'granted', email: 'ada@example.com' }]);
    // The root's own stops need no chain read and still work.
    expect((await stop(root, 'share', { shareId: b64(d.shareId) })).status).toBe(200);
  });

  it(`a page reads at most ${HOME_MEMBER_READS} identities, and stops after a failing batch`, async () => {
    const root = await home();
    const member = await home();
    for (let i = 0; i < HOME_DEVICES_PAGE; i++) {
      const app = await policyApp();
      await account(app.scope, root.sub, [[member.sub, 'active']]);
    }
    const reads = () => near.viewCalls.filter((c) => c.method === 'get_identity').length;
    const before = reads();
    expect((await devices(member)).scopes.every((s) => s.canStop)).toBe(true);
    expect(reads() - before).toBe(HOME_MEMBER_READS);
    identityDown = true;
    const failing = reads();
    expect((await devices(member)).scopes.every((s) => !s.canStop)).toBe(true);
    expect(reads() - failing).toBeLessThanOrEqual(HOME_MEMBER_READ_BATCH);
  });
});

describe('the bounds never make the list say something false', () => {
  it(`a device’s consent shows however many tab consents there are (${HOME_CONSENTS_PER_SCOPE}+)`, async () => {
    const app = await policyApp();
    const tabsApp = await policyApp({ scope: app.scope });
    await setSettings(tabsApp.id, { persistence: 'none' });
    const me = await home();
    for (let i = 0; i < HOME_CONSENTS_PER_SCOPE + 2; i++) await registerConsent(tabsApp, spentSession(near, app.scope, { sub: me.sub }), null);
    const d = await device(app, me.sub, { consent: true });
    const s = await ofScope(me, app.scope);
    expect(s.devices.find((x) => x.shareId === b64(d.shareId))?.consent?.consentId).toBe(b64(d.consentId!));
    expect(s.consents).toHaveLength(HOME_CONSENTS_PER_SCOPE);
    expect(s.more).toBe(true);
  });

  it('the apps read takes only the apps the rows name, so other apps in the scope can’t push a device out', async () => {
    const app = await policyApp();
    const me = await home();
    const d = await device(app, me.sub);
    for (let i = 0; i < 5; i++) await seedApp({ scope: app.scope });
    const s = await ofScope(me, app.scope);
    expect(s.devices.map((x) => x.shareId)).toEqual([b64(d.shareId)]);
    expect(s.apps.map((a) => a.appId)).toEqual([app.id]);
  });

  it('"last used" is never later than now', async () => {
    const app = await policyApp();
    const me = await home();
    const d = await device(app, me.sub);
    // A share slid long ago under a long idle limit, the limit lowered since: idle_until − the new limit is in the future.
    await setSettings(app.id, { idle_ttl_ms: 15 * 60_000 });
    await setShare(d.shareId, { idle_until: Date.now() + 3 * HOUR });
    const s = await ofScope(me, app.scope);
    expect(s.devices[0]!.lastUsedAtMs).not.toBeNull();
    expect(s.devices[0]!.lastUsedAtMs).toBeLessThanOrEqual(Date.now());
  });
});

describe('GET /v1/app’s share field (H9: an open tab learns it was signed out)', () => {
  const appRead = async (app: SeededApp, shareId: number[] | string, origin = VAULT): Promise<Record<string, unknown>> => {
    near.clients[`client-${app.scope}`] = app.scope;
    const res = await call('/v1/app', { method: 'GET', headers: { 'x-hana-key': app.key, origin, 'x-hana-parent-origin': ORIGIN, 'x-hana-share': typeof shareId === 'string' ? shareId : b64(shareId) } });
    return (await res.json()) as Record<string, unknown>;
  };

  it('live, then revoked once Home signs the device out; never from another origin; a malformed id gets no field', async () => {
    const app = await policyApp();
    const me = await home();
    const d = await device(app, me.sub);
    expect((await appRead(app, d.shareId)).share).toBe('live');
    expect((await stop(me, 'share', { shareId: b64(d.shareId) })).status).toBe(200);
    expect((await appRead(app, d.shareId)).share).toBe('revoked');
    expect((await appRead(app, [...crypto.getRandomValues(new Uint8Array(16))])).share).toBe('revoked');
    expect((await appRead(app, 'nope')).share).toBeUndefined();
    expect((await appRead(app, d.shareId, ORIGIN)).share).toBeUndefined();
  });

  it('an idle share still reads live: time-based ends stay the vault’s own (D55), and the read moves nothing', async () => {
    const app = await policyApp();
    const me = await home();
    const d = await device(app, me.sub);
    await setShare(d.shareId, { idle_until: Date.now() - 1 });
    const before = await storedShare(d.shareId);
    expect((await appRead(app, d.shareId)).share).toBe('live');
    expect(await storedShare(d.shareId)).toEqual(before);
  });
});

describe('every Home sign-in route (H10): an email identity and the exit client’s', () => {
  const EXIT = 'hana-exit.apps.googleusercontent.com';

  it('an email identity lists and stops its own email login’s devices, consents and sharing, by its provider and sub', async () => {
    withEmail(near, []);
    near.exit = [['email', HOME_EMAIL_AUDIENCE]];
    const app = await policyApp();
    const sub = `e1.${uid()}`;
    const me = await home(sub, { email: true });
    const a = await device(app, sub, { provider: 'email', consent: true, label: 'Safari on iOS' });
    const b = await device(app, sub, { provider: 'email' });
    const userSub = identitySub(userSubKey(), app.scope, { provider: 'email', sub });
    await shareEmail(app, userSub, 'me@example.com');
    const s = await ofScope(me, app.scope);
    expect(s.canStop).toBe(true);
    expect(s.devices.map((d) => d.shareId).sort()).toEqual([b64(a.shareId), b64(b.shareId)].sort());
    expect(s.email).toEqual([{ appId: app.id, addresses: ['me@example.com'] }]);
    expect((await stop(me, 'consent', { consentId: b64(a.consentId!) })).status).toBe(200);
    expect(await vaultSees(app, a.consentId!)).toBe('revoked');
    expect((await stop(me, 'share', { shareId: b64(b.shareId) })).status).toBe(200);
    expect((await storedShare(b.shareId))!.revoked_at).not.toBeNull();
    expect((await stop(me, 'email', { appId: app.id })).status).toBe(200);
    expect((await emailRows(app, userSub)).results).toEqual([{ state: 'declined', email: null }]);
  });

  it('the same string as a Google sub is another person: neither sees nor stops the other’s rows', async () => {
    withEmail(near, []);
    near.exit = [['email', HOME_EMAIL_AUDIENCE]];
    const app = await policyApp();
    const sub = `e1.${uid()}`;
    const byEmail = await home(sub, { email: true });
    const byGoogle = await home(sub);
    const e = await device(app, sub, { provider: 'email', consent: true });
    const g = await device(app, sub, { consent: true });
    expect((await ofScope(byEmail, app.scope)).devices.map((d) => d.shareId)).toEqual([b64(e.shareId)]);
    expect((await ofScope(byGoogle, app.scope)).devices.map((d) => d.shareId)).toEqual([b64(g.shareId)]);
    await expectCode(await stop(byGoogle, 'share', { shareId: b64(e.shareId) }), 404, 'unknown_share');
    await expectCode(await stop(byEmail, 'consent', { consentId: b64(g.consentId!) }), 404, 'unknown_consent');
    expect((await storedShare(e.shareId))!.revoked_at).toBeNull();
    expect(await vaultSees(app, g.consentId!)).toBe('active');
  });

  it('an identity signed in through Hana Home’s exit client lists and stops its devices like the shared client’s', async () => {
    near.exit = [EXIT];
    const app = await policyApp();
    const me = await home(undefined, { aud: EXIT });
    const d = await device(app, me.sub, { consent: true });
    expect((await ofScope(me, app.scope)).devices.map((x) => x.shareId)).toEqual([b64(d.shareId)]);
    expect((await stop(me, 'share', { shareId: b64(d.shareId) })).status).toBe(200);
    expect(await vaultSees(app, d.consentId!)).toBe('revoked');
  });
});

describe('the stops: shapes, refusals, limits, logs', () => {
  it('each body is exactly its one field, of its form', async () => {
    const me = await home();
    const ok = b64([...crypto.getRandomValues(new Uint8Array(16))]);
    for (const [what, body] of [
      ['consent', {}],
      ['consent', { consentId: ok, extra: 1 }],
      ['consent', { consentId: 'short' }],
      ['consent', { consentId: [1, 2, 3] }],
      ['consent', { shareId: ok }],
      ['share', { shareId: `${ok}==` }],
      ['email', { appId: 'not-an-app' }],
      ['email', { appId: 7 }],
    ] as const) {
      await expectCode(await stop(me, what, body), 400, 'bad_request');
    }
  });

  it('a GET is 405; preflight only for AUTH_ORIGIN', async () => {
    expect((await call(HOME_REVOKE_ENDPOINTS.share, { method: 'GET', headers: { origin: AUTH } })).status).toBe(405);
    expect((await call(HOME_REVOKE_ENDPOINTS.share, { method: 'OPTIONS', headers: { origin: AUTH } })).status).toBe(204);
    expect((await call(HOME_REVOKE_ENDPOINTS.share, { method: 'OPTIONS', headers: { origin: 'https://partner.example' } })).status).toBe(403);
    expect((await call(HOME_DEVICES_ENDPOINT, { method: 'POST', headers: { origin: AUTH } })).status).toBe(405);
  });

  it(`the per-Home-key limit (${HOME_REVOKE_PER_KEY_MINUTE} a minute, shared by the three) answers 429`, async () => {
    const { startOfMinuteClock } = await import('./helpers.ts');
    await startOfMinuteClock();
    const me = await home();
    const body = { consentId: b64([...crypto.getRandomValues(new Uint8Array(16))]) };
    for (let i = 0; i < HOME_REVOKE_PER_KEY_MINUTE; i++) expect((await stop(me, i % 2 ? 'consent' : 'share', i % 2 ? body : { shareId: body.consentId })).status).toBe(404);
    const res = await stop(me, 'consent', body);
    await expectCode(res, 429, 'rate_limited');
    // The list keeps its own window.
    expect((await me.send('GET', HOME_DEVICES_ENDPOINT)).status).toBe(200);
  });

  it('a D1 failure is 503 and stops nothing', async () => {
    const app = await policyApp();
    const me = await home();
    const d = await device(app, me.sub);
    vi.spyOn(env.DB, 'batch').mockRejectedValueOnce(new Error('D1 down'));
    await expectCode(await stop(me, 'share', { shareId: b64(d.shareId) }), 503, 'home_directory_unavailable');
    expect((await storedShare(d.shareId))!.revoked_at).toBeNull();
  });

  it('no sub, id, path hash, label or address reaches a log line', async () => {
    const spy = { log: vi.spyOn(console, 'log'), warn: vi.spyOn(console, 'warn'), error: vi.spyOn(console, 'error') };
    const app = await policyApp();
    const me = await home(`secret${uid().replace(/[^0-9]/gu, '')}9`);
    const userSub = await account(app.scope, me.sub);
    await shareEmail(app, userSub, 'secret-address@example.com');
    const d = await device(app, me.sub, { consent: true, label: 'Chrome on macOS' });
    const logs = () => [...spy.log.mock.calls, ...spy.warn.mock.calls, ...spy.error.mock.calls].flat().join('\n');
    const before = logs().length;
    await devices(me);
    await stop(me, 'consent', { consentId: b64(d.consentId!) });
    await stop(me, 'share', { shareId: b64(d.shareId) });
    await stop(me, 'email', { appId: app.id });
    const logged = logs().slice(before);
    expect(logged).toContain(HOME_DEVICES_ENDPOINT);
    const hash = await pathHash(pathFor(app.scope, me.sub));
    const hashHex = hash.map((b) => b.toString(16).padStart(2, '0')).join('');
    for (const secret of [me.sub, userSub, b64(d.shareId), b64(d.consentId!), 'secret-address', 'Chrome on macOS', app.id, hashHex, b64(hash), hash.join(',')]) {
      expect(logged).not.toContain(secret);
    }
  });
});
