// Hana Home's email route (`POST /v1/email/home/start`, then the shared `resend` and `verify`): the Home identity and the
// per-app session, gated on the chain alone (no app, no IssuerRpc read, D434); the nonce computed from typed inputs and
// never taken from the request (H1's review condition); the same `sub` as any email login; the mailbox limits; the
// exit list's email entry (D485, D494).
import { HOME_EMAIL_AUDIENCE, HOME_IDENTITY_MAX_LIFETIME_MS, homeNonce } from '@hana-id/core/home';
import { describe, expect, it } from 'vitest';
import { clientProofNonce } from '../src/client-proof.ts';
import { HOME_ISSUER_APP } from '../src/handlers.ts';
import { sessionNonceOf } from '../src/layouts.ts';
import { captureLogs, decodeToken, emailLogin, env, harness, seedApp, uid, type Harness } from './helpers.ts';

const HOME_START = '/v1/email/home/start';
const addr = (tag: string) => `${tag}${uid().replace(/[^a-z0-9]/gu, '')}@example.com`;
const bytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));

/** A Home identity's commitment: the Home key, its end and its salt (what the /home page makes at each sign-in). */
function identity(h: Harness, over: Record<string, unknown> = {}) {
  const homePublicKey = bytes(32);
  const salt = bytes(32);
  const expiresAtMs = h.clock.now + 15 * 60_000;
  const json = { homePublicKey: [...homePublicKey], expiresAtMs, salt: [...salt], ...over };
  return { json, nonce: homeNonce({ signer: env.SIGNER_ACCOUNT, homePublicKey, expiresAtMs, salt }) };
}

/** A Home session's commitment: one use, key index 0, 15 minutes (what home-export.ts makes for one app's wallet). */
function session(h: Harness, scopeId: string, over: Record<string, unknown> = {}) {
  const sessionPublicKey = bytes(32);
  const salt = bytes(32);
  const c = { scopeId, sessionPublicKey, expiresAtMs: h.clock.now + 15 * 60_000, keyIndex: 0, maxUses: 1, salt };
  return { json: { scopeId, sessionPublicKey: [...sessionPublicKey], expiresAtMs: c.expiresAtMs, keyIndex: 0, maxUses: 1, salt: [...salt], ...over }, nonce: sessionNonceOf(env.SIGNER_ACCOUNT, c) };
}

/** start → the code from the mail → verify. */
async function homeCode(h: Harness, email: string, kind: 'identity' | 'derive', commitment: Record<string, unknown>) {
  const s = await h.call(HOME_START, { email, kind, commitment });
  expect(s.status).toBe(202);
  const { challengeId } = (await s.json()) as { challengeId: string };
  return h.call('/v1/email/verify', { challengeId, code: h.sender.codeFor(email) });
}

/** The API's IssuerRpc made unreachable: any read of an app fails the test. */
function noAppReads(h: Harness): void {
  const refuse = () => {
    throw new Error('Hana Home’s route must not read an app');
  };
  h.deps.env = { ...h.deps.env, API: { appByKey: refuse, appById: refuse, scopeHasEmailApp: refuse } as unknown as typeof h.deps.env.API };
}

/** A scope on chain with no app anywhere (a shut-down partner's, purged from D1). */
function bareScope(h: Harness, opts: { email?: boolean } = {}): string {
  const scope = `s${uid().replace(/[^a-z0-9]/gu, '')}`.slice(0, 40);
  h.chain.addScope(scope, { email: opts.email ?? true, google: [] });
  return scope;
}

