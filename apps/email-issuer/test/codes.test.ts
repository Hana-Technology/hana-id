// start / resend / verify: codes (entropy source, HMAC storage, attempts, expiry, single use, resend rules,
// constant-time compare), purpose-bound nonces, the app gate, CORS and the token's exact shape.
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { bytesEqual, toHex } from '../src/bytes.ts';
import type { ChallengeRecord } from '../src/challenge.ts';
import { newCode } from '../src/keys.ts';
import { linkChangePreimage, linkNewPreimage, nonceOf } from '../src/layouts.ts';
import { parseChallengeId } from '../src/challenge-id.ts';
import { AUTH, challengeObject, decodeToken, env, harness, nonceFor, seedApp, sessionCommitment } from './helpers.ts';

const start = async (h: Awaited<ReturnType<typeof harness>>, body: Record<string, unknown>) => h.call('/v1/email/start', body);

describe('codes', () => {
  it('6 digits from getRandomValues with rejection sampling (no modulo bias)', () => {
    const limit = Math.floor(2 ** 32 / 1e6) * 1e6;
    const draws = [2 ** 32 - 1, limit, 1_234_567];
    let i = 0;
    expect(newCode((o) => ((o[0] = draws[i++]!), o))).toBe('234567');
    expect(i).toBe(3);
    expect(newCode((o) => ((o[0] = 42), o))).toBe('000042');
    for (let k = 0; k < 200; k++) expect(newCode()).toMatch(/^\d{6}$/u);
    expect(() => newCode((o) => ((o[0] = 2 ** 32 - 1), o))).toThrow();
  });

  it('constant-time compare: equal only for equal bytes and lengths', () => {
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it('a session login: 202 then the code verifies once; the token is exactly the spec’s', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const c = sessionCommitment(app.scope, h.clock.now);
    const s = await start(h, { pk: app.pk, email: ' Alice@Example.COM ', purpose: 'session', commitment: c.json });
    expect(s.status).toBe(202);
    expect(s.headers.get('cache-control')).toBe('no-store');
    expect(s.headers.get('access-control-allow-origin')).toBe(AUTH);
    const body = (await s.json()) as { challengeId: string; expiresAtMs: number; resendAfterMs: number };
    expect(Object.keys(body).sort()).toEqual(['challengeId', 'expiresAtMs', 'resendAfterMs']);
    expect(body.expiresAtMs).toBe(h.clock.now + 600_000);
    expect(body.resendAfterMs).toBe(h.clock.now + 30_000);
    // Sent to the normalized address, byte for byte; the code is not in the subject; no link in a code mail.
    expect(h.sender.sent).toHaveLength(1);
    const mail = h.sender.sent[0]!;
    expect(mail.to).toBe('alice@example.com');
    const code = h.sender.codeFor('alice@example.com');
    expect(mail.subject).toBe('Your sign-in code for Test Wallet');
    expect(mail.subject).not.toContain(code);
    expect(mail.text).not.toMatch(/https?:\/\//u);
    expect(mail.html).not.toMatch(/<a /u);
    expect(mail.text).toContain('auth.test');

    // The challenge stores a MAC, never the code, and the address only encrypted under the id's secret half (L3): the
    // object is named by the public half alone, and its storage holds nothing readable.
    const stub = challengeObject(body.challengeId);
    await runInDurableObject(stub, (_o, state) => {
      const rec = state.storage.kv.get<ChallengeRecord>('challenge')!;
      expect(JSON.stringify(rec)).not.toContain(code);
      expect(JSON.stringify(rec)).not.toContain('alice');
      expect(rec.emailEnc).toMatch(/^[A-Za-z0-9_-]{40,}$/u);
      expect(rec.codeMac).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(rec.nonce).toBe(nonceFor(c));
    });
    expect(env.EMAIL_CHALLENGE.idFromName(body.challengeId).toString()).not.toBe(env.EMAIL_CHALLENGE.idFromName(parseChallengeId(body.challengeId)!.name).toString());

    const v = await h.call('/v1/email/verify', { challengeId: body.challengeId, code });
    expect(v.status).toBe(200);
    const out = (await v.json()) as { idToken: string; googleWallet: boolean; linkTicket?: string };
    expect(out.googleWallet).toBe(false);
    expect(out.linkTicket).toBeUndefined();
    const t = await decodeToken(out.idToken);
    expect(t.verified).toBe(true);
    expect(t.kids).toEqual([env.EMAIL_ACTIVE_KID]);
    expect(Object.keys(t.claims)).toEqual(['iss', 'aud', 'sub', 'iat', 'exp', 'nonce', 'jti']);
    expect(t.claims.iss).toBe(env.EMAIL_ISS);
    expect(t.claims.aud).toBe(`email:${app.scope}`);
    expect(t.claims.sub).toMatch(/^e1\.[A-Za-z0-9_-]{43}$/u);
    expect(t.claims.exp).toBe((t.claims.iat as number) + 600);
    expect(t.claims.nonce).toBe(nonceFor(c));
    expect(t.claims.jti).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    // Logged in email_issuance (jti, app, purpose, kid, iat).
    const row = await env.DB.prepare('SELECT * FROM email_issuance WHERE jti = ?1').bind(t.claims.jti).first<Record<string, unknown>>();
    expect(row).toMatchObject({ app_id: app.id, purpose: 'session', kid: env.EMAIL_ACTIVE_KID, iat: t.claims.iat });

    // Single use: the object is gone.
    const again = await h.call('/v1/email/verify', { challengeId: body.challengeId, code });
    expect(again.status).toBe(410);
    expect(((await again.json()) as { code: string }).code).toBe('challenge_expired');
    await runInDurableObject(stub, (_o, state) => expect([...state.storage.kv.list()]).toEqual([]));
  });

  it('5 wrong codes kill the challenge; attemptsLeft counts down', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const s = await start(h, { pk: app.pk, email: 'bob@example.com', purpose: 'session', commitment: sessionCommitment(app.scope, h.clock.now).json });
    const { challengeId } = (await s.json()) as { challengeId: string };
    const code = h.sender.codeFor('bob@example.com');
    const wrong = code === '000000' ? '000001' : '000000';
    for (let left = 4; left >= 0; left--) {
      const v = await h.call('/v1/email/verify', { challengeId, code: wrong });
      expect(v.status).toBe(400);
      expect(await v.json()).toMatchObject({ code: 'code_invalid', data: { attemptsLeft: left } });
    }
    const v = await h.call('/v1/email/verify', { challengeId, code });
    expect(v.status).toBe(410);
  });

  it('expires 10 minutes after start, resends included (D197)', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const s = await start(h, { pk: app.pk, email: 'carol@example.com', purpose: 'session', commitment: sessionCommitment(app.scope, h.clock.now).json });
    const { challengeId } = (await s.json()) as { challengeId: string };
    h.clock.now += 31_000;
    expect((await h.call('/v1/email/resend', { challengeId })).status).toBe(202);
    const code = h.sender.codeFor('carol@example.com');
    h.clock.now += 600_000 - 31_000;
    const v = await h.call('/v1/email/verify', { challengeId, code });
    expect(v.status).toBe(410);
  });

  it('resend: a new code kills the old one, ≥ 30 s apart, at most 2', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const s = await start(h, { pk: app.pk, email: 'dan@example.com', purpose: 'session', commitment: sessionCommitment(app.scope, h.clock.now).json });
    const { challengeId } = (await s.json()) as { challengeId: string };
    const first = h.sender.codeFor('dan@example.com');
    const soon = await h.call('/v1/email/resend', { challengeId });
    expect(soon.status).toBe(429);
    expect(((await soon.json()) as { code: string }).code).toBe('rate_limited');
    h.clock.now += 30_000;
    expect((await h.call('/v1/email/resend', { challengeId })).status).toBe(202);
    h.clock.now += 30_000;
    const r2 = await h.call('/v1/email/resend', { challengeId });
    expect(r2.status).toBe(202);
    const latest = h.sender.codeFor('dan@example.com');
    h.clock.now += 30_000;
    const r3 = await h.call('/v1/email/resend', { challengeId });
    expect(r3.status).toBe(429);
    expect(((await r3.json()) as { code: string }).code).toBe('resend_limit');
    expect(h.sender.to('dan@example.com')).toHaveLength(3);
    if (first !== latest) expect((await h.call('/v1/email/verify', { challengeId, code: first })).status).toBe(400);
    expect((await h.call('/v1/email/verify', { challengeId, code: latest })).status).toBe(200);
  });

  it('a send that fails is not counted and leaves the challenge resendable', async () => {
    const h = await harness();
    const app = await seedApp(h);
    h.sender.next = { ok: false, reason: 'unavailable', providerStatus: 503 };
    const s = await start(h, { pk: app.pk, email: 'erin@example.com', purpose: 'session', commitment: sessionCommitment(app.scope, h.clock.now).json });
    expect(s.status).toBe(202);
    expect(h.sender.sent).toHaveLength(0);
    h.sender.next = { ok: true };
    const { challengeId } = (await s.json()) as { challengeId: string };
    h.clock.now += 30_000;
    expect((await h.call('/v1/email/resend', { challengeId })).status).toBe(202);
    expect(h.sender.to('erin@example.com')).toHaveLength(1);
  });

  it('a resend the provider refuses doesn’t spend one of the two resends', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const s = await start(h, { pk: app.pk, email: 'fay@example.com', purpose: 'session', commitment: sessionCommitment(app.scope, h.clock.now).json });
    const { challengeId } = (await s.json()) as { challengeId: string };
    h.sender.next = { ok: false, reason: 'unavailable', providerStatus: 503 };
    h.clock.now += 30_000;
    expect((await h.call('/v1/email/resend', { challengeId })).status).toBe(202);
    h.sender.next = { ok: true };
    // No 30 s wait either: the refused send is taken back.
    expect((await h.call('/v1/email/resend', { challengeId })).status).toBe(202);
    h.clock.now += 30_000;
    expect((await h.call('/v1/email/resend', { challengeId })).status).toBe(202);
    expect(h.sender.to('fay@example.com')).toHaveLength(3);
  });
});

