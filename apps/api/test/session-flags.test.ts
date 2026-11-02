// Batch B changes to the batch A session endpoints: the claim allow-list on /v1/sessions behind
// REJECT_PII_ON_SESSIONS, the BLS precheck on /v1/derive behind BLS_PRECHECK, and the key_index reservation.
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALLOWED_CLAIMS, disallowedClaim } from '../src/claims.ts';
import { appHeaders, call, chain, deriveBody, seedApp, sessionBody, uid } from './helpers.ts';
import { appKey, hanaHeaders, loginBody, mismatchedAppKey } from './login-helpers.ts';

afterEach(() => vi.restoreAllMocks());

const body = async (res: Response): Promise<Record<string, unknown>> => (await res.json()) as Record<string, unknown>;
const newAud = (): string => `${uid()}.apps.googleusercontent.com`;

describe('/v1/sessions claim allow-list (REJECT_PII_ON_SESSIONS)', () => {
  const REFUSED = ['email', 'email_verified', 'name', 'picture', 'given_name', 'family_name', 'hd', 'locale', 'profile', 'unknown_claim'];

  it('"0" (default): tokens with extra claims are relayed, as smoke’s Google Identity Services tokens need', async () => {
    const app = await seedApp();
    const aud = newAud();
    const near = chain({ [aud]: app.scope });
    const res = await call('/v1/sessions', { headers: appHeaders(app), body: await sessionBody(app.scope, aud, {}, { email: 'a@example.com', email_verified: true, hd: 'example.com' }) });
    expect(res.status).toBe(200);
    expect(near.sent).toHaveLength(1);
  });

  it('"1": each refused claim gives token_has_pii with its name; allowed claims pass', async () => {
    const app = await seedApp();
    const aud = newAud();
    const near = chain({ [aud]: app.scope });
    const on = { REJECT_PII_ON_SESSIONS: '1' };
    for (const claim of REFUSED) {
      const res = await call('/v1/sessions', { headers: appHeaders(app), body: await sessionBody(app.scope, aud, {}, { [claim]: claim === 'email_verified' ? true : 'x' }), env: on });
      expect([res.status, await body(res)], claim).toEqual([400, expect.objectContaining({ code: 'token_has_pii', data: { claim } })]);
    }
    expect(near.sent).toHaveLength(0);
    const now = Math.floor(Date.now() / 1000);
    const ok = await call('/v1/sessions', { headers: appHeaders(app), body: await sessionBody(app.scope, aud, {}, { azp: aud, iat: now, nbf: now, jti: 'j', auth_time: now }), env: on });
    expect(ok.status).toBe(200);
  });

  it('the claims verifyIdToken now parses (email, hd, …) never reach a log line, a response or D1 (D25, D96)', async () => {
    const lines: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(' ')));
    const app = await seedApp();
    const aud = newAud();
    const near = chain({ [aud]: app.scope });
    const email = `pii-${uid()}@example.com`;
    const hd = `hd-${uid()}.example`;
    const now = Math.floor(Date.now() / 1000);
    const pii = { email, email_verified: true, hd, amr: ['pwd'], auth_time: now, iat: now, azp: aud };
    const responses: string[] = [];
    // Accepted (REJECT_PII_ON_SESSIONS off) and refused (on: token_has_pii; /v1/login always refuses them).
    for (const [path, b, flags] of [
      ['/v1/sessions', await sessionBody(app.scope, aud, {}, pii), {}],
      ['/v1/sessions', await sessionBody(app.scope, aud, {}, pii), { REJECT_PII_ON_SESSIONS: '1' }],
      ['/v1/login', await loginBody(app.scope, aud, {}, pii), {}],
    ] as const) {
      const res = await call(path, { headers: path === '/v1/login' ? hanaHeaders(app) : appHeaders(app), body: b, env: flags });
      responses.push(`${res.status} ${await res.text()}`);
    }
    expect(responses[0]).toMatch(/^200 /u);
    expect(responses.slice(1).map((r) => r.slice(0, 3))).toEqual(['400', '400']);
    expect(near.sent).toHaveLength(1);
    const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all<{ name: string }>();
    const rows: string[] = [];
    for (const { name } of tables.results) rows.push(JSON.stringify((await env.DB.prepare(`SELECT * FROM "${name}"`).all()).results));
    for (const haystack of [...lines, ...responses, ...rows]) {
      expect(haystack).not.toContain(email);
      expect(haystack).not.toContain(hd);
    }
  });

  it('disallowedClaim reads the payload of any token, and leaves unreadable ones to the signature check', () => {
    const b64 = (o: unknown): string => btoa(JSON.stringify(o)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
    const jwt = (claims: unknown): string => `${b64({ alg: 'RS256' })}.${b64(claims)}.sig`;
    expect(disallowedClaim(jwt(Object.fromEntries([...ALLOWED_CLAIMS].map((c) => [c, 1]))))).toBeNull();
    expect(disallowedClaim(jwt({ sub: '1', picture: 'x', email: 'y' }))).toBe('picture');
    for (const bad of ['', 'a', 'a.!!!.c', `a.${b64([1])}.c`, `a.${b64('s')}.c`]) expect(disallowedClaim(bad), bad).toBeNull();
  });
});

describe('key_index reservation', () => {
  it('/v1/sessions refuses key_index ≥ 2^31 and accepts 2^31 − 1', async () => {
    const app = await seedApp();
    const aud = newAud();
    const near = chain({ [aud]: app.scope });
    for (const keyIndex of [0x8000_0000, 0xffff_ffff, -1, 1.5]) {
      const res = await call('/v1/sessions', { headers: appHeaders(app), body: await sessionBody(app.scope, aud, { keyIndex }) });
      expect([res.status, (await body(res)).code], String(keyIndex)).toEqual([400, 'bad_request']);
    }
    expect(near.sent).toHaveLength(0);
    expect((await call('/v1/sessions', { headers: appHeaders(app), body: await sessionBody(app.scope, aud, { keyIndex: 0x7fff_ffff }) })).status).toBe(200);
  });
});

describe('/v1/derive BLS precheck (BLS_PRECHECK)', () => {
  async function session() {
    const app = await seedApp();
    const aud = newAud();
    const near = chain({ [aud]: app.scope });
    const req = await sessionBody(app.scope, aud);
    expect((await call('/v1/sessions', { headers: appHeaders(app), body: req })).status).toBe(200);
    return { app, near, spk: req.sessionPublicKey as number[] };
  }

  it('"1": a pair that fails the pairing is refused before relaying; a good pair is relayed', async () => {
    const { app, near, spk } = await session();
    const on = { BLS_PRECHECK: '1' };
    const bad = await call('/v1/derive', { headers: appHeaders(app), body: await deriveBody(spk, mismatchedAppKey()), env: on });
    expect([bad.status, (await body(bad)).code]).toEqual([400, 'invalid_app_key']);
    expect(near.sent.filter((t) => t.method === 'derive_key')).toHaveLength(0);
    const ok = await call('/v1/derive', { headers: hanaHeaders(app), body: await deriveBody(spk, appKey()), env: on });
    expect(ok.status).toBe(200);
  });

  it('"0" (default): no pairing check (the MPC refuses a bad pair itself)', async () => {
    const { app, near, spk } = await session();
    const res = await call('/v1/derive', { headers: appHeaders(app), body: await deriveBody(spk, mismatchedAppKey()) });
    expect(res.status).toBe(200);
    expect(near.sent.filter((t) => t.method === 'derive_key')).toHaveLength(1);
  });
});
