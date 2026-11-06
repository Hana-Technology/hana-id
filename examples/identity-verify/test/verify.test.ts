// The partner verification guide's code (docs/integration.md "Identity token", src/verify.ts) against a local issuer:
// a throwaway P-256 key whose JWKS a local HTTP server publishes, tokens signed with jose as Hana's API signs them. It
// also checks the guide quotes src/verify.ts exactly, so the published guide always runs.
import { readFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { type AddressInfo } from 'node:net';
import { type JWK, SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const APP_ID = 'app_partner1';
const STELLAR = 'GBXGQJWVLWOYHFLVTKWV5FGHA3LNYY2JQKM7OAJAUEQFU6LPCSEFVXON';
const EVM = '0x52908400098527886E0F7030069857D2E4169EE7';

let server: Server;
let issuer: string;
let key: CryptoKey;
let kid: string;
let other: CryptoKey;
/** A key of an attacker who controls Hana's servers: published in the JWKS next to Hana's. */
let rogue: CryptoKey;
let rogueKid: string;
let verify: typeof import('../src/verify.ts');
let jwks: { keys: JWK[] };

beforeAll(async () => {
  const pair = await generateKeyPair('ES256', { extractable: true });
  key = pair.privateKey;
  const pub = (await exportJWK(pair.publicKey)) as JWK;
  kid = await calculateJwkThumbprint(pub);
  other = (await generateKeyPair('ES256')).privateKey;
  const roguePair = await generateKeyPair('ES256', { extractable: true });
  rogue = roguePair.privateKey;
  const roguePub = (await exportJWK(roguePair.publicKey)) as JWK;
  rogueKid = await calculateJwkThumbprint(roguePub);
  jwks = { keys: [{ ...pub, kid, use: 'sig', alg: 'ES256' }, { ...roguePub, kid: rogueKid, use: 'sig', alg: 'ES256' }] };
  server = createServer((req, res) => {
    if (req.url === '/v1/identity/jwks.json') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=600' });
      res.end(JSON.stringify(jwks));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/identity`;
  process.env.HANA_IDENTITY_ISSUER = issuer;
  process.env.HANA_APP_ID = APP_ID;
  process.env.HANA_IDENTITY_PINS = 'jwks-only';
  verify = await import('../src/verify.ts');
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

interface Opts {
  claims?: Record<string, unknown>;
  header?: Record<string, unknown>;
  signWith?: CryptoKey;
  iat?: number;
  exp?: number;
}

async function token(o: Opts = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: issuer,
    aud: APP_ID,
    sub: 'u1_8pQm3yR0tZ1vW5xA7cB2dE',
    iat: o.iat ?? now,
    exp: o.exp ?? now + 3600,
    sid: 's1_Jf2kL9mN0pQ3rS6tU8vW1x',
    jti: 'Zx3abcdefghijklmnopqrs',
    wallets: [
      { chain: 'stellar', address: STELLAR },
      { chain: 'evm', address: EVM },
    ],
    login_methods: ['google'],
    ...o.claims,
  };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid, typ: 'hana-identity+jwt', ...o.header } as never)
    .sign(o.signWith ?? key);
}

const codeOf = async (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'ok',
    (e: unknown) => (e instanceof verify.HanaTokenError ? e.code : `other: ${String(e)}`),
  );

describe('verifyHanaIdentityToken', () => {
  it('accepts a Hana token and maps its claims', async () => {
    const id = await verify.verifyHanaIdentityToken(await token());
    expect(id).toEqual({
      userId: 'u1_8pQm3yR0tZ1vW5xA7cB2dE',
      sessionId: 's1_Jf2kL9mN0pQ3rS6tU8vW1x',
      wallets: [
        { chain: 'stellar', address: STELLAR },
        { chain: 'evm', address: EVM },
      ],
      email: null,
      loginMethods: ['google'],
      issuedAt: expect.any(Number),
    });
  });

  it('email only together with email_verified: true', async () => {
    expect((await verify.verifyHanaIdentityToken(await token({ claims: { email: 'ada@example.com', email_verified: true } }))).email).toBe('ada@example.com');
    expect((await verify.verifyHanaIdentityToken(await token({ claims: { email: 'ada@example.com' } }))).email).toBeNull();
  });

  it('expired → "expired"; older than maxAgeSec → "stale"', async () => {
    const now = Math.floor(Date.now() / 1000);
    expect(await codeOf(verify.verifyHanaIdentityToken(await token({ iat: now - 7200, exp: now - 3600 })))).toBe('expired');
    expect(await codeOf(verify.verifyHanaIdentityToken(await token({ iat: now - 120 }), { maxAgeSec: 60 }))).toBe('stale');
    expect(await codeOf(verify.verifyHanaIdentityToken(await token({ iat: now - 10 }), { maxAgeSec: 60 }))).toBe('ok');
  });

  it.each([
    ['another app (aud)', { claims: { aud: 'app_other' } }],
    ['another issuer', { claims: { iss: 'https://evil.example/v1/identity' } }],
    ['another typ', { header: { typ: 'JWT' } }],
    ['a key not in the JWKS', { signWith: undefined as unknown as CryptoKey, other: true }],
    ['no sid', { claims: { sid: undefined } }],
    ['no wallets', { claims: { wallets: undefined } }],
  ])('fails closed on %s ("invalid")', async (_name, o) => {
    const t = (o as { other?: boolean }).other ? await token({ signWith: other }) : await token(o as Opts);
    expect(await codeOf(verify.verifyHanaIdentityToken(t))).toBe('invalid');
  });

  it('refuses alg none and HS256 with the public key (alg pinned to ES256)', async () => {
    const [h, p] = (await token()).split('.') as [string, string];
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', kid, typ: 'hana-identity+jwt' })).toString('base64url')}.${p}.`;
    expect(await codeOf(verify.verifyHanaIdentityToken(none))).toBe('invalid');
    const hs = await new SignJWT({ sid: 'x', wallets: [] })
      .setProtectedHeader({ alg: 'HS256', kid, typ: 'hana-identity+jwt' })
      .setIssuer(issuer)
      .setAudience(APP_ID)
      .setSubject('u1_x')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('a shared secret that is long enough'));
    expect(await codeOf(verify.verifyHanaIdentityToken(hs))).toBe('invalid');
    expect(h.length).toBeGreaterThan(0);
  });

  it('assertWallet binds the token to the wallet that authenticated (EVM in any case)', async () => {
    const id = await verify.verifyHanaIdentityToken(await token());
    expect(() => verify.assertWallet(id, 'stellar', STELLAR)).not.toThrow();
    expect(() => verify.assertWallet(id, 'evm', EVM.toLowerCase())).not.toThrow();
    expect(() => verify.assertWallet(id, 'evm', '0x000000000000000000000000000000000000dEaD')).toThrow(verify.HanaTokenError);
    expect(() => verify.assertWallet(id, 'stellar', EVM)).toThrow(verify.HanaTokenError);
  });
});

describe('thumbprint pinning (HANA_IDENTITY_PINS, recommended for anything of value)', () => {
  afterEach(() => {
    process.env.HANA_IDENTITY_PINS = 'jwks-only';
    vi.resetModules();
  });
  const fresh = async (pins: string) => {
    vi.resetModules();
    process.env.HANA_IDENTITY_PINS = pins;
    return import('../src/verify.ts');
  };
  const rogueToken = async () =>
    new SignJWT({ iss: issuer, aud: APP_ID, sub: 'u1_victim', sid: 's1_x', wallets: [] })
      .setProtectedHeader({ alg: 'ES256', kid: rogueKid, typ: 'hana-identity+jwt' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(rogue);

  it("with jwks-only (no pins), a key published in Hana's JWKS by someone else verifies (the risk pinning removes)", async () => {
    const v = await fresh('jwks-only');
    expect((await v.verifyHanaIdentityToken(await rogueToken())).userId).toBe('u1_victim');
  });

  it("with pins, only the pinned keys verify, whatever the JWKS lists", async () => {
    const v = await fresh(` ${kid} ,`);
    expect((await v.verifyHanaIdentityToken(await token())).sessionId).toBe('s1_Jf2kL9mN0pQ3rS6tU8vW1x');
    await expect(v.verifyHanaIdentityToken(await rogueToken())).rejects.toMatchObject({ code: 'invalid' });
  });

  it("a pinned kid on another key doesn't pass: the key itself is hashed", async () => {
    const v = await fresh(kid);
    jwks.keys[1] = { ...jwks.keys[1]!, kid: `${kid}` };
    jwks.keys.reverse();
    try {
      const forged = await new SignJWT({ iss: issuer, aud: APP_ID, sub: 'u1_victim', sid: 's1_x', wallets: [] })
        .setProtectedHeader({ alg: 'ES256', kid, typ: 'hana-identity+jwt' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(rogue);
      await expect(v.verifyHanaIdentityToken(forged)).rejects.toMatchObject({ code: 'invalid' });
    } finally {
      jwks.keys.reverse();
      jwks.keys[1] = { ...jwks.keys[1]!, kid: rogueKid };
    }
  });
});

describe('startup: the verifier refuses to start without its settings', () => {
  const SETTINGS = ['HANA_IDENTITY_ISSUER', 'HANA_APP_ID', 'HANA_IDENTITY_PINS'] as const;
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(SETTINGS.map((k) => [k, process.env[k]]));
    vi.resetModules();
  });
  afterEach(() => {
    for (const k of SETTINGS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.resetModules();
  });
  const load = () => import('../src/verify.ts');

  it.each(SETTINGS)('%s unset or empty: the module throws at import, naming it', async (name) => {
    delete process.env[name];
    await expect(load()).rejects.toThrow(`${name} is not set`);
    vi.resetModules();
    process.env[name] = '  ';
    await expect(load()).rejects.toThrow(`${name} is not set`);
  });

  it('refuses a publishable key in place of the app id', async () => {
    process.env.HANA_APP_ID = 'pk_test_abc';
    await expect(load()).rejects.toThrow('HANA_APP_ID must be your app id');
  });

  it('refuses a plaintext issuer that is not loopback, and a malformed one', async () => {
    process.env.HANA_IDENTITY_ISSUER = 'http://hana.example/v1/identity';
    await expect(load()).rejects.toThrow('must be an https:// URL');
    vi.resetModules();
    process.env.HANA_IDENTITY_ISSUER = 'not a url';
    await expect(load()).rejects.toThrow();
  });

  it('refuses pins that are not thumbprints (a typo, a stray separator only)', async () => {
    for (const pins of ['abc', ',', `${kid},not-a-thumbprint`]) {
      vi.resetModules();
      process.env.HANA_IDENTITY_PINS = pins;
      await expect(load()).rejects.toThrow('HANA_IDENTITY_PINS must be key thumbprints');
    }
  });

  it("started with every setting, it rejects a valid Hana token minted for another app", async () => {
    process.env.HANA_IDENTITY_PINS = kid;
    const v = await load();
    const other = await new SignJWT({ iss: issuer, aud: 'app_OTHER', sub: 'u1_8pQm3yR0tZ1vW5xA7cB2dE', sid: 's1_x', wallets: [] })
      .setProtectedHeader({ alg: 'ES256', kid, typ: 'hana-identity+jwt' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(key);
    await expect(v.verifyHanaIdentityToken(other)).rejects.toMatchObject({ code: 'invalid' });
    expect((await v.verifyHanaIdentityToken(await token())).userId).toBe('u1_8pQm3yR0tZ1vW5xA7cB2dE');
  });
});

describe('docs/integration.md', () => {
  it('quotes src/verify.ts exactly in its verification guide', () => {
    const guide = readFileSync(new URL('../../../docs/integration.md', import.meta.url), 'utf8');
    const source = readFileSync(new URL('../src/verify.ts', import.meta.url), 'utf8').trim();
    const blocks = [...guide.matchAll(/```ts\n([\s\S]*?)\n```/gu)].map((m) => m[1]!.trim());
    expect(blocks).toContain(source);
  });
});