describe('purpose-bound nonces and the app gate', () => {
  it('each link purpose’s nonce is computed by the issuer from the commitment', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const salt = [...crypto.getRandomValues(new Uint8Array(20))];
    const rootIk = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const memberIk = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const cases: [string, Record<string, unknown>, string][] = [
      ['link_new', { scopeId: app.scope, rootIk, epoch: 4, salt }, nonceOf(linkNewPreimage(env.SIGNER_ACCOUNT, app.scope, Uint8Array.from(Buffer.from(rootIk, 'hex')), 'email', 4, Uint8Array.from(salt)))],
      [
        'link_change',
        { scopeId: app.scope, action: 'cancel', rootIk, memberIk, epoch: 5, salt },
        nonceOf(linkChangePreimage(env.SIGNER_ACCOUNT, app.scope, 'cancel', Uint8Array.from(Buffer.from(rootIk, 'hex')), Uint8Array.from(Buffer.from(memberIk, 'hex')), 5, Uint8Array.from(salt))),
      ],
    ];
    for (const [purpose, commitment, expected] of cases) {
      const email = `${purpose.replace('_', '')}@example.com`;
      const s = await start(h, { pk: app.pk, email, purpose, commitment });
      expect(s.status).toBe(202);
      const { challengeId } = (await s.json()) as { challengeId: string };
      // The link purposes' mail says what the code does (spec "Phishing").
      expect(h.sender.to(email)[0]!.text).toContain(purpose === 'link_new' ? 'add this email as a sign-in method of your wallet' : 'remove or cancel a sign-in method');
      const v = await h.call('/v1/email/verify', { challengeId, code: h.sender.codeFor(email) });
      expect(v.status).toBe(200);
      const t = await decodeToken(((await v.json()) as { idToken: string }).idToken);
      expect(t.claims.nonce).toBe(expected);
      const row = await env.DB.prepare('SELECT purpose FROM email_issuance WHERE jti = ?1').bind(t.claims.jti).first<{ purpose: string }>();
      expect(row?.purpose).toBe(purpose);
    }
  });

  it('a commitment for another app’s scope is refused; auto_link can’t be started; the nonce is never accepted', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const other = await seedApp(h);
    const r = await start(h, { pk: app.pk, email: 'x@example.com', purpose: 'session', commitment: sessionCommitment(other.scope, h.clock.now).json });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { code: string }).code).toBe('scope_mismatch');
    const a = await start(h, { pk: app.pk, email: 'x@example.com', purpose: 'auto_link', commitment: {} });
    expect(a.status).toBe(400);
    const n = await start(h, { pk: app.pk, email: 'x@example.com', purpose: 'session', commitment: { ...sessionCommitment(app.scope, h.clock.now).json, nonce: 'abc' } });
    expect(n.status).toBe(400);
    expect(h.sender.sent).toHaveLength(0);
  });

  it('email must be on: unknown key, suspended app, google-only app, no email client on chain', async () => {
    const h = await harness();
    const body = (pk: string, scope: string) => ({ pk, email: 'y@example.com', purpose: 'session', commitment: sessionCommitment(scope, h.clock.now).json });
    const unknown = await start(h, body('pk_test_1111111111111111111111111111111z', 's1'));
    expect(unknown.status).toBe(401);
    const suspended = await seedApp(h, { status: 'suspended' });
    expect(((await (await start(h, body(suspended.pk, suspended.scope))).json()) as { code: string }).code).toBe('app_suspended');
    const google = await seedApp(h, { methods: 'google' });
    expect(((await (await start(h, body(google.pk, google.scope))).json()) as { code: string }).code).toBe('email_not_enabled');
    const noClient = await seedApp(h, { scope: { email: false } });
    expect(((await (await start(h, body(noClient.pk, noClient.scope))).json()) as { code: string }).code).toBe('no_email_client');
    expect(h.sender.sent).toHaveLength(0);
  });

  it('before the API’s login_methods migration, no app has email on', async () => {
    const { appByKey } = await import('../src/apps.ts');
    await env.APP_DB_OLD.prepare("INSERT INTO apps (id, name, scope_id, publishable_key) VALUES ('old1', 'Old', 's9', 'pk_test_1111111111111111111111111111111a')").run();
    const app = await appByKey(env.APP_DB_OLD, 'pk_test_1111111111111111111111111111111a');
    expect(app).toMatchObject({ id: 'old1', emailOn: false, active: true });
  });

  it('invalid and disposable addresses', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const go = (email: unknown) => start(h, { pk: app.pk, email, purpose: 'session', commitment: sessionCommitment(app.scope, h.clock.now).json });
    for (const bad of ['no-at-sign', 'a@b', 'ü@example.com', 42]) expect(((await (await go(bad)).json()) as { code: string }).code).toBe('invalid_email');
    const d = await go('someone@mailinator.com');
    expect(d.status).toBe(400);
    expect(((await d.json()) as { code: string }).code).toBe('email_domain_not_allowed');
    const sub = await go('someone@sub.mailinator.com');
    expect(((await sub.json()) as { code: string }).code).toBe('email_domain_not_allowed');
  });

  it('a suspended app’s challenge mints nothing', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const s = await start(h, { pk: app.pk, email: 'z@example.com', purpose: 'session', commitment: sessionCommitment(app.scope, h.clock.now).json });
    const { challengeId } = (await s.json()) as { challengeId: string };
    await env.APP_DB.prepare("UPDATE apps SET status = 'suspended' WHERE id = ?1").bind(app.id).run();
    const v = await h.call('/v1/email/verify', { challengeId, code: h.sender.codeFor('z@example.com') });
    expect(v.status).toBe(403);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM email_issuance').first('n')).toBe(0);
  });
});

