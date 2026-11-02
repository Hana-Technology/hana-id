// The identity token's AWS KMS signer (src/identity/kms.ts, signers.ts; docs/identity-token-spec.md "Where the key
// lives", build step 7, D215–D218): DER → JOSE conversion against frozen vectors and hand-made edge cases, the adapter
// against a fake KMS that signs with a real P-256 key (tests/kms-fake.ts), every failure failing closed, the signer
// selection, and POST /v1/identity/token end to end with the KMS signer.
import { p256 } from '@noble/curves/nist';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { base64Encode, base64UrlDecode, hex, sha256 } from '../src/bytes.ts';
import { KMS_MAX_RESPONSE_BYTES, KmsIdentitySigner, derToJose } from '../src/identity/kms.ts';
import { IdentitySignerError, clearIdentitySignerCache, identityConfig, verifyEs256 } from '../src/identity/signer.ts';
import { identitySigner } from '../src/identity/signers.ts';
import { FakeKms, derSignature } from './kms-fake.ts';
import { call } from './helpers.ts';
import { mint, publishedKids, verifyToken } from './identity-helpers.ts';
import { HOUR, createShare, vaultSetup } from './vault-helpers.ts';

afterEach(() => {
  vi.restoreAllMocks();
  clearIdentitySignerCache();
});

const fromHex = (h: string): Uint8Array => Uint8Array.from(h.match(/../gu)?.map((b) => parseInt(b, 16)) ?? []);
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const N = p256.CURVE.n;
const nHex = N.toString(16);

/** The reason an IdentitySignerError carries (fails the test on any other outcome). */
async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof IdentitySignerError) return e.reason;
    throw e;
  }
  throw new Error('expected an IdentitySignerError');
}

const syncReason = (f: () => unknown): Promise<string> => reason(Promise.resolve().then(f));

