import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetCachedApps } from '../src/app-cache.ts';
import { hex } from '../src/bytes.ts';
import { REVOKE_ALL_FRESH_MS, SHARE_PER_MINUTE, VAULT_APP_MINUTE_FACTOR, VAULT_PER_IP_MINUTE } from '../src/vault/endpoints.ts';
import { VAULT_LIMIT_PERIOD_S, vaultIpKey, vaultShareKey } from '../src/vault/limits.ts';
import { clearKekCache } from '../src/vault/kek.ts';
import { advanceShare } from '../src/vault/shares.ts';
import { NO_SHARE_ID, createSharePayload, vaultMessage } from '../src/vault/message.ts';
import { ORIGIN, appHeaders, call, chain, deriveBody, newKey, seedApp, seedPlan, sessionKeyPair, uid } from './helpers.ts';
import {
  HOUR,
  VAULT,
  act,
  actionBody,
  createShare,
  createShareBody,
  newKek,
  pathFor,
  pathHash,
  setSettings,
  setShare,
  signVault,
  spentSession,
  storedShare,
  vaultHeaders,
  vaultSetup,
} from './vault-helpers.ts';

afterEach(() => {
  vi.restoreAllMocks();
  clearKekCache();
});

const MIN = 60_000;
const DEV = { ENV_NAME: 'sandbox-test' };
/** The test bindings are a dev env (vitest.config.ts); the production rules need another name. */
const PROD = { ENV_NAME: 'prod' };

describe('vault message layout', () => {
  it('is prefix ‖ borsh(signer) ‖ borsh(appId) ‖ shareId ‖ u64le(counter) ‖ sha256(payload)', async () => {
    const shareId = Uint8Array.from({ length: 16 }, (_, i) => i);
    const msg = await vaultMessage({ signer: 'ab', appId: 'x', shareId, counter: 258, payload: new TextEncoder().encode('unlock') });
    const sha = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('unlock')));
    expect(hex(msg)).toBe(
      hex(new TextEncoder().encode('hana-id-vault-v1:')) + '02000000' + hex(new TextEncoder().encode('ab')) + '01000000' + '78' + hex(shareId) + '0201000000000000' + hex(sha),
    );
    // create share: utf8("share") ‖ borsh(parentOrigin)
    expect(hex(createSharePayload('o'))).toBe(hex(new TextEncoder().encode('share')) + '01000000' + '6f');
    await expect(vaultMessage({ signer: 'a', appId: 'b', shareId: new Uint8Array(15), counter: 0, payload: new Uint8Array() })).rejects.toThrow('16 bytes');
  });
});