describe('Hana Home: the identity', () => {
  it('a code mailed in Hana Home’s words; verify answers {idToken} only, audience hana-home, the Home nonce of the typed inputs', async () => {
    const h = await harness();
    noAppReads(h);
    const email = addr('home');
    const c = identity(h);
    const s = await h.call(HOME_START, { email, kind: 'identity', commitment: c.json });
    expect(s.status).toBe(202);
    expect(s.headers.get('access-control-allow-origin')).toBe('https://auth.test');
    const started = (await s.json()) as { challengeId: string };
    expect(Object.keys(started).sort()).toEqual(['challengeId', 'expiresAtMs', 'resendAfterMs']);
    const mail = h.sender.sent.at(-1)!;
    expect(mail.subject).toBe('Your sign-in code for Hana Home');
    expect(mail.text).toContain('Your code to sign in to Hana Home:');
    expect(mail.text).not.toMatch(/https?:\/\//u);
    expect(mail.appId).toBe(HOME_ISSUER_APP);

    const v = await h.call('/v1/email/verify', { challengeId: started.challengeId, code: h.sender.codeFor(email) });
    expect(v.status).toBe(200);
    const body = (await v.json()) as Record<string, unknown>;
    // No device ticket (Hana Home keeps none), no sealed address, no case B.
    expect(Object.keys(body)).toEqual(['idToken']);
    const t = await decodeToken(body.idToken as string);
    expect(t.verified).toBe(true);
    expect(Object.keys(t.claims)).toEqual(['iss', 'aud', 'sub', 'iat', 'exp', 'nonce', 'jti']);
    expect(t.claims.aud).toBe(HOME_EMAIL_AUDIENCE);
    expect(t.claims.nonce).toBe(c.nonce);
    expect(t.claims.sub).toMatch(/^e1\.[A-Za-z0-9_-]{43}$/u);
    // The issuance row names Hana Home, not an app.
    const row = await env.DB.prepare('SELECT app_id, purpose FROM email_issuance WHERE jti = ?1').bind(t.claims.jti).first<{ app_id: string; purpose: string }>();
    expect(row).toEqual({ app_id: HOME_ISSUER_APP, purpose: 'home' });
    // Not an app's login: nothing goes to the user directory.
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM user_emails WHERE provider = 'email' AND sub = ?1").bind(t.claims.sub).first<{ n: number }>()).toEqual({ n: 0 });
  });

  it('the same `sub` as a normal email login of the same address (and of its other spellings)', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const email = addr('same');
    const normal = await emailLogin(h, app, email);
    const normalSub = (await decodeToken(normal.idToken!)).claims.sub;
    const v = await homeCode(h, email, 'identity', identity(h).json);
    expect((await decodeToken(((await v.json()) as { idToken: string }).idToken)).claims.sub).toBe(normalSub);
    const s = session(h, app.scope);
    const d = await homeCode(h, email, 'derive', s.json);
    expect((await decodeToken(((await d.json()) as { idToken: string }).idToken)).claims.sub).toBe(normalSub);
  });

  it('refused while ("email", "hana-home") isn’t an exit client in force: no mail, and the verify of an earlier code refuses too', async () => {
    const h = await harness();
    const email = addr('noexit');
    h.chain.homeExit = false;
    const r = await h.call(HOME_START, { email, kind: 'identity', commitment: identity(h).json });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { code: string }).code).toBe('home_email_unavailable');
    expect(h.sender.sent).toHaveLength(0);

    // Removed in an emergency (D483) between the mail and the code: nothing is minted.
    h.chain.homeExit = true;
    const s = await h.call(HOME_START, { email, kind: 'identity', commitment: identity(h).json });
    const { challengeId } = (await s.json()) as { challengeId: string };
    h.chain.homeExit = false;
    const v = await h.call('/v1/email/verify', { challengeId, code: h.sender.codeFor(email) });
    expect(v.status).toBe(409);
    expect(((await v.json()) as { code: string }).code).toBe('home_email_unavailable');
  });

  it('the identity lasts at most 20 minutes and must not have ended', async () => {
    const h = await harness();
    for (const expiresAtMs of [h.clock.now, h.clock.now + HOME_IDENTITY_MAX_LIFETIME_MS + 1]) {
      const r = await h.call(HOME_START, { email: addr('end'), kind: 'identity', commitment: identity(h, { expiresAtMs }).json });
      expect(r.status).toBe(400);
    }
    expect((await h.call(HOME_START, { email: addr('end'), kind: 'identity', commitment: identity(h, { expiresAtMs: h.clock.now + HOME_IDENTITY_MAX_LIFETIME_MS }).json })).status).toBe(202);
  });
});

