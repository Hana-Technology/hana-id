// google-match (spec "How the popup gets Google's verified email", "The four cases"; D119, D122, D132, D133, D195):
// tokeninfo and userinfo checks, the Google-hosted rule, every case's decision and link mode, no token without `link`,
// the access token revoked, link tickets, and the auto_link nonce's join read from the chain at minting.
import { describe, expect, it } from 'vitest';
import { emailSub, normalizeEmail } from '@hana-id/email';
import { sha256 } from '../src/bytes.ts';
import { autoLinkPreimage, identityKey, nonceOf, sessionPreimage } from '../src/layouts.ts';
import {
  GOOGLE_CLIENT,
  SHARED_CLIENT,
  type GoogleAccount,
  type Harness,
  type TestApp,
  decodeToken,
  emailLogin,
  env,
  harness,
  nonceFor,
  seedApp,
  sessionCommitment,
  uid,
} from './helpers.ts';

type Match = { decision: string; googleHosted: boolean; linkable: boolean; emailToken?: string; linkImmediate?: boolean; challenge?: { challengeId: string; expiresAtMs: number; to: string } };

async function match(h: Harness, app: TestApp, account: GoogleAccount, opts: { link?: boolean; linkTicket?: string; aud?: string; tokenAud?: string; nonce?: string } = {}) {
  const commitment = sessionCommitment(app.scope, h.clock.now);
  const aud = opts.aud ?? GOOGLE_CLIENT;
  const googleIdToken = await h.google.idToken(account, aud, opts.nonce ?? nonceFor(commitment));
  const accessToken = h.google.accessToken(opts.tokenAud ? { ...account, tokenAud: opts.tokenAud } : account, aud);
  const res = await h.call('/v1/email/google-match', { pk: app.pk, accessToken, googleIdToken, commitment: commitment.json, link: opts.link ?? true, ...(opts.linkTicket ? { linkTicket: opts.linkTicket } : {}) });
  return { res, body: (await res.json()) as Match & { code?: string }, accessToken, commitment };
}

const sub = async (h: Harness, email: string) => {
  const r = normalizeEmail(email);
  if (!r.ok) throw new Error(email);
  return emailSub((await h.deps.keys()).sub, r.email);
};
const gAccount = (email: string, over: Partial<GoogleAccount> = {}): GoogleAccount => ({ sub: `1${Math.floor(Math.random() * 1e15)}`, email, ...over });

describe('Google checks', () => {
  it('a tokeninfo aud mismatch is refused, and the access token is revoked anyway', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const { res, body, accessToken } = await match(h, app, gAccount(`a${uid()}@gmail.com`), { tokenAud: 'other.apps.googleusercontent.com' });
    expect(res.status).toBe(400);
    expect(body.code).toBe('google_token_invalid');
    expect(h.google.revoked).toContain(accessToken);
    // Tokens travel in bodies and headers, never in a URL.
    for (const r of h.google.requests) expect(r.url).not.toContain(accessToken);
  });

  it('an ID token for another client, with the wrong nonce, or for another scope is refused', async () => {
    const h = await harness();
    const app = await seedApp(h);
    expect((await match(h, app, gAccount('x@gmail.com'), { aud: 'other.apps.googleusercontent.com' })).body.code).toBe('google_token_invalid');
    expect((await match(h, app, gAccount('x@gmail.com'), { nonce: 'A'.repeat(43) })).body.code).toBe('nonce_mismatch');
    const other = await seedApp(h);
    const c = sessionCommitment(other.scope, h.clock.now);
    const acc = gAccount('x@gmail.com');
    const r = await h.call('/v1/email/google-match', { pk: app.pk, accessToken: h.google.accessToken(acc, GOOGLE_CLIENT), googleIdToken: await h.google.idToken(acc, GOOGLE_CLIENT, nonceFor(c)), commitment: c.json, link: true });
    expect(((await r.json()) as { code: string }).code).toBe('scope_mismatch');
  });

  it('a shared client is accepted only in an allow_shared scope; the app’s own web client restricts it', async () => {
    const h = await harness();
    const shared = await seedApp(h, { scope: { google: [], allowShared: true } });
    expect((await match(h, shared, gAccount('s@gmail.com'), { aud: SHARED_CLIENT })).res.status).toBe(200);
    const own = await seedApp(h);
    expect((await match(h, own, gAccount('s@gmail.com'), { aud: SHARED_CLIENT })).body.code).toBe('google_token_invalid');
    await env.APP_DB.prepare('UPDATE apps SET google_web_client_id = ?1 WHERE id = ?2').bind('web.apps.googleusercontent.com', own.id).run();
    h.chain.addScope(own.scope, { google: [GOOGLE_CLIENT, 'web.apps.googleusercontent.com'] });
    expect((await match(h, own, gAccount('s@gmail.com'))).body.code).toBe('google_token_invalid');
    expect((await match(h, own, gAccount('s@gmail.com'), { aud: 'web.apps.googleusercontent.com' })).res.status).toBe(200);
  });

  it('email_verified=false: no match, no hint', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const email = `u${uid()}@gmail.com`;
    await emailLogin(h, app, email).then(async () => h.chain.open(app.scope, 'email', await sub(h, email)));
    const { body } = await match(h, app, gAccount(email, { emailVerified: false }));
    expect(body).toEqual({ decision: 'none', googleHosted: false, linkable: false });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM email_hints WHERE scope_id = ?1').bind(app.scope).first('n')).toBe(0);
  });

  it('the Google-hosted rule: Gmail, googlemail, hd equal; not hd absent or different', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const cases: [GoogleAccount, boolean][] = [
      [gAccount(`a${uid()}@gmail.com`), true],
      [gAccount(`b${uid()}@googlemail.com`), true],
      [gAccount(`c${uid()}@corp.example`, { hd: 'corp.example' }), true],
      [gAccount(`d${uid()}@corp.example`), false],
      [gAccount(`e${uid()}@corp.example`, { hd: 'other.example' }), false],
      [gAccount(`f${uid()}@gmail.com`, { hd: 'corp.example' }), false],
    ];
    for (const [acc, hosted] of cases) expect((await match(h, app, acc)).body.googleHosted).toBe(hosted);
  });
});

