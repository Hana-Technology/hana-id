// The console code-flow spike's logic (lib/console-code-flow.ts; open question 1, D295), against a stubbed Google: the
// authorization URL it prints (the console client, its one redirect URI, code + PKCE S256, the scope per leg), the
// pasted callback's checks (its own state, no error, no implicit-flow fragment), the exchange, and the report, which
// classifies each leg and never carries a value (no token, address, sub or code). No network.
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Manifest } from '@hana-id/env';
import { afterAll, describe, expect, it } from 'vitest';
import { TEST_MANIFEST } from '../../apps/console/scripts/gen-wrangler.ts';
import { CONSOLE_CLIENT_FILE, GOOGLE_TOKEN_URL, SIGN_IN_EXTRA_CLAIMS, TOKEN_CLAIM_ALLOW_LIST, codeFrom, exchange, loadConsoleClient, newLeg, reportLeg } from '../lib/console-code-flow.ts';

const CLIENT = 'console-client.apps.googleusercontent.com';
const client = { clientId: CLIENT, clientSecret: 'spike-secret', authOrigin: 'https://console-auth.test' };
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: 'jwk' }) as { n: string; e: string }), kid: 'k1' };
const jwks = async () => [jwk];
const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');
function jwt(claims: Record<string, unknown>): string {
  const input = `${b64(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }))}.${b64(JSON.stringify(claims))}`;
  return `${input}.${sign('sha256', Buffer.from(input), privateKey).toString('base64url')}`;
}
const atHash = (t: string) => createHash('sha256').update(t).digest().subarray(0, 16).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const base = (nonce: string) => ({ iss: 'https://accounts.google.com', azp: CLIENT, aud: CLIENT, sub: '109876543210', nonce, iat: now, exp: now + 3600 });

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('the client', () => {
  function withFile(content: unknown, mode = 0o600): string {
    const root = mkdtempSync(join(tmpdir(), 'spike-'));
    dirs.push(root);
    mkdirSync(join(root, '.secrets', 'sandbox-test'), { recursive: true });
    const f = join(root, '.secrets', 'sandbox-test', CONSOLE_CLIENT_FILE);
    writeFileSync(f, JSON.stringify(content));
    chmodSync(f, mode);
    return root;
  }

  it("reads Google's client JSON and checks it is the manifest's console audience", () => {
    const root = withFile({ web: { client_id: CLIENT, client_secret: 'spike-secret' } });
    expect(loadConsoleClient(TEST_MANIFEST, root)).toEqual(client);
    expect(() => loadConsoleClient(TEST_MANIFEST, withFile({ web: { client_id: 'other.apps', client_secret: 'x' } }))).toThrow(/another client/u);
    expect(() => loadConsoleClient(TEST_MANIFEST, withFile({ installed: {} }))).toThrow(/not a Google web client JSON/u);
    expect(() => loadConsoleClient(TEST_MANIFEST, withFile({ web: { client_id: CLIENT, client_secret: 'x' } }, 0o644))).toThrow(/0600/u);
    expect(() => loadConsoleClient({ ...TEST_MANIFEST, consoleAudiences: [] } as Manifest, root)).toThrow(/exactly one google client/u);
  });

  it('never puts the secret in an error', () => {
    const root = withFile({ web: { client_id: 'other.apps', client_secret: 'very-secret-value' } });
    try {
      loadConsoleClient(TEST_MANIFEST, root);
    } catch (err) {
      expect(String(err)).not.toContain('very-secret-value');
    }
  });
});