describe('Hana Home: no free-form nonce', () => {
  it('a nonce, a publishable key, an audience or any other field is refused, in the body or the commitment', async () => {
    const h = await harness();
    const scope = bareScope(h);
    const email = addr('shape');
    const nonce = clientProofNonce(env.SIGNER_ACCOUNT, scope, 0);
    const bodies: unknown[] = [
      { email, kind: 'identity', commitment: identity(h).json, nonce },
      { email, kind: 'identity', commitment: identity(h).json, pk: 'pk_test_x' },
      { email, kind: 'identity', commitment: identity(h).json, aud: `email:${scope}` },
      { email, kind: 'identity', commitment: { ...identity(h).json, nonce } },
      { email, kind: 'derive', commitment: { ...session(h, scope).json, nonce } },
      { email, kind: 'client_proof', commitment: { scopeId: scope, actionNonce: 0 } },
      { email, kind: 'session', commitment: session(h, scope).json },
      { email, kind: 'identity', commitment: { homePublicKey: [...bytes(31)], expiresAtMs: h.clock.now + 60_000, salt: [...bytes(32)] } },
      { email, kind: 'identity', commitment: { homePublicKey: [...bytes(32)], expiresAtMs: h.clock.now + 60_000, salt: [...bytes(16)] } },
      { email, kind: 'identity' },
    ];
    for (const b of bodies) expect((await h.call(HOME_START, b)).status, JSON.stringify(Object.keys(b as object))).toBe(400);
    // And the normal route takes no Home purpose.
    const app = await seedApp(h);
    for (const purpose of ['home', 'home_session']) expect((await h.call('/v1/email/start', { pk: app.pk, email, purpose, commitment: session(h, app.scope).json })).status).toBe(400);
    expect(h.sender.sent).toHaveLength(0);
  });

  it('the client-proof registration attack fails: no hana-home token can carry a client proof’s nonce', async () => {
    // The attack (H1's review): an owner of scope S gets a `hana-home` token whose nonce is
    // client_proof_nonce(signer, S, action_nonce) for their own mailbox, and proposes AddClient("email", "hana-home") on
    // S with it. The route takes no nonce; every one it signs is a Home or a session nonce of the typed inputs, whose
    // domains differ from the client proof's. (The contract refuses the client by its shape too: tests/email/exit.rs.)
    const h = await harness();
    const scope = bareScope(h, { email: false });
    const email = addr('owner');
    const proofs = new Set([0, 1, 2, 3].map((n) => clientProofNonce(env.SIGNER_ACCOUNT, scope, n)));
    const id = identity(h);
    const idToken = ((await (await homeCode(h, email, 'identity', id.json)).json()) as { idToken: string }).idToken;
    const s = session(h, scope);
    const sessionToken = ((await (await homeCode(h, email, 'derive', s.json)).json()) as { idToken: string }).idToken;
    for (const [token, expected] of [
      [idToken, id.nonce],
      [sessionToken, s.nonce],
    ] as const) {
      const t = await decodeToken(token);
      expect(t.claims.aud).toBe(HOME_EMAIL_AUDIENCE);
      expect(t.claims.nonce).toBe(expected);
      expect(proofs.has(t.claims.nonce as string)).toBe(false);
    }
  });
});

describe('Hana Home: opening one app’s wallet', () => {
  it('a scope with its email client: the token is for `email:{scope}` (the normal route), with no app read and a suspended app', async () => {
    const h = await harness();
    const app = await seedApp(h, { status: 'suspended' });
    noAppReads(h);
    const email = addr('susp');
    const s = session(h, app.scope);
    const st = await h.call(HOME_START, { email, kind: 'derive', commitment: s.json });
    expect(st.status).toBe(202);
    const mail = h.sender.sent.at(-1)!;
    expect(mail.subject).toBe('Your code to open a wallet in Hana Home');
    expect(mail.text).not.toContain(app.name);
    const { challengeId } = (await st.json()) as { challengeId: string };
    const v = await h.call('/v1/email/verify', { challengeId, code: h.sender.codeFor(email) });
    expect(v.status).toBe(200);
    const t = await decodeToken(((await v.json()) as { idToken: string }).idToken);
    expect(t.claims.aud).toBe(`email:${app.scope}`);
    expect(t.claims.nonce).toBe(s.nonce);
  });

  it('a registered scope that dropped its email client: the exit token (hana-home), only while the exit is in force', async () => {
    const h = await harness();
    noAppReads(h);
    const scope = bareScope(h, { email: false });
    const email = addr('exit');
    const s = session(h, scope);
    const v = await homeCode(h, email, 'derive', s.json);
    expect(v.status).toBe(200);
    const t = await decodeToken(((await v.json()) as { idToken: string }).idToken);
    expect(t.claims.aud).toBe(HOME_EMAIL_AUDIENCE);
    expect(t.claims.nonce).toBe(s.nonce);

    h.chain.homeExit = false;
    const r = await h.call(HOME_START, { email, kind: 'derive', commitment: session(h, scope).json });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { code: string }).code).toBe('not_covered');
  });

  it('an unknown scope is refused; so is a session of more than one use, another key index or more than 20 minutes', async () => {
    const h = await harness();
    const email = addr('bad');
    const r = await h.call(HOME_START, { email, kind: 'derive', commitment: session(h, 'nosuchscope').json });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { code: string }).code).toBe('not_covered');
    const scope = bareScope(h);
    for (const over of [{ keyIndex: 1 }, { maxUses: 3 }, { expiresAtMs: h.clock.now + 20 * 60_000 + 1 }]) expect((await h.call(HOME_START, { email, kind: 'derive', commitment: session(h, scope, over).json })).status).toBe(400);
    expect(h.sender.sent).toHaveLength(0);
  });

  it('the scope dropped its email client between the mail and the code: the token is the exit’s', async () => {
    const h = await harness();
    const scope = bareScope(h);
    const email = addr('drop');
    const s = await h.call(HOME_START, { email, kind: 'derive', commitment: session(h, scope).json });
    const { challengeId } = (await s.json()) as { challengeId: string };
    h.chain.addScope(scope, { email: false, google: [] });
    const v = await h.call('/v1/email/verify', { challengeId, code: h.sender.codeFor(email) });
    expect((await decodeToken(((await v.json()) as { idToken: string }).idToken)).claims.aud).toBe(HOME_EMAIL_AUDIENCE);
  });
});