describe('derToJose (D217)', () => {
  // Frozen with node:crypto (sign with dsaEncoding 'der', the same signature re-encoded as 'ieee-p1363' and verified
  // both ways) for one throwaway key; the private key was discarded.
  const NODE_KEY = { kty: 'EC', crv: 'P-256', x: '3K-2o_t3qUVLLIpJ9WNfneqRPzBQNGXgtktHABMohdw', y: 'DT48ArFtP18Py-UqDrGAvNjN73_0594AubfVQ11xyP8' } as const;
  const VECTORS = {
    'r and s of 32 bytes': {
      message: 'hana-id kms vector 2',
      der: '304402202a20eafbde3daed04ff588838d3be70b0afa5f780d80ebe5b95269ea38303ba3022038ca405bf35c56b1b1d875eab1fc8c93ff31c8e1562c5be390fd54488c7ed7a1',
      jose: '2a20eafbde3daed04ff588838d3be70b0afa5f780d80ebe5b95269ea38303ba338ca405bf35c56b1b1d875eab1fc8c93ff31c8e1562c5be390fd54488c7ed7a1',
    },
    'r with its high bit set (a 0x00 pad in DER)': {
      message: 'hana-id kms vector 10',
      der: '3045022100dfcf9efc23b3cad0265bb31438c838519da9a9a31ff95c7265aaaec6dd22410a02200c024c8590b9652bce1c83d9d9df53caedf2b233ff746b877c145bdde3a85827',
      jose: 'dfcf9efc23b3cad0265bb31438c838519da9a9a31ff95c7265aaaec6dd22410a0c024c8590b9652bce1c83d9d9df53caedf2b233ff746b877c145bdde3a85827',
    },
    'high s (s > n/2, and a 0x00 pad)': {
      message: 'hana-id kms vector 5',
      der: '30450220484ad686c3cab433ce8acafb48233f5f7add21a742ebd87d1e6329d1144fbce00221009b535827d68c6833179804958f9501f87ef2b31fbe4e2e2359009879a3713eba',
      jose: '484ad686c3cab433ce8acafb48233f5f7add21a742ebd87d1e6329d1144fbce09b535827d68c6833179804958f9501f87ef2b31fbe4e2e2359009879a3713eba',
    },
    'short r (31 bytes, left-padded)': {
      message: 'hana-id kms vector 238',
      der: '3043021f358eb630673ecbe44cc47bdf68d24c98853964ef3508689769d99f01541cab02201eb490113d5d297324de0ad7494a68f79e706caaf090f87b6716a2c7d705c8ba',
      jose: '00358eb630673ecbe44cc47bdf68d24c98853964ef3508689769d99f01541cab1eb490113d5d297324de0ad7494a68f79e706caaf090f87b6716a2c7d705c8ba',
    },
    'short s (31 bytes, left-padded)': {
      message: 'hana-id kms vector 588',
      der: '304302201add00948e579002404443a8e0992d019560c340eda2ae7e013c080a0c664ce7021f44bebc6e6e955e1d793a95011adf2901c829e4a50cbabea600dc04106eda85',
      jose: '1add00948e579002404443a8e0992d019560c340eda2ae7e013c080a0c664ce70044bebc6e6e955e1d793a95011adf2901c829e4a50cbabea600dc04106eda85',
    },
  };

  for (const [name, v] of Object.entries(VECTORS)) {
    it(`node vector: ${name}`, async () => {
      const jose = derToJose(fromHex(v.der));
      expect(hex(jose)).toBe(v.jose);
      expect(await verifyEs256(NODE_KEY, jose, utf8(v.message))).toBe(true);
    });
  }

  it('small values and the largest valid ones', () => {
    expect(hex(derToJose(fromHex('3006020101020101')))).toBe(`${'00'.repeat(31)}01${'00'.repeat(31)}01`);
    expect(hex(derToJose(fromHex('3007020200ff020101')))).toBe(`${'00'.repeat(31)}ff${'00'.repeat(31)}01`);
    const max = (N - 1n).toString(16);
    expect(hex(derToJose(fromHex(`3046022100${max}022100${max}`)))).toBe(max + max);
  });

  it('matches an independent encoder over many signatures, short r and s included', () => {
    const priv = p256.utils.randomPrivateKey();
    let short = 0;
    for (let i = 0; i < 3000 && (i < 200 || short < 2); i++) {
      const digest = crypto.getRandomValues(new Uint8Array(32));
      const sig = p256.sign(digest, priv, { lowS: false, prehash: false });
      const der = derSignature(sig.r, sig.s);
      if (der[3]! < 32 || der[der[3]! + 5]! < 32) short++;
      expect(hex(derToJose(der))).toBe(hex(sig.toCompactRawBytes()));
    }
    expect(short).toBeGreaterThanOrEqual(2);
  });

  const R32 = `0220${'11'.repeat(32)}`;
  const S1 = '020101';
  const seq = (body: string, len = body.length / 2) => `30${len.toString(16).padStart(2, '0')}${body}`;
  const REJECTED: Record<string, string> = {
    empty: '',
    'too short': '3003020101',
    'not a SEQUENCE': `31${seq(`${R32}${S1}`).slice(2)}`,
    'SEQUENCE length too long': seq(`${R32}${S1}`, 0x26),
    'SEQUENCE length too short': seq(`${R32}${S1}`, 0x24),
    'long-form SEQUENCE length': `3081${(0x25).toString(16)}${R32}${S1}`,
    'trailing byte after the SEQUENCE': `${seq(`${R32}${S1}`)}00`,
    'trailing byte inside the SEQUENCE': seq(`${R32}${S1}00`),
    'a third INTEGER': seq(`${R32}${S1}${S1}`),
    's missing': seq(`${R32}0000`),
    'r not an INTEGER': seq(`0320${'11'.repeat(32)}${S1}`),
    's not an INTEGER': seq(`${R32}030101`),
    'r of length 0': seq(`0200${S1}${S1}`),
    'r runs past the end': seq(`0221${'11'.repeat(32)}${S1}`),
    'negative r': seq(`0220${'81'.repeat(32)}${S1}`),
    'negative s': seq(`${R32}020180`),
    'non-minimal r (0x00 before a byte < 0x80)': seq(`022100${'7f'.repeat(32)}${S1}`),
    'non-minimal s (00 01)': seq(`${R32}02020001`),
    'r = 0': seq(`020100${S1}`),
    's = 0': seq(`${R32}020100`),
    'r = n': seq(`022100${nHex}${S1}`),
    's = n': seq(`${R32}022100${nHex}`),
    'r > n': seq(`022100${'ff'.repeat(32)}${S1}`),
    'r of 33 bytes without a pad': seq(`0221${'01'.repeat(33)}${S1}`),
    'r of 34 bytes': seq(`02220000${'ff'.repeat(32)}${S1}`),
    'longer than any P-256 signature': `3049022100${'ff'.repeat(32)}022100${'ff'.repeat(32)}0201`,
    'the JOSE form itself (64 raw bytes)': VECTORS['r and s of 32 bytes'].jose,
  };

  for (const [name, h] of Object.entries(REJECTED)) {
    it(`refuses: ${name}`, async () => {
      expect(await syncReason(() => derToJose(fromHex(h)))).toBe('kms_bad_signature');
    });
  }
});

