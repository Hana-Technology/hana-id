// Hana Home H4: POST /v1/vault/consents, /v1/vault/consents/revoke, the `consent` field on GET /v1/app, the share's
// device label and the hourly prune (docs/hana-home-spec.md "Consents and devices"). Both persistence modes.
import { consentRegisterPayload, consentRevokePayload } from '@hana-id/core/home';
import { policyId as computePolicyId } from '@hana-id/core/policy';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetCachedApps } from '../src/app-cache.ts';
import { base64UrlEncode, fromHex, sha256 } from '../src/bytes.ts';
import { CONSENT_MAX_PER_SESSION_KEY, CONSENT_REVOKED_KEEP_MS, pruneConsents } from '../src/vault/consent-store.ts';
import { SHARE_TOMBSTONE_MS, pruneShares, vaultMaintenance } from '../src/vault/cron.ts';
import { clearKekCache } from '../src/vault/kek.ts';
import { NO_SHARE_ID } from '../src/vault/message.ts';
import { ORIGIN, type Chain, type SeededApp, call, newSessionKey, seedApp } from './helpers.ts';
import { HOUR, VAULT, autoApprovePolicy, createShare, createShareBody, pathFor, pathHash, setSettings, setShare, signVault, spentSession, storedShare, vaultHeaders, vaultSetup } from './vault-helpers.ts';

afterEach(() => {
  vi.restoreAllMocks();
  clearKekCache();
});

const REGISTER = '/v1/vault/consents';
const REVOKE = '/v1/vault/consents/revoke';
const SESSION_TTL = 12 * HOUR;
const POLICY = autoApprovePolicy('Swaps on Base');
const POLICY_ID = [...fromHex(computePolicyId(POLICY, { sessionTtlMs: SESSION_TTL }))];

const newConsentId = (): number[] => [...crypto.getRandomValues(new Uint8Array(16))];
const inAnHour = (): number => Date.now() + HOUR;

interface Device {
  spk: number[];
  shareId: number[] | null;
}

/** An app with the policy in force, and a device in 'session' mode (a live share) or 'none' mode (a chain session only). */
async function setup(mode: 'session' | 'none', opts: Parameters<typeof vaultSetup>[0] = {}): Promise<{ app: SeededApp; near: Chain; device: Device }> {
  const { app, near } = await vaultSetup(opts);
  await setSettings(app.id, { auto_approve_policy: JSON.stringify(POLICY) });
  return { app, near, device: await newDevice(mode, app, near) };
}

async function newDevice(mode: 'session' | 'none', app: SeededApp, near: Chain, sub?: string): Promise<Device> {
  if (mode === 'none') {
    await setSettings(app.id, { persistence: 'none' });
    return { spk: spentSession(near, app.scope, { sub }), shareId: null };
  }
  const share = await createShare(app, near, { sub });
  return { spk: share.spk, shareId: share.shareId };
}

interface RegisterOpts {
  consentId?: number[];
  policyId?: number[];
  expiresAtMs?: number;
  counter?: number;
  parent?: string;
  signAs?: string;
  signWith?: number[];
}

async function registerBody(app: SeededApp, device: Device, o: RegisterOpts = {}): Promise<{ body: Record<string, unknown>; consentId: number[] }> {
  const consentId = o.consentId ?? newConsentId();
  const policyId = o.policyId ?? POLICY_ID;
  const expiresAtMs = o.expiresAtMs ?? inAnHour();
  const counter = o.counter ?? (device.shareId ? 1 : 0);
  const payload = consentRegisterPayload({ consentId: Uint8Array.from(consentId), policyId: Uint8Array.from(policyId), expiresAtMs, parentOrigin: o.parent ?? ORIGIN });
  const shareBytes = device.shareId ? Uint8Array.from(device.shareId) : NO_SHARE_ID;
  const signature = await signVault(o.signWith ?? device.spk, o.signAs ?? app.id, shareBytes, counter, payload);
  return {
    consentId,
    body: { ...(device.shareId ? { shareId: device.shareId } : {}), sessionPublicKey: device.spk, counter, signature, consentId, policyId, expiresAtMs },
  };
}

async function register(app: SeededApp, device: Device, o: RegisterOpts & { env?: Partial<typeof env> } = {}): Promise<{ res: Response; consentId: number[] }> {
  const { body, consentId } = await registerBody(app, device, o);
  return { res: await call(REGISTER, { headers: vaultHeaders(app, o.parent ?? ORIGIN), body, env: o.env }), consentId };
}

async function revokeBody(app: SeededApp, device: Device, consentId: number[], o: { counter?: number; signAs?: string; signWith?: number[] } = {}): Promise<Record<string, unknown>> {
  const counter = o.counter ?? (device.shareId ? 2 : 0);
  const shareBytes = device.shareId ? Uint8Array.from(device.shareId) : NO_SHARE_ID;
  const signature = await signVault(o.signWith ?? device.spk, o.signAs ?? app.id, shareBytes, counter, consentRevokePayload(Uint8Array.from(consentId)));
  return { ...(device.shareId ? { shareId: device.shareId } : {}), sessionPublicKey: device.spk, counter, signature, consentId };
}

