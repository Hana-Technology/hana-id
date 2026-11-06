// The sealed email (D419, docs/email-sharing-spec.md "Where the address comes from"): google-match, google-record and a
// `session` verify hand the API the verified address sealed under IDENTITY_SEAL_KEY for one app and session, until the
// session's expiry. Only a Google-verified address (userinfo's, lowercased) or the normalized login address is sealed;
// no key, no blob; never for case B, the link purposes or auto_link; never logged.
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { emailSub, normalizeEmail, openSealedEmail, parseSealKey, sealedEmailHeader, type SealKey } from '@hana-id/email';
import { toHex } from '../src/bytes.ts';
import type { ChallengeRecord } from '../src/challenge.ts';
import { importSealKey } from '../src/keys.ts';
import { GOOGLE_CLIENT, type GoogleAccount, type Harness, type TestApp, captureLogs, challengeObject, emailLogin, env, harness, nonceFor, seedApp, sessionCommitment, uid } from './helpers.ts';

const gAccount = (email: string, over: Partial<GoogleAccount> = {}): GoogleAccount => ({ sub: `1${Math.floor(Math.random() * 1e15)}`, email, ...over });

const envKey = async (): Promise<SealKey> => {
  const k = await parseSealKey(env.IDENTITY_SEAL_KEY);
  if (!k) throw new Error('vitest.config.ts binds IDENTITY_SEAL_KEY');
  return k;
};

/** google-match or google-record for `account`, with the commitment it was made for. */
async function google(h: Harness, path: '/v1/email/google-match' | '/v1/email/google-record', app: TestApp, account: GoogleAccount, extra: Record<string, unknown> = {}) {
  const commitment = sessionCommitment(app.scope, h.clock.now);
  const googleIdToken = await h.google.idToken(account, GOOGLE_CLIENT, nonceFor(commitment));
  const accessToken = h.google.accessToken(account, GOOGLE_CLIENT);
  const res = await h.call(path, { pk: app.pk, accessToken, googleIdToken, commitment: commitment.json, ...(path.endsWith('match') ? { link: true } : {}), ...extra });
  return { res, body: (await res.json()) as Record<string, unknown> & { sealedEmail?: string }, commitment };
}

const open = async (blob: unknown, appId: string, sessionPublicKey: Uint8Array, nowMs: number) => openSealedEmail([await envKey()], blob, { appId, sessionPublicKey, nowMs });

/** The email identity's sub of an address (as the issuer computes it). */
const eSub = async (h: Harness, email: string): Promise<string> => {
  const r = normalizeEmail(email);
  if (!r.ok) throw new Error('test address');
  return emailSub((await h.deps.keys()).sub, r.email);
};

/** A link_new commitment (an email identity joining an account). */
const linkNew = (scopeId: string) => ({ scopeId, rootIk: toHex(crypto.getRandomValues(new Uint8Array(32))), epoch: 1, salt: [...crypto.getRandomValues(new Uint8Array(16))] });

describe('the seal key (IDENTITY_SEAL_KEY)', () => {
  it('is imported from `<id>:<base64 of 32 bytes>`; absent is null silently, malformed is null with one code-only line', async () => {
    expect(await importSealKey(undefined)).toBeNull();
    expect(await importSealKey('')).toBeNull();
    expect((await importSealKey(env.IDENTITY_SEAL_KEY))?.id).toBe(7);
    const bad = `0:${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))}`;
    const short = `1:${btoa('too short')}`;
    const { result, lines } = await captureLogs(async () => [await importSealKey(bad), await importSealKey(short), await importSealKey(short)]);
    expect(result).toEqual([null, null, null]);
    // One line per value (cached per isolate and value), a code only.
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed.map((l) => [l.event, l.code])).toEqual([
      ['seal_key_unavailable', 'bad_seal_key'],
      ['seal_key_unavailable', 'bad_seal_key'],
    ]);
    for (const l of lines) {
      expect(l).not.toContain(bad.slice(2));
      expect(l).not.toContain(short.slice(2));
    }
  });
});

