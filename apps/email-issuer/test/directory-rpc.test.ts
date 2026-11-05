// DirectoryRpc (src/directory-rpc.ts, D275 as confirmed 2026-11-05; spec "Users and Support ID"): the staff check on
// every call (the admin application's Access JWT, verified by the issuer itself), the audit row in the same batch as
// the read (a failed audit write returns nothing), the ticket rule (required to open one identity, optional to search),
// the searches and their order (verified rows first on an address search), the keyed hash in place of the address,
// and the per-staff row budget. The entrypoint runs on the Worker's real D1 and RateLimiter objects; only the Access
// certs fetch is stubbed.
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { DIRECTORY_ROWS_PER_DAY, DIRECTORY_ROWS_PER_HOUR, UNVERIFIED_CLAIM_WARNING } from '@hana-id/console-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DIRECTORY_APPS_MAX, DirectoryRpc, budgetObjectName, resetDirectoryAccess, termHash } from '../src/directory-rpc.ts';
import { DIRECTORY_ROW_LIMITS } from '../src/limits.ts';

const TEAM = 'hana-admin-test.cloudflareaccess.com';
const AUD = 'cd'.repeat(32);
const CERTS = `https://${TEAM}/cdn-cgi/access/certs`;
const STAFF = 'staff@hana.example';
const HOUR = 3_600_000;

const b64url = (data: string | Uint8Array): string => {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
};

let pair: CryptoKeyPair;
let pub: JsonWebKey;
let certsDown = false;
let certFetches = 0;

async function accessJwt(over: Record<string, unknown> = {}, kid = 'admin-kid'): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims = { aud: [AUD], email: STAFF, exp: now + 3600, iat: now, nbf: now, iss: `https://${TEAM}`, type: 'app', sub: 'staff-sub-1', ...over };
  const input = `${b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`;
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(input)));
  return `${input}.${b64url(sig)}`;
}

beforeEach(async () => {
  pair ??= (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  pub ??= (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  certsDown = false;
  certFetches = 0;
  resetDirectoryAccess();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== CERTS) throw new Error(`Unexpected fetch to ${url}`);
    certFetches++;
    if (certsDown) throw new TypeError('Network connection lost.');
    return Response.json({ keys: [{ kty: 'RSA', n: pub.n, e: pub.e, kid: 'admin-kid', alg: 'RS256', use: 'sig' }] }, { headers: { 'cache-control': 'max-age=300' } });
  });
});
afterEach(() => vi.restoreAllMocks());

const rpc = (e: Partial<typeof env> = {}) => new DirectoryRpc(createExecutionContext(), { ...env, ...e } as typeof env);
let seq = 0;
const requestId = () => `req_${Date.now().toString(36)}${(++seq).toString(36)}aaaa`;
const call = async (extra: Record<string, unknown> = {}, jwt?: string) => ({ requestId: requestId(), accessJwt: jwt ?? (await accessJwt()), ...extra });

interface Seed {
  provider?: 'email' | 'google';
  sub?: string;
  email: string;
  verified?: boolean;
  hosted?: boolean | null;
  seen?: number;
  apps?: { appId: string; scopeId: string; seen?: number }[];
}
async function seed(...rows: Seed[]): Promise<void> {
  const stmts: D1PreparedStatement[] = [];
  for (const r of rows) {
    const provider = r.provider ?? 'email';
    const sub = r.sub ?? `${provider === 'email' ? 'e1.' : ''}${crypto.randomUUID().replaceAll('-', '')}`;
    const seen = r.seen ?? Date.now();
    stmts.push(
      env.DB.prepare('INSERT INTO user_emails (provider, sub, email, email_verified, hosted, first_seen_ms, last_seen_ms) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(
        provider,
        sub,
        r.email,
        r.verified === false ? 0 : 1,
        r.hosted === undefined ? (provider === 'google' ? 0 : null) : r.hosted === null ? null : r.hosted ? 1 : 0,
        seen - 1000,
        seen,
      ),
    );
    for (const a of r.apps ?? []) {
      stmts.push(env.DB.prepare('INSERT INTO user_email_apps (provider, sub, app_id, scope_id, first_seen_ms, last_seen_ms) VALUES (?, ?, ?, ?, ?, ?)').bind(provider, sub, a.appId, a.scopeId, (a.seen ?? seen) - 500, a.seen ?? seen));
    }
  }
  await env.DB.batch(stmts);
}
const auditRows = async () => (await env.DB.prepare('SELECT staff, action, ticket, detail FROM email_admin_audit ORDER BY id').all<{ staff: string; action: string; ticket: string | null; detail: string | null }>()).results;