describe('a leg', () => {
  it('asks for a code with PKCE S256, the console client, its one redirect URI and the leg’s scope', () => {
    for (const scope of ['openid', 'openid email'] as const) {
      const leg = newLeg(client, scope);
      const u = new URL(leg.url);
      expect(`${u.origin}${u.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
      expect(Object.fromEntries(u.searchParams)).toEqual({
        client_id: CLIENT,
        redirect_uri: 'https://console-auth.test/callback',
        response_type: 'code',
        scope,
        prompt: 'select_account',
        state: leg.state,
        nonce: leg.nonce,
        code_challenge: createHash('sha256').update(leg.verifier).digest('base64url'),
        code_challenge_method: 'S256',
      });
    }
  });

  it('takes the code only from its own callback: right origin and path, its state, no error, no implicit fragment', () => {
    const leg = newLeg(client, 'openid');
    const cb = (q: string, h = '') => `https://console-auth.test/callback?${q}${h}`;
    expect(codeFrom(cb(`code=4/abc&state=${leg.state}&scope=openid`), leg, client)).toBe('4/abc');
    expect(() => codeFrom('not a url', leg, client)).toThrow(/not a URL/u);
    expect(() => codeFrom(`https://evil.example/callback?code=x&state=${leg.state}`, leg, client)).toThrow(/is not https:\/\/console-auth\.test\/callback/u);
    expect(() => codeFrom(cb(`code=x&state=other`), leg, client)).toThrow(/state differs/u);
    expect(() => codeFrom(cb(`error=access_denied&state=${leg.state}`), leg, client)).toThrow(/access_denied/u);
    expect(() => codeFrom(cb(`state=${leg.state}`, '#id_token=a.b.c'), leg, client)).toThrow(/implicit-flow/u);
    expect(() => codeFrom(cb(`state=${leg.state}`), leg, client)).toThrow(/no code/u);
    try {
      codeFrom(cb('code=SECRETCODE&state=wrong'), leg, client);
    } catch (err) {
      expect(String(err)).not.toContain('SECRETCODE');
    }
  });

  it('exchanges with the secret, the redirect URI and the verifier', async () => {
    const leg = newLeg(client, 'openid');
    let form: URLSearchParams | undefined;
    const f = (async (url: string, init: RequestInit) => {
      expect(url).toBe(GOOGLE_TOKEN_URL);
      form = new URLSearchParams(String(init.body));
      return Response.json({ id_token: 'a.b.c', access_token: 'ya29.x' });
    }) as unknown as typeof fetch;
    expect(await exchange('4/abc', leg, client, f)).toEqual({ idToken: 'a.b.c', accessToken: 'ya29.x' });
    expect(Object.fromEntries(form!)).toEqual({ grant_type: 'authorization_code', code: '4/abc', client_id: CLIENT, client_secret: 'spike-secret', redirect_uri: 'https://console-auth.test/callback', code_verifier: leg.verifier });
    const refused = (async () => Response.json({ error: 'invalid_grant', error_description: 'Bad code 4/abc' }, { status: 400 })) as unknown as typeof fetch;
    await expect(exchange('4/abc', leg, client, refused)).rejects.toThrow(/400 \(invalid_grant\)/u);
    await expect(exchange('4/abc', leg, client, refused)).rejects.not.toThrow(/4\/abc/u);
  });
});

describe('the lists', () => {
  it("its allow-list is @hana-id/core's TOKEN_CLAIM_ALLOW_LIST, and its sign-in extras the console's", () => {
    const listIn = (file: string, name: string) =>
      [...(new RegExp(`${name}: readonly string\\[\\] = (?:Object\\.freeze\\()?\\[([^\\]]*)\\]`, 'u').exec(readFileSync(new URL(file, import.meta.url), 'utf8'))?.[1] ?? '').matchAll(/'([a-z_]+)'/gu)].map((m) => m[1]);
    expect(TOKEN_CLAIM_ALLOW_LIST).toEqual(listIn('../../packages/core/src/id-token.ts', 'TOKEN_CLAIM_ALLOW_LIST'));
    expect(SIGN_IN_EXTRA_CLAIMS).toEqual(listIn('../../apps/console/src/auth-token.ts', 'SIGN_IN_EXTRA_CLAIMS'));
  });
});

describe('the report', () => {
  it('openid, exactly the allow-list: PASS (open question 1 answered: no email)', async () => {
    const leg = newLeg(client, 'openid');
    const r = await reportLeg({ idToken: jwt(base(leg.nonce)), accessToken: 'ya29.x' }, leg, client, { jwks });
    expect(r).toMatchObject({ scope: 'openid', verified: true, outsideApiAllowList: [], hasEmailClaims: false, hasHd: false, hasAtHash: false, atHashMatches: null, passes: true });
    expect(r.verdict).toMatch(/^PASS/u);
  });

  it('openid with a matching at_hash: PASS, at_hash is in the allow-list (D342); a mismatched one FAILs', async () => {
    const leg = newLeg(client, 'openid');
    const r = await reportLeg({ idToken: jwt({ ...base(leg.nonce), at_hash: atHash('ya29.x') }), accessToken: 'ya29.x' }, leg, client, { jwks });
    expect(r).toMatchObject({ verified: true, outsideApiAllowList: [], hasEmailClaims: false, hasAtHash: true, atHashMatches: true, passes: true });
    expect(r.verdict).toMatch(/^PASS.*at_hash included/u);
    const bad = await reportLeg({ idToken: jwt({ ...base(leg.nonce), at_hash: atHash('ya29.other') }), accessToken: 'ya29.x' }, leg, client, { jwks });
    expect(bad).toMatchObject({ atHashMatches: false, passes: false });
    expect(bad.verdict).toMatch(/^FAIL: at_hash does not match/u);
  });

  it('openid with email or hd: FAIL', async () => {
    const leg = newLeg(client, 'openid');
    const r = await reportLeg({ idToken: jwt({ ...base(leg.nonce), email: 'a@b.example', email_verified: true }), accessToken: undefined }, leg, client, { jwks });
    expect(r).toMatchObject({ verified: true, hasEmailClaims: true, passes: false });
    expect(r.verdict).toMatch(/^FAIL: Google added email/u);
  });

  it('openid email: PASS with email, hd and a matching at_hash; FAIL with a profile claim', async () => {
    const leg = newLeg(client, 'openid email');
    const good = await reportLeg({ idToken: jwt({ ...base(leg.nonce), email: 'a@b.example', email_verified: true, hd: 'b.example', at_hash: atHash('ya29.y') }), accessToken: 'ya29.y' }, leg, client, { jwks });
    expect(good).toMatchObject({ passes: true, hasEmailClaims: true, hasHd: true, atHashMatches: true });
    const bad = await reportLeg({ idToken: jwt({ ...base(leg.nonce), email: 'a@b.example', email_verified: true, name: 'A' }), accessToken: 'ya29.y' }, leg, client, { jwks });
    expect(bad).toMatchObject({ passes: false });
    expect(bad.verdict).toMatch(/name/u);
  });

  it('a token for another nonce or audience, or badly signed, is NOT VERIFIED', async () => {
    const leg = newLeg(client, 'openid');
    for (const t of [jwt(base('other')), jwt({ ...base(leg.nonce), aud: 'x.apps' }), `${jwt(base(leg.nonce)).slice(0, -4)}AAAA`]) {
      const r = await reportLeg({ idToken: t, accessToken: undefined }, leg, client, { jwks });
      expect(r).toMatchObject({ verified: false, passes: false });
      expect(r.verdict).toMatch(/^NOT VERIFIED/u);
    }
  });

  it('holds names and yes/no answers only: never the token, the address, the sub or the access token', async () => {
    const leg = newLeg(client, 'openid email');
    const idToken = jwt({ ...base(leg.nonce), email: 'person@b.example', email_verified: true, at_hash: atHash('ya29.z') });
    const text = JSON.stringify(await reportLeg({ idToken, accessToken: 'ya29.z' }, leg, client, { jwks }));
    for (const s of [idToken, 'person@b.example', '109876543210', 'ya29.z', leg.nonce, leg.state, leg.verifier]) expect(text).not.toContain(s);
  });
});
