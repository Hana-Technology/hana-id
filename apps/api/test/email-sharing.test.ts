// Email sharing with partners (D411, D418–D421; docs/email-sharing-spec.md): the app setting, the consent endpoints,
// the identity token's `email` claim, ConsoleRpc's Email column and search, updateSettings and retention.
import { identitySub } from '@hana-id/core/identity';
import { internalIdOf, supportCodeOf } from '@hana-id/console-core';
import { type EmailConsentAction, emailConsentPayload, identityMessage } from '@hana-id/core/identity';
import { parseSealKey, sealEmail } from '@hana-id/email/sealed';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetCachedApps } from '../src/app-cache.ts';
import { base64Decode } from '../src/bytes.ts';
import { purgeDirectory } from '../src/changes/retention.ts';
import { HotDb } from '../src/changes/db.ts';
import { EMAIL_CONSENT_ENDPOINTS, appIdentityEmail, consentAddress, emailKeys, emailMac, isFullAddressTerm, toConsentBody } from '../src/identity/email.ts';
import { clearIdentitySignerCache } from '../src/identity/signer.ts';
import { ORIGIN, type SeededApp, call, sessionKeyPair, uid } from './helpers.ts';
import { mint, verifyToken } from './identity-helpers.ts';
import { adminRpc, consoleRpc, member, newOrg, orgApp, rid, system } from './rpc-helpers.ts';
import { type Share, createShare, setSettings, vaultHeaders, vaultSetup } from './vault-helpers.ts';

afterEach(() => {
  vi.restoreAllMocks();
  clearIdentitySignerCache();
});

const AUTH = 'https://auth.test';
type Body = Record<string, unknown>;
const json = async (res: Response): Promise<Body> => (await res.json()) as Body;

/** What the issuer would hand the vault for this session (D418): the address sealed for the app and session key. */
async function sealed(app: { id: string }, spk: number[], email: string, o: { notAfterMs?: number; key?: string } = {}): Promise<string> {
  const key = (await parseSealKey(o.key ?? env.IDENTITY_SEAL_KEY))!;
  return sealEmail(key, { appId: app.id, sessionPublicKey: Uint8Array.from(spk), notAfterMs: o.notAfterMs ?? Date.now() + 3_600_000, email, src: 'google' });
}

interface ConsentOptions {
  sealedEmail?: string;
  decision?: 'granted' | 'declined';
  parent?: string;
  /** Sign for this action instead of the endpoint's own. */
  signAction?: EmailConsentAction;
  issuedAtMs?: number;
  nonce?: Uint8Array;
  origin?: string | null;
  env?: Partial<typeof env>;
  mutate?: (b: Body) => void;
}

const ACTION: Record<string, EmailConsentAction> = {
  [EMAIL_CONSENT_ENDPOINTS.state]: 'state',
  [EMAIL_CONSENT_ENDPOINTS.revoke]: 'revoke',
  [EMAIL_CONSENT_ENDPOINTS.preview]: 'preview',
};

/** A consent call signed by the session key, as the vault signs it. */
async function consent(app: SeededApp, spk: number[], endpoint: string, o: ConsentOptions = {}): Promise<Response> {
  const parent = o.parent ?? ORIGIN;
  const action = o.signAction ?? ACTION[endpoint] ?? (o.decision as EmailConsentAction);
  const nonce = o.nonce ?? crypto.getRandomValues(new Uint8Array(16));
  const issuedAtMs = o.issuedAtMs ?? Date.now();
  const message = identityMessage({ signer: env.SIGNER_ACCOUNT, appId: app.id, sessionPublicKey: Uint8Array.from(spk), issuedAtMs, nonce, payload: emailConsentPayload({ action, parentOrigin: parent, sealedEmail: o.sealedEmail ?? null }) });
  const body: Body = { sessionPublicKey: spk, issuedAtMs, nonce: [...nonce], signature: [...sessionKeyPair(spk).sign(message).signature], ...(o.sealedEmail ? { sealedEmail: o.sealedEmail } : {}), ...(o.decision ? { decision: o.decision } : {}) };
  o.mutate?.(body);
  const origin = o.origin === undefined ? (endpoint === EMAIL_CONSENT_ENDPOINTS.preview ? AUTH : 'https://vault.test') : o.origin;
  return call(endpoint, { headers: vaultHeaders(app, parent, origin), body, env: o.env });
}