describe('Hana Home: the mailbox limits', () => {
  it('Home codes count in the same mailbox windows as app logins, and get the same generic 429', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const email = addr('limit');
    const ip = '10.77.1.9';
    // Production: 3 code mails per mailbox and requester per 15 minutes.
    expect((await h.call('/v1/email/start', { pk: app.pk, email, purpose: 'session', commitment: { ...session(h, app.scope).json, maxUses: 3 } }, { ip })).status).toBe(202);
    expect((await h.call(HOME_START, { email, kind: 'identity', commitment: identity(h).json }, { ip })).status).toBe(202);
    expect((await h.call(HOME_START, { email, kind: 'derive', commitment: session(h, app.scope).json }, { ip })).status).toBe(202);
    const r = await h.call(HOME_START, { email, kind: 'identity', commitment: identity(h).json }, { ip });
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('900');
    expect(((await r.json()) as { code: string }).code).toBe('rate_limited');
  });

  it('a wrong code counts as at any login; five end the challenge', async () => {
    const h = await harness();
    const email = addr('wrong');
    const s = await h.call(HOME_START, { email, kind: 'identity', commitment: identity(h).json });
    const { challengeId } = (await s.json()) as { challengeId: string };
    const code = h.sender.codeFor(email);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 4; i >= 0; i -= 1) {
      const v = await h.call('/v1/email/verify', { challengeId, code: wrong });
      expect(v.status).toBe(400);
      expect(((await v.json()) as { data: { attemptsLeft: number } }).data.attemptsLeft).toBe(i);
    }
    expect((await h.call('/v1/email/verify', { challengeId, code })).status).toBe(410);
  });

  it('a resend works as at any login, in Hana Home’s words', async () => {
    const h = await harness();
    const email = addr('resend');
    const s = await h.call(HOME_START, { email, kind: 'identity', commitment: identity(h).json });
    const { challengeId } = (await s.json()) as { challengeId: string };
    h.clock.now += 31_000;
    const r = await h.call('/v1/email/resend', { challengeId });
    expect(r.status).toBe(202);
    expect(h.sender.sent.filter((m) => m.to === email).map((m) => m.subject)).toEqual(['Your sign-in code for Hana Home', 'Your sign-in code for Hana Home']);
    expect((await h.call('/v1/email/verify', { challengeId, code: h.sender.codeFor(email) })).status).toBe(200);
  });

  it('logs no address, code, token or sub', async () => {
    const h = await harness();
    const email = addr('logs');
    const { result: v, lines } = await captureLogs(() => homeCode(h, email, 'identity', identity(h).json));
    const token = ((await v.json()) as { idToken: string }).idToken;
    const sub = (await decodeToken(token)).claims.sub as string;
    const all = lines.join('\n');
    for (const secret of [email, email.split('@')[0]!, h.sender.codeFor(email), token, sub]) expect(all).not.toContain(secret);
  });
});
