// Email login in the API (docs/email-login-build-plan.md batch 6, docs/email-login-spec.md "API changes"): email tokens
// on /v1/sessions and /v1/login, the D137 proof of possession on /v1/sessions, /v1/login's link precheck (D133), the
// email-login panics as errors, GET /v1/app's sign-in methods, and the link relays with share revocation.
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usageDay } from '../src/apps.ts';
import { fromHex, sha256 } from '../src/bytes.ts';
import { TGAS } from '../src/gas.ts';
import { LINK_ADDS_PER_IP_MINUTE, LINK_ADDS_PER_ROOT_MINUTE } from '../src/links.ts';
import { sessionStanding } from '../src/session-standing.ts';
import { clearViewCaches } from '../src/views.ts';
import { autoLinkNonce, createProofPayload, linkAccountNonce, linkChangeNonce, linkNewNonce, linkedCkdPayload, sessionNonce, sessionNoncePreimage } from '../src/session-crypto.ts';
import { EMAIL_ISS, type EmailChain, emailAud, emailEnv, emailSigner, emailToken, ikSync, issuer, setLoginMethods, withEmail } from './email-helpers.ts';
import { appHeaders, bytes, call, chain, google, newSessionKey, seedApp, sessionBody, signSession, uid } from './helpers.ts';
import { appKey, hanaHeaders, loginBody, withCombinedCall } from './login-helpers.ts';
import { panic } from './near-mock.ts';
import { ledger } from './usage-ledger.ts';
import { RECORD_EMAIL_SQL, syncEmailUsage } from '../src/usage/email-sync.ts';

afterEach(() => vi.restoreAllMocks());

const body = async (res: Response): Promise<Record<string, unknown>> => (await res.json()) as Record<string, unknown>;
const newAud = (): string => `${uid()}.apps.googleusercontent.com`;
const G_SUB = '1234567890';

/** An app with its own Google client and email on (D1 and chain), on a chain that runs the combined call. */
async function setup(methods = 'google,email') {
  const app = await seedApp();
  const aud = newAud();
  const near = withEmail(withCombinedCall(chain({ [aud]: app.scope })), [app.scope]);
  // create_session for an email token (the chain() mock reads a compact JWT's aud): the email path.
  const googleCreate = near.contract.create_session!;
  near.contract.create_session = (a, tx) => {
    const jwt = a.jwt as string;
    if (!jwt.startsWith('{')) return googleCreate(a, tx);
    const claims = JSON.parse(atob((JSON.parse(jwt) as { payload: string }).payload.replace(/-/gu, '+').replace(/_/gu, '/'))) as { sub: string };
    const session = { path: `${a.scope_id}#email#${claims.sub}#${a.key_index}`, scope_id: a.scope_id, expires_at_ms: a.expires_at_ms, max_uses: a.max_uses, used: 0 };
    near.sessions.set(JSON.stringify(a.session_public_key), session);
    return session;
  };
  await setLoginMethods(app.id, methods);
  return { app, aud, near };
}

/** A /v1/sessions body with an email token committing to it, and the session key's proof. */
async function emailSessionBody(scope: string, overrides: Record<string, unknown> = {}, claims: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const b: Record<string, unknown> = { sessionPublicKey: newSessionKey(), expiresAtMs: Date.now() + 3_600_000, salt: bytes(16, 3), keyIndex: 0, maxUses: 10, ...overrides };
  const input = { signer: env.SIGNER_ACCOUNT, scopeId: scope, sessionPublicKey: b.sessionPublicKey as number[], expiresAtMs: b.expiresAtMs as number, keyIndex: b.keyIndex as number, maxUses: b.maxUses as number, salt: b.salt as number[] };
  b.jwt = await emailToken({ aud: emailAud(scope), sub: 'e1.alice', nonce: await sessionNonce(input), ...claims });
  if (!('signature' in overrides)) b.signature = await signSession(input.sessionPublicKey, 0, await createProofPayload(input));
  return b;
}

async function emailUsage(appId: string): Promise<{ email_sessions: number; links: number } | null> {
  return env.DB.prepare('SELECT email_sessions, links FROM email_usage WHERE app_id = ?1 AND day = ?2').bind(appId, usageDay(Date.now())).first();
}

const sessions = (app: { key: string }, req: unknown, bindings: Partial<typeof env> = emailEnv()) => call('/v1/sessions', { headers: appHeaders(app), body: req, env: bindings });