describe('POST /v1/vault/shares', () => {
  it('creates a share for a used-up session: K_s, share id and limits, stored wrapped', async () => {
    const { app, near } = await vaultSetup();
    const before = Date.now();
    const share = await createShare(app, near);
    expect(share.shareId).toHaveLength(16);
    expect(share.ks).toHaveLength(32);
    expect(share.absExpiresAtMs).toBeGreaterThanOrEqual(before + 12 * HOUR - 5000);
    expect(share.absExpiresAtMs).toBeLessThanOrEqual(Date.now() + 12 * HOUR);
    expect(share.idleUntilMs).toBeGreaterThanOrEqual(before + 2 * HOUR);
    expect(share.idleUntilMs).toBeLessThanOrEqual(Date.now() + 2 * HOUR);
    const row = await storedShare(share.shareId);
    expect(row).toMatchObject({ kek_id: 1, counter: 0, partner_origin: ORIGIN, revoked_at: null, idle_until: share.idleUntilMs, abs_expires_at: share.absExpiresAtMs });
    expect(row!.path_hash).toEqual(await pathHash(pathFor(app.scope)));
    // D1 never holds K_s in the clear: the stored value is iv ‖ ciphertext ‖ tag and contains no run of K_s.
    expect(row!.share_enc).toHaveLength(12 + 32 + 16);
    expect(hex(Uint8Array.from(row!.share_enc))).not.toContain(hex(Uint8Array.from(share.ks)).slice(0, 16));
    const all = await env.DB.prepare('SELECT * FROM vault_shares WHERE share_id = ?1').bind(Uint8Array.from(share.shareId)).first();
    expect(JSON.stringify(all)).not.toContain(JSON.stringify(share.ks).slice(1, -1));
  });

  it('caps the absolute expiry at the session’s and the idle limit at the absolute one', async () => {
    const { app, near } = await vaultSetup();
    await setSettings(app.id, { session_ttl_ms: 2 * HOUR, idle_ttl_ms: 30 * MIN });
    const capped = await createShare(app, near, { expiresAtMs: Date.now() + 20 * MIN });
    expect(capped.absExpiresAtMs).toBe((await storedShare(capped.shareId))!.abs_expires_at);
    expect(capped.absExpiresAtMs).toBeLessThanOrEqual(Date.now() + 20 * MIN);
    expect(capped.idleUntilMs).toBe(capped.absExpiresAtMs);
    const ttl = await createShare(app, near);
    expect(ttl.absExpiresAtMs).toBeLessThanOrEqual(Date.now() + 2 * HOUR);
    expect(ttl.idleUntilMs).toBeLessThanOrEqual(Date.now() + 30 * MIN);
  });

  it('409 persistence_off unless the app keeps logins', async () => {
    const { app, near } = await vaultSetup();
    await setSettings(app.id, { persistence: 'none' });
    const spk = spentSession(near, app.scope);
    const res = await call('/v1/vault/shares', { headers: vaultHeaders(app), body: await createShareBody(spk, app.id) });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'persistence_off' });
    expect(near.viewCalls).toHaveLength(0);
  });

  it('401 invalid_signature: wrong key, another app’s id, another parent, or a session-message signature', async () => {
    const { app, near } = await vaultSetup();
    const spk = spentSession(near, app.scope);
    const other = spentSession(near, app.scope);
    const bodies = [
      { sessionPublicKey: spk, signature: (await createShareBody(other, app.id)).signature },
      await createShareBody(spk, `app_${uid()}`),
      await createShareBody(spk, app.id, 'https://elsewhere.example'),
      { sessionPublicKey: spk, signature: [...sessionKeyPair(spk).sign(createSharePayload(ORIGIN)).signature] },
    ];
    for (const body of bodies) {
      const res = await call('/v1/vault/shares', { headers: vaultHeaders(app), body });
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ code: 'invalid_signature' });
    }
    expect(near.viewCalls).toHaveLength(0);
  });

  it('403 scope_mismatch for a session in another scope', async () => {
    const { app, near } = await vaultSetup();
    const spk = spentSession(near, `s${uid()}`);
    const res = await call('/v1/vault/shares', { headers: vaultHeaders(app), body: await createShareBody(spk, app.id) });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'scope_mismatch' });
  });

  it('404 unknown_session for an expired session, without waiting', async () => {
    const { app, near } = await vaultSetup();
    const spk = spentSession(near, app.scope, { expiresAtMs: Date.now() - 1 });
    const started = Date.now();
    const res = await call('/v1/vault/shares', { headers: vaultHeaders(app), body: await createShareBody(spk, app.id) });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'unknown_session' });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('retries a missing or unspent session for 2 s, uncached, then 404 unknown_session or 409 session_not_spent', async () => {
    const { app, near } = await vaultSetup();
    const missing = (await import('./helpers.ts')).newSessionKey();
    const unspent = spentSession(near, app.scope, { used: 0 });
    const [a, b] = await Promise.all([
      call('/v1/vault/shares', { headers: vaultHeaders(app), body: await createShareBody(missing, app.id) }),
      call('/v1/vault/shares', { headers: vaultHeaders(app), body: await createShareBody(unspent, app.id) }),
    ]);
    expect(a.status).toBe(404);
    expect(await a.json()).toMatchObject({ code: 'unknown_session' });
    expect(b.status).toBe(409);
    expect(await b.json()).toMatchObject({ code: 'session_not_spent' });
    // Every attempt read the chain (300 ms apart for up to 2 s).
    const reads = near.viewCalls.filter((v) => v.method === 'get_session' && JSON.stringify(v.args.session_public_key) === JSON.stringify(unspent));
    expect(reads.length).toBeGreaterThanOrEqual(5);
    expect(reads.length).toBeLessThanOrEqual(8);
  });

  it('succeeds once a lagging RPC catches up (null, then used = 0, then spent)', async () => {
    const { app, near } = await vaultSetup();
    const spk = spentSession(near, app.scope);
    const key = JSON.stringify(spk);
    const session = near.sessions.get(key)!;
    near.sessions.delete(key);
    let reads = 0;
    near.onView = (method) => {
      if (method !== 'get_session') return;
      reads++;
      if (reads === 1) near.sessions.set(key, { ...session, used: 0 });
      if (reads === 2) near.sessions.set(key, session);
    };
    const res = await call('/v1/vault/shares', { headers: vaultHeaders(app), body: await createShareBody(spk, app.id) });
    expect(res.status).toBe(201);
    expect(reads).toBe(3);
  });

  it('502 near_unavailable when the session can’t be read', async () => {
    const { app, near } = await vaultSetup();
    const spk = spentSession(near, app.scope);
    near.views.get_session = () => {
      throw new Error('node down');
    };
    const res = await call('/v1/vault/shares', { headers: vaultHeaders(app), body: await createShareBody(spk, app.id) });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: 'near_unavailable' });
  });

  it('409 share_exists: one share per session key', async () => {
    const { app, near } = await vaultSetup();
    const spk = spentSession(near, app.scope);
    const body = await createShareBody(spk, app.id);
    const results = await Promise.all([0, 1, 2].map(() => call('/v1/vault/shares', { headers: vaultHeaders(app), body })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    const conflict = results.find((r) => r.status === 409)!;
    expect(await conflict.json()).toMatchObject({ code: 'share_exists' });
  });

  it('the parent origin must be allowed for the app, wildcard localhost included only for pk_test_ in dev envs', async () => {
    const { app, near } = await vaultSetup();
    for (const parent of ['https://elsewhere.example', null]) {
      const spk = spentSession(near, app.scope);
      const res = await call('/v1/vault/shares', { headers: vaultHeaders(app, parent), body: await createShareBody(spk, app.id, parent ?? ORIGIN) });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'origin_not_allowed' });
    }
    const local = await seedApp({ origins: ['http://localhost:*'] });
    const parent = 'http://localhost:5173';
    expect((await createShare(local, near, { parent, env: DEV })).ks).toHaveLength(32);
    // Loopback is refused outside dev envs, even for pk_test_.
    const spk = spentSession(near, local.scope);
    const refused = await call('/v1/vault/shares', { headers: vaultHeaders(local, parent), body: await createShareBody(spk, local.id, parent), env: PROD });
    expect(refused.status).toBe(403);
  });

  it('503 vault_key_unavailable without a usable VAULT_KEK', async () => {
    const { app, near } = await vaultSetup();
    for (const kek of [undefined, 'x', '1:short', `0:${newKek(1).split(':')[1]}`]) {
      const spk = spentSession(near, app.scope);
      const res = await call('/v1/vault/shares', { headers: vaultHeaders(app), body: await createShareBody(spk, app.id), env: { VAULT_KEK: kek } });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: 'vault_key_unavailable' });
    }
    // A previous key with the current key's id is refused too.
    const same = newKek(1);
    const spk = spentSession(near, app.scope);
    const res = await call('/v1/vault/shares', { headers: vaultHeaders(app), body: await createShareBody(spk, app.id), env: { VAULT_KEK: same, VAULT_KEK_PREVIOUS: newKek(1) } });
    expect(res.status).toBe(503);
  });

  it('400 for malformed bodies', async () => {
    const { app, near } = await vaultSetup();
    const spk = spentSession(near, app.scope);
    const good = await createShareBody(spk, app.id);
    for (const body of [{}, { ...good, extra: 1 }, { ...good, sessionPublicKey: spk.slice(1) }, { ...good, signature: 'x' }, [good]]) {
      const res = await call('/v1/vault/shares', { headers: vaultHeaders(app), body });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'bad_request' });
    }
    expect((await call('/v1/vault/shares', { headers: vaultHeaders(app), rawBody: '{' })).status).toBe(400);
    expect((await call('/v1/vault/shares', { headers: vaultHeaders(app), rawBody: 'x'.repeat(5000) })).status).toBe(413);
  });
});