describe('google-match and google-record seal the Google-verified address (D419)', () => {
  it('google-match: the blob opens for this app, session and expiry only, with userinfo’s address lowercased, src google', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const account = gAccount(`Mat.Ch${uid()}@GMail.com`);
    const { res, body, commitment } = await google(h, '/v1/email/google-match', app, account);
    expect([res.status, body.decision]).toEqual([200, 'none']);
    expect(body.sealedEmail).toMatch(/^se1\.[A-Za-z0-9_-]+$/u);
    // The header names the key and the session's expiry.
    expect(sealedEmailHeader(body.sealedEmail)).toEqual({ keyId: 7, notAfterMs: commitment.expiresAtMs });
    // Exactly the user directory's address: userinfo's lowercased, dots kept (not the login normalization).
    expect(await open(body.sealedEmail, app.id, commitment.sessionPublicKey, h.clock.now)).toEqual({ ok: true, email: account.email.toLowerCase(), src: 'google', notAfterMs: commitment.expiresAtMs });
    // Another app, another session, after the expiry: it doesn't open.
    expect((await open(body.sealedEmail, (await seedApp(h)).id, commitment.sessionPublicKey, h.clock.now)).ok).toBe(false);
    expect(await open(body.sealedEmail, app.id, crypto.getRandomValues(new Uint8Array(32)), h.clock.now)).toEqual({ ok: false, reason: 'bad_seal' });
    expect(await open(body.sealedEmail, app.id, commitment.sessionPublicKey, commitment.expiresAtMs)).toEqual({ ok: false, reason: 'expired' });
  });

  it('google-match: whatever the decision (case A with a token, case A with a challenge, case B)', async () => {
    const h = await harness();
    const app = await seedApp(h);
    // Case A, Google-hosted, linked at once.
    const hosted = `a${uid()}@gmail.com`;
    h.chain.open(app.scope, 'email', await eSub(h, hosted));
    const a = await google(h, '/v1/email/google-match', app, gAccount(hosted));
    expect([a.body.decision, typeof a.body.emailToken]).toEqual(['case_a', 'string']);
    expect(await open(a.body.sealedEmail, app.id, a.commitment.sessionPublicKey, h.clock.now)).toMatchObject({ ok: true, email: hosted, src: 'google' });
    // Case A, not Google-hosted: a prepared challenge.
    const corp = `c${uid()}@corp.example`;
    h.chain.open(app.scope, 'email', await eSub(h, corp));
    const c = await google(h, '/v1/email/google-match', app, gAccount(corp));
    expect(c.body.decision).toBe('case_a');
    expect(c.body.challenge).toBeDefined();
    expect(await open(c.body.sealedEmail, app.id, c.commitment.sessionPublicKey, h.clock.now)).toMatchObject({ ok: true, email: corp, src: 'google' });
    // Case B: G has the wallet.
    const b = gAccount(`b${uid()}@gmail.com`);
    await google(h, '/v1/email/google-match', app, b);
    h.chain.open(app.scope, 'google', b.sub);
    const mb = await google(h, '/v1/email/google-match', app, b);
    expect(mb.body.decision).toBe('case_b');
    expect(await open(mb.body.sealedEmail, app.id, mb.commitment.sessionPublicKey, h.clock.now)).toMatchObject({ ok: true, email: b.email, src: 'google' });
  });

  it('google-record: {accepted, sealedEmail} for an app without email login, sealed the same way', async () => {
    const h = await harness();
    const app = await seedApp(h, { methods: 'google', scope: { email: false } });
    const account = gAccount(`Rec.Ord${uid()}@GMail.com`);
    const { res, body, commitment } = await google(h, '/v1/email/google-record', app, account);
    expect(res.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['accepted', 'sealedEmail']);
    expect(await open(body.sealedEmail, app.id, commitment.sessionPublicKey, h.clock.now)).toEqual({ ok: true, email: account.email.toLowerCase(), src: 'google', notAfterMs: commitment.expiresAtMs });
  });

  it('no blob for an address Google didn’t verify, nor for one that isn’t an address the login accepts', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const unverified = gAccount(`u${uid()}@gmail.com`, { emailVerified: false });
    const m = await google(h, '/v1/email/google-match', app, unverified);
    expect(m.body).toEqual({ decision: 'none', googleHosted: false, linkable: false });
    const r = await google(h, '/v1/email/google-record', app, gAccount(`v${uid()}@gmail.com`, { emailVerified: false }));
    expect(r.body).toEqual({ accepted: true });
    // Verified, but not an address normalizeEmail accepts.
    const odd = gAccount(`not-an-address-${uid()}`);
    expect((await google(h, '/v1/email/google-match', app, odd)).body.sealedEmail).toBeUndefined();
    expect((await google(h, '/v1/email/google-record', app, odd)).body).toEqual({ accepted: true });
  });

  it('without the key (or with a malformed one) no answer carries a blob, and nothing else changes', async () => {
    for (const IDENTITY_SEAL_KEY of [undefined, 'not-a-key']) {
      const h0 = await harness();
      const h = await harness({ env: { ...h0.deps.env, IDENTITY_SEAL_KEY }, sealKey: () => importSealKey(IDENTITY_SEAL_KEY) });
      const app = await seedApp(h);
      const m = await google(h, '/v1/email/google-match', app, gAccount(`n${uid()}@gmail.com`));
      expect([m.res.status, m.body]).toEqual([200, { decision: 'none', googleHosted: true, linkable: false }]);
      const r = await google(h, '/v1/email/google-record', app, gAccount(`r${uid()}@gmail.com`));
      expect([r.res.status, r.body]).toEqual([200, { accepted: true }]);
      const login = await emailLogin(h, app, `e${uid()}@example.com`);
      expect(Object.keys(login).sort()).toEqual(['commitment', 'deviceTicket', 'googleWallet', 'idToken']);
    }
  });
});

