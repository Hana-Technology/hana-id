// The user directory at email logins (D269): every 200 from verify records the email identity (its `e1.` sub, the
// normalized address, verified) with the app and scope; a wrong, expired or refused code records nothing; a D1 failure
// never changes the answer. Rows are read by provider 'email' only, so Google-side writes (google-match) can't mask these.
import { emailSub, normalizeEmail } from '@hana-id/email';
import { describe, expect, it } from 'vitest';
import { toHex } from '../src/bytes.ts';
import { GOOGLE_CLIENT, type Harness, type TestApp, captureLogs, emailLogin, env, harness, nonceFor, seedApp, sessionCommitment, uid } from './helpers.ts';

const subOf = async (h: Harness, email: string): Promise<string> => {
  const r = normalizeEmail(email);
  if (!r.ok) throw new Error('bad test address');
  return emailSub((await h.deps.keys()).sub, r.email);
};
const emailRows = async () => (await env.DB.prepare("SELECT * FROM user_emails WHERE provider = 'email' ORDER BY sub").all()).results;
const emailAppRows = async () => (await env.DB.prepare("SELECT * FROM user_email_apps WHERE provider = 'email' ORDER BY app_id").all()).results;

async function startCode(h: Harness, app: TestApp, email: string, purpose = 'session', commitment: Record<string, unknown> = sessionCommitment(app.scope, h.clock.now).json): Promise<string> {
  const s = await h.call('/v1/email/start', { pk: app.pk, email, purpose, commitment });
  expect(s.status).toBe(202);
  return ((await s.json()) as { challengeId: string }).challengeId;
}