describe('POST /v1/sessions: email tokens and the proof of possession (D137)', () => {
  it('relays an email token for an app with email on, with the proof as `signature`, and counts an email session', async () => {
    const { app, near } = await setup();
    const req = await emailSessionBody(app.scope);
    const res = await sessions(app, req);
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect((await body(res)).result).toMatchObject({ path: `${app.scope}#email#e1.alice#0` });
    const tx = near.sent[0]!;
    expect(tx.method).toBe('create_session');
    expect(tx.args.signature).toEqual(req.signature);
    expect(tx.args.jwt).toBe(req.jwt);
    expect(near.viewCalls.map((v) => v.method)).toContain('get_self_issued');
    expect(await emailUsage(app.id)).toEqual({ email_sessions: 1, links: 0 });
  });

  it('refuses an email token for a Google-only app, and everywhere without the env’s email issuer, before any relay', async () => {
    const { app, near } = await setup('google');
    const res = await sessions(app, await emailSessionBody(app.scope));
    expect([res.status, (await body(res)).code]).toEqual([403, 'login_method_disabled']);
    const off = await sessions(app, await emailSessionBody(app.scope), {});
    expect([off.status, (await body(off)).code]).toEqual([400, 'unsupported_issuer']);
    expect(near.sent).toHaveLength(0);
  });

  it('refuses a missing, wrong or misbound proof before any chain call (Google tokens too)', async () => {
    const { app, aud, near } = await setup();
    const other = newSessionKey();
    const g = await sessionBody(app.scope, aud);
    const input = { signer: env.SIGNER_ACCOUNT, scopeId: app.scope, sessionPublicKey: g.sessionPublicKey as number[], expiresAtMs: g.expiresAtMs as number, keyIndex: 0, maxUses: 10, salt: g.salt as number[] };
    const cases: [Record<string, unknown>, number, string][] = [
      [{ ...g, signature: undefined }, 400, 'bad_request'],
      [{ ...g, signature: bytes(63, 1) }, 400, 'bad_request'],
      [{ ...g, signature: bytes(64, 1) }, 401, 'invalid_signature'],
      // Another key's signature, the derive counter instead of 0, or the proof of another key_index.
      [{ ...g, signature: await signSession(other, 0, await createProofPayload(input)) }, 401, 'invalid_signature'],
      [{ ...g, signature: await signSession(input.sessionPublicKey, 1, await createProofPayload(input)) }, 401, 'invalid_signature'],
      [{ ...g, signature: await signSession(input.sessionPublicKey, 0, await createProofPayload({ ...input, keyIndex: 1 })) }, 401, 'invalid_signature'],
    ];
    for (const [req, status, code] of cases) {
      const res = await sessions(app, JSON.parse(JSON.stringify(req)));
      expect([res.status, (await body(res)).code], code).toEqual([status, code]);
    }
    expect(near.sent).toHaveLength(0);
    // The same body with the right proof goes through.
    expect((await sessions(app, g)).status).toBe(200);
  });

  it('an email key a pending change adds is issuer_key_pending (retry); one no change adds is token_stale; no policy view is near_unavailable', async () => {
    const { app, near } = await setup();
    near.policy = { signers: [{ id: 'hana', kids: [] }], required: 1 };
    near.views.get_key_changes = () => [{ id: 3, provider: 'email', kid: issuer.kid, op: 'Add', n: 'x', e: 'AQAB', signer: 'hana', by: 'owner', proposed_at_ms: 1, executable_at_ms: 2 }];
    const res = await sessions(app, await emailSessionBody(app.scope));
    expect([res.status, (await body(res)).code, res.headers.get('retry-after')]).toEqual([503, 'issuer_key_pending', '30']);
    // Removed, or a dropped signer's: waiting won't help (review L2).
    const { clearLinkViewCaches: clearCaches } = await import('../src/link-views.ts');
    clearCaches();
    near.views.get_key_changes = () => [];
    const stale = await sessions(app, await emailSessionBody(app.scope));
    expect([stale.status, (await body(stale)).code]).toEqual([401, 'token_stale']);
    delete near.views.get_self_issued;
    const { clearLinkViewCaches } = await import('../src/link-views.ts');
    clearLinkViewCaches();
    const v2 = await sessions(app, await emailSessionBody(app.scope));
    expect([v2.status, (await body(v2)).code]).toEqual([502, 'near_unavailable']);
    expect(near.sent).toHaveLength(0);
  });

  it('an email token of another scope’s client is scope_mismatch; an extra claim is refused', async () => {
    const { app, near } = await setup();
    const other = await seedApp();
    withEmail(near, [app.scope, other.scope]);
    const res = await sessions(app, await emailSessionBody(app.scope, {}, { aud: emailAud(other.scope) }));
    expect([res.status, (await body(res)).code]).toEqual([403, 'scope_mismatch']);
    const pii = await sessions(app, await emailSessionBody(app.scope, {}, { email: 'alice@example.com' }));
    expect([pii.status, (await body(pii)).code]).toEqual([401, 'invalid_token']);
    expect(near.sent).toHaveLength(0);
  });

  it('a pending member’s session is link_pending (the contract’s panic as an error)', async () => {
    const { app, near } = await setup();
    near.contract.create_session = () => panic('Sign-in method link is pending');
    const res = await sessions(app, await emailSessionBody(app.scope));
    expect([res.status, (await body(res)).code]).toEqual([409, 'link_pending']);
  });
});

