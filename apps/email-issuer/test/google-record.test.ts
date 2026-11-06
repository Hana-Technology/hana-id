// The user directory's Google rows (D269, D270): google-match records the Google identity once its checks pass, and
// google-record (token_first, an app without email login) runs the same checks, answers `{accepted: true}` with no
// match data, then records. Neither records anything when a check fails; a directory failure never fails the answer.
import { describe, expect, it } from 'vitest';
import { IP_MATCH_LIMITS, IP_RECORD_LIMITS } from '../src/limits.ts';
import { AUTH, GOOGLE_CLIENT, VAULT, type GoogleAccount, type Harness, type TestApp, captureLogs, env, harness, nonceFor, seedApp, sessionCommitment, uid } from './helpers.ts';

const gAccount = (email: string, over: Partial<GoogleAccount> = {}): GoogleAccount => ({ sub: `1${Math.floor(Math.random() * 1e15)}`, email, ...over });

async function body(h: Harness, app: TestApp, account: GoogleAccount, opts: { aud?: string; nonce?: string; scope?: string } = {}) {
  const commitment = sessionCommitment(opts.scope ?? app.scope, h.clock.now);
  const aud = opts.aud ?? GOOGLE_CLIENT;
  const googleIdToken = await h.google.idToken(account, aud, opts.nonce ?? nonceFor(commitment));
  const accessToken = h.google.accessToken(account, GOOGLE_CLIENT);
  return { pk: app.pk, accessToken, googleIdToken, commitment: commitment.json };
}

const record = async (h: Harness, app: TestApp, account: GoogleAccount, opts: Parameters<typeof body>[3] = {}) => {
  const res = await h.call('/v1/email/google-record', await body(h, app, account, opts));
  return { res, json: (await res.json()) as Record<string, unknown> };
};

const userRow = async (sub: string) => env.DB.prepare("SELECT email, email_verified, hosted, first_seen_ms, last_seen_ms FROM user_emails WHERE provider = 'google' AND sub = ?1").bind(sub).first();
const appRows = async (sub: string) => (await env.DB.prepare("SELECT app_id, scope_id FROM user_email_apps WHERE provider = 'google' AND sub = ?1 ORDER BY app_id").bind(sub).all()).results;