const revoke = async (app: SeededApp, device: Device, consentId: number[], o: { counter?: number; signAs?: string; signWith?: number[] } = {}): Promise<Response> =>
  call(REVOKE, { headers: vaultHeaders(app), body: await revokeBody(app, device, consentId, o) });

async function expectCode(res: Response, status: number, code: string): Promise<Record<string, unknown>> {
  const body = (await res.json()) as Record<string, unknown>;
  expect({ status: res.status, code: body.code }).toEqual({ status, code });
  return body;
}

interface StoredConsent {
  app_id: string;
  share_id: unknown;
  path_hash: unknown;
  partner_origin: string;
  policy_id: unknown;
  label: string;
  granted_at: number;
  expires_at: number;
  revoked_at: number | null;
  revoked_by: string | null;
}

const stored = (consentId: number[]): Promise<StoredConsent | null> => env.DB.prepare('SELECT * FROM vault_consents WHERE consent_id = ?1').bind(Uint8Array.from(consentId)).first<StoredConsent>();
const setConsent = async (consentId: number[], fields: Record<string, number | string | null>): Promise<void> => {
  const keys = Object.keys(fields);
  await env.DB.prepare(`UPDATE vault_consents SET ${keys.map((k, i) => `${k} = ?${i + 2}`).join(', ')} WHERE consent_id = ?1`)
    .bind(Uint8Array.from(consentId), ...keys.map((k) => fields[k]))
    .run();
};
const arr = (v: unknown): number[] => (v === null ? [] : v instanceof ArrayBuffer ? [...new Uint8Array(v)] : [...(v as number[])]);

const counterOf = async (shareId: number[]): Promise<number> => (await storedShare(shareId))!.counter;

