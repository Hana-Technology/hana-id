// Batch B changes to the batch A session endpoints: the claim allow-list on /v1/sessions (always on since D271, which
// retired REJECT_PII_ON_SESSIONS), the BLS precheck on /v1/derive behind BLS_PRECHECK, and the key_index reservation.
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALLOWED_CLAIMS, disallowedClaim } from '../src/claims.ts';
import { NAMED_PII_CLAIMS, appHeaders, call, chain, deriveBody, seedApp, sessionBody, uid } from './helpers.ts';
import { appKey, hanaHeaders, loginBody, mismatchedAppKey } from './login-helpers.ts';

afterEach(() => vi.restoreAllMocks());

const body = async (res: Response): Promise<Record<string, unknown>> => (await res.json()) as Record<string, unknown>;
const newAud = (): string => `${uid()}.apps.googleusercontent.com`;

describe('/v1/sessions claim allow-list (always on, D271)', () => {
  const REFUSED = [...NAMED_PII_CLAIMS, 'unknown_claim'];

  it('each named PII claim (and any unknown one) gives 400 token_has_pii with its name, and nothing reaches the chain', async () => {
    const app = await seedApp();
    const aud = newAud();
    const near = chain({ [aud]: app.scope });
    for (const claim of REFUSED) {
      const res = await call('/v1/sessions', { headers: appHeaders(app), body: await sessionBody(app.scope, aud, {}, { [claim]: claim === 'email' ? 'a@example.com' : 'x' }) });
      expect([res.status, await body(res)], claim).toEqual([400, expect.objectContaining({ code: 'token_has_pii', data: { claim } })]);
    }
    // Refused before any chain read or relay: no transaction, no RPC call at all, no session.
    expect(near.sent).toHaveLength(0);
    expect(near.rpcMethods).toEqual([]);
    expect(near.viewCalls).toEqual([]);
    expect(near.sessions.size).toBe(0);
  });

  it('a Google Identity Services style token (email, email_verified, name, picture, hd) is refused, not relayed', async () => {
    const app = await seedApp();
    const aud = newAud();
    const near = chain({ [aud]: app.scope });
    const gis = { email: 'a@example.com', email_verified: true, name: 'A', picture: 'https://x.example/a', given_name: 'A', family_name: 'B', hd: 'example.com', azp: aud };
    const res = await call('/v1/sessions', { headers: appHeaders(app), body: await sessionBody(app.scope, aud, {}, gis) });
    expect(res.status).toBe(400);
    expect((await body(res)).code).toBe('token_has_pii');
    expect(near.sent).toHaveLength(0);
    expect(near.rpcMethods).not.toContain('send_tx');
  });

  it('a REJECT_PII_ON_SESSIONS var left in a deployed config has no effect: "0" still refuses', async () => {
    const app = await seedApp();
    const aud = newAud();
    const near = chain({ [aud]: app.scope });
    const legacy = { REJECT_PII_ON_SESSIONS: '0' } as unknown as Partial<typeof env>;
    const res = await call('/v1/sessions', { headers: appHeaders(app), body: await sessionBody(app.scope, aud, {}, { email: 'a@example.com' }), env: legacy });
    expect([res.status, (await body(res)).code]).toEqual([400, 'token_has_pii']);
    expect(near.sent).toHaveLength(0);
  });

  it('a token with only allow-listed claims (every one of them) is relayed', async () => {
    const app = await seedApp();
    const aud = newAud();
    const near = chain({ [aud]: app.scope });
    const now = Math.floor(Date.now() / 1000);
    const ok = await call('/v1/sessions', { headers: appHeaders(app), body: await sessionBody(app.scope, aud, {}, { azp: aud, iat: now, nbf: now, jti: 'j', auth_time: now, at_hash: 'pKoRe4wHbXLoKz8BsUNdXg' }) });
    expect(ok.status).toBe(200);
    expect(near.sent.map((t) => t.method)).toEqual(['create_session']);
  });

  it('the claims verifyIdToken parses (email, hd, …) never reach a log line, a response or D1 (D25, D96)', async () => {
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
    // Refused on both session routes (token_has_pii).
    for (const [path, b] of [
      ['/v1/sessions', await sessionBody(app.scope, aud, {}, pii)],
      ['/v1/login', await loginBody(app.scope, aud, {}, pii)],
    ] as const) {
      const res = await call(path, { headers: path === '/v1/login' ? hanaHeaders(app) : appHeaders(app), body: b });
      responses.push(`${res.status} ${await res.text()}`);
    }
    expect(responses.map((r) => r.slice(0, 3))).toEqual(['400', '400']);
    expect(near.sent).toHaveLength(0);
    const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all<{ name: string }>();
    const rows: string[] = [];
    for (const { name } of tables.results) rows.push(JSON.stringify((await env.DB.prepare(`SELECT * FROM "${name}"`).all()).results));
    for (const haystack of [...lines, ...responses, ...rows]) {
      expect(haystack).not.toContain(email);
      expect(haystack).not.toContain(hd);
    }
  });

  it('allow-listed claims of the wrong type are ignored, not refused (verifyIdToken optionalClaims "ignore", D201)', async () => {
    const app = await seedApp();
    const aud = newAud();
    const near = chain({ [aud]: app.scope });
    const res = await call('/v1/sessions', { headers: appHeaders(app), body: await sessionBody(app.scope, aud, {}, { iat: 'soon', auth_time: 'x', azp: 5 }) });
    expect(res.status).toBe(200);
    expect(near.sent).toHaveLength(1);
  });

  it('no named PII claim is allow-listed (the list is compared with @hana-id/core in scripts/test/relayed-tokens.test.ts)', () => {
    for (const claim of NAMED_PII_CLAIMS) expect(ALLOWED_CLAIMS.has(claim), claim).toBe(false);
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