/** A /v1/login body for a Google login carrying an email link token, signed over the linked CKD payload. */
async function linkedLogin(
  app: { scope: string },
  aud: string,
  link: { sub: string; join: 1 | 2; joiner: string; target: string; epoch?: number; immediate: boolean; mintMode?: boolean },
  sign: 'linked' | 'plain' = 'linked',
): Promise<Record<string, unknown>> {
  const key = appKey();
  const b = await loginBody(app.scope, aud, {}, {}, key);
  const input = { signer: env.SIGNER_ACCOUNT, scopeId: app.scope, sessionPublicKey: b.sessionPublicKey as number[], expiresAtMs: b.expiresAtMs as number, keyIndex: 0, maxUses: 1, salt: b.salt as number[] };
  const nonce = await autoLinkNonce({
    signer: env.SIGNER_ACCOUNT,
    scopeId: app.scope,
    sessionHash: await sha256(sessionNoncePreimage(input)),
    sessionIk: fromHex(ikSync(app.scope, 'google', G_SUB)),
    join: link.join,
    joinerIk: fromHex(link.joiner),
    targetRootIk: fromHex(link.target),
    targetEpoch: link.epoch ?? 0,
    immediate: link.mintMode ?? link.immediate,
  });
  const linkJwt = await emailToken({ aud: emailAud(app.scope), sub: link.sub, nonce });
  const payload = sign === 'linked' ? await linkedCkdPayload(key.pk1, key.pk2, linkJwt, link.immediate) : (await import('../src/session-crypto.ts')).ckdPayload(key.pk1, key.pk2);
  return { ...b, linkJwt, linkImmediate: link.immediate, signature: await signSession(b.sessionPublicKey as number[], 1, payload) };
}

const login = (app: { key: string }, req: unknown, bindings: Partial<typeof env> = emailEnv()) => call('/v1/login', { headers: hanaHeaders(app), body: req, env: bindings });