/** GET /v1/app as the vault sees it, with the consent header unless `consentId` is null. */
async function appStatus(app: SeededApp, near: Chain, consentId: number[] | string | null, origin: string | null = VAULT, envOverride?: Partial<typeof env>): Promise<Record<string, unknown>> {
  near.clients[`client-${app.scope}`] = app.scope;
  const headers: Record<string, string> = { 'x-hana-key': app.key, ...(origin ? { origin } : {}), ...(origin === VAULT ? { 'x-hana-parent-origin': ORIGIN } : {}) };
  if (consentId !== null) headers['x-hana-consent'] = typeof consentId === 'string' ? consentId : base64UrlEncode(Uint8Array.from(consentId));
  const res = await call('/v1/app', { method: 'GET', headers, env: envOverride });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe.each(['session', 'none'] as const)('register a consent, %s mode', (mode) => {
  it('stores the consent bound to the session and account, with the policy in force and its label', async () => {
    const { app, near, device } = await setup(mode);
    const { res, consentId } = await register(app, device);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { counter: number; grantedAtMs: number; expiresAtMs: number };
    expect(body.counter).toBe(device.shareId ? 1 : 0);
    const row = (await stored(consentId))!;
    expect(row.app_id).toBe(app.id);
    expect(row.partner_origin).toBe(ORIGIN);
    expect(arr(row.path_hash)).toEqual(await pathHash(pathFor(app.scope)));
    expect(arr(row.policy_id)).toEqual(POLICY_ID);
    expect(row.label).toBe('Swaps on Base');
    expect(row.granted_at).toBe(body.grantedAtMs);
    expect(row.revoked_at).toBeNull();
    if (device.shareId) expect(arr(row.share_id)).toEqual(device.shareId);
    else expect(row.share_id).toBeNull();
    expect(near.viewCalls.filter((c) => c.method === 'get_session')).toHaveLength(1); // 'session' mode: share creation's read only (registering makes none); 'none' mode: the consent's one read.
  });

  it('refuses a repeated consent id with 409 and changes nothing', async () => {
    const { app, device } = await setup(mode);
    const { consentId } = await register(app, device);
    const before = device.shareId ? await counterOf(device.shareId) : 0;
    await expectCode((await register(app, device, { consentId, counter: device.shareId ? 2 : 0 })).res, 409, 'consent_exists');
    if (device.shareId) expect(await counterOf(device.shareId)).toBe(before);
  });

  it('a second registration revokes the first', async () => {
    const { app, device } = await setup(mode);
    const first = await register(app, device);
    const second = await register(app, device, { counter: device.shareId ? 2 : 0 });
    expect(second.res.status).toBe(201);
    const old = (await stored(first.consentId))!;
    expect(old.revoked_by).toBe('device');
    expect(old.revoked_at).not.toBeNull();
    expect((await stored(second.consentId))!.revoked_at).toBeNull();
  });

  it('the device revokes its own consent; repeating it changes nothing further', async () => {
    const { app, device } = await setup(mode);
    const { consentId } = await register(app, device);
    const res = await revoke(app, device, consentId);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ revoked: true, counter: device.shareId ? 2 : 0 });
    const row = (await stored(consentId))!;
    expect(row.revoked_by).toBe('device');
    const again = await revoke(app, device, consentId, { counter: device.shareId ? 3 : 0 });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ revoked: false });
    expect((await stored(consentId))!.revoked_at).toBe(row.revoked_at);
  });

  it('refuses a bad signature, one for another app, and a policy or expiry that does not match', async () => {
    const { app, device } = await setup(mode);
    await expectCode((await register(app, device, { signWith: newSessionKey() })).res, 401, 'invalid_signature');
    await expectCode((await register(app, device, { signAs: 'other-app' })).res, 401, 'invalid_signature');
    await expectCode((await register(app, device, { parent: 'https://other.example' })).res, 403, 'origin_not_allowed');
    await expectCode((await register(app, device, { policyId: Array(32).fill(7) })).res, 409, 'policy_not_in_force');
    await expectCode((await register(app, device, { expiresAtMs: Date.now() - 1 })).res, 400, 'bad_expiry');
    await expectCode((await register(app, device, { expiresAtMs: Date.now() + 25 * HOUR })).res, 400, 'bad_expiry');
    // Each refusal above left the counter and the table alone.
    if (device.shareId) expect(await counterOf(device.shareId)).toBe(0);
  });

  it('refuses when no policy is in force', async () => {
    const { app, device } = await setup(mode);
    await setSettings(app.id, { auto_approve_policy: null });
    await expectCode((await register(app, device)).res, 409, 'policy_not_in_force');
  });

  it('the status read follows the consent: active, then revoked, unknown for another id', async () => {
    const { app, near, device } = await setup(mode);
    const { consentId } = await register(app, device);
    expect((await appStatus(app, near, consentId)).consent).toBe('active');
    expect((await appStatus(app, near, newConsentId())).consent).toBe('unknown');
    await setConsent(consentId, { revoked_at: Date.now(), revoked_by: 'home' });
    expect((await appStatus(app, near, consentId)).consent).toBe('revoked');
  });

  it('reads revoked once the consent itself has expired', async () => {
    const { app, near, device } = await setup(mode);
    const { consentId } = await register(app, device);
    await setConsent(consentId, { expires_at: Date.now() - 1 });
    expect((await appStatus(app, near, consentId)).consent).toBe('revoked');
  });

  it('a share or session key that is not the caller’s can’t revoke it (404, no change)', async () => {
    const { app, near, device } = await setup(mode);
    const { consentId } = await register(app, device);
    const other = await newDevice(mode, app, near, 'someone-else');
    await expectCode(await revoke(app, other, consentId, { counter: other.shareId ? 1 : 0 }), 404, 'unknown_consent');
    expect((await stored(consentId))!.revoked_at).toBeNull();
    if (other.shareId) expect(await counterOf(other.shareId)).toBe(0);
  });

  it('another app’s consent is unknown here: register, revoke and the status read', async () => {
    const { app, near, device } = await setup(mode);
    const { consentId } = await register(app, device);
    const app2 = await seedApp({ scope: app.scope, origins: [ORIGIN] });
    await setSettings(app2.id, { auto_approve_policy: JSON.stringify(POLICY), ...(mode === 'none' ? { persistence: 'none' } : {}) });
    const res = await call(REVOKE, { headers: vaultHeaders(app2), body: await revokeBody(app2, device, consentId) });
    if (device.shareId) expect(res.status).toBe(404);
    else await expectCode(res, 404, 'unknown_consent');
    expect((await stored(consentId))!.revoked_at).toBeNull();
    expect((await appStatus(app2, near, consentId)).consent).toBe('unknown');
  });
});