describe('KmsIdentitySigner against a fake KMS', () => {
  const signerFor = (kms: FakeKms, over: Partial<ConstructorParameters<typeof KmsIdentitySigner>[0]> = {}) =>
    new KmsIdentitySigner({ kid: kms.kid, keyArn: kms.arn, published: kms.publicJwk, accessKeyId: kms.accessKeyId, secretAccessKey: kms.secretAccessKey, fetch: (r) => kms.handle(r as Request), ...over });

  it('sends one DIGEST Sign request (SigV4, the right endpoint and key) and returns a JOSE signature that verifies', async () => {
    const kms = new FakeKms('ap-southeast-1');
    const input = utf8('eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1MV9zZWNyZXQtY2xhaW0ifQ');
    const sig = await signerFor(kms).sign(input);
    expect(sig).toHaveLength(64);
    expect(await verifyEs256(kms.publicJwk, sig, input)).toBe(true);
    expect(kms.problems).toEqual([]);
    expect(kms.calls).toHaveLength(1);
    const call = kms.calls[0]!;
    expect(call.url).toBe('https://kms.ap-southeast-1.amazonaws.com/');
    expect(call.body).toEqual({ KeyId: kms.arn, Message: base64Encode(await sha256(input)), MessageType: 'DIGEST', SigningAlgorithm: 'ECDSA_SHA_256' });
    // Only the digest leaves the Worker: no claim text reaches AWS (D216).
    expect(JSON.stringify(call)).not.toContain('eyJzdWIi');
  });

  it('accepts a high-S signature (JOSE does not require low-S) and verifies it', async () => {
    const kms = new FakeKms();
    kms.mode = { kind: 'sign', highS: true };
    const input = utf8('a.b');
    const sig = await signerFor(kms).sign(input);
    expect(BigInt(`0x${hex(sig.subarray(32))}`) > N >> 1n).toBe(true);
    expect(await verifyEs256(kms.publicJwk, sig, input)).toBe(true);
  });

  it('never returns a signature the published key does not verify (self_verify_failed)', async () => {
    const kms = new FakeKms();
    const other = new FakeKms();
    // KMS signs with its key, but the manifest published another one (a wrong ARN or a mixed-up key).
    expect(await reason(signerFor(kms, { published: other.publicJwk }).sign(utf8('a.b')))).toBe('self_verify_failed');
    // KMS answers a valid signature over another digest.
    kms.mode = { kind: 'patch', patch: (a, { sign }) => ({ ...a, Signature: base64Encode(sign(new Uint8Array(32))) }) };
    expect(await reason(signerFor(kms).sign(utf8('a.b')))).toBe('self_verify_failed');
  });

  const refusals: [string, number, string][] = [
    ['AccessDeniedException', 400, 'kms_access_denied'],
    ['UnrecognizedClientException', 400, 'kms_bad_credentials'],
    ['DisabledException', 400, 'kms_key_disabled'],
    ['KMSInvalidStateException', 400, 'kms_key_disabled'],
    ['NotFoundException', 400, 'kms_key_not_found'],
    ['InvalidKeyUsageException', 400, 'kms_key_usage'],
    ['ThrottlingException', 400, 'kms_throttled'],
    ['KMSInternalException', 500, 'kms_internal'],
    ['SomethingNewException', 400, 'kms_error'],
    ['constructor', 400, 'kms_error'],
    ['IncompleteSignatureException', 400, 'kms_bad_credentials'],
    ['UnrecognizedClientException:http://internal.amazon.com/coral/com.amazon.coral.service/', 400, 'kms_bad_credentials'],
  ];
  for (const [type, status, code] of refusals) {
    it(`a refusal (${type}) is ${code}, after exactly one call`, async () => {
      const kms = new FakeKms();
      kms.mode = { kind: 'refuse', status, type };
      expect(await reason(signerFor(kms).sign(utf8('a.b')))).toBe(code);
      expect(kms.calls).toHaveLength(1);
    });
  }

  const garbage: [string, FakeKms['mode'], string][] = [
    ['an HTML 502', { kind: 'raw', status: 502, body: '<html>502 Bad Gateway</html>' }, 'kms_error'],
    ['a 200 that is not JSON', { kind: 'raw', status: 200, body: 'not json' }, 'kms_bad_answer'],
    ['a 200 JSON array', { kind: 'raw', status: 200, body: '[]' }, 'kms_bad_answer'],
    ['a 200 JSON null', { kind: 'raw', status: 200, body: 'null' }, 'kms_bad_answer'],
    ['a body over the cap', { kind: 'raw', status: 200, body: JSON.stringify({ pad: 'x'.repeat(KMS_MAX_RESPONSE_BYTES) }) }, 'kms_bad_answer'],
    ['a Content-Length over the cap', { kind: 'raw', status: 200, body: '{}', headers: { 'content-length': String(KMS_MAX_RESPONSE_BYTES + 1) } }, 'kms_bad_answer'],
    ['invalid UTF-8', { kind: 'raw', status: 200, body: Uint8Array.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]) }, 'kms_bad_answer'],
    ['another key’s ARN', { kind: 'patch', patch: (a) => ({ ...a, KeyId: new FakeKms().arn }) }, 'kms_bad_answer'],
    ['another algorithm', { kind: 'patch', patch: (a) => ({ ...a, SigningAlgorithm: 'ECDSA_SHA_384' }) }, 'kms_bad_answer'],
    ['no Signature', { kind: 'patch', patch: ({ Signature: _s, ...a }) => a }, 'kms_bad_answer'],
    ['a Signature that is not a string', { kind: 'patch', patch: (a) => ({ ...a, Signature: [1, 2] }) }, 'kms_bad_answer'],
    ['a Signature that is not base64', { kind: 'patch', patch: (a) => ({ ...a, Signature: '!!!!' }) }, 'kms_bad_answer'],
    ['an empty Signature', { kind: 'patch', patch: (a) => ({ ...a, Signature: '' }) }, 'kms_bad_answer'],
    // base64 of 3006020101020101 (a well-formed DER signature) without its padding.
    ['base64 without padding', { kind: 'patch', patch: (a) => ({ ...a, Signature: 'MAYCAQECAQE' }) }, 'kms_bad_answer'],
    ['a signature in the raw JOSE form', { kind: 'patch', patch: (a) => ({ ...a, Signature: base64Encode(fromHex(`2a${'11'.repeat(63)}`)) }) }, 'kms_bad_signature'],
    ['a truncated DER signature', { kind: 'patch', patch: (a) => ({ ...a, Signature: base64Encode(Uint8Array.from(atob(String(a.Signature)), (c) => c.charCodeAt(0)).subarray(0, 40)) }) }, 'kms_bad_signature'],
  ];
  for (const [name, mode, code] of garbage) {
    it(`garbage: ${name} is ${code}`, async () => {
      const kms = new FakeKms();
      kms.mode = mode;
      expect(await reason(signerFor(kms).sign(utf8('a.b')))).toBe(code);
      expect(kms.calls).toHaveLength(1);
    });
  }

  it('a hung KMS is kms_timeout at the deadline, a dropped connection kms_unreachable; one call each, no retry', async () => {
    const kms = new FakeKms();
    kms.mode = { kind: 'hang' };
    const started = Date.now();
    expect(await reason(signerFor(kms, { timeoutMs: 50 }).sign(utf8('a.b')))).toBe('kms_timeout');
    expect(Date.now() - started).toBeLessThan(2000);
    // A body that never ends counts against the same deadline.
    const slowBody = new FakeKms();
    const stalled = (r: Request) =>
      slowBody.handle(r).then(() => new Response(new ReadableStream({ start: (c) => c.enqueue(utf8('{"KeyId":')) }), { status: 200 }));
    expect(await reason(signerFor(slowBody, { timeoutMs: 50, fetch: (r) => stalled(r as Request) }).sign(utf8('a.b')))).toBe('kms_timeout');
    kms.mode = { kind: 'network' };
    expect(await reason(signerFor(kms).sign(utf8('a.b')))).toBe('kms_unreachable');
    expect(kms.calls).toHaveLength(2);
  });

  it('refuses a malformed ARN or credentials before any call, and its errors never carry a credential', async () => {
    const kms = new FakeKms();
    for (const keyArn of ['', `${kms.arn.replace(':key/', ':alias/')}`, kms.arn.replace('arn:aws:', 'arn:aws-cn:'), `${kms.arn}x`]) {
      expect(await syncReason(() => signerFor(kms, { keyArn }))).toBe('kms_bad_key_arn');
    }
    for (const over of [{ accessKeyId: kms.accessKeyId.replace('AKIA', 'ASIA') }, { accessKeyId: 'akia' }, { secretAccessKey: 'short' }, { secretAccessKey: `${kms.secretAccessKey}=` }]) {
      expect(await syncReason(() => signerFor(kms, over))).toBe('kms_bad_credentials_format');
    }
    kms.mode = { kind: 'refuse', status: 400, type: 'AccessDeniedException' };
    try {
      await signerFor(kms).sign(utf8('a.b'));
    } catch (e) {
      const text = `${String(e)} ${JSON.stringify(e)} ${(e as Error).stack ?? ''}`;
      expect(text).not.toContain(kms.accessKeyId);
      expect(text).not.toContain(kms.secretAccessKey);
    }
    expect(kms.calls).toHaveLength(1);
  });

  it('a wrong secret is refused by KMS (SigV4 mismatch) as kms_bad_credentials', async () => {
    const kms = new FakeKms();
    const wrong = `${kms.secretAccessKey.slice(0, 39)}${kms.secretAccessKey.endsWith('A') ? 'B' : 'A'}`;
    expect(await reason(signerFor(kms, { secretAccessKey: wrong }).sign(utf8('a.b')))).toBe('kms_bad_credentials');
    expect(kms.problems).toEqual(['SigV4 signature']);
  });
});