describe('the staff check (the issuer verifies the admin application’s Access JWT itself)', () => {
  it('refuses a missing, forged, misdirected, expired or non-app token, and anyone off the staff list; writes nothing', async () => {
    await seed({ email: 'a@example.com' });
    const other = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const forged = (await accessJwt()).split('.');
    const forgedSig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', other.privateKey, new TextEncoder().encode(`${forged[0]}.${forged[1]}`)));
    const cases: [string, string][] = [
      ['garbage', 'not.a.jwt-but-long-enough'],
      ['forged', `${forged[0]}.${forged[1]}.${b64url(forgedSig)}`],
      // The issuer's own Access application (its staff routes) is another AUD: its tokens don't open the directory.
      ['other aud', await accessJwt({ aud: ['ab'.repeat(32)] })],
      ['other team', await accessJwt({ iss: 'https://other.cloudflareaccess.com' })],
      ['expired', await accessJwt({ exp: Math.floor(Date.now() / 1000) - 600 })],
      ['service token', await accessJwt({ type: 'service', sub: '' })],
      ['no sub', await accessJwt({ sub: '' })],
      ['unknown kid', await accessJwt({}, 'other-kid')],
    ];
    for (const [name, jwt] of cases) {
      const r = await rpc().search(await call({}, jwt));
      expect(r, name).toMatchObject({ ok: false, code: 'unauthenticated' });
    }
    expect(await rpc().search(await call({}, await accessJwt({ email: 'intruder@hana.example' })))).toMatchObject({ ok: false, code: 'not_staff' });
    expect(await rpc().get(await call({ provider: 'email', sub: 'e1.x', ticket: 'T-1' }, await accessJwt({ email: 'intruder@hana.example' })))).toMatchObject({ ok: false, code: 'not_staff' });
    expect(await rpc().auditSince(await call({ id: 0, limit: 10 }, await accessJwt({ email: 'intruder@hana.example' })))).toMatchObject({ ok: false, code: 'not_staff' });
    expect(await auditRows()).toEqual([]);
  });

  it('the staff email is compared lowercased; it is the audit row’s actor', async () => {
    await seed({ email: 'a@example.com' });
    expect(await rpc().search(await call({}, await accessJwt({ email: 'Staff@Hana.Example' })))).toMatchObject({ ok: true });
    expect((await auditRows())[0]!.staff).toBe(STAFF);
  });

  it('fails closed without the admin Access config or the certs: access_unavailable', async () => {
    for (const e of [{ ADMIN_ACCESS_AUD: undefined }, { ADMIN_ACCESS_AUD: 'UNSET' }, { ADMIN_ACCESS_TEAM_DOMAIN: undefined }, { ADMIN_STAFF_EMAILS: '[]' }, { ADMIN_STAFF_EMAILS: 'not json' }, { ADMIN_STAFF_EMAILS: '["Upper@Hana.Example"]' }]) {
      resetDirectoryAccess();
      expect(await rpc(e).search(await call()), JSON.stringify(e)).toMatchObject({ ok: false, code: 'access_unavailable' });
    }
    resetDirectoryAccess();
    certsDown = true;
    expect(await rpc().search(await call())).toMatchObject({ ok: false, code: 'access_unavailable' });
    expect(await auditRows()).toEqual([]);
  });

  it('a malformed call is bad_request before the token is read (no certs fetch)', async () => {
    for (const c of [{}, { requestId: 'x', accessJwt: 'y' }, { ...(await call()), limit: 101 }, { ...(await call()), provider: 'apple' }, { ...(await call()), extra: 1 }, { ...(await call()), ticket: 'has@sign' }]) {
      expect(await rpc().search(c)).toMatchObject({ ok: false, code: 'bad_request' });
    }
    expect(certFetches).toBe(0);
  });
});