describe('session mode', () => {
  it('moves the share counter in the same step, and a replay moves nothing', async () => {
    const { app, device } = await setup('session');
    const { body, consentId } = await registerBody(app, device, { counter: 1 });
    expect((await call(REGISTER, { headers: vaultHeaders(app), body })).status).toBe(201);
    expect(await counterOf(device.shareId!)).toBe(1);
    // The exact request replayed: the id is taken.
    await expectCode(await call(REGISTER, { headers: vaultHeaders(app), body }), 409, 'consent_exists');
    // Once pruned, the same signed request is still dead: its counter is used.
    await env.DB.prepare('DELETE FROM vault_consents WHERE consent_id = ?1').bind(Uint8Array.from(consentId)).run();
    await expectCode(await call(REGISTER, { headers: vaultHeaders(app), body }), 409, 'bad_counter');
    expect(await counterOf(device.shareId!)).toBe(1);
    expect(await stored(consentId)).toBeNull();
  });

  it('refuses a wrong counter without touching the consent table', async () => {
    const { app, device } = await setup('session');
    const { res, consentId } = await register(app, device, { counter: 5 });
    const body = await expectCode(res, 409, 'bad_counter');
    expect(body.expected).toBe(1);
    expect(await stored(consentId)).toBeNull();
  });

  it('a revoke replayed with a used counter changes nothing', async () => {
    const { app, device } = await setup('session');
    const first = await register(app, device);
    const second = await register(app, device, { counter: 2 });
    const body = await revokeBody(app, device, second.consentId, { counter: 3 });
    expect((await call(REVOKE, { headers: vaultHeaders(app), body })).status).toBe(200);
    await expectCode(await call(REVOKE, { headers: vaultHeaders(app), body }), 409, 'bad_counter');
    expect(await counterOf(device.shareId!)).toBe(3);
    expect((await stored(first.consentId))!.revoked_at).not.toBeNull();
  });

  it('refuses a dead share, one for another parent, and a share id that is not the session’s', async () => {
    const { app, near, device } = await setup('session');
    await setShare(device.shareId!, { revoked_at: Date.now() });
    await expectCode((await register(app, device)).res, 410, 'session_ended');

    const other = await newDevice('session', app, near);
    const mine = await newDevice('session', app, near);
    await expectCode((await register(app, { spk: mine.spk, shareId: other.shareId })).res, 404, 'unknown_share');
    expect(await counterOf(other.shareId!)).toBe(0);
    await expectCode((await register(app, { spk: mine.spk, shareId: null })).res, 404, 'unknown_share');
  });

  it('a session-mode consent can’t be registered against another user’s share (their key is needed)', async () => {
    const { app, near, device } = await setup('session');
    const attacker = await newDevice('session', app, near, 'attacker');
    // The attacker's key, the victim's share.
    await expectCode((await register(app, { spk: attacker.spk, shareId: device.shareId })).res, 404, 'unknown_share');
    // The victim's key without the victim's key material.
    await expectCode((await register(app, device, { signWith: attacker.spk })).res, 401, 'invalid_signature');
    expect(await counterOf(device.shareId!)).toBe(0);
  });

  it('the expiry bound is the share: a consent can’t outlive its share’s absolute end', async () => {
    const { app, device } = await setup('session');
    const capAt = Date.now() + HOUR / 2;
    await setShare(device.shareId!, { abs_expires_at: capAt });
    const refused = await expectCode((await register(app, device, { expiresAtMs: Date.now() + HOUR })).res, 400, 'bad_expiry');
    expect(refused.maxExpiresAtMs).toBe(capAt);
    expect((await register(app, device, { expiresAtMs: Date.now() + HOUR / 4 })).res.status).toBe(201);
  });

  it('the status read treats a consent as dead with its share: revoked, expired, idle, shortened, persistence off, origin removed, row gone', async () => {
    const dead: [string, (app: SeededApp, shareId: number[]) => Promise<unknown>][] = [
      ['revoked', (_, id) => setShare(id, { revoked_at: Date.now() })],
      ['absolute expiry', (_, id) => setShare(id, { abs_expires_at: Date.now() - 1 })],
      ['idle', (_, id) => setShare(id, { idle_until: Date.now() - 1 })],
      ['a lowered TTL', (app, id) => setSettings(app.id, { session_ttl_ms: HOUR, idle_ttl_ms: HOUR }).then(() => setShare(id, { created_at: Date.now() - 2 * HOUR }))],
      ['persistence off', (app) => setSettings(app.id, { persistence: 'none' })],
      ['row deleted', (_, id) => env.DB.prepare('DELETE FROM vault_shares WHERE share_id = ?1').bind(Uint8Array.from(id)).run()],
    ];
    for (const [name, kill] of dead) {
      const { app, near, device } = await setup('session');
      const { consentId } = await register(app, device);
      expect((await appStatus(app, near, consentId)).consent, name).toBe('active');
      await kill(app, device.shareId!);
      expect((await appStatus(app, near, consentId)).consent, name).toBe('revoked');
    }
  });

  it('reads revoked when the share’s origin is removed from the app, asked under another origin still allowed', async () => {
    const second = 'https://second.example.com';
    const { app, near, device } = await setup('session', { origins: [ORIGIN, second] });
    const { consentId } = await register(app, device);
    await env.DB.prepare('DELETE FROM app_origins WHERE app_id = ?1 AND origin = ?2').bind(app.id, ORIGIN).run();
    near.clients[`client-${app.scope}`] = app.scope;
    const res = await call('/v1/app', { method: 'GET', headers: { 'x-hana-key': app.key, origin: VAULT, 'x-hana-parent-origin': second, 'x-hana-consent': base64UrlEncode(Uint8Array.from(consentId)) } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { consent: string }).consent).toBe('revoked');
  });

  it('a revoked share’s revoke still answers the share’s own refusal', async () => {
    const { app, device } = await setup('session');
    const { consentId } = await register(app, device);
    await setShare(device.shareId!, { revoked_at: Date.now() });
    await expectCode(await revoke(app, device, consentId), 410, 'share_revoked');
  });
});