describe('vault gate', () => {
  it('only the vault origin may call, for an active app, with CORS for the vault', async () => {
    const { app, near } = await vaultSetup();
    const spk = spentSession(near, app.scope);
    const body = await createShareBody(spk, app.id);
    for (const origin of [ORIGIN, 'https://auth.test', null]) {
      const res = await call('/v1/vault/shares', { headers: vaultHeaders(app, ORIGIN, origin), body });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'origin_not_allowed' });
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    }
    const missing = await call('/v1/vault/shares', { headers: { origin: VAULT, 'x-hana-parent-origin': ORIGIN }, body });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({ code: 'missing_key' });
    expect(missing.headers.get('access-control-allow-origin')).toBe(VAULT);
    const unknown = await call('/v1/vault/shares', { headers: vaultHeaders({ key: newKey() }), body });
    expect(await unknown.json()).toMatchObject({ code: 'unknown_app' });
    const suspended = await seedApp({ status: 'suspended' });
    const res = await call('/v1/vault/shares', { headers: vaultHeaders(suspended), body });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'app_suspended' });
    // Without VAULT_ORIGIN configured no origin is the vault.
    const unset = await call('/v1/vault/shares', { headers: vaultHeaders(app), body, env: { VAULT_ORIGIN: undefined } });
    expect(await unset.json()).toMatchObject({ code: 'origin_not_allowed' });
  });

  it('403 scope_conflict for a pk_test_ app on a scope a pk_live_ app uses', async () => {
    const scope = `s${uid()}`;
    const near = chain();
    const test = await seedApp({ scope });
    await seedApp({ scope, key: newKey('pk_live_') });
    const spk = spentSession(near, scope);
    const res = await call('/v1/vault/shares', { headers: vaultHeaders(test), body: await createShareBody(spk, test.id) });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'scope_conflict' });
  });

  it('preflight allows the vault origin and x-hana-parent-origin, nobody else', async () => {
    for (const path of ['/v1/vault/shares', '/v1/vault/unlock', '/v1/vault/touch', '/v1/vault/revoke', '/v1/vault/revoke-all']) {
      const ok = await call(path, { method: 'OPTIONS', headers: { origin: VAULT, 'access-control-request-method': 'POST' } });
      expect(ok.status).toBe(204);
      expect(ok.headers.get('access-control-allow-origin')).toBe(VAULT);
      expect(ok.headers.get('access-control-allow-headers')).toBe('content-type, x-hana-key, x-hana-parent-origin');
      for (const origin of [ORIGIN, 'https://auth.test']) {
        const no = await call(path, { method: 'OPTIONS', headers: { origin } });
        expect(no.status).toBe(403);
        expect(no.headers.get('access-control-allow-origin')).toBeNull();
      }
      expect((await call(path)).status).toBe(405);
    }
  });

  it('per-IP and per-app vault windows', async () => {
    const { app, near } = await vaultSetup();
    const share = await createShare(app, near);
    const ip = `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    // Bad bodies pass the gate (and count) without touching the share's own window.
    const statuses: number[] = [];
    for (let i = 0; i < VAULT_PER_IP_MINUTE; i++) {
      statuses.push((await call('/v1/vault/unlock', { headers: { ...vaultHeaders(app), 'cf-connecting-ip': ip }, body: {} })).status);
    }
    expect(new Set(statuses)).toEqual(new Set([400]));
    const limited = await call('/v1/vault/unlock', { headers: { ...vaultHeaders(app), 'cf-connecting-ip': ip }, body: await actionBody(share, app.id, 'unlock', 1) });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe(String(VAULT_LIMIT_PERIOD_S));
    expect((await act(app, share, 'unlock', 1)).status).toBe(200);

    const plan = `p${uid()}`;
    await seedPlan(plan, 1, 1000, 1000);
    const small = await seedApp({ plan });
    for (let i = 0; i < VAULT_APP_MINUTE_FACTOR; i++) expect((await call('/v1/vault/unlock', { headers: vaultHeaders(small), body: {} })).status).toBe(400);
    const res = await call('/v1/vault/unlock', { headers: vaultHeaders(small), body: {} });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: 'Rate limit exceeded (app per minute)' });
  });

  it('unlocks never use the relay per-IP, per-app minute or day counters', async () => {
    const plan = `p${uid()}`;
    await seedPlan(plan, 1, 1, 1);
    const near = chain();
    const app = await seedApp({ plan });
    const ip = '10.8.1.1';
    const share = await createShare(app, near);
    for (let c = 1; c <= 3; c++) expect((await act(app, share, 'unlock', c, { headers: { 'cf-connecting-ip': ip } })).status).toBe(200);
    // The relay quota (1 per IP, 1 per minute, 1 per day) is untouched: a derive passes the gate.
    const derive = await call('/v1/derive', { headers: { ...appHeaders(app), 'cf-connecting-ip': ip }, body: await deriveBody(share.spk) });
    expect(derive.status).not.toBe(429);
  });

  it('the app window is asked only once the IP window accepted: requests the IP refuses never use the app quota', async () => {
    // per_minute 10 → an app vault window of 100, above the 60 per IP.
    const plan = `p${uid()}`;
    await seedPlan(plan, 10, 1000, 1000);
    const app = await seedApp({ plan });
    const ipA = `10.7.${Math.floor(Math.random() * 250)}.1`;
    const ipB = `10.7.${Math.floor(Math.random() * 250)}.2`;
    const from = (ip: string) => call('/v1/vault/unlock', { headers: { ...vaultHeaders(app), 'cf-connecting-ip': ip }, body: {} });
    for (let i = 0; i < VAULT_PER_IP_MINUTE; i++) expect((await from(ipA)).status).toBe(400);
    for (let i = 0; i < 20; i++) expect((await (await from(ipA)).json()) as object).toMatchObject({ error: 'Rate limit exceeded (per IP per minute)' });
    // 60 of the app's 100 are used, not 80: another client still gets the other 40.
    const left = VAULT_APP_MINUTE_FACTOR * 10 - VAULT_PER_IP_MINUTE;
    for (let i = 0; i < left; i++) expect((await from(ipB)).status).toBe(400);
    expect((await (await from(ipB)).json()) as object).toMatchObject({ error: 'Rate limit exceeded (app per minute)' });
  });

  it('the share limit counts only requests the IP and app limits accepted', async () => {
    const plan = `p${uid()}`;
    await seedPlan(plan, 1, 1000, 1000);
    const near = chain();
    const app = await seedApp({ plan });
    const share = await createShare(app, near);
    // Fill the app's vault window (10 for per_minute 1; share creation used one of them).
    for (let i = 1; i < VAULT_APP_MINUTE_FACTOR; i++) expect((await call('/v1/vault/unlock', { headers: vaultHeaders(app), body: {} })).status).toBe(400);
    // Well-formed share requests the app window refuses: more than the share's own limit.
    for (let i = 0; i <= SHARE_PER_MINUTE; i++) expect((await (await act(app, share, 'touch', 1)).json()) as object).toMatchObject({ error: 'Rate limit exceeded (app per minute)' });
    // Fill an IP's window, then more share requests from it: refused by the IP limit.
    const ip = `10.6.${Math.floor(Math.random() * 250)}.3`;
    const other = await seedApp();
    const otherShare = await createShare(other, near);
    for (let i = 0; i < VAULT_PER_IP_MINUTE; i++) await call('/v1/vault/unlock', { headers: { ...vaultHeaders(other), 'cf-connecting-ip': ip }, body: {} });
    for (let i = 0; i <= SHARE_PER_MINUTE; i++) {
      const res = await act(other, otherShare, 'touch', 1, { headers: { 'cf-connecting-ip': ip } });
      expect((await res.json()) as object).toMatchObject({ error: 'Rate limit exceeded (per IP per minute)' });
    }
    // Neither share's window counted those: each still takes its full SHARE_PER_MINUTE.
    for (let c = 1; c <= SHARE_PER_MINUTE; c++) expect((await act(other, otherShare, 'touch', c)).status).toBe(200);
    expect((await act(other, otherShare, 'touch', SHARE_PER_MINUTE + 1)).status).toBe(429);
    const key = vaultShareKey(env.ENV_NAME, app.id, hex(Uint8Array.from(share.shareId)));
    for (let i = 0; i < SHARE_PER_MINUTE; i++) expect(await env.VAULT_SHARE_LIMIT.limit({ key })).toEqual({ success: true });
    expect(await env.VAULT_SHARE_LIMIT.limit({ key })).toEqual({ success: false });
  });

  it('the per-IP and per-share limits are the Rate Limiting bindings; the RateLimiter object is asked only for the app quota', async () => {
    const { app, near } = await vaultSetup();
    const objects = vi.spyOn(env.RATE_LIMITER, 'idFromName');
    const share = await createShare(app, near);
    for (const action of ['unlock', 'touch', 'revoke'] as const) expect((await act(app, share, action, ['unlock', 'touch', 'revoke'].indexOf(action) + 1)).status).toBe(200);
    // One object call per request (share creation and three share actions), always the app's.
    expect(objects.mock.calls.map(([name]) => name)).toEqual(Array<string>(4).fill(`app:${app.id}`));
  });

  it('keys the bindings by env, app and IP subject (IPv6 by /64), and by env, app and share', async () => {
    const { app, near } = await vaultSetup();
    const share = await createShare(app, near);
    const ipKeys: string[] = [];
    const shareKeys: string[] = [];
    const recording = (keys: string[]): RateLimit => ({ limit: async ({ key }) => (keys.push(key), { success: true }) });
    const bindings = { VAULT_IP_LIMIT: recording(ipKeys), VAULT_SHARE_LIMIT: recording(shareKeys) };
    expect((await act(app, share, 'touch', 1, { env: bindings, headers: { 'cf-connecting-ip': '2001:db8:1:2:aaaa::1' } })).status).toBe(200);
    expect((await act(app, share, 'touch', 2, { env: bindings, headers: { 'cf-connecting-ip': '2001:db8:1:2:bbbb::2' } })).status).toBe(200);
    expect((await act(app, share, 'touch', 3, { env: { ...bindings, ENV_NAME: 'sandbox-other' }, headers: { 'cf-connecting-ip': '192.0.2.7' } })).status).toBe(200);
    const shareHex = hex(Uint8Array.from(share.shareId));
    expect(ipKeys).toEqual([
      `sandbox-test:vault-ip:${app.id}:v6:2001:db8:1:2::/64`,
      `sandbox-test:vault-ip:${app.id}:v6:2001:db8:1:2::/64`,
      `sandbox-other:vault-ip:${app.id}:v4:192.0.2.7`,
    ]);
    expect(shareKeys).toEqual([`sandbox-test:vault-share:${app.id}:${shareHex}`, `sandbox-test:vault-share:${app.id}:${shareHex}`, `sandbox-other:vault-share:${app.id}:${shareHex}`]);
    expect(vaultIpKey('e', 'a', 'v4:1.2.3.4')).toBe('e:vault-ip:a:v4:1.2.3.4');
  });

  it('a binding that refuses answers 429 rate_limited with retry-after; one that fails answers 503; neither lets the request through', async () => {
    const { app, near } = await vaultSetup();
    const share = await createShare(app, near);
    const no: RateLimit = { limit: async () => ({ success: false }) };
    const down: RateLimit = {
      limit: async () => {
        throw new Error('rate limiting unavailable');
      },
    };
    const objects = vi.spyOn(env.RATE_LIMITER, 'idFromName');
    // The IP limit refuses before the app quota is asked: no object call at all.
    for (const path of ['/v1/vault/shares', '/v1/vault/unlock', '/v1/vault/touch', '/v1/vault/revoke', '/v1/vault/revoke-all']) {
      const res = await call(path, { headers: vaultHeaders(app), body: {}, env: { VAULT_IP_LIMIT: no } });
      expect([res.status, res.headers.get('retry-after')], path).toEqual([429, String(VAULT_LIMIT_PERIOD_S)]);
      expect(await res.json()).toMatchObject({ code: 'rate_limited', error: 'Rate limit exceeded (per IP per minute)' });
      const failed = await call(path, { headers: vaultHeaders(app), body: {}, env: { VAULT_IP_LIMIT: down } });
      expect([failed.status, ((await failed.json()) as { code: string }).code], path).toEqual([503, 'rate_limiter_unavailable']);
    }
    expect(objects).not.toHaveBeenCalled();
    // The share limit, asked last.
    for (const action of ['unlock', 'touch', 'revoke', 'revoke-all'] as const) {
      const res = await act(app, share, action, 1, { env: { VAULT_SHARE_LIMIT: no } });
      expect([res.status, res.headers.get('retry-after')], action).toEqual([429, String(VAULT_LIMIT_PERIOD_S)]);
      expect(await res.json()).toMatchObject({ code: 'rate_limited', error: 'Rate limit exceeded (share per minute)' });
      const failed = await act(app, share, action, 1, { env: { VAULT_SHARE_LIMIT: down } });
      expect([failed.status, ((await failed.json()) as { code: string }).code], action).toEqual([503, 'rate_limiter_unavailable']);
    }
    // Nothing moved: the share is still at counter 0 and live.
    expect((await storedShare(share.shareId))!).toMatchObject({ counter: 0, revoked_at: null });
    expect((await act(app, share, 'unlock', 1)).status).toBe(200);
  });

  it('the app quota object failing answers 503 (after the IP limit accepted)', async () => {
    const { app, near } = await vaultSetup();
    const share = await createShare(app, near);
    vi.spyOn(env.RATE_LIMITER, 'idFromName').mockImplementation(() => {
      throw new Error('DO down');
    });
    const res = await act(app, share, 'unlock', 1);
    expect([res.status, ((await res.json()) as { code: string }).code]).toEqual([503, 'rate_limiter_unavailable']);
    vi.restoreAllMocks();
    expect((await storedShare(share.shareId))!.counter).toBe(0);
  });

  it(`per share: ${SHARE_PER_MINUTE} requests per minute`, async () => {
    const { app, near } = await vaultSetup();
    const share = await createShare(app, near);
    for (let c = 1; c <= SHARE_PER_MINUTE; c++) expect((await act(app, share, 'touch', c)).status).toBe(200);
    const res = await act(app, share, 'touch', SHARE_PER_MINUTE + 1);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: 'rate_limited', error: 'Rate limit exceeded (share per minute)' });
    expect((await storedShare(share.shareId))!.counter).toBe(SHARE_PER_MINUTE);
  });
});

describe('POST /v1/vault/unlock', () => {
  it('returns K_s, moves the counter, slides idle_until and counts an unlock, with no chain call', async () => {
    const { app, near } = await vaultSetup();
    const share = await createShare(app, near);
    await setShare(share.shareId, { idle_until: Date.now() + MIN });
    const views = near.viewCalls.length;
    const res = await act(app, share, 'unlock', 1);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ks: share.ks, counter: 1, absExpiresAtMs: share.absExpiresAtMs });
    expect(body.idleUntilMs as number).toBeGreaterThan(Date.now() + 2 * HOUR - 5000);
    expect((await storedShare(share.shareId))!).toMatchObject({ counter: 1, idle_until: body.idleUntilMs });
    expect(near.viewCalls.length).toBe(views);
    expect(near.rpcMethods.filter((m) => m !== 'query')).toEqual([]);
    const usage = await env.DB.prepare('SELECT unlocks, sessions, derives FROM usage WHERE app_id = ?1').bind(app.id).first();
    expect(usage).toEqual({ unlocks: 1, sessions: 0, derives: 0 });
    expect((await act(app, share, 'unlock', 2)).status).toBe(200);
    expect(await env.DB.prepare('SELECT unlocks FROM usage WHERE app_id = ?1').bind(app.id).first()).toEqual({ unlocks: 2 });
  });

  it('idle_until never passes the absolute expiry', async () => {
    const { app, near } = await vaultSetup();
    const share = await createShare(app, near);
    const abs = Date.now() + 10 * MIN;
    await setShare(share.shareId, { abs_expires_at: abs });
    const body = (await (await act(app, share, 'unlock', 1)).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ idleUntilMs: abs, absExpiresAtMs: abs });
  });

  it('409 bad_counter with the expected counter for a replay or a skip; nothing moves', async () => {
    const { app, near } = await vaultSetup();
    const share = await createShare(app, near);
    expect((await act(app, share, 'unlock', 1)).status).toBe(200);
    for (const counter of [1, 3]) {
      const res = await act(app, share, 'unlock', counter);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'bad_counter', expected: 2 });
    }
    expect((await storedShare(share.shareId))!.counter).toBe(1);
    expect((await act(app, share, 'unlock', 2)).status).toBe(200);
  });

  it('concurrent unlocks with one counter: exactly one wins', async () => {
    const { app, near } = await vaultSetup();
    const share = await createShare(app, near);
    const body = await actionBody(share, app.id, 'unlock', 1);
    const results = await Promise.all([0, 1, 2, 3].map(() => call('/v1/vault/unlock', { headers: vaultHeaders(app), body })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
    for (const r of results.filter((x) => x.status === 409)) expect(await r.json()).toMatchObject({ expected: 2 });
    expect(await env.DB.prepare('SELECT unlocks FROM usage WHERE app_id = ?1').bind(app.id).first()).toEqual({ unlocks: 1 });
  });

  it('401 invalid_signature does not consume the counter; another app’s id or another action never verifies', async () => {
    const { app, near } = await vaultSetup();
    const share = await createShare(app, near);
    const wrong = await act(app, share, 'unlock', 1, { signAs: `app_${uid()}` });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ code: 'invalid_signature' });
    const asTouch = { ...(await actionBody(share, app.id, 'touch', 1)) };
    expect((await call('/v1/vault/unlock', { headers: vaultHeaders(app), body: asTouch })).status).toBe(401);
    expect((await storedShare(share.shareId))!.counter).toBe(0);
    expect((await act(app, share, 'unlock', 1)).status).toBe(200);
  });

  it('another app’s key (same scope) gets 404 unknown_share and moves nothing', async () => {
    const { app, near } = await vaultSetup();
    const other = await seedApp({ scope: app.scope });
    const share = await createShare(app, near);
    const res = await act(other, share, 'unlock', 1);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'unknown_share' });
    // Signed with the other app's id, too.
    expect((await act(other, share, 'unlock', 1, { signAs: other.id })).status).toBe(404);
    expect((await storedShare(share.shareId))!.counter).toBe(0);
    expect((await act(app, share, 'unlock', 1)).status).toBe(200);
    const unknown = await act(app, { spk: share.spk, shareId: Array.from({ length: 16 }, () => 7) }, 'unlock', 1);
    expect(unknown.status).toBe(404);
  });

  it('a share from a wildcard-registered localhost origin still unlocks (dev env)', async () => {
    const near = chain();
    const app = await seedApp({ origins: ['http://localhost:*'] });
    const parent = 'http://localhost:40123';
    const share = await createShare(app, near, { parent, env: DEV });
    expect((await act(app, share, 'unlock', 1, { parent, env: DEV })).status).toBe(200);
    // The same share in a non-dev env: its origin is not allowed there.
    const res = await act(app, share, 'unlock', 2, { parent: ORIGIN });
    expect(res.status).toBe(403);
  });

  it('410 share_expired past the idle or the absolute limit', async () => {
    const { app, near } = await vaultSetup();
    const idle = await createShare(app, near);
    await setShare(idle.shareId, { idle_until: Date.now() - 1 });
    const abs = await createShare(app, near);
    await setShare(abs.shareId, { abs_expires_at: Date.now() - 1 });
    for (const share of [idle, abs]) {
      for (const action of ['unlock', 'touch'] as const) {
        const res = await act(app, share, action, 1);
        expect(res.status).toBe(410);
        expect(await res.json()).toMatchObject({ code: 'share_expired' });
      }
      expect((await storedShare(share.shareId))!.counter).toBe(0);
    }
  });

  it('removing an origin kills its shares for good (410 share_revoked)', async () => {
    const extra = `https://${uid()}.example.com`;
    const { app, near } = await vaultSetup({ origins: [ORIGIN, extra] });
    const share = await createShare(app, near, { parent: extra });
    const kept = await createShare(app, near);
    await env.DB.prepare('DELETE FROM app_origins WHERE app_id = ?1 AND origin = ?2').bind(app.id, extra).run();
    // This isolate read the app for the shares above; the change is seen once that read is past its TTL
    // (test/app-cache.test.ts), here at once.
    forgetCachedApps();
    const res = await act(app, share, 'unlock', 1);
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ code: 'share_revoked' });
    expect((await storedShare(share.shareId))!.revoked_at).not.toBeNull();
    expect((await act(app, kept, 'unlock', 1)).status).toBe(200);
    await env.DB.prepare('INSERT INTO app_origins (app_id, origin) VALUES (?1, ?2)').bind(app.id, extra).run();
    forgetCachedApps();
    expect((await act(app, share, 'unlock', 1, { parent: extra })).status).toBe(410);
  });

  it('KEK rotation: a share under the previous KEK unlocks and is re-wrapped under the current one', async () => {
    const { app, near } = await vaultSetup();
    const share = await createShare(app, near);
    const rotated = { VAULT_KEK: newKek(2), VAULT_KEK_PREVIOUS: env.VAULT_KEK };
    const res = await act(app, share, 'unlock', 1, { env: rotated });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ks: share.ks });
    const row = (await storedShare(share.shareId))!;
    expect(row.kek_id).toBe(2);
    // Only the new key reads it now.
    expect((await act(app, share, 'unlock', 2, { env: { VAULT_KEK: rotated.VAULT_KEK } })).status).toBe(200);
    const old = await act(app, share, 'unlock', 3);
    expect(old.status).toBe(503);
    expect(await old.json()).toMatchObject({ code: 'vault_key_unavailable' });
    expect((await storedShare(share.shareId))!.counter).toBe(2);
  });

  it('a tampered or moved share_enc fails closed without moving the counter', async () => {
    const { app, near } = await vaultSetup();
    const a = await createShare(app, near);
    const b = await createShare(app, near);
    const encA = (await storedShare(a.shareId))!.share_enc;
    await env.DB.prepare('UPDATE vault_shares SET share_enc = ?1 WHERE share_id = ?2').bind(Uint8Array.from(encA), Uint8Array.from(b.shareId)).run();
    const res = await act(app, b, 'unlock', 1);
    expect(res.status).toBe(500);
    expect((await storedShare(b.shareId))!.counter).toBe(0);
  });

  it('400 for malformed bodies', async () => {
    const { app, near } = await vaultSetup();
    const share = await createShare(app, near);
    const good = await actionBody(share, app.id, 'unlock', 1);
    for (const body of [{ ...good, counter: 0 }, { ...good, counter: 1.5 }, { ...good, counter: '1' }, { ...good, shareId: share.shareId.slice(1) }, { ...good, x: 1 }, { shareId: share.shareId }]) {
      expect((await call('/v1/vault/unlock', { headers: vaultHeaders(app), body })).status).toBe(400);
    }
  });
});