describe('search', () => {
  it('a full address matches exactly (email rows normalized, Google rows as typed); unverified claims come last, flagged', async () => {
    const now = Date.now();
    await seed(
      { provider: 'email', sub: 'e1.alice', email: 'alice@gmail.com', seen: now - 5000 },
      { provider: 'google', sub: '1001', email: 'a.lice@gmail.com', verified: true, hosted: true, seen: now - 9000 },
      // Newer, but an unverified claim: listed after the verified rows.
      { provider: 'google', sub: '1002', email: 'a.lice@gmail.com', verified: false, seen: now },
      { provider: 'email', email: 'bob@example.com' },
    );
    const r = await rpc().search(await call({ q: '  A.Lice@GoogleMail.com ' }));
    // Normalized, `a.lice@googlemail.com` is the email row's `alice@gmail.com`; as typed (lowercased) it isn't the
    // Google rows' `a.lice@gmail.com`: Google's own address is matched as Google gave it.
    expect(r.ok && r.users.map((u) => u.sub)).toEqual(['e1.alice']);
    const g = await rpc().search(await call({ q: 'A.Lice@Gmail.com' }));
    expect(g.ok && g.users.map((u) => [u.sub, u.unverifiedClaim])).toEqual([
      ['e1.alice', false],
      ['1001', false],
      ['1002', true],
    ]);
    if (!g.ok) throw new Error('search failed');
    expect(g.users[1]).toMatchObject({ provider: 'google', email: 'a.lice@gmail.com', emailVerified: true, hosted: true, appCount: 0 });
    expect(g.users[0]).toMatchObject({ provider: 'email', emailVerified: true, hosted: null });
    expect(UNVERIFIED_CLAIM_WARNING).toMatch(/^UNVERIFIED: this Google account claims the address/u);
  });

  it('a part of an address (≥ 3 characters) is a case-insensitive substring; shorter is refused, unaudited', async () => {
    await seed({ email: 'carol@corp.example' }, { email: 'dave@corp.example' }, { email: 'erin@other.example' });
    const r = await rpc().search(await call({ q: 'CORP.EX' }));
    expect(r.ok && r.users.map((u) => u.email).sort()).toEqual(['carol@corp.example', 'dave@corp.example']);
    expect(await rpc().search(await call({ q: 'co' }))).toMatchObject({ ok: false, code: 'bad_request' });
    expect((await auditRows()).length).toBe(1);
  });

  it('filters: provider, sub, app, unverified only; combined with an address', async () => {
    await seed(
      { provider: 'email', sub: 'e1.f1', email: 'f1@x.example', apps: [{ appId: 'app_one', scopeId: 's1' }] },
      { provider: 'google', sub: '2001', email: 'f2@x.example', apps: [{ appId: 'app_one', scopeId: 's1' }, { appId: 'app_two', scopeId: 's2' }] },
      { provider: 'google', sub: '2002', email: 'f3@x.example', verified: false },
    );
    const subs = async (extra: Record<string, unknown>) => {
      const r = await rpc().search(await call(extra));
      if (!r.ok) throw new Error(r.code);
      return r.users.map((u) => u.sub).sort();
    };
    expect(await subs({ provider: 'google' })).toEqual(['2001', '2002']);
    expect(await subs({ sub: '2001' })).toEqual(['2001']);
    expect(await subs({ appId: 'app_one' })).toEqual(['2001', 'e1.f1']);
    expect(await subs({ appId: 'app_two' })).toEqual(['2001']);
    expect(await subs({ unverifiedOnly: true })).toEqual(['2002']);
    expect(await subs({ q: 'x.example', provider: 'email' })).toEqual(['e1.f1']);
    const r = await rpc().search(await call({ sub: '2001' }));
    expect(r.ok && r.users[0]!.appCount).toBe(2);
  });

  it('pages newest first by last seen, without repeats or gaps, the cursor holding no address', async () => {
    const now = Date.now();
    await seed(...Array.from({ length: 7 }, (_, k) => ({ email: `p${k}@page.example`, seen: now - k * 1000 })), { email: 'tie-a@page.example', seen: now - 3000 }, { email: 'tie-b@page.example', seen: now - 3000 });
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let pages = 0; pages < 10; pages++) {
      const r = await rpc().search(await call({ q: 'page.example', limit: 3, ...(cursor ? { cursor } : {}) }));
      if (!r.ok) throw new Error(r.code);
      seen.push(...r.users.map((u) => u.email));
      if (r.next) expect(r.next).not.toMatch(/@/u);
      // A login writing a newer row mid-walk doesn't shift the pages (it sorts before the cursor).
      if (pages === 0) await seed({ email: 'new@page.example', seen: now + 5000 });
      cursor = r.next;
      if (!cursor) break;
    }
    expect(seen).not.toContain('new@page.example');
    expect(seen).toHaveLength(9);
    expect(new Set(seen).size).toBe(9);
    expect(seen.slice(0, 3)).toEqual(['p0@page.example', 'p1@page.example', 'p2@page.example']);
    // A list without an address term walks the same way (no claim ordering).
    const all = await rpc().search(await call({ limit: 100 }));
    expect(all.ok && all.users.length).toBe(10);
  });

  it('every search writes one audit row first: the filters, the term as a 12-character keyed hash, the row count; never the address', async () => {
    await seed({ email: 'secret.person@private.example', apps: [{ appId: 'app_x', scopeId: 's9' }] }, { email: 'secret.other@private.example' });
    await rpc().search(await call({ q: 'Secret.Person@Private.example', ticket: 'SUP-42' }));
    await rpc().search(await call({ q: 'secret', provider: 'email', appId: 'app_x', unverifiedOnly: false, limit: 5 }));
    const rows = await auditRows();
    expect(rows.map((r) => [r.staff, r.action, r.ticket])).toEqual([
      [STAFF, 'user_search', 'SUP-42'],
      [STAFF, 'user_search', null],
    ]);
    const d0 = JSON.parse(rows[0]!.detail!) as { q: { match: string; hash: string }; rows: number; filters: unknown; page: string };
    const d1 = JSON.parse(rows[1]!.detail!) as { q: { match: string; hash: string }; rows: number; filters: unknown };
    expect(d0).toMatchObject({ q: { match: 'exact' }, rows: 1, filters: {}, page: 'first' });
    expect(d1).toMatchObject({ q: { match: 'substring' }, rows: 1, filters: { provider: 'email', appId: 'app_x' } });
    expect(d0.q.hash).toMatch(/^[A-Za-z0-9_-]{12}$/u);
    for (const r of rows) expect(r.detail!.toLowerCase()).not.toMatch(/secret|private|person|@/u);
    // The exact term's hash is its mailbox's, the form unlock subjects take; a +tag doesn't change it.
    expect(d0.q.hash).toBe(await termHash(env.EMAIL_RL_KEY, 'secret.person+news@private.example'));
    expect(d1.q.hash).not.toBe(d0.q.hash);
  });

  it('no log line of a search or a view carries the address, the sub, the ticket, the staff email or the JWT', async () => {
    const lines: string[] = [];
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
    await seed({ provider: 'google', sub: '55501', email: 'logged.person@private.example' });
    const jwt = await accessJwt();
    await rpc().search({ requestId: requestId(), accessJwt: jwt, q: 'logged.person@private.example', ticket: 'TCK-LOG-1' });
    await rpc().search({ requestId: requestId(), accessJwt: jwt, q: 'logged' });
    await rpc().get({ requestId: requestId(), accessJwt: jwt, provider: 'google', sub: '55501', ticket: 'TCK-LOG-2' });
    await rpc().get({ requestId: requestId(), accessJwt: jwt, provider: 'google', sub: '55501' });
    await rpc().search({ requestId: requestId(), accessJwt: await accessJwt({ email: 'intruder@hana.example' }) });
    expect(lines.length).toBeGreaterThan(3);
    for (const l of lines) expect(l).not.toMatch(/logged|private\.example|55501|TCK-LOG|hana\.example|eyJ/u);
  });

  it('a failed audit write returns no rows (one D1 batch) and gives the rows back to the budget', async () => {
    await seed({ email: 'atomic@example.com' });
    await env.DB.prepare("CREATE TRIGGER audit_down BEFORE INSERT ON email_admin_audit BEGIN SELECT RAISE(ABORT, 'audit down'); END").run();
    try {
      const staff = 'other-staff@hana.example';
      const r = await rpc().search(await call({ q: 'atomic@example.com' }, await accessJwt({ email: staff })));
      expect(r).toEqual({ ok: false, code: 'internal', error: 'The directory read or its audit row failed' });
      expect(await rpc().get(await call({ provider: 'email', sub: 'e1.none', ticket: 'T-1' }, await accessJwt({ email: staff })))).toMatchObject({ ok: false, code: 'internal' });
      // Nothing was counted against the staff member.
      const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(budgetObjectName(env.ENV_NAME, staff)));
      const left = await stub.takeRows(DIRECTORY_ROW_LIMITS, DIRECTORY_ROWS_PER_HOUR);
      expect(left).toMatchObject({ ok: true, granted: DIRECTORY_ROWS_PER_HOUR });
      await stub.returnRows((left as { keys: string[] }).keys, DIRECTORY_ROWS_PER_HOUR);
    } finally {
      await env.DB.prepare('DROP TRIGGER audit_down').run();
    }
    expect(await auditRows()).toEqual([]);
  });

  it('refuses an address search when the issuer has no EMAIL_RL_KEY (the term could not be recorded)', async () => {
    expect(await rpc({ EMAIL_RL_KEY: undefined }).search(await call({ q: 'x@example.com' }))).toMatchObject({ ok: false, code: 'internal' });
    expect(await auditRows()).toEqual([]);
  });
});