describe('none mode', () => {
  it('refuses an app that keeps logins (a session with no share is not a none-mode session)', async () => {
    const { app, near } = await setup('session');
    const device = { spk: spentSession(near, app.scope), shareId: null };
    await expectCode((await register(app, device)).res, 410, 'session_ended');
    expect(await env.DB.prepare('SELECT 1 FROM vault_consents WHERE app_id = ?1').bind(app.id).first()).toBeNull();
  });

  it('refuses a session that has a share, even with no share id given (another app of the scope, D178)', async () => {
    const { app, near, device } = await setup('session');
    const none = await seedApp({ scope: app.scope, origins: [ORIGIN] });
    await setSettings(none.id, { persistence: 'none', auto_approve_policy: JSON.stringify(POLICY) });
    await expectCode((await register(none, { spk: device.spk, shareId: null }, {})).res, 410, 'session_ended');
    expect(near.viewCalls.filter((c) => c.method === 'get_session')).toHaveLength(1); // Refused before any further chain read.
  });

  it('refuses a session in another scope, an unknown session and an expired session', async () => {
    const { app, near } = await setup('none');
    const foreign = spentSession(near, 'other-scope');
    await expectCode((await register(app, { spk: foreign, shareId: null })).res, 403, 'scope_mismatch');
    await expectCode((await register(app, { spk: newSessionKey(), shareId: null })).res, 503, 'session_not_visible');
    const expired = spentSession(near, app.scope, { expiresAtMs: Date.now() - 1 });
    await expectCode((await register(app, { spk: expired, shareId: null })).res, 410, 'session_ended');
  });

  it('a session the chain has not shown costs one read and answers a retryable 503; once visible, the same request registers', async () => {
    const { app, near } = await setup('none');
    const spk = newSessionKey();
    near.viewCalls.length = 0;
    const started = Date.now();
    const { res } = await register(app, { spk, shareId: null });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('1');
    expect(((await res.json()) as { code: string }).code).toBe('session_not_visible');
    expect(near.viewCalls.filter((c) => c.method === 'get_session')).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(250);
    near.sessions.set(JSON.stringify(spk), { path: pathFor(app.scope), scope_id: app.scope, expires_at_ms: Date.now() + 12 * HOUR, max_uses: 1, used: 1 });
    expect((await register(app, { spk, shareId: null })).res.status).toBe(201);
  });

  it('the expiry bound is the chain session', async () => {
    const { app, near } = await setup('none');
    const spk = spentSession(near, app.scope, { expiresAtMs: Date.now() + HOUR });
    await expectCode((await register(app, { spk, shareId: null }, { expiresAtMs: Date.now() + 2 * HOUR })).res, 400, 'bad_expiry');
  });

  it('a replay can’t bring a revoked consent back: the primary key holds until it expires (D510)', async () => {
    const { app, device } = await setup('none');
    const { body, consentId } = await registerBody(app, device);
    expect((await call(REGISTER, { headers: vaultHeaders(app), body })).status).toBe(201);
    expect((await revoke(app, device, consentId)).status).toBe(200);
    await expectCode(await call(REGISTER, { headers: vaultHeaders(app), body }), 409, 'consent_exists');
    // An hourly run an hour after the revoke keeps it: the row is the replay check.
    await setConsent(consentId, { revoked_at: Date.now() - CONSENT_REVOKED_KEEP_MS - 1 });
    await pruneConsents(env.DB, Date.now());
    expect(await stored(consentId)).not.toBeNull();
    await expectCode(await call(REGISTER, { headers: vaultHeaders(app), body }), 409, 'consent_exists');
    expect((await stored(consentId))!.revoked_by).toBe('device');
  });

  it('counter must be 0 and shareId absent', async () => {
    const { app, device } = await setup('none');
    const { body } = await registerBody(app, device);
    await expectCode(await call(REGISTER, { headers: vaultHeaders(app), body: { ...body, counter: 1 } }), 400, 'bad_request');
    await expectCode(await call(REGISTER, { headers: vaultHeaders(app), body: { ...body, shareId: Array(16).fill(0) } }), 400, 'bad_request');
  });
});