/** The real D1 with its `batch` replaced (every other method bound to the real database). */
const withBatch = (db: D1Database, batch: (s: D1PreparedStatement[]) => Promise<D1Result[]>): D1Database =>
  new Proxy(db, {
    get: (t, k) => {
      if (k === 'batch') return batch;
      const v: unknown = Reflect.get(t, k, t);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });

const linkNewCommitment = (app: TestApp) => ({ scopeId: app.scope, rootIk: toHex(crypto.getRandomValues(new Uint8Array(32))), epoch: 1, salt: [...crypto.getRandomValues(new Uint8Array(20))] });

describe('email logins write the user directory (D269)', () => {
  it('a session verify records the email identity with its normalized address, verified, and the app and scope', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const local = `Dir.Ect${uid().replace(/[^a-z0-9]/gu, '')}`;
    const normalized = `${local.toLowerCase().replace(/\./gu, '')}@gmail.com`;
    const login = await emailLogin(h, app, ` ${local}@GMail.com `, normalized);
    expect(login.idToken).toBeDefined();
    const sub = await subOf(h, normalized);
    expect(sub.startsWith('e1.')).toBe(true);
    expect(await emailRows()).toEqual([{ provider: 'email', sub, email: normalized, email_verified: 1, hosted: null, first_seen_ms: h.clock.now, last_seen_ms: h.clock.now }]);
    expect(await emailAppRows()).toEqual([{ provider: 'email', sub, app_id: app.id, scope_id: app.scope, first_seen_ms: h.clock.now, last_seen_ms: h.clock.now }]);
  });

  it('a later login moves last_seen; a login to another app adds its app row, the identity row stays one', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const other = await seedApp(h);
    const email = `again${uid()}@example.com`;
    const t0 = h.clock.now;
    await emailLogin(h, app, email);
    h.clock.now += 60_000;
    await emailLogin(h, other, email);
    const rows = await emailRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email, first_seen_ms: t0, last_seen_ms: t0 + 60_000 });
    expect((await emailAppRows()).map((r) => [r.app_id, r.scope_id]).sort()).toEqual([[app.id, app.scope], [other.id, other.scope]].sort());
  });

  it('case B (no token: a Google identity has the wallet) still records: the code proved the address', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const email = `caseb${uid()}@gmail.com`;
    const googleSub = `1${Math.floor(Math.random() * 1e15)}`;
    await env.DB.prepare('INSERT INTO email_hints (scope_id, email_sub, google_sub, hosted, updated_at_ms) VALUES (?1, ?2, ?3, 1, ?4)').bind(app.scope, await subOf(h, email), googleSub, h.clock.now).run();
    h.chain.open(app.scope, 'google', googleSub);
    const login = await emailLogin(h, app, email);
    expect(login.googleWallet).toBe(true);
    expect(login.idToken).toBeUndefined();
    expect(await emailRows()).toMatchObject([{ sub: await subOf(h, email), email }]);
  });

  it('the link purposes record at their verify', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const email = `link${uid()}@example.com`;
    const challengeId = await startCode(h, app, email, 'link_new', linkNewCommitment(app));
    expect((await h.call('/v1/email/verify', { challengeId, code: h.sender.codeFor(email) })).status).toBe(200);
    expect(await emailRows()).toMatchObject([{ sub: await subOf(h, email), email }]);
  });

  it('case A with a code (auto_link, prepared by google-match) records the email identity at its verify', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const email = `casea${uid()}@corp.example`;
    const eSub = await subOf(h, email);
    h.chain.open(app.scope, 'email', eSub);
    const acc = { sub: `1${Math.floor(Math.random() * 1e15)}`, email };
    const c = sessionCommitment(app.scope, h.clock.now);
    const m = await h.call('/v1/email/google-match', { pk: app.pk, accessToken: h.google.accessToken(acc, GOOGLE_CLIENT), googleIdToken: await h.google.idToken(acc, GOOGLE_CLIENT, nonceFor(c)), commitment: c.json, link: true });
    const { challenge } = (await m.json()) as { challenge: { challengeId: string } };
    // Nothing for the email identity before its code.
    expect(await emailRows()).toEqual([]);
    await h.call('/v1/email/resend', { challengeId: challenge.challengeId });
    const v = await h.call('/v1/email/verify', { challengeId: challenge.challengeId, code: h.sender.codeFor(email) });
    expect(v.status).toBe(200);
    expect(await emailRows()).toMatchObject([{ sub: eSub, email }]);
    expect(await emailAppRows()).toMatchObject([{ sub: eSub, app_id: app.id, scope_id: app.scope }]);
  });

  it('a start, a wrong code, an expired challenge and refusals after a right code record nothing', async () => {
    const h = await harness();
    const app = await seedApp(h);
    // Start alone, then a wrong code.
    const a = `wrong${uid()}@example.com`;
    const id1 = await startCode(h, app, a);
    expect(await emailRows()).toEqual([]);
    const wrong = h.sender.codeFor(a) === '000000' ? '000001' : '000000';
    expect((await h.call('/v1/email/verify', { challengeId: id1, code: wrong })).status).toBe(400);
    // Expired.
    h.clock.now += 11 * 60_000;
    expect((await h.call('/v1/email/verify', { challengeId: id1, code: h.sender.codeFor(a) })).status).toBe(410);
    // The app turned email off between start and verify: 403, nothing minted or recorded.
    const b = `off${uid()}@example.com`;
    const id2 = await startCode(h, app, b);
    await env.API_TEST_DB.prepare("UPDATE apps SET login_methods = 'google' WHERE id = ?1").bind(app.id).run();
    expect((await h.call('/v1/email/verify', { challengeId: id2, code: h.sender.codeFor(b) })).status).toBe(403);
    await env.API_TEST_DB.prepare("UPDATE apps SET login_methods = 'google,email' WHERE id = ?1").bind(app.id).run();
    // A link while the chain has unrecorded pre-v3 wallets: 409 links_unavailable.
    const c = `unrec${uid()}@example.com`;
    const id3 = await startCode(h, app, c, 'link_new', linkNewCommitment(app));
    h.chain.unrecorded = true;
    expect((await h.call('/v1/email/verify', { challengeId: id3, code: h.sender.codeFor(c) })).status).toBe(409);
    h.chain.unrecorded = false;
    // Case A whose case moved on before the code (409 link_refused).
    const d = `moved${uid()}@corp.example`;
    h.chain.open(app.scope, 'email', await subOf(h, d));
    const acc = { sub: `1${Math.floor(Math.random() * 1e15)}`, email: d };
    const cm = sessionCommitment(app.scope, h.clock.now);
    const m = await h.call('/v1/email/google-match', { pk: app.pk, accessToken: h.google.accessToken(acc, GOOGLE_CLIENT), googleIdToken: await h.google.idToken(acc, GOOGLE_CLIENT, nonceFor(cm)), commitment: cm.json, link: true });
    const { challenge } = (await m.json()) as { challenge: { challengeId: string } };
    await h.call('/v1/email/resend', { challengeId: challenge.challengeId });
    h.chain.open(app.scope, 'google', acc.sub);
    expect((await h.call('/v1/email/verify', { challengeId: challenge.challengeId, code: h.sender.codeFor(d) })).status).toBe(409);
    expect(await emailRows()).toEqual([]);
    expect(await emailAppRows()).toEqual([]);
  });

  it('a D1 failure on the directory write never changes the login: same answer, a token, one warn line without the address', async () => {
    // Every other statement of verify runs on the real D1 (prepare().bind().run/all/first); only the directory's batch fails.
    const h0 = await harness();
    const h = await harness({ env: { ...h0.deps.env, DB: withBatch(env.DB, () => Promise.reject(new Error('d1 down'))) } });
    const app = await seedApp(h);
    const email = `down${uid()}@example.com`;
    const { result: login, lines } = await captureLogs(() => emailLogin(h, app, email));
    expect(login.googleWallet).toBe(false);
    expect(Object.keys(login).sort()).toEqual(['commitment', 'deviceTicket', 'googleWallet', 'idToken', 'sealedEmail']);
    expect(await emailRows()).toEqual([]);
    const failed = lines.filter((l) => l.includes('"directory_write_failed"'));
    expect(failed).toHaveLength(1);
    expect(JSON.parse(failed[0]!)).toMatchObject({ event: 'directory_write_failed', appId: app.id, scopeId: app.scope });
    const sub = await subOf(h, email);
    for (const l of lines) {
      expect(l).not.toContain(email);
      expect(l).not.toContain(sub);
    }
  });

  it('the write runs after the answer (waitUntil): verify returns before the directory batch settles', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let batches = 0;
    const slow = withBatch(env.DB, async (s) => {
      batches += 1;
      await gate;
      return env.DB.batch(s);
    });
    const pending: Promise<unknown>[] = [];
    const h0 = await harness();
    const h = await harness({ env: { ...h0.deps.env, DB: slow }, waitUntil: (p) => void pending.push(p) });
    const app = await seedApp(h);
    const email = `later${uid()}@example.com`;
    const challengeId = await startCode(h, app, email);
    // start's mail goes out in waitUntil too.
    await Promise.all(pending.splice(0));
    const v = await h.call('/v1/email/verify', { challengeId, code: h.sender.codeFor(email) });
    expect(v.status).toBe(200);
    expect(batches).toBe(1);
    expect(await emailRows()).toEqual([]);
    release();
    await Promise.all(pending);
    expect(await emailRows()).toMatchObject([{ email }]);
  });
});