describe('get', () => {
  it('needs a support reference; answers the row and its apps; audits {provider, sub} with the ticket', async () => {
    await seed({ provider: 'google', sub: '3001', email: 'g@example.com', verified: true, hosted: false, apps: [{ appId: 'app_a', scopeId: 's1', seen: 2000 }, { appId: 'app_b', scopeId: 's2', seen: 3000 }] });
    expect(await rpc().get(await call({ provider: 'google', sub: '3001' }))).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await rpc().get(await call({ provider: 'google', sub: '3001', ticket: '' }))).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await rpc().get(await call({ provider: 'google', sub: '3001', ticket: 'x'.repeat(65) }))).toMatchObject({ ok: false, code: 'bad_request' });
    const r = await rpc().get(await call({ provider: 'google', sub: '3001', ticket: 'ZD-1001' }));
    expect(r).toMatchObject({ ok: true, user: { provider: 'google', sub: '3001', email: 'g@example.com', emailVerified: true, hosted: false, unverifiedClaim: false, appCount: 2 } });
    expect(r.ok && r.apps.map((a) => a.appId)).toEqual(['app_b', 'app_a']);
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ staff: STAFF, action: 'user_view', ticket: 'ZD-1001' });
    expect(JSON.parse(rows[0]!.detail!)).toEqual({ provider: 'google', sub: '3001', found: 1 });
  });

  it('an unknown identity is not_found, still audited (found: 0), and costs no row', async () => {
    const staff = 'budget2@hana.example';
    expect(await rpc().get(await call({ provider: 'email', sub: 'e1.nobody', ticket: 'T-9' }, await accessJwt({ email: staff })))).toMatchObject({ ok: false, code: 'not_found' });
    expect(JSON.parse((await auditRows())[0]!.detail!)).toEqual({ provider: 'email', sub: 'e1.nobody', found: 0 });
    const left = await env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(budgetObjectName(env.ENV_NAME, staff))).takeRows(DIRECTORY_ROW_LIMITS, DIRECTORY_ROWS_PER_HOUR);
    expect(left).toMatchObject({ ok: true, granted: DIRECTORY_ROWS_PER_HOUR });
    await env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(budgetObjectName(env.ENV_NAME, staff))).returnRows((left as { keys: string[] }).keys, DIRECTORY_ROWS_PER_HOUR);
  });

  it('a Support ID lookup’s email join is audited as support_lookup, naming the admin request (D399); another purpose is refused', async () => {
    await seed({ provider: 'google', sub: '3002', email: 'sl@example.com', verified: true, hosted: false });
    const c = await call({ provider: 'google', sub: '3002', ticket: 'ZD-1002', purpose: 'support_lookup' });
    expect(await rpc().get(c)).toMatchObject({ ok: true, user: { email: 'sl@example.com' } });
    expect(await rpc().get(await call({ provider: 'email', sub: 'e1.nobody', ticket: 'ZD-1002', purpose: 'support_lookup' }))).toMatchObject({ ok: false, code: 'not_found' });
    for (const purpose of ['user_search', 'unlock', '', 1]) expect(await rpc().get(await call({ provider: 'google', sub: '3002', ticket: 'T', purpose }))).toMatchObject({ ok: false, code: 'bad_request' });
    const rows = await auditRows();
    expect(rows.map((r) => [r.action, r.ticket])).toEqual([
      ['support_lookup', 'ZD-1002'],
      ['support_lookup', 'ZD-1002'],
    ]);
    expect(JSON.parse(rows[0]!.detail!)).toEqual({ provider: 'google', sub: '3002', lookup: c.requestId, found: 1 });
    expect(JSON.parse(rows[1]!.detail!)).toMatchObject({ provider: 'email', sub: 'e1.nobody', found: 0 });
    // The default stays the Users detail's.
    await rpc().get(await call({ provider: 'google', sub: '3002', ticket: 'T-3', purpose: 'user_view' }));
    expect((await auditRows()).at(-1)).toMatchObject({ action: 'user_view', ticket: 'T-3' });
  });

  it('lists at most DIRECTORY_APPS_MAX apps, flagged when cut', async () => {
    await seed({ provider: 'email', sub: 'e1.many', email: 'many@example.com', apps: Array.from({ length: DIRECTORY_APPS_MAX + 2 }, (_, k) => ({ appId: `app_${k}`, scopeId: 's1', seen: 1000 + k })) });
    const r = await rpc().get(await call({ provider: 'email', sub: 'e1.many', ticket: 'T-2' }));
    expect(r.ok && r.apps.length).toBe(DIRECTORY_APPS_MAX);
    expect(r.ok && r.appsTruncated).toBe(true);
  });
});

