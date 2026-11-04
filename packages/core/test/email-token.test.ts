// The vault's email-token check (src/email-token.ts): the issuer's exact JWS JSON form, its pinned iss, the scope's
// aud, the login's nonce, the time window, the issuer's claim set, RS256 against the on-chain keys and the signer
// policy. Tokens here are built the way apps/email-issuer's jws.ts builds them, with throwaway RSA keys.
import { beforeAll, describe, expect, it } from 'vitest';
import { base64UrlEncode, utf8 } from '../src/bytes.ts';
import { type EmailChainKey, type EmailSignerPolicy, type EmailTokenExpectations, isJsonFormToken, parseIssuerKeysView, parseSelfIssuedView, verifyEmailIdToken } from '../src/email-token.ts';

const ISS = 'https://issuer.example/v1/email';
const AUD = 'email:s1';
const NONCE = 'n'.repeat(43);
const NOW = 1_800_000_000_000;
const SUB = `e1.${'A'.repeat(43)}`;

interface TestKey {
  kid: string;
  privateKey: CryptoKey;
  chain: EmailChainKey;
}

async function newKey(kid: string): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { kid, privateKey: pair.privateKey, chain: { kid, n: jwk.n as string, e: jwk.e as string } };
}

const b64json = (v: unknown): string => base64UrlEncode(utf8(JSON.stringify(v)));

async function sign(keys: TestKey[], claims: Record<string, unknown>, header?: (k: TestKey) => Record<string, unknown>): Promise<string> {
  const payload = b64json(claims);
  const signatures = [];
  for (const k of keys) {
    const protectedHeader = b64json(header ? header(k) : { alg: 'RS256', kid: k.kid });
    const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', k.privateKey, utf8(`${protectedHeader}.${payload}`) as Uint8Array<ArrayBuffer>));
    signatures.push({ protected: protectedHeader, signature: base64UrlEncode(sig) });
  }
  return JSON.stringify({ payload, signatures });
}

const claims = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ iss: ISS, aud: AUD, sub: SUB, iat: NOW / 1000, exp: NOW / 1000 + 600, nonce: NONCE, jti: 'j'.repeat(22), ...over });

let hana: TestKey;
let other: TestKey;
let policy: EmailSignerPolicy;
const expectations = (over: Partial<EmailTokenExpectations> = {}): EmailTokenExpectations => ({ iss: ISS, aud: AUD, nonce: NONCE, nowMs: NOW, keys: [hana.chain], policy, ...over });

beforeAll(async () => {
  [hana, other] = await Promise.all([newKey('kid-hana'), newKey('kid-other')]);
  policy = { signers: [{ id: 'hana', kids: ['kid-hana'] }], required: 1 };
});