describe('identitySigner: the signer selection (D215)', () => {
  const config = () => {
    const c = identityConfig(env);
    if (typeof c === 'string') throw new Error(c);
    return c;
  };
  const [ACTIVE_KID] = publishedKids() as [string, string];

  it('worker-secret when IDENTITY_SIGNER is absent or worker-secret; aws-kms builds the KMS signer for the active kid', async () => {
    expect((await identitySigner({ ...env, IDENTITY_SIGNER: undefined }, config())).kid).toBe(ACTIVE_KID);
    expect((await identitySigner({ ...env, IDENTITY_SIGNER: 'worker-secret' }, config())).kid).toBe(ACTIVE_KID);
    const kms = new FakeKms();
    const bindings = { ...env, ...kms.env() };
    const c = identityConfig(bindings);
    if (typeof c === 'string') throw new Error(c);
    const signer = await identitySigner(bindings, c);
    expect(signer).toBeInstanceOf(KmsIdentitySigner);
    expect(signer.kid).toBe(kms.kid);
  });

  it('fails closed: an unknown kind, no ARN, no credentials, an active kid that isn’t published', async () => {
    const kms = new FakeKms();
    const bindings = { ...env, ...kms.env() };
    const c = identityConfig(bindings);
    if (typeof c === 'string') throw new Error(c);
    expect(await reason(identitySigner({ ...bindings, IDENTITY_SIGNER: 'kms' }, c))).toBe('unknown_signer_kind');
    expect(await reason(identitySigner({ ...bindings, IDENTITY_KMS_KEY_ARN: undefined }, c))).toBe('no_kms_key_arn');
    expect(await reason(identitySigner({ ...bindings, IDENTITY_AWS_ACCESS_KEY_ID: undefined }, c))).toBe('no_aws_credentials');
    expect(await reason(identitySigner({ ...bindings, IDENTITY_AWS_SECRET_ACCESS_KEY: '' }, c))).toBe('no_aws_credentials');
    expect(await reason(identitySigner(bindings, { ...c, activeKid: 'x'.repeat(43) }))).toBe('active_kid_not_published');
    // A KMS key ARN without IDENTITY_SIGNER is a half-applied config: refused, not read as worker-secret.
    expect(await reason(identitySigner({ ...env, IDENTITY_SIGNER: undefined, IDENTITY_KMS_KEY_ARN: kms.arn }, identityConfig(env) as Exclude<ReturnType<typeof identityConfig>, string>))).toBe('signer_kind_missing');
  });

  it('a KMS-configured Worker never falls back to a Worker-secret key still on it', async () => {
    const kms = new FakeKms();
    kms.install();
    // The JWKS also publishes the Worker-secret key, and its secret is still bound: the KMS signer is still the one.
    const bindings = { ...env, ...kms.env(JSON.parse(env.IDENTITY_PUBLIC_KEYS!) as unknown[]), IDENTITY_ACTIVE_KID: ACTIVE_KID };
    expect(bindings.IDENTITY_SIGNING_KEY).toBeTruthy();
    const c = identityConfig(bindings);
    if (typeof c === 'string') throw new Error(c);
    const signer = await identitySigner(bindings, c);
    expect(signer).toBeInstanceOf(KmsIdentitySigner);
    // KMS signs with its own key, which isn't the published key for that kid: refused, never answered.
    expect(await reason(signer.sign(utf8('a.b')))).toBe('self_verify_failed');
    expect(kms.calls).toHaveLength(1);
  });
});