describe('POST /v1/login with a link (D133)', () => {
  /** Case A: the email identity E has a wallet, the Google identity G none: G joins E's account at once. */
  async function caseA() {
    const s = await setup();
    const e = 'e1.bob';
    s.near.identities.set(`email#${e}`, { status: 'own', opened: true });
    const g = ikSync(s.app.scope, 'google', G_SUB);
    const ek = ikSync(s.app.scope, 'email', e);
    return { ...s, e, g, ek };
  }

  it('case A: relays link_jwt and link_immediate with 250 Tgas, signed over the linked payload, and counts a link', async () => {
    const { app, aud, near, e, g, ek } = await caseA();
    const req = await linkedLogin(app, aud, { sub: e, join: 1, joiner: g, target: ek, immediate: true });
    const res = await login(app, req);
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    const tx = near.sent[0]!;
    expect(tx.method).toBe('create_session_and_derive');
    expect([tx.args.link_jwt, tx.args.link_immediate]).toEqual([req.linkJwt, true]);
    expect(tx.gas).toBe(250n * TGAS);
    expect(await emailUsage(app.id)).toEqual({ email_sessions: 0, links: 1 });
    // Read fresh: both identities and both accounts, and the session identity's standing once more (session-standing.ts).
    expect(near.viewCalls.filter((v) => v.method === 'get_identity' || v.method === 'get_account')).toHaveLength(5);
  });

  it('case B (the email identity joins the Google wallet), pending: relays with link_immediate false', async () => {
    const { app, aud, near } = await setup();
    near.identities.set(`google#${G_SUB}`, { status: 'own', opened: true });
    const e = 'e1.carol';
    const req = await linkedLogin(app, aud, { sub: e, join: 2, joiner: ikSync(app.scope, 'email', e), target: ikSync(app.scope, 'google', G_SUB), immediate: false });
    const res = await login(app, req);
    expect(res.status).toBe(200);
    expect(near.sent[0]!.args.link_immediate).toBe(false);
  });

  it('refuses a link the session key didn’t sign, a swapped or stale one, and a wrong mode, before any relay', async () => {
    const { app, aud, near, e, g, ek } = await caseA();
    const reasons: [Record<string, unknown>, number, string, string | undefined][] = [
      // Signed over the plain payload: whoever relays can't attach a link the user didn't sign.
      [await linkedLogin(app, aud, { sub: e, join: 1, joiner: g, target: ek, immediate: true }, 'plain'), 401, 'invalid_signature', undefined],
      // A token for case B while the chain says case A, a stale epoch, a token minted for the other mode.
      [await linkedLogin(app, aud, { sub: e, join: 2, joiner: ek, target: g, immediate: true }), 422, 'link_refused', 'link_mismatch'],
      [await linkedLogin(app, aud, { sub: e, join: 1, joiner: g, target: ek, epoch: 4, immediate: true }), 422, 'link_refused', 'link_mismatch'],
      [await linkedLogin(app, aud, { sub: e, join: 1, joiner: g, target: ek, immediate: false, mintMode: true }), 422, 'link_refused', 'link_mismatch'],
    ];
    for (const [req, status, code, reason] of reasons) {
      const res = await login(app, req);
      const b = await body(res);
      expect([res.status, b.code, b.reason], `${code} ${reason}`).toEqual([status, code, reason]);
    }
    // A token of another session: its nonce commits to that session's hash.
    const other = await linkedLogin(app, aud, { sub: e, join: 1, joiner: g, target: ek, immediate: true });
    const mine = await linkedLogin(app, aud, { sub: e, join: 1, joiner: g, target: ek, immediate: true });
    const key = appKey();
    const swapped = { ...mine, pk1: key.pk1, pk2: key.pk2, linkJwt: other.linkJwt, signature: await signSession(mine.sessionPublicKey as number[], 1, await linkedCkdPayload(key.pk1, key.pk2, other.linkJwt as string, true)) };
    const res = await login(app, swapped);
    expect([(await body(res)).reason]).toEqual(['link_mismatch']);
    expect(near.sent).toHaveLength(0);
  });

  it('refuses by the chain state: links not open, both wallets, a pending identity, a full account, the provider taken', async () => {
    const { app, aud, near, e, g, ek } = await caseA();
    const req = async () => linkedLogin(app, aud, { sub: e, join: 1, joiner: g, target: ek, immediate: true });
    const expectRefused = async (status: number, code: string, reason?: string) => {
      const res = await login(app, await req());
      const b = await body(res);
      expect([res.status, b.code, b.reason]).toEqual([status, code, reason]);
    };
    near.unrecordedWallets = true;
    clearViewCaches(); // get_config is cached 60 s
    await expectRefused(409, 'links_unavailable');
    near.unrecordedWallets = undefined; // a pre-v3 contract: no such field
    clearViewCaches();
    await expectRefused(409, 'links_unavailable');
    near.unrecordedWallets = false;
    clearViewCaches();
    near.identities.set(`google#${G_SUB}`, { status: 'own', opened: true });
    await expectRefused(422, 'link_refused', 'both_wallets');
    near.identities.set(`google#${G_SUB}`, { status: 'pending', opened: false, root: { provider: 'email', sub: 'e1.x' } });
    await expectRefused(409, 'link_pending');
    near.identities.delete(`google#${G_SUB}`);
    near.accounts.set(`email#${e}`, { root: { provider: 'email', sub: e }, members: [{ provider: 'google', sub: 'other-g', active: true }], epoch: 0 });
    await expectRefused(422, 'link_refused', 'provider_taken');
    expect(near.sent).toHaveLength(0);
  });

  it('refuses a malformed link: linkImmediate alone, a Google token as the link, a link from the export window', async () => {
    const { app, aud, near, e, g, ek } = await caseA();
    const plain = await loginBody(app.scope, aud);
    const alone = await login(app, { ...plain, linkImmediate: true });
    expect([alone.status, (await body(alone)).code]).toEqual([400, 'bad_request']);
    const compact = await login(app, { ...plain, linkJwt: await google.sign({ iss: 'https://accounts.google.com', aud, sub: 'x', exp: Math.floor(Date.now() / 1000) + 600 }) });
    expect([compact.status, (await body(compact)).code]).toEqual([400, 'bad_request']);
    const linked = await linkedLogin(app, aud, { sub: e, join: 1, joiner: g, target: ek, immediate: true });
    const exported = await call('/v1/login', { headers: hanaHeaders(app, env.AUTH_ORIGIN!), body: linked, env: emailEnv() });
    expect([exported.status, (await body(exported)).code]).toEqual([400, 'bad_request']);
    expect(near.sent).toHaveLength(0);
  });

  it('maps the email-login panics of a relayed login to errors', async () => {
    const { app, aud, near } = await setup();
    const cases: [string, number, string, string | undefined][] = [
      ['Links wait until the owner accepts the wallets opened before v3', 409, 'links_unavailable', undefined],
      ['Sign-in method is linked to an account', 409, 'identity_linked', undefined],
      ['Sign-in method link is pending', 409, 'link_pending', undefined],
      ['Account is full', 422, 'contract_rejected', 'account_full'],
      ['Link token nonce doesn’t match', 422, 'contract_rejected', 'link_mismatch'],
    ];
    for (const [msg, status, code, reason] of cases) {
      near.contract.create_session_and_derive = () => panic(msg);
      const res = await login(app, await loginBody(app.scope, aud));
      const b = await body(res);
      expect([res.status, b.code, b.reason], msg).toEqual([status, code, reason]);
    }
  });
});

describe('GET /v1/app: the sign-in methods', () => {
  const get = (app: { key: string }) => call('/v1/app', { headers: appHeaders(app) });

  it('lists email (with its aud) only when D1 enables it and the scope has its client', async () => {
    const { app, aud } = await setup();
    const on = await body(await get(app));
    expect(on).toMatchObject({ google: { clientId: aud, mode: 'own' }, loginMethods: ['google', 'email'], email: { aud: emailAud(app.scope) } });
    await setLoginMethods(app.id, 'google');
    const off = await body(await get(app));
    expect(off.loginMethods).toEqual(['google']);
    expect(off).not.toHaveProperty('email');
  });

  it('email on but no email client on chain: Google only; nothing available: no_login_method', async () => {
    const app = await seedApp();
    const aud = newAud();
    chain({ [aud]: app.scope });
    await setLoginMethods(app.id, 'google,email');
    expect((await body(await get(app))).loginMethods).toEqual(['google']);
    await setLoginMethods(app.id, 'email');
    const none = await get(app);
    expect([none.status, (await body(none)).code]).toEqual([409, 'no_login_method']);
  });

  it('email only, with its client: google null', async () => {
    const { app } = await setup('email');
    expect(await body(await get(app))).toMatchObject({ google: null, loginMethods: ['email'], email: { aud: emailAud(app.scope) } });
  });

  it('D1 refuses an unknown method', async () => {
    const app = await seedApp();
    await expect(setLoginMethods(app.id, 'google,apple')).rejects.toThrow();
  });
});