describe('verify seals the login address for a session token only (D419)', () => {
  it('a session token: the normalized address, src email, for the start’s session key and expiry', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const raw = `  Ver.Ify${uid()}@EXAMPLE.com `;
    const n = normalizeEmail(raw);
    if (!n.ok) throw new Error('test address');
    const login = await emailLogin(h, app, raw, n.email);
    expect(typeof login.idToken).toBe('string');
    expect(sealedEmailHeader(login.sealedEmail)).toEqual({ keyId: 7, notAfterMs: login.commitment.expiresAtMs });
    expect(await open(login.sealedEmail, app.id, login.commitment.sessionPublicKey, h.clock.now)).toEqual({ ok: true, email: n.email, src: 'email', notAfterMs: login.commitment.expiresAtMs });
    expect((await open(login.sealedEmail, app.id, crypto.getRandomValues(new Uint8Array(32)), h.clock.now)).ok).toBe(false);
  });

  it('the session challenge keeps the commitment’s key and expiry (and nothing else new); other purposes keep null', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const c = sessionCommitment(app.scope, h.clock.now);
    const s = await h.call('/v1/email/start', { pk: app.pk, email: `k${uid()}@example.com`, purpose: 'session', commitment: c.json });
    const { challengeId } = (await s.json()) as { challengeId: string };
    await runInDurableObject(challengeObject(challengeId), (_o, state) => {
      expect(state.storage.kv.get<ChallengeRecord>('challenge')!.seal).toEqual({ sessionPublicKey: [...c.sessionPublicKey], expiresAtMs: c.expiresAtMs });
    });
    const l = await h.call('/v1/email/start', { pk: app.pk, email: `l${uid()}@example.com`, purpose: 'link_new', commitment: linkNew(app.scope) });
    const link = (await l.json()) as { challengeId: string };
    await runInDurableObject(challengeObject(link.challengeId), (_o, state) => {
      expect(state.storage.kv.get<ChallengeRecord>('challenge')!.seal).toBeNull();
    });
  });

  it('no blob for case B, the link purposes or auto_link', async () => {
    const h = await harness();
    const app = await seedApp(h);
    // Case B: no token, no blob.
    const bEmail = `b${uid()}@gmail.com`;
    const acc = gAccount(bEmail);
    await google(h, '/v1/email/google-match', app, acc);
    h.chain.open(app.scope, 'google', acc.sub);
    const caseB = await emailLogin(h, app, bEmail);
    expect(caseB.googleWallet).toBe(true);
    expect(caseB.sealedEmail).toBeUndefined();
    // link_new: a token, no blob.
    const lEmail = `l${uid()}@example.com`;
    const l = await h.call('/v1/email/start', { pk: app.pk, email: lEmail, purpose: 'link_new', commitment: linkNew(app.scope) });
    const { challengeId } = (await l.json()) as { challengeId: string };
    const lv = await h.call('/v1/email/verify', { challengeId, code: h.sender.codeFor(lEmail) });
    const lb = (await lv.json()) as Record<string, unknown>;
    expect([lv.status, typeof lb.idToken, lb.sealedEmail]).toEqual([200, 'string', undefined]);
    // auto_link (case A, not Google-hosted): google-match's answer carries the Google blob; the code's verify none.
    const corp = `c${uid()}@corp.example`;
    h.chain.open(app.scope, 'email', await eSub(h, corp));
    const m = await google(h, '/v1/email/google-match', app, gAccount(corp));
    const ch = (m.body.challenge as { challengeId: string }).challengeId;
    h.clock.now += 1;
    expect((await h.call('/v1/email/resend', { challengeId: ch })).status).toBe(202);
    const av = await h.call('/v1/email/verify', { challengeId: ch, code: h.sender.codeFor(corp) });
    const ab = (await av.json()) as Record<string, unknown>;
    expect([av.status, ab.decision, typeof ab.idToken, ab.sealedEmail]).toEqual([200, 'case_a', 'string', undefined]);
  });

  it('a session challenge stored before the seal existed still verifies, without a blob', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const email = `old${uid()}@example.com`;
    const s = await h.call('/v1/email/start', { pk: app.pk, email, purpose: 'session', commitment: sessionCommitment(app.scope, h.clock.now).json });
    const { challengeId } = (await s.json()) as { challengeId: string };
    await runInDurableObject(challengeObject(challengeId), (_o, state) => {
      const { seal: _seal, ...old } = state.storage.kv.get<ChallengeRecord>('challenge')!;
      state.storage.kv.put('challenge', old);
    });
    const v = await h.call('/v1/email/verify', { challengeId, code: h.sender.codeFor(email) });
    const body = (await v.json()) as Record<string, unknown>;
    expect(v.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['deviceTicket', 'googleWallet', 'idToken']);
  });
});