describe('unlock and touch follow the app’s current settings', () => {
  it('persistence switched to none after a share exists: unlock and touch refuse with 410 share_revoked and revoke it', async () => {
    for (const action of ['unlock', 'touch'] as const) {
      const { app, near } = await vaultSetup();
      const share = await createShare(app, near);
      const other = await createShare(app, near);
      await setSettings(app.id, { persistence: 'none' });
      const res = await act(app, share, action, 1);
      expect(res.status).toBe(410);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ code: 'share_revoked' });
      expect(body).not.toHaveProperty('ks');
      expect((await storedShare(share.shareId))!).toMatchObject({ counter: 0, revoked_at: expect.any(Number) });
      // For good: turning persistence back on doesn't bring the share back (the other one was never used, so it is).
      await setSettings(app.id, { persistence: 'session' });
      expect((await act(app, share, 'unlock', 1)).status).toBe(410);
      expect((await act(app, other, 'unlock', 1)).status).toBe(200);
    }
  });

  it('a session TTL lowered after creation caps the share at created_at + the new TTL', async () => {
    const { app, near } = await vaultSetup();
    const share = await createShare(app, near);
    const created = (await storedShare(share.shareId))!.created_at;
    expect(share.absExpiresAtMs).toBeGreaterThan(created + 11 * HOUR);
    await setSettings(app.id, { session_ttl_ms: 2 * HOUR, idle_ttl_ms: 2 * HOUR });
    const res = await act(app, share, 'unlock', 1);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ks: share.ks, counter: 1, absExpiresAtMs: created + 2 * HOUR });
    expect(body.idleUntilMs as number).toBeLessThanOrEqual(created + 2 * HOUR);
    expect((await storedShare(share.shareId))!).toMatchObject({ abs_expires_at: created + 2 * HOUR, idle_until: body.idleUntilMs });
    const touched = (await (await act(app, share, 'touch', 2)).json()) as Record<string, unknown>;
    expect(touched.idleUntilMs as number).toBeLessThanOrEqual(created + 2 * HOUR);
    // Raising the TTL again never lengthens the share.
    await setSettings(app.id, { session_ttl_ms: 20 * HOUR });
    expect((await (await act(app, share, 'unlock', 3)).json()) as Record<string, unknown>).toMatchObject({ absExpiresAtMs: created + 2 * HOUR });
  });

  it('a share already older than the lowered TTL gets 410 share_expired, its counter unused and its stored expiry lowered', async () => {
    for (const action of ['unlock', 'touch'] as const) {
      const { app, near } = await vaultSetup();
      const share = await createShare(app, near);
      const created = Date.now() - 3 * HOUR;
      await setShare(share.shareId, { created_at: created });
      await setSettings(app.id, { session_ttl_ms: 2 * HOUR, idle_ttl_ms: HOUR });
      const res = await act(app, share, action, 1);
      expect(res.status).toBe(410);
      expect(await res.json()).toMatchObject({ code: 'share_expired' });
      expect((await storedShare(share.shareId))!).toMatchObject({ counter: 0, abs_expires_at: created + 2 * HOUR, revoked_at: null });
    }
  });

  it('the counter update itself re-checks the settings (a change after the request’s first read still applies)', async () => {
    const { app, near } = await vaultSetup();
    const share = await createShare(app, near);
    const id = Uint8Array.from(share.shareId);
    await setSettings(app.id, { persistence: 'none' });
    expect(await advanceShare(env.DB, app.id, id, 1, Date.now(), { kind: 'slide' })).toBeNull();
    await setSettings(app.id, { persistence: 'session' });
    const created = (await storedShare(share.shareId))!.created_at;
    await setSettings(app.id, { session_ttl_ms: HOUR, idle_ttl_ms: HOUR });
    expect(await advanceShare(env.DB, app.id, id, 1, created + HOUR, { kind: 'slide' })).toBeNull();
    expect(await advanceShare(env.DB, app.id, id, 1, created + HOUR - 1, { kind: 'slide' })).toMatchObject({ counter: 1, absExpiresAt: created + HOUR, idleUntil: created + HOUR });
    // revoke still works on a share whose app no longer keeps logins.
    await setSettings(app.id, { persistence: 'none' });
    expect(await advanceShare(env.DB, app.id, id, 2, Date.now(), { kind: 'revoke' })).toMatchObject({ counter: 2 });
  });

  it('revoke and revoke-all are not refused by the settings', async () => {
    const { app, near } = await vaultSetup();
    const share = await createShare(app, near);
    const device2 = await createShare(app, near);
    await setSettings(app.id, { persistence: 'none' });
    expect(await (await act(app, share, 'revoke-all', 1)).json()).toMatchObject({ revoked: 1 });
    expect(await (await act(app, share, 'revoke', 2)).json()).toMatchObject({ revoked: true });
    expect((await storedShare(device2.shareId))!.revoked_at).not.toBeNull();
  });
});