/** A 'session'-mode app with `identity_email` set, and a live share for a Google user. */
async function setup(setting: 'off' | 'on_request' | 'at_login' = 'at_login', sub = `g-${uid()}`): Promise<{ app: SeededApp; share: Share; spk: number[]; sub: string; near: Awaited<ReturnType<typeof vaultSetup>>['near'] }> {
  const { app, near } = await vaultSetup();
  await setSettings(app.id, { identity_email: setting, persistence: 'session' });
  forgetCachedApps();
  const share = await createShare(app, near, { sub });
  return { app, share, spk: share.spk, sub, near };
}

const userSubOf = (scope: string, sub: string): string => identitySub(base64Decode(env.IDENTITY_SUB_KEY!), scope, { provider: 'google', sub });

async function stateOf(app: SeededApp, spk: number[], sealedEmail?: string): Promise<Body> {
  const res = await consent(app, spk, EMAIL_CONSENT_ENDPOINTS.state, sealedEmail ? { sealedEmail } : {});
  expect(res.status).toBe(200);
  return json(res);
}

async function claimsOf(app: SeededApp, spk: number[], sealedEmail?: string): Promise<{ status: unknown; claims: Body }> {
  const res = await mint(app, spk, sealedEmail ? { sealedEmail } : {});
  expect(res.status).toBe(200);
  const b = await json(res);
  return { status: b.emailStatus, claims: (await verifyToken(b.identityToken as string)).claims };
}

describe('the app setting (migration 0012)', () => {
  it("defaults to 'off'; GET /v1/app answers it", async () => {
    const { seedApp, chain } = await import('./helpers.ts');
    const app = await seedApp();
    chain({ [`aud-${uid()}.apps.googleusercontent.com`]: app.scope });
    expect(await appIdentityEmail(env.DB, app.id)).toBe('off');
    const res = await call('/v1/app', { method: 'GET', headers: { 'x-hana-key': app.key, origin: ORIGIN } });
    expect((await json(res)).identityEmail).toBe('off');
    await setSettings(app.id, { identity_email: 'at_login' });
    const again = await call('/v1/app', { method: 'GET', headers: { 'x-hana-key': app.key, origin: ORIGIN } });
    expect((await json(again)).identityEmail).toBe('at_login');
  });

  it("refuses any other value (the CHECK), and reads 'off' before the column exists", async () => {
    const { app } = await vaultSetup();
    await expect(setSettings(app.id, { identity_email: 'on' })).rejects.toThrow();
    const noColumn = { prepare: () => ({ bind: () => ({ first: () => Promise.reject(new Error('D1_ERROR: no such column: identity_email: SQLITE_ERROR')) }) }) } as unknown as D1Database;
    expect(await appIdentityEmail(noColumn, app.id)).toBe('off');
    const broken = { prepare: () => ({ bind: () => ({ first: () => Promise.reject(new Error('D1_ERROR: network')) }) }) } as unknown as D1Database;
    await expect(appIdentityEmail(broken, app.id)).rejects.toThrow('network');
  });

  it('is written by updateSettings (AdminRpc, ConsoleRpc), recorded in app_changes, shown in the app detail', async () => {
    const app = await orgApp();
    const read = async () => (await adminRpc().getApp({ ...system(), actor: { kind: 'hana', id: 'staff', email: 'staff@hana.example' }, orgId: app.org, appId: app.id })) as unknown as { ok: true; app: { settingsVersion: number; settings: Record<string, unknown> } };
    const before = await read();
    expect(before.app.settings.identityEmail).toBe('off');
    const r = await consoleRpc().updateSettings({ ...member(), orgId: app.org, appId: app.id, expectedVersion: before.app.settingsVersion, identityEmail: 'on_request' });
    expect(r).toMatchObject({ ok: true });
    expect((await read()).app.settings.identityEmail).toBe('on_request');
    const changes = await env.DB.prepare("SELECT kind, detail_json FROM app_changes WHERE app_id = ?1 AND kind = 'settings.changed' ORDER BY seq DESC LIMIT 1").bind(app.id).first<{ detail_json: string }>();
    expect(JSON.parse(changes!.detail_json)).toEqual({ identityEmail: 'on_request' });
    const bad = await consoleRpc().updateSettings({ ...member(), orgId: app.org, appId: app.id, expectedVersion: before.app.settingsVersion + 1, identityEmail: 'on' as 'off' });
    expect(bad).toMatchObject({ ok: false, code: 'bad_request' });
  });
});