// ---- Link relays ----

/** A vault share of `path` in app `appId` (a live one). */
async function seedShare(appId: string, path: string): Promise<Uint8Array> {
  const id = crypto.getRandomValues(new Uint8Array(16));
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO vault_shares (share_id, app_id, session_pk, path_hash, partner_origin, share_enc, kek_id, created_at, idle_until, abs_expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, ?8)',
  )
    .bind(id, appId, crypto.getRandomValues(new Uint8Array(32)), await sha256(new TextEncoder().encode(path)), 'https://wallet.example.com', new Uint8Array(8), now, now + 3_600_000)
    .run();
  return id;
}
const revokedAt = async (id: Uint8Array): Promise<number | null> => ((await env.DB.prepare('SELECT revoked_at FROM vault_shares WHERE share_id = ?1').bind(id).first<{ revoked_at: number | null }>())?.revoked_at ?? null);

const linkCall = (path: string, app: { key: string }, req: unknown, headers: Record<string, string> = hanaHeaders(app)) => call(path, { headers, body: req, env: emailEnv() });

describe('POST /v1/link (explicit linking)', () => {
  const salt = bytes(16, 9);
  async function explicit(epoch = 0) {
    const s = await setup();
    s.near.identities.set(`google#${G_SUB}`, { status: 'own', opened: true });
    const root = fromHex(ikSync(s.app.scope, 'google', G_SUB));
    const nSub = 'e1.new';
    const newJwt = await emailToken({ aud: emailAud(s.app.scope), sub: nSub, nonce: await linkNewNonce(env.SIGNER_ACCOUNT, s.app.scope, root, 'email', epoch, Uint8Array.from(salt)) });
    const accountJwt = await google.sign({
      iss: 'https://accounts.google.com',
      aud: s.aud,
      sub: G_SUB,
      nonce: await linkAccountNonce(env.SIGNER_ACCOUNT, s.app.scope, root, fromHex(ikSync(s.app.scope, 'email', nSub)), epoch, Uint8Array.from(salt)),
      exp: Math.floor(Date.now() / 1000) + 600,
    });
    s.near.contract.link_identity = () => Date.now() + 60_000;
    return { ...s, nSub, req: { accountJwt, newJwt, epoch, salt } };
  }

  it('relays link_identity with 250 Tgas, answers effectiveAtMs, revokes the account’s shares in every app of the scope, counts a link', async () => {
    const { app, near, req } = await explicit();
    const sibling = await seedApp({ scope: app.scope });
    const rootShare = await seedShare(sibling.id, `${app.scope}#google#${G_SUB}#0`);
    const otherShare = await seedShare(sibling.id, `${app.scope}#google#someone-else#0`);
    const res = await linkCall('/v1/link', app, req);
    const b = await body(res);
    expect(res.status, JSON.stringify(b)).toBe(200);
    expect((b.result as { effectiveAtMs: number }).effectiveAtMs).toBeGreaterThan(Date.now());
    const tx = near.sent[0]!;
    expect([tx.method, tx.gas]).toEqual(['link_identity', 250n * TGAS]);
    expect(tx.args).toEqual({ scope_id: app.scope, account_jwt: req.accountJwt, new_jwt: req.newJwt, epoch: 0, salt: req.salt });
    expect(await revokedAt(rootShare)).not.toBeNull();
    expect(await revokedAt(otherShare)).toBeNull();
    expect(await emailUsage(app.id)).toEqual({ email_sessions: 0, links: 1 });
  });

  it('refuses a wrong nonce, a stale epoch, a new identity with a wallet, links not open, a partner page', async () => {
    const { app, near, req, nSub } = await explicit();
    const expectRefused = async (r: unknown, status: number, code: string, reason?: string, headers?: Record<string, string>) => {
      const res = await linkCall('/v1/link', app, r, headers);
      const b = await body(res);
      expect([res.status, b.code, b.reason], `${code} ${reason}`).toEqual([status, code, reason]);
    };
    await expectRefused({ ...req, epoch: 1 }, 422, 'link_refused', 'link_mismatch');
    await expectRefused({ ...req, salt: bytes(16, 8) }, 422, 'link_refused', 'link_mismatch');
    near.accounts.set(`google#${G_SUB}`, { root: { provider: 'google', sub: G_SUB }, members: [], epoch: 2 });
    await expectRefused(req, 422, 'link_refused', 'stale_epoch');
    near.accounts.delete(`google#${G_SUB}`);
    near.identities.set(`email#${nSub}`, { status: 'own', opened: true });
    await expectRefused(req, 422, 'link_refused', 'has_wallet');
    near.identities.delete(`email#${nSub}`);
    near.unrecordedWallets = true;
    clearViewCaches(); // get_config is cached 60 s
    await expectRefused(req, 409, 'links_unavailable');
    await expectRefused(req, 403, 'origin_not_allowed', undefined, appHeaders(app));
    expect(near.sent).toHaveLength(0);
  });

  it('per IP, adds have their own window: a flood of adds never blocks a cancel', async () => {
    const { app, near } = await explicit();
    const ip = '10.9.8.7';
    const headers = { ...hanaHeaders(app), 'cf-connecting-ip': ip };
    for (let i = 0; i < LINK_ADDS_PER_IP_MINUTE; i++) await linkCall('/v1/link', app, { bad: true }, headers);
    const blocked = await linkCall('/v1/link', app, { bad: true }, headers);
    expect(blocked.status).toBe(429);
    const cancel = await linkCall('/v1/link/cancel', app, { bad: true }, headers);
    expect([cancel.status, (await body(cancel)).code]).toEqual([400, 'bad_request']);
    expect(near.sent).toHaveLength(0);
  });
});