describe('the four cases', () => {
  it('case C (neither has a wallet): none, and the hint is written', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const acc = gAccount(`c${uid()}@gmail.com`);
    const { body } = await match(h, app, acc);
    expect(body).toEqual({ decision: 'none', googleHosted: true, linkable: false });
    const row = await env.DB.prepare('SELECT google_sub FROM email_hints WHERE scope_id = ?1 AND email_sub = ?2').bind(app.scope, await sub(h, acc.email)).first<{ google_sub: string }>();
    expect(row?.google_sub).toBe(acc.sub);
  });

  it('case A, Google-hosted: G joins E’s account at once, silently; no token without link', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const email = `a${uid()}@gmail.com`;
    const eSub = await sub(h, email);
    h.chain.open(app.scope, 'email', eSub);
    const acc = gAccount(email);
    const none = await match(h, app, acc, { link: false });
    expect(none.body).toEqual({ decision: 'case_a', googleHosted: true, linkable: true });
    const sentBefore = h.sender.sent.length;
    const { body, commitment } = await match(h, app, acc, { link: true });
    expect(body.decision).toBe('case_a');
    expect(body.linkImmediate).toBe(true);
    const t = await decodeToken(body.emailToken!);
    expect(t.verified).toBe(true);
    expect(t.claims.sub).toBe(eSub);
    const gIk = identityKey(app.scope, 'google', acc.sub);
    const eIk = identityKey(app.scope, 'email', eSub);
    const hash = sha256(sessionPreimage(env.SIGNER_ACCOUNT, commitment));
    expect(t.claims.nonce).toBe(nonceOf(autoLinkPreimage(env.SIGNER_ACCOUNT, app.scope, hash, gIk, { join: 1, joinerIk: gIk, targetRootIk: eIk, targetEpoch: 0, mode: 1 })));
    // A notice to the address (spec "Notices"), linking only to authOrigin.
    const notice = h.sender.sent.slice(sentBefore).find((m) => m.kind === 'link_notice')!;
    expect(notice.to).toBe(email);
    expect(notice.text).toContain('https://auth.test/link/cancel');
  });

  it('case A where E is a member: the target is E’s root, with that account’s epoch', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const email = `m${uid()}@gmail.com`;
    const eSub = await sub(h, email);
    // E is an active member of an account rooted at another email identity R (an explicit link).
    const rSub = await sub(h, `root${uid()}@example.com`);
    h.chain.open(app.scope, 'email', rSub);
    h.chain.link(app.scope, ['email', rSub], ['email', eSub]);
    h.chain.bumpEpoch(app.scope, ['email', rSub]);
    const acc = gAccount(email);
    const { body, commitment } = await match(h, app, acc);
    expect(body.decision).toBe('case_a');
    const gIk = identityKey(app.scope, 'google', acc.sub);
    const hash = sha256(sessionPreimage(env.SIGNER_ACCOUNT, commitment));
    const t = await decodeToken(body.emailToken!);
    expect(t.claims.nonce).toBe(nonceOf(autoLinkPreimage(env.SIGNER_ACCOUNT, app.scope, hash, gIk, { join: 1, joinerIk: gIk, targetRootIk: identityKey(app.scope, 'email', rSub), targetEpoch: 2, mode: 1 })));
  });

  it('case A, not Google-hosted: a prepared challenge; the code goes out on resend; verify mints the auto_link token', async () => {
    const h = await harness();
    const app = await seedApp(h, { name: 'Corp Wallet' });
    const email = `w${uid()}@corp.example`;
    const eSub = await sub(h, email);
    h.chain.open(app.scope, 'email', eSub);
    const acc = gAccount(email);
    const { body, commitment } = await match(h, app, acc, { link: false });
    expect(body.decision).toBe('case_a');
    expect(body.googleHosted).toBe(false);
    expect(body.emailToken).toBeUndefined();
    expect(body.challenge!.to).toBe(`w…@corp.example`);
    expect(h.sender.to(email)).toHaveLength(0);
    // "Link and continue": the first code.
    const r = await h.call('/v1/email/resend', { challengeId: body.challenge!.challengeId });
    expect(r.status).toBe(202);
    const mail = h.sender.to(email)[0]!;
    expect(mail.text).toContain('add this email to an existing wallet in “Corp Wallet”');
    // The account moved on meanwhile (another link elsewhere bumped E's epoch): the token commits to what is read now.
    const g2 = `9${Math.floor(Math.random() * 1e15)}`;
    h.chain.link(app.scope, ['email', eSub], ['google', g2]);
    h.chain.unlink(app.scope, ['email', eSub], ['google', g2]);
    const v = await h.call('/v1/email/verify', { challengeId: body.challenge!.challengeId, code: h.sender.codeFor(email) });
    expect(v.status).toBe(200);
    const out = (await v.json()) as { idToken: string; decision: string; linkImmediate: boolean };
    expect(out.decision).toBe('case_a');
    const t = await decodeToken(out.idToken);
    const gIk = identityKey(app.scope, 'google', acc.sub);
    const eIk = identityKey(app.scope, 'email', eSub);
    const epoch = h.chain.accounts.get(h.chain.ik(app.scope, 'email', eSub))!.epoch;
    const hash = sha256(sessionPreimage(env.SIGNER_ACCOUNT, commitment));
    expect(t.claims.nonce).toBe(nonceOf(autoLinkPreimage(env.SIGNER_ACCOUNT, app.scope, hash, gIk, { join: 1, joinerIk: gIk, targetRootIk: eIk, targetEpoch: epoch, mode: 1 })));
    const row = await env.DB.prepare('SELECT purpose FROM email_issuance WHERE jti = ?1').bind(t.claims.jti).first<{ purpose: string }>();
    expect(row?.purpose).toBe('auto_link');
  });

  it('case A, not Google-hosted: if G got a wallet before the code, verify refuses (no second wallet, no wrong join)', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const email = `y${uid()}@corp.example`;
    const eSub = await sub(h, email);
    h.chain.open(app.scope, 'email', eSub);
    const acc = gAccount(email);
    const { body } = await match(h, app, acc);
    await h.call('/v1/email/resend', { challengeId: body.challenge!.challengeId });
    h.chain.open(app.scope, 'google', acc.sub);
    const v = await h.call('/v1/email/verify', { challengeId: body.challenge!.challengeId, code: h.sender.codeFor(email) });
    expect(v.status).toBe(409);
    expect(await v.json()).toMatchObject({ code: 'link_refused', data: { decision: 'both_wallets' } });
  });

  for (const hosted of [true, false]) {
    it(`case B, ${hosted ? 'Google-hosted (at once)' : 'not Google-hosted (pending)'}: verify says googleWallet with a ticket; the Google step mints the join`, async () => {
      const h = await harness();
      const app = await seedApp(h);
      const email = hosted ? `b${uid()}@gmail.com` : `b${uid()}@corp.example`;
      const acc = gAccount(email, hosted ? {} : { hd: 'other.example' });
      // An earlier Google login wrote the hint and opened G's wallet.
      await match(h, app, acc);
      h.chain.open(app.scope, 'google', acc.sub);
      const login = await emailLogin(h, app, email);
      expect(login.googleWallet).toBe(true);
      expect(login.linkTicket).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      // Without the ticket (a plain Google login), nothing is minted: never silently at a Google login.
      const plain = await match(h, app, acc);
      expect(plain.body.decision).toBe('case_b');
      expect(plain.body.emailToken).toBeUndefined();
      const { body, commitment } = await match(h, app, acc, { linkTicket: login.linkTicket! });
      expect(body.linkImmediate).toBe(hosted);
      const eSub = await sub(h, email);
      const t = await decodeToken(body.emailToken!);
      expect(t.claims.sub).toBe(eSub);
      const gIk = identityKey(app.scope, 'google', acc.sub);
      const eIk = identityKey(app.scope, 'email', eSub);
      const hash = sha256(sessionPreimage(env.SIGNER_ACCOUNT, commitment));
      expect(t.claims.nonce).toBe(nonceOf(autoLinkPreimage(env.SIGNER_ACCOUNT, app.scope, hash, gIk, { join: 2, joinerIk: eIk, targetRootIk: gIk, targetEpoch: 0, mode: hosted ? 1 : 0 })));
      // The notice says pending when it is.
      expect(h.sender.to(email).find((m) => m.kind === 'link_notice')!.text).toContain(hosted ? 'now opens' : 'waiting period');
      // Single use.
      expect((await match(h, app, acc, { linkTicket: login.linkTicket! })).body.emailToken).toBeUndefined();
    });
  }

  it('case B: a ticket for another address, or another app, mints nothing; link=false mints nothing', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const email = `t${uid()}@gmail.com`;
    const acc = gAccount(email);
    await match(h, app, acc);
    h.chain.open(app.scope, 'google', acc.sub);
    const login = await emailLogin(h, app, email);
    const other = gAccount(`o${uid()}@gmail.com`, { sub: acc.sub });
    expect((await match(h, app, other, { linkTicket: login.linkTicket! })).body.emailToken).toBeUndefined();
    const login2 = await emailLogin(h, app, email);
    expect((await match(h, app, acc, { linkTicket: login2.linkTicket!, link: false })).body.emailToken).toBeUndefined();
  });

  it('both wallets, already linked, pending, unlinked, full account', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const mk = async (tag: string) => {
      const email = `${tag}${uid()}@gmail.com`;
      return { email, acc: gAccount(email), eSub: await sub(h, email) };
    };
    const d = await mk('d');
    h.chain.open(app.scope, 'email', d.eSub);
    h.chain.open(app.scope, 'google', d.acc.sub);
    expect((await match(h, app, d.acc)).body).toMatchObject({ decision: 'both_wallets', linkable: false });

    const l = await mk('l');
    h.chain.open(app.scope, 'email', l.eSub);
    h.chain.link(app.scope, ['email', l.eSub], ['google', l.acc.sub]);
    expect((await match(h, app, l.acc)).body.decision).toBe('linked');

    const p = await mk('p');
    h.chain.open(app.scope, 'google', p.acc.sub);
    h.chain.link(app.scope, ['google', p.acc.sub], ['email', p.eSub], false);
    expect((await match(h, app, p.acc)).body.decision).toBe('pending');

    const u = await mk('u');
    h.chain.open(app.scope, 'email', u.eSub);
    h.chain.link(app.scope, ['email', u.eSub], ['google', u.acc.sub]);
    h.chain.unlink(app.scope, ['email', u.eSub], ['google', u.acc.sub]);
    expect((await match(h, app, u.acc)).body).toMatchObject({ decision: 'unlinked', linkable: false });
    expect((await match(h, app, u.acc)).body.emailToken).toBeUndefined();

    // E's account already has a Google member: case A can't link ("Sign in with email" only).
    const f = await mk('f');
    h.chain.open(app.scope, 'email', f.eSub);
    h.chain.link(app.scope, ['email', f.eSub], ['google', `8${uid()}`]);
    const full = await match(h, app, f.acc);
    expect(full.body).toMatchObject({ decision: 'case_a', linkable: false });
    expect(full.body.emailToken).toBeUndefined();
  });

  it('while the chain has unrecorded pre-v3 wallets, nothing is linkable (D135)', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const email = `r${uid()}@gmail.com`;
    h.chain.open(app.scope, 'email', await sub(h, email));
    h.chain.unrecorded = true;
    const { body } = await match(h, app, gAccount(email));
    expect(body).toMatchObject({ decision: 'case_a', linkable: false });
    expect(body.emailToken).toBeUndefined();
  });

  it('a Gmail +tag is kept: Google’s name+1@gmail.com matches the email login of name+1@gmail.com only', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const base = `n${uid().replace(/[^a-z0-9]/gu, '')}`;
    const tagged = `${base}+1@gmail.com`;
    h.chain.open(app.scope, 'email', await sub(h, tagged));
    expect((await match(h, app, gAccount(`${base.slice(0, 2)}.${base.slice(2)}+1@gmail.com`))).body.decision).toBe('case_a');
    expect((await match(h, app, gAccount(`${base}@gmail.com`))).body.decision).toBe('none');
  });
});