describe('POST /v1/identity/token with the KMS signer', () => {
  async function setup() {
    const { app, near } = await vaultSetup();
    const share = await createShare(app, near);
    const kms = new FakeKms();
    kms.install();
    return { app, spk: share.spk, kms, bindings: kms.env(JSON.parse(env.IDENTITY_PUBLIC_KEYS!) as unknown[]) };
  }

  function captureLogs(): string[] {
    const lines: string[] = [];
    for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation((l: unknown) => void lines.push(String(l)));
    return lines;
  }

  it('mints a token signed in KMS that verifies against the JWKS, counted under the KMS kid, with one Sign call', async () => {
    const { app, spk, kms, bindings } = await setup();
    const logs = captureLogs();
    const hour = Math.floor(Date.now() / HOUR) * HOUR;
    const exec = createExecutionContext();
    const res = await mint(app, spk, { env: bindings, exec });
    await waitOnExecutionContext(exec);
    const b = (await res.json()) as { identityToken: string };
    expect(res.status).toBe(200);
    const { header } = await verifyToken(b.identityToken, bindings);
    expect(header).toEqual({ alg: 'ES256', kid: kms.kid, typ: 'hana-identity+jwt' });
    expect(kms.calls).toHaveLength(1);
    expect(kms.problems).toEqual([]);
    const row = await env.DB.prepare('SELECT count FROM identity_issuance_hourly WHERE hour = ?1 AND kid = ?2').bind(hour, kms.kid).first<{ count: number }>();
    expect(row?.count).toBe(1);
    // The JWKS still serves the Worker-secret keys next to the KMS one (a migration or rotation window).
    expect(await (await call('/v1/identity/jwks.json', { method: 'GET', env: bindings })).json()).toMatchObject({ keys: [{ kid: kms.kid }, {}, {}] });
    const all = logs.join('\n');
    for (const secret of [kms.accessKeyId, kms.secretAccessKey, b.identityToken.split('.')[2]!]) expect(all).not.toContain(secret);
    expect(base64UrlDecode(b.identityToken.split('.')[2]!)).toHaveLength(64);
  });

  const failures: [string, (kms: FakeKms, bindings: Record<string, string>) => Record<string, string | undefined>, string][] = [
    ['KMS refuses (AccessDenied)', (kms, b) => ((kms.mode = { kind: 'refuse', status: 400, type: 'AccessDeniedException' }), b), 'kms_access_denied'],
    ['KMS throttles', (kms, b) => ((kms.mode = { kind: 'refuse', status: 400, type: 'ThrottlingException' }), b), 'kms_throttled'],
    ['KMS answers garbage', (kms, b) => ((kms.mode = { kind: 'raw', status: 200, body: '<html>' }), b), 'kms_bad_answer'],
    // base64 of 3006020100020101: r = 0.
    ['KMS answers a malformed DER signature', (kms, b) => ((kms.mode = { kind: 'patch', patch: (a) => ({ ...a, Signature: 'MAYCAQACAQE=' }) }), b), 'kms_bad_signature'],
    ['KMS signs with a key other than the published one', (kms, b) => ((kms.mode = { kind: 'patch', patch: (a, { digest }) => ({ ...a, Signature: base64Encode(new FakeKms().signDigest(digest)) }) }), b), 'self_verify_failed'],
    ['the connection drops', (kms, b) => ((kms.mode = { kind: 'network' }), b), 'kms_unreachable'],
    ['the credentials are missing', (_kms, b) => ({ ...b, IDENTITY_AWS_SECRET_ACCESS_KEY: undefined }), 'no_aws_credentials'],
    ['IDENTITY_SIGNER is missing but a KMS key ARN is set', (_kms, b) => ({ ...b, IDENTITY_SIGNER: undefined }), 'signer_kind_missing'],
  ];
  for (const [name, arrange, code] of failures) {
    it(`503 identity_signer_unavailable when ${name} (logged as ${code}), with at most one Sign call`, async () => {
      const { app, spk, kms, bindings } = await setup();
      const logs = captureLogs();
      const res = await mint(app, spk, { env: arrange(kms, bindings) as Partial<typeof env> });
      expect(res.status).toBe(503);
      expect(((await res.json()) as { code: string }).code).toBe('identity_signer_unavailable');
      expect(kms.calls.length).toBeLessThanOrEqual(1);
      const all = logs.join('\n');
      expect(all).toContain(`"code":"${code}"`);
      expect(all).not.toContain(kms.accessKeyId);
      expect(all).not.toContain(kms.secretAccessKey);
    });
  }

  it('503 identity_signer_unavailable when KMS hangs past the deadline (one call, no retry)', { timeout: 15_000 }, async () => {
    const { app, spk, kms, bindings } = await setup();
    kms.mode = { kind: 'hang' };
    const res = await mint(app, spk, { env: bindings });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe('identity_signer_unavailable');
    expect(kms.calls).toHaveLength(1);
  });
});