describe('the status read on GET /v1/app', () => {
  it('is absent without the header, from a non-vault origin, and when D1 fails (never unknown)', async () => {
    const { app, near, device } = await setup('session');
    const { consentId } = await register(app, device);
    expect((await appStatus(app, near, null)).consent).toBeUndefined();
    expect((await appStatus(app, near, consentId, ORIGIN)).consent).toBeUndefined();
    const failing = { ...env.DB, prepare: (sql: string) => {
      if (sql.includes('vault_consents')) throw new Error('D1 down');
      return env.DB.prepare(sql);
    } };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const body = await appStatus(app, near, consentId, VAULT, { DB: failing as unknown as D1Database });
    expect(body.consent).toBeUndefined();
    expect(warn.mock.calls.map(([l]) => JSON.parse(String(l)).event)).toContain('consent_status_unavailable');
  });

  it('a malformed id reads unknown with no D1 read', async () => {
    const { app, near } = await setup('session');
    const prepare = vi.spyOn(env.DB, 'prepare');
    for (const bad of ['!!!', 'AAAA', base64UrlEncode(new Uint8Array(17))]) expect((await appStatus(app, near, bad)).consent).toBe('unknown');
    expect(prepare.mock.calls.some(([sql]) => sql.includes('vault_consents'))).toBe(false);
  });

  it('allows the header in the preflight and keeps older clients unchanged', async () => {
    const { app, near } = await setup('session');
    const pre = await call('/v1/app', { method: 'OPTIONS', headers: { origin: VAULT, 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-hana-consent' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-headers')).toContain('x-hana-consent');
    const old = await appStatus(app, near, null);
    expect(old).not.toHaveProperty('consent');
    expect(old.serverTimeMs).toBeTypeOf('number');
  });
});

describe('POST /v1/vault/consents*: gate and limits', () => {
  it.each([REGISTER, REVOKE])('%s: preflight and gate are the vault origin only', async (path) => {
    const { app, device } = await setup('session');
    expect((await call(path, { method: 'OPTIONS', headers: { origin: VAULT } })).status).toBe(204);
    expect((await call(path, { method: 'OPTIONS', headers: { origin: ORIGIN } })).status).toBe(403);
    const { body } = await registerBody(app, device);
    await expectCode(await call(path, { headers: { 'x-hana-key': app.key, origin: ORIGIN, 'x-hana-parent-origin': ORIGIN }, body }), 403, 'origin_not_allowed');
    await expectCode(await call(path, { headers: vaultHeaders(app, 'https://evil.example'), body }), 403, 'origin_not_allowed');
    await expectCode(await call(path, { headers: { origin: VAULT, 'x-hana-parent-origin': ORIGIN }, body }), 401, 'missing_key');
    expect((await call(path, { headers: vaultHeaders(app), rawBody: 'not json' })).status).toBe(400);
    await expectCode(await call(path, { headers: vaultHeaders(app), body: { ...body, extra: 1 } }), 400, 'bad_request');
    await expectCode(await call(path, { headers: vaultHeaders(app), body: { ...body, consentId: [1, 2] } }), 400, 'bad_request');
    await expectCode(await call(path, { headers: vaultHeaders(app), body: { ...body, counter: 0 } }), 400, 'bad_request');
    await expectCode(await call(path, { method: 'GET', headers: vaultHeaders(app) }), 405, 'method_not_allowed');
  });

  it('refuses a suspended app', async () => {
    const { app, device } = await setup('session');
    await env.DB.prepare('UPDATE apps SET suspended_by = 1 WHERE id = ?1').bind(app.id).run();
    forgetCachedApps();
    await expectCode((await register(app, device)).res, 403, 'app_suspended');
  });

  it('per-share limit (10 a minute), and a limiter that fails refuses', async () => {
    const { app, device } = await setup('session');
    const no = { limit: async () => ({ success: false }) } as unknown as RateLimit;
    const { res } = await register(app, device, { env: { VAULT_SHARE_LIMIT: no } });
    await expectCode(res, 429, 'rate_limited');
    const down = { limit: async () => { throw new Error('down'); } } as unknown as RateLimit;
    await expectCode((await register(app, device, { env: { VAULT_SHARE_LIMIT: down } })).res, 503, 'rate_limiter_unavailable');
    await expectCode((await register(app, device, { env: { VAULT_IP_LIMIT: no } })).res, 429, 'rate_limited');
  });

  it.each(['session', 'none'] as const)('%s mode: a bad signature does not spend the window, on register or revoke', async (mode) => {
    const { app, device } = await setup(mode);
    const seen: string[] = [];
    const recording = { limit: async ({ key }: { key: string }) => { seen.push(key); return { success: true }; } } as unknown as RateLimit;
    const envOverride = { VAULT_SHARE_LIMIT: recording };
    const wrongKey = newSessionKey();
    const reg = await registerBody(app, device, { signWith: wrongKey });
    await expectCode(await call(REGISTER, { headers: vaultHeaders(app), body: reg.body, env: envOverride }), 401, 'invalid_signature');
    const rev = await revokeBody(app, device, newConsentId(), { signWith: wrongKey });
    await expectCode(await call(REVOKE, { headers: vaultHeaders(app), body: rev, env: envOverride }), 401, 'invalid_signature');
    expect(seen).toEqual([]);
    expect((await register(app, device, { env: envOverride })).res.status).toBe(201);
    expect(seen).toHaveLength(1);
  });

  it('the per-IP limit comes before the signature, so unsigned floods can’t buy signature checks', async () => {
    const { app, device } = await setup('none');
    const no = { limit: async () => ({ success: false }) } as unknown as RateLimit;
    const { body } = await registerBody(app, device, { signWith: newSessionKey() });
    await expectCode(await call(REGISTER, { headers: vaultHeaders(app), body, env: { VAULT_IP_LIMIT: no } }), 429, 'rate_limited');
  });

  it('none mode counts the per-share limit under the session key', async () => {
    const { app, device } = await setup('none');
    const keys: string[] = [];
    const recording = { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: true }; } } as unknown as RateLimit;
    expect((await register(app, device, { env: { VAULT_SHARE_LIMIT: recording } })).res.status).toBe(201);
    expect(keys).toEqual([`${env.ENV_NAME}:vault-share:${app.id}:${[...device.spk].map((b) => b.toString(16).padStart(2, '0')).join('')}`]);
  });

  it('never logs a consent id, a session key or a body', async () => {
    const lines: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation((l) => void lines.push(String(l)));
    const { app, near, device } = await setup('session');
    const { consentId } = await register(app, device);
    await revoke(app, device, consentId);
    await appStatus(app, near, consentId);
    const text = lines.join('\n');
    expect(text).toContain('/v1/vault/consents');
    for (const banned of ['consentId', 'x-hana-consent', 'sessionPublicKey', base64UrlEncode(Uint8Array.from(consentId))]) expect(text).not.toContain(banned);
  });
});