describe('HTTP surface', () => {
  it('CORS: start, resend and verify only from authOrigin; google-match only from the vault; preflight', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const body = { pk: app.pk, email: 'w@example.com', purpose: 'session', commitment: sessionCommitment(app.scope, h.clock.now).json };
    for (const origin of [null, 'https://evil.example', 'https://vault.test']) {
      const r = await h.call('/v1/email/start', body, { origin });
      expect(r.status).toBe(403);
      expect(r.headers.get('access-control-allow-origin')).toBeNull();
    }
    expect((await h.call('/v1/email/google-match', {}, { origin: AUTH })).status).toBe(403);
    const pre = await h.call('/v1/email/verify', undefined, { method: 'OPTIONS' });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe(AUTH);
    expect(pre.headers.get('access-control-allow-credentials')).toBeNull();
    const text = await h.call('/v1/email/start', body, { contentType: 'text/plain' });
    expect(text.status).toBe(415);
    expect(h.sender.sent).toHaveLength(0);
  });

  it('oversized and unknown-field bodies are refused', async () => {
    const h = await harness();
    const big = await h.call('/v1/email/verify', { challengeId: 'a'.repeat(43), code: '123456', pad: 'x'.repeat(20_000) });
    expect(big.status).toBe(413);
    const extra = await h.call('/v1/email/verify', { challengeId: 'a'.repeat(43), code: '123456', email: 'x@example.com' });
    expect(extra.status).toBe(400);
  });

  it('JWKS and the OpenID configuration publish every key with kid = thumbprint', async () => {
    const h = await harness();
    const j = await h.call('/v1/email/jwks.json', undefined, { method: 'GET', origin: null });
    expect(j.status).toBe(200);
    expect(j.headers.get('access-control-allow-origin')).toBe('*');
    const { keys } = (await j.json()) as { keys: { kid: string; n: string; e: string; d?: string }[] };
    expect(keys).toHaveLength(2);
    const { rsaThumbprint } = await import('@hana-id/jwks');
    for (const k of keys) {
      expect(await rsaThumbprint(k)).toBe(k.kid);
      expect(k.d).toBeUndefined();
    }
    const o = await h.call('/v1/email/.well-known/openid-configuration', undefined, { method: 'GET', origin: null });
    expect(await o.json()).toMatchObject({ issuer: env.EMAIL_ISS, jwks_uri: `${env.EMAIL_ISS}/jwks.json`, id_token_signing_alg_values_supported: ['RS256'] });
    expect((await h.call('/v1/email/nope', {})).status).toBe(404);
  });

  it('a misconfigured signer answers 503 and mints nothing', async () => {
    const { WorkerSecretSigner, SignerUnavailable } = await import('../src/signer.ts');
    await expect(WorkerSecretSigner.create(env.TEST_STANDBY_KEY, env.EMAIL_ACTIVE_KID)).rejects.toBeInstanceOf(SignerUnavailable);
    const h = await harness({ signers: async () => [await WorkerSecretSigner.create(env.TEST_STANDBY_KEY, env.EMAIL_ACTIVE_KID)] });
    const app = await seedApp(h);
    const s = await h.call('/v1/email/start', { pk: app.pk, email: 'v@example.com', purpose: 'session', commitment: sessionCommitment(app.scope, h.clock.now).json });
    const { challengeId } = (await s.json()) as { challengeId: string };
    const v = await h.call('/v1/email/verify', { challengeId, code: h.sender.codeFor('v@example.com') });
    expect(v.status).toBe(503);
    expect(((await v.json()) as { code: string }).code).toBe('signer_unavailable');
  });
});