describe('google-record (D270)', () => {
  it('records a Google sign-in of an app without email login, answering {accepted: true} and nothing else', async () => {
    const h = await harness();
    const app = await seedApp(h, { methods: 'google', scope: { email: false } });
    const account = gAccount(`Rec.Ord${uid()}@GMail.com`);
    const issuedBefore = (await env.DB.prepare('SELECT COUNT(*) AS n FROM email_issuance').first<number>('n')) ?? 0;
    const { res, json } = await record(h, app, account);
    expect(res.status).toBe(200);
    // No match data: no decision, no hosted flag, no token, no challenge; only the sealed address (D418).
    expect(json).toEqual({ accepted: true, sealedEmail: expect.stringMatching(/^se1\./u) });
    expect(res.headers.get('access-control-allow-origin')).toBe(VAULT);
    expect(await userRow(account.sub)).toEqual({ email: account.email.toLowerCase(), email_verified: 1, hosted: 1, first_seen_ms: h.clock.now, last_seen_ms: h.clock.now });
    expect(await appRows(account.sub)).toEqual([{ app_id: app.id, scope_id: app.scope }]);
    // Nothing else happened: no hint, no token, no mail, no revocation (D265).
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM email_hints WHERE google_sub = ?1').bind(account.sub).first<number>('n')) ?? 0).toBe(0);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM email_issuance').first<number>('n')) ?? 0).toBe(issuedBefore);
    expect(h.sender.sent).toEqual([]);
    expect(h.google.revoked).toEqual([]);
    // The chain is read for the app's Google clients only: no identity or account is judged.
    expect(h.chain.calls).toEqual(['get_scope']);
  });

  it('records the Workspace flag and an unverified address as Google answers them; a second login updates the row', async () => {
    const h = await harness();
    const app = await seedApp(h, { methods: 'google' });
    const work = gAccount(`w${uid()}@corp.example`, { hd: 'corp.example' });
    await record(h, app, work);
    expect(await userRow(work.sub)).toMatchObject({ email_verified: 1, hosted: 1 });
    const unverified = gAccount(`u${uid()}@example.com`, { emailVerified: false });
    await record(h, app, unverified);
    expect(await userRow(unverified.sub)).toMatchObject({ email: unverified.email, email_verified: 0, hosted: 0 });
    const consumerElsewhere = gAccount(`c${uid()}@example.org`);
    await record(h, app, consumerElsewhere);
    expect(await userRow(consumerElsewhere.sub)).toMatchObject({ email_verified: 1, hosted: 0 });
    const first = h.clock.now;
    h.clock.now += 60_000;
    const other = await seedApp(h, { methods: 'google,email' });
    // Any active app may record, an app with email login too.
    expect((await record(h, other, work)).res.status).toBe(200);
    expect(await userRow(work.sub)).toMatchObject({ first_seen_ms: first, last_seen_ms: h.clock.now });
    expect((await appRows(work.sub)).length).toBe(2);
  });

  it('runs google-match’s checks: nothing is recorded when one fails', async () => {
    const h = await harness();
    const app = await seedApp(h, { methods: 'google' });
    const cases: [string, () => Promise<Response>, number, string][] = [
      ['another client’s access token', async () => h.call('/v1/email/google-record', await body(h, app, gAccount(`a${uid()}@gmail.com`, { tokenAud: 'other.apps.googleusercontent.com' }))), 400, 'google_token_invalid'],
      ['another account’s access token', async () => h.call('/v1/email/google-record', await body(h, app, gAccount(`b${uid()}@gmail.com`, { tokenSub: '1999' }))), 400, 'google_account_mismatch'],
      ['an ID token for another client', async () => h.call('/v1/email/google-record', await body(h, app, gAccount(`c${uid()}@gmail.com`), { aud: 'other.apps.googleusercontent.com' })), 400, 'google_token_invalid'],
      ['a nonce over another session', async () => h.call('/v1/email/google-record', await body(h, app, gAccount(`d${uid()}@gmail.com`), { nonce: 'N'.repeat(43) })), 400, 'nonce_mismatch'],
      ['a commitment for another scope', async () => h.call('/v1/email/google-record', await body(h, app, gAccount(`e${uid()}@gmail.com`), { scope: 'sother' })), 400, 'scope_mismatch'],
      ['an unknown key', async () => h.call('/v1/email/google-record', { ...(await body(h, app, gAccount(`f${uid()}@gmail.com`))), pk: 'pk_test_1111111111111111' }), 401, 'invalid_key'],
      ['a forged ID token', async () => h.call('/v1/email/google-record', { ...(await body(h, app, gAccount(`g${uid()}@gmail.com`))), googleIdToken: 'h.p.s' }), 400, 'google_token_invalid'],
      ['match fields', async () => h.call('/v1/email/google-record', { ...(await body(h, app, gAccount(`h${uid()}@gmail.com`))), link: true }), 400, 'bad_request'],
    ];
    for (const [what, call, status, code] of cases) {
      const res = await call();
      expect([res.status, ((await res.json()) as { code: string }).code], what).toEqual([status, code]);
    }
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM user_email_apps WHERE app_id = ?1').bind(app.id).first<number>('n')) ?? 0).toBe(0);
    // A suspended app records nothing either.
    const suspended = await seedApp(h, { methods: 'google', status: 'suspended' });
    const s = await record(h, suspended, gAccount(`s${uid()}@gmail.com`));
    expect([s.res.status, s.json.code]).toEqual([403, 'app_suspended']);
    // Google down: a 502 the vault drops (best effort), nothing recorded.
    h.google.userinfoStatus = 503;
    const down = gAccount(`x${uid()}@gmail.com`);
    expect((await record(h, app, down)).res.status).toBe(502);
    h.google.userinfoStatus = 200;
    expect(await userRow(down.sub)).toBeNull();
  });

  it('a directory failure is logged and never fails the answer', async () => {
    const h0 = await harness();
    const broken = { ...env.DB, batch: () => Promise.reject(new Error('d1 down')), prepare: env.DB.prepare.bind(env.DB) } as unknown as D1Database;
    const h = await harness({ env: { ...h0.deps.env, DB: broken } });
    const app = await seedApp(h, { methods: 'google' });
    const account = gAccount(`z${uid()}@gmail.com`);
    const { result, lines } = await captureLogs(() => record(h, app, account));
    expect([result.res.status, result.json]).toEqual([200, { accepted: true, sealedEmail: expect.stringMatching(/^se1\./u) }]);
    const failed = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === 'directory_write_failed');
    expect(failed).toEqual([expect.objectContaining({ appId: app.id, scopeId: app.scope })]);
    expect(lines.join('\n')).not.toContain(account.sub);
  });

  it('only from the vault’s origin, with a client address; its own per-IP limit, with retry-after exposed', async () => {
    const h = await harness();
    const app = await seedApp(h, { methods: 'google' });
    const b = await body(h, app, gAccount(`o${uid()}@gmail.com`));
    expect((await h.call('/v1/email/google-record', b, { origin: AUTH })).status).toBe(403);
    expect((await h.call('/v1/email/google-record', b, { origin: null })).status).toBe(403);
    expect((await h.call('/v1/email/google-record', b, { ip: null })).status).toBe(400);
    const pre = await h.call('/v1/email/google-record', undefined, { method: 'OPTIONS' });
    expect([pre.status, pre.headers.get('access-control-allow-origin')]).toEqual([204, VAULT]);
    const ip = '192.0.2.78';
    const junk = { pk: app.pk, accessToken: 'ya29.x', googleIdToken: 'h.p.s', commitment: sessionCommitment(app.scope, h.clock.now).json };
    for (let i = 0; i < IP_RECORD_LIMITS[0]!.max; i++) expect((await h.call('/v1/email/google-record', junk, { ip })).status).not.toBe(429);
    const limited = await h.call('/v1/email/google-record', junk, { ip });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(limited.headers.get('access-control-allow-origin')).toBe(VAULT);
    expect((limited.headers.get('access-control-expose-headers') ?? '').toLowerCase()).toContain('retry-after');
    // A window of its own: google-match from that address is unaffected.
    expect(IP_RECORD_LIMITS[0]!.name).not.toBe(IP_MATCH_LIMITS[0]!.name);
    const emailApp = await seedApp(h);
    const commitment = sessionCommitment(emailApp.scope, h.clock.now);
    const acc = gAccount(`m${uid()}@gmail.com`);
    const m = await h.call('/v1/email/google-match', { pk: emailApp.pk, accessToken: h.google.accessToken(acc, GOOGLE_CLIENT), googleIdToken: await h.google.idToken(acc, GOOGLE_CLIENT, nonceFor(commitment)), commitment: commitment.json, link: true }, { ip });
    expect(m.status).toBe(200);
  });
});