describe('a session key’s consent cap', () => {
  const seedRows = async (app: SeededApp, device: Device, n: number): Promise<void> => {
    const pathHashBytes = Uint8Array.from(await pathHash(pathFor(app.scope)));
    const now = Date.now();
    for (let i = 0; i < n; i++) {
      await env.DB.prepare(
        `INSERT INTO vault_consents (consent_id, app_id, share_id, session_pk, path_hash, partner_origin, policy_id, label, granted_at, expires_at, revoked_at, revoked_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'x', ?8, ?9, ?8, 'device')`,
      )
        .bind(Uint8Array.from(newConsentId()), app.id, device.shareId ? Uint8Array.from(device.shareId) : null, Uint8Array.from(device.spk), pathHashBytes, ORIGIN, Uint8Array.from(POLICY_ID), now, now + HOUR)
        .run();
    }
  };

  it.each(['session', 'none'] as const)('%s mode: at the cap a register is refused and writes nothing; below it, it works', async (mode) => {
    const { app, device } = await setup(mode);
    await seedRows(app, device, CONSENT_MAX_PER_SESSION_KEY);
    const { res, consentId } = await register(app, device);
    await expectCode(res, 429, 'too_many_consents');
    expect(await stored(consentId)).toBeNull();
    if (device.shareId) expect(await counterOf(device.shareId)).toBe(0);

    const { app: other, device: below } = await setup(mode);
    await seedRows(other, below, CONSENT_MAX_PER_SESSION_KEY - 1);
    expect((await register(other, below)).res.status).toBe(201);
  });

  it('a revoke is never capped, and another session key of the same account is unaffected', async () => {
    const { app, near, device } = await setup('none');
    const { consentId } = await register(app, device);
    await seedRows(app, device, CONSENT_MAX_PER_SESSION_KEY);
    expect((await revoke(app, device, consentId)).status).toBe(200);
    expect((await register(app, await newDevice('none', app, near))).res.status).toBe(201);
  });
});

describe('device label', () => {
  const create = async (app: SeededApp, near: Chain, label: unknown): Promise<number[]> => {
    const spk = spentSession(near, app.scope);
    const res = await call('/v1/vault/shares', { headers: vaultHeaders(app), body: { ...(await createShareBody(spk, app.id)), deviceLabel: label } });
    expect(res.status).toBe(201);
    return ((await res.json()) as { shareId: number[] }).shareId;
  };
  const labelOf = async (shareId: number[]): Promise<unknown> => (await env.DB.prepare('SELECT device_label FROM vault_shares WHERE share_id = ?1').bind(Uint8Array.from(shareId)).first<{ device_label: string | null }>())!.device_label;

  it('is stored when the vault sends a coarse one; an older vault sends none', async () => {
    const { app, near } = await vaultSetup();
    expect(await labelOf(await create(app, near, 'Chrome on macOS'))).toBe('Chrome on macOS');
    const spk = spentSession(near, app.scope);
    const res = await call('/v1/vault/shares', { headers: vaultHeaders(app), body: await createShareBody(spk, app.id) });
    expect(res.status).toBe(201);
    expect(await labelOf(((await res.json()) as { shareId: number[] }).shareId)).toBeNull();
  });

  it('a label that is too long or not plain is dropped and never fails the login', async () => {
    const { app, near } = await vaultSetup();
    for (const bad of ['x'.repeat(41), '<img src=x>', 'Chrome\non macOS', '', 7, null, { a: 1 }]) expect(await labelOf(await create(app, near, bad))).toBeNull();
  });

  it('a share body with any other extra key is still refused', async () => {
    const { app, near } = await vaultSetup();
    const spk = spentSession(near, app.scope);
    const res = await call('/v1/vault/shares', { headers: vaultHeaders(app), body: { ...(await createShareBody(spk, app.id)), deviceLabel: 'Chrome on macOS', extra: 1 } });
    await expectCode(res, 400, 'bad_request');
  });

  it('is deleted with the share (the tombstone rule is unchanged)', async () => {
    const { app, near } = await vaultSetup();
    const shareId = await create(app, near, 'Safari on iOS');
    await setShare(shareId, { revoked_at: Date.now(), created_at: Date.now() - SHARE_TOMBSTONE_MS - 1000 });
    await pruneShares(env.DB, Date.now());
    expect(await storedShare(shareId)).toBeNull();
  });
});