describe('POST /v1/link/cancel and /v1/link/unlink', () => {
  const salt = bytes(16, 9);
  async function account(active: boolean) {
    const s = await setup();
    const e = 'e1.member';
    s.near.identities.set(`google#${G_SUB}`, { status: 'own', opened: true });
    s.near.identities.set(`email#${e}`, { status: active ? 'member' : 'pending', opened: false, root: { provider: 'google', sub: G_SUB } });
    s.near.accounts.set(`google#${G_SUB}`, { root: { provider: 'google', sub: G_SUB }, members: [{ provider: 'email', sub: e, active }], epoch: 1 });
    const root = fromHex(ikSync(s.app.scope, 'google', G_SUB));
    const member = ikSync(s.app.scope, 'email', e);
    s.near.contract.cancel_link = () => null;
    s.near.contract.unlink_identity = () => null;
    return { ...s, e, root, member };
  }
  const googleChange = async (aud: string, action: 'cancel' | 'unlink', scope: string, root: Uint8Array, member: string, epoch = 1) =>
    google.sign({ iss: 'https://accounts.google.com', aud, sub: G_SUB, nonce: await linkChangeNonce(env.SIGNER_ACCOUNT, scope, action, root, fromHex(member), epoch, Uint8Array.from(salt)), exp: Math.floor(Date.now() / 1000) + 600 });

  it('the root cancels a pending member: cancel_link with 150 Tgas, the account’s shares revoked', async () => {
    const { app, aud, near, root, member } = await account(false);
    const share = await seedShare(app.id, `${app.scope}#google#${G_SUB}#0`);
    const jwt = await googleChange(aud, 'cancel', app.scope, root, member);
    const res = await linkCall('/v1/link/cancel', app, { jwt, memberKey: member, epoch: 1, salt });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect([near.sent[0]!.method, near.sent[0]!.gas]).toEqual(['cancel_link', 150n * TGAS]);
    expect(near.sent[0]!.args).toEqual({ scope_id: app.scope, jwt, member_key: member, epoch: 1, salt });
    expect(await revokedAt(share)).not.toBeNull();
    // Cancels and unlinks aren't counted as links.
    expect(await emailUsage(app.id)).toBeNull();
  });

  it('cancel refuses an active member, a wrong nonce and a stale epoch', async () => {
    const { app, aud, near, root, member } = await account(true);
    const jwt = await googleChange(aud, 'cancel', app.scope, root, member);
    const active = await body(await linkCall('/v1/link/cancel', app, { jwt, memberKey: member, epoch: 1, salt }));
    expect([active.code, active.reason]).toEqual(['link_refused', 'no_such_member']);
    const mismatch = await body(await linkCall('/v1/link/cancel', app, { jwt: await googleChange(aud, 'unlink', app.scope, root, member), memberKey: member, epoch: 1, salt }));
    expect(mismatch.reason).toBe('link_mismatch');
    const stale = await body(await linkCall('/v1/link/cancel', app, { jwt: await googleChange(aud, 'cancel', app.scope, root, member, 0), memberKey: member, epoch: 0, salt }));
    expect(stale.reason).toBe('stale_epoch');
    expect(near.sent).toHaveLength(0);
  });

  it('the member unlinks itself (email token): unlink_identity relayed; the root can’t be unlinked', async () => {
    const { app, near, e, root, member } = await account(true);
    const jwt = await emailToken({ aud: emailAud(app.scope), sub: e, nonce: await linkChangeNonce(env.SIGNER_ACCOUNT, app.scope, 'unlink', root, fromHex(member), 1, Uint8Array.from(salt)) });
    const res = await linkCall('/v1/link/unlink', app, { jwt, memberKey: member, epoch: 1, salt });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(near.sent[0]!.method).toBe('unlink_identity');
    const rootKey = ikSync(app.scope, 'google', G_SUB);
    const rootJwt = await emailToken({ aud: emailAud(app.scope), sub: e, nonce: await linkChangeNonce(env.SIGNER_ACCOUNT, app.scope, 'unlink', root, fromHex(rootKey), 1, Uint8Array.from(salt)) });
    const refused = await body(await linkCall('/v1/link/unlink', app, { jwt: rootJwt, memberKey: rootKey, epoch: 1, salt }));
    expect(refused.reason).toBe('not_allowed');
  });

  it('an app that turned email off still takes an email token to remove a link (review L6), never to add one', async () => {
    const { app, e, root, member } = await account(true);
    await setLoginMethods(app.id, 'google');
    const jwt = await emailToken({ aud: emailAud(app.scope), sub: e, nonce: await linkChangeNonce(env.SIGNER_ACCOUNT, app.scope, 'unlink', root, fromHex(member), 1, Uint8Array.from(salt)) });
    const res = await linkCall('/v1/link/unlink', app, { jwt, memberKey: member, epoch: 1, salt });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    const add = await linkCall('/v1/link', app, { accountJwt: jwt, newJwt: jwt, epoch: 1, salt });
    expect([add.status, (await body(add)).code]).toEqual([403, 'login_method_disabled']);
  });
});