describe('verifyEmailIdToken', () => {
  it('accepts the issuer’s token and returns its sub, nonce and kids', async () => {
    const r = await verifyEmailIdToken(await sign([hana], claims()), expectations());
    expect(r).toEqual({ ok: true, token: { iss: ISS, aud: AUD, sub: SUB, nonce: NONCE, iat: NOW / 1000, exp: NOW / 1000 + 600, kids: ['kid-hana'] } });
  });

  it('tells the JSON form from a compact JWT', async () => {
    expect(isJsonFormToken(await sign([hana], claims()))).toBe(true);
    expect(isJsonFormToken('eyJhbGciOiJSUzI1NiJ9.e30.sig')).toBe(false);
  });

  it.each([
    ['another issuer', { iss: 'https://evil.example/v1/email' }],
    ['another scope', { aud: 'email:s2' }],
    ['another session', { nonce: 'm'.repeat(43) }],
    ['an expired token', { exp: NOW / 1000 - 61 }],
    ['a token from the future', { iat: NOW / 1000 + 61 }],
    ['an address claim', { email: 'ada@example.com' }],
    ['a # in sub', { sub: 'e1.a#b' }],
    ['an empty sub', { sub: '' }],
    ['no jti', { jti: undefined }],
  ])('refuses %s', async (_, over) => {
    const r = await verifyEmailIdToken(await sign([hana], claims(over)), expectations());
    expect(r).toMatchObject({ ok: false, code: 'token_invalid' });
  });

  it('refuses a key the chain does not hold as key_pending, and a bad signature as invalid', async () => {
    expect(await verifyEmailIdToken(await sign([other], claims()), expectations())).toMatchObject({ ok: false, code: 'key_pending' });
    // other's signature under hana's kid
    const forged = await sign([{ ...other, kid: 'kid-hana' }], claims());
    expect(await verifyEmailIdToken(forged, expectations())).toMatchObject({ ok: false, code: 'token_invalid' });
  });

  it('applies the signer policy: a key under no signer, too few signers, no policy', async () => {
    const token = await sign([hana], claims());
    expect(await verifyEmailIdToken(token, expectations({ policy: { signers: [{ id: 'hana', kids: [] }], required: 1 } }))).toMatchObject({ ok: false, code: 'token_invalid' });
    expect(await verifyEmailIdToken(token, expectations({ policy: { signers: [{ id: 'hana', kids: ['kid-hana'] }, { id: 'co', kids: [] }], required: 2 } }))).toMatchObject({ ok: false, code: 'token_invalid' });
    expect(await verifyEmailIdToken(token, expectations({ policy: null }))).toMatchObject({ ok: false, code: 'token_invalid' });
    // Two signers, two signatures: accepted.
    const both = await sign([hana, other], claims());
    const twoPolicy = { signers: [{ id: 'hana', kids: ['kid-hana'] }, { id: 'co', kids: ['kid-other'] }], required: 2 };
    expect(await verifyEmailIdToken(both, expectations({ keys: [hana.chain, other.chain], policy: twoPolicy }))).toMatchObject({ ok: true });
  });

  it('refuses anything but the issuer’s exact form', async () => {
    const token = await sign([hana], claims());
    const parsed = JSON.parse(token) as { payload: string; signatures: { protected: string; signature: string }[] };
    const variants = [
      JSON.stringify(parsed, null, 1),
      JSON.stringify({ signatures: parsed.signatures, payload: parsed.payload }),
      JSON.stringify({ ...parsed, extra: 1 }),
      JSON.stringify({ payload: parsed.payload, signatures: [{ ...parsed.signatures[0], header: { kid: 'x' } }] }),
      JSON.stringify({ payload: parsed.payload, signatures: [] }),
      JSON.stringify({ payload: parsed.payload, signatures: [parsed.signatures[0], parsed.signatures[0]] }),
      JSON.stringify({ payload: parsed.payload, signatures: Array(4).fill(parsed.signatures[0]) }),
      JSON.stringify({ payload: parsed.payload, signatures: [null] }),
      JSON.stringify({ payload: parsed.payload, signatures: [1] }),
      JSON.stringify({ payload: parsed.payload, signatures: [[parsed.signatures[0]]] }),
      `${token} `,
      'not json',
      '[]',
    ];
    for (const v of variants) expect((await verifyEmailIdToken(v, expectations())).ok, v.slice(0, 60)).toBe(false);
  });

  it('refuses another algorithm, a crit header or a header member beyond alg and kid', async () => {
    for (const h of [(k: TestKey) => ({ alg: 'RS512', kid: k.kid }), (k: TestKey) => ({ alg: 'RS256', kid: k.kid, crit: ['x'] }), (k: TestKey) => ({ alg: 'RS256', kid: k.kid, typ: 'JWT' })]) {
      expect(await verifyEmailIdToken(await sign([hana], claims(), h), expectations())).toMatchObject({ ok: false, code: 'token_invalid' });
    }
  });

  it('refuses a token over 7168 bytes before parsing it', async () => {
    expect(await verifyEmailIdToken(`{"payload":"${'a'.repeat(7200)}","signatures":[]}`, expectations())).toMatchObject({ ok: false, code: 'token_invalid' });
  });
});

describe('the chain views of the email keys and signer policy (one strict parser for the vault and the export window)', () => {
  it('parses get_issuer_keys: null, or every entry {kid, n, e}; anything else throws', () => {
    expect(parseIssuerKeysView(null)).toBeNull();
    expect(parseIssuerKeysView([{ kid: 'k', n: 'n', e: 'AQAB', extra: 1 }])).toEqual([{ kid: 'k', n: 'n', e: 'AQAB' }]);
    for (const bad of [{}, 'x', [{ kid: 'k', n: 'n' }], [{ kid: 'k', n: 'n', e: 'AQAB' }, null]]) expect(() => parseIssuerKeysView(bad), JSON.stringify(bad)).toThrow();
  });

  it('parses get_self_issued: null, or {required, signers: [{id, kids}]}; one bad signer throws (never a policy of the rest)', () => {
    expect(parseSelfIssuedView(null)).toBeNull();
    expect(parseSelfIssuedView({ provider: 'email', required: 1, signers: [{ id: 'hana', kids: ['k1'] }], overlap_until_ms: null })).toEqual({ required: 1, signers: [{ id: 'hana', kids: ['k1'] }] });
    for (const bad of [
      { required: '1', signers: [] },
      { required: 1.5, signers: [] },
      { required: 1, signers: {} },
      { required: 1, signers: [{ id: 'hana', kids: ['k1'] }, { id: 5, kids: [] }] },
      { required: 1, signers: [{ id: 'hana', kids: [1] }] },
      [],
    ]) {
      expect(() => parseSelfIssuedView(bad), JSON.stringify(bad)).toThrow();
    }
  });
});