describe('the hourly prune', () => {
  it('deletes consents past their expiry and session-mode revoked ones after an hour, keeps the rest', async () => {
    await env.DB.prepare('DELETE FROM vault_consents').run();
    const now = Date.now();
    const { app, device } = await setup('session');
    const active = await register(app, device, { counter: 1 });

    const insert = async (fields: Partial<StoredConsent> & { share?: boolean } = {}): Promise<number[]> => {
      const consentId = newConsentId();
      const sessionPk = crypto.getRandomValues(new Uint8Array(32));
      await env.DB.prepare(
        `INSERT INTO vault_consents (consent_id, app_id, share_id, session_pk, path_hash, partner_origin, policy_id, label, granted_at, expires_at, revoked_at, revoked_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      )
        .bind(Uint8Array.from(consentId), app.id, fields.share === false ? null : Uint8Array.from(device.shareId!), sessionPk, new Uint8Array(32), ORIGIN, new Uint8Array(32), 'L', now - HOUR, fields.expires_at ?? now + HOUR, fields.revoked_at ?? null, fields.revoked_by ?? null)
        .run();
      return consentId;
    };
    const keep = [
      await insert({ revoked_at: now - CONSENT_REVOKED_KEEP_MS + 60_000, revoked_by: 'home' }), // Revoked recently.
      await insert({ share: false, revoked_at: now - 2 * HOUR, revoked_by: 'device' }), // 'none' mode: kept until expiry.
    ];
    const gone = [
      await insert({ expires_at: now - 1 }),
      await insert({ expires_at: now - 1, share: false }),
      await insert({ expires_at: now - 1, revoked_at: now - 10, revoked_by: 'device' }),
      await insert({ revoked_at: now - CONSENT_REVOKED_KEEP_MS - 1, revoked_by: 'share' }),
    ];
    const { prunedConsents, pruned } = await vaultMaintenance(env, now);
    expect(prunedConsents).toBe(gone.length);
    expect(pruned).toBe(0); // Shares keep their own 24-hour tombstones (D178).
    for (const id of gone) expect(await stored(id)).toBeNull();
    for (const id of keep) expect(await stored(id)).not.toBeNull();
    expect(await stored(active.consentId)).not.toBeNull();
  });
});

describe('migration 0017', () => {
  it('one active consent per session key, enforced by the table too', async () => {
    const { app } = await vaultSetup();
    const sessionPk = crypto.getRandomValues(new Uint8Array(32));
    const row = (id: Uint8Array, revokedAt: number | null) =>
      env.DB.prepare(
        `INSERT INTO vault_consents (consent_id, app_id, session_pk, path_hash, partner_origin, policy_id, label, granted_at, expires_at, revoked_at, revoked_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'L', 1, 2, ?7, ?8)`,
      )
        .bind(id, app.id, sessionPk, new Uint8Array(32), ORIGIN, new Uint8Array(32), revokedAt, revokedAt === null ? null : 'device')
        .run();
    await row(crypto.getRandomValues(new Uint8Array(16)), 1);
    await row(crypto.getRandomValues(new Uint8Array(16)), null);
    await expect(row(crypto.getRandomValues(new Uint8Array(16)), null)).rejects.toThrow();
  });

  it('the path hash is sha256 of the session path, and deleting an app removes its consents', async () => {
    const { app, device } = await setup('none');
    const { consentId } = await register(app, device);
    expect(arr((await stored(consentId))!.path_hash)).toEqual([...(await sha256(new TextEncoder().encode(pathFor(app.scope))))]);
    await env.DB.prepare('DELETE FROM apps WHERE id = ?1').bind(app.id).run();
    expect(await stored(consentId)).toBeNull();
  });
});