describe('email tokens and other issuers', () => {
  it('a token signed by a key the env doesn’t publish is refused, whatever the chain says', async () => {
    const { app, near } = await setup();
    const rogue = await emailSigner('hana-email-test');
    const b = await emailSessionBody(app.scope);
    const claims = JSON.parse(atob((JSON.parse(b.jwt as string) as { payload: string }).payload.replace(/-/gu, '+').replace(/_/gu, '/'))) as Record<string, unknown>;
    const forged = { ...b, jwt: await emailToken(claims, [rogue]) };
    const res = await sessions(app, forged);
    expect([res.status, (await body(res)).code]).toEqual([401, 'invalid_token']);
    expect(near.sent).toHaveLength(0);
    expect(issuer.kid).toBe('hana-email-test');
    expect(EMAIL_ISS).toBe('https://api.test/v1/email');
  });
});

export type { EmailChain };

describe('email counts into the usage ledger (hourly, D233)', () => {
  const day = (msAgo: number) => new Date(Date.now() - msAgo).toISOString().slice(0, 10);

  it('an email login counts in email_usage; the hourly copy sends it with the app’s org and scope; a replay never lowers it', async () => {
    const { app } = await setup();
    expect((await sessions(app, await emailSessionBody(app.scope))).status).toBe(200);
    await env.DB.prepare('INSERT INTO email_usage (app_id, day, links) VALUES (?1, ?2, 4)').bind(app.id, day(86_400_000)).run();
    expect(await syncEmailUsage(env)).toBeGreaterThanOrEqual(2);
    const mine = () => ledger.email.filter((r) => r.app_id === app.id).sort((a, b) => a.day.localeCompare(b.day));
    expect(mine()).toEqual([
      { app_id: app.id, day: day(86_400_000), org_id: 'org_legacy', scope_id: app.scope, email_sessions: 0, links: 4 },
      { app_id: app.id, day: day(0), org_id: 'org_legacy', scope_id: app.scope, email_sessions: 1, links: 0 },
    ]);
    await syncEmailUsage(env);
    expect(mine().map((r) => [r.email_sessions, r.links])).toEqual([[0, 4], [1, 0]]);
    expect(ledger.calls.filter((c) => c.sql === RECORD_EMAIL_SQL).length).toBe(2);
  });

  it('sends nothing without the binding; a failing ledger is logged and never throws', async () => {
    const app = await seedApp();
    await env.DB.prepare('INSERT INTO email_usage (app_id, day, email_sessions) VALUES (?1, ?2, 1)').bind(app.id, day(0)).run();
    expect(await syncEmailUsage({ ...env, USAGE_DB: undefined })).toBe(0);
    ledger.fail = () => new Error('Connection terminated unexpectedly');
    expect(await syncEmailUsage(env)).toBe(0);
  });
});