describe('the address and the blob are never logged', () => {
  it('google-match, google-record and verify, with the key, without it, and with a malformed one', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const recordApp = await seedApp(h, { methods: 'google', scope: { email: false } });
    const local = `Se.Aled${uid().replace(/[^a-z0-9]/gu, '')}`;
    const gmail = `${local}@GMail.com`;
    const plain = `${local}@Example.com`;
    const n = normalizeEmail(plain);
    if (!n.ok) throw new Error('test address');
    const blobs: string[] = [];
    const { lines } = await captureLogs(async () => {
      const m = await google(h, '/v1/email/google-match', app, gAccount(gmail));
      const r = await google(h, '/v1/email/google-record', recordApp, gAccount(gmail));
      const login = await emailLogin(h, app, plain, n.email);
      blobs.push(m.body.sealedEmail!, r.body.sealedEmail!, login.sealedEmail!);
      for (const IDENTITY_SEAL_KEY of [undefined, 'garbage']) {
        // A fresh env name (its own limiter windows), the same apps (one D1).
        const hk = await harness({ env: { ...(await harness()).deps.env, IDENTITY_SEAL_KEY }, sealKey: () => importSealKey(IDENTITY_SEAL_KEY) });
        hk.chain.addScope(app.scope);
        await google(hk, '/v1/email/google-match', app, gAccount(gmail));
        await emailLogin(hk, app, plain, n.email);
      }
    });
    expect(blobs.every((b) => typeof b === 'string' && b.startsWith('se1.'))).toBe(true);
    expect(lines.length).toBeGreaterThan(5);
    const all = lines.join('\n').toLowerCase();
    for (const needle of [gmail, plain, n.email, local]) expect(all).not.toContain(needle.toLowerCase());
    for (const b of blobs) expect(lines.join('\n')).not.toContain(b.slice(4, 40));
    expect(lines.join('\n')).not.toContain(env.IDENTITY_SEAL_KEY!.slice(2));
  });
});