describe('the row budget (per staff email: 500 identities an hour, 2 000 a day; provisional)', () => {
  it('counts rows returned, refuses past the hour with rate_limited and the window, without an audit row; other staff unaffected', async () => {
    const now = Date.now();
    await seed(...Array.from({ length: 100 }, (_, k) => ({ email: `b${k}@budget.example`, seen: now - k })));
    const as = await accessJwt({ email: 'budget@hana.example' });
    // An empty answer costs nothing.
    expect(await rpc().search(await call({ q: 'nobody-here' }, as))).toMatchObject({ ok: true, users: [] });
    for (let k = 0; k < DIRECTORY_ROWS_PER_HOUR / 100; k++) {
      const r = await rpc().search(await call({ limit: 100 }, as));
      expect(r.ok && r.users.length, `page ${k}`).toBe(100);
    }
    const before = (await auditRows()).length;
    const refused = await rpc().search(await call({ limit: 1 }, as));
    expect(refused).toMatchObject({ ok: false, code: 'rate_limited', budget: { window: '1h', limit: DIRECTORY_ROWS_PER_HOUR } });
    expect(!refused.ok && refused.budget!.retryAfterMs).toBeGreaterThan(0);
    expect(!refused.ok && refused.budget!.retryAfterMs).toBeLessThanOrEqual(HOUR);
    expect(await rpc().get(await call({ provider: 'email', sub: 'e1.x', ticket: 'T-1' }, as))).toMatchObject({ ok: false, code: 'rate_limited' });
    expect((await auditRows()).length).toBe(before);
    // Another staff member has a budget of their own.
    expect(await rpc().search(await call({ limit: 100 }))).toMatchObject({ ok: true });
  });

  it('the budget object is named by a hash of the staff email, never the address', () => {
    const name = budgetObjectName('local-test', 'Someone@hana.example');
    expect(name).toMatch(/^local-test:staff-dir:[0-9a-f]{64}$/u);
    expect(name).not.toMatch(/someone|hana/iu);
  });

  it('the day window: 2 000 across hours; a page past what is left is cut to it (budgetCut in the audit)', async () => {
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(budgetObjectName(env.ENV_NAME, 'day-test@hana.example')));
    const day = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    const per = DIRECTORY_ROWS_PER_HOUR;
    for (let h = 0; h < DIRECTORY_ROWS_PER_DAY / per; h++) expect(await stub.takeRows(DIRECTORY_ROW_LIMITS, per, day + h * HOUR + 1)).toMatchObject({ ok: true, granted: per });
    expect(await stub.takeRows(DIRECTORY_ROW_LIMITS, 1, day + 5 * HOUR)).toMatchObject({ ok: false, limit: 'directory:rows:1d', max: DIRECTORY_ROWS_PER_DAY });
    // Partial grants within the hour window.
    const p = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(budgetObjectName(env.ENV_NAME, 'partial@hana.example')));
    const t = day + 10 * HOUR;
    expect(await p.takeRows(DIRECTORY_ROW_LIMITS, 450, t)).toMatchObject({ ok: true, granted: 450 });
    const g = await p.takeRows(DIRECTORY_ROW_LIMITS, 100, t);
    expect(g).toMatchObject({ ok: true, granted: 50 });
    await p.returnRows((g as { keys: string[] }).keys, 20);
    expect(await p.takeRows(DIRECTORY_ROW_LIMITS, 100, t)).toMatchObject({ ok: true, granted: 20 });
  });
});