describe('google-match records the Google identity (D269)', () => {
  it('after its checks pass, whatever the decision; never when they fail', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const account = gAccount(`Mat.Ch${uid()}@gmail.com`);
    const commitment = sessionCommitment(app.scope, h.clock.now);
    const googleIdToken = await h.google.idToken(account, GOOGLE_CLIENT, nonceFor(commitment));
    const m = await h.call('/v1/email/google-match', { pk: app.pk, accessToken: h.google.accessToken(account, GOOGLE_CLIENT), googleIdToken, commitment: commitment.json, link: true });
    expect(((await m.json()) as { decision: string }).decision).toBe('none');
    expect(await userRow(account.sub)).toMatchObject({ email: account.email.toLowerCase(), email_verified: 1, hosted: 1 });
    expect(await appRows(account.sub)).toEqual([{ app_id: app.id, scope_id: app.scope }]);
    // An unverified address can't match (decision none) but is recorded with its flag.
    const unverified = gAccount(`uv${uid()}@gmail.com`, { emailVerified: false });
    const c2 = sessionCommitment(app.scope, h.clock.now);
    await h.call('/v1/email/google-match', { pk: app.pk, accessToken: h.google.accessToken(unverified, GOOGLE_CLIENT), googleIdToken: await h.google.idToken(unverified, GOOGLE_CLIENT, nonceFor(c2)), commitment: c2.json, link: true });
    expect(await userRow(unverified.sub)).toMatchObject({ email_verified: 0, hosted: 0 });
    // Another account's access token: refused, nothing recorded for either.
    const other = gAccount(`ot${uid()}@gmail.com`, { tokenSub: '1777' });
    const c3 = sessionCommitment(app.scope, h.clock.now);
    const refused = await h.call('/v1/email/google-match', { pk: app.pk, accessToken: h.google.accessToken(other, GOOGLE_CLIENT), googleIdToken: await h.google.idToken(other, GOOGLE_CLIENT, nonceFor(c3)), commitment: c3.json, link: true });
    expect(refused.status).toBe(400);
    expect(await userRow(other.sub)).toBeNull();
    expect(await userRow('1777')).toBeNull();
  });
});