describe('POST /v1/vault/touch', () => {
  it('slides idle_until without returning K_s', async () => {
    const { app, near } = await vaultSetup();
    const share = await createShare(app, near);
    await setShare(share.shareId, { idle_until: Date.now() + MIN });
    const res = await act(app, share, 'touch', 1);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['counter', 'idleUntilMs', 'requestId']);
    expect(body.counter).toBe(1);
    expect(body.idleUntilMs as number).toBeGreaterThan(Date.now() + 2 * HOUR - 5000);
    expect(await env.DB.prepare('SELECT unlocks FROM usage WHERE app_id = ?1').bind(app.id).first()).toBeNull();
    // Touch works without any KEK (it never reads K_s).
    expect((await act(app, share, 'touch', 2, { env: { VAULT_KEK: undefined } })).status).toBe(200);
  });
});

describe('POST /v1/vault/revoke and /revoke-all', () => {
  it('revoke ends the share: later requests get 410 share_revoked', async () => {
    const { app, near } = await vaultSetup();
    const share = await createShare(app, near);
    const res = await act(app, share, 'revoke', 1);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ revoked: true });
    for (const action of ['unlock', 'touch', 'revoke'] as const) {
      const again = await act(app, share, action, 2);
      expect(again.status).toBe(410);
      expect(await again.json()).toMatchObject({ code: 'share_revoked' });
    }
  });

  it('revoke-all, within 5 min of the share’s creation, revokes the user’s other live shares in this app only', async () => {
    const { app, near } = await vaultSetup();
    const other = await seedApp({ scope: app.scope });
    const mine = await createShare(app, near);
    const device2 = await createShare(app, near);
    const device3 = await createShare(app, near);
    const alreadyRevoked = await createShare(app, near);
    await setShare(alreadyRevoked.shareId, { revoked_at: Date.now() - 1 });
    const someoneElse = await createShare(app, near, { sub: 'another-user' });
    const otherApp = await createShare(other, near);
    const res = await act(app, mine, 'revoke-all', 1);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ revoked: 2 });
    for (const s of [device2, device3]) expect((await act(app, s, 'unlock', 1)).status).toBe(410);
    expect((await act(app, mine, 'unlock', 2)).status).toBe(200);
    expect((await act(app, someoneElse, 'unlock', 1)).status).toBe(200);
    expect((await act(other, otherApp, 'unlock', 1)).status).toBe(200);
  });

  it('revoke-all is one transaction: if the counter move fails, no other share is revoked and the counter stays', async () => {
    const { app, near } = await vaultSetup();
    const mine = await createShare(app, near);
    const device2 = await createShare(app, near);
    // A D1 whose batch fails on its second statement (the counter move), after the revoke in the same batch ran.
    const failing = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop === 'prepare') {
          return (query: string) => target.prepare(/^\s*UPDATE vault_shares SET counter = \?3\b/u.test(query) ? query.replace('UPDATE vault_shares', 'UPDATE no_such_table') : query);
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const res = await act(app, mine, 'revoke-all', 1, { env: { DB: failing } });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'config_unavailable' });
    expect((await storedShare(mine.shareId))!.counter).toBe(0);
    expect((await storedShare(device2.shareId))!.revoked_at).toBeNull();
    // The retry with the same counter then works.
    expect(await (await act(app, mine, 'revoke-all', 1)).json()).toMatchObject({ revoked: 1 });
  });

  it('a replayed revoke-all revokes nothing (shares made after the first one stay live)', async () => {
    const { app, near } = await vaultSetup();
    const mine = await createShare(app, near);
    await createShare(app, near);
    const body = await actionBody(mine, app.id, 'revoke-all', 1);
    expect(await (await call('/v1/vault/revoke-all', { headers: vaultHeaders(app), body })).json()).toMatchObject({ revoked: 1 });
    const later = await createShare(app, near);
    const replay = await call('/v1/vault/revoke-all', { headers: vaultHeaders(app), body });
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ code: 'bad_counter', expected: 2 });
    expect((await storedShare(later.shareId))!.revoked_at).toBeNull();
  });

  it('403 share_not_fresh for a share older than 5 min, without consuming the counter', async () => {
    const { app, near } = await vaultSetup();
    const share = await createShare(app, near);
    const device2 = await createShare(app, near);
    await setShare(share.shareId, { created_at: Date.now() - REVOKE_ALL_FRESH_MS });
    const res = await act(app, share, 'revoke-all', 1);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'share_not_fresh' });
    expect((await storedShare(share.shareId))!.counter).toBe(0);
    expect((await act(app, device2, 'unlock', 1)).status).toBe(200);
  });
});