describe('auditSince', () => {
  it('walks the issuer’s staff audit after an id or before one, by staff and action; no row of its own', async () => {
    await env.DB.prepare("INSERT INTO email_admin_audit (at_ms, staff, action, ticket, subject) VALUES (1, 'staff@hana.example', 'unlock', 'T-1', 'abcdefabcdef')").run();
    await seed({ email: 'w@example.com' });
    await rpc().search(await call({ q: 'w@example.com' }));
    await rpc().search(await call({}, await accessJwt({ email: 'other-staff@hana.example' })));
    const after = await rpc().auditSince(await call({ id: 0, limit: 10 }));
    if (!after.ok) throw new Error(after.code);
    expect(after.rows.map((r) => r.action)).toEqual(['unlock', 'user_search', 'user_search']);
    expect(after.rows[0]).toMatchObject({ staff: STAFF, ticket: 'T-1', subject: 'abcdefabcdef', detail: null });
    expect(after.rows[1]!.detail).toMatchObject({ q: { match: 'exact' }, rows: 1 });
    const newest = await rpc().auditSince(await call({ before: Number.MAX_SAFE_INTEGER, limit: 2 }));
    expect(newest.ok && newest.rows.map((r) => r.staff)).toEqual(['other-staff@hana.example', STAFF]);
    const byStaff = await rpc().auditSince(await call({ id: 0, limit: 10, staff: 'other-staff@hana.example' }));
    expect(byStaff.ok && byStaff.rows.length).toBe(1);
    const byAction = await rpc().auditSince(await call({ id: 0, limit: 10, action: 'unlock' }));
    expect(byAction.ok && byAction.rows.length).toBe(1);
    expect(await rpc().auditSince(await call({ id: 0, before: 9, limit: 10 }))).toMatchObject({ ok: false, code: 'bad_request' });
    expect((await auditRows()).length).toBe(3);
  });
});