describe('the consent endpoints', () => {
  it('state → grant → the token carries email and email_verified; a decline and a revoke take it out at once', async () => {
    const { app, spk } = await setup('at_login');
    const blob = await sealed(app, spk, 'Ada@Example.com');
    expect(await stateOf(app, spk, blob)).toMatchObject({ setting: 'at_login', state: 'not_asked' });
    expect(await claimsOf(app, spk, blob)).toMatchObject({ status: 'not_asked' });

    const granted = await consent(app, spk, EMAIL_CONSENT_ENDPOINTS.decide, { sealedEmail: blob, decision: 'granted' });
    expect(granted.status).toBe(200);
    expect((await json(granted)).state).toBe('granted');
    expect(await stateOf(app, spk, blob)).toMatchObject({ state: 'granted' });
    const { status, claims } = await claimsOf(app, spk, blob);
    expect(status).toBe('included');
    expect(claims.email).toBe('Ada@Example.com');
    expect(claims.email_verified).toBe(true);
    expect(Object.keys(claims)).toEqual(['iss', 'aud', 'sub', 'sid', 'iat', 'exp', 'jti', 'wallets', 'login_methods', 'email', 'email_verified']);

    // The stored copy (D411 point 4): exactly one granted row with the address; the MAC of the lowercased address.
    const rows = await env.DB.prepare('SELECT state, email, email_mac, user_sub, scope_id FROM email_consents WHERE app_id = ?1').bind(app.id).all<Body>();
    expect(rows.results).toHaveLength(1);
    const keys = await emailKeys(env);
    if (typeof keys === 'string') throw new Error(keys);
    expect(rows.results[0]).toMatchObject({ state: 'granted', email: 'Ada@Example.com', user_sub: claims.sub, scope_id: app.scope });
    expect([...new Uint8Array(rows.results[0]!.email_mac as ArrayBuffer)]).toEqual([...(await emailMac(keys.mac, 'ada@example.com'))]);

    const declined = await consent(app, spk, EMAIL_CONSENT_ENDPOINTS.decide, { sealedEmail: blob, decision: 'declined' });
    expect((await json(declined)).state).toBe('declined');
    expect(await claimsOf(app, spk, blob)).toMatchObject({ status: 'declined' });
    expect((await claimsOf(app, spk, blob)).claims.email).toBeUndefined();
    const row = await env.DB.prepare('SELECT state, email FROM email_consents WHERE app_id = ?1').bind(app.id).first<Body>();
    expect(row).toEqual({ state: 'declined', email: null });

    expect((await consent(app, spk, EMAIL_CONSENT_ENDPOINTS.decide, { sealedEmail: blob, decision: 'granted' })).status).toBe(200);
    const revoked = await consent(app, spk, EMAIL_CONSENT_ENDPOINTS.revoke);
    expect(await json(revoked)).toMatchObject({ state: 'declined', revoked: 1 });
    expect(await claimsOf(app, spk, blob)).toMatchObject({ status: 'declined' });
    expect(await claimsOf(app, spk)).toMatchObject({ status: 'missing' });
  });

  it('a consent covers only its address (D411 point 5); a session without a readable seal gets the latest shared one (D421)', async () => {
    const { app, near, spk, sub } = await setup('at_login');
    const gmail = await sealed(app, spk, 'ada@gmail.com');
    expect((await consent(app, spk, EMAIL_CONSENT_ENDPOINTS.decide, { sealedEmail: gmail, decision: 'granted' })).status).toBe(200);
    // The same account (another session of the same root) after linking a second address: asked again for it.
    const other = await createShare(app, near, { sub });
    const work = await sealed(app, other.spk, 'ada@work.com');
    expect(await stateOf(app, other.spk, work)).toMatchObject({ state: 'not_asked' });
    expect(await claimsOf(app, other.spk, work)).toMatchObject({ status: 'not_asked' });
    // No seal at all: the account's latest shared address.
    const noSeal = await claimsOf(app, other.spk);
    expect(noSeal.status).toBe('included');
    expect(noSeal.claims.email).toBe('ada@gmail.com');
    expect(await stateOf(app, other.spk)).toMatchObject({ state: 'granted' });
    // A seal it can't open (another session's): the same fallback, as `invalid` when nothing is shared.
    const invalid = await claimsOf(app, other.spk, gmail);
    expect(invalid).toMatchObject({ status: 'included' });
    // Sharing the second one too: tokens carry the session's own address.
    expect((await consent(app, other.spk, EMAIL_CONSENT_ENDPOINTS.decide, { sealedEmail: work, decision: 'granted' })).status).toBe(200);
    expect((await claimsOf(app, other.spk, work)).claims.email).toBe('ada@work.com');
    expect((await claimsOf(app, spk, gmail)).claims.email).toBe('ada@gmail.com');
    // A revoke covers every address of the app and account.
    expect(await json(await consent(app, other.spk, EMAIL_CONSENT_ENDPOINTS.revoke))).toMatchObject({ revoked: 2 });
    expect((await claimsOf(app, spk, gmail)).status).toBe('declined');
  });

  it('is per app (another app of the scope is asked again) and per account (the token sub)', async () => {
    const { app, near, spk, sub } = await setup('on_request');
    const blob = await sealed(app, spk, 'ada@example.com');
    expect((await consent(app, spk, EMAIL_CONSENT_ENDPOINTS.decide, { sealedEmail: blob, decision: 'granted' })).status).toBe(200);
    const { seedApp } = await import('./helpers.ts');
    const twin = await seedApp({ scope: app.scope });
    await setSettings(twin.id, { identity_email: 'on_request', persistence: 'session' });
    const twinShare = await createShare(twin, near, { sub });
    const twinBlob = await sealed(twin, twinShare.spk, 'ada@example.com');
    expect(await stateOf(twin, twinShare.spk, twinBlob)).toMatchObject({ state: 'not_asked' });
    expect((await claimsOf(twin, twinShare.spk, twinBlob)).claims.email).toBeUndefined();
    const someoneElse = await createShare(app, near, { sub: `g-${uid()}` });
    expect(await stateOf(app, someoneElse.spk, await sealed(app, someoneElse.spk, 'ada@example.com'))).toMatchObject({ state: 'not_asked' });
  });

  it("'off': no email in tokens whatever was granted; decisions and previews refused; a revoke still works", async () => {
    const { app, spk } = await setup('at_login');
    const blob = await sealed(app, spk, 'ada@example.com');
    expect((await consent(app, spk, EMAIL_CONSENT_ENDPOINTS.decide, { sealedEmail: blob, decision: 'granted' })).status).toBe(200);
    await setSettings(app.id, { identity_email: 'off' });
    expect(await claimsOf(app, spk, blob)).toMatchObject({ status: 'off' });
    expect((await claimsOf(app, spk, blob)).claims.email).toBeUndefined();
    expect(await stateOf(app, spk, blob)).toMatchObject({ setting: 'off', state: 'granted' });
    const refused = await consent(app, spk, EMAIL_CONSENT_ENDPOINTS.decide, { sealedEmail: blob, decision: 'granted' });
    expect({ status: refused.status, code: (await json(refused)).code }).toEqual({ status: 409, code: 'identity_email_off' });
    const preview = await consent(app, spk, EMAIL_CONSENT_ENDPOINTS.preview, { sealedEmail: blob });
    expect(preview.status).toBe(409);
    expect((await consent(app, spk, EMAIL_CONSENT_ENDPOINTS.revoke)).status).toBe(200);
  });

  it('preview: only from the auth popup, only the sealed address of this app and session', async () => {
    const { app, near, spk } = await setup('on_request');
    const blob = await sealed(app, spk, 'ada@example.com');
    const ok = await consent(app, spk, EMAIL_CONSENT_ENDPOINTS.preview, { sealedEmail: blob });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe(AUTH);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect((await json(ok)).email).toBe('ada@example.com');
    // From the vault's origin (or none): refused, so the vault frame never reads an address.
    const fromVault = await consent(app, spk, EMAIL_CONSENT_ENDPOINTS.preview, { sealedEmail: blob, origin: 'https://vault.test' });
    expect({ status: fromVault.status, code: (await json(fromVault)).code }).toEqual({ status: 403, code: 'origin_not_allowed' });
    // The decision endpoints from the popup's origin: refused (vault only).
    const fromPopup = await consent(app, spk, EMAIL_CONSENT_ENDPOINTS.decide, { sealedEmail: blob, decision: 'granted', origin: AUTH });
    expect(fromPopup.status).toBe(403);
    // Another session's blob, an expired one, one under an unknown key, garbage.
    const other = await createShare(app, near);
    for (const [bad, reason] of [
      [await sealed(app, other.spk, 'eve@example.com'), 'bad_seal'],
      [await sealed(app, spk, 'ada@example.com', { notAfterMs: Date.now() - 1 }), 'expired'],
      [await sealed(app, spk, 'ada@example.com', { key: `8:${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))}` }), 'unknown_key'],
      ['se1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'unknown_key'],
    ] as const) {
      const res = await consent(app, spk, EMAIL_CONSENT_ENDPOINTS.preview, { sealedEmail: bad });
      expect({ status: res.status, ...(await json(res)) }, reason).toMatchObject({ status: 400, code: 'email_unavailable', reason });
    }
  });

  it('the preflights: the preview for the auth origin, the others for the vault', async () => {
    const pre = (path: string, origin: string) => call(path, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST' } });
    expect((await pre(EMAIL_CONSENT_ENDPOINTS.preview, AUTH)).status).toBe(204);
    expect((await pre(EMAIL_CONSENT_ENDPOINTS.preview, 'https://vault.test')).status).toBe(403);
    expect((await pre(EMAIL_CONSENT_ENDPOINTS.decide, 'https://vault.test')).status).toBe(204);
    expect((await pre(EMAIL_CONSENT_ENDPOINTS.decide, AUTH)).status).toBe(403);
    expect((await call(EMAIL_CONSENT_ENDPOINTS.state, { method: 'GET' })).status).toBe(405);
  });

  it('the session proof: its own action, single use, ±60 s, the share and the chain session', async () => {
    const { app, near, spk, share } = await setup('at_login');
    const blob = await sealed(app, spk, 'ada@example.com');
    // Signed as a grant, sent as a revoke (and the other way): the payload names the action.
    const swapped = await consent(app, spk, EMAIL_CONSENT_ENDPOINTS.revoke, { signAction: 'granted' });
    expect((await json(swapped)).code).toBe('invalid_signature');
    const asDecline = await consent(app, spk, EMAIL_CONSENT_ENDPOINTS.decide, { sealedEmail: blob, decision: 'granted', signAction: 'declined' });
    expect((await json(asDecline)).code).toBe('invalid_signature');
    // The sealed address is covered: another blob with this signature fails.
    const other = await sealed(app, spk, 'eve@example.com');
    const moved = await consent(app, spk, EMAIL_CONSENT_ENDPOINTS.decide, { sealedEmail: blob, decision: 'granted', mutate: (b) => void (b.sealedEmail = other) });
    expect((await json(moved)).code).toBe('invalid_signature');
    // Another parent origin than the share's.
    const elsewhere = await consent(app, spk, EMAIL_CONSENT_ENDPOINTS.state, { parent: 'https://evil.example' });
    expect(elsewhere.status).toBe(403);
    // Replay.
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const issuedAtMs = Date.now();
    expect((await consent(app, spk, EMAIL_CONSENT_ENDPOINTS.state, { nonce, issuedAtMs })).status).toBe(200);
    const again = await consent(app, spk, EMAIL_CONSENT_ENDPOINTS.state, { nonce, issuedAtMs });
    expect((await json(again)).code).toBe('proof_replayed');
    // Stale.
    const stale = await consent(app, spk, EMAIL_CONSENT_ENDPOINTS.state, { issuedAtMs: Date.now() - 120_000 });
    expect((await json(stale)).code).toBe('stale_proof');
    // A revoked share, and a session gone from the chain.
    await env.DB.prepare('UPDATE vault_shares SET revoked_at = ?2 WHERE session_pk = ?1').bind(Uint8Array.from(spk), Date.now()).run();
    expect(await json(await consent(app, spk, EMAIL_CONSENT_ENDPOINTS.state))).toMatchObject({ code: 'session_ended', reason: 'share_revoked' });
    void share;
    const fresh = await createShare(app, near);
    near.sessions.delete(JSON.stringify(fresh.spk));
    const { clearViewCaches } = await import('../src/views.ts');
    clearViewCaches();
    expect((await json(await consent(app, fresh.spk, EMAIL_CONSENT_ENDPOINTS.state))).code).toBe('session_ended');
  });

  it('body shapes: exactly the fields of each endpoint', () => {
    const base = { sessionPublicKey: Array(32).fill(1), issuedAtMs: 1, nonce: Array(16).fill(2), signature: Array(64).fill(3) };
    expect(toConsentBody(EMAIL_CONSENT_ENDPOINTS.state, base)).not.toBeNull();
    expect(toConsentBody(EMAIL_CONSENT_ENDPOINTS.state, { ...base, sealedEmail: 'se1.x' })).not.toBeNull();
    expect(toConsentBody(EMAIL_CONSENT_ENDPOINTS.decide, { ...base, sealedEmail: 'se1.x' })).toBeNull();
    expect(toConsentBody(EMAIL_CONSENT_ENDPOINTS.decide, { ...base, sealedEmail: 'se1.x', decision: 'maybe' })).toBeNull();
    expect(toConsentBody(EMAIL_CONSENT_ENDPOINTS.decide, { ...base, sealedEmail: 'se1.x', decision: 'declined' })).not.toBeNull();
    expect(toConsentBody(EMAIL_CONSENT_ENDPOINTS.revoke, { ...base, sealedEmail: 'se1.x' })).toBeNull();
    expect(toConsentBody(EMAIL_CONSENT_ENDPOINTS.preview, base)).toBeNull();
    expect(toConsentBody(EMAIL_CONSENT_ENDPOINTS.state, { ...base, extra: 1 })).toBeNull();
    expect(toConsentBody(EMAIL_CONSENT_ENDPOINTS.state, { ...base, sealedEmail: 'x'.repeat(1025) })).toBeNull();
    expect(toConsentBody(EMAIL_CONSENT_ENDPOINTS.state, { ...base, nonce: Array(15).fill(0) })).toBeNull();
  });

  it('an env without the keys: 503 email_sharing_unavailable, and tokens carry no email', async () => {
    const { app, spk } = await setup('at_login');
    const blob = await sealed(app, spk, 'ada@example.com');
    for (const e of [{ EMAIL_CONSENT_KEY: '' }, { IDENTITY_SEAL_KEY: '' }, { EMAIL_CONSENT_KEY: 'short' }, { IDENTITY_SEAL_KEY: '0:x' }]) {
      const res = await consent(app, spk, EMAIL_CONSENT_ENDPOINTS.state, { sealedEmail: blob, env: e });
      expect((await json(res)).code, JSON.stringify(e)).toBe('email_sharing_unavailable');
    }
    const res = await mint(app, spk, { sealedEmail: blob, env: { EMAIL_CONSENT_KEY: '' } });
    expect((await json(res)).emailStatus).toBe('missing');
  });

  it('opens a blob sealed under the previous key during a rotation', async () => {
    const { app, spk } = await setup('at_login');
    const previous = env.IDENTITY_SEAL_KEY!;
    const blob = await sealed(app, spk, 'ada@example.com', { key: previous });
    const next = `9:${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))}`;
    const res = await consent(app, spk, EMAIL_CONSENT_ENDPOINTS.decide, { sealedEmail: blob, decision: 'granted', env: { IDENTITY_SEAL_KEY: next, IDENTITY_SEAL_KEY_PREVIOUS: previous } });
    expect(res.status).toBe(200);
    const without = await consent(app, spk, EMAIL_CONSENT_ENDPOINTS.decide, { sealedEmail: blob, decision: 'granted', env: { IDENTITY_SEAL_KEY: next } });
    expect((await json(without)).reason).toBe('unknown_key');
  });

  it('never logs an address, a blob or a sub', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((l: unknown) => void lines.push(String(l)));
    vi.spyOn(console, 'error').mockImplementation((l: unknown) => void lines.push(String(l)));
    vi.spyOn(console, 'warn').mockImplementation((l: unknown) => void lines.push(String(l)));
    const { app, spk, sub } = await setup('at_login');
    const blob = await sealed(app, spk, 'secret.person@example.com');
    await consent(app, spk, EMAIL_CONSENT_ENDPOINTS.decide, { sealedEmail: blob, decision: 'granted' });
    await consent(app, spk, EMAIL_CONSENT_ENDPOINTS.preview, { sealedEmail: blob });
    await mint(app, spk, { sealedEmail: blob });
    const text = lines.join('\n');
    expect(lines.length).toBeGreaterThan(0);
    expect(text).not.toContain('secret.person');
    expect(text).not.toContain(blob.slice(4, 30));
    expect(text).not.toContain(userSubOf(app.scope, sub));
  });
});

describe('ConsoleRpc: the Email column and the email search (D411, D315)', () => {
  /** A user of `org` in the wallet directory (the row the Users screen lists), with a session of its root. */
  async function partnerUser(org: string, near: Awaited<ReturnType<typeof vaultSetup>>['near'], setting: 'on_request' | 'at_login' = 'on_request') {
    const app = await orgApp({ org });
    await setSettings(app.id, { identity_email: setting, persistence: 'session' });
    forgetCachedApps();
    const sub = `g-${uid()}`;
    const share = await createShare(app, near, { sub });
    const userSub = userSubOf(app.scope, sub);
    const internal = internalIdOf(crypto.getRandomValues(new Uint8Array(16)));
    await env.DB.prepare('INSERT INTO end_users (user_id, token_sub, support_code, scope_id, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)').bind(internal, userSub, supportCodeOf(userSub), app.scope, Date.now()).run();
    return { app, spk: share.spk, userSub };
  }

  it('shows the shared address ("Not shared" is null), lists every share in the detail, finds a shared address only', async () => {
    const org = newOrg();
    const { chain } = await import('./helpers.ts');
    const near = chain();
    const a = await partnerUser(org, near);
    const b = await partnerUser(org, near);
    const asOrg = { ...member(), requestId: rid(), clientIp: '203.0.113.2', orgId: org };
    expect((await consent(a.app, a.spk, EMAIL_CONSENT_ENDPOINTS.decide, { sealedEmail: await sealed(a.app, a.spk, 'Ada@Example.com'), decision: 'granted' })).status).toBe(200);
    expect((await consent(b.app, b.spk, EMAIL_CONSENT_ENDPOINTS.decide, { sealedEmail: await sealed(b.app, b.spk, 'bob@example.com'), decision: 'declined' })).status).toBe(200);

    const list = (await consoleRpc().listUsers(asOrg)) as unknown as { ok: true; users: Body[] };
    const byId = new Map(list.users.map((u) => [u.userId, u]));
    expect(byId.get(a.userSub)!.email).toBe('Ada@Example.com');
    expect(byId.get(b.userSub)!.email).toBeNull();
    expect(Object.keys(byId.get(a.userSub)!).sort()).toEqual(['accounts', 'createdAt', 'email', 'lastSeenAt', 'scopeId', 'supportId', 'userId', 'wallets']);
    const got = (await consoleRpc().getUser({ ...asOrg, userId: a.userSub })) as unknown as { ok: true; user: Body };
    expect(got.user.emails).toEqual([{ appId: a.app.id, appName: `Test ${a.app.id}`, email: 'Ada@Example.com', sharedAt: expect.any(Number) }]);
    expect(((await consoleRpc().getUser({ ...asOrg, userId: b.userSub })) as unknown as { user: Body }).user.emails).toEqual([]);

    const search = async (term: string) => ((await consoleRpc().listUsers({ ...asOrg, requestId: rid(), search: term })) as unknown as { users: Body[] }).users.map((u) => u.userId);
    expect(await search('ada@example.com')).toEqual([a.userSub]);
    expect(await search('  ADA@EXAMPLE.COM ')).toEqual([a.userSub]);
    // A declined (unshared) address is never found, and no prefix or partial term is a search.
    expect(await search('bob@example.com')).toEqual([]);
    for (const partial of ['ada@', 'ada', 'example.com', '@example.com']) {
      const r = (await consoleRpc().listUsers({ ...asOrg, requestId: rid(), search: partial })) as unknown as { ok: boolean; code?: string };
      expect(r.ok, partial).toBe(false);
    }
    // Another org never sees it, by search or column.
    const other = { ...member(), requestId: rid(), clientIp: '203.0.113.2', orgId: newOrg() };
    expect(((await consoleRpc().listUsers({ ...other, search: 'ada@example.com' })) as unknown as { users: Body[] }).users).toEqual([]);

    // A revoke empties the column and the search at once.
    expect((await consent(a.app, a.spk, EMAIL_CONSENT_ENDPOINTS.revoke)).status).toBe(200);
    expect(((await consoleRpc().listUsers({ ...asOrg, requestId: rid() })) as unknown as { users: Body[] }).users.find((u) => u.userId === a.userSub)!.email).toBeNull();
    expect(await search('ada@example.com')).toEqual([]);
  });

  it('a deleted app’s shares leave the column at once and the table after the 30-day grace (retention)', async () => {
    const org = newOrg();
    const { chain } = await import('./helpers.ts');
    const a = await partnerUser(org, chain());
    expect((await consent(a.app, a.spk, EMAIL_CONSENT_ENDPOINTS.decide, { sealedEmail: await sealed(a.app, a.spk, 'ada@example.com'), decision: 'granted' })).status).toBe(200);
    const asOrg = { ...member(), requestId: rid(), clientIp: '203.0.113.2', orgId: org };
    const now = Date.now();
    await env.DB.prepare('UPDATE apps SET deleted_at = ?2 WHERE id = ?1').bind(a.app.id, now - 10 * 86_400_000).run();
    expect(((await consoleRpc().listUsers(asOrg)) as unknown as { users: Body[] }).users.find((u) => u.userId === a.userSub)!.email).toBeNull();
    const db = new HotDb(env.DB);
    expect((await purgeDirectory(db, { before: now, limit: 100 }, now)).emailConsents).toBe(0);
    await env.DB.prepare('UPDATE apps SET deleted_at = ?2 WHERE id = ?1').bind(a.app.id, now - 31 * 86_400_000).run();
    expect((await purgeDirectory(db, { before: now, limit: 100 }, now)).emailConsents).toBe(1);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM email_consents WHERE app_id = ?1').bind(a.app.id).first<{ n: number }>())!.n).toBe(0);
  });
});

describe('helpers', () => {
  it('compares addresses trimmed and lowercased; a search term is a full address only', () => {
    expect(consentAddress('  Ada@Example.COM ')).toBe('ada@example.com');
    for (const t of ['a@b', 'ada@example.com', ' ADA@x.io ']) expect(isFullAddressTerm(t), t).toBe(true);
    for (const t of ['', '@', 'a@', '@b', 'a@b@c', 'a b@c', 'ada', `${'a'.repeat(250)}@b.co`]) expect(isFullAddressTerm(t), t).toBe(false);
  });
});