describe('vault logging', () => {
  it('never logs K_s, signatures, share ciphertexts or session keys', async () => {
    const lines: string[] = [];
    for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(' ')));
    const { app, near } = await vaultSetup();
    const share = await createShare(app, near);
    const unlockBody = await actionBody(share, app.id, 'unlock', 1);
    await call('/v1/vault/unlock', { headers: vaultHeaders(app), body: unlockBody });
    await act(app, share, 'unlock', 1);
    await act(app, share, 'revoke', 2);
    const enc = (await storedShare(share.shareId))!.share_enc;
    const text = lines.join('\n');
    expect(lines.length).toBeGreaterThan(0);
    const forms = (b: number[]) => [JSON.stringify(b).slice(1, -1), hex(Uint8Array.from(b)), btoa(String.fromCharCode(...b))];
    for (const secret of [share.ks, unlockBody.signature as number[], enc, share.spk, share.shareId]) for (const form of forms(secret)) expect(text).not.toContain(form);
  });
});

describe('vault message signatures', () => {
  it('a signature over the create-share message never verifies as an unlock', async () => {
    const { app, near } = await vaultSetup();
    const share = await createShare(app, near);
    const createSig = await signVault(share.spk, app.id, NO_SHARE_ID, 0, createSharePayload(ORIGIN));
    const res = await call('/v1/vault/unlock', { headers: vaultHeaders(app), body: { shareId: share.shareId, counter: 1, signature: createSig } });
    expect(res.status).toBe(401);
  });
});