describe('batch 6 review: requests bound to fail, link limits, unknown fields', () => {
  const salt = bytes(16, 9);

  it('a pending member’s login and session are refused before any relay (409 link_pending)', async () => {
    const { app, aud, near } = await setup();
    near.identities.set(`google#${G_SUB}`, { status: 'pending', opened: false, root: { provider: 'email', sub: 'e1.root' } });
    const res = await login(app, await loginBody(app.scope, aud));
    expect([res.status, (await body(res)).code]).toEqual([409, 'link_pending']);
    const ses = await sessions(app, await sessionBody(app.scope, aud));
    expect([ses.status, (await body(ses)).code]).toEqual([409, 'link_pending']);
    expect(near.sent).toHaveLength(0);
  });

  it('a member’s login derives (and its export limit and uid key on) the account root’s path; links closed: its own', async () => {
    const { app, near } = await setup();
    near.identities.set(`google#${G_SUB}`, { status: 'member', opened: false, root: { provider: 'email', sub: 'e1.root' } });
    expect(await sessionStanding(env, app.scope, 'google', G_SUB, 0)).toEqual({ pending: false, path: `${app.scope}#email#e1.root#0` });
    near.unrecordedWallets = true;
    clearViewCaches();
    expect(await sessionStanding(env, app.scope, 'google', G_SUB, 0)).toEqual({ pending: false, path: `${app.scope}#google#${G_SUB}#0` });
  });

  it('the same request after a link-state panic is answered from the isolate, not relayed again', async () => {
    const { app, aud, near } = await setup();
    let calls = 0;
    near.contract.create_session_and_derive = () => {
      calls += 1;
      return panic('Sign-in method is linked to an account');
    };
    const req = await loginBody(app.scope, aud);
    expect((await body(await login(app, req))).code).toBe('identity_linked');
    expect((await body(await login(app, req))).code).toBe('identity_linked');
    expect(calls).toBe(1);
  });

  it('/v1/sessions refuses an unknown field, linkJwt included', async () => {
    const { app, aud, near } = await setup();
    const req = await sessionBody(app.scope, aud);
    for (const extra of [{ linkJwt: '{}' }, { foo: 1 }]) {
      const res = await sessions(app, { ...req, ...extra });
      expect([res.status, (await body(res)).code]).toEqual([400, 'bad_request']);
    }
    expect(near.sent).toHaveLength(0);
  });

  /** A /v1/link request adding a fresh email identity `nSub` to the Google root's account (epoch 0). */
  async function addRequest(s: Awaited<ReturnType<typeof setup>>, nSub: string) {
    const root = fromHex(ikSync(s.app.scope, 'google', G_SUB));
    const newJwt = await emailToken({ aud: emailAud(s.app.scope), sub: nSub, nonce: await linkNewNonce(env.SIGNER_ACCOUNT, s.app.scope, root, 'email', 0, Uint8Array.from(salt)) });
    const accountJwt = await google.sign({
      iss: 'https://accounts.google.com',
      aud: s.aud,
      sub: G_SUB,
      nonce: await linkAccountNonce(env.SIGNER_ACCOUNT, s.app.scope, root, fromHex(ikSync(s.app.scope, 'email', nSub)), 0, Uint8Array.from(salt)),
      exp: Math.floor(Date.now() / 1000) + 600,
    });
    return { accountJwt, newJwt, epoch: 0, salt };
  }

  it('a duplicate of a link request relays once (link_in_flight), across retries', async () => {
    const s = await setup();
    s.near.identities.set(`google#${G_SUB}`, { status: 'own', opened: true });
    s.near.contract.link_identity = () => Date.now() + 60_000;
    const req = await addRequest(s, 'e1.dup');
    const [a, b] = await Promise.all([linkCall('/v1/link', s.app, req), linkCall('/v1/link', s.app, req)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await body(a.status === 409 ? a : b)).code).toBe('link_in_flight');
    expect(s.near.sent).toHaveLength(1);
    // The link relay is a usage event (endpoint `link`, its relay facts).
    expect(ledger.events.filter((e) => e.endpoint === 'link' && e.app_id === s.app.id).map((e) => e.outcome).sort()).toEqual(['ok', 'rejected']);
  });

  it('adds are limited per account root, whatever the IP', async () => {
    const s = await setup();
    s.near.identities.set(`google#${G_SUB}`, { status: 'own', opened: true });
    s.near.contract.link_identity = () => Date.now() + 60_000;
    const statuses: number[] = [];
    for (let i = 0; i <= LINK_ADDS_PER_ROOT_MINUTE; i++) {
      const headers = { ...hanaHeaders(s.app), 'cf-connecting-ip': `10.7.${i}.1` };
      statuses.push((await linkCall('/v1/link', s.app, await addRequest(s, `e1.r${i}`), headers)).status);
    }
    expect(statuses).toEqual([...Array(LINK_ADDS_PER_ROOT_MINUTE).fill(200), 429]);
  });

  it('a 2-of-2 email token gets the gas of its second signature', async () => {
    const s = await setup();
    s.near.identities.set(`google#${G_SUB}`, { status: 'own', opened: true });
    s.near.contract.link_identity = () => Date.now() + 60_000;
    const cosign = await emailSigner('cosign-test');
    s.near.policy = { signers: [{ id: 'hana', kids: [issuer.kid] }, { id: 'cosign', kids: [cosign.kid] }], required: 2 };
    const req = await addRequest(s, 'e1.two');
    const claims = JSON.parse(atob((JSON.parse(req.newJwt) as { payload: string }).payload.replace(/-/gu, '+').replace(/_/gu, '/'))) as Record<string, unknown>;
    const newJwt = await emailToken(claims, [issuer, cosign]);
    const res = await call('/v1/link', { headers: hanaHeaders(s.app), body: { ...req, newJwt }, env: emailEnv([issuer, cosign]) });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    // 250 + 70 for the second signature, capped at NEAR's 300 Tgas per transaction.
    expect(s.near.sent[0]!.gas).toBe(300n * TGAS);
  });

  it('nothing under /v1/email/ is the API’s (D230): 404', async () => {
    for (const path of ['/v1/email/start', '/v1/email/jwks.json', '/v1/email/.well-known/openid-configuration']) {
      const res = await call(path, { method: 'GET' });
      expect([res.status, (await body(res)).code], path).toEqual([404, 'not_found']);
    }
  });

  it('/v1/health reports the createProof capability (deploy-contract --upgrade checks it)', async () => {
    const res = await call('/v1/health', { method: 'GET' });
    expect((await body(res)).capabilities).toEqual({ createProof: true });
  });
});
